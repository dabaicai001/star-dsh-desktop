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

pub mod auto;
pub mod decide;
pub mod idle;
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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
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
    // Jev 决策(只读:把目标+快照变成下一步动作建议,不执行;§docs/Jev 调研 §6)
    "browser_decide",
    // Jev 连续执行循环(Phase 2:Rust 内 extract→decide→执行,§docs/browser_auto 立项)
    "browser_auto",
];

/// 引擎选择(持久化到 settings 表。webview 为默认)。
pub const ENGINE_SETTING_KEY: &str = "browser.engine";

/// Jev 强制决策门(`ai.jev.enabled=1` 时生效):启用后每个页面动作都必须先
/// 拿到一次**新鲜**决策——动作工具消费令牌,一次动作一次决策;页面可能变化
/// 的工具吊销令牌(旧决策引用的元素编号不再可信)。只读观察类
/// (state/screenshot)不影响令牌。语义见 [`JevGate`]。
const JEV_GATED_ACTIONS: &[&str] = &[
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_press_key",
    "browser_select_option",
];

/// 使 Jev 决策令牌失效的工具:导航/重新加载/重新 extract 都会换掉页面,
/// `browser_eval` 可执行任意 JS 改动 DOM,同样按页面变化处理。
/// `browser_auto` 循环内页面必然多次变化,整次调用按页面变化处理。
const JEV_REVOKING_TOOLS: &[&str] = &[
    "browser_open",
    "browser_navigate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_extract",
    "browser_eval",
    "browser_auto",
];

/// 动作工具被 Jev 决策门拒绝时的软错误文本(模型可纠正重试)。
const JEV_GATE_DENIAL: &str = "[Error] Jev 决策已启用:执行浏览器动作前必须先调用 browser_decide 获取下一步建议(每次动作都需要一次新决策;页面变化后旧决策自动失效)。如需临时跳过,请在 设置 → AI 浏览器 关闭「启用 Jev 决策」后重试";

/// 页面 eval 的一次应答:ok + JSON 字符串载荷(页面侧已 JSON.stringify)。
type EvalOutcome = (bool, Option<String>);

/// 在途 eval 请求登记表(browser_internal_result 命令按 id 应答)。
/// 仅 webview 后端使用;obscura 后端经 CDP Runtime.evaluate 直取结果。
///
/// 另持两份空闲看门狗(`idle`)所需的状态:最后一次 `browser_*` 调用的时刻
/// (按调用进入计时,长轮询/慢页面加载也算活动中)与在途调用数。
#[derive(Default)]
pub struct BrowserManager {
    pending: Mutex<HashMap<String, oneshot::Sender<EvalOutcome>>>,
    /// 最后一次 browser_* 调用进入的时刻(未调用过为 None)。
    last_activity: Mutex<Option<Instant>>,
    /// 在途 browser_* 调用数(含其内部的 Extract/CDP 等待)。
    in_flight: AtomicUsize,
    /// Jev 强制决策门(会话级决策令牌;`ai.jev.enabled` 才参与判定)。
    jev_gate: JevGate,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一次 browser_* 调用:刷新活动时刻并计数;返回的守卫在调用结束
    /// (含提前返回/报错)时递减,供空闲看门狗判断「没有进行中调用」。
    pub fn begin_call(&self) -> CallGuard<'_> {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        *self.last_activity.lock().expect("browser activity stamp") = Some(Instant::now());
        CallGuard(self)
    }

    /// 距最后一次 browser_* 调用的空闲时长(从未调用过为 None)。
    pub fn idle_for(&self) -> Option<Duration> {
        self.last_activity
            .lock()
            .expect("browser activity stamp")
            .map(|at| at.elapsed())
    }

    /// 在途 browser_* 调用数。
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
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

    /// 在途 eval 请求数(空闲看门狗与单测共用)。
    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("browser pending map").len()
    }

    /// Jev 强制决策门(启用 Jev 后动作工具的先决条件)。
    pub fn jev_gate(&self) -> &JevGate {
        &self.jev_gate
    }
}

