<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.123.1-cyan)]()
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

**其他**:Excel 工具、Kafka/NSQ 元数据、系统 Keyring 凭据托管、深浅双主题、自动更新。

## 当前版本

### v0.123.1 (2026-09-23)
- 🧹 **移除设置「插件市场」tab 与支线 B 插件安装/启停/卸载/市场命令面(与 dsh 主壳原生「插件」面板重复)**:dsh 首页侧边栏「插件」面板已提供已装插件列表 + 启停、包名 / GitHub 仓库 / 本地目录安装、安装源(默认 / 中国大陆镜像 / 私有源)选择,StarHub 自研的平行插件管理整体退场。前端删除 `client-nav` 的 `settings/plugins.tsx`(PluginsTab / ConfirmActionDialog)与「插件市场」settings.section 注册(余下 tab 顺次前移)、`settings/services.ts` 的 8 个插件服务函数与 4 个类型、settings.module.css 的 5 个市场专用类;Rust 删除 `commands/dsh_plugins.rs` 6 个命令(`dsh_plugin_list` / `dsh_plugin_install_local` / `dsh_plugin_install_url` / `dsh_plugin_set_enabled` / `dsh_plugin_uninstall` / `dsh_plugin_market_fetch`)+ `dsh_web_restart` + `DshWebManager::restart` + ACL 白名单登记;`harness/plugins.rs` 精剪掉安装 / 市场 / 启停 / 卸载实现(约 500 行,含 `zip` 直接依赖),**保留加载面**:registry / cordis.yml / peer junction / 包装配置生成 / 内置插件注册 / 坏插件自救禁用照旧——已装进 `app_data_dir/plugins/` 的用户插件与 `dsh.client` UI 插件注入(web.rs `sync_user_client_plugins`)行为不变。设计背景与退场说明见 `docs/插件体系打通方案-dsh插件统一.md`(已标注被本版本取代)。
- 🧹 **移除设置「AI 助手」tab 与 StarHub 长期记忆整条栈(用户反馈不好用)**:删除前端 AiTab(记忆模型下拉 + 长期记忆总开关 + 记忆管理弹窗)、aiSettings / memory-context 两个桥模块、记忆服务与 logAudit;vendor 侧删除 `memory-context` / `memory-sink` 两个宿主插件包与 `memory` 模型工具,并同步 examples 组合、tsconfig、打包脚本清单、Rust `LOCAL_PACKAGES`;Rust 删除 7 个 `ai_memory_*` 命令、`starhub/memory.cards` / `starhub/memory.write` 两个 sdk 桥方法、memory 工具分支与记忆写入安全扫描(会话历史 `ai_conv_*` / `ai_msg_*` 命令保留)。**`ai_memories` 表数据保留在本地库中不再读写**(不删用户数据);`docs/AI内核替换方案-deepseek-harness.md` §5.3 标注为已移除。

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
| 当前版本 | v0.116.8 |
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
