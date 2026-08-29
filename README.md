<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.106.0-cyan)]()
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

**其他**:本地文件工作区(VSCode 式编辑)、Excel 工具、Kafka/NSQ 元数据、系统 Keyring 凭据托管、深浅双主题、自动更新。

## 当前版本

### v0.106.0 (2026-08-29)
- ✨ **沙箱直播改为独立 Tauri 窗口**:工具面板「沙箱桌面」实例卡片的「直播/接管」按钮不再使用侧边栏内嵌 iframe(尺寸太小,且 iframe permissions-policy 禁止全屏),改为新开独立窗口全页加载 noVNC——围观 = `view_only` 只读,接管 = 双向键鼠 + 接管互斥;同沙箱重复点击即「关旧窗开新窗」完成围观 ⇄ 接管切换;接管窗口被关闭(含主窗口退出联动)由 Rust `Destroyed` 钩子自动释放接管,不再依赖前端 React 清理
- ✨ **「请求人工介入」横幅新增「打开直播画面」按钮**:AI 调 `desktop_request_user_action`(扫码登录/输密码等)时,用户一键拉起该沙箱的接管窗口,操作完点「已完成」闭环
- 🔧 **新增 `desktop_ui_open_live_window` 命令,移除 `desktop_set_takeover`**:接管生命周期(进入/释放)并入开窗命令,`desktop_set_takeover` 已无调用方;直播窗口 label `sandbox-live-*` 不匹配任何 capability,noVNC 页无任何 app command 权限(与 ai-browser 窗口同姿势)

### v0.105.1 (2026-08-29)
- 🐛 **沙箱桌面长耗时操作突破 sidecar RPC 120 秒默认超时**:`desktop_build_template`(首次构建 5-15 分钟)给 30 分钟上限,`desktop_commit_sandbox` 给 10 分钟,`desktop_exec` 的 RPC 层超时跟随其 `timeoutSec` 参数(+30 秒余量),不再出现「Sidecar RPC timed out after 120 seconds」
- 🐛 **构建/固化超时降级为人工操作指引**:超时不再硬失败——`desktop_build_template` 会把 Dockerfile 落盘缓存目录并返回手工 `docker build` 命令(用户执行后重调即命中层缓存秒过);`desktop_commit_sandbox` 返回核对镜像/手工 `docker commit` 的指引

### v0.105.0 (2026-08-29)
- ✨ **沙箱桌面(Ubuntu 容器沙箱平台,E2B 式架构,M1-M4 一次交付,设计见 `docs/superpowers/specs/2026-08-28-desktop-automation-design.md`)**:AI 在一次性 Ubuntu 24.04 桌面容器(Xvfb + Xfce + x11vnc + noVNC)里操作任意 Linux 桌面应用,画面对用户全程直播
- ✨ **Rust 主进程新增 `desktop` 模块**:`desktop/mod.rs`(DesktopManager:平台连接缓存/授权/接管/人工介入应答;全部工具实现经 sidecar Docker 适配器编排)、`desktop/recipe.rs`(配方解析校验 + Dockerfile 生成,含 Ubuntu 24.04 firefox/chromium 为 snap 壳的坑说明)、`commands/desktop.rs`(UI 命令:接管开关/概览/平台设置/模板 CRUD/回放帧/生命周期/人工介入应答)
- ✨ **前端(client-nav)**:沙箱桌面工作面板(实例卡片/直播查看器/回放查看器/模板编辑器)、「请求人工介入」全局横幅(`starhub://desktop-user-action` 事件 + 倒计时)、设置「沙箱平台」tab;配套 25 个新 vitest 用例(面板/横幅/设置/服务/装配/工具树)
- 🐛 **修复 `docker_exec` 域工具参数键名错位**(搭车修复):Rust 进程内执行器发 `container`/`cmd`,sidecar 期望 `containerId`/`command`——该工具自方案1 迁移后实际一直报错,现对齐

### v0.104.0 (2026-08-29)
- ✨ sidecar Docker 适配器补齐沙箱编排能力(沙箱桌面平台 M0,设计见 `docs/superpowers/specs/2026-08-28-desktop-automation-design.md`)

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

## License

[MIT](./LICENSE) · Copyright © 2026 StarHub Authors
