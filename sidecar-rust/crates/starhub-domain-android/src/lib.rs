//! StarHub Android-device domain, extracted from the retired Tauri shell.
//!
//! 设计:`docs/superpowers/specs/2026-08-30-android-device-design.md`。
//! 与沙箱桌面(desktop)并列、互不影响:那里是一次性 Ubuntu 容器,这里是
//! 用户真实的 Android 手机——误操作是真实后果,因此:
//! - `android_connect` 的一次确认 = 任务级授权(60 分钟,对齐沙箱模型),
//!   授权只覆盖选定 serial;授权存在性/过期/serial 匹配由本 crate 在执行点强制;
//! - 直播窗口内「接管」开启期间 AI 写操作一律拒绝(不撤销授权);
//! - 每次写操作前自动截屏留档(回放帧),支持回放;
//! - `android_type` 文本不进审计(审计摘要在 events.rs 只记长度);
//! - `android_exec` 恒确认 hard 档(approval-bridge),任何预设不静默放行;
//! - `android_pull`/`android_push`/`android_wireless` 恒确认软档(对齐 sftp)。
//!
//! adb 二进制解析顺序(§3):设置 `android.adb_path` → STARHUB_ADB_PATH →
//! PATH → 平台常见安装位置;全部缺失时报错文本带安装引导。不做自动下载
//! (供应链风险,见 §3)。
//!
//! 直播(scrcpy H.264 / 轮询帧 / custom protocol)是**宿主窗口面**,M1 留在
//! Tauri 侧;新架构下面板化(M3)由 sidecar 的帧出口供给。本 crate 只通过
//! [`LiveLauncher`] seam 表达「打开直播」这一意图。

pub mod adb;
pub mod exec;
pub mod keys;
pub mod manager;
pub mod store;

pub use adb::{adb_missing_guidance, resolve_adb, Adb};
pub use exec::{execute, ANDROID_TOOLS};
pub use keys::AdbDevice;
pub use manager::AndroidManager;

use std::future::Future;
use std::pin::Pin;

/// Boxed future alias for the object-safe async seam methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 设置读取(adb 路径)。
pub trait SettingsStore: Send + Sync {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, String>>;
}

/// 缓存目录(截图落盘)。
pub trait CacheDir: Send + Sync {
    fn dir(&self, sub: &str) -> Result<std::path::PathBuf, String>;
}

/// 直播启动(宿主实现:Tauri 开窗口 / sidecar 注册帧会话)。
pub trait LiveLauncher: Send + Sync {
    fn open<'a>(
        &'a self,
        serial: &'a str,
        resolution: (i64, i64),
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// 直播接管状态(AI 写操作互斥;宿主注入)。
pub trait TakeoverState: Send + Sync {
    fn is_takeover(&self, serial: &str) -> bool;
}

/// 工具执行上下文:全部注入点 + 会话 id。
pub struct Android<'a> {
    pub manager: &'a AndroidManager,
    pub adb: &'a dyn adb::Adb,
    pub settings: &'a dyn SettingsStore,
    pub cache: &'a dyn CacheDir,
    pub frames: &'a dyn store::FrameStore,
    pub live: &'a dyn LiveLauncher,
    pub takeover: &'a dyn TakeoverState,
    pub session_id: &'a str,
}

impl Android<'_> {
    /// 直播接管中?(便捷转发)。
    pub fn is_takeover(&self, serial: &str) -> bool {
        self.takeover.is_takeover(serial)
    }
}
