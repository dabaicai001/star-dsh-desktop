# StarHub AI 记忆系统方案

> 版本:v0.50.2 · 状态:设计待实施
> 参考对象:[Hermes Agent 记忆系统](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)(NousResearch 开源 Agent,四层记忆架构)

---

## 1. 背景与现状

### 1.1 问题

StarHub AI 助手目前**没有任何跨会话记忆能力**:

- 对话完整状态(含 tool 调用流水、执行计划、# 资产绑定、steer 队列)只存在于 tab 内存,关 tab / 重启即丢
- localStorage `ai-sessions-v1` 仅持久化压缩后的 user/assistant 文本(30 会话 × 60 条 × 12 万字符上限,单条截 1.2 万字符),tool 消息不落盘
- `conversationSummaries` 摘要只用于 UI 展示,不回注给 LLM
- 会话粒度绑死在 tab instanceId 上,没有独立的会话实体(无历史列表 / 切换 / 搜索)
- `runAgent()` 每步全量回发历史,没有 token 预算 / 滑窗截断

### 1.2 设计参考:Hermes Agent 四层记忆

Hermes 的核心思想:**不是"记住一切",而是分层 + 架构决定访问方式**——热记忆永远在上下文里,冷记忆按需检索,互不污染。

| 层 | 载体 | 访问方式 | 预算 |
|---|---|---|---|
| L1 提示词记忆(热) | MEMORY.md(Agent 笔记,2200 字符)+ USER.md(用户画像,1375 字符) | 会话开始注入 system prompt,冻结快照 | 固定 ~1300 token |
| L2 会话存档(冷) | SQLite + FTS5 全文索引 | Agent 显式调 `session_search` 工具才查 | 无限,按需 ~20ms |
| L3 技能(程序性记忆) | skills/ 下的 SKILL.md | 任务完成后沉淀,复用时检索 | — |
| L4 外部 provider | Honcho / Mem0 等插件 | 可选,叠加在内置层之上 | — |

值得直接借鉴的工程细节:

1. **memory 工具只有三个动作**:`add` / `replace` / `remove`,无 `read`(内容本来就在 system prompt 里);`replace` / `remove` 用短唯一子串匹配,匹配多条则报错要求更精确
2. **硬字符上限,拒绝写入而非静默压缩**:写入超限时工具返回错误(附当前全部条目),逼 Agent 当轮自己合并 / 删除后重试
3. **容量可见**:system prompt 记忆块头部显示用量 `[67% — 1,474/2,200 chars]`,Agent 自己感知容量
4. **冻结快照保 prefix cache**:会话中写入立即落盘,但本会话 system prompt 不变,下一会话生效
5. **写入前安全扫描**:记忆会进 system prompt,条目先扫注入 / 凭据外泄模式与隐形 Unicode,命中拒收
6. **压缩前记忆冲刷(memory flush)**:长对话压缩前,先触发一次只能调 memory 工具的独立 LLM 调用,把在途重要事实先落库
7. **write_approval 闸门**:可配置写入需用户批准;后台自动写入进 staging 区待审
8. **后台自我改进 review**:每轮结束后 replay 对话,自动沉淀记忆与技能(可切便宜模型)
9. **存 / 不存清单写进 prompt**:用户偏好、环境事实、纠正、约定、完成的工作 → 存;琐碎信息、可重新搜索的事实、原始数据、会话临时态 → 不存

---

## 2. 总体设计

一句话原则:**小而热、大而冷、Agent 自己策展、用户有否决权**。全部本地、可审计、工程轻量。

### 2.1 StarHub 对 Hermes 的关键改造:资产作用域

Hermes 是单 agent 单 home,记忆全局一份。**StarHub 是多资产运维工具,必须加作用域维度**:

- `user` 卡 —— 用户偏好、沟通风格(对应 USER.md)
- `global` 卡 —— 跨资产的环境事实、工作方式(对应 MEMORY.md)
- `asset:{assetId}` 卡 —— **StarHub 的差异化能力**:"10.0.3.5 是生产库,DDL 前必须先备份""staging SSH 端口 2222"。当前会话通过 # 绑定资产时,该资产卡一并注入

### 2.2 明确不抄的部分

- L4 外部 provider 体系(运维桌面应用无必要)
- journey 时间线可视化(Settings 里做记忆管理列表即可)
- MD 文件存储(Hermes 是 CLI 工具、用户手改文件;StarHub 是桌面应用,用 SQLite + 管理 UI)

### 2.3 架构落点

Rust 侧 `ai_chat` 是遗留通道(不支持 tools / 流式),新链路全部在前端(`src/services/ai.ts` 的 `chatWithTools` / `chatStream`)。因此记忆系统的**读写、注入、裁剪全部在前端编排层**:

- **读**:`runAgent()`(`src/stores/ai.ts`)组装上下文时拼入记忆块;`session_search` 作为工具按需查
- **写**:消息落库挂在 `runAgent` 的消息 push 处;memory 工具走 `src/utils/aiTools.ts` 的新工具定义
- **存储通道**:照 `src-tauri/src/commands/db.rs` 模式新增 Tauri commands,前端 `src/services/` 加封装

---

## 3. 详细设计

### 3.1 L2 冷记忆:会话存档(基础设施,先做)

#### 表结构(`src-tauri/src/db/schema.rs` 新增)

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT,               -- 绑定的资产,可为空(全局会话)
  asset_type  TEXT,
  title       TEXT,               -- 首条用户消息截断生成,可改
  summary     TEXT,               -- 会话摘要(第三期自动生成)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,  -- user / assistant / tool
  content         TEXT,
  tool_calls_json TEXT,           -- tool 调用的结构化数据
  created_at      INTEGER NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content='messages', content_rowid='rowid'
);
```

#### `session_search` 工具(前端 `src/utils/aiTools.ts`)

照 Hermes 的三种调用形态:

- **discovery**:`session_search(query, limit)` → FTS5 检索,返回命中消息 + 会话元信息
- **scroll**:`session_search(conversation_id, before/after message_id)` → 在命中会话内前后翻页
- **browse**:`session_search(conversation_id)` → 浏览整个会话

落库后,现有 localStorage `ai-sessions-v1` 压缩方案退役(它本是容量妥协产物),`compactPersistedMessages()` 的取舍逻辑(默认只存 user/assistant 文本)保留为落库默认策略,tool 输出是否入库做成设置项。

#### 上下文 token 预算(前置依赖)

`runAgent()` 目前全量回发 `snapshotChatMessages()`,无任何截断。加记忆后上下文只会更长,必须同期加上:

- 按 `settings.maxTokens` 反推历史预算
- 滑窗策略:system prompt + 记忆块 + 近期 N 条原文 + 更早历史的滚动摘要
- 触发压缩前执行 memory flush(见 3.4)

### 3.2 L1 热记忆:三级记忆卡

#### 表结构

```sql
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,        -- 'user' | 'global' | 'asset:{assetId}'
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

