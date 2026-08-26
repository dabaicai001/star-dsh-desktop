# StarHub — Agent 协作指引

> 本文件供 AI Agent(以及人类贡献者)快速理解项目结构、技术栈、约定与工作方式。
> 任何架构级变更请同步更新 `docs/` 与本文件。

**快速导航**:[1. 项目定位](#1-项目定位) · [2. 仓库信息](#2-仓库信息) · [3. 目录结构](#3-目录结构v032-实际快照) · [4. 技术栈](#4-技术栈)([4.4 设计系统](#44-设计系统design-system)) · [5. 关键命令](#5-关键命令) · [6. 开发约定](#6-开发约定)([6.5 版本发布](#65-版本发布强制) / [6.6 必 commit](#66-修改后必-commit强制)) · [7. 测试/构建](#7-测试--构建)([7.3 UI 回归](#73-真实布局浏览器回归ui-改动强制)) · [8. 沟通协作](#8-沟通与协作) · [9. 文档维护](#9-文档维护强制) · [10. 已知坑索引](#10-已知坑与注意事项索引) · [11. 路线图](#11-路线图与任务优先级) · [12. 协作 Tips](#12-agent-协作-tips)

---

## 1. 项目定位

**StarHub** 是一款跨平台(Windows / macOS / Linux)的桌面应用,把开发运维日常所需的多种工具整合到一个窗口:

- 🗄️ 数据库客户端(MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Oracle / 国产库)
- 🖥️ SSH 终端(跳板机、隧道、命令广播、批量执行)
- 📁 SFTP 文件传输(三栏布局、ZMODEM/SCP、断点续传)
- 🐳 Docker 面板(容器/镜像、SSH 通道连远程 Docker、镜像加速)
- 🤖 AI 助手(自然语言驱动本机与远程运维,Function Calling)

详细功能矩阵见 [`docs/技术方案.md`](./docs/技术方案.md) 第 3 章(280+ 子功能,P0/P1/P2/P3 标注)。

---

## 2. 仓库信息

| 项 | 值 |
|---|---|
| GitHub | https://github.com/dabaicai001/star-dsh-desktop |
| 主分支 | `main` |
| 协议 | MIT |
| 立项时间 | 2026-06-04 |
| 当前版本 | v0.98.0(✨ 设置「打开配置文件」改为**壳内打开并支持编辑保存**:新增 Tauri `dsh_settings_path` 返回 `settings.yaml` 路径,StarHub 插件注册 `settings.action`(plugin 形式,不改上游工具视图)经 `starhubFileViewer` 在壳内打开;对话 Read/Edit 工具卡文件名点击同走壳内文件查看窗(改 `ui-conversation/openFile` 优先 `starhubFileViewer`,回退原生打开器)。) |

---

## 3. 目录结构(v0.32 实际快照)

```
starhub/
├── .github/                  # GitHub 配置(ISSUE_TEMPLATE / PR_TEMPLATE / CI)
├── .gitignore
├── AGENTS.md                 # 本文件
├── CHANGELOG.md
├── LICENSE
├── README.md
├── docs/
│   ├── 技术方案.md            # 完整技术方案
│   ├── 设计系统.md            # 设计系统规范(token / 组件类 / 反模式)
│   ├── 踩坑记录.md            # 已知坑详细内容
│   ├── 已知坑索引.md          # 已知坑主题索引(见第 10 节)
│   └── 架构图.html            # 可视化架构图
│
├── legacy-core/              # 脱离 Vue 的纯 TypeScript 工具与服务,由 Node 测试覆盖
├── vendor/deepseek-harness/  # DSH 主壳与 StarHub React 工作台
│   ├── apps/starhub-window/  # 独立 React 资产工作台构建入口
│   └── packages/starhub/     # React 导航、设置、资产管理和静态托管插件
│
├── src-tauri/                # 桌面壳与主进程 - Rust
│   ├── src/
│   │   ├── main.rs            # 入口
│   │   ├── mcp.rs             # MCP Server 管理
│   │   ├── commands/          # 全部 Tauri Command(ssh/sftp/db/docker/ai/mcp/asset/audit/alert/local/secret/sidecar/broker/file)
│   │   ├── ssh/               # SSH 会话(russh):auth / session / known_hosts / sftp_transport
│   │   ├── sftp/              # SFTP 会话与传输(russh-sftp)
│   │   ├── db/                # 本地 SQLite 持久化(sqlx)
│   │   ├── ai/                # AI Gateway
│   │   ├── keyring/           # 系统 Keyring 封装
│   │   └── sidecar/           # Go Sidecar 启动器(路径解析见 docs/踩坑记录.md 第 4 节)
│   ├── capabilities/          # Tauri 权限(含 detach-* 窗口)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/                 # 打包图标(见 docs/踩坑记录.md 第 6 节)
│
├── sidecar/                  # Go Sidecar - 数据库/中间件代理
│   ├── main.go                # 入口(stdio JSON-RPC server)
│   ├── adapters/              # 各 DB / 中间件适配器
│   │   ├── mysql.go / postgres.go / sqlite.go / redis.go
│   │   ├── clickhouse.go / mssql.go / elasticsearch.go
│   │   ├── broker.go          # Kafka / NSQ 元数据
│   │   ├── docker.go / docker_compose.go / docker_ssh.go
│   │   ├── excel.go / csv.go / backup.go
│   │   └── handlers.go        # RPC 分发(各域 *_handlers.go)
│   ├── pool/                  # 连接池
│   ├── rpc/                   # JSON-RPC 协议
│   ├── bin/                   # 构建输出(starhub-sidecar[.exe])
│   ├── winres/                # Windows 资源(rsrc_*.syso)
│   ├── go.mod
│   └── go.sum
│
├── scripts/                  # 构建脚本(build-sidecar.mjs、Linux 打包与校验)
├── tests/                    # node --test 单测(utils、AI 上下文/滚动)
└── vendor/                   # 上游源码引用(git submodule)
    ├── univer/               # DreamNum Univer v0.25.1
    └── univer-presets/       # DreamNum Univer Presets v0.25.1
```

---

## 4. 技术栈

### 4.1 前端

| 类别 | 选型 | 备注 |
|---|---|---|
| 框架 | React + DeepSeek Harness | DSH Web 主壳、StarHub React 工作台与设置分区 |
| 构建 | Vite 5+ | `starhub-window` 生成 `dist-starhub-react/` |
| 语言 | TypeScript 5+ | strict 模式 |
| 终端 | xterm.js 6 | React SSH 工作台 |
| SQL 编辑 | CodeMirror 6 | React 数据库工作台 |
| Markdown | DSH UI renderer | AI 对话渲染 |
| 资产管理 | React `NewConnectionDialog` | Tauri IPC 创建、编辑、删除和测试连接 |

### 4.2 桌面壳与主进程(Rust)

| 类别 | Crate | 用途 |
|---|---|---|
| 桌面壳 | `tauri` 2.x | 多窗口、权限、Updater |
| 自动更新 | `tauri-plugin-updater` 2 | 检查/下载/安装应用更新 |
| 进程管理 | `tauri-plugin-process` 2 | 更新后重启应用 |
| 异步 | `tokio` | 全异步 |
| SSH | `russh` + `russh-sftp` | SSH / SFTP |
| SFTP | `russh-sftp` 2.x | SFTP client |
| Docker | `bollard` | Docker API |
| HTTP | `reqwest` | LLM API / Webhook |
| 持久化 | `sqlx` (SQLite) | 本地资产/配置 |
| 序列化 | `serde` + `serde_json` | |
| 加密 | `aes-gcm` / `argon2` | 敏感数据 |
| 系统监控 | `sysinfo` | CPU/内存/进程 |
| 密钥 | `keyring-rs` | 系统 Keyring |
| 日志 | `tracing` | |
| 错误 | `thiserror` + `anyhow` | |

### 4.3 Sidecar(Go 1.25+)

| 类别 | 包 | 用途 |
|---|---|---|
| MySQL | `github.com/go-sql-driver/mysql` | |
| PostgreSQL | `github.com/jackc/pgx/v5` | 性能之王,流式一等公民 |
| SQLite | `modernc.org/sqlite` | 纯 Go,无 CGO,跨平台编译无坑 |
| Redis | `github.com/redis/go-redis/v9` | 官方维护 |
| ClickHouse | `github.com/ClickHouse/clickhouse-go/v2` | 官方 |
| SQL Server | `github.com/microsoft/go-mssqldb` | 微软官方 |
| Oracle | `github.com/sijms/go-ora` | 纯 Go,无需 Instant Client **(规划中)** |
| Elasticsearch | `github.com/elastic/go-elasticsearch/v8` | 官方 |
| MongoDB | `go.mongodb.org/mongo-driver` | **(规划中)** |
| Kafka | `github.com/segmentio/kafka-go` | Broker 元数据、Topic / 分区状态 |
| NSQ | nsqd TCP + HTTP Stats API | Topic / Channel / 积压状态 |
| Docker | `github.com/docker/docker` | 容器/镜像/Compose,支持 SSH 通道 |
| 国产库兜底 | `github.com/alexbrainman/odbc` | 达梦/金仓 ODBC 桥 **(规划中)** |
| SQL 工具 | `github.com/jmoiron/sqlx` | Struct 映射 + 命名参数 |
| Excel | `github.com/xuri/excelize/v2` | 导入导出、工作簿编辑 |
| 日志 | `github.com/rs/zerolog` | 结构化日志 |
| 验证 | `github.com/go-playground/validator/v10` | **(规划中)** |
| 配置 | `github.com/spf13/viper` | **(规划中)** |
| 指标 | `github.com/prometheus/client_golang` | **(规划中)** |
| 追踪 | `go.opentelemetry.io/otel` | **(规划中)** |
| 测试 | `github.com/stretchr/testify` | **(规划中)** |
| Mock | `github.com/golang/mock` + `github.com/DATA-DOG/go-sqlmock` | **(规划中)** |

### 4.4 UI 约定

- StarHub 交互界面由 DeepSeek Harness React UI 提供；改动遵循 `vendor/deepseek-harness` 的组件、图标和样式约定。
- 不新增 Vue、Vuetify、Pinia 或 Vue Router 依赖。
- 面向用户的文案应复用 DSH 已有的本地化与界面模式。
- **新功能优先以 DSH 插件形式注入，禁止改 DSH 内核源码**：任何新增能力都落在 StarHub 自己的包（`vendor/deepseek-harness/packages/starhub/*`）里，经 DSH 的**槽位系统（`ctx.slots.register` / `slots.inject`）**或 **Cordis 服务（`ctx.provide` / `ctx.get`）**接入，而不是改上游 `packages/client/*`、`packages/bundle/*` 等 DSH 源码。仅两种例外允许动 vendor 源码：(1) 修 DSH 自身确实是 bug 的地方（在注释/文档标注「上游补丁」及复现）；(2) 该能力在 DSH 扩展点上无法表达且改动最小（如给一个注入函数加一次 `ctx.get` 优先分支）。判断：能否用「StarHub 插件注册一个槽 / 提供或消费一个服务」表达？能 → 走插件；不能 → 先回退到最小、带注释的 vendor 改动。

---

## 5. 关键命令

> 根 `package.json` 管理 Tauri、sidecar、React workbench 构建及 Node 测试；DSH React 源码和工作区脚本位于 `vendor/deepseek-harness`。

```bash
# 仓库根
cd D:\code\new_project\starhub

# 安装根依赖
npm install

# 完整桌面开发:检查 DSH 产物、构建 sidecar 和 React workbench,然后启动 DSH 主壳
npm run tauri:dev

# 单独构建 React 资产工作台
npm run build:window

# Node 纯逻辑测试
npm run test:utils
npm run test:ai-context
npm run test:ai-scroll

# Rust 主进程
cd src-tauri && cargo build && cargo test
# Git Bash 下 cl.exe 不在 PATH,用 npm 脚本(scripts/cargo-env.bat 先加载 MSVC 环境;
# vcvars64.bat 路径取 STARHUB_VCVARS 环境变量,缺省回退 D:\c++1)
npm run cargo:check
npm run cargo:test

# Go Sidecar(推荐走根目录脚本,自动处理 GOOS/GOARCH 与 rsrc)
npm run sidecar:build           # debug
npm run sidecar:build:release   # release(-ldflags "-s -w")
# 手动:cd sidecar && go build -o bin/starhub-sidecar .   # 注意二进制名是 starhub-sidecar

# 跨平台打包(Releases 用,产出 MSI/DEB/RPM/AppImage 等)
npm run tauri:build
```

---

## 6. 开发约定

### 6.1 提交信息(Conventional Commits)

```
<emoji> <type>(scope): <subject>

<body>

<footer>
```

**emoji 前缀**:
- 🎉 `init` / 重大里程碑
- ✨ `feat` 新功能
- 🐛 `fix` 修 bug
- 📝 `docs` 文档
- 🔧 `chore` / `refactor` 杂项 / 重构
- ⬆️ `upgrade` 升级依赖
- ⚡ `perf` 性能优化
- ✅ `test` 测试
- 🎨 `style` 样式

**示例**:
```
✨ feat(ssh): add jump host support
🐛 fix(db): handle MySQL connection timeout
📝 docs: update architecture diagram for v0.2
```

### 6.2 分支命名

| 类型 | 命名 | 例子 |
|---|---|---|
| 主分支 | `main` | |
| 功能 | `feat/<short-name>` | `feat/ssh-jump-host` |
| 修复 | `fix/<short-name>` | `fix/db-stream-overflow` |
| 文档 | `docs/<short-name>` | `docs/update-roadmap` |
| 重构 | `refactor/<short-name>` | `refactor/sidecar-protocol` |
| 发布 | `release/v<version>` | `release/v0.3.0` |

### 6.3 代码风格

- **TypeScript**: `strict: true`,禁用 `any`(`unknown` 替代)
- **React/TypeScript**:遵循 DeepSeek Harness 既有组件与状态模式
- **Rust**: `cargo fmt` + `cargo clippy` 必过
- **Go**: `gofmt` + `golangci-lint` 必过
- **命名**: 文件/类 `PascalCase`;函数/变量 `camelCase`(前端)/ `snake_case`(Rust/Go)
- **注释**: 公共 API 必须有文档注释(`///` Rust / `/** */` TS / `//` Go)
- **国际化**: 面向用户文案必须走 i18n,禁止硬编码

### 6.4 路径与编码

- 仓库内路径用相对路径,文档中以正斜杠 `/` 写
- 跨平台说明时:`Windows: D:\code\new_project\starhub`、`Unix: ~/code/starhub`
- 字符编码: 全仓库 UTF-8(无 BOM)
- 行尾: 跟随 git 默认(Windows CRLF / Unix LF,git 会自动转换)

### 6.5 版本发布(强制)

每次大需求完成之后,必须执行以下操作:

1. **更新 `CHANGELOG.md`**:
   - 将 `[未发布]` 中已完成的内容移到新版本号下
   - 新版本号格式:`[x.y.z] - YYYY-MM-DD`
   - 保留 `[未发布]` 部分用于计划中功能

2. **同步七处版本号**:
   - `package.json` 的 `version` 字段
   - `src-tauri/Cargo.toml` 的 `version` 字段
   - `src-tauri/Cargo.lock` 中 `starhub` 包的 `version`(`cargo check` 或手动同步)
   - `src-tauri/tauri.conf.json` 的 `version` 字段
   - `CHANGELOG.md` 的最新版本号
   - `AGENTS.md` 第 2 节「当前版本」一行
   - `README.md` 的版本 badge 与「当前版本」区
   - 七处必须保持一致,禁止出现某个文件落后于其他文件的情况

3. **版本号规则**:
   - **主版本(x)**: 架构重大变更、不兼容 API
   - **次版本(y)**: 新功能、大需求完成
   - **修订版(z)**: Bug 修复、小改进、文档/构建脚本调整

4. **发布检查清单**:
   - [ ] CHANGELOG.md 已更新
   - [ ] 七处版本号(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)已同步
   - [ ] AGENTS.md 第 2 节「当前版本」已更新
   - [ ] AGENTS.md 末尾「最后更新」日期已同步
   - [ ] 文档与代码一致

5. **git tag 与 Release 构建(强制)**:
   - `release.yml` 由 `v*.*.*` tag push 触发;GitHub 单次 push 最多为 **3 个 tag** 触发工作流,超出部分静默丢弃
   - **一次会话涉及多个版本时,只在最后 push 最新版本的 tag**(中间版本只 commit/push,不打 tag、不出包)
   - 纯文档/脚本类修订版(z)默认不打 tag,避免为无产物价值的变更触发 Release 构建;tag 随下一个有实际代码产物的版本一起打
   - 推 tag 一律单个推:`git tag vX.Y.Z && git push origin vX.Y.Z`,禁止一次推多个 tag

6. **README「当前版本」区只保留最近 3 个版本**:`bump-version.mjs` 每次会在顶部插入新版本条目,升版后顺手把超出 3 个的旧条目裁掉(完整历史以 CHANGELOG.md 为准)。

### 6.5.1 每次更新代码必须更新版本号(强制)

**核心规则**:**任何一次**代码或构建链改动提交时,版本号必须随之递增,不允许「改了代码但版本号不变」。

**例外(2026-08-16 起,maintainer 决定)**:**纯文档改动不递增版本号**——只动 `docs/`、`README.md` 正文、代码注释等不进入构建产物、不影响运行时行为的提交,直接 commit/push 即可,不动七处版本号、不写 CHANGELOG 条目(方案/手册类文档自身的「变更记录」写进该文档头部即可)。判断标准:这次提交会不会改变打包产物或用户可感知行为?不会 → 免升版。拿不准时按升版处理(宁多勿漏,仅限代码)。

**为什么**(代码必须升版):
- StarHub 是桌面应用,版本号是用户可感知的升级信号;同一版本号对应两份不同的代码,会让打包产物、更新日志、崩溃上报全部失真
- Tauri Updater、安装包元数据、`Cargo.toml` / `tauri.conf.json` / `package.json` 三处版本号任一不一致,都会导致签名校验、增量更新、依赖解析出现难以排查的偏差
- AI Agent 在多轮对话里容易「只改代码不动版本号」,长此以往 CHANGELOG 与实际产物脱节

**对 AI Agent 的硬约束**:
1. 每次提交代码 / 文档前,先 `git diff` 看自己动了哪些文件
2. 按改动性质决定递增哪一位(参考 6.5 第 3 条版本号规则):
   - 纯文档改动(docs/、README 正文、注释)→ **免升版**(见上方例外)
   - 构建脚本 / 修复 typo / 小改进 → **修订版(z)+1**
   - 新增功能或大需求 → **次版本(y)+1**(z 归零)
   - 架构级不兼容变更 → **主版本(x)+1**(y、z 归零)
3. 同步更新 6.5 第 2 条列出的**七处**版本号,不允许只改其中一两个
4. 在 `CHANGELOG.md` 的 `[未发布]` 下补一条本次改动,或在发布时移到新版本号下
5. 不允许出现「代码已 commit、版本号仍停在上一版」的情况;若发现历史遗留(如本次修复的 0.12.0/0.12.1 不一致),必须一次性对齐

**反例**:
- ❌ 改了 `src-tauri/src/sftp/ops.rs` 但 `Cargo.toml` / `tauri.conf.json` 版本号没动
- ❌ `package.json` 是 0.12.1、`Cargo.toml` 还是 0.12.0
- ❌ 只更新 `package.json` 就认为版本号「已经更新了」

### 6.6 修改后必 commit(强制)

**核心规则**:工作区**不允许**长期挂着未提交的修改。任何代码 / 文档改动完成后,必须立即 `git commit`(写清 Conventional Commits 信息),不允许"先攒着回头再 commit"。

**为什么**:
- 长期未提交的改动容易跟其他改动混在一起,事后拆分主题很痛苦
- 重启 / 切换分支 / 误操作可能直接丢失未提交的工作
- AI Agent 在多轮对话里也容易遗漏"我改过 X 但没 commit"

**对 AI Agent 的硬约束**:
1. 修改完代码 / 文档 → 立即 `git status` 看自己动了哪些文件 → 立即 commit
2. 不允许等用户提醒"你怎么不 commit"——这是基本职业素养
3. 不允许把"自己的改动 + 用户之前的未提交改动"塞进同一个 commit;
   如果 diff 不干净(混了用户之前的累积改动),只 commit 自己审过的那部分,
   把混进来的部分**明确告诉用户**让他自己处理
4. 一次 commit 只装一个主题;多主题改动拆成多个 commit
5. commit 完默认 `git push`(除非用户明确说"先别 push")

**commit 粒度参考**:
- ✅ 一个 bug fix 一个 commit
- ✅ 一个新功能一个 commit
- ✅ 一次文档同步一个 commit
- ❌ 三个无关改动塞一个 commit
- ❌ 自己的 fix 跟用户之前的 feat 塞一个 commit(污染历史)

---

## 7. 测试 / 构建

### 7.1 测试策略

| 层 | 工具 | 命令 | 范围 |
|---|---|---|---|
| 前端单元 | Vitest | `npm run test` | components / stores / utils |
| 前端纯逻辑 | node --test | `npm run test:utils` / `test:ai-context` / `test:ai-scroll` | `tests/` 下的 utils 与 AI 上下文/滚动 |
| 前端 E2E | Playwright | (规划中) | 关键流程(连接 SSH、跑 SQL) |
| Rust 单元 | `cargo test` | `cd src-tauri && cargo test` | 协议层、工具函数 |
| Rust 集成 | `cargo test --test integration` | 同上 | 跨模块 |
| Go 单元 | `go test` | `cd sidecar && go test ./...` | adapters、pool、rpc(已有 `*_test.go`) |
| Go 集成 | `docker-compose up -d mysql pg redis` | (规划中) | 真实 DB 跑查询 |

### 7.2 CI(GitHub Actions,规划)

- `lint.yml`: Rust clippy / Go golangci-lint / ESLint / Prettier
- `test.yml`: 各层单元测试
- `build.yml`: 三平台 Tauri 打包(macOS / Windows / Linux runner)
- `release.yml`: tag 触发,自动发 GitHub Release + 签名 + 更新元数据


### 7.4 性能目标

| 指标 | 目标 |
|---|---|
| 冷启动 | < 2s |
| SSH 连接 | < 1.5s |
| 百万行表格滚动 | 60fps |
| 空闲内存 | < 200MB |
| 安装包 | DEB/RPM/Windows < 35MB;自包含 AppImage < 120MB |
| 终端输入延迟 | < 30ms |

---

## 8. 沟通与协作

- **Bug 报告 / 功能请求**: GitHub Issue
- **架构讨论**: 先开 Issue 标注 `discussion`,达成共识再开 PR
- **代码审查**: 至少 1 人 approve 才能 merge
- **安全漏洞**: 邮件私密汇报(暂未公布),不要直接开 public Issue

---

## 9. 文档维护(强制)

任何**架构级变更**必须同步更新:

- [`docs/技术方案.md`](./docs/技术方案.md) — 完整技术细节
- [`docs/架构图.html`](./docs/架构图.html) — 可视化架构图
- [`CHANGELOG.md`](./CHANGELOG.md) — 版本日志
- [`AGENTS.md`](./AGENTS.md) — 本文件(技术栈、约定变更时)

---

## 10. 已知坑与注意事项(索引)

> 已知坑主题索引与维护规则已迁移至 [`docs/已知坑索引.md`](./docs/已知坑索引.md),详细内容沉淀在 [`docs/踩坑记录.md`](./docs/踩坑记录.md)。遇到对应领域的问题请先查阅索引。

---

## 11. 路线图与任务优先级

完整功能矩阵与 P0/P1/P2/P3 标注见 `docs/技术方案.md` 第 3、11 章。

**MVP(P0)已全部交付**:SSH 终端、SFTP(三栏 + 拖拽 + ZMODEM)、MySQL / PostgreSQL / SQLite / Redis、Docker 基础、AI 基础。

**当前所处阶段(P1+ 持续迭代中,截至 v0.32)已交付的代表性能力**:

- 数据库:ClickHouse / SQL Server / Elasticsearch、备份恢复、审计与告警
- SSH:跳板机、端口转发、分屏、命令广播、危险命令拦截
- SFTP:断点续传、暂停/继续、全局传输任务条(TransferDock)
- Docker:Compose、SSH 通道连远程
- AI:Planner → Executor、MCP Server、工作区内嵌确认卡、@/# 上下文绑定
- 应用:dsh 主壳融合(功能页 embed overlay)、深浅双主题、自动更新(标签页拖出独立窗口已随旧外壳于 P4a 退役)

**下一步候选**(以 Issue / `CHANGELOG.md` [未发布] 为准):Settings 代理与安全 tab、Oracle / MongoDB 适配、国产库 ODBC 桥、CI/CD 流水线。

---

## 12. Agent 协作 Tips

> 写给 AI Agent(以及不熟悉项目的人类)的实战经验。

### 12.1 改文档前先读

`docs/技术方案.md` 和 `docs/架构图.html` 是事实来源。任何与文档冲突的代码或设计,先更新文档再写代码。

### 12.2 跨域改动要协调

数据库 / AI / SSH 是相互依赖的:
- 加新的 SSH 命令需要同时更新: `docs/技术方案.md`(6.1 节)+ `CHANGELOG.md` + 本文件(技术栈)
- 加新的数据库支持需要: `sidecar/adapters/` + 文档(3.4.1 节)+ 技术栈表

### 12.3 涉及安全/性能/架构的决策

- 不要独自决定。先开 Issue 讨论
- 投票或 maintainer 拍板后,再写代码 + 更新文档

### 12.4 不确定时

- 优先遵循 `docs/技术方案.md`
- 文档没写的,沿用主流方案 + 开 Issue 提案
- 不要凭直觉造新架构

---

*最后更新: 2026-08-26 (v0.98.0)*
