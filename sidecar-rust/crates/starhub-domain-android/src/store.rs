//! 回放帧持久化 seam(从 `src-tauri/src/android/mod.rs::record_frame` 的 SQLite
//! 写入部分抽出)。
//!
//! Tauri 实现为 `android_replay_frames` 表;sidecar 实现为 JSON 文件。

use crate::BoxFuture;

/// 回放帧存储。
pub trait FrameStore: Send + Sync {
    /// 追加一条回放帧(serial, session_id, action, shot_path)。
    fn insert_frame<'a>(
        &'a self,
        serial: &'a str,
        session_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 回放帧清单(正序,上限 limit)。
    fn list_frames<'a>(
        &'a self,
        serial: &'a str,
        limit: i64,
    ) -> BoxFuture<'a, Result<Vec<ReplayFrame>, String>>;
}

/// 一条回放帧。
#[derive(Debug, Clone)]
pub struct ReplayFrame {
    pub action: String,
    pub shot_path: Option<String>,
    pub created_at: i64,
}
