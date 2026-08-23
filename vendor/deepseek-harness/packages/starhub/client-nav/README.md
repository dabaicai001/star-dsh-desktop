# @deepseek-ai/dsh-starhub-client-nav

StarHub 浏览器导航插件(方案 P1,重构版):把 StarHub 工作台挂进 dsh web 壳的侧栏、右侧工具工作区列与设置面板。

## 行为

- **侧栏导航**(`sidebar.navigation`):侧栏「工具」大类/子类导航,含资产列表;选择经 store/hooks 舱位下发,并同步写 `starhub-tool-context` settings namespace 供 AI 工具上下文注入。
- **Overlay**(`shell.overlay` 两次):连接对话框(`openConnectionManager` / `closeConnectionManager`)与壳内文件查看窗(`FileViewerOverlay`,走 ui-conversation 的 `viewFile` 通道)。
- **工具工作区**(`workspace` + `details.workspace`):右侧工具页(数据库/终端/SFTP/Docker/Redis/ES/资产页等),资产实例经 `openNewPage` 在桌面端开独立 webview 窗口(浏览器预览退化为新标签页)。
- **会话头部**(`conversation.session.header.actions`):git 分支胶囊(切换/提交/推送/同步远程/AI 生成提交信息)。
- **设置分区**(`settings.section` 五次):AI 助手(记忆与上下文 + 记忆管理弹窗)、插件、审计、告警、关于。

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
- 「记忆写入需逐条确认」「存档 tool 消息」开关仍是 UI 层状态,未接入真行为(由 approval-bridge 与后续设置改造承接)。
