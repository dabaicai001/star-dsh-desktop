//! 浏览器的 Tauri Command:页面侧 eval 结果回传 + 引擎设置读写。
//!
//! `browser_internal_result` 是 webview 后端页面侧 eval 回传桥(capabilities/browser.json
//! 把它作为 `ai-browser` 窗口唯一可调用的 app command——浏览器窗口加载不可信网页,
//! 绝不暴露其它命令面)。引擎设置(`browser_get_engine` / `browser_set_engine`)由
//! 设置页/宿主 UI 调用,读取与写入 settings 表。

use crate::browser::{self, obscura::Engine};
use tauri::Manager;

/// 页面注入脚本(script::wrap_eval)的 eval 结果回传:按 id 应答在途 oneshot。
/// 未知 id(导航后迟到的旧应答)静默丢弃,返回 Ok —— 对页面不可报错,
/// 否则旧上下文的迟到应答会变成页面侧 unhandled rejection。
#[tauri::command]
pub fn browser_internal_result(
    manager: tauri::State<'_, browser::BrowserManager>,
    id: String,
    ok: bool,
    payload: Option<String>,
) -> Result<(), String> {
    manager.resolve_pending(&id, ok, payload);
    Ok(())
}

/// 读取当前 AI 浏览器引擎设置(webview | obscura)。
#[tauri::command]
pub async fn browser_get_engine(app: tauri::AppHandle) -> Result<String, String> {
    let engine = browser::engine_setting(&app).await;
    Ok(match engine {
        Engine::Webview => "webview",
        Engine::Obscura => "obscura",
    }
    .to_string())
}

/// 设置 AI 浏览器引擎(webview | obscura);值非法报错。
#[tauri::command]
pub async fn browser_set_engine(
    app: tauri::AppHandle,
    engine: String,
) -> Result<(), String> {
    let engine = match engine.as_str() {
        "webview" => Engine::Webview,
        "obscura" => Engine::Obscura,
        other => return Err(format!("未知浏览器引擎「{other}」,只支持 webview/obscura")),
    };
    browser::save_engine_setting(&app, engine).await?;
    // 同步到管理器缓存,供注入协议/查看器立即感知。
    app.state::<browser::obscura::ObscuraManager>().set_engine(engine);
    Ok(())
}
