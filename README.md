<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.116.6-cyan)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/star-dsh-desktop/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

</div>

StarHub 是一个跨平台桌面应用,把开发运维每天要用到的工具收进同一个窗口:数据库客户端、SSH 终端、SFTP 文件传输、Docker 面板、AI 助手。不用再在 Navicat、Xshell、Portainer 和 AI 对话框之间来回切换。

官网:[starthub.waouzzz.cc](https://starthub.waouzzz.cc/)

## 架构

三层进程模型:

- **Rust 主进程(Tauri 2)** — 桌面壳。负责多窗口管理、SSH/SFTP 会话(russh)、系统密钥环、AI 浏览器、Updater。
- **Go Sidecar** — 数据库与中间件代理。独立进程,经 stdio JSON-RPC 与主进程通信,承载 MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch / Docker / Excel 等适配器和连接池。
- **前端(React)** — 基于 DeepSeek Harness(dsh)主壳,StarHub 的工作台和插件住在 `vendor/deepseek-harness` 里:`apps/starhub-window` 是资产工作台构建入口,`packages/starhub/*` 是 11 个内置插件(导航、工具桥、记忆、审批、领域事件等),经 dsh 的槽位系统接入,不改上游内核。

## 功能

**数据库**:MySQL、PostgreSQL、SQLite、Redis、ClickHouse、SQL Server、Elasticsearch。表结构浏览、SQL 编辑器(CodeMirror 6,补全/格式化/历史)、虚拟滚动结果网格(可编辑、按主键批量保存)、DDL 生成、监控 Dashboard、Excel 导入导出、备份恢复、审计与告警。Oracle / MongoDB / 国产库 ODBC 在规划中。

**SSH 终端**:xterm.js 6,跳板机、端口转发、分屏、命令广播、危险命令拦截、ZMODEM(rz/sz)、Xshell 快捷命令导入、MFA/2FA、cwd 跟踪、断线重连。

**SFTP**:与终端共用同一条连接,三栏浏览、拖拽传输、断点续传、暂停/继续、全局传输任务条。

**Docker**:容器/镜像管理、交互式 Exec TTY、日志查看、Compose、支持经 SSH 通道连远程 Docker 主机。

**AI 助手**:OpenAI 兼容协议(可接 GPT / Claude / DeepSeek / Ollama 等),Function Calling 直接驱动 SSH / 数据库 / SFTP / Docker / 本地文件 / 浏览器等工具;`@` 绑定资产、`#` 绑定上下文;无痕 AI 浏览器(14 个 `browser_*` 工具,Windows 走 CDP 可信输入);三级记忆卡 + 会话全文存档;MCP Server 挂载;所有 AI 发起的写操作都要经过确认卡审批并落审计日志。

**AI 助手**:OpenAI 兼容协议(可接 GPT / Claude / DeepSeek / Ollama 等),Function Calling 直接驱动 SSH / 数据库 / SFTP / Docker / 本地文件 / 浏览器等工具;`@` 绑定资产、`#` 绑定上下文;无痕 AI 浏览器(14 个 `browser_*` 工具,Windows 走 CDP 可信输入);三级记忆卡 + 会话全文存档;MCP Server 挂载;所有 AI 发起的写操作都要经过确认卡审批并落审计日志。

**AI 沙箱桌面**(E2B 式):AI 在一次性 Ubuntu 24.04 桌面容器(Xvfb + Xfce + noVNC)里操作任意 Linux 桌面应用——截图回灌、窗口管理、键鼠操作、箱内命令,全程 23 个 `desktop_*` 工具;模板 → 实例 → 销毁,登录态可固化为新模板;画面在独立直播窗口对用户全程可见,用户可随时「接管」亲手操作(接管期间 AI 写操作自动暂停),扫码登录/输密码时可一键请人工出手。

**Android 实体机直连**(adb):AI 直接操作用户真实的 Android 手机(开发者模式 → USB 调试 / 无线调试)——截屏看画面、点按/滑动/滚动、按键、输入文本、按包名启动 App、设备文件传输、无线配对,共 19 个 `android_*` 工具;直播窗口走 bundled scrcpy-server 的 H.264 实时画面(不可用自动降级截图轮询),同样支持围观/接管;任务级授权(60 分钟)、任意 shell 恒确认 hard 档、每次写操作自动截屏留档可回放——真实设备,每一步都有据可查。

**其他**:本地文件工作区(VSCode 式编辑)、Excel 工具、Kafka/NSQ 元数据、系统 Keyring 凭据托管、深浅双主题、自动更新。

## 当前版本

### v0.116.6 (2026-09-04)
- 🐛 **Obscura 直播查看器在 Windows 上永远停在「连接 Obscura…」**:查看器页面 JS 硬编码 `obscura-live://localhost/...` 绝对 URL 发 fetch;Windows WebView2 不认识自定义 scheme(wry 把自定义协议映射成 `http://obscura-live.localhost`,过滤器只匹配该形式),文档 URL 由 Tauri 自动改写所以页面能渲染,但页面内 fetch 全部 TypeError → 轮询永远进 catch,直播与查看器输入(地址栏/点击/按键 POST)整体失效。改为全部相对 URL(`meta`/`frame.jpg`/`input` 随文档地址解析),各平台行为一致;meta 404(页面会话未建立)时状态栏保持「连接 Obscura…」而不是「 · undefined」。
- 🐛 **Obscura 引擎崩溃/断连后所有 `browser_*` 永久失败,且僵尸 obscura 进程累积**:`ensure_engine` 快路径直接复用缓存 client 不探测,引擎死后所有动作报「发送通道已关闭」直到重启 App;启动失败分支不回收已 spawn 进程,且 `spawn_engine` 未设 `kill_on_drop`,每次重试/重启泄漏一个 obscura 进程。现快路径先 probe、失效则 `kill_engine`(杀进程 + 清 client/port/页面会话)后重启;启动失败同样回收;`spawn_engine` 补 `kill_on_drop(true)`。
- 🐛 **Obscura screencast 流中途死掉后直播永久定格**:`ensure_screencast` 以 `seq>0` 判活,流死时 seq 冻结在 >0,补启逻辑直接返回。改为按「重注册后 seq 增长」判活(startScreencast 成功必强制推一帧);同时帧 base64 解码失败不再用空数据覆盖上一帧(空帧会让 frame.jpg 变 204 黑屏)。
- 🐛 **Obscura 双击不触发页面 dblclick 处理器**:查看器双击原来发两次 clickCount=1 的完整单击;真双击第二次 press/release 需 clickCount=2,已修正。AI `browser_click` 可信输入路径补 mouseMoved(依赖 hover 态的元素此前点不中)。
- 🐛 **Obscura 引擎冷启动时并发调用方误报「等待 Obscura 引擎启动超时」**:等待方上限 7.5s 小于启动方最坏耗时(12s+),拉长到 15s。
- 🐛 **Obscura 直播帧 metadata 的视口尺寸未写回**:`deviceWidth/deviceHeight` 现在随帧更新 PageState.viewport,首帧到达前查看器坐标映射不再用假视口(1280×800)。
- 🐛 **Obscura 模块 Mutex 中毒级联**:live 协议处理器跑在 webview 同步线程,`lock().expect(...)` 会因任何持锁 panic 级联让查看器窗口线程崩溃;全模块改 `plock` 辅助(中毒时取回内层数据继续用)。
- 🐛 小项:obscura 二进制用户级 target 路径在非 Windows 平台回退 `HOME`;查看器窗口聚焦失败不再让 `browser_open` 整体报错;CDP `call_session` 应答通道关闭时清理 pending 表。

> 历史版本见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载

[GitHub Releases](https://github.com/dabaicai001/star-dsh-desktop/releases) 提供:

| 平台 | 产物 |
|---|---|
| Windows | `.msi` / NSIS `.exe` |
| macOS | `.dmg` / `.app` |
| Linux | `.deb` / `.rpm` / `.AppImage`(x86_64 与 ARM64) |

Linux 默认版在 Ubuntu 24.04 构建(glibc 2.39+,截图依赖 PipeWire ≥ 1.0);另附 `-ubuntu2204` 后缀的兼容版(glibc 2.35,无区域截图),适用于 Ubuntu 22.04 / Debian 12 / Fedora 38+ 等旧系统。AppImage 自带 WebKitGTK/GTK/sidecar,无 FUSE 环境加 `--appimage-extract-and-run` 运行。

## 开发

前置:Node 20 LTS、Rust 1.78+、Go 1.25+、pnpm 9+。Windows 需要 MSVC 构建环境。

```bash
git clone https://github.com/dabaicai001/star-dsh-desktop.git
cd starhub
npm install
pnpm --dir vendor/deepseek-harness install

npm run tauri:dev        # 完整开发:构建 sidecar + React 工作台,启动桌面壳
```

常用命令:

| 命令 | 作用 |
|---|---|
| `npm run build:window` | 构建 React 工作台(输出 `dist-starhub-react/`) |
| `npm run sidecar:build` / `:release` | 构建 Go Sidecar |
| `npm run cargo:check` / `cargo:test` | Rust 检查 / 测试(自动加载 MSVC 环境) |
| `npm run test:utils` 等 | Node `node --test` 纯逻辑测试(见 `package.json`) |
| `npm run package:dsh-runtime` | 打包 DeepSeek Harness runtime |
| `npm run tauri:build` | 当前平台打包(NSIS/MSI、dmg、DEB/RPM/AppImage) |

## 文档

- [docs/技术方案.md](./docs/技术方案.md) — 完整技术方案与功能矩阵
- [docs/设计系统.md](./docs/设计系统.md) — UI token 与组件规范
- [docs/踩坑记录.md](./docs/踩坑记录.md) + [docs/已知坑索引.md](./docs/已知坑索引.md) — 已知坑
- [CHANGELOG.md](./CHANGELOG.md) — 版本演进
- [AGENTS.md](./AGENTS.md) — AI Agent / 贡献者协作指引(目录结构、命令、提交与发版约定)

## 安全

- 密码、私钥、API Key 存系统 Keyring(macOS Keychain / Windows Credential Manager / Linux Secret Service)
- AI 执行写操作(SSH 写、SQL 写、文件删除、传输等)一律弹确认卡,超时按拒绝处理
- hostkey 自动接受不持久化,MFA 验证码不回写

## 关于(About)

**StarHub** — All-in-One DevOps Desktop Command Center。把开发运维每天要用到的工具收进同一个窗口:数据库客户端 · SSH 终端 · SFTP · Docker · AI 助手,以及 AI 驱动的沙箱桌面与 Android 实体机操作。

| 项 | 值 |
|---|---|
| 当前版本 | v0.116.6 |
| 官网 | [starthub.waouzzz.cc](https://starthub.waouzzz.cc/) |
| 仓库 | [github.com/dabaicai001/star-dsh-desktop](https://github.com/dabaicai001/star-dsh-desktop) |
| 问题反馈 | [GitHub Issues](https://github.com/dabaicai001/star-dsh-desktop/issues) |
| 协议 | MIT · Copyright © 2026 StarHub Authors |

**致谢与依赖**:

- AI 主壳基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(插件化 agent harness,`vendor/deepseek-harness` submodule);
- Android 直播的 H.264 通道使用 [scrcpy](https://github.com/Genymobile/scrcpy) server(Apache-2.0,来源与 SHA256 校验见 `src-tauri/resources/scrcpy/PROVENANCE.md`);
- 桌面壳 [Tauri](https://tauri.app/),终端 [xterm.js](https://xtermjs.org/),数据库/中间件适配由内置 Go sidecar 承载。

## License

[MIT](./LICENSE) · Copyright © 2026 StarHub Authors
