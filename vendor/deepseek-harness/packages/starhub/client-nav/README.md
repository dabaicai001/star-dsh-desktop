# @deepseek-ai/dsh-starhub-client-nav

StarHub 浏览器导航插件(方案 P1,重构版):把 StarHub 工作台挂进 dsh web 壳的侧栏、右侧工具工作区列与设置面板。

## 行为

- **工具入口**(`sidebar.footer.action`):侧栏底部「工具」按钮,打开 shell.overlay 承载的工具抽屉(终端 / 数据库 / Docker 子类 + 资产列表);选择经 store/hooks 舱位下发,并同步写 `starhub-tool-context` settings namespace 供 AI 工具上下文注入。
- **Overlay**(`shell.overlay` 五次):连接对话框、壳内文件查看窗(`FileViewerOverlay`)、MFA 验证卡、堡垒机选机器卡、工具抽屉(`StarHubToolWorkspace`)。
- **资产操作页**:数据库/终端/SFTP/Docker/Redis/ES 等资产实例经 `openNewPage` 在桌面端开独立 webview 窗口(浏览器预览退化为新标签页)。
- **会话头部**(`conversation.session.header.actions`):git 分支胶囊(切换/提交/推送/同步远程/AI 生成提交信息)与文件树按钮(打开工具抽屉并切到项目文件目录树)。
- **设置分区**(`settings.section` 五次):AI 助手(记忆模型配置 + 长期记忆总开关 + 记忆管理弹窗)、插件、审计、告警、关于。

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
- 浏览器预览(:3085)下无 Tauri IPC,资产/数据库等操作退化为错误提示或预览态,与桌面端行为有差异(记忆模型下拉因此禁用)。
- 记忆模型下拉的数据源 `api.llm.models`(会话无关模型目录)只列出 provider 已暴露的模型;未列出的 model id 仍可在目录外存在,但下拉不会提供。
