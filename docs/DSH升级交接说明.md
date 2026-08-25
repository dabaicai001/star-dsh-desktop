# DSH 升级交接说明(v0.1.1-rc.2 升级分支)

> 本文档是给**接手此升级任务的 AGENT/开发者**的完整交接,包含当前状态、已完成、
> 待办、关键路径与坑。工作区:分支 `chore/upgrade-dsh-rc2`,仓库 `D:\code\new_project\starhub`。

---

## 0. 一句话现状

`vendor/deepseek-harness` 已整体替换为上游 `dsh-v0.1.1-rc.2`(commit `b150a551`),StarHub
11 个本地包(`packages/starhub/*`)已按**方案 2(解耦/面向插件开发,上游 0 改动)**完成适配:
**host typecheck 零错误、host 单测 145 过、Rust cargo test 164 过、client-nav 测试 857/857 全绿、
client typecheck 零错误**(见第 7 节「本次接手修复」)。当前分支已有 4 个 checkpoint commit。

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
| **[本次] tsconfig.base.json 补 dsh-client-web-react + 10 个 dsh-starhub-* paths** | ✅ | 见第 7 节 |
| **[本次] web/tsconfig.json 补回丢失的 4 个 references** | ✅ | 见第 7 节 |
| **[本次] 恢复 loader-status.ts 缺失实现(client typecheck 6→0)** | ✅ | 见第 7 节 |

## 2. 待办(按优先级)

### #1 ✅ 已解决 client 包连锁 lib 解析(原 2 个 suite 红)
- 原现象:`ai-chat-panel` / `starhub-apply` 2 个 suite 报
  `Failed to resolve import "@deepseek-ai/dsh-client-ui-slots" from packages/client/web-react/lib/index.js`
- **根因(本次查明)**:tsconfig.base.json 的泛化通配 `@deepseek-ai/dsh-*` → `./packages/<group>/*/src`
  对 `client-` 前缀包拼不出 `client/<name>` 双层路径,而 rc.2 又**丢了旧副本里
  `@deepseek-ai/dsh-client-web-react` 的显式 paths 映射**;同理 starhub 包(带 `starhub-`
  前缀)的 10 个显式映射也在升级时丢失。丢失后测试把 `dsh-client-web-react` 解析到
  node_modules 真实 main(`lib/index.js`,tsdown 产物本机缺失)→ 连锁到 ui-slots 缺 lib → suite 红。
- **解法**:tsconfig.base.json 补回 `@deepseek-ai/dsh-client-web-react` + 10 个 `dsh-starhub-*`
  显式 paths(与旧副本一致),`dsh-*` 通配尾部补 `./packages/starhub/*/src`。**测试全走 src,
  不再依赖任何 client 包 lib 产物**。
- 附带修正 2 个此前从未真正跑过的断言:
  - `starhub-apply.client.spec.ts` footer 测试:`injected.hooks.toolsPanel` 实际在**工具面板
    (workspace)槽**的 inject hooks 舱位,footer 槽只有 `openTools`;测试改为查 register[5]
  - source 测试:`toMatchObject({ id })` → `{ name }`(rc.2 `InputTriggerSource` 以 `name` 标识)
- 结果:**client-nav 53 suite / 857 tests 全绿**(此前被跳过的 34 个测试真正跑起来)。

### #2 [环境限制,非代码问题] 上游 vendor 层 lib 产物缺失 / tsdown 全量构建不可用
- 现象:`pnpm run build` 在 tsdown 阶段崩,报
  `no packages/*/*/package.json declares the name @deepseek-ai/dsh-api-remotes`(host face)
  或 `... @deepseek-ai/dsh-api-gateway`(client face)
- **判定(本次确认)**:上游 `engines` 要求 **Node `^22.19||>=24`,本机是 22.14**;tsdown
  workspace 发现在此 Node 下失效(扫描不到 workspace 包),与代码无关
- 候选:升级本机 Node 到 `^22.19` 或 `>=24` 后 `pnpm run build` 应恢复;或接受
  「本机以 tsc 直出 + `emit-typert-remotes.mjs` 手动产物为准」,生产打包
  (`package-dsh-runtime`)在正确 Node 版本下跑。**本机已验证的可用路径**:
  - `pnpm exec tsc -b tsconfig.host.json` ✅ 零错误(starhub host 包 lib 直出)
  - `pnpm exec tsc -b tsconfig.client.json` ✅ 零错误
  - `node scripts/emit-typert-remotes.mjs` ✅ 再生 7 个 typert 产物
  - `pnpm vitest run packages/starhub` ✅ 全绿
  - ⚠️ `lib/` 被 `.gitignore` 忽略,**产物不 commit**;换环境需重跑上面前三步

### #3 [收尾] 升版 + 提交
- 按 AGENTS.md 升七处版本号(z+1,当前 v0.96.1 → v0.96.2),CHANGELOG 记录升级
- README/AGENTS 的版本描述同步
- 完整回归后再 push 分支(本次已回归:host 145 / client-nav 857 / Rust 164 / typecheck 双零)

---

## 3. 关键验证命令(接手后先跑)

```bash
cd D:\code\new_project\starhub\vendor\deepseek-harness

# 1. starhub host 包 typecheck(应零错误)
pnpm exec tsc -b tsconfig.host.json 2>&1 | Select-String "error TS" | Select-String starhub

# 2. starhub host 单测(应 145 过)
pnpm vitest run packages/starhub/approval-bridge/tests packages/starhub/domain-events/tests packages/starhub/session-registry/tests packages/starhub/live-context/tests packages/starhub/memory-context/tests packages/starhub/memory-sink/tests packages/starhub/tool-context/tests packages/starhub/commit-message/tests

# 3. client-nav 测试(应 857 全绿)
pnpm vitest run packages/starhub/client-nav/tests

# 4. Rust 回归(应 164 过)
cd D:\code\new_project\starhub && npm run cargo:test
```

