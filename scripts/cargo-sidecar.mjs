#!/usr/bin/env node
/**
 * cargo-sidecar.mjs — 跨平台跑 sidecar-rust 的 cargo。
 *
 * 为什么需要它:`scripts/cargo-sidecar.bat` 是 Windows 专用的(它负责加载 MSVC
 * 并把 rustup 工具链 bin 送上 PATH)。`npm run sidecar-rust:build` 原先直接指向
 * 那个 .bat,于是 CI 的 ubuntu matrix 一执行就 `sh: 1: scriptscargo-sidecar.bat:
 * not found`(exit 127)——Linux 上没有 cmd,也没法用 sh 跑 .bat。
 *
 * 分工:
 * - Windows:仍然走 .bat(MSVC 加载 + 工具链 PATH 是 Windows 上的刚需);
 * - 其它平台:直接调 cargo,只补 `--manifest-path sidecar-rust/Cargo.toml`。
 *   Linux/macOS 上 cargo 由 rustup 装在 PATH 里,不需要额外准备。
 *
 * 用法(与 .bat 一致):`node scripts/cargo-sidecar.mjs build [--release]`
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = join(root, 'sidecar-rust', 'Cargo.toml')
const args = process.argv.slice(2)

if (args.length === 0) {
  console.error('用法: node scripts/cargo-sidecar.mjs <cargo 子命令> [参数...]')
  console.error('例:  node scripts/cargo-sidecar.mjs build --release')
  process.exit(1)
}

let command
let commandArgs

if (process.platform === 'win32') {
  command = process.env.COMSPEC ?? 'cmd.exe'
  commandArgs = ['/d', '/c', join('scripts', 'cargo-sidecar.bat'), ...args]
} else {
  // cargo 的全局选项要放在子命令**之后**:`cargo build --manifest-path ...`,
  // 写在前面会报 "unexpected argument '--manifest-path'"。
  command = 'cargo'
  commandArgs = [...args, '--manifest-path', manifest]
}

const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' })

if (result.error) {
  console.error(`cargo-sidecar: 启动 ${command} 失败: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
