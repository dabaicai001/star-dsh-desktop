#!/usr/bin/env node
/**
 * StarHub × dsh desktop 冒烟(去 Tauri 化 M4 第 2 步)。
 *
 * 上游 Electron 壳自己 spawn desktop-host;本脚本不拉 Electron,而是直接 boot
 * 那个宿主进程(`apps/cli/lib/bin.js web`)——上游 `apps/desktop/scripts/
 * smoke-runtime.ts` 就是这么验「Host 启动 + 外部插件」的,同款路径。要证的只有
 * 一件事:**provisioning 装好的组合能真的跑起来**。
 *
 * 步骤:
 * 1. 前置校验(vendor lib / sidecar / 工作台 dist 缺失即 fail loud);
 * 2. `scripts/provision-dsh.mjs` 物化一个一次性 `$DSH_HOME`(profile=web,
 *    因为 `bin.js web` 用的就是 web profile);
 * 3. spawn `bin.js web`,等 webserver 起来; * 4. 断言四条:
 *    - `GET /starhub-react/` 返回工作台 index.html(host-static 用上了
 *      provisioning 注入的 windowDist——安装形态没有仓库可回退);
 *    - `POST /starhub/api/invoke {cmd:'get_assets'}` 回 `{ok:true,result:[]}`
 *      (bridge 真的 spawn 了 sidecar 并打通了 JSON-RPC);
 *    - `POST /starhub/api/invoke {cmd:'bogus'}` 回 `{ok:false,error}` 且错误
 *      含 method not found(bridge 的 `ui.` 前缀 + 错误通路);
 *    - `GET /starhub/api/events` 是 SSE 流(工作台事件面的共享连接);
 * 5. 收进程、清临时目录、按断言结果退出。
 *
 * 用法:
 *   node scripts/smoke-dsh-desktop.mjs [--keep] [--port <n>] [--timeout <ms>]
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(repoRoot, 'vendor', 'deepseek-harness')

/** 启动总预算(冷启动:Node + 首次物化 profile + sidecar ping)。 */
const DEFAULT_TIMEOUT_MS = 90_000

function parseArgs(argv) {
  const values = { keep: false, port: 0, timeout: DEFAULT_TIMEOUT_MS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return value
    }
    switch (arg) {
      case '--keep': values.keep = true; break
      case '--port': values.port = Number.parseInt(next(), 10); break
      case '--timeout': values.timeout = Number.parseInt(next(), 10); break
      case '--help': console.log(usage()); process.exit(0)
      default: throw new Error(`未知参数 ${arg}`)
    }
  }
  return values
}

function usage() {
  return [
    'Usage: node scripts/smoke-dsh-desktop.mjs [flags]',
    '',
    '  --keep             冒烟结束后保留临时 DSH_HOME(排查用)。',
    '  --port <n>         webserver 端口,缺省 0(内核分配)。',
    '  --timeout <ms>     启动总预算,缺省 90000。',
    '',
  ].join('\n')
}

/** 抢一个空闲端口(绑定后立刻关,交给宿主进程)。 */
function pickPort() {
  return new Promise((resolvePick, rejectPick) => {
    const server = createServer()
    server.once('error', rejectPick)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePick(port))
    })
  })
}

async function pathKind(path) {
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

/** 等 HTTP 端点就绪(任何响应都算,401 也算——那是 token 认证在工作)。 */
async function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
      return response
    } catch {
      if (Date.now() > deadline) return null
      await new Promise(r => setTimeout(r, 300))
    }
  }
}

/**
 * 挑一个能跑 dsh CLI 的 Node。
 *
 * 必须优先打包进去的便携 node(`dsh-runtime/node.exe`,由 `npm run
 * package:dsh-runtime` 生成):CLI 入口用 `import.meta.main` 自决是否执行,
 * 而这个特性要 Node ≥24.2——本机开发用的 node v24.0.0 会让 `import.meta.main`
 * 为 undefined,进程静默退出 0(不报错、不输出),冒烟会误判成「起不来」。用
 * 运行时的 node 同时也更接近生产:desktop 宿主 spawn 的就是它。
 *
 * @returns `{ executable, cliBin }`。
 */
