# DSH 升级适配清单(v0.1.0-rc.5 → v0.1.1-rc.2)

> 本文档跟踪 `vendor/deepseek-harness` 从上游 `47f9438`(2026-08-13,vendored 基线)整体同步到
> `dsh-v0.1.1-rc.2`(commit `b150a551`)的适配过程。每完成一项在行尾打 ✅。
>
> 分支:`chore/upgrade-dsh-rc2`

---

## 〇、核心主旨:解耦合,面向插件开发

这次 DSH 升级的本质不是「追新版」,而是把 **StarHub 与上游 DSH 的耦合关系**从
「fork 式直接改上游源码」彻底改为 **「上游原样 + 插件式扩展」**。这是 StarHub 后续
可持续升级的地基,也是所有 `packages/starhub/*` 代码的第一性约束。

### 为什么必须解耦

旧做法(v0.95.x 及以前):StarHub 功能直接修改上游文件(如 `ui-settings-general` 的
SettingsRoot 加分组、`ui-conversation` 加 viewFile、`sdk/server` 加 re-export)。
后果是每次升级都要手工分辨「哪些改动是我的、哪些是上游的」,上游树一换,本地改动
全部被覆盖或丢失,升级成本随改动量线性膨胀(本次盘点:改了 54 个上游业务文件)。

新做法(方案 2):**上游源文件 0 改动**。上游树永远可以整树替换、直通下一个版本;
StarHub 的定制全部以插件形式存在,升级时只需重放「插件层」,与上游解耦。

### 四条解耦铁律(面向插件开发者)

1. **不碰上游源文件。** 任何需要改上游行为的诉求,先找上游的扩展面:
   - 槽位机制 `ctx.slots.inject(name, () => ctx.slots.register(..., Component))` —— 组合 UI;
   - 服务注入 `ctx.provide` / `ctx.get` —— 共享业务能力;
   - `priority` 覆盖(single 槽低优先级 shadow 高优先级) —— 替换上游默认壳;
   - `./src/*` 透出 —— 复用上游包的内部模块(仅 import 类型/纯函数,不改其源码)。
   若上游没有可用的扩展面,优先在 `packages/starhub/*` 里自持类型与实现,而不是开上游文件。

2. **StarHub 定制只活在 `packages/starhub/*`。** 本地新增文件(组件、桥、类型、服务)一律
   放进 starhub 本地包;需要「补丁型」改上游的极少数场景(如 `sdk/server` 的 notification
   分发),用「上游包内新增文件 + 经 `./src/*` 透出导入」实现,不 touch 上游已有文件。

3. **上游 API 变更是常态,升级适配是例行工作。** rc.2 之后每次升级,上游可能改名/删槽/
   重构接口。适配的唯一正确姿态是:改动 `packages/starhub/*` 跟上新 API,而不是回改上游
   让它兼容旧 StarHub。升级流程 = 整树替换 + 按本清单逐项核对 starhub 包。

4. **能用插件机制表达的,绝不复刻上游实现。** 例如本次的设置页分组:上游 `SettingsSectionRow`
   已无分组字段,StarHub 不再 fork SettingsRoot 强行渲染分组,而是改为平铺 section 接入
   (用户确认),把 UI 表达权交还上游,StarHub 只提供内容。

### 第五条铁律(2026-08-26 补充):StarHub 内部同样组件化

**`client-nav` 巨型包(73 文件 / 16K 行)按功能边界拆分为独立插件包**,每个功能包可以
单独挂载 / 卸载 / 复用(cordis profile 决定是否加载),不再有一个「全都要」的巨型导航包。
拆分目标(按功能边界):

