//! AI 浏览器的 Tauri Command:页面侧 eval 结果回传。
//!
//! 只有 `browser_internal_result` 一条,且 capabilities/browser.json 把它作为
//! `ai-browser` 窗口(任意外部 origin)**唯一**可调用的 app command——
//! 浏览器窗口加载的是不可信网页,绝不暴露其它命令面。

use crate::browser::BrowserManager;

/// 页面注入脚本(script::wrap_eval)的 eval 结果回传:按 id 应答在途 oneshot。
/// 未知 id(导航后迟到的旧应答)静默丢弃,返回 Ok —— 对页面不可报错,
/// 否则旧上下文的迟到应答会变成页面侧 unhandled rejection。
#[tauri::command]
pub fn browser_internal_result(
    manager: tauri::State<'_, BrowserManager>,
    id: String,
    ok: bool,
    payload: Option<String>,
) -> Result<(), String> {
    manager.resolve_pending(&id, ok, payload);
    Ok(())
}
