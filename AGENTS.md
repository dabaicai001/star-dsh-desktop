# AGENTS.md — StarHub 协作指引

写给 AI Agent 和人类贡献者:读完这份文件就能上手改这个仓库。架构级变更请同步更新 `docs/` 与本文件。

## 项目是什么

StarHub 是跨平台(Windows / macOS / Linux)DevOps 桌面应用,单一窗口整合:数据库客户端(MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch)、SSH 终端、SFTP、Docker 面板、AI 助手。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/dabaicai001/star-dsh-desktop |
| 主分支 | `main` |
| 协议 | MIT |
| 当前版本 | v0.112.0(**侧栏品牌 Logo 换成 StarHub**:侧栏顶部的品牌区改为 StarHub 资产——`brandMark`(原 FishLogo)换成 `apps/web/public/starhub-logo.png`(03 字标,边框白边已去除),标题+commit hash 徽标换成 `starhub-badge.png`(04 横版字标,背景已去透明);两图在 DSH web 的 `public/` 静态目录,重建 dsh web 后生效) |

## 架构一句话

三层进程:**Rust 主进程(Tauri 2,`src-tauri/`)** 管窗口、SSH/SFTP、密钥环、AI 浏览器 → **Go Sidecar(`sidecar/`)** 经 stdio JSON-RPC 管全部数据库/中间件适配 → **前端** 是 DeepSeek Harness 主壳 + StarHub React 工作台(`vendor/deepseek-harness/`,git submodule)。

## 目录结构

```
starhub/
├── src-tauri/               # Rust 主进程(Tauri 2)
│   ├── src/
│   │   ├── main.rs           # 入口(主窗口关闭联动销毁其余窗口)
│   │   ├── commands/         # 全部 Tauri Command:ssh / sftp / db / docker / ai_memory /
│   │   │                     # android(Android 设备设置)/ asset / audit / alert / broker /
│   │   │                     # browser / desktop(沙箱桌面 UI)/ dsh_plugins / file / harness /
│   │   │                     # local / mcp / screenshot / secret / sidecar
│   │   ├── ssh/              # SSH 会话(russh):auth / session / known_hosts / sftp_transport
│   │   ├── sftp/             # SFTP 会话与传输(russh-sftp)
│   │   ├── android/          # Android 实体机(adb):mod(授权/直播双模/scrcpy 通道/20 工具)
│   │   ├── browser/          # AI 浏览器(无痕独立窗口):mod / script / cdp(Win)/ snapshot_*(mac/Linux)
│   │   ├── desktop/          # 沙箱桌面(Ubuntu 容器沙箱平台):mod(编排/授权/接管)/ recipe(配方)
│   │   ├── harness/          # dsh 桥与插件宿主(harness/plugins)
│   │   ├── db/               # 本地 SQLite 持久化(sqlx)
│   │   ├── keyring/          # 系统 Keyring 封装
│   │   └── sidecar/          # Go Sidecar 启动器
│   ├── capabilities/         # Tauri 权限(按窗口收窄)
│   └── tauri.conf.json
│
├── sidecar/                 # Go 1.25 Sidecar — 数据库/中间件代理
│   ├── main.go               # stdio JSON-RPC server 入口
│   ├── adapters/             # mysql / postgres / sqlite / redis / clickhouse / mssql /
│   │                         # elasticsearch / broker(Kafka/NSQ)/ docker(+compose,+ssh)/ excel / csv / backup
│   ├── pool/  rpc/           # 连接池 / JSON-RPC 协议
│   └── bin/                  # 构建输出 starhub-sidecar[.exe]
│
├── vendor/deepseek-harness/ # DSH 主壳与 StarHub React 工作台(唯一 git submodule)
│   ├── apps/
│   │   ├── starhub-window/   # StarHub 资产工作台构建入口(产物 dist-starhub-react/)
│   │   ├── web/  cli/        # DSH 自身应用
│   └── packages/starhub/     # 11 个内置插件:approval-bridge / client-nav / commit-message /
│                             # domain-events / host-static / live-context / memory-context /
│                             # memory-sink / session-registry / tool-context / tools
│
├── legacy-core/             # 脱离前端的纯 TS 工具与服务(node --test 覆盖)
├── scripts/                 # 构建脚本:build-sidecar / build-window / dev-dsh-shell /
│                            # bump-version / cargo-env.bat(MSVC)/ refresh-icons / verify-linux-bundles
├── tests/                   # node --test 单测(utils、AI 上下文/滚动/记忆、SSH prompt/cwd/后台任务)
├── docs/                    # 技术方案 / 设计系统 / 踩坑记录 / 已知坑索引 / 架构图.html
└── .github/                 # CI(lint / test / build / release)
```

## 技术栈速查

- **前端**:React + TypeScript 5(strict)+ Vite 5;xterm.js 6(终端)、CodeMirror 6(SQL)、zmodem.js
- **Rust**:tauri 2、tokio、russh 0.62 + russh-sftp 2、sqlx(SQLite + FTS5)、reqwest、keyring-core、serde、tracing、thiserror/anyhow;AI 浏览器平台 crate(webview2-com / objc2-web-kit / webkit2gtk 2.0.2)版本必须与 wry 0.55 锁定一致
- **Go**:go-sql-driver/mysql、jackc/pgx、modernc.org/sqlite(纯 Go)、go-redis、clickhouse-go、go-mssqldb、go-elasticsearch、docker/docker、excelize、zerolog

