//! AI 浏览器(M1+M2+M3):无痕独立 Tauri 窗口,AI 经 Function Calling 全权操作,
//! 用户全程可见。
//!
//! 架构(调研见 docs/AI浏览器插件调研.md,窗口形态按需求调整为独立无痕窗口):
//! - 窗口:label = [`BROWSER_WINDOW_LABEL`],`WebviewWindowBuilder::incognito(true)`
//!   —— Windows WebView2 InPrivate / macOS WKWebView nonPersistent DataStore /
//!   Linux WebKitGTK ephemeral WebContext,三平台均由 wry 0.55 原生支持;
//! - 控制通道双层:Windows 走 [`cdp`](CDP,可信输入/截图/awaitPromise eval),
//!   其余平台(及 CDP 失败回退)走 [`script`] 注入 + `browser_internal_result`
//!   IPC oneshot 桥;
//! - 截图:Windows CDP Page.captureScreenshot / macOS WKWebView takeSnapshot
//!   (snapshot_macos.rs)/ Linux WebKitGTK get_snapshot(snapshot_linux.rs);
//! - 工具分发:harness/tools.rs 把 [`BROWSER_TOOLS`] 内的调用路由到
//!   [`execute_from_bridge`];风险分级在 dsh 侧 starhub-approval-bridge。
//!
//! 安全边界:浏览器窗口加载任意外部网页,capabilities/browser.json 只授予
//! `browser-eval-result` 一条命令权限(外部 origin 经 remote.urls 匹配),
//! 页面拿不到任何其它 app command;导航协议白名单见 script::normalize_url。

pub mod script;

#[cfg(windows)]
mod cdp;
#[cfg(target_os = "macos")]
#[path = "snapshot_macos.rs"]
mod snapshot;
#[cfg(target_os = "linux")]
#[path = "snapshot_linux.rs"]
mod snapshot;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use super::harness::HostBridgeState;

/// AI 浏览器窗口 label(capabilities/browser.json 按此收窄权限)。
pub const BROWSER_WINDOW_LABEL: &str = "ai-browser";

/// 浏览器域工具名全集(与 vendor packages/starhub/tools/src/index.ts 的
/// BRIDGED_TOOLS、approval-bridge 的 STARHUB_DOMAIN_TOOLS 对齐)。
pub const BROWSER_TOOLS: &[&str] = &[
    "browser_open",
    "browser_navigate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_state",
    "browser_extract",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_select_option",
    "browser_scroll",
    "browser_screenshot",
    "browser_eval",
];

/// eval 桥超时(页面导航中途的在途请求随之超时收口)。
const EVAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 导航后等待文档就绪的轮询参数。
const NAV_READY_TIMEOUT: Duration = Duration::from_secs(10);
const NAV_READY_POLL: Duration = Duration::from_millis(300);

/// 页面 eval 的一次应答:ok + JSON 字符串载荷(页面侧已 JSON.stringify)。
type EvalOutcome = (bool, Option<String>);

/// 在途 eval 请求登记表(browser_internal_result 命令按 id 应答)。
#[derive(Default)]
pub struct BrowserManager {
    pending: Mutex<HashMap<String, oneshot::Sender<EvalOutcome>>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 页面 JS 回传:应答按 id 配对;未知 id(导航后迟到的旧应答)丢弃并记日志。
    pub fn resolve_pending(&self, id: &str, ok: bool, payload: Option<String>) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("browser pending map")
            .remove(id);
        match sender {
            Some(tx) => {
                let _ = tx.send((ok, payload));
                true
            }
            None => {
                tracing::debug!("浏览器 eval 迟到的应答(无在途请求): {id}");
                false
            }
        }
    }

    /// 窗口被用户关闭/销毁时,全部在途 eval 以失败收口(避免调用方挂到超时)。
    pub fn fail_all_pending(&self, reason: &str) -> usize {
        let mut pending = self.pending.lock().expect("browser pending map");
        let count = pending.len();
        for (id, tx) in pending.drain() {
            tracing::debug!("浏览器窗口关闭,在途 eval 失败收口: {id}");
            let _ = tx.send((false, Some(reason.to_string())));
        }
        count
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("browser pending map").len()
    }
}

// ============================================================
// 工具参数 → 动作(纯解析层,无 GUI 依赖,单测覆盖)
// ============================================================

/// 校验后的浏览器动作。执行层只认这个枚举,模型传入的原始 JSON 在此收口。
#[derive(Debug, Clone, PartialEq)]
pub enum BrowserAction {
    Open { url: Option<String> },
    Navigate { url: String },
    Back,
    Forward,
    Reload,
    State,
    Extract { max_chars: usize },
    Click { id: String },
    Type { id: String, text: String, clear: bool },
    PressKey { key: String },
    SelectOption { id: String, value: String },
    Scroll { direction: String, amount: i64 },
    Screenshot,
    Eval { expression: String },
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim)
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    arg_str(args, key)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} 不能为空"))
}

