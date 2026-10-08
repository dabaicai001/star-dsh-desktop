//! Android 域运行时(M1 第 6 步):sidecar 侧的装配点。
//!
//! 工体在 [`starhub_domain_android`];这里提供四个 seam 的 sidecar 实现:
//!
//! | seam | sidecar 实现 |
//! |---|---|
//! | `Adb` | `LocalAdb`(本机 spawn adb——adb 是宿主机工具,与 sidecar 同机) |
//! | `SettingsStore` | `FileSettingsStore`(与 desktop 域共用 settings.json) |
//! | `CacheDir` | `STARHUB_CACHE_DIR` / `<cwd>/starhub-cache` |
//! | `FrameStore` | [`FileFrameStore`](crate::methods::android::FileFrameStore) |
//! | `LiveLauncher` | 事件通知出口(M3 的面板消费) |
//! | `TakeoverState` | 内存集合(桥命令 `starhub/android.takeover` 维护) |
//!
//! 直播(scrcpy H.264 / 轮询帧 / custom protocol)是窗口面,M1 留在 Tauri 侧。

use std::sync::Arc;

use starhub_domain_android::adb::LocalAdb;
use starhub_domain_android::AndroidManager;

use crate::assets::AssetStore;
use crate::bindings::SessionBindings;
use crate::desktop_runtime::FileSettingsStore;
use crate::methods::android::{EnvCacheDir, FileFrameStore, MemoryTakeover, NotifyLiveLauncher};

/// Android 域运行时(20 个 `android_*` 方法共享)。
pub struct AndroidRuntime {
    manager: AndroidManager,
    adb: LocalAdb,
    settings: FileSettingsStore,
    cache: EnvCacheDir,
    frames: FileFrameStore,
    live: NotifyLiveLauncher,
    takeover: MemoryTakeover,
    /// 资产存储(与其它域共用;Android 工具目前不直接用它,预留)。
    #[allow(dead_code)]
    assets: Arc<AssetStore>,
    /// 会话绑定(与其它域共用;设备授权按 session_id 记)。
    #[allow(dead_code)]
    bindings: Arc<SessionBindings>,
}

impl AndroidRuntime {
    /// 装配运行时。
    pub fn new(
        assets: Arc<AssetStore>,
        bindings: Arc<SessionBindings>,
        sink: Arc<dyn starhub_domain_ssh::events::EventSink>,
    ) -> Self {
        Self {
            manager: AndroidManager::new(),
            adb: LocalAdb::new(),
            settings: FileSettingsStore::from_env(),
            cache: EnvCacheDir,
            frames: FileFrameStore::from_env(),
            live: NotifyLiveLauncher::new(sink),
            takeover: MemoryTakeover::default(),
            assets,
            bindings,
        }
    }

    /// 管理器(设置页清 adb 缓存 / UI 命令用)。
    pub fn manager(&self) -> &AndroidManager {
        &self.manager
    }

    /// 接管开关(桥命令 `starhub/android.takeover`)。
    pub fn set_takeover(&self, serial: &str, active: bool) {
        self.takeover.set(serial, active);
    }

    /// 装配执行上下文。
    pub fn context<'a>(&'a self, session_id: &'a str) -> starhub_domain_android::Android<'a> {
        starhub_domain_android::Android {
            manager: &self.manager,
            adb: &self.adb,
            settings: &self.settings,
            cache: &self.cache,
            frames: &self.frames,
            live: &self.live,
            takeover: &self.takeover,
            session_id,
        }
    }
}
