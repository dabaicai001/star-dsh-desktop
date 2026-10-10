#!/usr/bin/env node
/**
 * StarHub 纯插件化(bundle 形态)冒烟:一次性 profile + 宿主进程 boot。
 *
 * 与 `smoke-dsh-desktop.mjs`(验 provisioning)的差别在于**它证的是另一条安装
 * 路径**:profile 里没有 provisioning 产物、没有 `STARHUB_GO_SIDECAR` 环境变量、
 * patch 里没有任何绝对路径,只有
 *
 *   1. `dsh.profile.bundles` 里多一个 `@starhub/dsh-plugin`,
 *   2. `<profile>/node_modules/@starhub/dsh-plugin` 指向 dist-plugin 的链接
 *      (本地目录安装时 pnpm 建的就是它),
 *   3. 该包自己的 `cordis.patch.yml`。
 *
 * 断言五条:
 *   - 工作台 `GET /starhub-react/` 由**包内 dist** 提供(host-static 自解析);
 *   - `POST /starhub/api/invoke get_assets` 回 `{ok:true}`,证明 bridge 用**包内
 *     sidecar**(Rust 侧 + 按同级兄弟名找到的 Go 侧)真的起来了;
 *   - 未知命令回 `method not found`(错误通路);
 *   - `GET /starhub/api/events` 是 SSE 流;
 *   - `GET /plugins/@starhub/dsh-plugin/client.js` 不是 404(客户端半边被
 *     `dsh.client` 扫描并下发)。
 *
 * 用法:
 *   node scripts/smoke-plugin-bundle.mjs [--bundle <dir>] [--keep] [--port <n>] [--timeout <ms>]
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(repoRoot, 'vendor', 'deepseek-harness')

/** 启动总预算(冷启动:Node + 首次物化 profile + sidecar ping)。 */
const DEFAULT_TIMEOUT_MS = 90_000

/** bundle 包名与它的安装目录名(与 build-plugin-bundle.mjs 的缺省一致)。 */
const BUNDLE_NAME = '@starhub/dsh-plugin'

function parseArgs(argv) {
  const values = {
    bundle: join(repoRoot, 'dist-plugin'), keep: false, port: 0, timeout: DEFAULT_TIMEOUT_MS, spec: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return value
    }
    switch (arg) {
      case '--bundle': values.bundle = resolve(next()); break
      case '--spec': values.spec = next(); break
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
    'Usage: node scripts/smoke-plugin-bundle.mjs [flags]',
    '',
    '  --bundle <dir>   已组装好的 bundle 目录,缺省 dist-plugin。',
    '  --spec <spec>    改用真 pnpm 安装(`pnpm add <spec>`,缺省用 --bundle 的目录拷贝),',
    '                   传 tarball 路径即可复刻插件页的安装动作。',
    '  --keep           冒烟结束后保留临时 DSH_HOME(排查用)。',
    '  --port <n>       webserver 端口,缺省 0(内核分配)。',
    '  --timeout <ms>   启动总预算,缺省 90000。',
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

/** 等 HTTP 端点就绪(任何响应都算,401 也算——那是 token 认证在工作)。 */
async function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    } catch {
      if (Date.now() > deadline) return null
      await new Promise(r => setTimeout(r, 300))
    }
  }
}

/**
 * 从宿主输出里取 webserver 的登录 token(CLI 打印 `dsh web: http://…/?token=…`)。
 * @param read - 返回当前已捕获输出的函数。
 * @param timeoutMs - 等待上限。
 * @returns token,或超时后的 null。
 */
async function waitForToken(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = /[?&]token=([A-Za-z0-9_-]{8,})/.exec(read())
    if (found !== null) return found[1]
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 200))
  }
}

/**
 * 挑一个能跑 dsh CLI 的 Node:优先打包进去的便携 node(`dsh-runtime/node.exe`),
 * 因为 CLI 入口用 `import.meta.main` 自决是否执行,而它要 Node ≥24.2。
 * @returns `{ executable, cliBin }`。
 */
