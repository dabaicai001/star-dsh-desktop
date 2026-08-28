//! Windows WebView2 CDP 后端(M2 增强层)。
//!
//! 经 `ICoreWebView2.CallDevToolsProtocolMethod`(异步完成回调,不阻塞 UI 线程)
//! 执行 Chromium DevTools Protocol 命令,能力对齐 Playwright 内核:
//! - `Runtime.evaluate`(awaitPromise + returnByValue):eval 结果直达,免 IPC 桥;
//! - `Page.captureScreenshot`:页面 PNG 截图;
//! - `Input.dispatchMouseEvent / insertText / dispatchKeyEvent`:**可信输入事件**,
//!   能过大部分站点的机器人检测(JS 注入分发的是 untrusted 事件,部分站点拒绝)。
//!
//! 无痕说明:wry incognito → WebView2 InPrivate 控制器,CDP 在 InPrivate 下可用。

use serde_json::Value;
use std::time::Duration;
use tauri::WebviewWindow;
use tokio::sync::oneshot;

/// 单次 CDP 调用超时(Runtime.evaluate 带 awaitPromise 时页面脚本可能很慢)。
const CDP_TIMEOUT: Duration = Duration::from_secs(30);

/// 执行一条 CDP 命令,返回结果 JSON(WebView2 返回的是 JSON 字符串)。
async fn call_method(
    window: &WebviewWindow,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let method_h = HSTRING::from(method);
    let params_h = HSTRING::from(params.to_string());
    let method_owned = method.to_string();
    let method_for_log = method_owned.clone();
    window
        .with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(core) => core,
                Err(e) => {
                    let _ = tx.send(Err(format!("获取 CoreWebView2 失败:{e}")));
                    return;
                }
            };
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |error_code, result_json| {
                    let _ = tx.send(match error_code {
                        Ok(()) => Ok(result_json),
                        Err(e) => Err(format!("CDP {method_owned} 执行失败:{e}")),
                    });
                    Ok(())
                },
            ));
            if let Err(e) = core.CallDevToolsProtocolMethod(&method_h, &params_h, &handler) {
                tracing::warn!("CDP {method_for_log} 发起失败:{e}");
            }
        })
        .map_err(|e| format!("CDP {method} 无法进入 webview 主线程:{e}"))?;

    let json = match tokio::time::timeout(CDP_TIMEOUT, rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => return Err(format!("CDP {method} 应答通道已关闭")),
        Err(_) => return Err(format!("CDP {method} 超时({}s)", CDP_TIMEOUT.as_secs())),
    };
    if json.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&json).map_err(|e| format!("CDP {method} 返回非 JSON:{e}"))
}

/// `Runtime.evaluate`:awaitPromise + returnByValue;表达式抛错时返回 Err(异常文本)。
/// `body` 按函数体执行(与 script::wrap_eval 的语义一致:末尾 `return` 取值)。
pub async fn runtime_evaluate(window: &WebviewWindow, body: &str) -> Result<Value, String> {
    let expression = format!("(function() {{\n{body}\n}})()");
    let result = call_method(
        window,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": expression,
            "awaitPromise": true,
            "returnByValue": true,
            "userGesture": true,
        }),
    )
    .await?;
    if let Some(details) = result.get("exceptionDetails") {
        let text = details
            .pointer("/exception/description")
            .or_else(|| details.pointer("/text"))
            .and_then(Value::as_str)
            .unwrap_or("页面脚本异常");
        return Err(format!("页面脚本异常:{text}"));
    }
    // returnByValue:原始值在 result.value;undefined/不可序列化时无 value 字段
    Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

/// `Page.captureScreenshot`:返回 PNG 字节(base64 解码后)。
pub async fn capture_screenshot(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let result = call_method(
        window,
        "Page.captureScreenshot",
        serde_json::json!({ "format": "png", "fromSurface": true }),
    )
    .await?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "Page.captureScreenshot 返回缺少 data".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("截图 base64 解码失败:{e}"))
}

/// `Input.dispatchMouseEvent`:视口坐标(CSS 像素)上的可信左键单击。
pub async fn click_at(window: &WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    for event_type in ["mouseMoved", "mousePressed", "mouseReleased"] {
        let mut params = serde_json::json!({ "type": event_type, "x": x, "y": y });
        if event_type != "mouseMoved" {
            params["button"] = Value::String("left".to_string());
            params["clickCount"] = Value::from(1);
        }
        call_method(window, "Input.dispatchMouseEvent", params).await?;
    }
    Ok(())
}

/// `Input.insertText`:向当前焦点元素插入文本(可信,触发完整输入管线)。
pub async fn insert_text(window: &WebviewWindow, text: &str) -> Result<(), String> {
    call_method(
        window,
        "Input.insertText",
        serde_json::json!({ "text": text }),
    )
    .await?;
    Ok(())
}

/// 常见按键 → Windows 虚拟键码(与页面侧 script.rs 的 KEYCODES 表保持一致)。
fn virtual_key(key: &str) -> Option<(i64, &'static str)> {
    let pair = match key {
        "Enter" => (13, "Enter"),
        "Tab" => (9, "Tab"),
        "Escape" => (27, "Escape"),
        "Backspace" => (8, "Backspace"),
        "Delete" => (46, "Delete"),
        "ArrowUp" => (38, "ArrowUp"),
        "ArrowDown" => (40, "ArrowDown"),
        "ArrowLeft" => (37, "ArrowLeft"),
        "ArrowRight" => (39, "ArrowRight"),
        "Home" => (36, "Home"),
        "End" => (35, "End"),
        "PageUp" => (33, "PageUp"),
        "PageDown" => (34, "PageDown"),
        " " => (32, "Space"),
        _ => return None,
    };
    Some(pair)
}

/// `Input.dispatchKeyEvent`:可信按键(rawKeyDown + keyUp);不认识的键返回 None
/// 由调用方回退 JS 注入路径。
pub async fn press_key(window: &WebviewWindow, key: &str) -> Result<Option<()>, String> {
    let Some((vk, code)) = virtual_key(key) else {
        return Ok(None);
    };
    for event_type in ["rawKeyDown", "keyUp"] {
        call_method(
            window,
            "Input.dispatchKeyEvent",
            serde_json::json!({
                "type": event_type,
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
            }),
        )
        .await?;
    }
    Ok(Some(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_key_covers_common_keys() {
        for (key, vk) in [
            ("Enter", 13),
            ("Tab", 9),
            ("Escape", 27),
            ("Backspace", 8),
            ("ArrowDown", 40),
            (" ", 32),
        ] {
            let (code, _) = virtual_key(key).unwrap_or_else(|| panic!("缺按键 {key}"));
            assert_eq!(code, vk);
        }
        assert!(virtual_key("F12").is_none(), "未映射键走 JS 兜底");
    }
}