/// 元素 id:extract 输出的编号(字符串数字)。
fn element_id(args: &Value) -> Result<String, String> {
    let id = required_str(args, "id")?;
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!(
            "id 必须是 browser_extract 输出里的元素编号(纯数字),收到「{id}」"
        ));
    }
    Ok(id)
}

/// 工具名 + 模型参数 → 校验后的动作;Err 为软错误文本(模型可纠正重试)。
pub fn parse_action(name: &str, args: &Value) -> Result<BrowserAction, String> {
    match name {
        "browser_open" => {
            let url = arg_str(args, "url")
                .filter(|s| !s.is_empty())
                .map(script::normalize_url)
                .transpose()?;
            Ok(BrowserAction::Open { url })
        }
        "browser_navigate" => Ok(BrowserAction::Navigate {
            url: script::normalize_url(&required_str(args, "url")?)?,
        }),
        "browser_back" => Ok(BrowserAction::Back),
        "browser_forward" => Ok(BrowserAction::Forward),
        "browser_reload" => Ok(BrowserAction::Reload),
        "browser_state" => Ok(BrowserAction::State),
        "browser_extract" => {
            let max_chars = args
                .get("max_chars")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|n| n.floor() as usize)
                .unwrap_or(script::DEFAULT_MAX_CHARS);
            Ok(BrowserAction::Extract { max_chars })
        }
        "browser_click" => Ok(BrowserAction::Click {
            id: element_id(args)?,
        }),
        "browser_type" => Ok(BrowserAction::Type {
            id: element_id(args)?,
            text: required_str(args, "text")?,
            clear: args.get("clear").and_then(Value::as_bool).unwrap_or(false),
        }),
        "browser_press_key" => Ok(BrowserAction::PressKey {
            key: required_str(args, "key")?,
        }),
        "browser_select_option" => Ok(BrowserAction::SelectOption {
            id: element_id(args)?,
            value: required_str(args, "value")?,
        }),
        "browser_scroll" => {
            let direction = arg_str(args, "direction").unwrap_or("down").to_lowercase();
            if !["up", "down", "top", "bottom"].contains(&direction.as_str()) {
                return Err(format!(
                    "未知滚动方向「{direction}」,只支持 up/down/top/bottom"
                ));
            }
            let amount = args
                .get("amount")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|n| n.floor() as i64)
                .unwrap_or(600);
            Ok(BrowserAction::Scroll { direction, amount })
        }
        "browser_screenshot" => Ok(BrowserAction::Screenshot),
        "browser_eval" => Ok(BrowserAction::Eval {
            expression: required_str(args, "expression")?,
        }),
        other => Err(format!("unsupported browser tool: {other}")),
    }
}

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

