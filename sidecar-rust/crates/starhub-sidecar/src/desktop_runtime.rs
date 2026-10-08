//! Desktop 域运行时:sidecar 侧的装配点(M1 第 6 步)。
//!
//! 工具体在 [`starhub_domain_desktop`];这里只提供六个 seam 的 sidecar 实现:
//!
//! | seam | sidecar 实现 |
//! |---|---|
//! | SidecarCaller | [`DbRuntime`] 里的 GoSidecar |
//! | InstanceStore | [`FileInstanceStore`](crate::desktop_store::FileInstanceStore) |
//! | SettingsStore | `starhub-settings.json` + `STARHUB_SETTINGS_FILE` |
//! | AssetConfigSource | [`AssetStore`](crate::assets::AssetStore) |
//! | EventBroadcast | 域事件通知出口(JSON-RPC) |
//! | CacheDir | `STARHUB_CACHE_DIR` / `<cwd>/starhub-cache` |
//! | KnownHostsStore | [`FileKnownHostsStore`](crate::known_hosts_store::FileKnownHostsStore) |

use std::path::PathBuf;
use std::sync::Arc;

use starhub_domain_desktop::manager::DesktopManager;
use starhub_domain_desktop::{
    AssetConfigSource, BoxFuture, CacheDir, Desktop, EventBroadcast, SettingsStore, SidecarCaller,
};
use starhub_domain_ssh::events::EventSink;

use crate::assets::AssetStore;
use crate::db_runtime::DbRuntime;
use crate::desktop_store::FileInstanceStore;
use crate::known_hosts_store::FileKnownHostsStore;

/// sidecar 的 Go sidecar 调用(直接转 [`DbRuntime`] 持有的客户端)。
pub struct GoSidecarCaller {
    db: Arc<DbRuntime>,
}

impl GoSidecarCaller {
    pub fn new(db: Arc<DbRuntime>) -> Self {
        Self { db }
    }
}

impl SidecarCaller for GoSidecarCaller {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(async move { self.db.go_sidecar().call(method, params).await })
    }

    fn call_with_timeout<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
        timeout: std::time::Duration,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(async move {
            self.db
                .go_sidecar()
                .call_with_timeout(method, params, timeout)
                .await
        })
    }
}

/// 资产配置来源(与 DB 域共用同一份 assets.json)。
impl AssetConfigSource for AssetStore {
    fn load<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> BoxFuture<'a, Result<(String, serde_json::Value), String>> {
        let outcome = self.load_asset_config(asset_id);
        Box::pin(async move { outcome })
    }
}

/// 文件设置存储(`starhub-settings.json`,一个扁平的 key→value 对象)。
pub struct FileSettingsStore {
    path: PathBuf,
}

impl FileSettingsStore {
    /// 按环境变量解析路径:`STARHUB_SETTINGS_FILE`,缺省 `<cwd>/starhub-settings.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_SETTINGS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-settings.json"));
        Self { path }
    }

    /// 读全部设置(扁平 key→value 对象;文件不存在 = 空)。
    pub fn read_all(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|e| format!("设置文件解析失败({}): {e}", self.path.display()))
                .map(|value| value.as_object().cloned().unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(error) => Err(format!(
                "设置文件读取失败({}): {error}",
                self.path.display()
            )),
        }
    }
}

impl SettingsStore for FileSettingsStore {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        let outcome = (|| {
            let value = self
                .read_all()?
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            Ok(value)
        })();
        Box::pin(async move { outcome })
    }
}

/// 缓存目录:`STARHUB_CACHE_DIR`,缺省 `<cwd>/starhub-cache`。
pub struct EnvCacheDir;

impl CacheDir for EnvCacheDir {
    fn dir(&self, sub: &str) -> Result<PathBuf, String> {
        let root = std::env::var("STARHUB_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-cache"));
        Ok(root.join(sub))
    }
}

/// 域事件通知出口(与 SSH 域同一条通道)。
pub struct NotifyEventBroadcast {
    sink: Arc<dyn EventSink>,
}

impl NotifyEventBroadcast {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self { sink }
    }
}

impl EventBroadcast for NotifyEventBroadcast {
    fn emit<'a>(&'a self, event: &'a str, payload: serde_json::Value) -> BoxFuture<'a, ()> {
        self.sink.emit(event, payload);
        Box::pin(async move {})
    }
}

/// Desktop 域运行时。
pub struct DesktopRuntime {
    manager: DesktopManager,
    sidecar: GoSidecarCaller,
    store: FileInstanceStore,
    settings: FileSettingsStore,
    cache: EnvCacheDir,
    events: NotifyEventBroadcast,
    known_hosts: FileKnownHostsStore,
    /// 资产存储(AssetConfigSource;与 SSH/DB 域共用同一份 assets.json)。
    assets: Arc<AssetStore>,
}

impl DesktopRuntime {
    /// 装配运行时;资产/密钥/事件出口与另外两个域共享。
    pub fn new(
        db: Arc<DbRuntime>,
        assets: Arc<AssetStore>,
        known_hosts: FileKnownHostsStore,
        events: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            manager: DesktopManager::new(),
            sidecar: GoSidecarCaller::new(db),
            store: FileInstanceStore::from_env(),
            settings: FileSettingsStore::from_env(),
            cache: EnvCacheDir,
            events: NotifyEventBroadcast::new(events),
            known_hosts,
            assets,
        }
    }

    /// 管理器(前端接管开关 / 人工介入应答经此进出)。
    pub fn manager(&self) -> &DesktopManager {
        &self.manager
    }

    /// 装配执行上下文。
    pub fn context<'a>(&'a self, session_id: &'a str) -> Desktop<'a> {
        Desktop {
            manager: &self.manager,
            sidecar: &self.sidecar,
            store: &self.store,
            settings: &self.settings,
            assets: self.assets.as_ref(),
            events: &self.events,
            cache: &self.cache,
            known_hosts: &self.known_hosts,
            session_id,
        }
    }

    /// 持久化存储(诊断信息用)。
    pub fn store_path(&self) -> &std::path::Path {
        self.store.path()
    }
}
