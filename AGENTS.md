# AGENTS.md — StarHub 协作指引

写给 AI Agent 和人类贡献者:读完这份文件就能上手改这个仓库。架构级变更请同步更新 `docs/` 与本文件。

## 项目是什么

StarHub 是 DevOps 桌面应用,单一窗口整合:数据库客户端(MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch)、SSH 终端、SFTP、Docker 面板、Android 真机、AI 助手。

**StarHub 不是桌面项目,是上游 DeepSeek Harness Electron 壳的外部插件集**:桌面壳、品牌/签名/更新栈都是上游的,StarHub 交付「插件 + 两个 sidecar 子进程 + 静态资产」三件套。去 Tauri 化(M1–M4)已把原来的 Tauri 壳整体退役,详见 `docs/去Tauri化-M1..M4-*.md` 四份清单。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/dabaicai001/star-dsh-desktop |
| 主分支 | `main` |
| 协议 | MIT |
| 当前版本 | v0.129.3(🔧 **一个 tag 只跑一条发布链**:上一版把插件 tarball 放进独立的 `plugin-bundle.yml` 并让它也监听 `v*.*.*`,于是推一个 tag 会同时起「Release desktop bundles」与「Publish StarHub plugin bundle」两条 job,各自重建一遍 release sidecar(实测各 ~15 分钟),看起来像「两个版本在打包」。现在插件 tarball 的组装/校验/冒烟搬进 `release.yml` 的 windows job——它本来就构建了 libs、工作台 dist 与两个 sidecar,顺手打包即可;tarball 作为独立 artifact 上传,并与 installer 一起挂到同一个 Release。`plugin-bundle.yml` 退化为 **workflow_dispatch 手动兜底**(装机链因签名/更新源 secrets 走不到 publish 时,单独产出插件 URL)。) |

## 架构一句话

三层进程:**上游 Electron 壳(零改动)** 跑 dsh Host(Node)进程 → Host 里的 **starhub-bridge 插件** spawn 两个 sidecar:**Rust sidecar(`sidecar-rust/`,ssh/sftp/android/desktop/browser 契约层 + 直播帧枢纽)** 与 **Go Sidecar(`sidecar/`,数据库/中间件适配)**,均经 stdio 换行分帧 JSON-RPC 通话 → **前端**是 DSH 主壳 + StarHub React 工作台(`vendor/deepseek-harness/`,上游 `deepseek-ai/deepseek-harness` 的 vendored 副本,随仓库直接版本化)。

## 目录结构

