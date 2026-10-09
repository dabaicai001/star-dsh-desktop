//! 帧枢纽:通道注册 / 一次性令牌 / 帧广播与重放 / 接管互斥。
//!
//! 对应 Tauri 直播窗口的三个注册表(live / scrcpy / 窗口栈)合一:
//! - **通道**(`Channel`)一源一通道,id 形如 `android:<serial>`;
//! - **源**(帧生产者)经 `push_frame` 推帧,帧枢纽负责广播给当前订阅者 + 进环形
//!   缓冲供迟到者重放;
//! - **输入**(接管时的人工操作)经通道的 mpsc 交给源顺序执行——与 Tauri 的
//!   `LiveAction` → pump 同姿势;
//! - **接管**标志是帧枢纽级(不是源级):域工具的执行点经 `TakeoverState`
//!   seam 读它,AI 写操作一律拒绝(不撤销授权)。
//!
//! **只有一个帧源:Android**(去 Tauri 化 M3 定稿)。browser 与沙箱桌面的直播/
//! 接管**不做**——上游 dsh 原生提供 browser-use / computer-use 及其可见面,
//! StarHub 重复造一份只会带来双轨维护。因此这里只登记 `android` 一种通道类型,
//! 不为不存在的源预留位置(预留即漂移)。
//!
//! 通道生命周期:源启动(`open`)→ 订阅者接入 → **最后一个订阅者离开即关闭**
//! (等价于 Tauri「关窗口即停泵 + 回收 scrcpy」),或源自行退出(adb 缺失 /
//! 设备离线 / scrcpy 流中断)。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{broadcast, mpsc, watch};

use crate::frames::{PacketRing, MSG_PNG};

/// 通道类型(决定源与面板语义)。M3 定稿:仅 Android 一个帧源。
pub const KIND_ANDROID: &str = "android";

/// 人工输入动作(面板 → 源)。`SetTakeover` 由帧枢纽自行处理,不转发给源。
#[derive(Debug, Clone)]
pub enum LiveInput {
    /// 点击/滑动/按键/文本(Android 与沙箱桌面同形状)。
    Gesture(Gesture),
    /// 源自定义动作(browser 的 navigate/click/type …),原样透传。
    Raw(Value),
    /// 接管开关。
    SetTakeover(bool),
}

/// 手势类输入(与 Tauri 直播页 POST /input 的 body 同形状)。
#[derive(Debug, Clone)]
pub enum Gesture {
    Tap {
        x: i64,
        y: i64,
    },
    Swipe {
        x1: i64,
        y1: i64,
        x2: i64,
        y2: i64,
        ms: i64,
    },
    Key {
        key: String,
    },
    Text {
        text: String,
    },
}

impl Gesture {
    /// 从面板 JSON 解析;形状与 Tauri 直播页逐字对应(`type` + 坐标/键名/文本)。
    pub fn parse(value: &Value) -> Option<Gesture> {
        let num = |key: &str| value.get(key).and_then(Value::as_i64);
        match value.get("type").and_then(Value::as_str)? {
            "tap" => Some(Gesture::Tap {
                x: num("x")?,
                y: num("y")?,
            }),
            "swipe" => Some(Gesture::Swipe {
                x1: num("x1")?,
                y1: num("y1")?,
                x2: num("x2")?,
                y2: num("y2")?,
                ms: value
                    .get("ms")
                    .and_then(Value::as_i64)
                    .unwrap_or(300)
                    .clamp(50, 5000),
            }),
            "key" => value
                .get("key")
                .and_then(Value::as_str)
                .map(|k| Gesture::Key { key: k.to_string() }),
            "text" => value
                .get("text")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(|t| Gesture::Text {
                    text: t.to_string(),
                }),
            _ => None,
        }
    }
}

/// 通道元数据(面板据此选择渲染方式:canvas 解码 H.264 / img 显示 PNG)。
#[derive(Debug, Clone)]
pub struct ChannelMeta {
    /// `scrcpy`(H.264 实时)| `frames`(截图轮询)| 源自定义值。
    pub mode: String,
    /// 设备物理分辨率(坐标映射用)。
    pub width: i64,
    pub height: i64,
    /// 视频尺寸(scrcpy codec meta 就绪后写入)。
    pub vw: Option<u32>,
    pub vh: Option<u32>,
    /// 降级原因(scrcpy 不可用时给面板展示)。
    pub error: Option<String>,
}

impl Default for ChannelMeta {
    fn default() -> Self {
        Self {
            mode: "frames".to_string(),
            width: 0,
            height: 0,
            vw: None,
            vh: None,
            error: None,
        }
    }
}

