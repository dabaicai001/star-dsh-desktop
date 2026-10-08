//! 领域事件 schema 与构造(StarHub × dsh 联动,契约 §1)。
//!
//! 实现已平移到 `starhub-contract` crate(去 Tauri 化 M1):Tauri 壳与 Rust
//! sidecar 共用同一份事件形状与模型可读能力文本,两处不可能漂移。本文件只做
//! 再导出,原有调用点(`events::ai_tool_event` / `events::tail_of` /
//! `events::RecentExec` …)一字不改。

pub use starhub_contract::events::{
    ai_tool_event, capabilities_text, kind_for_tool, normalize_summary, tail_of, unix_now,
    DomainEvent, RecentExec, MAX_EXEC_TAIL_BYTES, MAX_SUMMARY_CHARS,
};