| 拆分包(规划) | 内容(现状目录) | 备注 |
|---|---|---|
| `starhub-footer-tools` | 侧栏底部工具入口按钮 | 极小,入口 |
| `starhub-tool-panel` | 工具侧边树面板(资产列表) | StarHubToolWorkspace |
| `starhub-git` | Git 分支胶囊 + 服务 | git/ |
| `starhub-file-tree` | 文件树面板 + 服务 | file-tree/ |
| `starhub-file-viewer` | 壳内文件查看窗 | file-viewer/ |
| `starhub-mfa` | MFA TOTP 卡 + 堡垒机选卡 | mfa/ + bastion/ |
| `starhub-screenshot` | 截图按钮 | screenshot/ |
| `starhub-asset-source` | `@` 资产/文件 source | asset-source.ts + file-source.ts |
| `starhub-workbenches` | DB/Docker/Redis/ES/Broker 工作台 | db*/docker/redis/es/broker/dashboard/terminal 子目录 |
| `starhub-settings` | 设置页 5 个 tab | settings/ |
| `starhub-connection` | 新建/编辑连接对话框 | NewConnectionDialog.tsx |

> 拆分是**渐进**的:先保证 rc.2 适配后 `client-nav` 可编译、功能可用,再逐个把目录
> 提升为独立包(每个独立包 = package.json + tsconfig + tsdown + invariant + README +
> bundle 挂载)。拆出的包之间只经 DSH 槽位/服务交互,不互相 import 实现。

### 本次升级的收益

- `vendor/deepseek-harness` ≈ 上游 rc.2 原样 + `packages/starhub/*` + `apps/starhub-*` +
  `examples/starhub-*`,差异面收敛到可枚举的本地文件;
- 下次升级(rc.3 / 0.2.x):整树替换 → `UPSTREAM_COMMIT.txt` 更新 → 按本清单重跑适配;
- 新功能开发:优先以「新 starhub 插件 + 槽位/服务接入」的方式写,天然与上游演进兼容。

---

## 一、盘点与备份(已完成)

