# Agent Note：StarHub 执行记录从右下角浮层迁入工具抽屉

Status: implemented

## Problem

v0.99.0 的执行面板为每个 SSH 会话连接在 dsh 主壳右下角堆叠一张固定定位卡片。
三个缺陷叠加：「拖动重排」手势天然不可靠（只有光标进入另一面板矩形才交换，
且每次重排都会移动已被浏览器授予 pointer capture 的 DOM 节点——捕获被隐式
释放，后续 move 事件全部丢失）；多会话同时静默执行时右下角被卡片占满且无处
安放；监听器挂在会随浮层重挂载的组件上，订阅生命周期跟随挂载顺序。

## Decision

静默执行输出移入右侧工具抽屉。新增「执行」胶囊（`ExecDrawerButton`，
`conversation.session.header.actions` 上 order 45，「文件」旁），开关
apply 持有的 `execRecords` 桥的 `viewOpen`；抽屉席位（`StarHubToolWorkspace`）
在该视图打开时渲染 `ExecRecordList`——每个会话连接一行默认收起（徽标、命令、
时间），点击展开完整输出/再点收起，列表纵向滚动，「清空」一键清空。桥最多保留
50 条记录，按 `dsh:` 前缀的 sessionId 去重（最新在上），忽略非 AI 会话。
`ssh:exec-done` 的 Tauri 订阅上移进 `apply` 的插件级 `ctx.effect`，采集不再
依赖任何组件挂载。原 `shell.overlay` 的 BastionExecPanel 席位、组件、样式与
测试删除。两个视图互斥（文件树 vs 执行），关闭抽屉经同一组合式 `closeTools`
复位两个开关。

## Alternatives considered

**修浮层的拖动。** 即便换成 window 级 move 监听 + 中点交换算法，N 张固定
卡片仍是无上限的悬浮层，持续挤压真实界面空间；抽屉复用既有表面。

**把每会话徽标钉在对话输入区。** 历史没有可滚动的家，而且把 root scope 数据源
耦合进 session-scope 席位，相比头部胶囊没有任何增益。

## Consequences

拖动特性是有意移除、不做替代：抽屉内即最新在上、顺序稳定。跨多个绑定资产的
AI 静默执行在一处可观察。组件回归纯展示（记录只经 props / 注入回调进入），
本就是客户端纪律的要求；单条输出仍受后端 4000 字符截断约束。

## Related

- [StarHub File Viewer Overlay](../feature/2026-08-21-starhub-file-viewer-overlay.zh.md) — 本改造复用的裸 source 桥 + 抽屉席位范式。
