# @deepseek-ai/dsh-starhub-client-nav

StarHub 浏览器导航插件(方案 P1,重构版):把 StarHub 工作台挂进 dsh web 壳的侧栏、右侧工具工作区列与设置面板。

## 行为

- **工具主面板**(`sidebar.panellist` + `main`,v0.123.2 起):侧栏「工具」行 order 1,紧随「插件」之下;点击经 `layout.selectPanel` 把主区域切成工具面板(终端 / 数据库 / Docker / Android 子类 + 资产列表;执行按钮切到本面板并带上执行记录视图,× 回会话;v0.130.0 起子类标题行再点一次可收起整个手风琴;v0.132.0 起沙箱桌面子类随域退役)。此前(v0.123.2 前)是侧栏底部 `sidebar.footer.action` 按钮 + `shell.overlay` 浮层 + toolsPanel 开关桥。选择经 store/hooks 舱位下发,并同步写 `starhub-tool-context` settings namespace 供 AI 工具上下文注入。
- **Overlay**(`shell.overlay` 两次):连接对话框、MFA 验证卡 / 堡垒机选机器卡(工具抽屉 v0.123.2 起改主面板,见上;v0.132.0 起沙箱「请求人工介入」横幅随域移除)。
- **资产操作页**(去 Tauri 化 M2 第 6 步起):数据库/终端/SFTP/Docker/Redis/ES 等资产实例不再开独立 webview 窗口,而是壳内**工作台主面板**(第二个 keyed `main` 槽 key=`starhub-workbench`)的一页——同源 iframe 承载 `/starhub-react/` 独立程序,标签条一页一签(同资产 id 重复打开 = 聚焦)。v0.132.0 起关掉最后一页让回**会话视图**(此前是工具面板),标签条左侧的「返回工具列表」按钮随之移除——回工具列表统一走侧栏常驻的「工具」行。
- **直播/接管主面板**(去 Tauri 化 M3 起):直播/接管线从独立直播窗口(`android-live://` custom protocol + 自包含页)改为壳内**直播主面板**(第三个 keyed `main` 槽 key=`starhub-live`)。一通道一页;帧与输入走宿主 upgrade 路由 `/starhub/live`(由 `starhub-bridge` 中继到 sidecar 的本地 WS),PNG 帧直画 canvas、H.264 帧经 WebCodecs 解码(annexb → avcC 描述集);接管开关经 `{"t":"takeover"}` 写帧枢纽,与 AI 写操作互斥;指针/滚轮经 `{"t":"input"}` 下行,坐标按 contain 内容矩形映射回设备物理像素。通道簿空时组件渲染 null 且面板让回会话视图(v0.132.0 起)。v0.130.0 起侧栏「直播」行移除:该面板只在 AI/Android 面板触发真实直播会话时自动出现,手动点入只会看到空画面。
- **会话头部**(`conversation.session.header.actions`):执行按钮(SSH 执行记录视图),v0.130.0 起 git 分支胶囊/Git 工作台整条退场。v0.121.8 起文件树按钮/`@` 文件源/壳内文件查看窗已移除(与 DSH 主壳 fs 工具、`ui-reference` 文件源、`ui-sidebar-files` 重复)。
- **设置分区**(`settings.section` ×2,v0.130.0 起):Android 设备、SSH。审计日志、告警规则、沙箱平台、AI 浏览器、关于五个区块 v0.130.0 一并移除。(更早:v0.123.1 起「插件市场」与「AI 助手」区块移除:前者由壳内首页「插件」面板接管,后者(长期记忆)整条栈退场。)
- **SFTP 传输中心**(v0.118.0):传输任务列表从 SftpPanel 内联区块升级为 overlay 级弹框(`TransferDialog` + 会话级投影 hook `useTransferTasks`)——任务监听挂在 SSH 工作区 overlay 而非面板,关掉「文件」页签传输不丢,「文件」页签与面板工具栏显示进行中计数徽标;弹框内含任务级聚合进度条(不再用文件级数字,多文件不回跳)、当前文件名、实时速度/ETA、逐文件明细、暂停/继续/取消/重试(失败与已取消都支持,断点续传)、单条删除/清除已完成/全部暂停、失败原因完整展示+复制、运行中动态限速(KB/s)、下载完成「打开目录」(`sftp_reveal_local`)。

## Model Experience

### Browser navigation surface

#### What the model sees

Nothing directly — this package registers only browser-side UI (sidebar navigation, `shell.overlay` dialogs, `settings.section` rows). Model-visible context comes from the `starhub-tool-context` package, which injects the current tool/asset selection on every pre-step.

#### Token effect

None — pure presentation; no prompt or message contribution.

#### KV Cache effect

Not applicable — the package never participates in model requests.

## Known Limitations and Deferred Work

- 数据库/终端/SFTP 等重型工作台模块的测试覆盖率薄(terminal-cwd / xshell-quick-command / quick-commands / sftp-service 曾低至 3-44%,v0.92.2 补齐到 per-file 100%);交互路径复杂,后续仍需按模块补行为级用例。
- 浏览器预览(:3085)下无 Tauri IPC,资产/数据库等操作退化为错误提示或预览态,与桌面端行为有差异。