```
starhub/
├── sidecar-rust/           # Rust sidecar(M1 起域逻辑的新家)
│   └── crates/
│       ├── starhub-sidecar      # 二进制 + stdio JSON-RPC 方法面(模型面 + ui.* 面)
│       ├── starhub-live         # 直播/接管帧枢纽(M3):本地 WS + Android 帧源
│       ├── starhub-contract     # 领域事件 schema + 模型可读能力文本
│       └── starhub-domain-{ssh,db,desktop,android,browser}
│
├── sidecar/                 # Go 1.25 Sidecar — 数据库/中间件代理
│   ├── main.go               # stdio JSON-RPC server 入口
│   ├── adapters/             # mysql / postgres / sqlite / redis / clickhouse / mssql /
│   │                         # elasticsearch / broker(Kafka/NSQ)/ docker(+compose,+ssh)/ csv / backup
│   ├── pool/  rpc/           # 连接池 / JSON-RPC 协议
│   └── bin/                  # 构建输出 starhub-sidecar[.exe]
│
├── vendor/deepseek-harness/ # DSH 主壳与 StarHub React 工作台(上游 deepseek-ai/deepseek-harness
│                            # 的 vendored 副本,随仓库直接版本化;上游 commit 记录于
│                            # vendor/deepseek-harness/UPSTREAM_COMMIT.txt)
│   ├── apps/
│   │   ├── starhub-window/   # StarHub 资产工作台构建入口(产物 dist-starhub-react/)
│   │   ├── web/  cli/        # DSH 自身应用
│   │   └── desktop/ desktop-host/  # 上游 DSH 自家 Electron 桌面壳(发布链用它打包)
│   ├── examples/
│   │   ├── starhub-web/      # web 组合的 profile 模板(旧 Tauri 壳用)
│   │   └── starhub-desktop/  # desktop 组合的 profile 模板(provisioning 用)
│   └── packages/starhub/     # 10 个内置插件:approval-bridge / bridge / client-nav /
│                             # commit-message / domain-events / host-static / live-context /
│                             # session-registry / tool-context / tools
│
├── scripts/
│   ├── provision-dsh.mjs     # M4:把 StarHub 组合装进 dsh profile
│   ├── smoke-dsh-desktop.mjs # M4:provisioning + 宿主进程冒烟
│   ├── build-plugin-bundle.mjs  # 纯插件形态:拼出自包含 bundle(→ dist-plugin/,--pack 出 .tgz)
│   ├── smoke-plugin-bundle.mjs  # 纯插件形态:pnpm 安装 + 宿主冒烟(五条断言)
│   ├── build-sidecar.*       # Go sidecar 构建
│   ├── build-window.mjs      # React 工作台构建
│   ├── bump-version.mjs      # 版本号同步
│   ├── cargo-sidecar.bat     # Windows 上跑 sidecar-rust 的 cargo(MSVC + 工具链)
│   └── cargo-sidecar.mjs     # 上面的跨平台包装:Windows 转 .bat,其它平台直调 cargo
│
├── dsh-runtime/             # 打包好的 dsh 运行时(gitignore;package:dsh-runtime 产出)
├── dist-starhub-react/      # React 工作台产物(gitignore)
├── dist-plugin/             # 纯插件 bundle 组装产物(gitignore;plugin:bundle 产出,--pack 另出 .tgz)
├── docs/                    # 技术方案 / 设计系统 / 踩坑记录 / 已知坑索引 / 去Tauri化 M1-M4 清单
├── test-sftp/               # SSH/SFTP stub + 桥兼容验收脚本
└── tests/                   # node --test 单测(utils、AI 上下文/滚动/记忆、SSH prompt/cwd/后台任务、provisioning)
```

## 技术栈速查

- **前端**:React + TypeScript 5(strict)+ Vite 5;xterm.js 6(终端)、CodeMirror 6(SQL)、zmodem.js
- **Rust**:tokio、russh 0.62 + russh-sftp 2、serde、thiserror/anyhow;sidecar-rust 是独立 workspace(零 tauri 依赖,`cargo tree` 不应出现 tauri crate)
- **Go**:go-sql-driver/mysql、jackc/pgx、modernc.org/sqlite(纯 Go)、go-redis、clickhouse-go、go-mssqldb、go-elasticsearch、docker/docker、zerolog
- **Node**:上游 dsh Host(desktop profile)+ starhub-bridge 插件。**仓库根 `package.json` 零 runtime 依赖**(唯一 devDependency 是 `typescript`,供 `tests/` 现编译 vendored TS)——React 工作台的全部依赖在 `vendor/deepseek-harness` 的 pnpm workspace 里,`npm ci` 在根目录只装一个包;根 `scripts/` 与 `tests/` 只 import node 内置模块。

**铁律 — 新功能优先以 dsh 插件形式注入,禁止改 vendor 内核源码。** 新能力落在 `vendor/deepseek-harness/packages/starhub/*`,经槽位系统(`ctx.slots.register` / `slots.inject`)或 Cordis 服务(`ctx.provide` / `ctx.get`)接入。仅两种例外可动 vendor 源码:(1) 修 DSH 自身的 bug(注释标注「上游补丁」);(2) 扩展点上无法表达且改动最小。不新增 Vue 系依赖。

## 关键命令

```bash
npm install && pnpm --dir vendor/deepseek-harness install   # 安装依赖

npm run build:window         # 构建 React 工作台(→ dist-starhub-react/)
npm run sidecar:build        # Go Sidecar(加 :release 为 release 构建)
npm run sidecar-rust:build   # Rust sidecar(scripts/cargo-sidecar.mjs:Windows 转 .bat 加载 MSVC,其它平台直调 cargo)

npm run test:utils           # node --test 纯逻辑套件;其余套件见 package.json scripts
npm run test:provision       # provisioning 合并逻辑单测
npm run smoke:dsh-desktop    # provisioning + 宿主进程冒烟(五条断言)
npm run plugin:bundle        # 纯插件形态:组装 dist-plugin/(加 --pack 出 .tgz,粘进 dsh 插件页)
npm run plugin:pack          # 同上并打 tarball(Windows PowerShell 下 `npm run x -- --pack` 会被吞参,故单列一个脚本)
npm run smoke:plugin-bundle  # 纯插件形态:真 pnpm 安装 + 宿主冒烟(五条断言)
npm run verify:bridge-compat # 真 sidecar 二进制 ↔ 桥兼容层全工具面验收

npm run package:dsh-runtime  # 打包 dsh 运行时(→ dsh-runtime/)
npm run provision:dsh        # 把 StarHub 组合装进一个 dsh profile
npm run version              # 版本号同步(见下)

# 上游 Electron 壳(发布链)
pnpm --dir vendor/deepseek-harness/apps/desktop run package:win:x64:unsigned
```

