# Agent Note: StarHub client-nav splits stores by slot scope and rides the hooks compartment

Status: implemented

[English](2026-08-16-starhub-client-nav-scope-split.md) | 中文

## Problem

`packages/starhub/client-nav`(StarHub 本地包,非上游)原先让四个 slot 注册共享同一个 store handle:`sidebar.navigation` 与 `shell.overlay` 是 `root` scope,而 `workspace` 与 `details.workspace` 是 `session-maybe`。store 注册表在首次挂载时钉死 handle 的 scope(one handle, one scope),因此任何声明了 workspace 槽位的组合在启动时抛出 `store handle mounted under "workspace" (scope "session-maybe") is already mounted under scope "root"`,整个插件加载失败——StarHub web GUI 只剩 "Failed to load plugins"。不声明 workspace 槽位的组合(旧 ui-layout 构建)永远不会触发该抛错,掩盖了这一缺陷。

拆开 handle 修复了启动崩溃,却暴露了第二条 renderer 规则:`scoped-slots.tsx` 只在 session-maybe 席位有会话时才挂载注册声明的 store(`scope === 'session-maybe' && info?.sessionId === undefined` 时跳过 `storeOf`),于是无会话的 workspace 席位拿不到 `useStore`/`actions`,渲染即以 `useStore is not a function` 崩溃。对这些席位而言,跨 scope 共享的状态根本无法走注册侧 store。

## Decision

`client-nav` 只保留一个注册侧 store:`createStarHubNavStore()`(root scope),由 `sidebar.navigation` 与 `shell.overlay` 共享。session-maybe 席位需要共享的一切——资产列表(`get_assets` 结果 + loading/error)与跨 scope 的工具选择(当前子类 + 打开的资产实例)——都住在插件 `apply` 里创建的 apply 持有裸 snapshot source(`createStarHubAssets`、`createToolSelectionBridge`),经各注册的 inject `hooks` 舱位下发为绑定的 `useAssets`/`useSelection` 选择器钩子;写入走注入回调(`openAsset`、`closeAsset`、`selectSubcategory`、`refreshAssets`)。这是 `ui-agent-preset` controller 范式扩展到两份 holder。`openAsset` 按资产派生实例路由前缀(`routePrefixForAsset`——PostgreSQL/Redis 资产不得继承数据库子类的 `/db/mysql` 前缀),并一次性生成 instance id,overlay 重渲染不会重建 iframe src。tool-context 的 settings 同步始终写全量四字段、空串清除,取消选中的资产不会滞留成过期 AI 上下文。[会话作用域架构 note](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) 拥有 session-maybe 收养语义;本 note 只拥有 client-nav 的状态拓扑。

## Alternatives considered

**两个 store handle,每 scope 一个。** 修得了启动抛错,修不了无会话崩溃:workspace 席位仍在无会话时渲染,而框架在该分支不下发 store 对。它还会把每次跨 scope 写入复制一份(nav 点击要同时抵达工作区列表与 overlay),重新引入现在由桥承接的耦合。

**让无会话席位降级渲染。** 把 `workspace` 退化为占位符直到有会话,违背 StarHub 方案(工具工作区正是无会话落地面),且 overlay 跨 scope 读选择的问题依旧存在。

**把所有状态并入 root scope 的 nav store。** overlay 与 nav 同属 root scope,但 workspace 两座席位是 session-maybe;root handle 挂到它们下面会触发同一个 one-handle-one-scope 抛错。

## Consequences

StarHub web GUI 在声明了 workspace 槽位的组合上正常启动(3086 测试实例在无头检查下渲染工具导航、工作区列引导态,控制台零错误),无会话落地面显示资产工作区而不再崩溃。代价是 client-nav 的共享状态不再走注册侧 store 的常规路径:每个跨 scope 字段都流经两份 apply 持有的 source 与其注入回调,测试必须显式 stub(`starhub-shell-state` 与工作区 spec,共 18 项测试)。资产列表在挂载与每次切换子类时重新拉取,用缓存换取对设置侧资产编辑的新鲜度。
