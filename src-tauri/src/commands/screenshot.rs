//! AI 对话截图:区域截图(全屏遮罩 + 拖拽选区)。
//!
//! 截图由 [xcap] 提供(Windows WGC / macOS ScreenCaptureKit / Linux X11+Wayland),
//! 显示器坐标一律为物理像素;遮罩交互层是独立置顶窗口加载的静态页面
//! (`shell-placeholder/screenshot.html`),确认后把最终 PNG 字节回传主窗口。
//!
//! 会话状态([`ScreenshotSession`])只缓存「区域模式截取的桌面底图」:
//! 遮罩窗口创建前主窗口先隐藏,所以底图与最终截图都不含 StarHub 自身窗口。

use std::io::Cursor;
use std::sync::Mutex;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, ImageFormat, RgbaImage};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

/// 遮罩窗口 label(需出现在 capabilities 的 windows 列表里以保有 IPC 授权)。
pub const OVERLAY_LABEL: &str = "screenshot-overlay";
/// 截图结果事件:发往主窗口,payload 为 [`ScreenshotResult`]。
pub const RESULT_EVENT: &str = "screenshot:result";

/// 一台显示器的物理像素描述(遮罩前端用于拼底图、换算坐标)。
#[derive(Clone, serde::Serialize)]
pub struct ScreenshotMonitor {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

/// 截图会话状态(挂在 Tauri state 上):区域模式缓存的全屏底图。
#[derive(Default)]
pub struct ScreenshotSession {
    /// 拼接好的桌面底图 base64 dataURL(区域模式截取)。
    desktop: Mutex<Option<String>>,
    /// 底图对应的显示器列表(物理坐标)。
    monitors: Mutex<Vec<ScreenshotMonitor>>,
    /// 虚拟屏物理原点(拼接图左上角 = 各显示器坐标最小值)。
    origin: Mutex<(i32, i32)>,
    /// 统一缩放系数(取主显示器;混合 DPI 时按主屏处理)。
    scale: Mutex<f32>,
}

/// 主窗口收到的截图结果。
#[derive(Clone, serde::Serialize)]
pub struct ScreenshotResult {
    pub ok: bool,
    /// 确认时的最终 PNG 字节(取消时为 None)。
    pub data: Option<Vec<u8>>,
}

fn monitor_descs() -> Result<Vec<ScreenshotMonitor>, String> {
    let monitors = Monitor::all().map_err(|e| format!("enumerate monitors failed: {e}"))?;
    let mut descs = Vec::with_capacity(monitors.len());
    for m in monitors {
        descs.push(ScreenshotMonitor {
            x: m.x().map_err(|e| e.to_string())?,
            y: m.y().map_err(|e| e.to_string())?,
            width: m.width().map_err(|e| e.to_string())?,
            height: m.height().map_err(|e| e.to_string())?,
            scale_factor: m.scale_factor().map_err(|e| e.to_string())?,
            is_primary: m.is_primary().map_err(|e| e.to_string())?,
        });
    }
    if descs.is_empty() {
        return Err("no monitor found".to_string());
    }
    Ok(descs)
}

/// 桌面底图负载:(base64 dataURL JPEG, 显示器列表, 虚拟屏物理原点)。
/// 用 base64 字符串传输:IPC 的 JSON 通道对 `Vec<u8>` 会序列化成巨型
/// number[],前端转换/解码容易出错(黑屏根因);字符串零歧义。
type DesktopCapture = (String, Vec<ScreenshotMonitor>, (i32, i32));

/// 截取全部显示器并拼接成一张虚拟屏底图(物理像素)。
/// @returns (base64 dataURL JPEG, 显示器列表, 虚拟屏物理原点)。
fn capture_desktop() -> Result<DesktopCapture, String> {
    let descs = monitor_descs()?;
    let x_min = descs.iter().map(|d| d.x).min().unwrap_or(0);
    let y_min = descs.iter().map(|d| d.y).min().unwrap_or(0);
    let x_max = descs
        .iter()
        .map(|d| d.x + d.width as i32)
        .max()
        .unwrap_or(0);
    let y_max = descs
        .iter()
        .map(|d| d.y + d.height as i32)
        .max()
        .unwrap_or(0);
    let total_w = (x_max - x_min) as u32;
    let total_h = (y_max - y_min) as u32;

    let mut canvas = RgbaImage::new(total_w, total_h);
    let monitors = Monitor::all().map_err(|e| format!("enumerate monitors failed: {e}"))?;
    for m in monitors {
        let img = m
            .capture_image()
            .map_err(|e| format!("capture monitor failed: {e}"))?;
        image::imageops::overlay(
            &mut canvas,
            &img,
            i64::from(m.x().map_err(|e| e.to_string())? - x_min),
            i64::from(m.y().map_err(|e| e.to_string())? - y_min),
        );
    }

    // 底图仅用于遮罩预览,JPEG 质量 85 足够且体积远小于 PNG。
    let mut buf = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut buf, ImageFormat::Jpeg)
        .map_err(|e| format!("encode desktop jpeg failed: {e}"))?;
    let data_url = format!("data:image/jpeg;base64,{}", BASE64.encode(buf.into_inner()));
    Ok((data_url, descs, (x_min, y_min)))
}

