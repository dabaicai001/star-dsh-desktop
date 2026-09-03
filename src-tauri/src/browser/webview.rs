//! 浏览器引擎之一(wry webview 后端):无痕独立 Tauri 窗口 + eval 通道。
//!
//! 窗口:label = [`super::BROWSER_WINDOW_LABEL`],`WebviewWindowBuilder::incognito(true)`
//! (Windows WebView2 InPrivate / macOS WKWebView nonPersistent DataStore /
//! Linux WebKitGTK ephemeral WebContext,三平台由 wry 0.55 原生支持)。
//!
//! 控制通道双层:Windows 走 `super::cdp`(CDP,可信输入/截图/awaitPromise eval),
//! 其余平台(及 CDP 失败回退)走 [`super::script`] 注入 + `browser_internal_result`
//! IPC oneshot 桥。

use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use super::{BrowserAction, BrowserManager, BROWSER_WINDOW_LABEL};
use super::{script, EvalOutcome};

/// eval 桥超时(页面导航中途的在途请求随之超时收口)。
const EVAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 导航后等待文档就绪的轮询参数。
const NAV_READY_TIMEOUT: Duration = Duration::from_secs(10);
const NAV_READY_POLL: Duration = Duration::from_millis(300);

// ============================================================
// 窗口生命周期
// ============================================================

/// 确保浏览器窗口存在:已存在则聚焦复用;不存在则以无痕模式创建。
/// `url` 非空时创建即导航(复用已有窗口时不强制跳页,交给 browser_navigate)。
pub async fn ensure_window(
    app: &AppHandle,
    url: Option<&str>,
) -> Result<(WebviewWindow, bool), String> {
    if let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        window
            .set_focus()
            .map_err(|e| format!("聚焦 AI 浏览器窗口失败:{e}"))?;
        return Ok((window, false));
    }
    let initial = match url {
        Some(u) => script::normalize_url(u)?,
        None => "about:blank".to_string(),
    };
    let parsed = tauri::Url::parse(&initial).map_err(|e| format!("初始 URL 非法:{e}"))?;
    let window = WebviewWindowBuilder::new(
        app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::External(parsed),
    )
    .title("StarHub AI 浏览器(无痕)")
    .inner_size(1100.0, 760.0)
    .incognito(true)
    .build()
    .map_err(|e| format!("创建 AI 浏览器窗口失败:{e}"))?;
    Ok((window, true))
}

pub fn current_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or_else(|| "AI 浏览器窗口未打开,请先 browser_open".to_string())
}

// ============================================================
// eval 通道:Windows CDP 优先,失败/非 Windows 回退 IPC 桥
// ============================================================

/// 在页面执行一段 JS 函数体,拿 JSON 结果。
/// `body` 语义见 script::wrap_eval(内部调用恒带 return;browser_eval 同约定)。
async fn eval_in_page(app: &AppHandle, window: &WebviewWindow, body: &str) -> Result<Value, String> {
    #[cfg(windows)]
    {
        match super::cdp::runtime_evaluate(window, body).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                tracing::debug!("CDP Runtime.evaluate 回退 IPC 桥:{error}");
            }
        }
    }
    eval_via_ipc(app, window, body).await
}

/// IPC 桥 eval:注入脚本 → 页面 `browser_internal_result` 回传 → oneshot 收口。
async fn eval_via_ipc(
    app: &AppHandle,
    window: &WebviewWindow,
    body: &str,
) -> Result<Value, String> {
    let manager = app.state::<BrowserManager>();
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<EvalOutcome>();
    manager
        .pending
        .lock()
        .expect("browser pending map")
        .insert(id.clone(), tx);
    if let Err(e) = window.eval(&script::wrap_eval(&id, body)) {
        manager
            .pending
            .lock()
            .expect("browser pending map")
            .remove(&id);
        return Err(format!("注入脚本失败:{e}"));
    }
    let outcome = match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => return Err("eval 应答通道已关闭".to_string()),
        Err(_) => {
            manager
                .pending
                .lock()
                .expect("browser pending map")
                .remove(&id);
            return Err(format!(
                "eval 超时({}s):页面可能正在导航或未注入 IPC,稍后重试",
                EVAL_TIMEOUT.as_secs()
            ));
        }
    };
    let (ok, payload) = outcome;
    if !ok {
        return Err(format!(
            "页面脚本异常:{}",
            payload.unwrap_or_else(|| "未知错误".to_string())
        ));
    }
    match payload.as_deref() {
        None | Some("") | Some("null") => Ok(Value::Null),
        Some(text) => serde_json::from_str(text)
            .map_err(|e| format!("eval 结果不是合法 JSON:{e};原文:{text}"))
    }
}

