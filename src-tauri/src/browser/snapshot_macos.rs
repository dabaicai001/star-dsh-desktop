//! macOS WKWebView 截图(M3):`takeSnapshotWithConfiguration:completionHandler:`
//! 抓可视区域快照,NSImage → TIFF → NSBitmapImageRep → PNG。
//!
//! wry 没有暴露快照 API(上游 wry 0.55 无通用 screenshot 能力),这里经
//! `PlatformWebview::inner()` 拿 WKWebView 原始指针直接调 objc2 绑定——属于
//! 「DSH/wry 扩展点无法表达 + 改动最小」的本侧补丁,锁定在单个模块内。
//!
//! 线程模型:`with_webview` 闭包在主线程执行,takeSnapshot 完成回调也回主线程;
//! 结果经 oneshot 送回调用协程,绝不阻塞主线程等待(否则回调永远到不了 = 死锁)。

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
};
use objc2_foundation::{NSDictionary, NSError};
use objc2_web_kit::WKWebView;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::WebviewWindow;
use tokio::sync::oneshot;

/// 快照完成回调超时(页面渲染进程卡死时兜底)。
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);

/// NSImage → PNG 字节(TIFF 中转,不依赖 CoreGraphics 直接栈)。
fn image_to_png(image: &NSImage) -> Result<Vec<u8>, String> {
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "NSImage 转 TIFF 失败".to_string())?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "TIFF 解码为位图失败".to_string())?;
    let empty: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
        NSDictionary::new();
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty) }
        .ok_or_else(|| "位图编码 PNG 失败".to_string())?;
    Ok(png.to_vec())
}

/// 抓取 AI 浏览器窗口当前可视区域的 PNG 截图。
pub async fn capture_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let shared = Arc::new(Mutex::new(Some(tx)));
    window
        .with_webview(move |platform| {
            let wk = platform.inner() as *mut WKWebView;
            if wk.is_null() {
                if let Some(tx) = shared.lock().expect("snapshot sender").take() {
                    let _ = tx.send(Err("WKWebView 句柄为空".to_string()));
                }
                return;
            }
            let shared = Arc::clone(&shared);
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result: Result<Vec<u8>, String> = unsafe {
                    if !error.is_null() {
                        let desc = (*error).localizedDescription();
                        Err(format!("WKWebView 快照失败:{}", &*desc))
                    } else if image.is_null() {
                        Err("WKWebView 快照返回空图像".to_string())
                    } else {
                        image_to_png(&*image)
                    }
                };
                if let Some(tx) = shared.lock().expect("snapshot sender").take() {
                    let _ = tx.send(result);
                }
            });
            let webview = unsafe { &*wk };
            unsafe {
                webview.takeSnapshotWithConfiguration_completionHandler(None, &block);
            }
        })
        .map_err(|e| format!("无法进入 webview 主线程:{e}"))?;

    match tokio::time::timeout(SNAPSHOT_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("快照应答通道已关闭".to_string()),
        Err(_) => Err(format!("快照超时({}s)", SNAPSHOT_TIMEOUT.as_secs())),
    }
}
