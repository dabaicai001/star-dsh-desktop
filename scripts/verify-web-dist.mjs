// 打包链守卫:确认 vendor 的 web 前端产物(apps/web/dist)是刚刚构建出来的。
//
// 背景(v0.121.6 踩坑):vendor 的 `pnpm run build`(scripts/build.ts)以
// `import.meta.main` 自执行;该属性在 Node 24.0.x 不存在(24.2+ / 22.19+ 才有),
// 用这类 node 跑会**静默退 0 而不构建任何东西**。StarHub 打包链此前只依赖
// package-dsh-runtime 内部的 `pnpm run build` 重建 web dist,一旦它静默跳过,
// 磁盘上遗留的旧 dist(如 vendor 快照替换前 08-26 的产物)就会被原样打进
// 安装包 —— 表现为装出来的 GUI 报 "Failed to load plugins … missed the module
// table"(旧 dist 的模块表没有新基线包)。CI 全新检出没有旧 dist,existsSync
// 校验会失败所以是响的;只有长期开发的树(旧 dist 残留)会静默中招。
//
// 修复分两层:
// 1. beforeBuildCommand 显式跑 `npm run build:web`(直连 vendor 的 vite build,
//    不经过 import.meta.main,任何 Node 版本都真构建);
// 2. 本脚本紧跟其后 fail-loud:dist 必须是在最近 FRESH_WINDOW_MINUTES 分钟内
//    写入的,否则中断打包——防止将来链路漂移再次静默跳过。
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distIndex = join(repoRoot, 'vendor', 'deepseek-harness', 'apps', 'web', 'dist', 'index.html')
const FRESH_WINDOW_MINUTES = 60

if (!existsSync(distIndex)) {
  console.error(`verify:web-dist: 未找到 ${distIndex}`)
  console.error('verify:web-dist: 先跑 npm run build:web(vendor 的 vite build)')
  process.exit(1)
}

const builtAt = statSync(distIndex).mtimeMs
const ageMinutes = (Date.now() - builtAt) / 60_000
if (ageMinutes > FRESH_WINDOW_MINUTES) {
  const builtAtText = new Date(builtAt).toISOString()
  console.error(`verify:web-dist: web dist 陈旧(${builtAtText},${ageMinutes.toFixed(0)} 分钟前),中止打包`)
  console.error('verify:web-dist: 跑 npm run build:web 重建;若刚跑过仍报此错,检查 node 版本(≥22.19/≥24.2)——')
  console.error('verify:web-dist: vendor 的 scripts/build.ts 以 import.meta.main 自执行,旧 node 上会静默跳过整个构建。')
  process.exit(1)
}

console.log(`verify:web-dist: web dist 新鲜(${ageMinutes.toFixed(1)} 分钟前)`)
