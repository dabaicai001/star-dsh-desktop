# DSH 升级交接说明(v0.1.1-rc.2 升级分支)

> 本文档是给**接手此升级任务的 AGENT/开发者**的完整交接,包含当前状态、已完成、
> 待办、关键路径与坑。工作区:分支 `chore/upgrade-dsh-rc2`,仓库 `D:\code\new_project\starhub`。

---

## 0. 一句话现状

`vendor/deepseek-harness` 已整体替换为上游 `dsh-v0.1.1-rc.2`(commit `b150a551`),StarHub
11 个本地包(`packages/starhub/*`)已按**方案 2(解耦/面向插件开发,上游 0 改动)**完成适配:
**host typecheck 零错误、host 单测 78 过、Rust cargo test 164 过、client-nav 测试 823/823 过**
(2 个 suite 因 client 包连锁 lib 解析失败,见待办 #1)。当前分支有 2 个 checkpoint commit。

---

## 1. 已完成(全部经 commit)

| 项 | 状态 | commit |
|---|---|---|
| 上游树整体替换 rc.2 + StarHub 本地文件恢复 + UPSTREAM_COMMIT 更新 | ✅ | `c48b4b1b` |
| tsconfig host/client 补 starhub references(修复误删 schema-form/web-react) | ✅ | 两个 commit |
| 11 个 starhub 包 API 适配(typecheck 零错误) | ✅ | `c48b4b1b` + `e59642d2` |
| 设置页分组/折叠 → 平铺(上游无分组字段) | ✅ | `c48b4b1b` |
| 侧栏导航 → sidebar.footer.action 底部入口 + shell.overlay 工具侧边树面板 | ✅ | `c48b4b1b` + `e59642d2` |
| 截图按钮适配 rc.2 附件管线(addImages) | ✅ | `c48b4b1b` |
| 文件查看类型本地自持(FileViewRequest 等) | ✅ | `c48b4b1b` |
| starhub host 包 exports/main 指向 lib/types/*.js(tsc 直出,免 tsdown) | ✅ | `e59642d2` |
| typert remote 产物生成(emit-typert-remotes.mjs,7 个服务包) | ✅ | `e59642d2` |
| 回归测试:Rust 164、host 78、client-nav 823 | ✅ | 见第 3 节 |
| 升级清单文档 docs/DSH升级适配清单-v0.1.1-rc2.md(含解耦主旨) | ✅ | 两个 commit |

## 2. 待办(按优先级)

### #1 [阻塞测试] client 包连锁 lib 解析(2 个 suite 红)
- 现象:`ai-chat-panel` / `starhub-apply` 2 个 suite 报
  `Failed to resolve import "@deepseek-ai/dsh-client-ui-slots" from packages/client/web-react/lib/index.js`
- 根因:测试走包 main(`lib/index.js`),但 web-react 已 build 后它 import ui-slots,而 **ui-slots
  等 client 包的 lib 未全量生成**(`build:lib:client` 的 tsc 阶段被上游 loader-status 等错误中断)
- 已试:`pnpm run build:lib:client` 失败在 `client/web` 的 `loader-status.ts`(上游 rc.2 自身
  缺 `KernelSignal`/`LoaderStatus` 导出,非 StarHub 引入)
- **候选解法(按推荐序)**:
  1. **vitest alias 到 src**(最干净):vitest.config.ts 的 `resolve.alias` 把
     `@deepseek-ai/dsh-client-*` 映射到各包 `src/index.ts`(上游测试本应如此;tsconfig paths 已配,
     需确认 vite-tsconfig-paths 对 node_modules 包不生效的原因)
  2. **逐个 build client 依赖包**(web-react → ui-slots → ui-conversation → ui-layout → ...):
     每个 `pnpm exec tsc -b packages/client/<pkg> && pnpm exec tsdown --config packages/client/<pkg>/tsdown.config.ts --env.DSH_BUILD_FACE client`
  3. 修上游 loader-status(违背「上游 0 改动」,仅作最后手段,需在文档记录)

### #2 [待确认] 上游 vendor 层 lib 产物缺失(dev 布局启动隐患)
- 现象:`pnpm run build` exit 0 但 `vendor/cordis/lib/index.js`、`packages/examples/jsonrpc-demo/lib/bin.js`
  等缺失;Rust dev 布局(harness/mod.rs RUNTIME_BIN_REL)启动 dsh 需要它们
- 判定:上游 rc.2 构建环境门禁(疑似 Node `^22.19||>=24` vs 本机 `22.14`,或 tsbuildinfo 增量)
- 候选:`pnpm run clean && pnpm install && pnpm run build`(已试,仍缺);或接受「dev 布局在
  本机不可用,以 package-dsh-runtime 生产路径为准」,在文档记录为已知限制

### #3 [收尾] 升版 + 提交
- 按 AGENTS.md 升七处版本号(z+1,当前 v0.96.1 → v0.96.2),CHANGELOG 记录升级
- README/AGENTS 的版本描述同步
- 完整回归后再 push 分支

---

## 3. 关键验证命令(接手后先跑)

```bash
cd D:\code\new_project\starhub\vendor\deepseek-harness

# 1. starhub host 包 typecheck(应零错误)
pnpm exec tsc -b tsconfig.host.json 2>&1 | Select-String "error TS" | Select-String starhub

# 2. starhub host 单测(应 78 过)
pnpm vitest run packages/starhub/approval-bridge/tests packages/starhub/domain-events/tests packages/starhub/session-registry/tests packages/starhub/live-context/tests packages/starhub/memory-context/tests packages/starhub/memory-sink/tests packages/starhub/tool-context/tests packages/starhub/commit-message/tests

# 3. client-nav 测试(当前 823 过 / 2 suite 红,见待办 #1)
pnpm vitest run packages/starhub/client-nav/tests

# 4. Rust 回归(应 164 过)
cd D:\code\new_project\starhub && npm run cargo:test
```

## 4. 关键坑速查

- **tsdown 全 workspace 构建被 `api-remotes` 卡**:报「no package declares @deepseek-ai/dsh-api-remotes」,
  因 remote 产物未生成;已用 `scripts/emit-typert-remotes.mjs` 手动生成(7 个 typert 服务包),
  产物进各包 lib。**不要删这些 lib/typert.* 产物**
- **starhub host 包 exports 已改指向 lib/types/**:main/exports 的 default 是 `./lib/types/X.js`
  (tsc 直出)。**不要再改回 lib/index.js**(那是 tsdown bundling 路径,本环境不产出)
- **`scripts/build-vendor-layer.mjs`**:为无自己 tsdown.config 的 vendor 包(cordis 等)构建的辅助脚本,
  但会被 api-remotes 卡;优先用待办 #1 的解法
- **client/web 的 loader-status.ts 是上游 rc.2 自身缺口**(AppRoot import 未导出的成员),
  非 StarHub 问题;`package-dsh-runtime` 生产打包路径不依赖源码 typecheck
- **解耦铁律**:上游文件不修改;StarHub 定制只在 `packages/starhub/*` + 文档记录的补丁文件。
  若要改上游行为,先找 slot/服务/priority 扩展面

## 5. 分支与 commit

- 分支 `chore/upgrade-dsh-rc2`(基于 main 的 beaf4e8b)
- commit 1 `c48b4b1b`:整体升级 + StarHub 适配 + 文档
- commit 2 `e59642d2`:工具面板文件树恢复 + exports 修复 + 构建补丁
- 后续工作在此分支继续,完成待办后升版并 push

## 6. 用户明确诉求(勿丢)

1. **主旨:解耦合,面向插件开发**——StarHub 与上游解耦、StarHub 内部组件化(每个功能可独立挂载)
2. 设置页分组/折叠 → 已确认改为平铺
3. 侧栏工具入口 → 已确认移到侧栏底部(sidebar.footer.action),工具面板以树展示
4. 分支功能(GitBranchPill)/文件功能(文件树/查看器)→ 已在适配中保留(header.actions 槽 + 面板内文件树)
5. **功能回归测试**——升级后必须回归 SSH/MFA 堡垒机、AI 域工具、DB、文件、分支、截图等