/// 隐藏主窗口(截图开始,避免截到 StarHub 自身)。
fn hide_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
}

/// 恢复主窗口并聚焦(截图结束)。
fn restore_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 关闭遮罩窗口(若存在)。
fn close_overlay(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.close();
    }
}

/// 创建遮罩窗口:覆盖虚拟屏、置顶、无边框、跳过任务栏、不可关(只能确认/取消)。
fn create_overlay(app: &AppHandle, state: &ScreenshotSession) -> Result<(), String> {
    close_overlay(app);
    let scale = *state.scale.lock().unwrap();
    let (x_min, y_min) = *state.origin.lock().unwrap();
    let (x_max, y_max) = {
        let monitors = state.monitors.lock().unwrap();
        (
            monitors
                .iter()
                .map(|d| d.x + d.width as i32)
                .max()
                .unwrap_or(0),
            monitors
                .iter()
                .map(|d| d.y + d.height as i32)
                .max()
                .unwrap_or(0),
        )
    };
    let width = ((x_max - x_min) as f32 / scale).ceil().max(1.0);
    let height = ((y_max - y_min) as f32 / scale).ceil().max(1.0);

    WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("screenshot.html".into()),
    )
    .title("StarHub 截图")
    .inner_size(width as f64, height as f64)
    .position(
        x_min as f64 / f64::from(scale),
        y_min as f64 / f64::from(scale),
    )
    .decorations(false)
    .transparent(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .build()
    .map_err(|e| format!("create screenshot overlay failed: {e}"))?;

    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.set_focus();
    }
    Ok(())
}

/// 列出所有显示器(物理像素)。
#[tauri::command]
pub fn screenshot_list_monitors() -> Result<Vec<ScreenshotMonitor>, String> {
    monitor_descs()
}

/// 开始区域截图:隐藏主窗口 → 截桌面底图 → 弹出遮罩窗口。
/// 截屏走 blocking 线程 + 10s 超时:WGC/GPU 异常卡住时不能把用户锁死在
/// 「主窗口已隐藏、遮罩未弹出」的黑屏态,任何失败都恢复主窗口。
#[tauri::command]
pub async fn screenshot_begin_region(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotSession>,
) -> Result<(), String> {
    hide_main(&app);
    const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
    let captured = tokio::time::timeout(
        CAPTURE_TIMEOUT,
        tokio::task::spawn_blocking(capture_desktop),
    )
    .await;
    let (jpeg, monitors, origin) = match captured {
        Ok(Ok(Ok(v))) => v,
        Ok(Ok(Err(e))) => {
            restore_main(&app);
            return Err(format!("截屏失败: {e}"));
        }
        Ok(Err(e)) => {
            restore_main(&app);
            return Err(format!("截屏线程异常: {e}"));
        }
        Err(_) => {
            restore_main(&app);
            return Err("截屏超时(10s)".to_string());
        }
    };
    let scale = monitors
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| monitors.first())
        .map(|d| d.scale_factor)
        .unwrap_or(1.0);
    *state.desktop.lock().unwrap() = Some(jpeg);
    *state.monitors.lock().unwrap() = monitors;
    *state.origin.lock().unwrap() = origin;
    *state.scale.lock().unwrap() = scale;
    create_overlay(&app, &state).inspect_err(|_| restore_main(&app))
}

/// 遮罩页面取底图:返回缓存的全屏 JPEG + 显示器列表 + 虚拟屏原点。
#[tauri::command]
pub fn screenshot_get_desktop(
    state: tauri::State<'_, ScreenshotSession>,
) -> Result<DesktopCapture, String> {
    let desktop = state.desktop.lock().unwrap().clone();
    let monitors = state.monitors.lock().unwrap().clone();
    let origin = *state.origin.lock().unwrap();
    match desktop {
        Some(jpeg) => Ok((jpeg, monitors, origin)),
        None => Err("no desktop capture cached (call screenshot_begin_region first)".to_string()),
    }
}

/// 确认截图:关闭遮罩、恢复主窗口、把最终 base64 PNG 发往主窗口
/// (解码回字节后经事件传回,主窗口侧收到 Uint8Array 转 File)。
#[tauri::command]
pub fn screenshot_finish(app: AppHandle, data: String) -> Result<(), String> {
    // 前端传裸 base64(去 dataURL 前缀)。
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("decode screenshot data failed: {e}"))?;
    let result = ScreenshotResult {
        ok: true,
        data: Some(bytes),
    };
    let _ = app.emit(RESULT_EVENT, result);
    close_overlay(&app);
    restore_main(&app);
    Ok(())
}

/// 取消截图:关闭遮罩、恢复主窗口、通知主窗口未产生结果。
#[tauri::command]
pub fn screenshot_cancel(app: AppHandle) -> Result<(), String> {
    let result = ScreenshotResult {
        ok: false,
        data: None,
    };
    let _ = app.emit(RESULT_EVENT, result);
    close_overlay(&app);
    restore_main(&app);
    Ok(())
}
