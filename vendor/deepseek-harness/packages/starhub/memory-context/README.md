# @deepseek-ai/dsh-starhub-memory-context

StarHub 本地 host 包(不在上游):`agent/pre-step` 注入长期记忆,补上「memory 工具写了却从不注入」的缺失环节。

## 行为

- 每个 agent 请求 pre-step 时,经 `sdk-transport` 反向 RPC pull `starhub/memory.cards`(Rust 侧 `handle_memory_cards`),scopes = `user` + `global` + `folder:<会话工作区绝对路径>`(session header.cwd);Rust 侧按 sessionId 解析资产绑定,额外追加 `asset:<id>` 卡。
- 各卡非空段拼成一条 plugin 来源 user message(`form: 'snapshot'`)注入;全部为空则不注入。
- pull 失败或超时(2s)降级为不注入,不阻断 agent turn。
- 开关:设置 → AI 助手「启用长期记忆」经 `starhub-memory-context` settings namespace 下发;关闭时完全不注入。v0.92.0 起 namespace 未写过视为关闭(与设置默认值一致,默认关)。
- **记忆模型硬前置(v0.94.0)**:namespace 的 `memoryProvider` + `memoryModel` 必须成对非空,记忆功能才可能工作——未配置时即使「启用长期记忆」打开也不注入(console.warn 提示),自动沉淀(memory-sink)不抽 LLM,**memory 工具调用被本插件的 `tools/pre-execute` 门禁 deny**(提示去设置里配置),不弹确认卡也不进 Rust 写路径。配置后工具门放行,交回 approval-bridge 的逐条确认。

## Model Experience

### Injected memory snapshot

#### What the model sees

One plugin-sourced user message listing the session-visible long-term memory cards (user profile / global environment experience / current-workspace folder / bound assets), with a hint to use the `memory` tool to persist new durable facts.

#### Token effect

Injected only when at least one card has content; each card is capped by the Rust-side character limit (`user`/`folder`/`asset` 1375, `global` 2200), so per-step injection is bounded.

#### KV Cache effect

Per-step snapshot; the text changes only when the memory contents change.

## Known Limitations and Deferred Work

- 注入发生在每一步(pre-step),不跨步缓存卡片;SQLite 查询足够便宜,暂不引入缓存层。
- 「启用长期记忆与自动沉淀」单开关(v0.96.4 起合并)同步到 namespace 的 `enabled` 与 `autoReview` 两字段:memory-context 在 `agent/pre-step` 据此注入,memory-sink 在 `agent/turn-stopping` 后据此跳过 LLM 抽取。
- memory 工具锁死门只按「路由是否配置」判定,不校验 provider 路由在 llm registry 里真实存在;配错 provider 由抽取/写入尝试时报错兜底。