/// eval 出字符串结果的便捷封装(页面侧返回 JSON string)。
async fn eval_text(app: &AppHandle, window: &WebviewWindow, body: &str) -> Result<String, String> {
    match eval_in_page(app, window, body).await? {
        Value::String(s) => Ok(s),
        Value::Null => Ok(String::new()),
        other => Ok(other.to_string()),
    }
}

/// 页面状态(url/title/readyState/scrollY),经 `__shb.state()` 取回。
async fn page_state(app: &AppHandle, window: &WebviewWindow) -> Result<Value, String> {
    let raw = eval_text(app, window, "return window.__shb.state();").await?;
    serde_json::from_str(&raw).map_err(|e| format!("页面状态解析失败:{e}"))
}

/// 导航后等文档就绪(轮询 readyState,超时静默放行——慢站点不阻塞工具结果)。
async fn wait_document_ready(app: &AppHandle, window: &WebviewWindow) {
    let deadline = std::time::Instant::now() + NAV_READY_TIMEOUT;
    loop {
        if let Ok(state) = page_state(app, window).await {
            if state.get("readyState").and_then(Value::as_str) == Some("complete") {
                return;
            }
        }
        if std::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(NAV_READY_POLL).await;
    }
}

/// 动作后回报:动作结果文本 + 最新页面状态(模型无需再补 browser_state)。
async fn with_state_suffix(
    app: &AppHandle,
    window: &WebviewWindow,
    action_text: String,
) -> String {
    match page_state(app, window).await {
        Ok(state) => {
            let url = state.get("url").and_then(Value::as_str).unwrap_or("");
            let title = state.get("title").and_then(Value::as_str).unwrap_or("");
            format!("{action_text}\n当前页面:{title} ({url})")
        }
        Err(_) => action_text,
    }
}

// ============================================================
// 工具执行(桥入口)
// ============================================================

