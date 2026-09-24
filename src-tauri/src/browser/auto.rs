//! `browser_auto` 连续执行循环(Phase 2):把 Phase 1「每步一问」升级为
//! 「循环内自治」——主模型一次工具往返,Rust 内部完成最多 N 步
//! extract → Jev decide → 执行,汇总返回。
//!
//! 设计依据:`docs/browser_auto-连续执行循环-立项设计.md`。关键性质:
//!
//! - **引擎解耦**:extract 与动作执行都走 `webview`/`obscura` 的
//!   `execute_action`,与单步工具同一路径,无新增后端能力;
//! - **JevGate 不进门控表**:循环自决策(内部 decide 不过桥、不授不耗令牌),
//!   `browser_auto` 只登记进吊销表(页面必变);
//! - **能力划界**:Jev 不生成自由文本——`type` 需调用方提供 `input_text`,
//!   `select_option` 交还主模型(立项设计 §5);
//! - **步数上限可配**:模型参数 `max_steps` 钳制到 settings
//!   `ai.jev.auto_max_steps`(默认 50,区间 1–500,设置页可改);
//! - **fail loud**:循环内每步重读 Jev 配置,中途被关 → decide 软错误 → 中断交接。

use tauri::AppHandle;

use super::decide::{self, AUTO_MAX_STEPS_RANGE};
use super::obscura::{self, Engine};
use super::script::DEFAULT_MAX_CHARS;
use super::{webview, BrowserAction};

/// 汇总输出总截断(仿 `browser_eval` 的 `MAX_EVAL_OUTPUT`)。
pub(crate) const MAX_SUMMARY_CHARS: usize = 8000;
/// 单步执行结果在汇总里的摘录长度。
const STEP_OUTCOME_CHARS: usize = 120;
/// scroll 的默认方向/像素量(与 `browser_scroll` 工具缺省一致)。
const SCROLL_DIRECTION: &str = "down";
const SCROLL_AMOUNT: i64 = 600;
/// press_key 的默认键(Jev 语义:通常是回车提交/切换焦点)。
const PRESS_KEY: &str = "Enter";
/// `max_steps` 缺省(模型未传或传非法值时)。
const DEFAULT_MAX_STEPS: usize = 8;

/// 循环参数(已由 `parse_action` 校验;上限钳制在 [`run`] 内按配置完成)。
pub(crate) struct AutoParams {
    pub goal: String,
    /// 模型请求的步数(≥1)。
    pub max_steps: usize,
    pub stop_on_lowconf: bool,
    /// `type` 动作的输入文本(Jev 不生成文本,由调用方提供)。
    pub input_text: Option<String>,
    /// 首屏快照;缺省时循环内部自取。
    pub snapshot: Option<String>,
}

/// 终止原因(汇总首行向模型说明为什么停)。
pub(crate) enum StopReason {
    /// Jev 判 done(目标已完成)。
    Done,
    /// 用尽步数上限。
    MaxSteps,
    /// 置信度低于阈值且 `stop_on_lowconf`。
    LowConf { confidence: f64, threshold: f64 },
    /// 能力交接:Jev 的结构化决策产不出下一步所需(带说明)。
    Handoff(String),
    /// 防震荡:同一页面同一决策重复。
    Stall,
    /// 软错误(extract/decide/执行任一失败)。
    Error(String),
}

/// 一步执行记录(汇总行)。
pub(crate) struct StepRecord {
    index: usize,
    action: String,
    element_id: Option<String>,
    confidence: f64,
    outcome: String,
}

/// 防震荡判定键:(快照, 动作, 元素编号)。
type DecisionKey = (String, String, Option<String>);

/// 步数上限钳制:模型请求值压到配置区间内(配置区间见
/// [`AUTO_MAX_STEPS_RANGE`];请求值恒 ≥1,这里只压上界)。
pub(crate) fn effective_cap(requested: usize, configured: u64) -> usize {
    requested.min(configured.clamp(*AUTO_MAX_STEPS_RANGE.start(), *AUTO_MAX_STEPS_RANGE.end()) as usize)
}