/// 一条直播通道(帧枢纽的最小单位)。
pub struct Channel {
    id: String,
    kind: String,
    meta: watch::Sender<ChannelMeta>,
    takeover: AtomicBool,
    ring: Mutex<PacketRing>,
    frames: broadcast::Sender<Vec<u8>>,
    input_tx: mpsc::UnboundedSender<LiveInput>,
    /// 输入接收端:源启动时取走(单owner);未取走时缓冲在通道里。
    input_rx: Mutex<Option<mpsc::UnboundedReceiver<LiveInput>>>,
    subscribers: AtomicUsize,
    closed: AtomicBool,
}

impl Channel {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    /// 当前元数据快照。
    pub fn meta(&self) -> ChannelMeta {
        self.meta.borrow().clone()
    }

    /// 订阅元数据变化(scrcpy 就绪即从 frames 升级 scrcpy)。
    pub fn meta_rx(&self) -> watch::Receiver<ChannelMeta> {
        self.meta.subscribe()
    }

    /// 合并更新元数据。
    pub fn patch_meta(&self, patch: impl FnOnce(&mut ChannelMeta)) {
        self.meta.send_modify(patch);
    }

    /// 推一帧(广播 + 进环)。
    pub fn push_frame(&self, kind: u8, flags: u8, payload: &[u8]) {
        let encoded = crate::frames::encode_frame(kind, flags, payload);
        if let Ok(mut ring) = self.ring.lock() {
            ring.push(kind, flags, encoded.clone());
        }
        let _ = self.frames.send(encoded);
    }

    /// 推一帧 PNG 截图(轮询模式便利封装)。
    pub fn push_png(&self, bytes: &[u8]) {
        self.push_frame(MSG_PNG, 0, bytes);
    }

    /// 环形缓冲当前字节数(面板/诊断展示)。
    pub fn ring_bytes(&self) -> usize {
        self.ring.lock().map(|r| r.bytes()).unwrap_or(0)
    }

    /// 订阅:返回「重放帧」+ 后续实时帧的接收端。
    pub fn subscribe(&self) -> (Vec<Vec<u8>>, broadcast::Receiver<Vec<u8>>) {
        self.subscribers.fetch_add(1, Ordering::SeqCst);
        let replay = self.ring.lock().map(|r| r.replay()).unwrap_or_default();
        (replay, self.frames.subscribe())
    }

    /// 退订;返回退订后的订阅者数。
    pub fn unsubscribe(&self) -> usize {
        self.subscribers
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1)
    }

    pub fn subscribers(&self) -> usize {
        self.subscribers.load(Ordering::SeqCst)
    }

    pub fn input_tx(&self) -> &mpsc::UnboundedSender<LiveInput> {
        &self.input_tx
    }

    /// 取走输入接收端(源启动时调用,单 owner;重复调用返回 None)。
    pub fn take_input_rx(&self) -> Option<mpsc::UnboundedReceiver<LiveInput>> {
        self.input_rx.lock().ok()?.take()
    }

    pub fn takeover(&self) -> bool {
        self.takeover.load(Ordering::SeqCst)
    }

    pub fn set_takeover(&self, active: bool) {
        self.takeover.store(active, Ordering::SeqCst);
    }

    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// 通道摘要(`ui.live_status` / 诊断用)。
#[derive(Debug, Clone)]
pub struct ChannelInfo {
    pub id: String,
    pub kind: String,
    pub subscribers: usize,
    pub takeover: bool,
    pub ring_bytes: usize,
    pub meta: ChannelMeta,
}

/// 帧枢纽(两个宿主各持一份;sidecar 侧由 WS server 与 UI 方法面共享)。
#[derive(Default)]
pub struct FrameHub {
    channels: Mutex<HashMap<String, Arc<Channel>>>,
    /// 一次性令牌 → 通道 id(握手成功后即消费)。
    tokens: Mutex<HashMap<String, String>>,
}