## 4. 关键坑速查

- **tsdown 全 workspace 构建被 Node 版本卡**:报「no package declares @deepseek-ai/dsh-api-remotes
  / dsh-api-gateway」,根因是**上游要求 Node ^22.19||>=24,本机 22.14**(tsdown workspace 发现失效),
  非 remote 产物问题(产物已由 `scripts/emit-typert-remotes.mjs` 生成,见待办 #2 判定)。
  **不要试图改 tsdown 配置绕过**——升 Node 或接受本机以 tsc 直出为准。
- **starhub host 包 exports 已改指向 lib/types/**:main/exports 的 default 是 `./lib/types/X.js`
  (tsc 直出)。**不要再改回 lib/index.js**(那是 tsdown bundling 路径,本环境不产出)
- **tsconfig.base.json 必须保留**:`@deepseek-ai/dsh-client-web-react`(1 条)+
  `@deepseek-ai/dsh-starhub-*`(10 条)显式 paths + `dsh-*` 通配尾部 `./packages/starhub/*/src`。
  删掉任何一条都会让对应包在测试里解析到 node_modules lib 而连锁失败(见待办 #1)。
- **web/tsconfig.json 必须保留**:references 里 `web-react` / `ui-renderer` / `runtime` /
  `schema-form` / `ui-attachment` 缺一不可——rc.2 上游自身丢了这些,删掉会触发 client
  typecheck 的 rootDir/TS6307(见第 7 节)。
- **loader-status.ts 已补回实现**:rc.2 升级时该文件**后半部分丢失**(`KernelSignal` /
  `LoaderStatus` / `createSignal` / `createLoaderStatusStore` 全缺),但 boot.tsx / AppRoot /
  spec 都在用,导致 client typecheck 6 错。已从旧副本(上游 47f9438)恢复,见第 7 节。
  **这是唯一一处「改上游 src」的补丁**,其余仍守解耦铁律。
- **`scripts/build-vendor-layer.mjs`**:为无自己 tsdown.config 的 vendor 包(cordis 等)构建的辅助脚本,
  但会被 Node 版本卡;优先用 tsc 直出 + emit-typert-remotes
- **解耦铁律**:上游文件不修改(loader-status.ts 是唯一记录在案的例外补丁);StarHub 定制
  只在 `packages/starhub/*` + tsconfig 适配 + 文档记录。若要改上游行为,先找 slot/服务/priority 扩展面

## 5. 分支与 commit

- 分支 `chore/upgrade-dsh-rc2`(基于 main 的 beaf4e8b)
- commit 1 `c48b4b1b`:整体升级 + StarHub 适配 + 文档
- commit 2 `e59642d2`:工具面板文件树恢复 + exports 修复 + 构建补丁
- commit 3 `abf154a9`:DSH 升级交接说明(供接手 AGENT)+ 适配清单回归状态更新
- commit 4(本次):测试全绿 + 升版 v0.96.2 + 文档更新(见第 7 节)
- 后续工作在此分支继续

## 6. 用户明确诉求(勿丢)

1. **主旨:解耦合,面向插件开发**——StarHub 与上游解耦、StarHub 内部组件化(每个功能可独立挂载)
2. 设置页分组/折叠 → 已确认改为平铺
3. 侧栏工具入口 → 已确认移到侧栏底部(sidebar.footer.action),工具面板以树展示
4. 分支功能(GitBranchPill)/文件功能(文件树/查看器)→ 已在适配中保留(header.actions 槽 + 面板内文件树)
5. **功能回归测试**——升级后必须回归 SSH/MFA 堡垒机、AI 域工具、DB、文件、分支、截图等

## 7. 本次接手修复(commit 4,测试充分后提交)

| 修复 | 文件 | 说明 |
|---|---|---|
| 补 `dsh-client-web-react` + 10 个 `dsh-starhub-*` paths | `vendor/deepseek-harness/tsconfig.base.json` | 解决 client-nav 2 suite 红 + host 2 suite 红(包互引解析) |
| 补 web/tsconfig.json 丢失 references | `vendor/deepseek-harness/packages/client/web/tsconfig.json` | web-react/ui-renderer/runtime/schema-form/ui-attachment,解决 client typecheck rootDir/TS6307 |
| 恢复 loader-status.ts 缺失实现 | `vendor/deepseek-harness/packages/client/web/src/loader-status.ts` | 从旧副本恢复 KernelSignal/createSignal/createLoaderStatusStore 等,client typecheck 6→0 |
| 修正 2 个测试断言 | `vendor/deepseek-harness/packages/starhub/client-nav/tests/starhub-apply.client.spec.ts` | footer 测试查 workspace 槽 hooks;source 用 name 而非 id |
| 再生 typert remote 产物 | 7 个服务包 lib | `node scripts/emit-typert-remotes.mjs`(产物不 commit,需重跑) |

**本次回归结果(全部通过后 push)**:
- host typecheck 零错误 ✅
- client typecheck 零错误 ✅(含 loader-status 修复)
- host 单测 145/145 ✅(此前 78 过但 2 suite 因 import 失败跳过)
- client-nav 857/857 ✅(此前 823 过 / 2 suite 红)
- Rust cargo test 164/164 ✅

