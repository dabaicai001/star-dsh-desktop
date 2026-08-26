<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.98.3-cyan)]()
[![Status](https://img.shields.io/badge/status-active%20development-brightgreen)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/star-dsh-desktop/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

</div>

---

## 项目介绍

**StarHub** 是一款跨平台桌面应用（Tauri 2 + Rust 主进程 + DeepSeek Harness React 工作台 + Go Sidecar），把开发运维日常高频工具整合到同一个窗口 —— 数据库、SSH/SFTP、Docker 面板与 AI 助手。目标是减少在 Navicat、Xshell、Portainer、文件管理器和 AI 对话窗口之间来回切换的成本。

**前端架构**：基于 DeepSeek Harness 原生 React 工作台（`/starhub-react` 路由）。资产、设置、SSH 终端、SFTP、数据库（MySQL/PG/SQLite/ClickHouse/SQL Server/Redis/Elasticsearch）、Docker、AI 助手、Broker、Excel 工具全部由壳内 React 工作台承载，深浅双主题、token 体系与键盘快捷键跨工作区打通。

**当前版本聚焦**：本地优先、单人高效、跨平台一致体验。Agent 可经 `@` 资产引用在任意工作台上下文里发起 SSH / 数据库 / SFTP / Docker 操作，并配合 AI 记忆系统延续跨会话工作。

---

## 下载安装

前往 [GitHub Releases](https://github.com/dabaicai001/star-dsh-desktop/releases) 下载最新版本：

| 平台 | 文件格式 | 安装方式 |
|---|---|---|
| **Windows** | `.msi` / `.exe` (NSIS) | 双击安装 |
| **Linux** (Debian/Ubuntu) | `.deb` | `sudo apt install ./StarHub_0.87.8_amd64.deb` |
| **Linux** (Fedora 38+ 等 glibc 2.35+ RPM 系) | `.rpm` | `sudo dnf install ./StarHub-0.87.8-1.x86_64.rpm` |
| **Linux** (通用) | `.AppImage` | `chmod +x StarHub_0.87.8_amd64.AppImage && ./StarHub_0.87.8_amd64.AppImage` |
| **macOS** | `.dmg` / `.app` | 拖入 Applications |

> Linux 同时发布 x86_64 (`amd64`) 与 ARM64 (`arm64` / `aarch64`)。默认产物在 Ubuntu 24.04 原生 runner 构建，兼容 Ubuntu 24.04+ / Debian 13+ / Fedora 40+ 等 **glibc 2.39+** 桌面发行版；同时发布 **Ubuntu 22.04 兼容版**（无截图，glibc 2.35，文件名带 `-ubuntu2204` 后缀）供 Ubuntu 22.04 / Debian 12 / Fedora 38+ 等旧系统使用。AppImage 已携带 WebKitGTK、GTK 和静态 Go sidecar；无 FUSE 环境可使用 `./StarHub_0.87.8_amd64.AppImage --appimage-extract-and-run`。Alpine（musl）与无 FHS 兼容层的 NixOS 不属于直接兼容范围。

---

## 功能矩阵

### 数据库客户端（Go Sidecar 承载）

- ✅ **MySQL**：表结构、数据浏览、查询执行、DDL/索引/列管理、表数据 Excel 全量导出（后端直写 xlsx，分批拉取 + 进度条 + 通知中心）
- ✅ **PostgreSQL / SQLite**：表浏览、查询执行、数据导出
- ✅ **Redis**：键浏览（SCAN 分页 + 搜索 + 刷新/空态/错误）、String/Hash/List/Set/ZSet 五类值的 tab 式编辑（HDEL/SREM/ZREM/HSET/SADD/ZADD/LSET 命令拼装）、TTL 与 DB 切换、CLI `db_redis_execute`、新建/重命名/删除/清空键
- ✅ **Elasticsearch**：索引浏览、文档查询、聚合、DSL 检索表格/JSON 双视图 + 分页、索引映射/settings 详情、新建/删除索引
- ✅ **ClickHouse / SQL Server**：表浏览、查询执行、导出
- ✅ **DB 监控 Dashboard**：MySQL / PG / Redis 性能仪表盘（概览/性能/网络 tab、指标卡、连接会话、慢语句明细；Redis INFO + db_size、MySQL SHOW 系列 + 慢日志 digest 回退、PG pg_stat_activity + pg_stat_statements 扩展失败回退），30 秒自动刷新
- ✅ **SQL 编辑器**：CodeMirror 6 内嵌，MySQL/PG 方言高亮，schema 表/列补全，多语句拆分执行，Mod-Enter 执行 / Shift-Mod-e EXPLAIN / Tab 缩进；SQL 格式化、历史（最多 1000 条，键 `starhub.sqlHistory`）、多语句拆分
- ✅ **DDL 生成器**：MySQL/PG/ClickHouse 方言 CREATE TABLE / ADD/MODIFY/CHANGE/DROP COLUMN / CREATE+DROP INDEX 单语句合并（兼容 `INFORMATION_SCHEMA` 读取），索引存在性判断（不生成 DROP 不存在的索引以规避 Error 1091）
- ✅ **结果网格**：原生 HTML 表格 + 虚拟滚动（ROW_HEIGHT=28/OVERSCAN=8），表头 hover 提示类型/可空/键/默认值/备注，列排序、拖拽调宽、表内搜索 + 服务端列筛选，复制 INSERT 语句、行复制、删除行、批量编辑保存（`Ctrl/Cmd+S` 按主键 `db_mysql_update_rows` 批量提交）
- ✅ **备份恢复、SQL 审计与告警**
- 🚧 **Oracle / MongoDB / 国产库 ODBC 桥**（规划中）

### SSH 终端

- xterm.js 6 渲染，FitAddon / WebLinksAddon / SearchAddon
- **ZMODEM 协议支持**：通过 `zmodem.js` 在 Webview 侧实现 `rz` / `sz`，支持远端触发本地文件选择发送 / 远端发送本地接收并保存
- 跳板机、端口转发、分屏、**命令广播**（多会话同时下发，单条失败不影响其他会话）、**危险命令拦截**
- **快捷命令管理器** + Xshell `.qbl` / `.qblx` 导入（兼容旧格式 + Xshell 8 UTF-16 + 多命令集合并）
- **shell prompt 捕获 + cwd 跟踪**：终端输出解析 OSC 7 + `pwd` 输出，隐藏回显过滤；SFTP 面板「跟随终端」一键定位远端当前目录
- **服务器网页访问**：经 SSH direct-tcpip 的 Web 网关（幂等启动 + 端口校验重启 + postMessage 桥），从服务器侧出口浏览公网/内网站点，支持端到端 TLS（`tokio-rustls` ring provider）
- **MFA / 2FA 认证**：password / key / mfa 三档，kb-interactive 内联验证码面板，hostkey 自动接受不持久化
- 多标签独立会话、状态恢复、断线自动重连（应用层 keepalive）；独立窗口由 Tauri 标题栏统一关闭

### SFTP 文件传输

- **壳内 SFTP 面板**：与 SSH 终端共用同一 live session（经 `sftp_ensure_session` 复用，不重复认证），双 tab 同窗口展示
- 三栏浏览、路径面包屑、隐藏文件、新建文件夹、重命名、删除、复制路径
- SFTP 启动策略：自动诊断标准 subsystem，异常时探测 `sftp-server` 路径并受控降级；支持「仅标准 subsystem」和「指定远端程序」模式
- 拖拽上传 / 下载、断点续传、暂停 / 继续 / 取消 / 重试，全局传输任务条（TransferDock）
- 跟随终端当前目录、路径输入直达、连接后落到会话起始目录

### Docker 面板

- 容器 / 镜像列表，资产树 DB 化（容器/镜像对象树联动工作区）
- 本地 Docker 主机 + **SSH 通道连远程 Docker**
- **Docker Exec 交互式 TTY**：可持续读写的终端会话，支持窗口尺寸同步、命令历史、Tab 补全、Ctrl 组合键
- **容器日志独立弹框**：最新日志置顶 + 图标刷新 / 关闭
- **Docker Compose**、镜像加速、清理入口
- SSH 传输、主机密钥、跳板机参数全量解析

### 本地工作区

- 导入文件夹 / 文件为工作区，目录树懒加载 + 缩进参考线、明细列表（大小/修改时间）
- VSCode 式编辑体验：可点击面包屑、编辑器 tab（dirty 点/关闭钮同槽位）、底部状态栏
- 文件 CRUD、右键菜单、文本编辑 `Ctrl/Cmd+S` 保存，`.xlsx`/`.csv` 自动用 Excel 工具打开
- AI 全局可读本机文件（`#LOCAL` 绑定）

### AI 助手

- OpenAI 兼容协议（GPT / Claude / DeepSeek / 通义千问 / Ollama 等），流式输出
- **多模型配置 + 会话级模型选择**：每个窗口/标签页独立切换模型，互不影响；subagent 自动继承父会话模型
- **Function Calling 可驱动 SSH / SFTP / DB / Docker / Redis / ES / 本地文件 / Excel / MCP / skill_save 等域工具**；Planner → Executor 编排；模型工具执行成功自动产生 origin=ai 领域事件，跨工作区广播
- **`@` 调用 Agent、`#` 绑定目标**（AI 工作区与各标签页内嵌助手同源支持；`@` 资产选择仅绑定 AI 工具上下文，不打开工作台标签页）
- **三级记忆卡 + SQLite FTS5 会话存档**：user / global / asset 三作用域记忆，压缩前 flush / 回合后 review 自动沉淀，侧边栏内置记忆管理（添加/删除/编辑），历史会话全文搜索（`session_search`）
- **MCP Server**：stdio、Streamable HTTP 与兼容 SSE，动态挂载外部 tools
- **审批统一走 dsh 权限体系**：设置 → 通用 → 权限 preset（read-only / workspace-write / danger-full-access），starhub 域工具（SSH/DB 写、Redis 写、ES 写、SFTP 传输、MCP 调用、记忆写入等）恒需确认，确认卡经原生窗口弹出（180s 超时）
- **最近对话恢复 + 单条删除**、每个标签页独立聊天历史；主侧边栏内嵌 AI 聊天，快速提问 `Ctrl+J`
- **危险命令强制确认**（SSH 写、数据库写、Redis 写、ES 写、文件删除、记忆写入等）

### StarHub × dsh 联动

- **`@` 资产引用驱动域工具**：当前会话可 `@ssh-1`，模型自动解析为 `ssh_exec(targetAsset=...)`，无需切窗
- **`open_connection` / `focus_terminal` 模型工具**：资产已存在则聚焦标签，不存在则新开工作台
- **`starhub/live.snapshot` 活性快照**：pre-step 注入资产注册表 + 领域事件 + 任务轨迹（taskTrails ≤ 20，按目标资产去重保序），支持跨窗口任务连续性
- **共享 settings.yaml**：StarHub 与 dsh 共用同一份设置，权限 preset / 模型 / Agent 预设双端一致
- **stdio JSON-RPC 桥**：Rust 主进程与 dsh web 进程互通 `starhub/open.asset`、`starhub/focus.tool`、`starhub/registry.sync`、`starhub/domain.event`

### 工作台体验

- **侧栏「工具」三级导航**：大类 → 子类（终端 / 数据库 / Docker）→ 资产 → 工作台，资产数徽标 + 刷新 / 新建连接一键入口
- 多标签工作区，同一资产支持多实例；标签页可拖出为独立窗口（Tauri 标题栏统一关闭入口）
- 单击资产优先激活已有标签，避免误开重复会话
- 全局搜索 `Ctrl/Command + K`、命令面板 `Ctrl/Command + P`
- 折叠侧边栏 `Ctrl/Command + B`、折叠右面板 `Ctrl/Command + Shift + B`
- 深浅双主题、自动更新（Tauri Updater + GitHub Releases latest.json）
- **通知中心**：操作历史 + 条数 / SQL / 耗时等详情
- DeepSeek Harness 原生 React 工作台，DSH `shell.overlay` 复用

### Excel 工具

- 由 Sidecar `excelize` 引擎承载，**导入 / 导出 / 编辑** 独立工作台（与 DB 工具打通，`#LOCAL` 绑定本机文件）
- XLSX / CSV 双向转换，支持数据库表 → Excel 一键导出

### 插件与扩展

- **StarHub 插件 = dsh 插件**：市场 / URL / 本地 / Zip 导入，全量市场为 UI 类插件；内置插件（client-nav / host-static / tool-context / tools）幂等注册、不可启停
- **UI 类插件直接进入 `__DSH_BOOT__`**：依赖分层解析（`@deepseek-ai/*` 走 vendor junction，第三方尽力解析），bundled 200 OK

### 资产 / 设置 / 安全

- **新建 / 编辑连接对话框**：类型下拉（SSH / MySQL / PG / ClickHouse / Redis / ES / Kafka / NSQ / Docker）+ 公共 + 专有字段，SSL / Redis DB 索引 / SSH 私钥文件；「测试连接」描边按钮 + 主按钮高对比；密码 / 私钥留空保持原值
- **DSH 风格设置面板**：侧栏分组（通用 / 模型 / 插件 / Agent 预设 / StarHub 五个子项），插件 / 审计日志 / 告警规则 / 关于 / AI 助手 tab 直渲
- **凭据托管**：系统 Keyring 优先（macOS Keychain / Windows Credential Manager / Linux Secret Service），无桌面密钥环时回退会话级 Keyutils
- **审计与告警**：操作历史 + 统计 + 清理；规则 CRUD + Webhook 测试

---

## 当前版本

### v0.98.3 (2026-08-26)
- 🔧 🐛 修复 `connect_session` MFA 信号处的编译错误:`sessions.insert(id, ...)` 先把 `id` move 进会话表,随后 `emit("ssh:mfa-connected:{id}", id.clone())` 再借用 `id` 导致 `E0382 borrow of moved value`,release 打包编译失败;改为 `insert(id.clone(), ...)` 保留原始 `id` 供发射信号使用。

### v0.98.2 (2026-08-26)
- 🔧 🔧 MFA 连接精确「目标机已连接」信号:后端把「连接成功」定义为**目标机认证全部完成**(跳板机/堡垒机选机器只是中间态),在 `connect_session` 会话落库后发 `ssh:mfa-connected:<sessionId>`;前端 MFA 卡订阅该信号展示「连接成功,会话可复用」。前端独立弹窗 UI 待后续轮落地。

### v0.98.1 (2026-08-26)
- 🔧 🐛 壳内文件查看窗/文件信息弹窗被上游 Modal 默认宽 `min(380px, 100%)` 覆盖,缩成窄窗且长内容无法滚动:`.viewer` 与 `.dialog` 宽度加 `!important`,FileInfoDialog 经 `contentClassName` 让内容区撑满固定高度并承接滚动。
- 🔧 🐛 关闭工具面板(点遮罩/空白/×)未复位文件树视图:下回点会话头部「文件」胶囊走的是 `closeFileTree` 而非 `openFileTree`,看起来没反应;`closeTools` 现同时 `fileTree.close()`。
- 🔧 🐛 设置里出现两个「打开配置文件」:上游 `ui-settings-general` 的原生打开按钮与 StarHub 壳内按钮并存——starhub-web profile 给 `api-gateway` 设 `nativeOpen: false`,让上游 `hasDocument` 为 false 不再渲染,只留壳内(对齐 Read/Edit 弹框)按钮;并把 `dsh_settings_path` 补进 `commands.toml` ACL,消除「Command … not allowed by ACL」报错。
- 🔧 🔧 `starhub-tool-context` 改为**会话级作用域**:绑定 `@` 资产时记录触发会话 id(`sessionId`),host 侧 pre-step 只对 `agent.session.id` 一致的会话注入,普通对话/其它会话不再带上下文。
- 🔧 🔧 移除工具面板头部「AI 助手」图标按钮(用户红框标出,非必要入口);对应注入字段与测试断言一并删除。

### v0.96.5 (2026-08-26)
- 🐛 🐛 **根治「安装版启动即 Failed to load plugins、换回老版本也启动不了」**:`healProfilesModuleFallback`(dsh-app-boot profile.ts 的 `ensureSymlink`)对 `$DSH_HOME/profiles/node_modules` 下**非符号链接的真实目录**原先 fail-loud 抛错(`exists and is not a symlink`),导致 dsh web 进程启动即退出、GUI 报「failed to import loader entry … client-modules: bundle script … failed to load」。该污染(旧版本复制回退残留 / 杀毒或云同步把 junction 解引用成普通目录 / 中断安装)持久存在于 DSH_HOME,任何版本启动都会在同一处崩溃——**这解释了「换回老版本也启动不了」且清理 AppData 前无法自愈**。修复:`ensureSymlink` 遇到非符号链接条目改为**隔离备份**(改名为 `<name>.dshbak-<timestamp>`,不删除用户数据)后重建 junction,启动继续、下次 heal 保持正确链接;隔离/重建失败仍 fail-loud 兜底。配套:`profile.spec.ts` 原「real directory 抛错」用例改为「隔离 + 重建 + 数据保留 + 不重复备份」自愈断言,app-boot 106 例全绿。
- 🐛 🐛 修复安装版启动偶发「Failed to load plugins」(点名 `@deepseek-ai/dsh-session-log-export`)回归:v0.83.2 的客户端 bundle 加载退避重试补丁(方案 §11.9 第 5 条)在 2026-08-25 的 DSH rc.2 整树同步中被上游原版覆盖丢失,`defaultLoadBundle` 退回单次抓取,启动时 webview 撞上 dsh web 进程更替窗口即永久拒启动。已在 rc.2 源码上重施同一补丁(`packages/client/modules` 的 `system.ts` 拆出 `fetchBundle` + `BUNDLE_RETRY_DELAYS` 300ms/1200ms 共 3 次尝试,`manifest.ts` 两处 `loadBundle` 契约注释,`loader.client.spec.ts` 重试成功/耗尽两用例,client-modules 52 例全绿);并在 `docs/DSH升级适配清单-v0.1.1-rc2.md` 新增「升级后补丁重放记录」+ 方案 §11.9 第 5 条标注「整树替换后必须重放」,防止下次升级再丢。

### v0.96.4 (2026-08-26)
- 🐛 AI 助手记忆设置改造:删除「存档 tool 消息与工具调用」「记忆写入需逐条确认」两个已退役开关(它们此前只是 UI 层状态、无真行为),「启用长期记忆」与「自动沉淀记忆」合并为单开关「启用长期记忆与自动沉淀」(host 侧 `enabled` 与 `autoReview` 同值下发)。
- 🐛 修复长期记忆「自动沉淀」从不生效:memory-sink 的消息计数用错了事件词表(`message/user` / `message/assistant` → dsh 实际的 `user/message` / `assistant/message`),导致 `shouldReview` 恒为 false、自动沉淀从不触发。
- 🐛 修复工具面板(StarHub 工具抽屉)子类行死胡同:空态分支原先不渲染「终端 / 数据库 / Docker」子类行,导致永远无法选中任何子类;改为子类行始终渲染。
- 🐛 修复会话头部「文件树」按钮开错面板:原先 `openDetails()` 打开的是 ui-conversation 独占的工具调用详情列,与文件树本体(渲染在工具抽屉内)不接通;改为打开工具抽屉并切到文件树视图。
- 🐛 文件树根目录 cwd 由注入期快照改为经 `useSessions` 响应式读取,避免切换会话后文件树仍指向旧工作区。
- 🐛 修复 `client-nav` 客户端包 bundle-purity 违例(此前无法跑通 tsdown 全量构建):`AiChatPanel` 值导入 shell 侧 React 胶水 `bindSnapshotSelector`,改为 React 内置 `useSyncExternalStore`。
- 🔧 清理死代码 `createStarHubNavStore` 与相关过时注释/README。

### v0.96.3 (2026-08-25)
- 🔧 GitHub 仓库更名为 `star-dsh-desktop`:`git remote`、README 下载/克隆链接、CHANGELOG 仓库地址、AGENTS.md 仓库信息、关于页 GitHub 链接、Tauri Updater 端点全部切换至新仓库名(旧地址仅剩 GitHub 自动重定向)。
- 🔧 DSH 内核升级到上游 v0.1.1-rc.2 的适配收尾:补回 `tsconfig.base.json` 缺失的 `dsh-client-web-react` 与 10 个 `dsh-starhub-*` 显式 paths 映射(修复测试把包解析到 node_modules lib 的连锁失败)、补回 `web/tsconfig.json` 丢失的 5 个 project references、恢复 `loader-status.ts` 升级时丢失的 `KernelSignal`/`createSignal`/`createLoaderStatusStore` 实现(修复 client typecheck 6 个错误)、修正 2 个此前从未真正运行的测试断言。回归:host typecheck / client typecheck 双零错误,host 单测 145 过、client-nav 857 过、Rust 164 过。已知限制:tsdown 全量构建需 Node `^22.19||>=24`(本机 22.14 下不可用),lib/ 产物被 .gitignore 忽略,换环境需重跑 tsc + `emit-typert-remotes.mjs`(详见 docs/DSH升级交接说明.md)。

### v0.96.1 (2026-08-25)
- 🐛 AI `@` 直连堡垒机(如阿里云 BastionHost 公网入口,host 即堡垒机、未配跳板机)在验证码通过后报错:堡垒机 pty 判定 `is_bastion()` 原先强制要求 `jump_host`,直连堡垒机 + kb-interactive MFA 资产被漏判,AI exec 走普通通道被服务端拒绝(Channel send error)。改为只认 kb-interactive 启用,直连与跳板两种形态都走「带 pty 选机器」路径;菜单为空(普通 MFA 服务器无选机器菜单)时跳过选机器直接执行命令。
- 🔧 移除 `linux-legacy-2204.yml`(Ubuntu 22.04 / glibc 2.35 无截图兼容版构建),后续 Release 不再附 `-ubuntu2204` 包。

> 最近 3 个版本（完整演进见 [CHANGELOG.md](./CHANGELOG.md)）。

---

## 技术栈

| 层级 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 + Rust (tokio 异步) | 多窗口、权限、Updater、Sidecar 管理、`HostBridgeState` 共享桥 |
| 工作台 | React + DeepSeek Harness | `starhub-window` React 入口；DSH 主壳承载设置、资产、SSH 浏览器、SFTP、AI |
| 构建 | Vite 5 + TypeScript 5（`strict`、`exactOptionalPropertyTypes`） | `build:window` 产物 `dist-starhub-react/` |
| 终端 | xterm.js 6 + ZMODEM.js | 终端渲染与文件传输协议；OSC 7 + `pwd` cwd 跟踪 + 隐藏回显过滤 |
| SQL 编辑 | CodeMirror 6 | `@codemirror/state/view/lang-sql/autocomplete/commands`，MySQL/PG 方言高亮 |
| 表格 / Excel | Univer Sheets 0.25.1 (vendor) | 结果网格与 Excel 工具（Sidecar `excelize` 协同） |
| 数据库 Sidecar | Go 1.25+ stdio JSON-RPC | 8 类适配器、连接池、流式数据、Excel 直写 |
| SSH / SFTP | `russh` 0.62 + `russh-sftp` 2 | SSH 客户端、SFTP 客户端，`exec_id` 可中断 |
| 持久化 | sqlx (SQLite) + FTS5 | 本地资产/配置、会话存档全文检索 |
| 加密 | aes-gcm + argon2 + keyring-rs | 敏感数据 + 系统 Keyring 跨平台封装 |
| Web 网关 | `tokio-rustls`（ring provider）+ `webpki-roots` | SSH direct-tcpip 之上的端到端 TLS |
| 系统监控 | sysinfo | 资源/进程指标 |
| AI 协议 | OpenAI 兼容（GPT / Claude / DeepSeek / Ollama 等） | 流式输出 + Function Calling + stdio JSON-RPC 桥 |
| MCP | stdio / Streamable HTTP / SSE | 动态挂载外部 tools |
| 自动更新 | `tauri-plugin-updater` 2 + GitHub Releases | latest.json + 签名 |

UI 约定遵循 DeepSeek Harness 既有组件、图标与样式（`--dsw-*` token），跨数据库 / SSH / Docker / AI 工作台保持视觉、交互与快捷键一致。详见 [AGENTS.md § 4.4](./AGENTS.md)。

---

## 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl/Command + K` | 聚焦顶部资产搜索 |
| `Ctrl/Command + P` | 打开全局命令面板 |
| `Ctrl/Command + B` | 折叠 / 展开侧边栏 |
| `Ctrl/Command + Shift + B` | 折叠 / 展开右侧面板 |
| `Ctrl/Command + W` | 关闭当前标签 |
| `Ctrl/Command + J` | 打开 AI 聊天 |
| `Ctrl/Command + ,` | 打开设置 |
| `Ctrl/Command + S` | 数据库表格批量保存（编辑模式下）/ 工作区文件保存 |
| `Enter` | 执行当前聚焦操作或终端输入 |
| `Mod-Enter`（SQL 编辑器） | 执行当前 SQL |
| `Shift-Mod-E`（SQL 编辑器） | EXPLAIN 当前 SQL |
| `Ctrl + Enter`（终端） | 多行输入换行 |

---

## 开发运行

> 前置：Node 18+（建议 20 LTS）、Rust 1.78+、Go 1.25+、pnpm 9+。Windows 用户需要 MSVC 构建环境；macOS / Linux 用户需要 WebKitGTK / GTK 依赖（参见 Tauri 官方前置）。

```bash
# 克隆与安装
git clone https://github.com/dabaicai001/star-dsh-desktop.git
cd starhub
npm install
pnpm --dir vendor/deepseek-harness install   # DSH 主壳依赖

# 完整桌面开发
# scripts/dev-dsh-shell.mjs 启动 DSH 主壳 →
# sidecar:build 构建 Go Sidecar →
# build:window 构建 React 工作台 →
# tauri dev 启动桌面壳并加载 127.0.0.1:3185(开发实例端口;正式实例 3085)
npm run tauri:dev

# 单独构建 React 资产工作台（输出 dist-starhub-react/，由 Tauri resources 打包）
npm run build:window

# Node 纯逻辑测试
npm run test:utils         # crypto / ddlGenerator / sqlHistory / commandGuard / sqlTables / xshellQuickCommand / aiMention / aiCompaction
npm run test:ai-context
npm run test:ai-scroll
npm run test:ai-steering
npm run test:ssh-prompt
npm run test:terminal-cwd
npm run test:ssh-bg
npm run test:memory-guard
npm run test:ai-memory-review

# Rust 主进程（scripts/cargo-env.bat 加载 MSVC 环境，vcvars64.bat 路径取 STARHUB_VCVARS 环境变量，缺省回退 D:\c++1）
npm run cargo:check
npm run cargo:test

# Go Sidecar（自动处理 GOOS/GOARCH 与 rsrc；二进制名固定 starhub-sidecar[.exe]）
npm run sidecar:build           # debug
npm run sidecar:build:release   # release（-ldflags "-s -w"）

# 打包 DeepSeek Harness runtime（前端 dsh-web-frontend 必走 build:lib + build:web）
npm run package:dsh-runtime
```

---

## 打包

```bash
# 当前平台打包（自动跑 beforeBuildCommand：sidecar:build:release + build:window + package:dsh-runtime + cargo build --release + 平台打包器）
npm run tauri:build
```

Tauri 打包前置流程（`src-tauri/tauri.conf.json` 的 `beforeBuildCommand` 已编排）：

1. `npm run sidecar:build:release` — Go Sidecar release 编译（产物 `sidecar/bin/starhub-sidecar[.exe]`）
2. `npm run build:window` — React 工作台 production build（输出 `dist-starhub-react/`）
3. `npm run package:dsh-runtime` — 打包 DeepSeek Harness runtime（含 dsh-web-frontend dist + 8 个本地 starhub 包 junction + 悬空链接清扫 + node_modules `.d.ts/.map` 裁剪）
4. `cargo build --release` — Rust 主进程编译
5. NSIS / MSI（Windows）、`.dmg` / `.app`（macOS）、DEB / RPM / AppImage（Linux）打包

### Windows 产物

| 文件 | 路径 | 用途 |
|---|---|---|
| MSI 安装包 | `src-tauri/target/release/bundle/msi/StarHub_<version>_x64_en-US.msi` | 企业部署 |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/StarHub_<version>_x64-setup.exe` | 双击安装 |
| 单文件可执行 | `src-tauri/target/release/starhub.exe` | 绿色版，免安装 |
| Go Sidecar | `sidecar/bin/starhub-sidecar.exe` | 数据库代理进程（`externalBin` 注入主安装包） |

> Windows CI 把工作区 `subst` 到短盘符 `S:\` 以规避 checkout + pnpm deploy 嵌套 node_modules 的 260 字符路径上限（NSIS `File /r` 中断）；`package-dsh-runtime.ts` 组装后裁剪 `node_modules/**/*.{d.ts,d.ts.map,js.map}` 进一步压路径。

### Linux 产物（ubuntu-24.04 基线,glibc 2.39）

| 文件 | 路径 | 用途 |
|---|---|---|
| DEB 安装包 | `src-tauri/target/release/bundle/deb/StarHub_<version>_{amd64,arm64}.deb` | Debian/Ubuntu 24.04+，通过 APT 安装并解析依赖 |
| RPM 安装包 | `src-tauri/target/release/bundle/rpm/StarHub-<version>-1.{x86_64,aarch64}.rpm` | glibc 2.39+ RPM 系，通过 DNF 安装并解析依赖 |
| AppImage | `src-tauri/target/release/bundle/appimage/StarHub_<version>_{amd64,aarch64}.AppImage` | 主流 glibc 桌面通用版，内置 WebKitGTK/GTK/sidecar |

> Linux 默认包在 Ubuntu 24.04 对应架构的原生环境构建，确保 glibc 2.39 兼容下限；**截图功能依赖系统 PipeWire ≥ 1.0（Ubuntu 24.04 及以上）**——旧系统（如 Ubuntu 22.04 的 PipeWire 0.3.48）上点击截图会提示升级；AppImage 不允许交叉编译。CI 使用 `ubuntu-24.04` 与 `ubuntu-24.04-arm` runner，完成后执行 `bash scripts/verify-linux-bundles.sh`。

#### Ubuntu 22.04 / glibc 2.35 兼容版（无截图）

| 文件 | 说明 |
|---|---|
| `StarHub_<version>-ubuntu2204_amd64.deb` / `StarHub-<version>-1-ubuntu2204.x86_64.rpm` | 面向 Ubuntu 22.04 / Debian 12 / Fedora 38+ 等 **glibc 2.35+ 且 PipeWire < 1.0** 的旧桌面发行版 |

> 兼容版在 `ubuntu-22.04` 原生 runner 上以 `--no-default-features`（关闭 `screenshot` 特性）构建：不引入 xcap → pipewire/libspa 0.10.1 截图链，因此 glibc 下限保持 **2.35**，可在 Ubuntu 22.04 上直接安装运行。**代价是内置 AI 对话的「区域截图」功能在本版不可用**（点击剪刀按钮会提示当前版本未编译截图功能）；其余功能与默认版一致。由 `linux-legacy-2204.yml` 随 tag 构建并附到同一 Release（文件名带 `-ubuntu2204` 后缀，与 glibc 2.39 默认包区分）。

---

## 刷新品牌图标

仓库 `scripts/refresh-icons.ps1` 会从单一源图（默认 `icons/app-icon-v6/02-star-chevron-s.png`）重新生成 Tauri `bundle.icon` 全部打包图标与 README 顶图，**无外部图像库依赖**（使用 .NET `System.Drawing`，对 PNG-in-ICO 直接写 ICONDIR 头）：

```powershell
# Windows PowerShell 5.1+
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/refresh-icons.ps1 `
  -RepoRoot .
```

输出：`src-tauri/icons/{icon.png, 32x32.png, 128x128.png, 128x128@2x.png, icon.ico}` 与 `docs/assets/starhub-logo.png`。SVG / `.icns` / iOS / Android 子目录保持原状，分别需要专用工具链。

---

## 文档

| 文档 | 链接 | 说明 |
|---|---|---|
| 技术方案 | [docs/技术方案.md](./docs/技术方案.md) | 完整技术细节、280+ 子功能矩阵 |
| 架构图 | [docs/架构图.html](./docs/架构图.html) | 可视化架构图 |
| 设计系统 | [docs/设计系统.md](./docs/设计系统.md) | token / 组件类 / 反模式 |
| 已知坑索引 | [docs/已知坑索引.md](./docs/已知坑索引.md) | 已知坑主题索引 |
| 踩坑记录 | [docs/踩坑记录.md](./docs/踩坑记录.md) | 已知坑详细内容 |
| 更新日志 | [CHANGELOG.md](./CHANGELOG.md) | 版本演进 |
| Agent 协作指引 | [AGENTS.md](./AGENTS.md) | AI Agent / 人类贡献者快速上手 |
| 打包配置 | [src-tauri/tauri.conf.json](./src-tauri/tauri.conf.json) | Tauri 2 配置 |

---

## 路线图

| 阶段 | 状态 | 重点 |
|---|---|---|
| v0.18.x ~ v0.32.x | ✅ 完成 | PostgreSQL、Kafka/NSQ、Univer 深度集成、SFTP 启动策略、Linux 跨发行版兼容、Docker 资产树 DB 化 |
| v0.40.x ~ v0.49.x | ✅ 完成 | 本地工作区、服务器网页访问（SSH Web 网关）、SFTP 暂停/继续、Xshell 快捷命令导入 |
| v0.50.x ~ v0.54.x | ✅ 完成 | AI 记忆系统三期（会话存档 FTS5 → 三级记忆卡 → 自动沉淀）、多模型配置与选择器、SFTP 跟随终端 |
| v0.55.x ~ v0.59.x | ✅ 完成 | AI 会话级模型独立、useAiChatHost 统一聊天编排、`@`/`#` mention、侧边栏 AI 聊天 + 记忆、本地工作区 VSCode 化重设计 |
| v0.70.x ~ v0.79.x | ✅ 完成 | 壳内 React 工作台化、Broker / Elasticsearch / Redis / 数据库 / SSH / SFTP 弹框化、Excel 退役、dsh 联动实施、dsh 审批体系接管命令白名单 |
| v0.81.x ~ v0.87.x | ✅ 完成 | DDL / 监控 Dashboard / SQL 编辑器 / 命令广播 / 网页访问 / 主壳 AI 面板批量化接入；DSH React 工作台迁移；MFA / hostkey 内联；品牌图标升级与 README 重写 |
| 下一步 | 📋 计划中 | Settings 代理与安全 tab、SQL 结果可编辑及无主键报错（转 K3）、Oracle / MongoDB 适配、国产库 ODBC 桥、CI/CD 流水线 |
| v1.0 | 🎯 目标 | 稳定版 GA、团队协作与企业能力 |

---

## 安全提示

- DB / SSH 密码、私钥和 AI API Key 应存入系统 Keyring（macOS Keychain / Windows Credential Manager / Linux Secret Service；无桌面密钥环时回退到会话级 Keyutils）
- AI 执行命令前会经过 dsh 权限 preset 与 starhub 域工具风险门；starhub_* 工具（SSH 写、数据库写、Redis 写、ES 写、SFTP 传输、MCP 调用、记忆写入等）恒需确认
- 危险命令、删除类操作和破坏性操作需要显式确认；180s 超时未应答按拒绝收口
- 生产环境连接请优先使用最小权限账号，定期轮换凭据
- ssh-keyscan hostkey 自动接受不持久化；MFA 一次性验证码不回写

---

## 贡献

仓库遵循 Conventional Commits 风格，AI Agent / 人类贡献者请先阅读 [AGENTS.md](./AGENTS.md)：

- 跨域改动需要协调（SSH / DB / AI 互相依赖）
- 安全 / 性能 / 架构决策先开 Issue 讨论
- 一次 commit 一个主题，工作区不允许长期挂着未提交改动
- 七处版本号（`package.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` / `CHANGELOG.md` / `AGENTS.md` / `README.md`）必须同步

---

## License

本项目基于 [MIT License](./LICENSE) 开源。

Copyright © 2026 StarHub Authors