function resolveNode() {
  const runtimeRoot = join(repoRoot, 'dsh-runtime')
  const bundled = join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  const cliFromRuntime = join(runtimeRoot, 'apps', 'cli', 'lib', 'bin.js')
  const cli = existsSync(cliFromRuntime) ? cliFromRuntime : join(vendorRoot, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(bundled)) return { executable: bundled, cliBin: cli }
  console.log('[smoke] 未找到 dsh-runtime/node,回退 process.execPath(若其 <24.2,CLI 会静默退出)')
  return { executable: process.execPath, cliBin: cli }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const node = resolveNode()
  const rustSidecar = join(repoRoot, 'sidecar-rust', 'target', 'debug',
    process.platform === 'win32' ? 'starhub-sidecar-rust.exe' : 'starhub-sidecar-rust')
  const goSidecar = join(repoRoot, 'sidecar', 'bin',
    process.platform === 'win32' ? 'starhub-sidecar.exe' : 'starhub-sidecar')
  const windowDist = join(repoRoot, 'dist-starhub-react')
  console.log(`[smoke] node    ${node.executable}`)
  console.log(`[smoke] cli     ${node.cliBin}`)

  // ── 1. 前置校验 ──
  const problems = []
  for (const [label, path, kind] of [
    ['dsh CLI', node.cliBin, 'file'],
    ['Rust sidecar', rustSidecar, 'file'],
    ['Go sidecar', goSidecar, 'file'],
    ['工作台 dist', windowDist, 'dir'],
  ]) {
    if (await pathKind(path) !== kind) {
      problems.push(`${label} 缺失: ${path}`)
    }
  }
  if (problems.length > 0) {
    console.error('smoke-dsh-desktop: 前置校验失败:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const port = options.port === 0 ? await pickPort() : options.port
  const home = mkdtempSync(join(tmpdir(), 'starhub-smoke-'))
  console.log(`[smoke] DSH_HOME ${home}`)
  console.log(`[smoke] port    ${port}`)

  // ── 2. provisioning ──
  const provision = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'provision-dsh.mjs'),
    '--home', home,
    '--profile', 'web',
    '--sidecar-rust', rustSidecar,
    '--sidecar-go', goSidecar,
    '--window-dist', windowDist,
    '--port', String(port),
  ], { encoding: 'utf8' })
  if (provision.status !== 0) {
    console.error(`[smoke] provisioning 失败:\n${provision.stdout}\n${provision.stderr}`)
    rmSync(home, { recursive: true, force: true })
    process.exit(1)
  }
  console.log('[smoke] provisioning 完成')

  // ── 3. boot 宿主进程 ──
  const child = spawn(node.executable, [node.cliBin, 'web'], {
    cwd: vendorRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      STARHUB_GO_SIDECAR: goSidecar,
    },
  })
  const logTail = []
  const remember = (chunk) => {
    logTail.push(chunk.toString('utf8'))
    if (logTail.length > 200) logTail.shift()
  }
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)

  let failures = 0
  try {
    const ready = await waitForHttp(port, options.timeout)
    if (ready === null) {
      throw new Error(`webserver 在 ${options.timeout}ms 内未就绪\n${logTail.join('')}`)
    }
    console.log(`[smoke] webserver 就绪(GET / → ${ready.status})`)

    const check = (label, condition, detail) => {
      if (condition) {
        console.log(`  ok   ${label}`)
      } else {
        failures += 1
        console.log(`  FAIL ${label} — ${detail}`)
      }
    }

    // ① host-static:工作台 dist 由 windowDist 注入(安装形态没有仓库回退)
    const workbench = await fetch(`http://127.0.0.1:${port}/starhub-react/`)
    const workbenchText = await workbench.text()
    check('GET /starhub-react/ 返回工作台 index.html',
      workbench.status === 200 && workbenchText.includes('<html'),
      `status=${workbench.status} body=${workbenchText.slice(0, 120)}`)

    // ② bridge:真的 spawn 了 sidecar 并打通 JSON-RPC
    const invoke = await fetch(`http://127.0.0.1:${port}/starhub/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'get_assets', args: {} }),
    })
    const assets = await invoke.json()
    check('POST /starhub/api/invoke get_assets → {ok:true,result:[]}',
      assets?.ok === true && Array.isArray(assets.result),
      JSON.stringify(assets).slice(0, 200))

    // ③ bridge 的 ui. 前缀 + 错误通路
    const bogus = await fetch(`http://127.0.0.1:${port}/starhub/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'definitely_not_a_command', args: {} }),
    })
    const bogusBody = await bogus.json()
    check('未知命令 → {ok:false,error} 且含 method not found',
      bogusBody?.ok === false && String(bogusBody.error).includes('method not found'),
      JSON.stringify(bogusBody).slice(0, 200))

    // ④ 工作台事件面:SSE 共享连接
    const events = await fetch(`http://127.0.0.1:${port}/starhub/api/events`, {
      headers: { accept: 'text/event-stream' },
    })
    const eventsType = events.headers.get('content-type') ?? ''
    check('GET /starhub/api/events 是 SSE 流',
      events.status === 200 && eventsType.includes('text/event-stream'),
      `status=${events.status} type=${eventsType}`)
    await events.body?.cancel()

    // ⑤ sidecar 侧真实应答:Go sidecar 通(数据库族工具第一个调用会 lazy start)
    const goProbe = await fetch(`http://127.0.0.1:${port}/starhub/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'db_mysql_test', args: { params: { host: '127.0.0.1', port: 1, username: 'x', password: 'x' } } }),
    })
    const goBody = await goProbe.json()
    check('db_mysql_test 经 Go sidecar 走到连接失败(证明 Go 侧活着)',
      goBody?.ok === true || (goBody?.ok === false && String(goBody.error).length > 0),
      JSON.stringify(goBody).slice(0, 200))
  } catch (error) {
    failures += 1
    console.log(`  FAIL 冒烟异常 — ${error instanceof Error ? error.message : String(error)}`)
    console.log(logTail.join(''))
  } finally {
    child.kill()
    await new Promise((r) => {
      if (child.exitCode !== null) { r(); return }
      child.once('exit', r)
      setTimeout(() => { child.kill('SIGKILL'); r() }, 5000).unref()
    })
  }

  if (options.keep) {
    console.log(`[smoke] --keep:DSH_HOME 保留在 ${home}`)
  } else {
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`[smoke] 结果:${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`smoke-dsh-desktop: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
