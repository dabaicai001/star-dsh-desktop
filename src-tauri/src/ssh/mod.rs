//! SSH 域(Tauri 侧适配层,去 Tauri 化 M1)。
//!
//! 域逻辑(russh 会话 / 认证 / known_hosts 策略 / SFTP / Web 网关)已抽取到
//! `starhub-domain-ssh` crate;本模块只保留两件 Tauri 专属的事:
//! 1. [`adapters`] —— 两个 host seam 的 Tauri 实现(Emitter 事件 sink、
//!    SQLite known_hosts 存储);
//! 2. 再导出 crate 的全部公共面,`crate::ssh::*` 路径对既有调用方不变。
//!
//! 上游铁律例外说明:这是「抽取域逻辑」迁移的过渡层,M4 退役 src-tauri 时
//! 本模块随之消失。

pub use starhub_domain_ssh::*;

pub mod adapters;