每个 scope 一张"卡"(该 scope 下所有条目拼接),字符上限:

| 卡 | 上限 | 典型条数 |
|---|---|---|
| user | 1375 字符 | 5–10 条 |
| global | 2200 字符 | 8–15 条 |
| asset:{id} | 1375 字符 | 5–10 条 |

#### system prompt 注入格式(照 Hermes)

```
══════════════════════════════════════════════
MEMORY (global) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
生产 MySQL 主库 10.0.3.5:3306,执行 DDL 前必须先在 #备份 库跑 mysqldump
§
所有 Linux 服务器统一 Debian 12,sudo 免密已配置
§
2026-07-20 已完成 order 库从 MySQL 5.7 到 8.0 的迁移
```

- 条目间用 `§` 分隔,条目可多行
- 头部显示容量用量,Agent 据此自主策展(>80% 先合并再新增)
- **冻结快照**:会话开始时注入一次,会话中写入立即落库但 system prompt 不变,下一会话生效(保 prefix cache)
- 注入哪些卡:`user` + `global` 恒注入;会话 # 绑定资产时追加对应 `asset:{id}` 卡

#### `memory` 工具(三个动作,无 read)

```ts
memory(action: 'add' | 'replace' | 'remove',
       target: 'user' | 'global' | 'asset',
       content?: string,      // add / replace 的新内容
       old_text?: string)     // replace / remove 的唯一子串
```

