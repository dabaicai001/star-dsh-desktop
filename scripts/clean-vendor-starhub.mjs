// 打包前清理 StarHub 本地包的 lib 产物(防「源码改了但旧产物进包」)。
//
// 背景:tauri:build 的 beforeBuildCommand 依赖 package:dsh-runtime 内部的
// build:lib 全量重编译;但本地增量开发时 lib/ 产物可能停留在旧版本,且若
// tsc 编译失败未中断打包,旧产物会被静默拷贝进 dsh-runtime → exe(v0.99.0
// 踩坑:前端 client-nav 改完未重建,exe 里还是旧 BastionSelectCard,「选机器
// 浮层不关闭」修复没进包)。
//
// 本脚本删除 vendor/deepseek-harness/packages/starhub/*/lib(tsc 的 lib/types
// 与 tsdown 的 lib/*.js 一并清掉),让打包流程里的 build:lib 必然全量重编译:
// 编译错误必然暴露并中断打包,产物必然反映最新源码。只清 StarHub 本地包,
// 不动上游 packages/client/* 与 vendor/*(它们由 package-dsh-runtime 的
// clearClientBuildCache + 增量 tsc 处理,无需每次全量)。
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const starhubDir = join(root, 'vendor', 'deepseek-harness', 'packages', 'starhub')

let cleared = 0
for (const entry of readdirSync(starhubDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const libDir = join(starhubDir, entry.name, 'lib')
  if (!existsSync(libDir)) continue
  rmSync(libDir, { recursive: true, force: true })
  cleared += 1
}

if (cleared > 0) {
  console.log(`clean:vendor-starhub: 已删除 ${cleared} 个 StarHub 包 lib 产物,打包将全量重编译`)
} else {
  console.log('clean:vendor-starhub: 无 lib 产物可清理')
}
