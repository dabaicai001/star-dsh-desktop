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

/// 读取 Jev 决策配置(设置 → AI 浏览器 的「Jev 决策」区;API key 走
/// `get_ai_model_api_key`,此处只返回非密项)。缺省全关。
#[tauri::command]
pub async fn browser_get_jev_config(app: tauri::AppHandle) -> Result<browser::decide::JevConfig, String> {
    Ok(browser::decide::jev_config(&app).await)
}

/// 保存 Jev 决策配置(启用开关/base_url/模型/阈值/超时/自动执行步数上限)。
/// 值非法报错;API key 不走本命令,由前端调 `set_ai_model_api_key({id:"jev"})` 写入。
#[tauri::command]
pub async fn browser_set_jev_config(
    app: tauri::AppHandle,
    enabled: bool,
    base_url: String,
    model: String,
    threshold: f64,
    timeout_ms: u64,
    auto_max_steps: u64,
) -> Result<(), String> {
    let config = browser::decide::JevConfig {
        enabled,
        base_url,
        model,
        threshold,
        timeout_ms,
        auto_max_steps,
    };
    config.validate()?;
    browser::decide::save_jev_config(&app, &config).await
}
