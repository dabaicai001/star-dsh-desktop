//! 直播/接管帧出口的 sidecar 装配点(去 Tauri 化 M3)。
//!
//! 取代 Tauri 的直播窗口栈(`WebviewWindow` + custom protocol + 自包含页):
//!
//! | Tauri 直播窗口面 | sidecar 帧出口 |
//! |---|---|
//! | `android-live://localhost/<serial>/*` | `ws://127.0.0.1:<port>/live/android:<serial>?token=…` |
//! | `GET frame.png`(轮询) | 二进制帧 `kind=1`(PNG)推送 |
//! | `GET video?since=`(scrcpy 增量) | 二进制帧 `kind=2`(H.264)推送 + 关键帧重放 |
//! | `POST /input` + `POST /takeover` | WS 文本消息 `{"t":"input"}` / `{"t":"takeover"}` |
//! | `live` / `scrcpy` 注册表 | [`FrameHub`] 的通道表 |
//! | 关窗口停泵 + 回收 scrcpy | 最后一个订阅者离开即关通道(源自行回收) |
//!
//! 端口与令牌由 bridge 经 `starhub/live.endpoint` / `ui.live_token` 取得,
//! 再由它的 `webServer.registerUpgrade` 以带鉴权的 path 暴露给 GUI 面板。
//!
//! 环境变量:
//! - `STARHUB_LIVE_PORT`:WS 监听端口(缺省 0 = 内核分配空闲端口);
//! - `STARHUB_LIVE_DISABLED`:置 1 时不启动 WS server(只保留方法面,供测试)。

use std::sync::Arc;

use starhub_domain_android::adb::LocalAdb;
use starhub_domain_android::AndroidManager;
use starhub_live::android::AndroidLiveSource;
use starhub_live::ws::{LiveServer, LiveServerHandle};
use starhub_live::{FrameHub, HubTakeoverState};

/// 环境变量:WS 监听端口(0 = 内核分配)。
pub const LIVE_PORT_ENV_KEY: &str = "STARHUB_LIVE_PORT";
/// 环境变量:置 1 关闭 WS server(方法面仍在,测试/无 GUI 环境用)。
pub const LIVE_DISABLED_ENV_KEY: &str = "STARHUB_LIVE_DISABLED";

/// 直播/接管帧出口运行时。
pub struct LiveRuntime {
    hub: Arc<FrameHub>,
    /// WS server 句柄;None = 未启动(被环境变量关闭)。
    server: Option<LiveServerHandle>,
    /// Android 帧源(scrcpy + 轮询泵 + 接管输入)。
    android: AndroidLiveSource,
    /// 域名工具的 `TakeoverState` seam 实现(读帧枢纽)。
    takeover: Arc<HubTakeoverState>,
}

impl LiveRuntime {
    /// 在既有帧枢纽上装配:起 Android 帧源 → 绑本地 WS server。
    ///
    /// hub 由调用方创建并与 Android 域共享(同一处授权/接管/通道),因此
    /// `manager` / `settings` 也必须与 [`crate::android_runtime::AndroidRuntime`]
    /// 同一份,否则 adb 路径解析会分裂。
    pub fn with_hub(
        hub: Arc<FrameHub>,
        settings: Arc<dyn starhub_domain_android::SettingsStore>,
        manager: Arc<AndroidManager>,
        runtime: &tokio::runtime::Runtime,
    ) -> Result<Self, String> {
        let android = AndroidLiveSource::new(
            Arc::clone(&hub),
            Arc::new(LocalAdb::new()),
            settings,
            manager,
        );
        let takeover = Arc::new(HubTakeoverState::new(Arc::clone(&hub)));

        let server = if std::env::var(LIVE_DISABLED_ENV_KEY).as_deref() == Ok("1") {
            None
        } else {
            let port = std::env::var(LIVE_PORT_ENV_KEY)
                .ok()
                .and_then(|value| value.trim().parse::<u16>().ok())
                .unwrap_or(0);
            Some(
                runtime
                    .block_on(async { LiveServer::bind(Arc::clone(&hub), port).await?.spawn() })?,
            )
        };

        Ok(Self {
            hub,
            server,
            android,
            takeover,
        })
    }

    /// 不起 WS server 的装配(单测 / 无 GUI 环境):方法面与帧枢纽仍在。
    pub fn without_server(
        settings: Arc<dyn starhub_domain_android::SettingsStore>,
        manager: Arc<AndroidManager>,
    ) -> Self {
        let hub = Arc::new(FrameHub::new());
        let android = AndroidLiveSource::new(
            Arc::clone(&hub),
            Arc::new(LocalAdb::new()),
            settings,
            manager,
        );
        let takeover = Arc::new(HubTakeoverState::new(Arc::clone(&hub)));
        Self {
            hub,
            server: None,
            android,
            takeover,
        }
    }

    pub fn hub(&self) -> &Arc<FrameHub> {
        &self.hub
    }

    pub fn android(&self) -> &AndroidLiveSource {
        &self.android
    }

    /// 域名工具的接管状态 seam(单事实来源:帧枢纽)。
    pub fn takeover(&self) -> Arc<HubTakeoverState> {
        Arc::clone(&self.takeover)
    }

    /// WS 端点(`ws://127.0.0.1:<port>`);未启动返回 None。
    pub fn endpoint(&self) -> Option<String> {
        self.server
            .as_ref()
            .map(|server| LiveServer::endpoint(server.port))
    }

    /// 当前监听端口(未启动 = 0)。
    pub fn port(&self) -> u16 {
        self.server.as_ref().map(|server| server.port).unwrap_or(0)
    }
}

impl Drop for LiveRuntime {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            server.shutdown();
        }
    }
}