- `replace` / `remove` 用短唯一子串匹配;匹配多条 → 报错要求更精确
- 超限 → 报错并附当前全部条目,Agent 当轮合并 / 删除后重试
- 精确去重:完全相同条目拒绝重复添加
- `target: 'asset'` 时作用于当前会话绑定的资产;未绑定 → 报错提示先 # 绑定

#### 写入前安全扫描(必做)

记忆进 system prompt,且运维对话天然含敏感信息。写入前扫描:

- prompt 注入模式(伪造 system 指令、角色覆写)
- 凭据外泄模式(密码 / 私钥 / token 字面量)
- 隐形 Unicode 字符
- 命中即拒收并在工具响应中说明原因

#### 存 / 不存清单(写进 system prompt,引导 Agent 策展)

**主动存**:用户偏好、环境事实(系统 / 端口 / 拓扑)、纠正("别用 sudo,用户在 docker 组")、项目约定、完成的工作("2026-08-11 已把 X 库迁移到 Y")、显式"记住"请求
**不存**:琐碎模糊信息、可重新查到的事实、原始数据(日志 / 大段代码)、会话临时态(临时路径、一次性调试上下文)

### 3.3 写入闸门与记忆管理 UI

复用现有**工作区内嵌确认卡**(commandGuard 的 `confirmFn` 交互),不新建交互范式:

- 默认自动写入,聊天中显示一条轻量通知:"💾 已记住:staging SSH 端口 2222"(对应 Hermes 的 `memory_notifications`)
- Settings → AI 区块新增开关"记忆写入需确认":开启后写入走确认卡
- Settings 新增"AI 记忆"管理区块:按 scope 分组列出全部条目,可查看 / 编辑 / 删除;记忆增删写进 `audit_log`

### 3.4 后台 review 与 memory flush(第三期)

- **memory flush**:上下文触发压缩前,先发起一次只能调 memory 工具的独立 LLM 调用,把在途重要事实落库后再压缩
- **后台 review**:每轮对话结束后 replay 对话,自动沉淀记忆与技能;依赖 token 预算机制先落地(否则 review 成本不可控),写入同样受确认闸约束

### 3.5 L3 技能

现有 `settings.customSkills` / `enabledSkillIds` 已是雏形,后续与记忆系统打通:任务完成后由后台 review 沉淀可复用技能,检索注入方式与记忆卡一致。本期不动。

---

## 4. 与现有模块的映射

| 模块 | 文件 | 改动 |
|---|---|---|
| SQLite schema | `src-tauri/src/db/schema.rs` | 新增 `conversations` / `messages` / `messages_fts` / `memories` |
| Tauri commands | `src-tauri/src/commands/` | 新增 `memory_*` / `conversation_*` commands(照 `db.rs` 模式) |
| IPC 封装 | `src/services/` | 新增 `aiMemory.ts`(conversation / memory / search 封装) |
| 工具定义 | `src/utils/aiTools.ts` | 新增 `memoryTool`、`sessionSearchTool` 及执行器 |
| 会话 store | `src/stores/ai.ts` | `runAgent` 消息落库、记忆块注入、token 预算裁剪;conversation 实体化(脱离 tab instanceId 绑定) |
| 安全扫描 | `src/utils/` | 新增记忆写入扫描(可参考 `commandGuard.ts` 的模式匹配思路) |
| 设置 UI | `src/views/SettingsView.vue` | AI 区块:记忆开关、写入确认开关、"AI 记忆"管理入口 |
| 聊天 UI | `src/components/ai/AiChat.vue` | "已记住"轻量通知;历史会话列表 / 切换 |
| 淘汰 | localStorage `ai-sessions-v1` | L2 上线后退役 |

---

## 5. 安全红线

1. 延续现有纪律:API key 只进 OS Keyring;记忆库不落明文凭据(写入扫描兜底)
2. tool 输出(命令结果 / 查询结果)是否入长期库是设置项,默认只存 user/assistant 文本
3. 记忆必须有完整查看 / 编辑 / 删除 UI——用户必须知道 AI 记住了什么
4. 记忆增删写 `audit_log`
5. 冻结快照 + 写入扫描双保险,防记忆成为 prompt 注入载体

