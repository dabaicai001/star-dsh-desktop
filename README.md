<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.128.0-cyan)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/star-dsh-desktop/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

</div>

StarHub 是一个桌面应用,把开发运维每天要用到的工具收进同一个窗口:数据库客户端、SSH 终端、SFTP 文件传输、Docker 面板、Android 真机、AI 助手。不用再在 Navicat、Xshell、Portainer 和 AI 对话框之间来回切换。

官网:[starthub.waouzzz.cc](https://starthub.waouzzz.cc/)

## 架构

三层进程模型:

- **上游 Electron 桌面壳** — DeepSeek Harness 自家的 Electron 壳,**零改动**原样使用;品牌、签名、自动更新都是它的。StarHub 不做自己的桌面项目。
- **dsh Host + starhub-bridge 插件** — Host(Node)进程里的 bridge 插件 spawn 两个 sidecar,把 sidecar 的方法面暴露成模型工具与工作台命令面。
- **两个 sidecar** — **Rust sidecar**(`sidecar-rust/`)承载 SSH/SFTP、Android 真机、沙箱桌面与直播帧枢纽;**Go Sidecar**(`sidecar/`)承载 MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch / Docker / Kafka 等适配器和连接池。均经 stdio 换行分帧 JSON-RPC 通信。
- **前端** — DeepSeek Harness(dsh)主壳,StarHub 的工作台和插件住在 `vendor/deepseek-harness` 里:`apps/starhub-window` 是资产工作台构建入口,`packages/starhub/*` 是 10 个内置插件(导航、工具桥、直播、审批、领域事件等),经 dsh 的槽位系统接入,不改上游内核。

## 功能

**数据库**:MySQL、PostgreSQL、SQLite、Redis、ClickHouse、SQL Server、Elasticsearch。表结构浏览、SQL 编辑器(CodeMirror 6,补全/格式化/历史)、虚拟滚动结果网格(可编辑、按主键批量保存)、DDL 生成、监控 Dashboard、Excel 导入导出、备份恢复、审计与告警。Oracle / MongoDB / 国产库 ODBC 在规划中。

**SSH 终端**:xterm.js 6,跳板机、端口转发、分屏、命令广播、危险命令拦截、ZMODEM(rz/sz)、Xshell 快捷命令导入、MFA/2FA、cwd 跟踪、断线重连。

**SFTP**:与终端共用同一条连接,三栏浏览、拖拽传输、断点续传、暂停/继续、全局传输任务条。

**Docker**:容器/镜像管理、交互式 Exec TTY、日志查看、Compose、支持经 SSH 通道连远程 Docker 主机。

**AI 助手**:OpenAI 兼容协议(可接 GPT / Claude / DeepSeek / Ollama 等),Function Calling 直接驱动 SSH / 数据库 / SFTP / Docker / 本地文件 / Android 真机等工具;`@` 绑定资产、`#` 绑定上下文;三级记忆卡 + 会话全文存档;所有 AI 发起的写操作都要经过确认卡审批并落审计日志。

**AI 沙箱桌面**(E2B 式):AI 在一次性 Ubuntu 24.04 桌面容器(Xvfb + Xfce + noVNC)里操作任意 Linux 桌面应用——截图回灌、窗口管理、键鼠操作、箱内命令,全程 23 个 `desktop_*` 工具;模板 → 实例 → 销毁,登录态可固化为新模板;扫码登录/输密码时可一键请人工出手。

**Android 实体机直连**(adb):AI 直接操作用户真实的 Android 手机(开发者模式 → USB 调试 / 无线调试)——截屏看画面、点按/滑动/滚动、按键、输入文本、按包名启动 App、设备文件传输、无线配对,共 19 个 `android_*` 工具;直播画面在壳内直播面板里看(scrcpy-server 的 H.264 实时,不可用自动降级截图轮询),支持围观/接管;任务级授权(60 分钟)、任意 shell 恒确认 hard 档、每次写操作自动截屏留档可回放——真实设备,每一步都有据可查。

**其他**:Kafka/NSQ 元数据、深浅双主题、自动更新。

## 当前版本

### v0.128.0 (2026-10-10)
- 🗑️ **去 Tauri 化 M1–M4 全部完成,StarHub 以上游 DeepSeek Harness Electron 壳的外部插件集形态发布**:Tauri 桌面壳(246 个 `tauri::command`、capabilities/ACL、窗口栈、打包/更新链)整体退役,桌面壳、品牌/签名/更新栈全部归上游;StarHub 交付「10 个 dsh 插件 + 两个 sidecar 子进程 + 静态资产」三件套,由 `scripts/provision-dsh.mjs` 装进 dsh desktop profile。方法面从 85 扩到 **226**(模型面工具 + `ui.*` 工作台命令面),交互全部面板化(资产工作台 / 直播接管制 / 工具面板都是壳内主面板,不再开独立窗口)。
- 🗑️ **AI 浏览器与 `vendor/obscura` 子模块整体删除**:16 个 `browser_*` 工具 + 4 个 `ui.browser_*` 设置 + 设置页 tab + `starhub-domain-browser` crate + obscura 引擎(707MB / 2616 文件)一并清掉——上游 dsh 原生提供 browser-use 及其可见面,重复造一份只会双轨维护。方法面 246 → 226。
- ✨ **直播/接管线面板化(M3)**:新 crate `starhub-live`(帧枢纽 + 本地 WS + 一次性令牌 + Android 帧源 scrcpy H.264 / 400ms 截图轮询),bridge 透明字节中继,壳内直播主面板支持围观/接管。
- ✨ **凭据迁移工具 + provisioning 落盘前 YAML 校验(M4)**:`scripts/migrate-tauri-data.mjs` 把老 Tauri SQLite + 系统 Keyring 搬进 sidecar 存储并做双跑期校验;provisioning 落盘前用 YAML 解析器验一遍,别把坏文件写到装机界面。
- 🐛 **修掉根 lock 与 package.json 长期不同步**:`npm ci` 在 CI 与发布链的第一行就红(M4 删 `@tauri-apps/*` 时只改了 package.json);顺带清掉根目录整套死依赖,`package-lock.json` 3731 行 → 29 行。
- ♻️ **CI / 发布链切换**:PR 门换成「前端纯逻辑 + Go 单测 + sidecar-rust 域单测 + provisioning 单测 + provisioning 与宿主冒烟」;发布链换成上游 electron-builder。Linux 不发版(决策 A:等上游出 target)。
- ✅ 验证:根 16 个测试套件 198 例、Go sidecar、sidecar-rust 域单测、provisioning 13 例、迁移 9 例、宿主冒烟五条断言全绿。

> 历史版本见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载

[GitHub Releases](https://github.com/dabaicai001/star-dsh-desktop/releases) 提供:

| 平台 | 产物 |
|---|---|
| Windows | NSIS `.exe`(未签名) |

> **Linux / macOS 暫不发版(2026-10-09 决策 A:等上游)**。桌面壳是上游 DeepSeek Harness 的 Electron 壳,它的 `SUPPORTED_TARGETS` 目前只有 `mac-arm64` / `mac-x64` / `win-x64`,没有 Linux target;原来的 deb/rpm 能力随 Tauri 壳一起退役。等上游出了 Linux target,加一个 CI job 即可,StarHub 不自己维护第二条打包路径。macOS 同理(缺签名/公证证书,证书就位后照抄 Windows job 改 target 名)。

## 开发

前置:Node 20 LTS、Rust 1.96+、Go 1.25+、pnpm 11+。Windows 需要 MSVC 构建环境。

```bash
git clone https://github.com/dabaicai001/star-dsh-desktop.git
cd starhub
npm install
pnpm --dir vendor/deepseek-harness install

npm run build:window && npm run sidecar:build && npm run sidecar-rust:build
npm run smoke:dsh-desktop   # provisioning + 宿主进程冒烟(五条断言)
```

常用命令:

| 命令 | 作用 |
|---|---|
| `npm run build:window` | 构建 React 工作台(输出 `dist-starhub-react/`) |
| `npm run sidecar:build` / `:release` | 构建 Go Sidecar |
| `npm run sidecar-rust:build` / `:test` | Rust sidecar 构建 / 测试(Windows 自动加载 MSVC) |
| `npm run test:utils` 等 | Node `node --test` 纯逻辑测试(见 `package.json`) |
| `npm run test:provision` | provisioning 合并逻辑单测 |
| `npm run smoke:dsh-desktop` | provisioning + 宿主进程冒烟 |
| `npm run package:dsh-runtime` | 打包 dsh 运行时(输出 `dsh-runtime/`) |
| `npm run provision:dsh` | 把 StarHub 组合装进一个 dsh profile |
| `npm run version` | 版本号同步(四处) |

上游 Electron 壳打包(发布链):

```bash
pnpm --dir vendor/deepseek-harness/apps/desktop run package:win:x64:unsigned
```

## 文档

- [docs/技术方案.md](./docs/技术方案.md) — 完整技术方案与功能矩阵
- [docs/设计系统.md](./docs/设计系统.md) — UI token 与组件规范
- [docs/踩坑记录.md](./docs/踩坑记录.md) + [docs/已知坑索引.md](./docs/已知坑索引.md) — 已知坑
- [CHANGELOG.md](./CHANGELOG.md) — 版本演进
- [AGENTS.md](./AGENTS.md) — AI Agent / 贡献者协作指引(目录结构、命令、提交与发版约定)

## 安全

- 密码、私钥、API Key 存 sidecar 的密钥存储(文件或内存;系统 Keyring 迁移见技术方案 §六)
- AI 执行写操作(SSH 写、SQL 写、文件删除、传输等)一律弹确认卡,超时按拒绝处理
- hostkey 自动接受不持久化,MFA 验证码不回写
- 直播/接管的帧通道只绑 127.0.0.1,一次性令牌握手后即弃

## 关于(About)

**StarHub** — All-in-One DevOps Desktop Command Center。把开发运维每天要用到的工具收进同一个窗口:数据库客户端 · SSH 终端 · SFTP · Docker · Android 真机 · AI 助手,以及 AI 驱动的沙箱桌面。

| 项 | 值 |
|---|---|
| 当前版本 | v0.127.0 |
| 官网 | [starthub.waouzzz.cc](https://starthub.waouzzz.cc/) |
| 仓库 | [github.com/dabaicai001/star-dsh-desktop](https://github.com/dabaicai001/star-dsh-desktop) |
| 问题反馈 | [GitHub Issues](https://github.com/dabaicai001/star-dsh-desktop/issues) |
| 协议 | MIT · Copyright © 2026 StarHub Authors |

**致谢与依赖**:

- AI 主壳基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(插件化 agent harness,`vendor/deepseek-harness` 整树 vendored);
- Android 直播的 H.264 通道使用 [scrcpy](https://github.com/Genymobile/scrcpy) server(Apache-2.0);
- 终端 [xterm.js](https://xtermjs.org/),数据库/中间件适配由内置 Go sidecar 承载。

## License

[MIT](./LICENSE) · Copyright © 2026 StarHub Authors
