#!/usr/bin/env node
/**
 * tauri:dev 的 beforeDevCommand(P4a 起 dsh 壳是唯一主壳,双轨制已取消)。
 *
 * 依次执行:
 * 1. vendor dsh 构建产物存在性检查(client lib / web dist / CLI bin 缺失才构建;
 *    vendor 构建需要 PATH 里有 pnpm,取仓库根 tmp/pnpm-home;严禁 CI=true)
 * 2. sidecar:build(setup 钩子对 sidecar 版本 fail loud)
 * 3. build:window(StarHub React workbench dist → dist-starhub-react/,host-static 托管)
 * 4. 前台占位等待页 server 监听 3085:tauri dev 要等 devUrl 可访问才启动应用,
 *    而真实 dsh web 由 Rust DshWebManager 在 setup 里拉起——3085 被本占位进程
 *    占用,管理器递增到 3086+。占位页自身轮询 `/__dsh_url`(由本 server 扫描
 *    3086..3095 找到含 __DSH_BOOT__ 标记的服务)并 location.replace 过去——
 *    不依赖 Rust 侧 window.url()/eval 的时序(取舍见 docs/踩坑记录.md 第 20 节)。
 *    应用退出时 tauri 回收本进程树。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(repoRoot, 'vendor', 'deepseek-harness')
const WAIT_PORT = 3085

function run(label, command, args, options = {}) {
  console.log(`[dev-dsh-shell] ${label}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) {
    console.error(`[dev-dsh-shell] ${label} 失败(退出码 ${result.status})`)
    process.exit(result.status ?? 1)
  }
}

// 1. vendor 构建产物存在性检查,缺失才跑对应构建
const needHost = !existsSync(join(vendorRoot, 'apps', 'cli', 'lib', 'bin.js'))
const needClient = !existsSync(join(vendorRoot, 'packages', 'starhub', 'client-nav', 'lib', 'client.js'))
  || !existsSync(join(vendorRoot, 'packages', 'starhub', 'host-static', 'lib', 'index.js'))
const needWeb = !existsSync(join(vendorRoot, 'apps', 'web', 'dist', 'index.html'))
if (needHost || needClient || needWeb) {
  const env = {
    ...process.env,
    PATH: `${join(repoRoot, 'tmp', 'pnpm-home', 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  }
  delete env.CI
  for (const [needed, script] of [
    [needHost, 'build:lib:host'],
    [needClient, 'build:lib:client'],
    [needWeb, 'build:web'],
  ]) {
    if (needed) run(`vendor ${script}`, 'npm', ['run', script], { cwd: vendorRoot, env })
  }
} else {
  console.log('[dev-dsh-shell] vendor 构建产物齐全,跳过 vendor 构建')
}

// 2. sidecar + 3. React workbench dist
run('sidecar:build', 'npm', ['run', 'sidecar:build'], { cwd: repoRoot })
run('build:window', 'npm', ['run', 'build:window'], { cwd: repoRoot })

// 4. 占位等待页(前台常驻;tauri 等待 devUrl=3085 可访问后才启动应用)
const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>StarHub</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #080d14; color: #7f8b99; font: 14px/1.6 ui-monospace, monospace; }
</style></head>
<body><div>STARHUB dsh 壳启动中…(若长时间停留请查看终端日志)</div>
<script>
  // 真实 dsh web 由 Rust 在 setup 拉起(3085 被本占位页占用,故在 3086+);
  // 轮询发现后立即跳转,用户基本无感。
  const poll = async () => {
    try {
      const res = await fetch('/__dsh_url')
      if (res.status === 200) {
        const { url } = await res.json()
        if (url) { location.replace(url); return }
      }
    } catch { /* server 重启间隙,继续轮询 */ }
    setTimeout(poll, 500)
  }
  poll()
</script></body>
</html>`

// 扫描 3086..3095,找 GET / 返回体含 __DSH_BOOT__ 的 dsh web 服务;结果缓存。
let discoveredUrl = null
async function discoverDshWeb() {
  if (discoveredUrl !== null) return discoveredUrl
  for (let port = WAIT_PORT + 1; port <= WAIT_PORT + 10; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) })
      if (res.ok && (await res.text()).includes('__DSH_BOOT__')) {
        discoveredUrl = `http://127.0.0.1:${port}`
        console.log(`[dev-dsh-shell] 发现真实 dsh web: ${discoveredUrl}`)
        return discoveredUrl
      }
    } catch { /* 端口未起或非 dsh,继续扫 */ }
  }
  return null
}

const server = createServer(async (req, res) => {
  if (req.url === '/__dsh_url') {
    const url = await discoverDshWeb()
    if (url === null) {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url }))
    return
  }
  // 截图遮罩页:dev 下 WebviewUrl::App("screenshot.html") 会解析到本 devUrl,
  // 占位 server 需要真实返回 frontendDist 里的文件(prod 由 tauri://localhost 直接读)。
  if (req.url === '/screenshot.html') {
    const file = join(repoRoot, 'shell-placeholder', 'screenshot.html')
    if (existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(file))
      return
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
server.on('error', (err) => {
  console.error(`[dev-dsh-shell] 占位端口 ${WAIT_PORT} 不可用: ${err.message}`)
  process.exit(1)
})
server.listen(WAIT_PORT, '127.0.0.1', () => {
  console.log(`[dev-dsh-shell] 占位等待页: http://127.0.0.1:${WAIT_PORT}(真实 dsh web 将就绪于 ${WAIT_PORT + 1}+)`)
})