fn current_window(app: &AppHandle) -> Result<WebviewWindow, String> {
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
        match cdp::runtime_evaluate(window, body).await {
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

/// harness 桥入口:browser_* 工具在此分发执行,返回模型可读文本。
pub async fn execute_from_bridge(
    bridge: &HostBridgeState,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "应用句柄未就绪(启动序列未完成)".to_string())?;
    let action = parse_action(name, args)?;
    execute_action(&app, action).await
}

async fn execute_action(app: &AppHandle, action: BrowserAction) -> Result<String, String> {
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
                        if let Err(e) = cdp::click_at(&window, x, y).await {
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
                if let Err(e) = cdp::insert_text(&window, &text).await {
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
                match cdp::press_key(&window, &key).await {
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
    let png = cdp::capture_screenshot(window).await;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let png = snapshot::capture_png(window).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- parse_action ----------

    #[test]
    fn parse_open_and_navigate_normalize_urls() {
        let action = parse_action("browser_open", &json!({})).expect("open");
        assert_eq!(action, BrowserAction::Open { url: None });

        let action = parse_action("browser_open", &json!({"url": "example.com"})).expect("open url");
        assert_eq!(
            action,
            BrowserAction::Open {
                url: Some("https://example.com/".to_string())
            }
        );

        let action =
            parse_action("browser_navigate", &json!({"url": "http://a.internal:8080/x"}))
                .expect("navigate");
        assert_eq!(
            action,
            BrowserAction::Navigate {
                url: "http://a.internal:8080/x".to_string()
            }
        );

        assert!(parse_action("browser_navigate", &json!({"url": "javascript:alert(1)"})).is_err());
        assert!(parse_action("browser_navigate", &json!({})).is_err(), "缺 url 报错");
    }

    #[test]
    fn parse_element_actions_validate_numeric_id() {
        let action = parse_action("browser_click", &json!({"id": "12"})).expect("click");
        assert_eq!(action, BrowserAction::Click { id: "12".into() });

        for args in [json!({"id": "abc"}), json!({"id": "1');alert(1);//"}), json!({})] {
            assert!(
                parse_action("browser_click", &args).is_err(),
                "非法 id 必须拒绝:{args}"
            );
        }

        let action =
            parse_action("browser_type", &json!({"id": "3", "text": "hello", "clear": true}))
                .expect("type");
        assert_eq!(
            action,
            BrowserAction::Type {
                id: "3".into(),
                text: "hello".into(),
                clear: true
            }
        );

        let action =
            parse_action("browser_select_option", &json!({"id": "5", "value": "cn"}))
                .expect("select");
        assert_eq!(
            action,
            BrowserAction::SelectOption {
                id: "5".into(),
                value: "cn".into()
            }
        );
    }

    #[test]
    fn parse_scroll_defaults_and_validation() {
        let action = parse_action("browser_scroll", &json!({})).expect("scroll default");
        assert_eq!(
            action,
            BrowserAction::Scroll {
                direction: "down".into(),
                amount: 600
            }
        );
        let action = parse_action("browser_scroll", &json!({"direction": "TOP", "amount": 1200}))
            .expect("scroll top");
        assert_eq!(
            action,
            BrowserAction::Scroll {
                direction: "top".into(),
                amount: 1200
            }
        );
        assert!(parse_action("browser_scroll", &json!({"direction": "sideways"})).is_err());
    }

    #[test]
    fn parse_extract_caps_and_defaults() {
        let action = parse_action("browser_extract", &json!({})).expect("extract default");
        assert_eq!(
            action,
            BrowserAction::Extract {
                max_chars: script::DEFAULT_MAX_CHARS
            }
        );
        let action = parse_action("browser_extract", &json!({"max_chars": 2000})).expect("extract");
        assert_eq!(action, BrowserAction::Extract { max_chars: 2000 });
    }

    #[test]
    fn parse_stateless_actions_and_eval() {
        assert_eq!(
            parse_action("browser_back", &Value::Null).expect("back"),
            BrowserAction::Back
        );
        assert_eq!(
            parse_action("browser_forward", &Value::Null).expect("forward"),
            BrowserAction::Forward
        );
        assert_eq!(
            parse_action("browser_reload", &Value::Null).expect("reload"),
            BrowserAction::Reload
        );
        assert_eq!(
            parse_action("browser_state", &Value::Null).expect("state"),
            BrowserAction::State
        );
        assert_eq!(
            parse_action("browser_screenshot", &Value::Null).expect("shot"),
            BrowserAction::Screenshot
        );
        assert_eq!(
            parse_action("browser_press_key", &json!({"key": "Enter"})).expect("key"),
            BrowserAction::PressKey { key: "Enter".into() }
        );
        assert!(parse_action("browser_press_key", &json!({})).is_err());
        assert_eq!(
            parse_action("browser_eval", &json!({"expression": "return 1;"})).expect("eval"),
            BrowserAction::Eval {
                expression: "return 1;".into()
            }
        );
        assert!(parse_action("browser_eval", &json!({})).is_err());
        assert!(parse_action("browser_nope", &json!({})).is_err(), "未知工具报错");
    }

    #[test]
    fn browser_tools_table_covers_every_parseable_name() {
        for name in BROWSER_TOOLS {
            // 无参或最小参也应能解析(带必填参数的工具允许 Err,但不允许 unknown 报错)
            let probe = match parse_action(name, &json!({"id": "1", "text": "x", "key": "Enter", "value": "v", "url": "https://a.b", "expression": "return 1;"})) {
                Ok(_) => true,
                Err(e) => !e.starts_with("unsupported browser tool"),
            };
            assert!(probe, "{name} 未接入 parse_action");
        }
    }

    // ---------- BrowserManager pending map ----------

    #[tokio::test]
    async fn resolve_pending_delivers_outcome_once() {
        let manager = BrowserManager::new();
        let (tx, rx) = oneshot::channel::<EvalOutcome>();
        manager
            .pending
            .lock()
            .expect("map")
            .insert("r1".to_string(), tx);
        assert_eq!(manager.pending_count(), 1);
        assert!(manager.resolve_pending("r1", true, Some("42".to_string())));
        let (ok, payload) = rx.await.expect("delivered");
        assert!(ok);
        assert_eq!(payload.as_deref(), Some("42"));
        // 重复应答 / 未知 id 一律丢弃
        assert!(!manager.resolve_pending("r1", true, None));
        assert!(!manager.resolve_pending("unknown", false, None));
        assert_eq!(manager.pending_count(), 0);
    }

    #[tokio::test]
    async fn fail_all_pending_unblocks_waiters_with_error() {
        let manager = BrowserManager::new();
        let (tx1, rx1) = oneshot::channel::<EvalOutcome>();
        let (tx2, rx2) = oneshot::channel::<EvalOutcome>();
        {
            let mut pending = manager.pending.lock().expect("map");
            pending.insert("a".to_string(), tx1);
            pending.insert("b".to_string(), tx2);
        }
        assert_eq!(manager.fail_all_pending("浏览器窗口已关闭"), 2);
        assert_eq!(manager.pending_count(), 0);
        for rx in [rx1, rx2] {
            let (ok, payload) = rx.await.expect("delivered");
            assert!(!ok);
            assert_eq!(payload.as_deref(), Some("浏览器窗口已关闭"));
        }
        // 空表再次收口是 no-op
        assert_eq!(manager.fail_all_pending("再次"), 0);
    }
}
