# @deepseek-ai/dsh-starhub-memory-sink

StarHub 本地 host 包(2026-08-22,v0.92.0):agent/turn-stopping 钩子把当轮持久事实自动写入 ai_memories,补上 v0.79 AI 内核替换时丢失的「memory 自动沉淀」能力(原 Vue `aiMemoryReviewGates` 等价逻辑)。

## 行为

- 监听 `agent/turn-stopping`(payload `{ agent, turn, signal }`,fire-and-forget)。
- 读取 settings namespace `starhub-memory-context.autoReview`:
  - 未写过 → 视为关闭(v0.92.0 起默认关,与设置单开关默认关闭一致)
  - `autoReview === true` 才整段执行;关闭则整段跳过
- **记忆模型硬前置(v0.94.0)**:`memoryProvider` + `memoryModel` 必须成对非空,否则整段跳过(开关打开也没用,与设置「只有配置了才能勾选」对齐)。
- 消息数门禁 `shouldReview({user, assistant})`(消息数 ≥ 4):**仅当 `agent.session.events` 能提供 user/assistant 计数时生效**。DSH web 会话(DSH GUI 内核)的消息事件并不总是进入 `session.events`(实证 `session.jsonl.zstd` 只有 session 头、无消息事件),此时计数为 0/0,若强依赖计数会让自动沉淀永远不触发;已触发 `turn-stopping` 本身就代表本轮回合确有对话,因此计数缺失时不再拦截,交由记忆模型 LLM 转取自行判断(空轮次返回 `{"facts":[]}` 不落库)。
- 抽取走**专属记忆模型路由**(`ctx.llm.stream`,provider/model 取自上面两个字段);调用 LLM 抽取(6 秒超时),返回 `{"facts":[{"content":"..."}]}`;抽取提示里带工作区/项目名(目录末段)。
- `normalizeFacts` 收敛 scope → `folder:<cwd>` 或 `global`(根据 cwd 决定);去空、限 280 字符/条、限 8 条/批。
- 逐条经 sdk-transport 反向 RPC `starhub/memory.write` 调 Rust `ai_memory_add`(2 秒超时);失败/超时/[FULL]/[DUPLICATE] 全部吞掉,不污染 turn 链。
- 无 sdk-transport / 无 LLM 服务时整段无操作(开发态友好)。

## Model Experience

### Turn-review extraction

#### What the model sees

No direct message injection — the hook reads the `starhub-memory-context` settings namespace and issues one separate streaming completion through the dedicated memory route (`ctx.llm.stream`, provider/model from the namespace) over the just-completed turn.

#### Token effect

One independent LLM call per eligible turn (a turn with ≥4 event counts when countable, or any `turn-stopping` when events are absent); steady-state cost is near zero because an empty turn returns `{"facts":[]}` without a write.

#### KV Cache effect

Not applicable — the extraction path runs entirely after the turn ends.

## Known Limitations and Deferred Work

- LLM 抽取独立于主 agent 的 chat completion,目前只是 best-effort;Rust 侧 [FULL] / [DUPLICATE] 直接吞掉,不当轮合并重试(沉淀本就是低质量信号,后续 turn 自然再抽一次)。
- 压缩点(`compaction/start`、`compaction/end`)暂未挂载;本版本只做 turn-stopping。
- 跨项目作用域(global / user)的事实项目标注约定靠抽取提示约束,不做机械校验;无工作区的会话沉淀到 global 时,事实里提到的项目名由模型自行带出。
