//! Obscura 无头浏览器引擎编排:进程生命周期、CDP 页面会话、动作执行、直播查看器。
//!
//! 作为 AI 浏览器可选后端与「网页访问」独立窗口的渲染引擎。用户全程可见由
//! 直播查看器窗口承担:`Page.startScreencast` 推 JPEG 帧,`obscura-live://`
//! 协议处理器供给查看器轮询显示。引擎与页面惰性启动,随 App 退出回收。

mod cdp;
mod live;
mod process;
mod state;
#[cfg(test)]
mod tests;

pub use live::live_protocol_handler;
pub use state::{Engine, LiveCmd, ObscuraInner, PageState};

use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindowBuilder, WebviewUrl};

use super::script;
use super::BrowserAction;

/// Tauri 托管的状态包装:`inner` 是真正共享的 [`Arc<ObscuraInner>`]。
pub struct ObscuraManager {
    pub inner: Arc<ObscuraInner>,
}

impl ObscuraManager {
    pub fn new() -> Self {
        Self {
            inner: ObscuraInner::new(),
        }
    }

    pub fn set_engine(&self, engine: Engine) -> bool {
        let mut cur = state::plock(&self.inner.engine);
        if *cur == engine {
            return false;
        }
        *cur = engine;
        true
    }
}

// ============================================================
// 引擎生命周期
// ============================================================

/// 定位 obscura 可执行文件(打包后紧随 exe,开发时在 sidecar/bin 或 target)。
pub fn binary_path(app: &AppHandle) -> std::path::PathBuf {
    process::binary_path(app)
}

