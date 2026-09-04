//! AI 浏览器双引擎:webview(无痕独立窗口)与 obscura(无头浏览器 + 直播查看器)。
//!
//! 14 个 `browser_*` 工具经 harness/tools.rs 路由到 [`execute_from_bridge`]。
//! 实际执行后端由设置 `browser.engine`(`webview`|`obscura`)决定;JSON 参数解析
//! (`parse_action`)与页面侧注入层(`script::HELPERS_JS`)两后端共用。
//!
//! 安全边界(webview 后端):浏览器窗口加载任意外部网页,capabilities/browser.json
//! 只授予 `browser-eval-result` 一条命令权限,页面拿不到任何其它 app command;
//! 导航协议白名单见 [`script::normalize_url`]。obscura 后端为无头引擎,页面不经过
//! Tauri IPC,由 CDP 触发,风险面由 CDP 命令白名单收窄。

pub mod obscura;
pub mod script;
pub mod web_shell;
pub mod webview;

#[cfg(windows)]
mod cdp;
#[cfg(target_os = "macos")]
#[path = "snapshot_macos.rs"]
mod snapshot;
#[cfg(target_os = "linux")]
#[path = "snapshot_linux.rs"]
mod snapshot;

mod keymap;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use super::harness::HostBridgeState;

/// AI 浏览器 webview 窗口 label(capabilities/browser.json 按此收窄权限)。
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

/// 引擎选择(持久化到 settings 表。webview 为默认)。
pub const ENGINE_SETTING_KEY: &str = "browser.engine";

/// 页面 eval 的一次应答:ok + JSON 字符串载荷(页面侧已 JSON.stringify)。
type EvalOutcome = (bool, Option<String>);

/// 在途 eval 请求登记表(browser_internal_result 命令按 id 应答)。
/// 仅 webview 后端使用;obscura 后端经 CDP Runtime.evaluate 直取结果。
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
// 工具参数 → 动作(纯解析层,无 GUI 依赖,单测覆盖;两后端共用)
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
// 引擎设置(settings 表持久化)
// ============================================================

/// 读取当前引擎设置;缺省 webview。读取失败(库未就绪)回退默认并告警。
pub async fn engine_setting(_app: &AppHandle) -> obscura::Engine {
    match crate::db::get_pool() {
        Ok(pool) => match sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key = ?",
        )
        .bind(ENGINE_SETTING_KEY)
        .fetch_optional(pool)
        .await
        {
            Ok(Some(value)) => match value.as_str() {
                "obscura" => obscura::Engine::Obscura,
                _ => obscura::Engine::Webview,
            },
            Ok(None) => obscura::Engine::Webview,
            Err(e) => {
                tracing::warn!("读取浏览器引擎设置失败,回退 webview:{e}");
                obscura::Engine::Webview
            }
        },
        Err(_) => obscura::Engine::Webview,
    }
}

/// 写入引擎设置;返回是否成功。
pub async fn save_engine_setting(_app: &AppHandle, engine: obscura::Engine) -> Result<(), String> {
    let pool = crate::db::get_pool().map_err(|e| e.to_string())?;
    let value = match engine {
        obscura::Engine::Webview => "webview",
        obscura::Engine::Obscura => "obscura",
    };
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now')) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(ENGINE_SETTING_KEY)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| format!("保存引擎设置失败:{e}"))?;
    Ok(())
}

// ============================================================
// 工具执行(桥入口,按引擎路由)
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
    // 运行时决定后端:每次查询设置(轻量 SQLite),避免引擎与设置脱节。
    let engine = engine_setting(&app).await;
    let manager = app.state::<obscura::ObscuraManager>();
    manager.set_engine(engine); // 同步到缓存,供注入协议/查看器使用
    match engine {
        obscura::Engine::Webview => webview::execute_action(&app, action).await,
        obscura::Engine::Obscura => obscura::execute_action(&app, action).await,
    }
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
        assert_eq!(manager.fail_all_pending("再次"), 0);
    }
}