/// webview 后端的动作执行(由 browser::execute_from_bridge 在 engine=webview 时分发)。
pub async fn execute_action(app: &AppHandle, action: BrowserAction) -> Result<String, String> {
    match action {
        BrowserAction::Open { url } => {
            let (_window, created) = ensure_window(app, url.as_deref()).await?;
            let window = current_window(app)?;
            wait_document_ready(app, &window).await;
            let verb = if created { "已打开" } else { "已聚焦" };
            let state = page_state(app, &window).await.unwrap_or(Value::Null);
            let current = state.get("url").and_then(Value::as_str).unwrap_or("about:blank");
            Ok(format!(
                "{verb}无痕 AI 浏览器窗口(独立窗口,用户可见 AI 的全部操作)。当前:{current}"
            ))
        }
        BrowserAction::Navigate { url } => {
            let (window, _) = ensure_window(app, None).await?;
            window
                .navigate(
                    tauri::Url::parse(&url).map_err(|e| format!("URL 解析失败:{e}"))?,
                )
                .map_err(|e| format!("导航失败:{e}"))?;
            wait_document_ready(app, &window).await;
            let state = page_state(app, &window).await.unwrap_or(Value::Null);
            let title = state.get("title").and_then(Value::as_str).unwrap_or("");
            Ok(format!("已导航到 {url}。页面标题:{title}"))
        }
        BrowserAction::Back | BrowserAction::Forward | BrowserAction::Reload => {
            let window = current_window(app)?;
            let call = match action {
                BrowserAction::Back => "history.back(); return 'back';",
                BrowserAction::Forward => "history.forward(); return 'forward';",
                _ => "location.reload(); return 'reload';",
            };
            let _ = eval_in_page(app, &window, call).await;
            wait_document_ready(app, &window).await;
            let label = match action {
                BrowserAction::Back => "后退",
                BrowserAction::Forward => "前进",
                _ => "刷新",
            };
            Ok(with_state_suffix(app, &window, format!("已{label}")).await)
        }
        BrowserAction::State => {
            let window = current_window(app)?;
            let state = page_state(app, &window).await?;
            Ok(serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
        }
        BrowserAction::Extract { max_chars } => {
            let window = current_window(app)?;
            eval_text(
                app,
                &window,
                &format!("return window.__shb.extract({max_chars});"),
            )
            .await
        }
        BrowserAction::Click { id } => {
            let window = current_window(app)?;
            // Windows:元素矩形 → CDP 可信点击;其余/失败:JS 分发 + el.click()。
            #[cfg(windows)]
            {
                let rect = eval_text(
                    app,
                    &window,
                    &format!("return window.__shb.rectOf({});", json_str(&id)),
                )
                .await
                .unwrap_or_default();
                if let Ok(point) = serde_json::from_str::<Value>(&rect) {
                    let x = point.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                    let y = point.get("y").and_then(Value::as_f64).unwrap_or(0.0);
                    if x > 0.0 || y > 0.0 {
                        if let Err(e) = super::cdp::click_at(&window, x, y).await {
                            tracing::debug!("CDP 可信点击失败,回退 JS 点击:{e}");
                        } else {
                            return Ok(with_state_suffix(
                                app,
                                &window,
                                format!("已点击元素 [{id}](可信输入,坐标 {x:.0},{y:.0})"),
                            )
                            .await);
                        }
                    }
                }
            }
            let text = eval_text(
                app,
                &window,
                &format!("return window.__shb.click({});", json_str(&id)),
            )
            .await?;
            Ok(with_state_suffix(app, &window, text).await)
        }
        BrowserAction::Type { id, text, clear } => {
            let window = current_window(app)?;
            // 先聚焦(必要时清空);Windows 再走 CDP insertText 可信输入。
            let focus = eval_text(
                app,
                &window,
                &format!(
                    "return window.__shb.focusEl({}, {});",
                    json_str(&id),
                    if clear { "true" } else { "false" }
                ),
            )
            .await?;
            if focus.starts_with("[Error]") {
                return Ok(focus);
            }
            #[cfg(windows)]
            {
                if let Err(e) = super::cdp::insert_text(&window, &text).await {
                    tracing::debug!("CDP insertText 失败,回退 JS 赋值:{e}");
                } else {
                    return Ok(with_state_suffix(
                        app,
                        &window,
                        format!("已向元素 [{id}] 输入 {} 字符(可信输入)", text.chars().count()),
                    )
                    .await);
                }
            }
            let result = eval_text(
                app,
                &window,
                &format!(
                    "return window.__shb.typeText({}, {}, {});",
                    json_str(&id),
                    json_str(&text),
                    if clear { "true" } else { "false" }
                ),
            )
            .await?;
            Ok(with_state_suffix(app, &window, result).await)
        }
        BrowserAction::PressKey { key } => {
            let window = current_window(app)?;
            #[cfg(windows)]
            {
                match super::cdp::press_key(&window, &key).await {
                    Ok(Some(())) => {
                        return Ok(format!("已按键 {key}(可信输入)"));
                    }
                    Ok(None) => {}
                    Err(e) => tracing::debug!("CDP 按键失败,回退 JS:{e}"),
                }
            }
            eval_text(
                app,
                &window,
                &format!("return window.__shb.pressKey({});", json_str(&key)),
            )
            .await
        }
        BrowserAction::SelectOption { id, value } => {
            let window = current_window(app)?;
            eval_text(
                app,
                &window,
                &format!(
                    "return window.__shb.selectOption({}, {});",
                    json_str(&id),
                    json_str(&value)
                ),
            )
            .await
        }
        BrowserAction::Scroll { direction, amount } => {
            let window = current_window(app)?;
            eval_text(
                app,
                &window,
                &format!("return window.__shb.scrollPage({}, {amount});", json_str(&direction)),
            )
            .await
        }
        BrowserAction::Screenshot => {
            let window = current_window(app)?;
            capture_screenshot_to_file(app, &window).await
        }
        BrowserAction::Eval { expression } => {
            let window = current_window(app)?;
            let value = eval_in_page(app, &window, &expression).await?;
            let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
            const MAX_EVAL_OUTPUT: usize = 8000;
            if text.chars().count() > MAX_EVAL_OUTPUT {
                let kept: String = text.chars().take(MAX_EVAL_OUTPUT).collect();
                Ok(format!("{kept}\n…(输出已截断至 {MAX_EVAL_OUTPUT} 字符)"))
            } else {
                Ok(text)
            }
        }
    }
}

/// JS 字符串字面量(嵌入注入脚本用,serde_json 转义)。
fn json_str(raw: &str) -> String {
    serde_json::to_string(raw).unwrap_or_else(|_| "\"\"".to_string())
}

/// 截图 → PNG 落盘(应用缓存目录 browser-shots/),返回模型可读路径与大小。
/// 图像内容暂不回灌模型上下文(dsh 工具结果为文本通道;视觉接入见调研文档 M3 备注)。
async fn capture_screenshot_to_file(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<String, String> {
    #[cfg(windows)]
    let png = super::cdp::capture_screenshot(window).await;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let png = super::snapshot::capture_png(window).await;
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let png: Result<Vec<u8>, String> = Err("当前平台不支持浏览器截图".to_string());

    let bytes = png?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("缓存目录不可用:{e}"))?
        .join("browser-shots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败:{e}"))?;
    let path = dir.join(format!("shot-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S-%3f")));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入截图失败:{e}"))?;
    Ok(format!(
        "已截图(可视区域 PNG,{} 字节),保存于:{}",
        bytes.len(),
        path.display()
    ))
}
