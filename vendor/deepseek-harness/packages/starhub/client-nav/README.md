# @deepseek-ai/dsh-starhub-client-nav

StarHub 浏览器导航插件(方案 P1,重构版):把 StarHub 工作台挂进 dsh web 壳的侧栏、右侧工具工作区列与设置面板。

## 行为

- **工具入口**(`sidebar.footer.action`):侧栏底部「工具」按钮,打开 shell.overlay 承载的工具抽屉(终端 / 数据库 / Docker 子类 + 资产列表);选择经 store/hooks 舱位下发,并同步写 `starhub-tool-context` settings namespace 供 AI 工具上下文注入。
- **Overlay**(`shell.overlay` 四次):连接对话框、MFA 验证卡、堡垒机选机器卡、工具抽屉(`StarHubToolWorkspace`)。
- **资产操作页**:数据库/终端/SFTP/Docker/Redis/ES 等资产实例经 `openNewPage` 在桌面端开独立 webview 窗口(浏览器预览退化为新标签页)。
- **会话头部**(`conversation.session.header.actions`):git 分支胶囊(分支 + 未提交脏点展示;v0.118.0 起融合为 Git 工作台入口,点击把工具抽屉切到跟随当前会话工作区的 Git 工作台视图并落在「分支」Tab——变更/暂存/取消暂存/放弃两步确认/单文件 diff(紧随选中项所在分段)/提交已暂存(含 AI 提交信息草稿)/历史(50 条 + git show 补丁)/分支搜索切换,页面重新可见时自动刷新当前 Tab,原胶囊弹层能力全部收进工作台;v0.119.0 起新增 ahead/behind 徽标与合并冲突检测——冲突文件置顶显示「标记已解决」与「中止合并」操作,提交区固定在底部不被长列表推走)与执行按钮(SSH 执行记录视图)。两个抽屉视图互斥。v0.121.8 起文件树按钮/`@` 文件源/壳内文件查看窗已移除(与 DSH 主壳 fs 工具、`ui-reference` 文件源、`ui-sidebar-files` 重复)。
- **设置分区**(`settings.section` ×7):审计、告警、沙箱平台、Android 设备、AI 浏览器、SSH、关于。(v0.123.1 起「插件市场」与「AI 助手」区块移除:前者由壳内首页「插件」面板接管,后者(长期记忆)整条栈退场。)
- **SFTP 传输中心**(v0.118.0):传输任务列表从 SftpPanel 内联区块升级为 overlay 级弹框(`TransferDialog` + 会话级投影 hook `useTransferTasks`)——任务监听挂在 SSH 工作区 overlay 而非面板,关掉「文件」页签传输不丢,「文件」页签与面板工具栏显示进行中计数徽标;弹框内含任务级聚合进度条(不再用文件级数字,多文件不回跳)、当前文件名、实时速度/ETA、逐文件明细、暂停/继续/取消/重试(失败与已取消都支持,断点续传)、单条删除/清除已完成/全部暂停、失败原因完整展示+复制、运行中动态限速(KB/s)、下载完成「打开目录」(`sftp_reveal_local`)。

## Model Experience

### Browser navigation surface

#### What the model sees

Nothing directly — this package registers only browser-side UI (sidebar navigation, `shell.overlay` dialogs, `settings.section` rows, the git branch pill). Model-visible context comes from the `starhub-tool-context` package, which injects the current tool/asset selection on every pre-step.

#### Token effect

None — pure presentation; no prompt or message contribution.

#### KV Cache effect

Not applicable — the package never participates in model requests.

## Known Limitations and Deferred Work

- 数据库/终端/SFTP 等重型工作台模块的测试覆盖率薄(terminal-cwd / xshell-quick-command / quick-commands / sftp-service 曾低至 3-44%,v0.92.2 补齐到 per-file 100%);交互路径复杂,后续仍需按模块补行为级用例。
- 浏览器预览(:3085)下无 Tauri IPC,资产/数据库等操作退化为错误提示或预览态,与桌面端行为有差异。
