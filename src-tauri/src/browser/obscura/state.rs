//! Obscura 无头浏览器引擎:共享内部状态。
//!
//! [`ObscuraInner`] 是真正的状态所在(`Arc` 共享),同时实现 [`FrameSink`] 接收
//! screencast 帧。Tauri state 只是对它的薄包装,便于在命令与桥接层存取。

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

/// 取锁,中毒时取回内层数据继续用。live 协议处理器跑在 webview 同步线程,
/// `lock().expect(...)` 会因任何一次持锁 panic 级联毒化、让查看器窗口线程
/// 跟着 panic;这里宁可带病运行也不让 UI 线程崩。
pub(crate) fn plock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 共享内部状态(进程 + CDP 客户端 + 页面会话 + 输入泵 + 引擎设置)。
pub struct ObscuraInner {
    /// 引擎进程(kill_on_drop 兜底)。
    pub process: Mutex<Option<tokio::process::Child>>,
    /// 浏览器级 CDP 客户端。
    pub client: Mutex<Option<Arc<crate::browser::obscura::cdp::CdpClient>>>,
    /// 监听端口。
    pub port: Mutex<Option<u16>>,
    /// 启动互斥。
    pub starting: AtomicBool,
    /// 页面会话表:key → 会话状态。
    pub pages: Mutex<HashMap<String, PageState>>,
    /// 输入转发命令泵。
    pub cmds: Mutex<Option<tokio::sync::mpsc::UnboundedSender<LiveCmd>>>,
    /// 引擎设置缓存。
    pub engine: Mutex<Engine>,
}

impl ObscuraInner {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            process: Mutex::new(None),
            client: Mutex::new(None),
            port: Mutex::new(None),
            starting: AtomicBool::new(false),
            pages: Mutex::new(HashMap::new()),
            cmds: Mutex::new(None),
            engine: Mutex::new(Engine::Webview),
        })
    }
}

/// 引擎选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Webview,
    Obscura,
}

/// 页面会话状态。
pub struct PageState {
    pub session_id: String,
    pub url: String,
    pub title: String,
    pub seq: u64,
    pub frame: Mutex<Vec<u8>>,
    pub viewport: Mutex<(u32, u32)>,
}

impl PageState {
    pub fn new(session_id: &str, initial: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            url: initial.to_string(),
            title: String::new(),
            seq: 0,
            frame: Mutex::new(Vec::new()),
            viewport: Mutex::new((1280, 800)),
        }
    }
}

/// 查看器窗口输入命令。
///
/// 字段在 `crate::browser::obscura::mod.rs` 的 `run_live_cmd` 中以模式匹配读取;
/// 二进制 crate 中对 pub 枚举的 dead_code lint 与会误报,故抑制。
#[allow(dead_code)]
pub enum LiveCmd {
    Navigate { key: String, url: String },
    Back { key: String },
    Forward { key: String },
    Reload { key: String },
    Click { key: String, x: f64, y: f64 },
    DblClick { key: String, x: f64, y: f64 },
    Key { key: String, kbd: String, text: Option<String> },
    Scroll { key: String, direction: String, amount: i64 },
}

impl crate::browser::obscura::cdp::FrameSink for ObscuraInner {
    fn on_screencast_frame(
        &self,
        session_id: &str,
        seq: u64,
        data_base64: String,
        viewport: Option<(u32, u32)>,
    ) {
        use base64::Engine as _;
        // 解码失败直接丢帧,不用空数据覆盖上一帧(空帧会让 frame.jpg 变 204,
        // 直播黑屏且 seq 还在涨,排查时误以为流正常)。
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes())
        else {
            return;
        };
        let mut pages = plock(&self.pages);
        if let Some(state) = pages.values_mut().find(|s| s.session_id == session_id) {
            state.seq = seq.max(state.seq + 1);
            if let Some(vp) = viewport {
                *plock(&state.viewport) = vp;
            }
            *plock(&state.frame) = bytes;
        }
    }
}