/// 防震荡判定:本次决策与上一条完全相同(同一页面、同一动作、同一元素),
/// 即上一步执行没有产生任何页面变化——继续下去只会无限重复。
pub(crate) fn is_repeat(previous: &Option<DecisionKey>, current: &DecisionKey) -> bool {
    previous.as_ref() == Some(current)
}

/// `max_steps` 参数解析:缺省/非法/非正数回落 [`DEFAULT_MAX_STEPS`](与
/// `browser_extract` 的 `max_chars` 同款宽容风格)。
pub(crate) fn parse_max_steps(args: &serde_json::Value) -> usize {
    args.get("max_steps")
        .and_then(serde_json::Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as usize)
        .unwrap_or(DEFAULT_MAX_STEPS)
}

/// 跑一轮自动执行循环,返回汇总文本(任何失败都是软错误文本,不 Err——
/// 汇总里带终止原因与已执行步骤,交还主模型继续)。
pub(crate) async fn run(app: &AppHandle, engine: Engine, params: &AutoParams) -> String {
    let config = decide::jev_config(app).await;
    if !config.enabled {
        return "[Error] Jev 决策未启用:browser_auto 需要 Jev 决策,请在 设置 → AI 浏览器 打开「Jev 决策」并保存".to_string();
    }
    let cap = effective_cap(params.max_steps, config.auto_max_steps);
    let mut steps: Vec<StepRecord> = Vec::new();
    let mut pending_snapshot = params.snapshot.clone();
    let mut last_key: Option<DecisionKey> = None;
    let mut last_snapshot: Option<String> = None;
    let mut reason = StopReason::MaxSteps;

    for index in 1..=cap {
        // 1) 新鲜 extract(编号空间与页面当前状态对齐)。
        let snapshot = match pending_snapshot.take() {
            Some(snapshot) => snapshot,
            None => match execute(app, engine, BrowserAction::Extract { max_chars: DEFAULT_MAX_CHARS }).await {
                Ok(snapshot) => snapshot,
                Err(e) => {
                    reason = StopReason::Error(e);
                    break;
                }
            },
        };
        // 2) 问 Jev(每步重读配置:中途关开关 → 软错误中断,fail loud)。
        let (step_config, decision) = match decide::decide_struct(app, &params.goal, &snapshot).await {
            Ok(pair) => pair,
            Err(e) => {
                reason = StopReason::Error(e);
                break;
            }
        };
        // 3) 低置信度路由(与 browser_decide 的 [LOWCONF] 同语义)。
        if decision.confidence < step_config.threshold && params.stop_on_lowconf {
            reason = StopReason::LowConf {
                confidence: decision.confidence,
                threshold: step_config.threshold,
            };
            break;
        }
        if decision.action == "done" {
            reason = StopReason::Done;
            break;
        }
        // 4) 防震荡:同一页面同一决策重复即中断(在执行前)。
        let key: DecisionKey = (snapshot.clone(), decision.action.clone(), decision.element_id.clone());
        if is_repeat(&last_key, &key) {
            reason = StopReason::Stall;
            break;
        }
        last_key = Some(key);
        last_snapshot = Some(snapshot);
        // 5) 决策 → 单步原语(白名单/编号校验已在 decide 解析层完成)。
        let action = match decision.action.as_str() {
            "click" => match &decision.element_id {
                Some(id) => BrowserAction::Click { id: id.clone() },
                None => {
                    reason = StopReason::Handoff("Jev 选择 click 但未给出元素编号".to_string());
                    break;
                }
            },
            "type" => match (&decision.element_id, &params.input_text) {
                (Some(id), Some(text)) => BrowserAction::Type {
                    id: id.clone(),
                    text: text.clone(),
                    clear: false,
                },
                (Some(_), None) => {
                    reason = StopReason::Handoff(
                        "需要输入文本:请提供 browser_auto 的 input_text,或由主模型调用 browser_type"
                            .to_string(),
                    );
                    break;
                }
                (None, _) => {
                    reason = StopReason::Handoff("Jev 选择 type 但未给出元素编号".to_string());
                    break;
                }
            },
            "scroll" => BrowserAction::Scroll {
                direction: SCROLL_DIRECTION.to_string(),
                amount: SCROLL_AMOUNT,
            },
            "press_key" => BrowserAction::PressKey {
                key: PRESS_KEY.to_string(),
            },
            "select_option" => {
                reason = StopReason::Handoff(
                    "select_option 需要选项值(Jev 不生成自由文本),请主模型调用 browser_select_option"
                        .to_string(),
                );
                break;
            }
            other => {
                reason = StopReason::Handoff(format!("Jev 返回了未映射的动作「{other}」"));
                break;
            }
        };
        // 6) 执行;软错误([Error] 开头,如元素失效)立即中断交接。
        let outcome = match execute(app, engine, action).await {
            Ok(outcome) => outcome,
            Err(e) => {
                reason = StopReason::Error(e);
                break;
            }
        };
        if outcome.starts_with("[Error]") {
            reason = StopReason::Error(outcome);
            break;
        }
        steps.push(StepRecord {
            index,
            action: decision.action.clone(),
            element_id: decision.element_id.clone(),
            confidence: decision.confidence,
            outcome: first_line_capped(&outcome, STEP_OUTCOME_CHARS),
        });
    }

    render_summary(&steps, &reason, cap, last_snapshot.as_deref())
}

