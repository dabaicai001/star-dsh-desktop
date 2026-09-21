#!/usr/bin/env node
/**
 * tauri:dev 的 beforeDevCommand(P4a 起 dsh 壳是唯一主壳,双轨制已取消)。
 *
 * 依次执行:
 * 1. vendor dsh 构建产物存在性检查(client lib / web dist / CLI bin 缺失才构建;
 *    vendor 构建需要 PATH 里有 pnpm,取仓库根 tmp/pnpm-home;严禁 CI=true)
 * 2. sidecar:build(setup 钩子对 sidecar 版本 fail loud)
 * 3. build:window(StarHub React workbench dist → dist-starhub-react/,host-static 托管)
 * 4. 前台占位等待页 server 监听 3185:tauri dev 要等 devUrl 可访问才启动应用,
 *    而真实 dsh web 由 Rust DshWebManager 在 setup 里拉起——3185 被本占位进程
 *    占用,管理器递增到 3186+。占位页经 Tauri invoke 轮询 `dsh_web_url` 并
 *    location.replace 过去(与 prod 跳板页同机制;DSH 0.1.6 起 web app 有进程
 *    token 认证,裸根路径 401,Rust 侧捕获 tokenized URL 后经该 command 返回)。
 *    应用退出时 tauri 回收本进程树。
 * 端口(2026-08-23 起)与正式实例隔离:本脚本是 dev 专属,占位页固定 3185
 * (正式 release 实例保持 3085,见 web.rs DEFAULT_PORT 的 debug/release 分支),
 * 避免与本机常驻正式实例的 dsh web(3085)冲突。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(repoRoot, 'vendor', 'deepseek-harness')
const WAIT_PORT = 3185

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

// 2. sidecar + 3. obscura + React workbench dist
run('sidecar:build', 'npm', ['run', 'sidecar:build'], { cwd: repoRoot })
run('obscura:build', 'npm', ['run', 'obscura:build'], { cwd: repoRoot })
run('build:window', 'npm', ['run', 'build:window'], { cwd: repoRoot })

// 4. 占位等待页(前台常驻;tauri 等待 devUrl=3185 可访问后才启动应用)
// DSH 0.1.6 适配(2026-09-20):web app 引入进程 token 认证,裸根路径返回 401、
// body 不再含 __DSH_BOOT__,原「端口扫描 + body 标记」发现机制失效;且 node
// 侧看不到子进程 stdout 里的 tokenized URL。改为与 prod 跳板页(shell-placeholder/
// index.html)一致:页面经 Tauri invoke 轮询 `dsh_web_url`(Rust 的 web_read_loop
// 捕获 `dsh web: <tokenized URL>` 行后返回),拿到地址整窗跳转。
// node server 只保留伺服与 /screenshot.html。
const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>StarHub</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #080d14; color: #7f8b99; font: 14px/1.6 ui-monospace, monospace; }
</style></head>
<body><div id="msg">STARHUB dsh 壳启动中…(若长时间停留请查看终端日志)</div>
<script>
  var msg = document.getElementById('msg')
  function poll() {
    var tauri = window.__TAURI_INTERNALS__
    if (!tauri || typeof tauri.invoke !== 'function') { setTimeout(poll, 500); return }
    tauri.invoke('dsh_web_url')
      .then(function (url) { if (url) location.replace(url); else setTimeout(poll, 500) })
      .catch(function (err) {
        msg.textContent = 'dsh web 未就绪:' + String(err) + '(重试中…)'
        setTimeout(poll, 1000)
      })
  }
  poll()
</script></body>
</html>`

const server = createServer(async (req, res) => {
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