**铁律 — 新功能优先以 dsh 插件形式注入,禁止改 vendor 内核源码。** 新能力落在 `vendor/deepseek-harness/packages/starhub/*`,经槽位系统(`ctx.slots.register` / `slots.inject`)或 Cordis 服务(`ctx.provide` / `ctx.get`)接入。仅两种例外可动 vendor 源码:(1) 修 DSH 自身的 bug(注释标注「上游补丁」);(2) 扩展点上无法表达且改动最小。不新增 Vue 系依赖。

## 关键命令

```bash
npm install && pnpm --dir vendor/deepseek-harness install   # 安装依赖

npm run tauri:dev            # 完整开发:构建 sidecar + React 工作台,启动桌面壳
npm run build:window         # 只构建 React 工作台(→ dist-starhub-react/)
npm run sidecar:build        # Go Sidecar(加 :release 为 release 构建)

npm run cargo:check          # Rust 检查(scripts/cargo-env.bat 先加载 MSVC 环境;
npm run cargo:test           #   vcvars64.bat 路径取 STARHUB_VCVARS,缺省回退 D:\c++1)

npm run test:utils           # node --test 纯逻辑套件;其余套件见 package.json scripts
npm run package:dsh-runtime  # 打包 DSH runtime
npm run tauri:build          # 当前平台打包(beforeBuildCommand 已编排全链路)
```

## 开发约定

**提交信息**:Conventional Commits + emoji 前缀:`✨ feat` / `🐛 fix` / `📝 docs` / `🔧 chore` / `⬆️ upgrade` / `⚡ perf` / `✅ test` / `🎨 style`,格式 `<emoji> <type>(scope): <subject>`。一次 commit 只装一个主题。

**分支**:`main` 主干;`feat/<name>` / `fix/<name>` / `docs/<name>` / `refactor/<name>` / `release/v<x.y.z>`。

**代码风格**:TS `strict`、禁 `any`(用 `unknown`);Rust 过 `cargo fmt` + `clippy`;Go 过 `gofmt`;公共 API 写文档注释;面向用户文案走 i18n,禁硬编码;全仓库 UTF-8 无 BOM。

## 版本与提交纪律(强制)

1. **改完立即 commit + push**:工作区不允许长期挂未提交改动;不把自己的改动和用户已有的未提交改动塞进同一个 commit(diff 不干净时只 commit 自己审过的部分,其余明确告知用户)。
2. **代码或构建链改动必须升版**,纯文档改动(docs/、README 正文、注释)免升版。判断标准:会不会改变打包产物或用户可感知行为?不会 → 免升版;拿不准 → 升。
3. **升版同步七处**:`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`CHANGELOG.md`、`AGENTS.md`(本节「当前版本」)、`README.md`(版本 badge)。七处必须一致。
4. **版本号规则**:主版本 = 架构不兼容变更;次版本 = 新功能;修订版 = bug 修复 / 小改进 / 构建脚本调整。
5. **CHANGELOG**:改动在 `[未发布]` 下补条目,发布时移到 `[x.y.z] - YYYY-MM-DD` 下。
6. **tag 与 Release**:`release.yml` 由 `v*.*.*` tag 触发;一次 push 最多触发 3 个 tag,超出静默丢弃;多版本只在最后推最新 tag,单个推(`git tag vX.Y.Z && git push origin vX.Y.Z`);纯文档修订版不打 tag。

## 测试

| 层 | 工具 | 命令 |
|---|---|---|
| 前端纯逻辑 | node --test | `npm run test:utils` / `test:ai-context` / `test:ai-scroll` / `test:ai-steering` / `test:ssh-prompt` / `test:terminal-cwd` / `test:ssh-bg` 等(见 `package.json`) |
| 前端组件 | Vitest | vendor/deepseek-harness 内 `pnpm` 脚本 |
| Rust | cargo test | `npm run cargo:test` |
| Go | go test | `cd sidecar && go test ./...`(adapters 已有 `*_test.go`) |

## 文档维护(强制)

架构级变更必须同步:`docs/技术方案.md`、`docs/架构图.html`、`CHANGELOG.md`、本文件。已知坑沉淀到 `docs/踩坑记录.md`,主题索引在 `docs/已知坑索引.md`。

## 协作 Tips

- **改文档前先读**:`docs/技术方案.md` 是事实来源,代码与文档冲突时先更新文档。
- **跨域改动要协调**:加数据库支持 = `sidecar/adapters/` + 技术方案文档 + 技术栈表;加 SSH 能力同理。
- **安全 / 性能 / 架构决策**先开 Issue 讨论,不独自拍板。
- **不确定时**优先遵循 `docs/技术方案.md`;文档没写的沿用主流方案 + 开 Issue 提案,不凭直觉造新架构。

---

*最后更新: 2026-09-01 (v0.112.0)*
