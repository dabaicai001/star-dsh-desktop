# @deepseek-ai/dsh-starhub-tool-context

StarHub 本地 host 包:把「用户当前在哪个 StarHub 工具、哪个资产连接上」注入每个 agent 请求的上下文,让模型感知当前工作面(方案第 4 章 4.3)。

## 行为

- client-nav(浏览器壳)在用户选择子类/资产时,经 settings 通道(`settings.update`)写入 `starhub-tool-context` namespace:`subcategory` / `assetId` / `assetName` / `routePrefix`。
- 本插件在 `agent/pre-step`(prepend 监听器)读取该 namespace,有选中工具或资产时注入一条 plugin 来源的 user message(快照形态);全部为空时 no-op,不打扰对话。
- namespace 由 Schemastery Schema 校验;旧运行时无该 namespace 时读取为空,自然降级为不注入。

## Model Experience

### Injected tool-context message

#### What the model sees

A plugin-sourced user message naming the current selection, e.g. `Tool: database` / `Asset: production-mysql` (optional `Route: /database`); nothing is injected when the selection is empty.

#### Token effect

One short list per request, only while a tool or asset is selected.

#### KV Cache effect

Per-step snapshot; the text changes only when the selection changes.

## Known Limitations and Deferred Work

- 只携带"当前选择"快照,不携带资产连接状态/凭据信息;深度上下文(库表、连接健康)由各工作台自身承担。
- 选择写入依赖 client-nav 在切换时主动 `settings.update`;宿主进程重启后未重选前 namespace 保留旧值。
