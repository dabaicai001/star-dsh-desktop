# @deepseek-ai/dsh-starhub-memory-context

StarHub 本地 host 包(不在上游):`agent/pre-step` 注入长期记忆,补上「memory 工具写了却从不注入」的缺失环节。

## 行为

- 每个 agent 请求 pre-step 时,经 `sdk-transport` 反向 RPC pull `starhub/memory.cards`(Rust 侧 `handle_memory_cards`),scopes = `user` + `global` + `folder:<会话工作区绝对路径>`(session header.cwd);Rust 侧按 sessionId 解析资产绑定,额外追加 `asset:<id>` 卡。
- 各卡非空段拼成一条 plugin 来源 user message(`form: 'snapshot'`)注入;全部为空则不注入。
- pull 失败或超时(2s)降级为不注入,不阻断 agent turn。
- 开关:设置 → AI 助手「启用长期记忆」经 `starhub-memory-context` settings namespace 下发;关闭时完全不注入。v0.92.0 起 namespace 未写过视为关闭(与设置默认值一致,默认关)。

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
- 「记忆写入需逐条确认」「存档 tool 消息」两个设置开关仍是 UI 层状态(写路径由 approval-bridge 风险门承接),不在本包语义内。
- 「自动沉淀记忆」开关 2026-08-22 (v0.92.0) 起接入 `@deepseek-ai/dsh-starhub-memory-sink`:开关同步到 namespace 的 `autoReview` 字段,memory-sink 在 `agent/turn-stopping` 后读取并据此跳过 LLM 抽取。
