# AI 内核替换方案:迁移至 deepseek-harness(dsh)

> 状态:**方案草案(部分实施)**——Phase 0/1/2 与主壳融合 P0~P5 已完成(v0.66.0);v0.79.0(2026-08-17)完成 P2-2~P2-5/P2-8/P3-2/P3-4/P3-5(内嵌 AI 助手六宿主全面迁移 dsh,审批统一走 dsh 权限体系,命令白名单移除),剩余 P2-1/P2-7/P3-1/P3-3/P3-6 见 `docs/AI内核替换-实施任务清单.md`
> 调研日期:2026-08-14
> 调研对象:
> - `deepseek-ai/deepseek-harness` master(fork: dabaicai001/deepseek-harness),版本 `0.1.0-rc.5`(developer preview)
> - `Small-tailqwq/dsh-deep-whale`(dsh 皮肤插件,maid-atelier)
> - dsh 插件生态:[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选索引(198 个插件)+ GitHub `topic:dsh-plugin`
> - dsh Web UI 设计系统(`packages/client/ui-theme`,token 三层 `--dsw-static/alias/specific`)
> - 本仓库 StarHub v0.62.3 现状代码

---

## 1. 背景与目标

StarHub 现有 AI 内核为**前端自研**:Pinia store(`src/stores/ai.ts`)实现 function-calling 循环、Planner→Executor 编排、上下文压缩、记忆沉淀;LLM 调用走浏览器 fetch 直连 OpenAI 兼容端点(SSE)。随着功能增多,自研内核在会话管理、重试、子代理、持久化等方面维护成本升高。

**目标**:

1. 将 AI 内核整体替换为 DeepSeek 官方 agent harness(`dsh`),LLM 循环、工具管线、会话持久化、重试、压缩等由 dsh 接管。
2. 将"本地工作区"能力(#LOCAL 及 # 多资产绑定)迁移到 dsh 的插件/工具体系上重建。
3. 评估 dsh 插件生态(`topic:dsh-plugin`,含 dsh-deep-whale 皮肤)对全工程的适配性(结论见第 8 章)。

**集成总原则(已拍板):代码拷贝 + 自行适配,不引用其 npm 包。**

- 把 dsh 需要的子集源码**拷入本仓库自行维护**(放 `vendor/deepseek-harness/`,与现有 `vendor/univer` 同模式;许可为 MIT,合规,需保留其 LICENSE 与版权声明),而不是依赖 `@deepseek-ai/dsh-*` npm 包。
- 只拷最小可用子集(core 脊柱 + llm + 适配器 + sdk protocol/server + 需要的工具包),**不拷** React Web UI、CLI、ACP、E2B 等无关部分;拷入后按 StarHub 需要直接改源码(审批桥、资产工具、Windows 打包都改自己的副本)。
- 好处:不受其 developer preview 破坏性变更与发版节奏影响(D6);Windows 打包、协议扩展(cancel/审批)可以直接改,不用绕开黑盒限制;裁剪后体积可控。
- 代价:上游 bugfix 需手动挑拣合入 —— 以"锁定一个上游 commit + 变更评审"的方式管理,与 vendor/univer 的治理方式一致。

---

## 2. deepseek-harness(dsh)调研摘要

### 2.1 是什么

- DeepSeek 官方开源的 **agent 内核/运行时**,命令名 `dsh`,口号 "everything is a plugin"。非聊天 UI 产品,而是可组合的 agent 运行时 + CLI / Web / SDK 入口。
- 全 TypeScript(ESM only,strict),pnpm monorepo(100+ 包),框架为 vendored Cordis 4.0.0-rc.7,要求 Node ^22.19 || >=24。
- 版本 `0.1.0-rc.5`,官方明确声明 **developer preview,存在破坏性变更**,无会话格式兼容承诺。

### 2.2 核心架构

- **插件模型**:一切皆插件(模型适配器、工具注册表、会话日志、agent loop 均可替换);组合单位为 profile / bundle。
- **事件溯源**:append-only `SessionEvent` 日志为单一事实源,硬不变量 "model-visible ⟺ logged"(进入模型请求的内容必须能从日志重建);fork/resume/持久化/遥测全部从事件流派生。
- **Turn flow**:`turn/start → step(一次模型请求 + 工具调用)×n → turn/end`,含 `agent/pre-step`、`tools/pre-execute` 等 waterfall 钩子。
- **工具注册**:`defineTool()` DSL 注册到 `ctx.tools`,注册即 Cordis effect,卸载自动撤销;执行管线含 pre-execute(allow/deny/ask)→ guards → execute → post-execute。
- **审批**:`ctx.approval` + `approval/request` waterfall,**fail-closed**(无 answerer = 拒绝);`ask_user_question` 走 `ctx.userQuestions` 接缝。
- **持久化**:`SessionPersistence` 抽象,JSONL / SQLite 双后端;崩溃恢复追加合成 `turn/end{reason:interrupted}`。
- **子代理 / 计划 / 后台任务**:subagent 注册表、plan mode、goal、todo、jobs、hooks、compaction 均有发货实现。
- **MCP**:`mcp-client` 把外部 MCP server 工具汇入同一注册表(与 StarHub 现有 `mcp.rs` 能力重叠)。

### 2.3 LLM 接入

- 接缝 `ctx.llm`(`LlmAdapter.stream()`),流协议为封闭联合 `StreamChunk`(text-delta / reasoning-delta / tool-call-delta / usage / finish 等)。
- 发货适配器:`llm-deepseek`(直连 DeepSeek 官方 API,依赖极轻)+ `llm-pi-ai`(多 provider,**支持任意 OpenAI 兼容端点**——StarHub 现有模型配置走这条路)。
- 凭证只存 `apiKeyEnv` 引用,每次请求解析;settings 热重载。
- 稳定错误码(AUTH/QUOTA/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED/EMPTY_RESPONSE)+ step 边界重试插件。

### 2.4 对外接口形态(集成面)

| 形态 | 说明 | 对 StarHub 的相关性 |
|---|---|---|
| **stdio JSON-RPC SDK** | 换行分隔 JSON-RPC 2.0;方法仅 3 个:`initialize` / `session/prompt` / `shutdown`;服务端→客户端通知:`session.event`(全量)、`session.status`、`subagent.*` | ★★★ 与现有 Go sidecar 模式同构,**推荐** |
| ACP server | JSON-RPC stdio,支持 `session/cancel`、`session/request_permission` | ★★ 备选(补 cancel 能力) |
| Web host | HTTP + 下行 WebSocket,React SPA | ★ UI 不可复用,协议层(Typert Remote)深度耦合其 monorepo 构建,不要走 |
| 库形态 | npm 包同进程嵌入 | ★ 要求宿主是 Node,不适合 Tauri |

**SDK 协议硬限制**:无 mid-turn cancel、无 per-session close、无 per-prompt result(放弃一个 turn = 杀运行时进程);无协议版本协商。

### 2.5 dsh 的 "workspace" ≠ StarHub 的 "workspace"

这是**最容易误读的一点**:

- dsh 的 `ctx.workspaceRegistry` 只是"用户工作目录的持久记录"(uuid ↔ canonical 目录路径),用于 GUI 会话分组,**对模型完全不可见**。
- dsh 没有"workspace 参数选择不同远程资产""多资产绑定"的概念。StarHub 的 `#SSH-x / #DB-y / #LOCAL` 绑定机制在 dsh 里没有对应物,**需要自行在 dsh 插件体系上重建**(见第 5 章)。

### 2.6 皮肤插件机制(dsh-deep-whale 验证)

dsh 的 Web UI 支持纯展示层客户端插件(覆盖 `--dsw-*` token + DOM 装饰 + 明暗双主题),`dsh plugin --profile web add <dir>` 装入即生效。该机制只对 dsh 自带 React UI 有效,与 StarHub 的 Vue 前端无关(详见第 8 章)。

---

## 3. StarHub 现状地图(替换影响面)

### 3.1 内核本体(必改)

| 文件 | 现状职责 |
|---|---|
| `src/stores/ai.ts`(2074 行) | runAgent 循环、Planner(`createExecutionPlan`)、`compactSessionNow`、记忆注入、会话持久化、settings |
| `src/services/ai.ts`(460 行) | LLM 传输层:`chatWithTools()` / `chatStream()`(SSE);旧 `chat()` 走 Tauri `ai_chat` |
| `src/composables/useAiChatHost.ts`(440 行) | 内嵌宿主编排(7 个宿主视图共用):mention、确认挂起、绑定 runtime 生命周期 |
| `src/views/AiView.vue`(1293 行) | 全局 AI 工作区:Planner→Executor、确认卡、引导 |

### 3.2 工具契约层(需适配为 dsh 工具)

- `src/utils/aiTools.ts`(1470 行):ssh_/db_/redis_/es_/docker_/excel_ + session_search/memory/skill_save,单一事实来源。
- `src/utils/aiSftpTools.ts`、`src/services/aiLocal.ts`(11 个 local_* 工具)、`src/services/mcp.ts`(mcp__* 发现/调用)。
- 执行器约定 `(call) => Promise<string>` + 挂起式确认(`ToolConfirmFn`)。

### 3.3 本地工作区现状

- **#LOCAL**:`src/services/aiLocal.ts` → Rust `commands/local.rs`(11 个 command);写操作 always-confirm。
- **#资产绑定**:`src/services/aiWorkspace.ts`(674 行)direct workspace runtime:`workspace` 参数路由、惰性连接、绑定集合变化重建、卸载关闭全部连接。
- Rust 能力层(`commands/local.rs` / `secret.rs` / `ai_memory.rs` / `mcp.rs` / SSH / SFTP / DB / Docker 各 command)与 Go sidecar(Excel/CSV)**可原样保留**,作为 dsh 工具的执行后端。
### 3.4 可退役

- `src-tauri/src/ai/mod.rs` + `src-tauri/src/commands/ai.rs`(旧非流式网关,主流程已不使用)。
- 前端 runAgent 循环、Planner、压缩、SSE 客户端(由 dsh 接管)。

---

## 4. 目标架构

### 4.1 总体形态:dsh 作为第三个 sidecar

```
┌───────────────────────────── StarHub (Tauri) ─────────────────────────────┐
│ Vue 前端                                                                   │
│  AiView / AiChat / 7 个宿主视图                                            │
│    │ 渲染 session.event 流;发出 prompt / 审批应答                           │
│    ▼                                                                       │
│ src/services/aiHarness.ts(新)— IPC 封装                                    │
│    │ Tauri IPC                                                             │
│    ▼                                                                       │
│ src-tauri/src/harness/(新)— Rust dsh 客户端                                │
│    · 管理 dsh 子进程(stdio JSON-RPC,3 方法 + 通知)                         │
│    · 事件流转发前端(session.event → Tauri event)                           │
│    · 审批桥:approval 请求 → 前端确认卡 → 应答                                │
│    ▼ stdio JSON-RPC                                                        │
│ dsh runtime(vendor 拷贝的适配副本,构建为单文件 exe 随应用打包)            │
│    · cordis.yml 组合:core 脊柱 + llm-deepseek/llm-pi-ai                    │
│    · starhub-tools 插件(新,TS):ssh_*/sftp_*/db_*/… 工具注册到 ctx.tools   │
│    · starhub-bridge 插件(新,TS):approval/userQuestions → SDK 自定义通知    │
│    ▼ 工具执行回调(JSON-RPC server→client 扩展请求,或直接内嵌)              │
│ Rust 能力层(原样复用):local_* / SSH / SFTP / DB / Docker / Keyring        │
│ Go sidecar(原样复用):Excel / CSV                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**选型理由**:

- StarHub 已有"宿主 ↔ stdio JSON-RPC sidecar"的成熟模式(Go sidecar),dsh SDK runtime 同构,Rust 侧客户端实现成本低。
- Vue 前端只碰协议层(session.event 全量流 + prompt),不耦合 dsh 的 React UI 与 Typert Remote。
- 工具执行仍回落到 Rust/Go 能力层,SSH/SFTP/DB/Docker/Excel 的成熟实现与确认语义(白名单、风险词、always-confirm)原样保留。

### 4.2 关键设计决策(实施前必须拍板)

| # | 决策点 | 背景 | 建议 |
|---|---|---|---|
| D1 | **取消语义** | SDK 协议无 mid-turn cancel;ACP 有 `session/cancel` | 走 ACP server 或库形态自包一层;"停止生成"是既有功能不能退化 |
| D2 | **Windows 运行时打包** | 官方单文件 exe 只出 Linux/macOS wheel,无 Windows | 自跑其 pkg 流程加 Windows target;备选:应用内置 Node runtime + 构建产物闭包。**这是最大工程风险,先做 POC 验证** |
| D3 | **审批桥** | fail-closed,无 answerer 全拒;SDK server→client request 是"死能力" | 自定义 notification + 新请求方法扩展协议,把 `approval/request` / `userQuestions` 桥到前端确认卡 |
| D4 | **多资产绑定重建** | dsh 无此概念 | 每个资产域一个 tool 包;绑定集合 = agent-scoped Cordis 插件(agent.ctx),绑定变化 = 插件 unload/reload(天然表达"重建 runtime");见第 5 章 |
| D5 | **注入内容的日志不变量** | model-visible ⟺ logged,自定义注入必须落 session event | 资产上下文/记忆块经 `agent.inject()` 或扩展 `SessionEventMap` 声明合并,禁止绕过日志直接改 messages |
| D6 | **代码获取方式(已拍板)** | 0.1.0-rc.5 developer preview,官方预告破坏性变更;npm 公开发布仅数日 | **源码拷入 `vendor/deepseek-harness/` 自维护,不依赖 npm 包**;锁定上游 commit `47f9438`,上游更新手动挑拣合入 |
| D7 | **MCP 归属** | dsh 自带 mcp-client;Rust 侧已有 `mcp.rs` | 二选一:推荐交给 dsh(工具进同一注册表),Rust `mcp.rs` 退役;或保留 Rust 经工具桥暴露 |
| D8 | **记忆/压缩/Planner 去留** | dsh 自带 compaction、plan mode、goal;StarHub 有三级记忆卡 + 压缩 + Planner | **记忆系统(三级记忆卡 + 会话注入 + 自动沉淀)确定保留**,迁移到 dsh 体系,见 5.3;压缩/计划切换 dsh 实现 |

### 4.3 LLM 配置映射

- StarHub 现有 `settings.models`(OpenAI 兼容 baseUrl + model + key)→ dsh `llm-pi-ai` 的 OpenAI 兼容 route(`api: openai-completions` + `baseURL`)。
- DeepSeek 官方端点可直接用 `llm-deepseek`(缓存命中记账、thinking 模式)。
- API key 仍存系统 Keyring,经环境变量注入 dsh 子进程(`apiKeyEnv` 引用),不出现在配置文件。

---

## 5. 本地工作区迁移设计(重点)

### 5.1 概念映射

| StarHub 现状 | dsh 目标形态 |
|---|---|
| `local_*` 工具(#LOCAL) | **方案 A(推荐)**:直接用 dsh 发货的 fs/bash 工具(read/write/edit/glob/grep/bash),会话 cwd 即本机工作区,能力比现有 11 个手写工具强得多;审批策略映射现有 always-confirm 白名单。**方案 B**:把 `commands/local.rs` 包成 dsh 工具,语义不变但保留两套实现 |
| #资产绑定(SSH/DB/Docker/Excel/Redis/ES) | 每域一个 dsh tool 包(`starhub-ssh-tools` 等),`defineTool` 注册,schema 从 `aiTools.ts` 平移;执行回调经桥层调 Rust/Go 能力 |
| `workspace` 参数路由(`resolveAsset`) | 保留为工具参数约定:绑定同类资产 >1 时 `workspace` required,省略自动选定;路由逻辑移入 tool 包的 execute |
| 绑定集合变化 → runtime 重建 | Cordis effect 天然支持:绑定 = agent 作用域插件,变化时 dispose 旧插件(关连接)→ 加载新插件 |
| 宿主内嵌 AI(useAiChatHost) | 每个宿主视图对应一个 dsh session,`SessionHeader.cwd` 可绑 LocalView 目录;宿主工具与绑定工具的同名冲突处理逻辑平移到工具注册层 |
| 连接生命周期(惰性连接、卸载关闭) | tool 包内部维护连接 Map(逻辑从 `aiWorkspace.ts` 平移),插件 dispose 时统一关闭 |

### 5.2 确认/安全语义迁移(不可退化项)

- 风险词硬拦截(`commandGuard`)、白名单、只读免确认、写操作 always-confirm、MCP always-confirm —— 全部映射到 dsh 的 `tools/pre-execute`(allow/deny/ask waterfall)+ `ctx.approval`。
- `approval/policy` per 会话 `'ask' | 'never'` 与 StarHub 的 session 白名单语义对齐。
- 审计:`approval/asked` / `approval/decided` 落日志(dsh 自带)。

### 5.3 记忆系统(确定保留)

现有三级记忆卡(user / global / asset:{id},SQLite + FTS5)+ 会话级记忆注入 + 压缩前 flush / 回合后 review 的自动沉淀,**整体保留**,只改注入通道与载体:

- **存储层不动**:`src-tauri/src/commands/ai_memory.rs`(SQLite/FTS5、`ai_memory_*` command)原样保留,dsh 工具经桥层调用;`src/services/aiMemory.ts` / `aiMemoryReview.ts` / `utils/memoryGuard.ts` 的安全扫描与确认闸语义平移。
- **注入通道切换**:现在由 `stores/ai.ts` 的 `loadMemoryBlock` 拼进 system prompt;迁移后改为经 `agent.inject()` 或扩展 `SessionEventMap` 落 session event(D5 不变量),每会话冻结一次的语义不变。
- **工具保留**:`memoryTools` / `skill_save` 平移为 dsh 工具(`defineTool` 注册),写操作仍走确认闸 + 审计。
- **自动沉淀保留**:压缩前 flush 与回合后 review 的 mini-loop 改为挂在 dsh 的 `agent/turn-stopping` / compaction 钩子上,门禁逻辑(`aiMemoryReviewGates.ts`)平移。

### 5.4 前端事件渲染

- 前端从 `session.event` 全量流重建消息列表(事件溯源模型),**不再维护增量消息缓存**;现有 `AiChat.vue` 的流式渲染改造为事件投影渲染。
- 确认卡状态机(`awaiting-confirm`)改由 `approval/request` 通知驱动。
- `@/#` mention、steering、用量指示、dsh 发货的 `session_search` 等能力可原位保留或切换。

---

## 6. 分阶段实施计划

### Phase 0:POC(风险验证,1 周内出结论)

0. 建立 `vendor/deepseek-harness/` 拷贝(D6):锁定上游 commit `47f9438`,裁出最小子集(core 脊柱 + llm + 适配器 + sdk protocol/server + 需要的工具包),保留其 LICENSE,跑通最小组合的构建。
1. Windows 上跑通 dsh runtime 单文件 exe 打包(D2);失败则验证"内置 Node + lib 闭包"备选。
2. Rust ↔ dsh stdio JSON-RPC 最小回路:`initialize` → `session/prompt` → 收 `session.event` → 前端渲染一条流式回复(参考实现:deepseek-harness-tui,Rust 直接讲 SDK JSON-RPC,见 8.3)。
3. 验证 cancel 方案(D1)与审批桥(D3)的技术可行性。

**Go/No-Go 门槛**:三者全部通过才进入 Phase 1;D2 失败且无备选 = 整体方案重议。

### Phase 1:全局 AiView 切换(单宿主试点)

- 新建 `src/services/aiHarness.ts` + `src-tauri/src/harness/`;AiView 切到 dsh 会话。
- 工具集:workspace 工具(starhub_list_capabilities 等)+ session_search + memory;不接资产绑定。
- Planner→Executor 切换 dsh plan mode / subagent 能力(D8)。
- 新内核直接替换旧内核:AiView 接入 dsh 会话的同时删除旧内核调用路径,不做 feature flag 并存,不留回退方案。

### Phase 2:本地工作区与资产绑定

- #LOCAL 切换 dsh fs/bash 工具(5.1 方案 A),LocalView 目录 = session cwd。
- starhub-ssh-tools 包(SSH/SFTP,含 hostkey 确认桥),SshTerminal 宿主切换。
- 依次:db/redis/es/docker/excel 各 tool 包 + 对应宿主视图;绑定集合的 agent-scoped 插件机制落地(D4)。

### Phase 3:收尾与退役

- 记忆卡系统接入(D5/D8);SettingsView AI tab 改造(模型配置 → dsh route);MCP 归并(D7)。
- 退役 `src/stores/ai.ts` 的 runAgent/Planner/压缩、`src/services/ai.ts`、`aiWorkspace.ts`、`aiLocal.ts`、Rust 旧 AI 网关。
- 测试补齐:桥层协议单测、工具 schema 快照测试、事件投影渲染测试;现有 `tests/ai-*.test.mjs` 按新架构重写。

---

## 7. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| Windows 无官方打包载体 | 高 | Phase 0 优先验证;备选内置 Node |
| developer preview 破坏性变更 | 高 | 锁版本 + vendor/fork;升级走回归 |
| SDK 协议无 cancel/session close | 中 | ACP 或库形态;兜底杀进程重启 runtime |
| 事件溯源重构前端渲染,工作量大 | 中 | 分阶段切换(按宿主逐个切,切一个删一个旧路径),不保留新旧并存 |
| 确认/安全语义迁移遗漏 | 中 | 5.2 清单逐项核对;commandGuard 逻辑平移并配测试 |
| 会话存档(SQLite FTS5)与 dsh 持久化双写 | 低 | 统一为 dsh 持久化 + 搜索工具桥,或保留存档仅作历史列表 |
| 体积:Node runtime + dsh 闭包进安装包 | 低 | ~~监控 7.4 性能目标~~ **已拍板(2026-08-14):不考虑体积**,SEA 单文件 exe(~172MB)可直接作 sidecar 分发 |

---

## 8. dsh 插件生态与皮肤适配结论

### 8.1 调研结果

- **性质**:dsh 官方形态的 Cordis 客户端皮肤插件(`@dsh-external/dsh-client-ui-skin-maid-atelier`,"深海女仆工坊"),纯展示层:覆盖 dsh 的 `--dsw-*` 设计 token + DOM 装饰(双女仆立绘、蕾丝帘、玻璃拟态面板、整屏插画背景),明暗双主题,data URI 内嵌素材,`dsh plugin add` 装入即生效。
- **耦合度**:高。2497 行 CSS 锚定 dsh 内部 DOM(181 处 CSS Modules 哈希类名子串匹配 + `--dsw-*` token),dsh 升级即可能碎;peer 只约束 cordis 版本,对 dsh web UI 无显式版本约束。
- **许可**:**CC BY-NC-SA 4.0,禁止商用**,且角色素材为三创衍生(有署名链)。StarHub 是 MIT 项目,直接引入素材会污染许可。

### 8.2 能否适配到 StarHub 全工程

**结论:皮肤类不做完整适配,策略是"风格导入 + 尽量适配"——只把设计语言中有价值的元素(配色数值、质感参数、动效手感)移植进 `cyber.css` token 体系,装饰层与素材不迁移。**

1. **技术上不可完整适配**:选择器全部锚定 dsh 的 React DOM 与 token 体系,对 Vue 3 + Vuetify 3 + `cyber.css` 的 StarHub 无意义,照搬等于重写——完整适配既不可能也无必要。
2. **许可上不可直接搬运**:NC(禁止商用)+ SA(相同方式共享)与 MIT 不兼容,素材与 CSS 成品均不应入库。
3. **风格上与 StarHub 定位冲突**:maid-atelier 是"华丽动漫装饰系"(整屏插画、立绘、蕾丝、蝴蝶结);StarHub 是"深海蓝黑暗色 + 低饱和青色高亮 + 等宽数字"的 Cyber Command Center(克制、工具向)。装饰层(整屏位图背景、立绘、蕾丝、Q 版 mascot)直接移植违反 `docs/设计系统.md` 的反模式约束,**不适配**。

**风格导入清单(尽量适配的部分,如确有需要,走 token 增补流程)**:

- 分层 token 组织(navy 梯度 / glass / shadow 分组、明暗双套值)——与 cyber.css `:root` 做法一致,可参考写法。
- 玻璃拟态质感参数(半透明面板 + `0 18px 54px rgba(15,30,72,.2)` 级大柔和投影)——可增强 `.cyber-panel` 层次。
- 柔金 `#c5a468` 作"次级强调色"的用法(仅边框/激活态/悬停)——若需暖色点缀,金+青成立。
- 缓动 `cubic-bezier(0.22,0.78,0.2,1)` + 500~620ms 动效手感;"运行状态扫光"动画思路可用于 AI thinking 状态。

落地路径:在 `src/styles/cyber.css` `:root` 增补少量 token → `.cyber-*` 组件类引用 → 同步 `docs/设计系统.md` + CHANGELOG。**不引入该仓库任何文件。**

### 8.3 dsh 插件生态(topic:dsh-plugin)整体适配性

调研范围:GitHub `topic:dsh-plugin` 约 1350 个仓库(噪音大,大量项目仅蹭标签);有效样本取社区精选索引 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)(198 个 `dsh plugin add` 可装插件,均声明 `dsh.bundle` manifest)。

**总体结论:运行时类插件大多可以适配(因为内核走 vendor 拷贝),UI/皮肤类插件不能适配。**

| 插件类别 | 代表 | 适配结论 |
|---|---|---|
| 工具/能力(Tools & Capabilities) | dsh-tool-* 系列、dsh-docker、dsh-excel-chat、dsh-data-agent、modlens(视觉桥) | ✅ 可拷入 vendor 副本直接加载或少量改写——它们就是 Cordis 插件 + `defineTool`,与我们自建 starhub-tools 同机制 |
| 记忆(Memory) | dsh-memento、dsh-mneme、dsh-memory | ⚠️ 机制可参考;StarHub 已拍板保留自有三级记忆卡(5.3),不引入 |
| 工作流/自动化(Workflow) | dsh-routines、dsh-loop、dsh-workflow、dsh-proof | ⚠️ 可选引入,逐个评审;与 Planner→Executor 替代方案(D8)有重叠 |
| 会话/消息(Sessions) | dsh-message-edit、dsh-share、dsh-chat-import | ⚠️ 部分有价值(message-edit 的分支编辑),需配合事件溯源模型评审 |
| 模型/Provider(Models) | dsh-llm-fallbacks、dsh-polyglot(OpenAI 兼容 + 自动 fallback)、dsh-codex-auth | ✅ 高价值,直接补齐多 provider/fallback 能力 |
| 开发/运行时(Dev & Runtime) | dsh-bash-terminal(Win PowerShell/Git Bash/WSL PTY)、dsh-tool-approval、dsh-gitflow、dsh-eval-harness(插件回归测试) | ✅ 高价值;`dsh-bash-terminal` 正好补 Windows shell 短板;`dsh-eval-harness` 可作迁移回归测试设施 |
| 通知/集成(Notifications) | telegram、微信/飞书桥 | ➖ 与 StarHub 桌面定位关系不大,暂不引入 |
| UI 增强 / 主题皮肤(UI / Themes / 娱乐) | maid-atelier、dsh-skin、dsh-genui、whale-girl 桌宠等 | ❌ 不做完整适配:全部锚定 dsh React DOM 与 `--dsw-*` token,对 Vue 前端无意义;只做"风格导入"(见 8.2),交互思路(如命令面板、状态栏)可参考后在 Vue 侧自实现 |
| 独立客户端(TUI/ACP) | dsh-TUI、**deepseek-harness-tui**(Rust/ratatui,直接讲 SDK JSON-RPC) | ➖ 本身不用,但后者是 **Rust 侧 dsh 客户端的现成参考实现**,Phase 0 应研读 |

**引入原则**:

1. 只引入运行时类插件,逐个评审:许可(优先 MIT/Apache;NC/无许可一律不引入)、依赖重量、对 dsh 内部 seam 的耦合点是否在我们裁剪的子集内。
2. 引入方式与内核一致——**源码拷入 vendor 自行维护**,不走 `dsh plugin add` / npm 依赖;加载机制(cordis patch / `dsh.bundle` manifest)在 vendor 副本中保留即可。
3. 生态极年轻(多数仓库创建仅数日,awesome 列表自带"安全性无保证"免责声明),默认不信任,引入前必读源码。
4. **用户自行引入:支持,作为 P2 能力,仅限运行时类插件,默认关闭。前端快捷导入,不要求用户手动操作目录。**(支线 B 已实现,2026-08-14,见实施任务清单)
   - **导入方式(Settings → 插件页,Vue 前端操作)**:
     - **插件市场(主路径)**:内嵌社区目录浏览——数据源用 awesome-dsh-plugin 的精选索引(纯数据、CC0;目录本体 `README.zh.md`,`data/npm-map.json` / `data/stars.json` 以 GitHub URL 为 key 补 stars/npm 名),Rust 侧 reqwest 拉 raw 文件解析,**解析/抓取失败降级为空目录或缓存(`plugins/market-cache.json`,带抓取时间),不报错**;按分类浏览/搜索,一键安装;UI/主题/皮肤/客户端/娱乐类分类在市场侧直接不收录;
     - **URL 导入**:粘贴 GitHub 仓库地址(可带 `/tree/<branch>`),reqwest 拉 `codeload.github.com` zip(分支顺序:指定 > main > master),也支持 zip 直链;`zip` crate 解包,`enclosed_name()` + 剥离后二次组件校验防 Zip Slip,剥掉 `<repo>-<branch>/` 顶层目录;
     - **本地导入**:系统文件选择器选本地文件夹/zip,复制进插件目录。
   - **安装管线(Rust 侧 `src-tauri/src/harness/plugins.rs`)**:拉取/复制到应用数据目录 `plugins/<id>/` → 校验 `dsh.bundle` manifest(**首版只支持零依赖插件**:`dependencies` 非空拒装;UI/皮肤类双保险拒装:manifest 含 `dsh.client` 或包名分段命中 skin/theme/client/ui;入口文件必须存在,不负责构建)→ **peer 依赖 junction**:`plugins/node_modules/@deepseek-ai/` 下为 cordis / cosmokit / schemastery 建指向 vendor 对应目录的 junction(Windows `mklink /J` 免管理员,失败回退整目录复制;vendor 根解析不到时安装明确报错)→ 首次启用弹**风险提示**(插件等同本机代码权限)→ 逐项启停写入 `plugins/cordis.yml`(entry 的 `disabled` 字段;该文件由本模块独占生成、单引号转义、禁止 `!!js`)→ 前端调 `dsh_shutdown` 重启 runtime 生效。
   - **管理**:已装列表(版本/来源/启停/许可 + "未审计"标记,目录被外部删除时标 missing)、卸载(移除目录 + 配置,重启复原);更新(重拉 + diff 提示)留作后续。
   - **加载机制落地(与调研假设的偏差,已实测)**:Cordis Include 插件是 tree carrier(`EntryGroup.key`),其 config 保持 literal,**`path` 字段不支持 `!!js` env 注入**;改为 Rust 在每次 spawn 前生成包装配置 `<app_data_dir>/dsh-cordis.generated.yml`(两条 `cordis:include` entry——app-boot 注册的内建插件,任何位置可引用:主组合指向 vendor 内 starhub-agent/cordis.yml,bare 包名仍在 vendor 树解析;用户插件清单带 `initial: []` 容忍文件缺失)。vendor 的 cordis.yml 本体零改动。
   - **坏插件自救**:boot 有 assertEntriesActivated,坏插件会让 initialize 整体失败;首版自救降级为**手动**——initialize 失败时引导用户去插件页禁用,自动禁用留 TODO(`harness/plugins.rs` 模块注释)。
   - 底层机制不变:vendor 副本保留 Cordis 的 profile patch / `dsh.bundle` manifest 加载机制,启用状态最终落在 runtime 的 cordis 配置上。
   - 与开发者 vendor 引入的关系:随应用打包的官方插件走本节前三条评审流程;用户导入的插件是运行时扩展,不进仓库、不受 StarHub 背书。
   - 落地阶段:作为并行支线(支线 B)于 Phase 1 期间完成,不阻塞主线。

---

## 9. 设计语言与前端改造方向:向 dsh 靠拢

> 取向已拍板:**保留深色主场,借 dsh 语言**。本节为方向性设计,具体落地按 `docs/设计系统.md` 流程另行排期。

### 9.1 dsh 设计语言摘要

token 源:`packages/client/ui-theme/src/styles/`(三层命名:`--dsw-static-*` 色板 / `--dsw-alias-*` 语义 / `--dsw-specific-*` 组件面),亮暗双主题经 `body[data-ds-dark-theme]` 切换。

**配色(关键值)**:

| 角色 | 亮 | 暗 |
|---|---|---|
| bg-base / 分层 | `#FFFFFF`(亮态不分层) | `#151517` / layer1~3 `#232324`→`#353638` |
| 中性灰(带蓝调) | neutral-bluish 50 `#F9FAFB` → 1000 `#0F1115` | 同色板 |
| **brand-primary(主按钮)** | **`#0F1115` 墨色(不是蓝!)** | `#F9FAFB` 白 |
| 功能蓝(进行中/功能动作) | `#4176E6` | `#679EFE` |
| 边框 hairline l1/l2 | `rgba(0,0,0,0.04/0.10)` | `rgba(255,255,255,0.06/0.12)` |
| 用户气泡 | `#EDF3FE` 淡品牌蓝 | `#2C2C2E` |
| 阴影 | lv1 `0 2px 4px rgba(0,0,0,.05)` ~ lv3(仅悬浮层),极克制 | 同 |

**字体**:系统字族栈;等宽 `'SF Mono','JetBrains Mono','Fira Code',Consolas`(故意不带裸 monospace 防 Windows CJK 回退);基准 14/16,梯度 xxs-11 ~ xl-24;数字 `tabular-nums`。

**布局与组件**:三列 AppFrame(sidebar 280px 可拖 / center ≥640 / details 360px),chat 内容轴 748px;胶囊按钮(h36 r18,primary 墨底白字,发送键蓝底白箭头);composer 卡 r22 + lv2 阴影;输入框 h32 r8 描边、focus 描边变墨色;菜单 r12 / 模态 r24;tooltip 深底无箭头。

**动效**:统一 `cubic-bezier(0.4,0,0.2,1)`,时长档 0.1/0.2(基准)/0.3s;turn 状态文字品牌蓝渐变 shimmer(1.8s);工具行 running 扫光(2.6s);全部有 `prefers-reduced-motion` 降级。滚动条契约:8px、thumb 圆角 4px、track 透明、抬升面重绑一档。

**一句话定位**:DeepSeek Chat 同源的"轻亮优先、扁平 + hairline 描边、极轻阴影、偏大圆角、蓝只用于功能动作"的现代产品风——与 StarHub 现状(深色主场、青色发光、重阴影)几乎是两个极端。

### 9.2 改造取舍(已拍板)

**保留(StarHub 基因)**:

- 深海蓝黑暗色基调(`--bg` 家族)与暗色主场定位;亮主题保留但同步重做。
- 青色高亮(`--cyan`)作为品牌/强调色,**承担 dsh "功能蓝"的角色**(进行中状态、功能动作、发送键)。
- 终端调色板(`--term-*`)、数据库域色(`--db-*`)、Excel 绿等域色不动。

**采纳(dsh 语言)**:

- **扁平化 + hairline 描边**替代发光/重阴影:`--glow-*` 与 `--shadow` 收敛为 dsh lv1~lv3 级别的克制阴影;层级靠灰阶面 + 描边而非投影。
- **胶囊按钮**(r18/999px)+ 圆角梯度:卡片 16~22px、菜单 12px、行/输入 8px、chip 4~6px。
- 字号梯度对齐 dsh(基准 14/16,梯度 11~24);等宽栈去掉裸 `monospace`;数字 `tabular-nums`。
- 动效收敛:0.2s 基准 + `cubic-bezier(0.4,0,0.2,1)`;AI thinking/工具 running 改用扫光/shimmer(青色版);补全 `prefers-reduced-motion` 降级。
- 滚动条契约:8px、圆角 thumb、透明 track、抬升面重绑。
- 边框改 hairline 语义:l1 分隔/l2 交互描边,透明度向 dsh 值靠拢。

**明确偏差(不照搬)**:

- 不采纳"墨色主按钮"——深色主场下墨色无意义,主按钮继续用青色系。
- 不采纳亮色优先——默认主题维持深色;亮主题按 dsh 暗色映射的思路重做但保持 StarHub 色温。
- 不引入任何 dsh 前端代码/CSS(技术栈不同),只移植 token 数值与组件特征。

### 9.3 token 映射表(方向性)

| cyber.css 现状 | dsh 启发的新值(暗色) | 说明 |
|---|---|---|
| `--shadow` / `--glow-*`(发光重阴影) | lv1 `0 2px 4px rgba(0,0,0,.3)` / lv2 `0 4px 12px …` / lv3 `0 12px 32px …`(暗态加深) | 发光仅保留启动页等仪式场景 |
| `--line` / `--line-2` | hairline `rgba(255,255,255,0.06)` / `0.12` | 由蓝灰色调改为中性白透明 |
| `--hover-cyan` / `--active-cyan` | `rgba(255,255,255,0.08)` / `0.14` 中性 + 青色留给功能动作 | hover 中性化是 dsh 的重要特征 |
| 按钮圆角(现状偏方) | 胶囊 999px / sm r14 | `.cyber-btn` 系列 |
| 面板/卡片圆角 | 16~22px 梯度 | composer 卡、模态 24px |
| 动效(现状不一) | `0.2s cubic-bezier(0.4,0,0.2,1)` 基准 | 全局统一 |
| AI thinking 状态 | 青色扫光/shimmer(2.6s/1.8s) | 替换现有脉冲 |

亮主题同表另出一套(向 dsh 亮色值靠拢、保持 StarHub 色温),落地时在 `docs/设计系统.md` 给出完整对照。

### 9.4 改造范围与顺序

按 AGENTS.md 设计系统流程执行(token → 组件类 → 使用方 → 同步 `docs/设计系统.md` → CHANGELOG → 7.3 真实浏览器 UI 回归):

- **D0 token 层**:重构 `src/styles/cyber.css` `:root` 双主题 token(9.3 映射表落地)。
- **D1 核心组件类**:`.cyber-*` 按钮/输入/面板/菜单/模态/滚动条。
- **D2 AI 界面**:AiChat 消息流、composer、工具行、确认卡——与内核迁移 Phase 1/2 协同(新渲染层直接按新语言写,避免二次改造)。
- **D3 全局面板**:设置、资产、传输、Docker 等其余视图。

与内核迁移**无强依赖**,D0/D1 可先行;D2 建议与内核切换同步做。

### 9.5 与 maid-atelier(8.2)的关系

本节即 8.2"风格导入"的具体化与升级:8.2 列的可选项(玻璃拟态质感、柔金次级强调、缓动手感)并入 9.2/9.3 统一决策——其中缓动与扫光思路已被 dsh 原生方案覆盖;玻璃拟态与柔金默认**不采纳**(与扁平化方向冲突),如未来需要再走 token 增补流程。

---

## 10. 附:调研工件

- dsh 浅克隆:`tmp/deepseek-harness/`(HEAD `47f9438`)
- dsh-deep-whale 浅克隆:`tmp/dsh-deep-whale/`(HEAD `19dbbfb`)
- dsh 高质量文档(迁移实施的日常参考):`tmp/deepseek-harness/docs/architecture.md`、`docs/subsystems/*`、`docs/tool-catalog.md`、`docs/capability-seams.md`
- 插件生态索引:[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)(198 个插件精选列表,CC0)

---

## 11. 附:Phase 0 POC 结论(2026-08-14,全部实测)

> 实验脚本与原始收发日志:`tmp/dsh-poc/`(`drive.mjs`、`transcript-basic.log`、`transcript-cancel.log`、`transcript-exe-basic.log`)。环境:便携 Node v24.19.0(`tmp/node24/`)+ pnpm 11.7.0;LLM 用 mock(`pnpm run mock:llm`),未跑真 API。

### 11.1 安装与构建

- `pnpm install` 成功(4m23s,237 个 workspace project);`npm run build:lib:host` 绿(47s)。
- 拷贝时剔除 `website/` 导致 `scripts/project-doc-site.ts` 编译错,修复:`tsconfig.host.json` exclude 两行(已 commit 进 vendor 副本)。

### 11.2 stdio 协议(已实测确认)

- 传输:NDJSON 一行一帧 JSON-RPC 2.0(`packages/sdk/protocol/src/transport.ts`);stdout 只走协议帧;未知方法回 `-32603`(注意不是 -32601)。
- 方法(仅 3 个):`initialize {cwd, provider, model, maxTokens?}` → `serverInfo`;`session/prompt {sessionId, contentBlocks}` → `{messageId}`(**未知 sessionId 惰性创建 session,无独立 create;返回值只是入队回执**);`shutdown` → `{}`。
- 通知:`session.event`(完整事件溯源信封 `{type, seq, time, data}`;流式 = 拼 `assistant/chunk` 的 `text-delta`;一轮结束权威信号 = `session.status` → `idle`,或 `turn/end{reason}`)、`subagent.started/finished`。
- 启动:`node packages/examples/jsonrpc-demo/lib/bin.js <cordis.yml>`(或 env `DSH_CORDIS_CONFIG`);LLM 走 env:`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`;组合(工具集/persona/持久化根/审批)全在 cordis.yml,参考 `examples/jsonrpc-agent/cordis.yml`(全)与 `python/sdk-runtime/.../runtime/cordis.yml`(最小)。

### 11.3 cancel(D1 最终结论)

**SDK 协议无 cancel**:`session/cancel` 回 -32603,慢速流式中实测取消后事件继续涌入;SIGTERM 杀进程有效。进程内 `Agent.cancel()` 存在(`packages/core/agent/src/runtime-types.ts:85`),ACP server 的 cancel 就是调它(`packages/acp/acp/src/index.ts:338-342`)——**给 SDK server 补一个 `session/cancel` case 是小补丁,列入 Phase 1**;在此之前 Rust 桥按「中断=杀进程重启 runtime」实现。

### 11.4 审批桥(D3 最终结论)

可介入。审批 seam = cordis 服务 `ctx.approval.request(req)`(`packages/interaction/user-approval/`),answerer 是 `approval/request` waterfall 监听器;无 answerer 时 fail closed。现成参考:`packages/acp/acp/src/index.ts:215-229` 把审批转成 ACP `session/request_permission`。SDK 传输层双向 request 已支持,**实施 = 自写一个 answerer 插件向 stdio 对端发 JSON-RPC request**(上游已预留此意图)。已知限制:审批请求不带工具参数、只有 one-shot 授权。同类 seam:`user-questions`(ask_user_question 工具)也需 provider 插件桥出。

### 11.5 exe 打包(D2 最终结论)

路线:上游 `scripts/build-exe-for-python-sdk.ts` + `@yao-pkg/pkg --sea`(上游只声明 linux/macos,Windows 已打 4 处补丁跑通:PLATFORMS 加 win、win32→win 映射、spawn 加 shell、产物名补 .exe)。**已产出 172MB win-x64 exe 并完整冒烟通过**(initialize→多轮流式→shutdown)。体积已拍板不设限。一键复跑稳定性遗留(不阻塞,Phase 1 固化进构建脚本):
1. 外层 `pnpm exec` 需 `--config.verify-deps-before-run=false`;**严禁设 CI=true**(会剪掉全部 devDependencies)。
2. `pnpm deploy --legacy` 会拆掉其他 workspace 包的 node_modules 链接 → exe 构建后必跟一次 `pnpm install --config.confirmModulesPurge=false`。
3. pkg 在 Refining 阶段偶发 `fetch failed`(网络抖动),且**失败运行会用 92.8MB 裸 node 坏产物覆盖好 exe**——用前必须实跑验证。

### 11.6 最小 package 子集(物理裁剪清单)

权威起点 = deploy 根 manifest `python/sdk-runtime/package.json`。建议保留:协议/启动(sdk-jsonrpc-server/demo、sdk-protocol、app-boot、cmdline)、vendored cordis 全家(cordis/loader/include/group/timer/cosmokit/schemastery)、核心(agent、agent-loop、agent-spine-demo、session、persistence-jsonl、checkpoint-policy、projection、scope、brand、tools、system-prompt、agent-instructions)、LLM(llm、llm-deepseek、llm-retry、token-meter、timeout、compaction-basic)、工具面(subprocess-local、shell、bash-local、tool-bash、fs 系、tool-fs、tool-str-replace-editor、tool-todo)、**审批/交互(user-approval、user-questions、tool-ask-user、permission-presets——现组合没有,必加)**、子代理(可选,subagent 系)。可裁:acp、hooks、workflow、jobs、web-search-*、llm-pi-ai、e2b、lsp、terminal、pwsh、session-sqlite、session-query、host、client、apps/web 整条 web 线。

### 11.7 坑清单(POC 新发现的,dsh 相关)

- **G-1 shutdown 后 0xC0000409**:完整跑过 LLM turn 的进程在 dispose 时触发 libuv 断言崩溃(node 与 exe 形态同现);**宿主以收到 shutdown 响应为完成信号,忽略退出码**。建议上游报 issue。
- **G-2** 拷源必须带 `website/` 或 exclude doc-site 脚本(已修)。
- **G-3 sessionId 持久化冲突**:同一 session root 下复用已存在 sessionId → `turn/end error id collision`;**StarHub 每轮必须生成全新 sessionId**。
- **G-4/G-5/G-6**:pnpm 11 deps-status 自爆 / deploy 拆链接 / pkg 坏产物覆盖,见 11.5。
- **G-8** mock 慢速流式只对 `slow_success` 行为生效;时序实验必须用它。
- **G-10** engines 卡 Node ^22.19||>=24,Rust 拉起 runtime 时要钉住便携 Node 或直接用 exe。


### 11.8 环境准备(新机器/重装)

`vendor/deepseek-harness` 的 `node_modules`(~1.4GB)与便携 Node 均不入库。换机器或重装后,dsh runtime 跑不起来的话按此恢复:

1. **便携 Node 24**(engines 要求 ^22.19 || >=24,系统 Node 22.14 不够):下载 `node-v24.19.0-win-x64.zip`(https://nodejs.org/dist/v24.19.0/)解压到 `tmp/node24/`,使用时 `export PATH="$PWD/tmp/node24:$PATH"`(Git Bash);Rust 侧缺省也会回退找 `<repo>/tmp/node24/node.exe`(可用 env `STARHUB_DSH_NODE` 覆盖)。
2. **pnpm 11.7.0**:便携 Node 自带 corepack,`corepack enable pnpm` 后会按 repo `packageManager` 字段自动拉取。
3. **安装依赖**:`cd vendor/deepseek-harness && pnpm install`(约 4 分钟;**不要设 CI=true**,见附录 G-4)。
4. **构建**:`npm run build:lib:host`(约 47 秒,产物在 `packages/*/lib/`)。
5. 验证:`cargo test harness`(mock LLM 端到端回路,无需 API key)。

同一份代码、同一台机器(如笔记本带回家)无需任何操作,开箱即用。

### 11.9 StarHub 本地补丁清单(vendor/deepseek-harness 内,上游同步时需重新施加)

> vendor 副本锁定上游 commit `47f9438`(D6)。以下是 StarHub 在副本上的全部本地修改,合入上游更新时逐条重新施加并回归 `cargo test harness`。

**P0(打包/构建修复)**:

1. `scripts/build-exe-for-python-sdk.ts` 4 处 Windows 打包补丁:`PLATFORMS` 加 `win`、`process.platform` win32→win 映射、spawn pnpm 加 `shell: true`、产物名补 `.exe`(附录 11.5)。
2. `tsconfig.host.json` `exclude` 两行:剔除因拷贝时裁掉 `website/` 而编译失败的 doc-site 脚本(G-2)。

**P1-4(工具桥,2026-08-14)**:

3. `packages/sdk/server/src/index.ts`:`apply()` 里把私有 transport 以 `ctx.provide('sdk-transport', transport)` 暴露为可选服务,供同组合的 starhub-tools 插件发起 server→client 双向 request(方法 `starhub/tool.execute`,参数 `{ name, args }`,result 为模型可读文本);生命周期跟随插件 fiber。同时实例化 `SdkNotificationDispatcher` 并 `ctx.provide('sdk-notifications', …)` + `transport.onNotification` 接线(入站 notification 按 method 多路分发)。**2026-08-25 的 rc.2 整树同步曾把本条冲掉(approval-bridge 等消费方全部 `ctx.get` 落空、dsh web 进程崩溃),v0.96.5 已重施(见 `docs/DSH升级适配清单-v0.1.1-rc2.md` 第五节);后续每次整树替换后必须重放本条。**
4. 新增本地包 `packages/starhub/tools/`(`@deepseek-ai/dsh-starhub-tools`,`private: true`,不在上游):注册 `starhub_list_capabilities` / `starhub_list_assets` / `session_search` / `memory` 四个工具,`execute` 经 `sdk-transport` 桥回 Rust 主进程(`src-tauri/src/harness/tools.rs` 执行);缺 `sdk-transport` 时加载即 fail loud。配套登记:`tsconfig.host.json` references、`tsconfig.base.json` 的 `dsh-*` paths 通配组、`examples/package.json` 依赖、`examples/starhub-agent/cordis.yml` 插件条目(排在 sdk-jsonrpc-server 之后)。

**v0.83.2(web 启动鲁棒性,2026-08-18)**:

5. `packages/client/modules/src/client/system.ts`:`defaultLoadBundle` 拆出单次抓取 `fetchBundle` 并按 `BUNDLE_RETRY_DELAYS`(300ms / 1200ms)做有界退避重试——安装版启动时 webview 请求插件 bundle 可能撞上 dsh web 进程更替/文件瞬时不读的窗口,首次 `error` 事件即永久拒启动("Failed to load plugins" 点名某个插件,重启即恢复);重试后瞬态失败自愈,真正缺失的 bundle 仍在 3 次尝试后以原报错 fail loud。`manifest.ts` 的 `loadBundle` seam 契约同步注明默认实现带重试。配套:Agent Note `.agents/notes/implemented/bug-fix/2026-08-18-client-bundle-load-retry.md`(三件套)、`loader.client.spec.ts` 重试成功/耗尽两用例。**2026-08-25 的 rc.2 整树同步曾把本条冲掉,v0.96.5 已在 rc.2 源码上重施(见 `docs/DSH升级适配清单-v0.1.1-rc2.md` 第五节);后续每次整树替换后必须重放本条。**

**v0.96.5(启动永久失败的持久状态自愈,2026-08-26)**:

6. `packages/boot/app-boot/src/profile.ts`:`ensureSymlink` 对 `$DSH_HOME/profiles/node_modules` 下**非符号链接条目**(真实目录/文件)由「fail-loud 抛错」改为「**隔离备份 + 重建 junction**」——真实目录改名为 `<name>.dshbak-<timestamp>`(不删除,数据保留)后重建链接;隔离或重建失败仍抛错兜底。背景:真实目录污染(旧版本复制回退残留 / 杀毒或云同步把 junction 解引用成普通目录 / 中断安装)持久存在于 DSH_HOME,上游 fail-loud 让 dsh web 进程启动即退出,GUI 报「failed to import loader entry … client-modules: bundle script … failed to load」,且**换回任何老版本都在同一处崩溃**(污染不随版本回退消失,清理 AppData 前无法自愈)。配套:`profile.spec.ts` 原「real directory 抛错」用例改为「隔离 + 重建 + 数据保留 + 不重复备份」自愈断言,app-boot 106 例全绿。**后续每次整树替换后必须重放本条(升级适配清单第五节第 6 条)。**
