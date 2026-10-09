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
//! | `LiveLauncher` | [`HubLiveLauncher`](crate::methods::android::HubLiveLauncher)(M3:帧通道) |
//! | `TakeoverState` | [`HubTakeoverState`](starhub_live::HubTakeoverState)(M3:帧枢纽) |
//!
//! M3 起直播/接管不再是窗口面:`LiveLauncher` 直接开 [`starhub_live`] 的帧通道
//! (scrcpy H.264 / 截图轮询 + 接管输入),接管标志由帧枢纽统一持有——域名工具
//! 的执行点与面板读同一处,AI 写操作在接管期间一律拒绝(不撤销授权)。

use std::sync::Arc;

use starhub_domain_android::adb::LocalAdb;
use starhub_domain_android::AndroidManager;
use starhub_live::android::AndroidLiveSource;
use starhub_live::{FrameHub, HubTakeoverState};

use crate::assets::AssetStore;
use crate::bindings::SessionBindings;
use crate::desktop_runtime::FileSettingsStore;
use crate::methods::android::{EnvCacheDir, FileFrameStore, HubLiveLauncher};

/// Android 域运行时(20 个 `android_*` 方法共享)。
pub struct AndroidRuntime {
    manager: AndroidManager,
    adb: LocalAdb,
    settings: FileSettingsStore,
    cache: EnvCacheDir,
    frames: FileFrameStore,
    live: HubLiveLauncher,
    takeover: Arc<HubTakeoverState>,
    /// 资产存储(与其它域共用;Android 工具目前不直接用它,预留)。
    #[allow(dead_code)]
    assets: Arc<AssetStore>,
    /// 会话绑定(与其它域共用;设备授权按 session_id 记)。
    #[allow(dead_code)]
    bindings: Arc<SessionBindings>,
}

impl AndroidRuntime {
    /// 装配运行时(直播/接管线接帧枢纽)。
    pub fn with_live(
        assets: Arc<AssetStore>,
        bindings: Arc<SessionBindings>,
        sink: Arc<dyn starhub_domain_ssh::events::EventSink>,
        hub: Arc<FrameHub>,
        live_source: AndroidLiveSource,
    ) -> Self {
        Self {
            manager: AndroidManager::new(),
            adb: LocalAdb::new(),
            settings: FileSettingsStore::from_env(),
            cache: EnvCacheDir,
            frames: FileFrameStore::from_env(),
            live: HubLiveLauncher::new(live_source, sink),
            takeover: Arc::new(HubTakeoverState::new(hub)),
            assets,
            bindings,
        }
    }

    /// 用显式设置/帧存储路径装配(测试 / 装配点用)。
    ///
    /// 自建一个独立帧枢纽:测试不关心与真实 WS server 共享状态,只要 seam 齐全。
    pub fn with_paths(
        assets: Arc<AssetStore>,
        bindings: Arc<SessionBindings>,
        sink: Arc<dyn starhub_domain_ssh::events::EventSink>,
        settings: FileSettingsStore,
        cache: EnvCacheDir,
        frames: FileFrameStore,
    ) -> Self {
        let hub = Arc::new(FrameHub::new());
        let source = AndroidLiveSource::new(
            Arc::clone(&hub),
            Arc::new(LocalAdb::new()),
            Arc::new(NullSettings),
            Arc::new(AndroidManager::new()),
        );
        Self {
            manager: AndroidManager::new(),
            adb: LocalAdb::new(),
            settings,
            cache,
            frames,
            live: HubLiveLauncher::new(source, sink),
            takeover: Arc::new(HubTakeoverState::new(hub)),
            assets,
            bindings,
        }
    }

    /// 管理器(设置页清 adb 缓存 / UI 命令用)。
    pub fn manager(&self) -> &AndroidManager {
        &self.manager
    }

    /// adb 执行器(UI 面 `android_ui_list_devices` 只读列表用)。
    pub fn adb(&self) -> &LocalAdb {
        &self.adb
    }

    /// 设置存储(UI 面 adb 路径读写;与 desktop 域共用同一份文件)。
    pub fn settings(&self) -> &FileSettingsStore {
        &self.settings
    }

    /// 接管开关(面板的 WS `{"t":"takeover"}` 写帧枢纽;这里保留给桥命令兼容)。
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
            takeover: self.takeover.as_ref(),
            session_id,
        }
    }
}

/// 空设置存储(`with_paths` 的测试装配用;真实装配走 `FileSettingsStore`)。
struct NullSettings;

impl starhub_domain_android::SettingsStore for NullSettings {
    fn get<'a>(
        &'a self,
        _key: &'a str,
    ) -> starhub_domain_android::BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { Ok(None) })
    }
}