/// 选一次性空闲端口。
async fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("选端口失败:{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取端口失败:{e}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// 回收引擎进程并清空连接状态。页面会话属于旧引擎实例,重启后全部失效,
/// 一并清掉,否则 ensure_page 会拿旧 session_id 在新引擎上空转。
fn kill_engine(inner: &Arc<ObscuraInner>) {
    if let Some(mut child) = state::plock(&inner.process).take() {
        let _ = child.start_kill();
    }
    *state::plock(&inner.client) = None;
    *state::plock(&inner.port) = None;
    state::plock(&inner.pages).clear();
}

/// 确保引擎进程与 CDP 连接就绪,返回 (client, port)。
async fn ensure_engine(
    app: &AppHandle,
    inner: &Arc<ObscuraInner>,
) -> Result<(Arc<cdp::CdpClient>, u16), String> {
    // 快路径:缓存的 client 必须先探测。引擎崩溃/WS 断开后若直接复用,
    // 所有动作会永久报「发送通道已关闭」直到重启 App;探测失败则回收并重启。
    let cached = (state::plock(&inner.client).clone(), *state::plock(&inner.port));
    if let (Some(client), Some(port)) = cached {
        if client_probe(&client).await {
            return Ok((client, port));
        }
        tracing::warn!("Obscura 引擎连接已失效,回收并重启");
        kill_engine(inner);
    }
    if inner.starting.swap(true, Ordering::AcqRel) {
        // 等待方上限必须超过启动方最坏耗时(60×200ms 连接重试 + spawn),
        // 否则冷启动时会误报超时。
        for _ in 0..100 {
            let client = state::plock(&inner.client).clone();
            if let Some(client) = client {
                if client_probe(&client).await {
                    let port = state::plock(&inner.port).expect("port set with client");
                    return Ok((client, port));
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        return Err("等待 Obscura 引擎启动超时".to_string());
    }
    // 本任务拥有启动权。
    let result = async {
        let binary = binary_path(app);
        if !binary.exists() {
            return Err(format!("obscura 可执行文件未找到:{}", binary.display()));
        }
        let port = pick_free_port().await?;
        let child = process::spawn_engine(&binary, port)?;
        *state::plock(&inner.process) = Some(child);
        let client = Arc::new(cdp::CdpClient::new(inner.clone()));
        let ws_url = format!("ws://127.0.0.1:{port}/devtools/browser");
        let mut last_err = String::new();
        for _ in 0..60 {
            match client.connect(&ws_url).await {
                Ok(()) => {
                    *state::plock(&inner.client) = Some(client.clone());
                    *state::plock(&inner.port) = Some(port);
                    // 启动输入转发泵(viewer 窗口 POST input → CDP Input 域)。
                    spawn_pump(app);
                    return Ok((client, port));
                }
                Err(e) => {
                    last_err = e;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
        // 连接不上:回收引擎进程,否则每次失败重试都泄漏一个僵尸 obscura 进程。
        kill_engine(inner);
        Err(format!("Obscura CDP 连接失败:{last_err}"))
    }
    .await;
    inner.starting.store(false, Ordering::Release);
    result
}

/// 探测 client 是否仍可通信(browser 级),返回 true 表示可用。
async fn client_probe(client: &cdp::CdpClient) -> bool {
    client.call("Target.getTargets", serde_json::json!({})).await.is_ok()
}

// ============================================================
// 页面会话
// ============================================================

/// 确保 page_key 会话存在;不存在则创建、(可选)导航。
async fn ensure_page(
    app: &AppHandle,
    inner: &Arc<ObscuraInner>,
    key: &str,
    initial: Option<&str>,
) -> Result<(), String> {
    let (client, _port) = ensure_engine(app, inner).await?;
    if state::plock(&inner.pages).contains_key(key) {
        // 页面已存在;若是 AI 浏览器会话且用户曾关掉直播窗,重新拉起来。
        if key == "ai" {
            let _ = open_viewer(app, inner, key, "StarHub AI 浏览器(Obscura)").await;
        }
        // 首次 startScreencast 可能因页面临时无 DOM 表面而失败(错误被忽略),
        // 补一次,保证直播流已注册、能持续出帧。
        let _ = ensure_screencast(&client, inner, key).await;
        return Ok(());
    }
    let url = initial.unwrap_or("about:blank");
    let target = client
        .call(
            "Target.createTarget",
            // 总是先在 about:blank 建页:obscura 的 createTarget 带真实 URL 时会
            // 走 `page.navigate()`(默认 WaitUntil::Load——等全部子资源/脚本就绪才返回),
            // 慢页面会让 CDP 调用挂到超时,尽管内容早已渲染。改为先落 about:blank,
            // 后面统一用 Page.navigate(默认 DomContentLoaded,快速返回)加载真实 URL。
            serde_json::json!({ "url": "about:blank" }),
        )
        .await?;
    let target_id = target
        .get("targetId")
        .and_then(|v| v.as_str())
        .ok_or("Target.createTarget 未返回 targetId")?
        .to_string();
    let attached = client
        .call(
            "Target.attachToTarget",
            serde_json::json!({ "targetId": target_id, "flatten": true }),
        )
        .await?;
    let session_id = attached
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("Target.attachToTarget 未返回 sessionId")?
        .to_string();
    let _ = client
        .call_session(Some(&session_id), "Page.enable", serde_json::json!({}))
        .await;
    // 先落页面会话,再启动 screencast(帧回调按 session_id 查找 state)。
    state::plock(&inner.pages).insert(key.to_string(), PageState::new(&session_id, url));
    // 有真实 URL:在 about:blank 会话上导航(默认 DomContentLoaded,快速返回),
    // 避免 createTarget 卡 Load 导致 browser_open 超时。
    if url != "about:blank" {
        let _ = client
            .call_session(
                Some(&session_id),
                "Page.navigate",
                serde_json::json!({ "url": url }),
            )
            .await;
    }
    // 等页面 ready,再启动 screencast:startScreencast 在页面尚无可见 DOM 表面
    // 时会直接报错,导致后续无帧可推(直播窗停在「连接 Obscura…」)。
    wait_ready(inner, key).await;
    if let Err(e) = ensure_screencast(&client, inner, key).await {
        tracing::warn!(key, "启动 obscura screencast 失败(已重试):{e}");
    }
    // AI 浏览器页面一旦创建(任意 browser_* 动作触发),自动开直播查看器窗口,
    // 用户全程可见 AI 在干什么。
    if key == "ai" {
        let _ = open_viewer(app, inner, key, "StarHub AI 浏览器(Obscura)").await;
    }
    Ok(())
}

/// 启动(或补启)screencast,直到确认收到新帧或有限次重试耗尽。
/// startScreencast 返回 Ok 但页面无可见 DOM 表面时,obscura 会回滚注册,
/// 调用方(旧实现)用 `let _ =` 吞掉错误 → 直播永远无帧。此处显式确认帧已到。
/// 判据是「seq 增长」而非「seq>0」:流中途死掉时 seq 冻结在 >0,
/// 旧判据会误以为流还活着,直播永久定格。startScreencast 成功会强制推一帧
/// (vendor 侧 force=true),所以重注册后必然能观察到 seq 增长。
async fn ensure_screencast(
    client: &cdp::CdpClient,
    inner: &Arc<ObscuraInner>,
    key: &str,
) -> Result<(), String> {
    let session_id = {
        let pages = state::plock(&inner.pages);
        pages
            .get(key)
            .ok_or_else(|| "浏览器页面未打开".to_string())?
            .session_id
            .clone()
    };
    let mut last_err = String::new();
    for _ in 0..5 {
        let prev_seq = state::plock(&inner.pages).get(key).map(|s| s.seq).unwrap_or(0);
        if let Err(e) = client
            .call_session(
                Some(&session_id),
                "Page.startScreencast",
                serde_json::json!({ "format": "jpeg", "quality": 70, "everyNthFrame": 1 }),
            )
            .await
        {
            last_err = e;
        }
        // 等新帧;超时说明仍无 DOM 表面,下一轮再试(期间页面通常已加载完成)。
        let deadline = std::time::Instant::now() + Duration::from_millis(600);
        loop {
            {
                let pages = state::plock(&inner.pages);
                if let Some(state) = pages.get(key) {
                    if state.seq > prev_seq {
                        return Ok(());
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    if last_err.is_empty() {
        last_err = "screencast 重注册后未收到新帧".to_string();
    }
    Err(last_err)
}

/// 轮询页面 readyState,超时静默放行。
async fn wait_ready(inner: &Arc<ObscuraInner>, key: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if current_state(inner, key).await.is_ok() {
            return;
        }
        if std::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// 经 `evaluate` 读取页面状态并写回 page state。
async fn current_state(inner: &Arc<ObscuraInner>, key: &str) -> Result<(), String> {
    let (client, session_id) = {
        let pages = state::plock(&inner.pages);
        let state = pages
            .get(key)
            .ok_or_else(|| "浏览器页面未打开".to_string())?;
        let client = state::plock(&inner.client)
            .clone()
            .ok_or_else(|| "Engine 未连接".to_string())?;
        (client, state.session_id.clone())
    };
    // `__shb.state()` 返回 JSON 字符串,解析成对象后取字段。
    let raw = evaluate(&client, &session_id, "return window.__shb.state()").await?;
    let parsed = match raw {
        serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(&s)
            .unwrap_or(serde_json::Value::Null),
        other => other,
    };
    let mut pages = state::plock(&inner.pages);
    if let Some(state) = pages.get_mut(key) {
        state.url = parsed.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        state.title = parsed.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    }
    Ok(())
}

// ============================================================
// evaluate 与 __shb 注入
// ============================================================

/// 在页面会话里执行一段函数体,拿 JSON 结果。先注入幂等助手。
/// `body` 语义与 webview 后端一致:内部调用恒带 `return`。
async fn evaluate(
    client: &cdp::CdpClient,
    session_id: &str,
    body: &str,
) -> Result<serde_json::Value, String> {
    // 单个 IIFE 表达式:obscura 的 Runtime.evaluate 会把表达式包进 `await (...)`,
    // 只接受单一表达式。直接拼 `HELPERS\nIIFE()` 是「多语句程序」,被 await(...)
    // 包裹后 `...;}` 里的分号会抛 `Unexpected token ';'`(见 vendor/obscura
    // runtime.rs wrap 逻辑)。把整个(助手 + body)包成一个函数表达式即可。
    // 外层用 async,兼容 body 里 `return await ...` 的异步求值。
    let expression = format!("(async function() {{\n{HELPERS}\n{body}\n}})()");
    let result = client
        .call_session(
            Some(session_id),
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
            .and_then(|v| v.as_str())
            .unwrap_or("页面脚本异常");
        return Err(format!("页面脚本异常:{text}"));
    }
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// __shb 助手脚本(直接复用 webview 后端的 HELPERS_JS,保持行为一致)。
const HELPERS: &str = script::HELPERS_JS;

// ============================================================
// 动作执行
// ============================================================

/// 桥入口(由 browser::execute_from_bridge 在 engine=obscura 时分发)。
pub async fn execute_action(app: &AppHandle, action: BrowserAction) -> Result<String, String> {
    let inner = app.state::<ObscuraManager>().inner.clone();
    let key = "ai".to_string();
    match action {
        BrowserAction::Open { url } => {
            ensure_page(app, &inner, &key, url.as_deref()).await?;
            open_viewer(app, &inner, &key, "StarHub AI 浏览器(Obscura)").await?;
            let state = current_state(&inner, &key).await;
            let current = state
                .ok()
                .and_then(|_| state::plock(&inner.pages).get(&key).map(|s| s.url.clone()))
                .unwrap_or_else(|| "about:blank".to_string());
            Ok(format!(
                "已启动 Obscura 无头浏览器(直播查看器窗口已打开,用户可见 AI 操作)。当前:{current}"
            ))
        }
        BrowserAction::Navigate { url } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            client
                .call_session(
                    Some(&session_id),
                    "Page.navigate",
                    serde_json::json!({ "url": url }),
                )
                .await?;
            // 更新 page state 的 url(导航后 evaluate 可能尚不可用)。
            {
                let mut pages = state::plock(&inner.pages);
                if let Some(state) = pages.get_mut(&key) {
                    state.url = url.clone();
                }
            }
            wait_ready(&inner, &key).await;
            let title = current_state(&inner, &key)
                .await
                .ok()
                .and_then(|_| state::plock(&inner.pages).get(&key).map(|s| s.title.clone()))
                .unwrap_or_default();
            Ok(format!("已导航到 {url}。页面标题:{title}"))
        }
        BrowserAction::Back | BrowserAction::Forward | BrowserAction::Reload => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            match action {
                // Back/Forward:obscura 不直接支持 Page.goBack/Page.goForward,走
                // getNavigationHistory + navigateToHistoryEntry(前/后一条)。
                BrowserAction::Back | BrowserAction::Forward => {
                    let history = client
                        .call_session(
                            Some(&session_id),
                            "Page.getNavigationHistory",
                            serde_json::json!({}),
                        )
                        .await
                        .unwrap_or(serde_json::Value::Null);
                    let current = history
                        .pointer("/currentIndex")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let entries = history
                        .pointer("/entries")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    let delta: i64 = if matches!(action, BrowserAction::Back) { -1 } else { 1 };
                    let target = current as i64 + delta;
                    if target >= 0 && (target as usize) < entries {
                        let _ = client
                            .call_session(
                                Some(&session_id),
                                "Page.navigateToHistoryEntry",
                                serde_json::json!({ "entryId": target }),
                            )
                            .await;
                    }
                }
                _ => {
                    let _ = client
                        .call_session(Some(&session_id), "Page.reload", serde_json::json!({}))
                        .await;
                }
            }
            wait_ready(&inner, &key).await;
            _ = current_state(&inner, &key).await;
            let label = match action {
                BrowserAction::Back => "后退",
                BrowserAction::Forward => "前进",
                _ => "刷新",
            };
            Ok(append_state(&inner, &key, format!("已{label}")).await)
        }
        BrowserAction::State => {
            ensure_page(app, &inner, &key, None).await?;
            current_state(&inner, &key).await?;
            let state = {
                let pages = state::plock(&inner.pages);
                match pages.get(&key) {
                    Some(s) => serde_json::json!({
                        "url": s.url,
                        "title": s.title,
                    }),
                    None => serde_json::Value::Null,
                }
            };
            Ok(serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
        }
        BrowserAction::Extract { max_chars } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            let text = evaluate(&client, &session_id, &format!("return window.__shb.extract({max_chars});")).await?;
            Ok(text.as_str().unwrap_or_default().to_string())
        }
        BrowserAction::Click { id } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            let rect = evaluate(&client, &session_id, &format!("return window.__shb.rectOf({});", json_str(&id)))
                .await
                .unwrap_or(serde_json::Value::Null);
            let x = rect.pointer("/x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = rect.pointer("/y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if x > 0.0 || y > 0.0 {
                // 先补 mouseMoved:依赖 hover 态(:hover 样式、悬浮才渲染的
                // 元素)的页面在指针未移动过时点不中。
                let _ = client
                    .call_session(
                        Some(&session_id),
                        "Input.dispatchMouseEvent",
                        serde_json::json!({ "type": "mouseMoved", "x": x, "y": y }),
                    )
                    .await;
                if client
                    .call_session(
                        Some(&session_id),
                        "Input.dispatchMouseEvent",
                        serde_json::json!({
                            "type": "mousePressed", "x": x, "y": y,
                            "button": "left", "clickCount": 1,
                        }),
                    )
                    .await
                    .is_ok()
                {
                    let _ = client
                        .call_session(
                            Some(&session_id),
                            "Input.dispatchMouseEvent",
                            serde_json::json!({
                                "type": "mouseReleased", "x": x, "y": y,
                                "button": "left", "clickCount": 1,
                            }),
                        )
                        .await;
                    return Ok(append_state(&inner, &key, format!("已点击元素 [{id}](可信输入,坐标 {x:.0},{y:.0})")).await);
                }
            }
            let text = evaluate(&client, &session_id, &format!("return window.__shb.click({});", json_str(&id)))
                .await?
                .as_str()
                .unwrap_or_default()
                .to_string();
            Ok(append_state(&inner, &key, text).await)
        }
        BrowserAction::Type { id, text, clear } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            let focus = evaluate(
                &client,
                &session_id,
                &format!(
                    "return window.__shb.focusEl({}, {});",
                    json_str(&id),
                    if clear { "true" } else { "false" }
                ),
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string();
            if focus.starts_with("[Error]") {
                return Ok(focus);
            }
            let result = evaluate(
                &client,
                &session_id,
                &format!(
                    "return window.__shb.typeText({}, {}, {});",
                    json_str(&id),
                    json_str(&text),
                    if clear { "true" } else { "false" }
                ),
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string();
            Ok(append_state(&inner, &key, result).await)
        }
        BrowserAction::PressKey { key } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            if let Some((vk, code)) = super::keymap::virtual_key(&key) {
                for event_type in ["rawKeyDown", "keyUp"] {
                    let _ = client
                        .call_session(
                            Some(&session_id),
                            "Input.dispatchKeyEvent",
                            serde_json::json!({
                                "type": event_type,
                                "key": key,
                                "code": code,
                                "windowsVirtualKeyCode": vk,
                                "nativeVirtualKeyCode": vk,
                            }),
                        )
                        .await;
                }
                Ok(format!("已按键 {key}(可信输入)"))
            } else {
                let text = evaluate(&client, &session_id, &format!("return window.__shb.pressKey({});", json_str(&key)))
                    .await?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                Ok(text)
            }
        }
        BrowserAction::SelectOption { id, value } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            let text = evaluate(
                &client,
                &session_id,
                &format!("return window.__shb.selectOption({}, {});", json_str(&id), json_str(&value)),
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string();
            Ok(text)
        }
        BrowserAction::Scroll { direction, amount } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            let text = evaluate(
                &client,
                &session_id,
                &format!("return window.__shb.scrollPage({}, {amount});", json_str(&direction)),
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string();
            Ok(text)
        }
        BrowserAction::Screenshot => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            capture_screenshot(app, &client, &session_id).await
        }
        BrowserAction::Eval { expression } => {
            ensure_page(app, &inner, &key, None).await?;
            let (client, session_id) = session_ids(&inner, &key).await?;
            let value = evaluate(&client, &session_id, &expression).await?;
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

async fn session_ids(inner: &Arc<ObscuraInner>, key: &str) -> Result<(Arc<cdp::CdpClient>, String), String> {
    let client = state::plock(&inner.client)
        .clone()
        .ok_or_else(|| "Engine 未连接".to_string())?;
    let session_id = state::plock(&inner.pages)
        .get(key)
        .ok_or_else(|| "浏览器页面未打开,请先 browser_open".to_string())?
        .session_id
        .clone();
    Ok((client, session_id))
}

async fn append_state(inner: &Arc<ObscuraInner>, key: &str, text: String) -> String {
    let _ = current_state(inner, key).await;
    let state = state::plock(&inner.pages)
        .get(key)
        .map(|s| (s.title.clone(), s.url.clone()));
    match state {
        Some((title, url)) => format!("{text}\n当前页面:{title} ({url})"),
        None => text,
    }
}

/// 截图 → PNG 落盘(应用缓存目录 browser-shots/)。
async fn capture_screenshot(
    app: &AppHandle,
    client: &cdp::CdpClient,
    session_id: &str,
) -> Result<String, String> {
    use base64::Engine as _;
    let result = client
        .call_session(
            Some(session_id),
            "Page.captureScreenshot",
            serde_json::json!({ "format": "png", "fromSurface": true }),
        )
        .await?;
    let data = result
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Page.captureScreenshot 返回缺少 data".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("截图 base64 解码失败:{e}"))?;
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

fn json_str(raw: &str) -> String {
    serde_json::to_string(raw).unwrap_or_else(|_| "\"\"".to_string())
}

/// 打开直播查看器窗口(obscura-live://…)。
async fn open_viewer(
    app: &AppHandle,
    inner: &Arc<ObscuraInner>,
    key: &str,
    title: &str,
) -> Result<(), String> {
    let label = format!("obscura-live-{key}");
    if let Some(window) = app.get_webview_window(&label) {
        // 聚焦失败(窗口最小化等)不应让 browser_open 整体报错。
        let _ = window.set_focus();
        return Ok(());
    }
    let url = format!("obscura-live://localhost/{key}/index.html");
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("查看器 URL 非法:{e}"))?;
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1200.0, 820.0)
        .build()
        .map_err(|e| format!("创建查看器窗口失败:{e}"))?;
    // 激活查看器后确保 screencast 已在跑(ensure_page 会兜底)。
    let _ = inner;
    Ok(())
}

/// 启动输入转发泵(viewer 窗口 POST input → 此处执行 CDP)。
pub fn spawn_pump(app: &AppHandle) {
    let inner = app.state::<ObscuraManager>().inner.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LiveCmd>();
    *state::plock(&inner.cmds) = Some(tx);
    tauri::async_runtime::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            let inner = inner.clone();
            tauri::async_runtime::spawn(async move {
                run_live_cmd(&inner, cmd).await;
            });
        }
    });
}

async fn run_live_cmd(inner: &Arc<ObscuraInner>, cmd: LiveCmd) {
    let client = match state::plock(&inner.client).clone() {
        Some(c) => c,
        None => return,
    };
    match cmd {
        LiveCmd::Navigate { key, url } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                let _ = client
                    .call_session(Some(&sid), "Page.navigate", serde_json::json!({ "url": url }))
                    .await;
                let mut pages = state::plock(&inner.pages);
                if let Some(state) = pages.get_mut(&key) {
                    state.url = url.clone();
                }
            }
        }
        LiveCmd::Back { key } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                nav_history(&client, &sid, -1).await;
            }
        }
        LiveCmd::Forward { key } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                nav_history(&client, &sid, 1).await;
            }
        }
        LiveCmd::Reload { key } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                let _ = client.call_session(Some(&sid), "Page.reload", serde_json::json!({})).await;
            }
        }
        LiveCmd::Click { key, x, y } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                dispatch_click(&client, &sid, x, y).await;
            }
        }
        LiveCmd::DblClick { key, x, y } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                dispatch_dblclick(&client, &sid, x, y).await;
            }
        }
        LiveCmd::Key { key, kbd, text } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                dispatch_key(&client, &sid, &kbd, text.as_deref()).await;
            }
        }
        LiveCmd::Scroll { key, direction, amount } => {
            if let Some(sid) = session_of_opt(inner, &key) {
                let _ = client
                    .call_session(
                        Some(&sid),
                        "Runtime.evaluate",
                        serde_json::json!({
                            "expression": format!("window.scrollBy(0,{})", if direction == "up" { -amount } else { amount }),
                            "returnByValue": true,
                        }),
                    )
                    .await;
            }
        }
    }
}