## 开发约定

**提交信息**:Conventional Commits + emoji 前缀:`✨ feat` / `🐛 fix` / `📝 docs` / `🔧 chore` / `⬆️ upgrade` / `⚡ perf` / `✅ test` / `🎨 style` / `♻️ refactor` / `🗑️ remove`,格式 `<emoji> <type>(scope): <subject>`。一次 commit 只装一个主题。

**分支**:`main` 主干;`feat/<name>` / `fix/<name>` / `docs/<name>` / `refactor/<name>` / `release/v<x.y.z>`。

**代码风格**:TS `strict`、禁 `any`(用 `unknown`);Rust 过 `cargo fmt` + `clippy`;Go 过 `gofmt`;公共 API 写文档注释;面向用户文案走 i18n,禁硬编码;全仓库 UTF-8 无 BOM。

## 版本与提交纪律(强制)

1. **改完立即 commit + push**:工作区不允许长期挂未提交改动;不把自己的改动和用户已有的未提交改动塞进同一个 commit(diff 不干净时只 commit 自己审过的部分,其余明确告知用户)。
2. **代码或构建链改动必须升版**,纯文档改动(docs/、README 正文、注释)免升版。判断标准:会不会改变打包产物或用户可感知行为?不会 → 免升版;拿不准 → 升。
3. **升版同步四处**(M4 退役 src-tauri 之后从七处降下来):`package.json`、`CHANGELOG.md`、`AGENTS.md`(本节「当前版本」)、`README.md`(版本 badge)。`npm run version` 一键搞定。
4. **版本号规则**:主版本 = 架构不兼容变更;次版本 = 新功能;修订版 = bug 修复 / 小改进 / 构建脚本调整。
5. **CHANGELOG**:改动在 `[未发布]` 下补条目,发布时移到 `[x.y.z] - YYYY-MM-DD` 下。
6. **tag 与 Release**:`release.yml` 由 `v*.*.*` tag 触发;一次 push 最多触发 3 个 tag,超出静默丢弃;多版本只在最后推最新 tag,单个推(`git tag vX.Y.Z && git push origin vX.Y.Z`);纯文档修订版不打 tag。

## 测试

| 层 | 工具 | 命令 |
|---|---|---|
| 前端纯逻辑 | node --test | `npm run test:utils` 等(见 package.json scripts) |
| 前端组件 | Vitest | `vendor/deepseek-harness` 内 `pnpm` 脚本 |
| Rust | cargo test | `npm run sidecar-rust:test`(Windows)/ `cargo test --manifest-path sidecar-rust/Cargo.toml` |
| Go | go test | `cd sidecar && go test ./...` |
| 发布链 | node --test + 冒烟 | `npm run test:provision` + `npm run smoke:dsh-desktop` |

## 文档维护(强制)

架构级变更必须同步:`docs/技术方案.md`、`docs/架构图.html`、`CHANGELOG.md`、本文件。已知坑沉淀到 `docs/踩坑记录.md`,主题索引在 `docs/已知坑索引.md`。

## 协作 Tips

- **改文档前先读**:`docs/技术方案.md` 是事实来源,代码与文档冲突时先更新文档。
- **跨域改动要协调**:加数据库支持 = `sidecar/adapters/` + 技术方案文档 + 技术栈表;加 SSH 能力同理。
- **安全 / 性能 / 架构决策**先开 Issue 讨论,不独自拍板。
- **不确定时**优先遵循 `docs/技术方案.md`;文档没写的沿用主流方案 + 开 Issue 提案,不凭直觉造新架构。

---

*最后更新: 2026-10-10 (v0.129.3)*
