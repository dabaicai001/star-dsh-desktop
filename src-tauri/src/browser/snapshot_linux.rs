//! Linux WebKitGTK 截图(M3):`webkit_web_view_get_snapshot` 抓可视区域
//! (SNAPSHOT_REGION_VISIBLE),cairo Surface 直接编码 PNG。
//!
//! wry 没有暴露快照 API,这里用 `PlatformWebview::inner()` 返回的
//! `webkit2gtk::WebView` 句柄直接调 gtk-rs 绑定(版本与 wry 0.55 锁死 =2.0.2)。
//!
//! 线程模型:webkit2gtk 的异步快照要求调用线程持有 GLib MainContext——
//! `with_webview` 闭包派发到主线程执行,天然满足;结果经 std mpsc +
//! tokio oneshot 两级通道送回调用协程(闭包要求 'static + Send)。

use std::time::Duration;
use tauri::WebviewWindow;
use tokio::sync::oneshot;
use webkit2gtk::WebViewExt;
use webkit2gtk::{SnapshotOptions, SnapshotRegion};

/// 快照完成回调超时(页面渲染进程卡死时兜底)。
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);

/// 抓取 AI 浏览器窗口当前可视区域的 PNG 截图。
pub async fn capture_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let mut tx = Some(tx);
    window
        .with_webview(move |platform| {
            let webview = platform.inner();
            let callback = move |result: Result<cairo::Surface, webkit2gtk::glib::Error>| {
                let png = result
                    .map_err(|e| format!("WebKitGTK 快照失败:{e}"))
                    .and_then(|surface| {
                        let mut bytes = Vec::new();
                        surface
                            .write_to_png(&mut bytes)
                            .map_err(|e| format!("快照编码 PNG 失败:{e}"))?;
                        Ok(bytes)
                    });
                if let Some(tx) = tx.take() {
                    let _ = tx.send(png);
                }
            };
            webview.snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                callback,
            );
        })
        .map_err(|e| format!("无法进入 webview 主线程:{e}"))?;

    match tokio::time::timeout(SNAPSHOT_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("快照应答通道已关闭".to_string()),
        Err(_) => Err(format!("快照超时({}s)", SNAPSHOT_TIMEOUT.as_secs())),
    }
}