/// 引擎分发执行(与 `execute_from_bridge` 的单步路径同一函数)。
async fn execute(app: &AppHandle, engine: Engine, action: BrowserAction) -> Result<String, String> {
    match engine {
        Engine::Webview => webview::execute_action(app, action).await,
        Engine::Obscura => obscura::execute_action(app, action).await,
    }
}

/// 汇总渲染(纯函数):终止原因 + 每步一行 + 最终页面;总长截断到
/// [`MAX_SUMMARY_CHARS`]。
pub(crate) fn render_summary(
    steps: &[StepRecord],
    reason: &StopReason,
    cap: usize,
    last_snapshot: Option<&str>,
) -> String {
    let mut out = format!(
        "自动执行 {}/{} 步,终止原因:{}\n",
        steps.len(),
        cap,
        reason_line(reason)
    );
    for step in steps {
        let target = match &step.element_id {
            Some(id) => format!(" 元素[{id}]"),
            None => String::new(),
        };
        out.push_str(&format!(
            "[{}] {}{} conf={:.2} → {}\n",
            step.index, step.action, target, step.confidence, step.outcome
        ));
    }
    if let Some(snapshot) = last_snapshot {
        let (url, title) = decide::snapshot_url_title(snapshot);
        if !url.is_empty() || !title.is_empty() {
            out.push_str(&format!("最终页面:{title} ({url})"));
        }
    }
    truncate_chars(&out, MAX_SUMMARY_CHARS)
}

/// 终止原因的人类可读行(软错误/交接原文自带前缀)。
fn reason_line(reason: &StopReason) -> String {
    match reason {
        StopReason::Done => "done(目标已完成)".to_string(),
        StopReason::MaxSteps => "达到步数上限".to_string(),
        StopReason::LowConf { confidence, threshold } => format!(
            "[LOWCONF] 置信度 {confidence:.2} 低于阈值 {threshold:.2},交还主模型判断"
        ),
        StopReason::Handoff(message) => format!("[HANDOFF] {message}"),
        StopReason::Stall => {
            "[STALL] 同一页面同一决策重复(上一步没有产生页面变化),已中断".to_string()
        }
        StopReason::Error(message) => {
            if message.starts_with("[Error]") {
                message.clone()
            } else {
                format!("[Error] {message}")
            }
        }
    }
}

/// 取第一行并截断(执行结果可能带「当前页面:」后缀,汇总只留要点)。
fn first_line_capped(text: &str, max: usize) -> String {
    let first = text.lines().next().unwrap_or("");
    truncate_chars(first, max)
}