function resolveNode() {
  const runtimeRoot = join(repoRoot, 'dsh-runtime')
  const bundled = join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  const cliFromRuntime = join(runtimeRoot, 'apps', 'cli', 'lib', 'bin.js')
  const cli = existsSync(cliFromRuntime) ? cliFromRuntime : join(vendorRoot, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(bundled)) return { executable: bundled, cliBin: cli }
  console.log('[plugin-smoke] 未找到 dsh-runtime/node,回退 process.execPath(若其 <24.2,CLI 会静默退出)')
  return { executable: process.execPath, cliBin: cli }
}

/**
 * 物化一次性 profile:三个文件 + 一个 node_modules 链接。
 *
 * 这份 profile 刻意**不跑 pnpm**——「本地目录安装」在 dsh 里就是 profile 依赖
 * 记一条 `file:` 加一个链接,本脚本复刻的正是它落盘后的样子。
 * @param home - 一次性 DSH_HOME。
 * @param bundleDir - 组装好的 bundle 绝对路径。
 * @param port - webserver 端口。
 * @returns profile 目录。
 */
function materializeProfile(home, bundleDir, port, installed = false) {
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })

  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: installed ? {} : { [BUNDLE_NAME]: `file:${bundleDir}` },
    dsh: { profile: { bundles: installed
      ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BUNDLE_NAME] } },
  }, undefined, 2)}\n`)

  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# 冒烟用用户层:只给 webserver 定端口,不碰 StarHub 行(它们来自 bundle 层)。',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    '',
  ].join('\n'))

  if (installed) return profileDir

  const scopedRoot = join(profileDir, 'node_modules', '@starhub')
  mkdirSync(scopedRoot, { recursive: true })
  // 关键:落成**真实目录**而不是链接。
  //
  // pnpm 安装(注册表 / git / tarball)把包解开在 `<profile>/node_modules/.pnpm/…`,
  // realpath 在 profile 树内;而「本地目录路径」安装是 link,realpath 指向仓库外,
  // Node 默认按 realpath 解析 → 行模块里的 `@deepseek-ai/*` 裸 import 不会被 dsh
  // 的运行时解析层接管,插件会 "failed to import"。这里复刻的是 pnpm 安装后的布局。
  cpSync(bundleDir, join(scopedRoot, 'dsh-plugin'), { recursive: true })

  return profileDir
}

/**
 * 真跑一次 `pnpm add <spec>` 并复刻 `install_bundle` 的选入动作。
 *
 * 这就是插件页「安装」做的事:在 profile 目录里 pnpm add,成功后把新依赖里声明了
 * `dsh.bundle.patch` 的包名追加进 `dsh.profile.bundles`。
 * @param profileDir - profile 目录。
 * @param spec - 安装 spec(tarball 绝对路径 / 包名 / git 地址)。
 * @throws 当 pnpm 非零退出时。
 */
