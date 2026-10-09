//! StarHub 直播/接管帧枢纽(去 Tauri 化 M3 面板化的根)。
//!
//! Tauri 时代,直播/接管是**窗口面**:`android-live://` / `sandbox-live://`
//! custom protocol + 自包含 HTML 页 + WebviewWindow。舍弃 Tauri 后,窗口面
//! 整体消亡,能力改由三件套承接:
//!
//! ```text
//! 源(browser / Android / 沙箱)──push_frame──▶ 帧枢纽(FrameHub)
//!                                              │ broadcast + 环形重放
//!                                              ▼
//!                              本地 WS server(127.0.0.1 + 一次性 token)
//!                                              │ bridge 的 registerUpgrade 代理
//!                                              ▼
//!                                   dsh 壳内面板(canvas / img + 手势)
//! ```
//!
//! 三条不变量(与 Tauri 直播窗口逐字对齐):
//! 1. **接管互斥**:接管开启期间 AI 写操作一律拒绝(不撤销授权)——域名工具的
//!    执行点经 [`TakeoverState`] seam 读帧枢纽,语义不变;
//! 2. **最后一位走即关**:最后一个订阅者离开 = 关窗口,源(泵 / scrcpy 子进程 /
//!    adb forward)当场回收,不泄漏;
//! 3. **降级要说清**:scrcpy 不可用 / adb 缺失等原因写进通道元数据 `error`,
//!    面板原样展示,直播走截图轮询兜底(与 Tauri meta 端点同语义)。
//!
//! 帧源分批落地:本 crate 先交付 Android(`android` 模块);browser 与沙箱桌面
//! 两个源随 M3 后续批次进入,接口已经在此钉死(`Channel` + `push_frame`)。

pub mod android;
pub mod frames;
pub mod hub;
pub mod ws;

pub use frames::{
    decode_frame, encode_frame, PacketRing, FLAG_CONFIG, FLAG_KEYFRAME, FRAME_HEADER_LEN,
    MAX_FRAME_PAYLOAD, MSG_H264, MSG_PNG, RING_CAP_BYTES,
};
pub use hub::{
    valid_channel_id, Channel, ChannelInfo, ChannelMeta, FrameHub, Gesture, LiveInput,
    KIND_ANDROID, KIND_BROWSER, KIND_DESKTOP,
};
pub use ws::{parse_live_path, LiveServer, LiveServerHandle, LIVE_PATH_PREFIX};

/// Android 域的接管状态 seam:读帧枢纽里 `android:<serial>` 通道的接管标志。
///
/// 域工具(android_tap / swipe / type …)在执行点调它;与 Tauri 版查 live
/// 注册表同语义,只是数据源从窗口注册表换成帧枢纽。
pub struct HubTakeoverState {
    hub: std::sync::Arc<FrameHub>,
}

impl HubTakeoverState {
    pub fn new(hub: std::sync::Arc<FrameHub>) -> Self {
        Self { hub }
    }

    /// 写接管标志(桥命令兼容入口;WS 路径自己写通道,不经这里)。
    pub fn set(&self, serial: &str, active: bool) -> bool {
        self.hub
            .set_takeover(&android::AndroidLiveSource::channel_id(serial), active)
    }
}

impl starhub_domain_android::TakeoverState for HubTakeoverState {
    fn is_takeover(&self, serial: &str) -> bool {
        self.hub
            .is_takeover(&android::AndroidLiveSource::channel_id(serial))
    }
}
