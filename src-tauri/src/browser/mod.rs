//! AI 浏览器双引擎:webview(无痕独立窗口)与 obscura(无头浏览器 + 直播查看器)。
//!
//! 14 个 `browser_*` 工具经 harness/tools.rs 路由到 [`execute_from_bridge`]。
//! 实际执行后端由设置 `browser.engine`(`webview`|`obscura`)决定;JSON 参数解析
//! (`parse_action`,契约层已搬到 `starhub-domain-browser`)与页面侧注入层
//! (`script::HELPERS_JS`)两后端共用。
//!
//! 安全边界(webview 后端):浏览器窗口加载任意外部网页,capabilities/browser.json
//! 只授予 `browser-eval-result` 一条命令权限,页面拿不到任何其它 app command;
//! 导航协议白名单见 [`script::normalize_url`]。obscura 后端为无头引擎,页面不经过
//! Tauri IPC,由 CDP 触发,风险面由 CDP 命令白名单收窄。

pub mod auto;
pub mod decide;
pub mod idle;
pub mod obscura;
/// 页面注入脚本与 URL 归一化(已随契约层搬到 starhub-domain-browser)。
pub use starhub_domain_browser::script;
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
// 工具参数 → 动作(契约层,已搬到 starhub-domain-browser,唯一事实源)
// ============================================================

pub use starhub_domain_browser::action::{parse_action, BrowserAction};
pub use starhub_domain_browser::script::DEFAULT_MAX_CHARS;

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
                    max_chars: DEFAULT_MAX_CHARS,
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

    // parse_action / BrowserAction 的契约测试已随契约层搬到
    // starhub-domain-browser(action::tests + script::tests)。
}