function installSpec(profileDir, spec) {
  const { spawnSync } = require$('node:child_process')
  if (/["\r\n]/.test(spec)) throw new Error(`安装 spec 含引号或换行,拒绝拼命令: ${spec}`)
  // Windows 上 pnpm 是 .cmd,不经 shell 起不来;spec 已拒绝引号/换行,命令串只多一层双引号。
  const added = spawnSync(`pnpm add ${JSON.stringify(spec)}`, {
    cwd: profileDir,
    encoding: 'utf8',
    shell: true,
  })
  if (added.status !== 0 || added.error !== undefined) {
    throw new Error(`pnpm add ${spec} 失败:\n${added.error?.message ?? ''}\n${added.stdout ?? ''}\n${added.stderr ?? ''}`)
  }
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh.profile.bundles
  if (!bundles.includes(BUNDLE_NAME)) bundles.push(BUNDLE_NAME)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/** `createRequire` 的薄封装(脚本按 ESM 跑,这里只在需要内置模块时借用)。 */
function require$(specifier) {
  return createRequire(import.meta.url)(specifier)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const node = resolveNode()
  console.log(`[plugin-smoke] node   ${node.executable}`)
  console.log(`[plugin-smoke] cli    ${node.cliBin}`)
  console.log(`[plugin-smoke] bundle ${options.bundle}`)

  // ── 1. 前置校验 ──
  for (const [label, path] of [
    ['dsh CLI', node.cliBin],
    ['bundle package.json', join(options.bundle, 'package.json')],
    ['bundle patch', join(options.bundle, 'cordis.patch.yml')],
    ['bundle 工作台 dist', join(options.bundle, 'host-static', 'dist', 'index.html')],
    ['bundle Rust sidecar', join(options.bundle, 'bridge', 'sidecar',
      process.platform === 'win32' ? 'starhub-sidecar-rust.exe' : 'starhub-sidecar-rust')],
    ['bundle Go sidecar', join(options.bundle, 'bridge', 'sidecar',
      process.platform === 'win32' ? 'starhub-sidecar.exe' : 'starhub-sidecar')],
  ]) {
    if (!existsSync(path)) {
      console.error(`plugin-smoke: 前置校验失败 — ${label} 缺失: ${path}`)
      console.error('             先跑 npm run plugin:bundle 组装产物')
      process.exit(1)
    }
  }

  const port = options.port === 0 ? await pickPort() : options.port
  const home = mkdtempSync(join(tmpdir(), 'starhub-plugin-smoke-'))
  const profileDir = materializeProfile(home, options.bundle, port, options.spec !== null)
  console.log(`[plugin-smoke] DSH_HOME ${home}`)
  console.log(`[plugin-smoke] profile  ${profileDir}`)
  console.log(`[plugin-smoke] port     ${port}`)
  if (options.spec !== null) {
    console.log(`[plugin-smoke] 安装     pnpm add ${options.spec}`)
    installSpec(profileDir, options.spec)
  }

  // ── 2. boot 宿主进程(刻意不设 STARHUB_GO_SIDECAR / STARHUB_WINDOW_DIST) ──
  const child = spawn(node.executable, [node.cliBin, 'web'], {
    cwd: vendorRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      STARHUB_GO_SIDECAR: '',
      STARHUB_WINDOW_DIST: '',
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
  const check = (label, condition, detail) => {
    if (condition) {
      console.log(`  ok   ${label}`)
    } else {
      failures += 1
      console.log(`  FAIL ${label} — ${detail}`)
    }
  }

  try {
    const ready = await waitForHttp(port, options.timeout)
    if (ready === null) throw new Error(`webserver 在 ${options.timeout}ms 内未就绪\n${logTail.join('')}`)
    console.log(`[plugin-smoke] webserver 就绪(GET / → ${ready.status})`)

    // ① host-static:工作台 dist 来自包内(没有 windowDist / env 注入)
    const workbench = await fetch(`http://127.0.0.1:${port}/starhub-react/`)
    const workbenchText = await workbench.text()
    check('GET /starhub-react/ 由包内 dist 提供',
      workbench.status === 200 && workbenchText.includes('<html'),
      `status=${workbench.status} body=${workbenchText.slice(0, 120)}`)

    // ② bridge:包内 sidecar 真的起来并打通 JSON-RPC
    const invoke = await fetch(`http://127.0.0.1:${port}/starhub/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'get_assets', args: {} }),
    })
    const assets = await invoke.json()
    check('POST /starhub/api/invoke get_assets → {ok:true,result:[]}',
      assets?.ok === true && Array.isArray(assets.result),
      JSON.stringify(assets).slice(0, 200))

    // ③ 错误通路
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

    // ⑤ 客户端半边:`dsh.client` 扫描把行并入 boot 图(window.__DSH_BOOT__)
    const token = await waitForToken(() => logTail.join(''), 20_000)
    if (token === null) {
      check('取到 webserver 登录 token', false, 'CLI 未打印 ?token=')
    } else {
      const login = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })
      const cookie = (login.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
      const page = await fetch(`http://127.0.0.1:${port}/`, { headers: cookie === '' ? {} : { cookie } })
      const html = await page.text()
      check('客户端半边进入 boot 图(HTML 含 @starhub/dsh-plugin)',
        page.status === 200 && html.includes(BUNDLE_NAME),
        `status=${page.status} 含包名=${html.includes(BUNDLE_NAME)}`)
    }
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
    console.log(`[plugin-smoke] --keep:DSH_HOME 保留在 ${home}`)
  } else {
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`[plugin-smoke] 结果:${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  if (failures !== 0) console.log(logTail.join(''))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`smoke-plugin-bundle: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