fn session_of_opt(inner: &Arc<ObscuraInner>, key: &str) -> Option<String> {
    state::plock(&inner.pages)
        .get(key)
        .map(|s| s.session_id.clone())
}

/// 浏览历史前进/后退一条(obscura 无 Page.goBack,走 getNavigationHistory +
/// navigateToHistoryEntry)。delta:-1 后退,+1 前进。
async fn nav_history(client: &cdp::CdpClient, sid: &str, delta: i64) {
    let history = client
        .call_session(Some(sid), "Page.getNavigationHistory", serde_json::json!({}))
        .await
        .unwrap_or(serde_json::Value::Null);
    let current = history
        .pointer("/currentIndex")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let entries = history
        .pointer("/entries")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let target = current as i64 + delta;
    if target >= 0 && (target as usize) < entries {
        let _ = client
            .call_session(
                Some(sid),
                "Page.navigateToHistoryEntry",
                serde_json::json!({ "entryId": target }),
            )
            .await;
    }
}

async fn dispatch_click(client: &cdp::CdpClient, sid: &str, x: f64, y: f64) {
    for event_type in ["mouseMoved", "mousePressed", "mouseReleased"] {
        let mut params = serde_json::json!({ "type": event_type, "x": x, "y": y });
        if event_type != "mouseMoved" {
            params["button"] = serde_json::Value::String("left".to_string());
            params["clickCount"] = serde_json::Value::from(1);
        }
        let _ = client.call_session(Some(sid), "Input.dispatchMouseEvent", params).await;
    }
}