---

## 6. 落地分期

### 第一期:会话存档(纯基础设施)

- `conversations` / `messages` / `messages_fts` 落 SQLite
- conversation 实体化(脱离 tab 绑定),历史会话列表 / 切换 / 搜索 UI
- `session_search` 工具
- 上下文 token 预算 + 滑窗裁剪
- 退役 `ai-sessions-v1`

收益:tool 流水不丢、历史可查可搜,Agent 能"翻旧账"

### 第二期:记忆卡

- `memories` 表 + `memory` 三动作工具
- user / global / asset 三级卡注入 system prompt(冻结快照 + 容量头部)
- 写入安全扫描 + 去重 + 超限自合并
- "已记住"通知 + 写入确认闸(复用确认卡)+ Settings 记忆管理 UI + 审计

收益:跨会话记住环境事实与用户偏好,资产级记忆成为差异化能力

### 第三期:自动沉淀

- 压缩前 memory flush
- 后台 review 自动沉淀记忆 / 技能(受确认闸约束)
- `customSkills` 与记忆系统打通
- 观察记忆命中率,评估是否需要更强检索(FTS5 不够再考虑 `sqlite-vec`,不引外部向量库)

### 实施补充(v0.94.0,2026-08-23):专属记忆模型 + 项目标注

当前实现(截至 v0.94.0)在三期规划基础上的两项定型决策:

**1. 记忆模型硬前置(「专属 AI 负责记忆」)**

- 记忆系统里的 LLM 调用只有一处:`memory-sink` 的自动沉淀抽取(回合后 one-shot
  提炼)。参照 Hermes Agent 的实践(`hermes_cli/config.py` 为后台任务配置独立的
  便宜快速模型;`background_review.py` fork 后台 agent 复述对话),StarHub 让
  记忆沉淀走**专属记忆模型路由**,与主对话模型解耦。
- 配置:设置 → AI 助手 →「记忆模型」下拉(provider + model,数据源
  `llm.models` 会话无关模型目录),经 `starhub-memory-context` settings
  namespace 的 `memoryProvider` / `memoryModel` 下发。
- **门禁语义**:provider + model 必须成对非空,否则记忆功能整体关闭——
  - UI:「启用长期记忆」「自动沉淀记忆」开关禁用(默认关,无法勾选);
  - 注入:memory-context `agent/pre-step` 在 `enabled && !configured` 时跳过并
    console.warn;
  - 沉淀:memory-sink `agent/turn-stopping` 在路由缺失时整段跳过;
  - memory 工具:memory-context 的 `tools/pre-execute` 门禁直接 deny(不弹
    确认卡、不进 Rust 写路径),提示先去设置里配置;
  - 归一化兜底:localStorage 残留的开启态在 `normalizeAiSettings` 被强制归零。
- 门槛不校验 provider 路由在 llm registry 里真实存在;配错由抽取尝试报错兜底。

**2. 跨项目作用域的项目标注(global / user)**

- 背景:user(用户画像)与 global(环境经验)是跨项目作用域,会注入到所有
  项目的会话;不同项目的事实混在一起会被误套用。
- 约定:写成 user/global 的条目,**凡只属于某个项目的事实必须在条目内标注项目
  名**(取工作区目录名,如 `[starhub] 生产库在 10.0.0.5`);跨项目通用的偏好/
  经验可不标注(「可以总结相同点,但不同点必须标注是哪个项目」)。
- 落地:memory 工具描述(模型侧契约)+ memory-sink 抽取系统提示与抽取 prompt
  (带 `project: <目录名>` 行)。folder:<工作区> 卡本身就是按项目隔离的,
  不需要额外标注。标注靠约定约束,不做机械校验。

---

## 7. 参考资料

- [Hermes Agent — Persistent Memory 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [How Hermes Agent Memory Actually Works — vectorize.io](https://vectorize.io/articles/hermes-agent-memory-explained)