impl FrameHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册(或取回既有)通道;返回通道句柄供源推帧。
    ///
    /// 幂等:同 id 重复 open 返回既有通道(源重启不丢订阅者)。
    pub fn open(&self, id: &str, kind: &str, meta: ChannelMeta) -> Result<Arc<Channel>, String> {
        if !valid_channel_id(id) {
            return Err(format!("直播通道 id 非法: {id:?}"));
        }
        let mut channels = self
            .channels
            .lock()
            .map_err(|_| "帧枢纽锁失效".to_string())?;
        if let Some(existing) = channels.get(id) {
            existing.mark_open();
            return Ok(existing.clone());
        }
        let (frames, _) = broadcast::channel(256);
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let (meta_tx, _meta_rx) = watch::channel(meta);
        let channel = Arc::new(Channel {
            id: id.to_string(),
            kind: kind.to_string(),
            meta: meta_tx,
            takeover: AtomicBool::new(false),
            ring: Mutex::new(PacketRing::new()),
            frames,
            input_tx,
            input_rx: Mutex::new(Some(input_rx)),
            subscribers: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
        });
        channels.insert(id.to_string(), channel.clone());
        Ok(channel)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Channel>> {
        self.channels.lock().ok()?.get(id).cloned()
    }

    /// 关闭通道:摘除 + 打标记(源的循环据此退出),订阅者数清零。
    pub fn close(&self, id: &str) {
        if let Ok(mut channels) = self.channels.lock() {
            if let Some(channel) = channels.remove(id) {
                channel.mark_closed();
                channel.subscribers.store(0, Ordering::SeqCst);
            }
        }
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.retain(|_, target| target != id);
        }
    }

    pub fn list(&self) -> Vec<ChannelInfo> {
        let Ok(channels) = self.channels.lock() else {
            return Vec::new();
        };
        let mut out: Vec<ChannelInfo> = channels
            .values()
            .map(|channel| ChannelInfo {
                id: channel.id().to_string(),
                kind: channel.kind().to_string(),
                subscribers: channel.subscribers(),
                takeover: channel.takeover(),
                ring_bytes: channel.ring_bytes(),
                meta: channel.meta(),
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// 签发一次性令牌(bridge 每次代理新连接前调用)。
    pub fn issue_token(&self, id: &str) -> Result<String, String> {
        if self.get(id).is_none() {
            return Err(format!("直播通道未打开: {id}"));
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.tokens
            .lock()
            .map_err(|_| "帧枢纽锁失效".to_string())?
            .insert(token.clone(), id.to_string());
        Ok(token)
    }

    /// 兑换令牌(一次性);通道不存在或令牌无效都返回 None。
    pub fn redeem(&self, token: &str) -> Option<Arc<Channel>> {
        let id = self
            .tokens
            .lock()
            .ok()
            .and_then(|mut tokens| tokens.remove(token))?;
        self.get(&id)
    }

    pub fn set_takeover(&self, id: &str, active: bool) -> bool {
        match self.get(id) {
            Some(channel) => {
                channel.set_takeover(active);
                true
            }
            None => false,
        }
    }

    /// 接管中?(`android:<serial>` 通道;域名工具的 `TakeoverState` seam 用它)。
    pub fn is_takeover(&self, id: &str) -> bool {
        self.get(id).map(|c| c.takeover()).unwrap_or(false)
    }

    /// 下发人工输入(接管时才允许;调用方负责 423 语义)。
    pub fn send_input(&self, id: &str, input: LiveInput) -> Result<(), String> {
        let channel = self
            .get(id)
            .ok_or_else(|| format!("直播通道未打开: {id}"))?;
        channel
            .input_tx
            .send(input)
            .map_err(|_| "直播通道已停止(源退出)".to_string())
    }
}

impl Channel {
    fn mark_open(&self) {
        self.closed.store(false, Ordering::SeqCst);
    }
}

/// 通道 id 白名单:`android:<serial>`,serial 过白名单形态
/// (防路径/查询注入:通道 id 会进 WS URL)。
///
/// M3 定稿只有 Android 一个帧源,因此 kind 只接受 `android`——不接受的 kind 在
/// 这里就拒掉,比留到 `ui.live_open` 再报「不支持」更早失败。
pub fn valid_channel_id(id: &str) -> bool {
    let Some((kind, target)) = id.split_once(':') else {
        return false;
    };
    if kind != KIND_ANDROID {
        return false;
    }
    !target.is_empty()
        && target.len() <= 96
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hub_with_channel() -> (FrameHub, Arc<Channel>) {
        let hub = FrameHub::new();
        let channel = hub
            .open("android:serial-a", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        (hub, channel)
    }

    #[test]
    fn open_is_idempotent_and_keeps_subscribers() {
        let (hub, channel) = hub_with_channel();
        let (_replay, _rx) = channel.subscribe();
        let again = hub
            .open("android:serial-a", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        assert_eq!(again.subscribers(), 1, "重复 open 不重建通道");
        assert_eq!(hub.list().len(), 1);
    }

    #[test]
    fn push_frame_broadcasts_and_replays_for_late_joiners() {
        let (hub, channel) = hub_with_channel();
        channel.push_png(b"first");
        let (replay, mut rx) = channel.subscribe();
        assert_eq!(replay.len(), 1, "迟到者立刻拿到最新一帧");
        channel.push_png(b"second");
        let got = rx.try_recv().unwrap();
        assert_eq!(
            crate::frames::decode_frame(&got).unwrap().2,
            b"second",
            "实时帧走广播"
        );
        drop(rx);
        hub.close("android:serial-a");
        assert!(hub.get("android:serial-a").is_none());
    }

    #[test]
    fn tokens_are_single_use_and_bound_to_a_channel() {
        let (hub, _channel) = hub_with_channel();
        let token = hub.issue_token("android:serial-a").unwrap();
        assert_eq!(token.len(), 32, "uuid simple 形态");
        let redeemed = hub.redeem(&token).expect("首次兑换成功");
        assert_eq!(redeemed.id(), "android:serial-a");
        assert!(hub.redeem(&token).is_none(), "一次性:第二次失效");
        assert!(hub.issue_token("android:missing").is_err());
        assert!(hub.redeem("nonsense").is_none());
    }

    #[test]
    fn close_drops_tokens_of_that_channel() {
        let (hub, _channel) = hub_with_channel();
        let token = hub.issue_token("android:serial-a").unwrap();
        hub.close("android:serial-a");
        assert!(hub.redeem(&token).is_none(), "通道关了令牌即废");
    }

    #[test]
    fn takeover_roundtrip_and_input_delivery() {
        let (hub, channel) = hub_with_channel();
        assert!(!hub.is_takeover("android:serial-a"));
        assert!(hub.set_takeover("android:serial-a", true));
        assert!(hub.is_takeover("android:serial-a"));
        assert!(!hub.set_takeover("android:missing", true), "通道不存在");

        let mut rx = channel.take_input_rx().expect("接收端可取走一次");
        hub.send_input("android:serial-a", LiveInput::SetTakeover(false))
            .unwrap();
        assert!(matches!(
            rx.try_recv().unwrap(),
            LiveInput::SetTakeover(false)
        ));
        hub.send_input(
            "android:serial-a",
            LiveInput::Gesture(Gesture::Tap { x: 1, y: 2 }),
        )
        .unwrap();
        assert!(matches!(
            rx.try_recv().unwrap(),
            LiveInput::Gesture(Gesture::Tap { x: 1, y: 2 })
        ));
        assert!(channel.take_input_rx().is_none(), "只能取走一次");
        assert!(hub
            .send_input("android:missing", LiveInput::SetTakeover(true))
            .is_err());
    }

    #[test]
    fn channel_id_whitelist() {
        assert!(valid_channel_id("android:emulator-5554"));
        assert!(valid_channel_id("android:192.168.1.5:43217"));
        // M3 定稿:只有 Android 一个帧源(browser / 沙箱桌面由 dsh 原生承接)
        assert!(!valid_channel_id("browser:page-1"), "browser 帧源已去掉");
        assert!(!valid_channel_id("desktop:inst-1"), "沙箱桌面帧源已去掉");
        assert!(!valid_channel_id("android"));
        assert!(!valid_channel_id("android:"));
        assert!(!valid_channel_id(":x"));
        assert!(!valid_channel_id("evil:x"));
        assert!(!valid_channel_id("android:a b"));
        assert!(!valid_channel_id("android:$(reboot)"));
        assert!(!valid_channel_id("android:/etc/passwd"));
        assert!(!valid_channel_id(&format!("android:{}", "a".repeat(97))));
    }

    #[test]
    fn gesture_parse_matches_the_tauri_live_page_shape() {
        assert!(matches!(
            Gesture::parse(&json!({"type":"tap","x":10,"y":20})).unwrap(),
            Gesture::Tap { x: 10, y: 20 }
        ));
        match Gesture::parse(&json!({"type":"swipe","x1":1,"y1":2,"x2":3,"y2":4})).unwrap() {
            Gesture::Swipe { ms, .. } => assert_eq!(ms, 300, "ms 缺省 300"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            Gesture::parse(&json!({"type":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"ms":99999}))
                .unwrap(),
            Gesture::Swipe { ms: 5000, .. }
        ));
        assert!(
            matches!(
                Gesture::parse(&json!({"type":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"ms":10}))
                    .unwrap(),
                Gesture::Swipe { ms: 50, .. }
            ),
            "ms 钳制下限 50"
        );
        assert!(matches!(
            Gesture::parse(&json!({"type":"key","key":"back"})).unwrap(),
            Gesture::Key { .. }
        ));
        assert!(matches!(
            Gesture::parse(&json!({"type":"text","text":"hi"})).unwrap(),
            Gesture::Text { .. }
        ));
        // 形状不完整 / 未知类型 / 空文本一律拒绝(与 Tauri 的 400 分支同语义)
        assert!(Gesture::parse(&json!({"type":"tap","x":1})).is_none());
        assert!(Gesture::parse(&json!({"type":"nope"})).is_none());
        assert!(Gesture::parse(&json!({"type":"text","text":""})).is_none());
    }
}