/// Jev 强制决策门:会话(session id)级「决策令牌」状态机。
///
/// 启用 Jev 决策(`ai.jev.enabled=1`)后,主模型对页面的每个动作都必须先经
/// `browser_decide` 拿到一次决策——Jev 只判断不执行,动作仍由主模型调
/// `browser_click`/`browser_type` 等完成,审批链路原样保留。令牌规则:
///
/// - [`JevGate::grant`]:`browser_decide` **成功返回后**授予(失败不授,
///   配置/HTTP 错误时动作门保持关闭,fail loud);
/// - [`JevGate::consume`]:动作工具执行前消费,一次动作一次决策;
/// - [`JevGate::revoke`]:页面可能变化的工具(navigate/reload/extract/eval
///   等)吊销,旧决策的元素编号不再可信。
///
/// 状态只在进程内(Jev 关闭即整个门不参与判定),会话结束由 map 自然遗留,
/// 条目仅一个 bool,不做主动清理。
#[derive(Default)]
pub struct JevGate {
    granted: Mutex<HashMap<String, bool>>,
}

impl JevGate {
    /// 授予会话一个有效决策(覆盖旧值;重复 decide 即续期)。
    pub fn grant(&self, session_id: &str) {
        self.granted
            .lock()
            .expect("jev gate map")
            .insert(session_id.to_string(), true);
    }

    /// 尝试消费会话的决策令牌:持有时消费并返回 `true`(动作放行);
    /// 未持有时返回 `false`(调用方应拒绝动作并提示先 decide)。
    pub fn consume(&self, session_id: &str) -> bool {
        let mut granted = self.granted.lock().expect("jev gate map");
        match granted.get_mut(session_id) {
            Some(flag) => {
                let fresh = *flag;
                *flag = false;
                fresh
            }
            None => false,
        }
    }

    /// 吊销会话的决策令牌(页面可能已变化)。
    pub fn revoke(&self, session_id: &str) {
        self.granted
            .lock()
            .expect("jev gate map")
            .insert(session_id.to_string(), false);
    }

    /// 会话当前是否持有效决策(单测/诊断用)。
    pub fn is_granted(&self, session_id: &str) -> bool {
        self.granted
            .lock()
            .expect("jev gate map")
            .get(session_id)
            .copied()
            .unwrap_or(false)
    }
}

/// browser_* 调用生命周期守卫:drop 时递减在途计数。
pub struct CallGuard<'a>(&'a BrowserManager);