/// 真双击:第二次 press/release 必须 clickCount=2,否则页面的 dblclick
/// 处理器不触发(两次独立 clickCount=1 只是两下单击)。
async fn dispatch_dblclick(client: &cdp::CdpClient, sid: &str, x: f64, y: f64) {
    for (event_type, count) in [
        ("mouseMoved", 0),
        ("mousePressed", 1),
        ("mouseReleased", 1),
        ("mousePressed", 2),
        ("mouseReleased", 2),
    ] {
        let mut params = serde_json::json!({ "type": event_type, "x": x, "y": y });
        if event_type != "mouseMoved" {
            params["button"] = serde_json::Value::String("left".to_string());
            params["clickCount"] = serde_json::Value::from(count);
        }
        let _ = client.call_session(Some(sid), "Input.dispatchMouseEvent", params).await;
    }
}

async fn dispatch_key(client: &cdp::CdpClient, sid: &str, key: &str, text: Option<&str>) {
    let code = super::keymap::virtual_key(key).map(|(_, c)| c.to_string()).unwrap_or_else(|| key.to_string());
    let vk = super::keymap::virtual_key(key).map(|(v, _)| v);
    for event_type in ["rawKeyDown", "keyUp"] {
        let mut params = serde_json::json!({
            "type": event_type,
            "key": key,
            "code": code,
        });
        if let Some(vk) = vk {
            params["windowsVirtualKeyCode"] = serde_json::Value::from(vk);
            params["nativeVirtualKeyCode"] = serde_json::Value::from(vk);
        }
        if let Some(t) = text {
            if event_type == "rawKeyDown" {
                // printable char:cdp 惯例放在 keyDown。obscura 读 "text" 字段。
                params["type"] = serde_json::Value::String("keyDown".to_string());
                params["text"] = serde_json::Value::String(t.to_string());
            }
        }
        let _ = client.call_session(Some(sid), "Input.dispatchKeyEvent", params).await;
    }
}

/// 引擎进程回收(由 main.rs 主窗口 Destroyed 联动)。
pub fn shutdown(app: &AppHandle) {
    let inner = app.state::<ObscuraManager>().inner.clone();
    kill_engine(&inner);
}