/// 按字符数截断(避免按字节切碎多字节字符)。
pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}\n…(输出已截断至 {max} 字符)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(index: usize, action: &str, element: Option<&str>) -> StepRecord {
        StepRecord {
            index,
            action: action.to_string(),
            element_id: element.map(str::to_string),
            confidence: 0.87,
            outcome: "已点击元素 [12]".to_string(),
        }
    }

    #[test]
    fn effective_cap_clamps_request_to_configured_range() {
        assert_eq!(effective_cap(8, 50), 8, "请求小于上限原样");
        assert_eq!(effective_cap(100, 50), 50, "请求超过上限被压");
        assert_eq!(effective_cap(500, 500), 500, "顶格");
        assert_eq!(effective_cap(8, 0), 1, "配置被读成 0 时保底 1 步");
        assert_eq!(effective_cap(8, 9999), 8, "配置超区间钳到 500,但请求更小");
        assert_eq!(effective_cap(600, 9999), 500, "配置超区间钳到 500 后压请求");
    }

    #[test]
    fn is_repeat_only_matches_identical_consecutive_decision() {
        let key = ("snap".to_string(), "click".to_string(), Some("12".to_string()));
        assert!(!is_repeat(&None, &key), "首条决策不是重复");
        assert!(is_repeat(&Some(key.clone()), &key), "同页面同动作同元素 = 重复");
        let other_action = ("snap".to_string(), "scroll".to_string(), None);
        assert!(!is_repeat(&Some(key.clone()), &other_action), "动作不同不算重复");
        let other_page = ("snap2".to_string(), "click".to_string(), Some("12".to_string()));
        assert!(!is_repeat(&Some(key), &other_page), "页面变了不算重复(翻页场景)");
    }

    #[test]
    fn parse_max_steps_falls_back_like_extract_max_chars() {
        assert_eq!(parse_max_steps(&serde_json::json!({})), 8);
        assert_eq!(parse_max_steps(&serde_json::json!({"max_steps": 30})), 30);
        assert_eq!(parse_max_steps(&serde_json::json!({"max_steps": 12.7})), 12, "向下取整");
        for bad in [
            serde_json::json!({"max_steps": 0}),
            serde_json::json!({"max_steps": -3}),
            serde_json::json!({"max_steps": "abc"}),
        ] {
            assert_eq!(parse_max_steps(&bad), 8, "非法值回落缺省:{bad}");
        }
    }

    #[test]
    fn render_summary_lists_steps_reason_and_final_page() {
        let steps = vec![step(1, "click", Some("12")), step(2, "scroll", None)];
        let text = render_summary(&steps, &StopReason::Done, 8, Some("url: https://x/\ntitle: 首页\n…"));
        assert!(text.starts_with("自动执行 2/8 步,终止原因:done(目标已完成)"), "{text}");
        assert!(text.contains("[1] click 元素[12] conf=0.87 → 已点击元素 [12]"), "{text}");
        assert!(text.contains("[2] scroll conf=0.87"), "{text}");
        assert!(text.contains("最终页面:首页 (https://x/)"), "{text}");
    }

    #[test]
    fn render_summary_marks_lowconf_handoff_and_stall() {
        let empty: Vec<StepRecord> = Vec::new();
        let lowconf = render_summary(
            &empty,
            &StopReason::LowConf { confidence: 0.41, threshold: 0.60 },
            8,
            None,
        );
        assert!(lowconf.starts_with("自动执行 0/8 步,终止原因:[LOWCONF] 置信度 0.41"), "{lowconf}");
        let handoff = render_summary(
            &empty,
            &StopReason::Handoff("select_option 需要选项值".to_string()),
            8,
            None,
        );
        assert!(handoff.contains("[HANDOFF] select_option 需要选项值"), "{handoff}");
        let stall = render_summary(&empty, &StopReason::Stall, 8, None);
        assert!(stall.contains("[STALL]"), "{stall}");
    }

    #[test]
    fn render_summary_truncates_to_max_chars() {
        let mut steps = Vec::new();
        for index in 1..=200 {
            steps.push(step(index, "click", Some("12")));
        }
        let text = render_summary(&steps, &StopReason::MaxSteps, 200, None);
        assert!(text.chars().count() <= MAX_SUMMARY_CHARS + 64, "截断后有截断标记余量");
        assert!(text.contains("输出已截断"), "{text}");
    }

    #[test]
    fn truncate_chars_never_splits_multibyte() {
        let text = "登录".repeat(10);
        let cut = truncate_chars(&text, 5);
        assert_eq!(cut.chars().count(), 5 + "\n…(输出已截断至 5 字符)".chars().count());
        assert!(cut.starts_with("登录登"), "{cut}");
    }
}