impl Drop for CallGuard<'_> {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
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
    /// Jev 决策:只读。`snapshot` 缺省时内部先跑一次 Extract 再问 Jev。
    Decide { goal: String, snapshot: Option<String> },
    /// Jev 连续执行循环(Phase 2):内部 extract → decide → 执行,汇总返回。
    /// `max_steps` 钳制到 settings `ai.jev.auto_max_steps`。
    Auto {
        goal: String,
        max_steps: usize,
        stop_on_lowconf: bool,
        input_text: Option<String>,
        snapshot: Option<String>,
    },
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
        "browser_decide" => {
            let goal = required_str(args, "goal")?;
            // snapshot 可缺省(Rust 内部补一次 Extract);显式传空串等同缺省。
            let snapshot = arg_str(args, "snapshot")
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty());
            Ok(BrowserAction::Decide { goal, snapshot })
        }
        "browser_auto" => {
            let goal = required_str(args, "goal")?;
            Ok(BrowserAction::Auto {
                goal,
                max_steps: auto::parse_max_steps(args),
                stop_on_lowconf: args
                    .get("stop_on_lowconf")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                // input_text 可缺省(遇到 type 时交接回主模型);空串等同缺省。
                input_text: arg_str(args, "input_text")
                    .map(str::to_string)
                    .filter(|s| !s.is_empty()),
                snapshot: arg_str(args, "snapshot")
                    .map(str::to_string)
                    .filter(|s| !s.trim().is_empty()),
            })
        }
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
/// `session_id` 用于 Jev 强制决策门的会话级令牌(见 [`JevGate`])。
pub async fn execute_from_bridge(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "应用句柄未就绪(启动序列未完成)".to_string())?;
    // 调用登记(活动时刻 + 在途计数):空闲看门狗据此判断窗口可否自动关闭。
    // 守卫覆盖整个调用(含内部 Extract/Jev HTTP),drop 时计数递减。
    let browser_manager = app.state::<BrowserManager>();
    let _call = browser_manager.begin_call();
    // Jev 强制决策门(启用后):动作工具须持有效决策令牌,一次动作一次决策;
    // 页面变化类工具吊销令牌。判定在执行前完成,与引擎/参数校验解耦。
    // 配置读取失败按未启用处理(不阻断浏览器本身)。
    let jev_enabled = decide::jev_config(&app).await.enabled;
    if jev_enabled {
        if JEV_GATED_ACTIONS.contains(&name) && !browser_manager.jev_gate().consume(session_id) {
            return Err(JEV_GATE_DENIAL.to_string());
        }
        if JEV_REVOKING_TOOLS.contains(&name) {
            browser_manager.jev_gate().revoke(session_id);
        }
    }
    let action = parse_action(name, args)?;
    // 运行时决定后端:每次查询设置(轻量 SQLite),避免引擎与设置脱节。
    let engine = engine_setting(&app).await;
    let manager = app.state::<obscura::ObscuraManager>();
    manager.set_engine(engine); // 同步到缓存,供注入协议/查看器使用
    // Jev 决策(browser_decide):只读。缺 snapshot 时按当前引擎内部补一次
    // Extract(与浏览器自身进程序号一致,编号空间天然对齐),再问 Jev;
    // 决策文本交还模型,执行仍走 click/type 等既有工具(审批链路不变)。
    if let BrowserAction::Decide { goal, snapshot } = action {
        let snapshot = match snapshot {
            Some(snapshot) => snapshot,
            None => {
                let extract = BrowserAction::Extract {
                    max_chars: script::DEFAULT_MAX_CHARS,
                };
                match engine {
                    obscura::Engine::Webview => webview::execute_action(&app, extract).await,
                    obscura::Engine::Obscura => obscura::execute_action(&app, extract).await,
                }?
            }
        };
        let text = decide::decide(&app, &goal, &snapshot).await?;
        // 决策成功才授予令牌:Jev 未配置/HTTP 失败时动作门保持关闭(fail loud),
        // 主模型收到软错误后要么修配置,要么明确请求用户关闭 Jev。
        if jev_enabled {
            browser_manager.jev_gate().grant(session_id);
        }
        return Ok(text);
    }
    // Jev 连续执行循环(Phase 2):Rust 内 extract→decide→执行,汇总返回。
    // 循环自决策,不在 JEV_GATED_ACTIONS(进门即死锁);调用前的吊销已在上面完成。
    if let BrowserAction::Auto {
        goal,
        max_steps,
        stop_on_lowconf,
        input_text,
        snapshot,
    } = action
    {
        return Ok(auto::run(
            &app,
            engine,
            &auto::AutoParams {
                goal,
                max_steps,
                stop_on_lowconf,
                input_text,
                snapshot,
            },
        )
        .await);
    }
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
    fn parse_auto_defaults_full_and_invalid() {
        // 缺省:max_steps=8、stop_on_lowconf=true、无可选参数。
        let action = parse_action("browser_auto", &json!({"goal": "找到登录并进入"}))
            .expect("auto defaults");
        match action {
            BrowserAction::Auto {
                goal,
                max_steps,
                stop_on_lowconf,
                input_text,
                snapshot,
            } => {
                assert_eq!(goal, "找到登录并进入");
                assert_eq!(max_steps, 8);
                assert!(stop_on_lowconf);
                assert_eq!(input_text, None);
                assert_eq!(snapshot, None);
            }
            other => panic!("expected Auto, got {other:?}"),
        }
        // 全量参数(步数上限的钳制在 auto::run 按配置完成,parse 只收正整数)。
        let action = parse_action(
            "browser_auto",
            &json!({"goal": "g", "max_steps": 30, "stop_on_lowconf": false,
                    "input_text": "starhub", "snapshot": "url: x\ntitle: y"}),
        )
        .expect("auto full");
        assert_eq!(
            action,
            BrowserAction::Auto {
                goal: "g".to_string(),
                max_steps: 30,
                stop_on_lowconf: false,
                input_text: Some("starhub".to_string()),
                snapshot: Some("url: x\ntitle: y".to_string()),
            }
        );
        // 非法 max_steps 回落缺省;空串可选参数等同缺省。
        let action = parse_action(
            "browser_auto",
            &json!({"goal": "g", "max_steps": -1, "input_text": "", "snapshot": "   "}),
        )
        .expect("auto bad steps");
        match action {
            BrowserAction::Auto {
                max_steps,
                input_text,
                snapshot,
                ..
            } => {
                assert_eq!(max_steps, 8);
                assert_eq!(input_text, None);
                assert_eq!(snapshot, None);
            }
            other => panic!("expected Auto, got {other:?}"),
        }
        assert!(parse_action("browser_auto", &json!({})).is_err(), "缺 goal 报错");
        assert!(
            parse_action("browser_auto", &json!({"goal": "   "})).is_err(),
            "goal 空串报错"
        );
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
    fn parse_decide_requires_goal_and_optional_snapshot() {
        assert!(parse_action("browser_decide", &json!({})).is_err(), "缺 goal 报错");
        assert!(
            parse_action("browser_decide", &json!({"goal": "  "})).is_err(),
            "goal 空白报错"
        );
        let action = parse_action("browser_decide", &json!({"goal": "找到登录并点击"})).expect("decide");
        assert_eq!(
            action,
            BrowserAction::Decide {
                goal: "找到登录并点击".to_string(),
                snapshot: None,
            }
        );
        let action = parse_action(
            "browser_decide",
            &json!({"goal": "找登录", "snapshot": "url: x\ntitle: y"}),
        )
        .expect("decide with snapshot");
        assert_eq!(
            action,
            BrowserAction::Decide {
                goal: "找登录".to_string(),
                snapshot: Some("url: x\ntitle: y".to_string()),
            }
        );
        // 显式空串等同缺省(内部补 Extract)。
        let action = parse_action("browser_decide", &json!({"goal": "找登录", "snapshot": "  "}))
            .expect("blank snapshot");
        assert_eq!(
            action,
            BrowserAction::Decide {
                goal: "找登录".to_string(),
                snapshot: None,
            }
        );
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

    // ---------- JevGate 决策令牌状态机 ----------

    #[test]
    fn jev_gate_grants_one_action_per_decision() {
        let gate = JevGate::default();
        assert!(!gate.is_granted("s1"), "新会话无令牌");
        assert!(!gate.consume("s1"), "无决策时动作被拒");
        gate.grant("s1");
        assert!(gate.is_granted("s1"));
        assert!(gate.consume("s1"), "持令牌时第一个动作放行");
        assert!(!gate.consume("s1"), "一次动作一次决策,令牌已消费");
        assert!(!gate.is_granted("s1"));
        // 重新 decide 后续期
        gate.grant("s1");
        assert!(gate.consume("s1"));
    }

    #[test]
    fn jev_gate_revokes_on_page_change_and_isolates_sessions() {
        let gate = JevGate::default();
        gate.grant("s1");
        gate.grant("s2");
        gate.revoke("s1");
        assert!(!gate.is_granted("s1"), "页面变化吊销 s1 令牌");
        assert!(gate.is_granted("s2"), "不影响其它会话");
        assert!(gate.consume("s2"));
        assert!(!gate.consume("s2"), "s2 令牌同样一次一消费");
    }

    #[test]
    fn jev_gate_tables_partition_browser_tools() {
        // 门控表与吊销表不相交、且都落在 BROWSER_TOOLS 内(漏登记 = 门失效)。
        for name in JEV_GATED_ACTIONS {
            assert!(BROWSER_TOOLS.contains(name), "{name} 不在 BROWSER_TOOLS");
            assert!(!JEV_REVOKING_TOOLS.contains(name), "{name} 同时是门控与吊销");
        }
        for name in JEV_REVOKING_TOOLS {
            assert!(BROWSER_TOOLS.contains(name), "{name} 不在 BROWSER_TOOLS");
        }
        // 只读观察类不碰令牌(既不放行也不吊销)。
        for name in ["browser_state", "browser_screenshot"] {
            assert!(!JEV_GATED_ACTIONS.contains(&name));
            assert!(!JEV_REVOKING_TOOLS.contains(&name));
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