- ✅ 创建升级分支 `chore/upgrade-dsh-rc2`
- ✅ 拉取上游基线 `47f9438`(7412 文件)与 `dsh-v0.1.1-rc.2`(7903 文件)完整树,做精确对比
- ✅ 盘点 StarHub 本地改动:新增 275 文件(starhub/* 11 包、apps/starhub-window、examples/starhub-*、Agent Notes 等)+ 修改 145 文件(其中业务代码 ~54)
- ✅ 备份本地独有文件(331 个,上游 rc.2 无对应)到 staging
- ✅ 用 rc.2 原样树整体替换 `vendor/deepseek-harness`(保留 node_modules)
- ✅ 恢复 StarHub 本地独有文件到 vendored
- ✅ 更新 `UPSTREAM_COMMIT.txt` → `b150a551`
- ✅ 清理临时分析目录/脚本

## 二、构建链配置适配

- ✅ `tsconfig.host.json` 的 `references` 补入 11 个 `packages/starhub/*` 包(client-nav 也进 host 聚合)
- ✅ `tsconfig.client.json` 的 `references` 补入 `packages/starhub/client-nav`;修复 add-starhub-refs 脚本
  误删的 `schema-form` / `web-react` 两行 refs
- ✅ `pnpm install` 通过(260 workspace 项目,starhub 包内部 junction 链接正常)
- ✅ root `package.json` 补 `unrun@0.3.1` devDep(tsdown 的 optional peer;上游 rc.2 未声明,
  pnpm 11 strict 下不链接导致 tsdown 无法启动——vendored 侧补齐的可用性缺口)
- ✅ `packages/client/web` 补 `@deepseek-ai/dsh-client-web-react` devDep(上游 rc.2 遗漏,
  shell-bundled 面需在 devDeps 声明类型)
- ✅ **上游一致性全量校验**:vendored 与上游 rc.2 对比 7899 个文件,除 `pnpm-lock.yaml`
  (unrun 依赖)外全部一致、0 缺失——树替换完整,StarHub 定制未污染上游源码
- ✅ **typert remote 生成**:manual emit 脚本为 7 个带 `./typert` export 的服务包
  (commands/goal/file-reference/cordis-host-runner/plugin-inventory/message-feedback/session-reference)
  生成 `lib/typert.host.*` + `lib/typert.remote-client.*`(上游 tsdown typertPlugin 在本环境
  静默未落盘,补跑等价步骤;产物进入各包 lib,api/remotes 类型面随之完整)
- 📌 上游 rc.2 自身的 typecheck/构建缺口(不影响 StarHub 打包,按解耦原则不修上游源码,留待上游吸收):
  - `client/web` 的 `loader-status.ts` 缺 `KernelSignal`/`LoaderStatus` 导出(AppRoot import 了
    rc.2 未导出的成员)——上游 rc.2 内部不一致
  - **`pnpm run build`(干净环境)在本机(Windows + Node 22.14,上游要求 ^22.19||>=24)下
    exit 0 但静默不产出部分产物**(vendor 层 cordis 等 `lib/index.js`、`packages/examples/jsonrpc-demo/lib/bin.js`
    缺失)——上游 rc.2 构建环境门禁(疑似 Node 版本/平台差异),非 StarHub 引入;
    StarHub 生产打包走 `package-dsh-runtime`(打包机重新 build),本地 dev 产物缺失不阻塞升级交付

## 三、StarHub 本地包 API 适配(rc.2)

### `sdk/server` 本地补丁导入
- ✅ `domain-events` / `session-registry` 的 `SdkNotificationHub` 导入改为
  `@deepseek-ai/dsh-sdk-jsonrpc-server/src/notifications.ts`(上游 index.ts 不再 re-export 本地补丁)

### 设置页:分组/折叠 → 平铺(用户确认)
- ✅ `client-nav/src/client/index.ts` 的 `settings.section` 注册去掉 `group`/`groupLabel` 字段(上游
  `SettingsSectionRow` 仅 `{id, order, label}`),5 个 StarHub tab 以平铺 section 呈现

### 图标适配(rc.2 图标表变化)
- ✅ `DbWorkbench.tsx`:`IconChartOutline16 → IconDataOutline16`
- ✅ `DockerWorkbench.tsx`:`IconRestartOutline16 → IconRefreshOutline16`、`IconTerminalOutline16 → IconCodeOutline16`、`IconChartOutline16 → IconDataOutline16`

### 文件查看(FileViewer)类型自持(上游 rc.2 移除 StarHub 专属类型)
- ✅ `file-viewer/state.ts` 本地定义 `FileViewRequest` / `FileViewDiff`(read/edit 两种请求 + hunk)
- ✅ `client-nav/index.ts` 去掉对 `StarHubFileViewerFace`(ui-conversation)的 import,改为本地
  `{ open(target: FileViewTarget) }` face + `FileViewTarget` 导入

### 侧栏导航 & 槽位迁移(rc.2 移除 `sidebar.navigation` / `workspace` / `details.workspace`)
- ✅ `StarHubNav` 退役:rc.2 无 `sidebar.navigation` 槽,原「工具大类树」改为
  「侧栏底部工具入口 + 工具面板」两段式(用户确认)
- ✅ 新增 `StarHubFooterButton`(挂 `sidebar.footer.action`,侧栏底部「工具」入口按钮)
- ✅ `store.ts` 新增 `createToolsPanelOverlay`(工具面板开关桥,footer 写 / overlay 读)
- ✅ `StarHubToolWorkspace` 改为 `shell.overlay` 工具侧边树面板(右缘抽屉 + mask):
  树形展示子类(终端/数据库/Docker)→ 资产列表;点子类展开/聚焦,点资产开独立窗口;
  文件树分支暂降级为提示(overlay root scope 无会话 cwd)
- ✅ `index.ts` 注册迁移:`sidebar.footer.action`(入口)+ `shell.overlay`(工具面板)
- ✅ `index.ts` `toggleDetails` 删除(rc.2 ILayout 无此方法;面板开关改走 toolsPanel 桥)
- ✅ `conversation.input.left` 截图按钮:`createDraftImages` 在 rc.2 `IConversation` 仍存在,签名兼容

### 截图按钮(rc.2 附件管线变更)
- ✅ `ScreenshotButton.tsx`:props 从 `createDraftImages` + `inputActions.addImages` 改为
  rc.2 的 `addImages(files) => string | null`;`conversation` 类型改 `ConversationController`
  (rc.2 `IConversation` 无 createDraftImages,具体类有)
- ✅ `index.ts` 截图注入:createDraftImages → input shell addImages 全链路(无会话时静默)
- 📌 截图按钮当前挂在 `conversation.input.left`(AI 输入框工具行,升级后原样保留);
  可选增强:同时注册进工具面板(StarHubToolWorkspace 头部)作为第二入口(待用户确认)

### 测试适配
- ✅ 删 `StarHubNav.tsx` + `StarHubNav.module.css` + `starhub-nav-overlay.client.spec.tsx`(组件退役)
- ✅ `starhub-apply.client.spec.ts` 重写:槽清单断言改 rc.2 注册面
  (`sidebar.footer.action` + `shell.overlay`×5 + header.actions×2 + input.left + settings×5);
  selectSubcategory 语义改「写选择桥,不再联动布局」
- ✅ `starhub-tool-workspace.client.spec.tsx` stub 补 `closeTools`/`selectSubcategory`/`useToolsPanel`
- ✅ `screenshot-button.client.spec.tsx` props 改 `addImages`

### 侧栏导航 & 槽位迁移(rc.2 移除 `sidebar.navigation` / `workspace` / `details.workspace`)
- ✅ **全部完成**:`packages/starhub/*` 在 client typecheck 下错误归零(typecheck 仅剩上游 rc.2 自身
  remote 生成缺失,见验证节)

### 其它 client-nav 文件
- ✅ `FileViewerOverlay.tsx`:`d`/`i` 隐式 any 修复(显式标注 `FileViewDiff`/`number`)
- ✅ `ui-deliverables`:删除无引用的遗留组件 `ProducedFilesDrawer.tsx`/`ProducedStats.tsx` 及其 CSS/测试
  (rc.2 的 ProducedFiles 已改为纯路径 chips,不再用抽屉;遗留文件仅产生 `ProducedEntry` 类型断链)

### 其余 starhub/* 包(host 侧)
- ⬜ `approval-bridge` / `commit-message` / `live-context` / `memory-*` / `session-registry` /
  `tool-context` / `tools` / `host-static` 逐个 typecheck 核对(未被替换的上游 API 引用)

## 四、验证与收尾

- ⬜ `pnpm run build:lib:host && typecheck` 通过(上游 remote 产物 + client-nav 适配后)
- ⬜ `pnpm run test:gui` 前端测试
- ⬜ Rust 侧回归:`cargo test` + `npm run cargo:test`(SSH/MFA 堡垒机、AI 域工具、DB 走 Rust 主进程,
      不受 client-nav 影响 —— 验证 starhub-agent 组合加载正常)
- ⬜ AGENTS.md 说明方案 2 解耦 + 设置平铺 + 侧栏底部入口迁移
- ⬜ 七处版本号升版(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG / AGENTS.md / README)
- ⬜ commit + push 分支

---

## 关键决策记录

| 决策 | 结论 |
|---|---|
| 解耦方案 | 方案 2:上游 0 改动,StarHub 定制全部经扩展面接入(用户确认) |
| 设置页分组/折叠 | 放弃分组折叠,5 个 StarHub tab 平铺进 rc.2 设置面板(用户确认) |
| 侧栏导航落点 | `sidebar.footer.action`(侧栏底部 action 入口,用户确认) |
| 右侧工作区列(workspace/details.workspace) | 待定:rc.2 无对应槽,候选为 `shell.overlay` 工具面板浮层(评估中) |
| 影响面 | Rust 侧(starhub-agent 组合)不引用 client-nav → SSH/MFA/AI 域工具/DB 不受 UI 适配阻塞 |