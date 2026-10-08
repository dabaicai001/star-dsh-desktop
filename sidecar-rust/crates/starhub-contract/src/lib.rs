//! StarHub × dsh 联动契约(契约 §1 / §2.2,`docs/联动实施-桥接契约-2026-08-17.md`)。
//!
//! 两个宿主(Tauri 壳 / Rust sidecar)与 dsh 侧插件共用同一份形状:
//! 领域事件 `{ kind, assetId?, ts, summary, data, origin? }`(ts 为秒级 unix
//! 时间戳,`origin` 省略等价于 `"user"`),以及 `starhub_list_capabilities`
//! 的模型可读静态文本。
//!
//! 规则(契约 §1):
//! - 终端高频输出不进事件流,只记「命令提交/完成」粒度;
//! - `summary` 单行、≤200 字符、不含敏感值(密码/密钥一律不落);
//! - AI 起源事件由宿主在 `starhub/tool.execute` 成功后自动生成(origin=ai),
//!   用户起源事件由前端上报。

pub mod events;

pub use events::{
    ai_tool_event, capabilities_text, kind_for_tool, normalize_summary, tail_of, unix_now,
    DomainEvent, RecentExec, MAX_EXEC_TAIL_BYTES, MAX_SUMMARY_CHARS,
};
