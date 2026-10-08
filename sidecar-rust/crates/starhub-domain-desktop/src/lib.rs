//! StarHub sandbox-desktop domain, extracted from the retired Tauri shell.
//!
//! 设计:`docs/superpowers/specs/2026-08-28-desktop-automation-design.md`。
//! 编排全部经 Go sidecar 的 Docker 适配器;目标连接 = 设置页「沙箱平台」选择,
//! 未选择时默认本机 Docker。
//!
//! 安全模型(§5)——**在执行点强制**,与宿主无关:
//! - 任务级授权:`desktop_create_sandbox` 成功即建立 session → sandbox 授权
//!   (60 分钟),授权期内写操作自动放行;
//! - 用户接管期间写操作一律拒绝,接管不撤销授权;
//! - 每次写操作前自动截屏留档(`sandbox_replay_frames`),支持回放;
//! - `desktop_type` 的文本不进审计(审计摘要在 events.rs 只记长度)。
//!
//! 宿主注入点(全部 trait,两个宿主各实现一次):
//!
//! | seam | Tauri 壳 | sidecar |
//! |---|---|---|
//! | [`SidecarCaller`] | app state 的 Go sidecar 客户端 | 自有 GoSidecar |
//! | [`InstanceStore`] | SQLite(sandbox_instances/templates/replay_frames) | JSON 文件 |
//! | [`SettingsStore`] | settings 表 | 配置文件 / 环境变量 |
//! | [`AssetConfigSource`] | SQLite assets + Keyring | assets.json |
//! | [`EventBroadcast`] | `tauri::Emitter` | JSON-RPC 通知 |
//! | [`CacheDir`] | `app_cache_dir()` | 环境变量 / cwd |

pub mod exec;
pub mod keys;
pub mod manager;
pub mod recipe;
pub mod store;

pub use exec::{execute, ui_lifecycle, DESKTOP_TOOLS};
pub use manager::DesktopManager;
pub use store::{InstanceRow, InstanceStore, SandboxTemplate};

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Boxed future alias for the object-safe async seam methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Go sidecar 调用(Tauri 与 sidecar 各自接自己的客户端)。
///
/// 方法带 `'a`(与 [`InstanceStore`] 同一手法):入参借用的生命周期即返回
/// future 的生命周期,impl 侧先同步算完再包 `Box::pin(async move { … })`。
pub trait SidecarCaller: Send + Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>>;

    /// 长耗时 RPC(镜像构建/实例固化)用自定义超时。
    fn call_with_timeout<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>>;
}

/// 设置读取(沙箱平台选择)。
pub trait SettingsStore: Send + Sync {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, String>>;
}

/// 资产配置解析(Docker over SSH 传输的 SSH 资产、沙箱平台资产)。
pub trait AssetConfigSource: Send + Sync {
    /// 资产 id → (资产类型, 合并密钥后的配置)。
    fn load<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> BoxFuture<'a, Result<(String, serde_json::Value), String>>;
}

/// 域事件广播(「请求用户人工介入」横幅)。
pub trait EventBroadcast: Send + Sync {
    fn emit<'a>(&'a self, event: &'a str, payload: serde_json::Value) -> BoxFuture<'a, ()>;
}

/// 缓存目录(截图 / Dockerfile 落盘)。
pub trait CacheDir: Send + Sync {
    fn dir(&self, sub: &str) -> Result<std::path::PathBuf, String>;
}

/// 工具执行上下文:全部注入点 + 会话 id。
pub struct Desktop<'a> {
    pub manager: &'a DesktopManager,
    pub sidecar: &'a dyn SidecarCaller,
    pub store: &'a dyn InstanceStore,
    pub settings: &'a dyn SettingsStore,
    pub assets: &'a dyn AssetConfigSource,
    pub events: &'a dyn EventBroadcast,
    pub cache: &'a dyn CacheDir,
    /// TOFU 主机密钥存储(Docker over SSH 复用;宿主注入)。
    pub known_hosts: &'a dyn starhub_domain_ssh::events::KnownHostsStore,
    pub session_id: &'a str,
}
