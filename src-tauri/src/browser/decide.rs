//! Jev 决策层(TypeSafe 「System One」决策模型):把「目标 + 页面快照」变成
//! 下一步浏览器动作的结构化判断,**只判断不执行**——真正的动作仍由主模型调
//! `browser_click` / `browser_type` 完成,审批链路因此原样保留。
//! 设计依据:`docs/Jev决策模型-浏览器操作接入调研.md` §6。
//!
//! Jev 官方接口(`POST {base_url}/v1/systemone`,Bearer Key)与 OpenAI Chat
//! Completions **不是**同一路径:请求体是 `state` + `questions`(每个问题带
//! `instructions` 与 `criteria` 候选集),应答是 `answers`(每个答案带
//! `choice`/`probabilities`/`confidence`,`noul`/`score` 同理)。所以这里
//! 直接裸 HTTP,不套任何 OpenAI SDK/SDK base_url——把 base_url 塞进
//! 会自动追加 `/chat/completions` 的客户端会打出错误路径。
//!
//! 安全边界:候选动作是**服务端白名单**(本文件的 [`ACTION_CRITERIA`]),不接受
//! 任何自由文本动作;元素编号沿用 extract 的纯数字语义;页面文本只能影响
//! 「选哪个候选」,不能创造新候选。

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;

// ------------------------------------------------------------
// 配置(非密走 settings 表,密钥走 keyring `model:jev`)
// ------------------------------------------------------------

/// 启用开关(settings 值 `0`/`1`),**默认关**:外部 SaaS,页面快照会外发。
pub const CONFIG_ENABLED: &str = "ai.jev.enabled";
/// Jev API base_url(官方 `https://api.typesafe.ai`,或网关/自建端点)。
pub const CONFIG_BASE_URL: &str = "ai.jev.base_url";
/// 模型名(官方示例返回 `jev-1.13.0`;缺省 `jev-latest`)。
pub const CONFIG_MODEL: &str = "ai.jev.model";
/// 置信度阈值,低于它返回 `[LOWCONF]` 提示主模型自行判断。
pub const CONFIG_THRESHOLD: &str = "ai.jev.threshold";
/// 单次决策超时(毫秒);决策对延迟敏感,默认 8s。
pub const CONFIG_TIMEOUT_MS: &str = "ai.jev.timeout_ms";
/// `browser_auto` 单次循环的步数上限(模型参数 `max_steps` 钳制到它)。
pub const CONFIG_AUTO_MAX_STEPS: &str = "ai.jev.auto_max_steps";

/// keyring 条目 id(entry key = `model:` + 本值,见 keyring::ai_model_api_key_id)。
pub const API_KEY_ID: &str = "jev";
/// 官方 API base(用户可改填 AI/ML API 等网关或内网自建端点)。
pub const DEFAULT_BASE_URL: &str = "https://api.typesafe.ai";
pub const DEFAULT_MODEL: &str = "jev-latest";
pub const DEFAULT_THRESHOLD: f64 = 0.60;
pub const DEFAULT_TIMEOUT_MS: u64 = 8_000;
/// 单次自动执行循环步数上限的缺省值(自定义入口:设置 → AI 浏览器)。
pub const DEFAULT_AUTO_MAX_STEPS: u64 = 50;
/// 步数上限的许可区间(设置页校验与读取钳制共用)。
pub const AUTO_MAX_STEPS_RANGE: std::ops::RangeInclusive<u64> = 1..=500;

/// 决策面(候选动作白名单):Jev 只能从这个封闭集里选,自由文本一律拒收。
pub(crate) const ACTION_CRITERIA: &[(&str, &str)] = &[
    ("click", "点击某个编号元素(配合 element 问题选择编号)"),
    ("type", "在某个编号输入框输入文本(配合 element 问题选择编号,文本由调用方提供)"),
    ("scroll", "滚动页面以看到更多元素"),
    ("press_key", "按一个键(通常是回车提交/切换焦点)"),
    ("select_option", "为某个编号下拉框选择选项(配合 element 问题选择编号)"),
    ("done", "目标已完成,或当前页面没有可推进目标的元素"),
];

/// 发给 Jev 的元素候选上限:extract 最多 300 个编号元素,全量进 criteria
/// 会把请求撑爆;截断只影响「可选项」,不影响正确性。
const MAX_ELEMENT_CANDIDATES: usize = 60;
/// state 里正文快照的截断上限(字符):决策只需结构与标签,不需要全文。
const MAX_STATE_CHARS: usize = 8_000;

/// Jev 决策配置(非密部分;API key 单独走 keyring)。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JevConfig {
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    /// 0.00–1.00;低于它的决策返回 `[LOWCONF]`。
    pub threshold: f64,
    /// 单次请求超时(毫秒)。
    pub timeout_ms: u64,
    /// `browser_auto` 单次循环步数上限(1–500;模型参数 `max_steps` 钳制到它)。
    pub auto_max_steps: u64,
}

impl Default for JevConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // 官方端点为缺省值:设置页加载即回显官方地址,用户启用后直接可用。
            // 历史上这里是空串,而前端 JEV_DEFAULT 是官方地址、`{...JEV_DEFAULT,
            // ...value}` 的展开让 Rust 空串覆盖前端默认 → 字段显示为空、保存后
            // `ai.jev.base_url` 落空,browser_decide 必然软失败(空值在 setting()
            // 读取时被过滤,同样回落到本默认,自愈)。validate() 仍允许显式置空。
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            threshold: DEFAULT_THRESHOLD,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            auto_max_steps: DEFAULT_AUTO_MAX_STEPS,
        }
    }
}

impl JevConfig {
    /// 设置页保存前的校验(软错误文本,前端原样展示)。
    pub fn validate(&self) -> Result<(), String> {
        if !(0.0..=1.0).contains(&self.threshold) {
            return Err(format!(
                "阈值必须在 0.00–1.00 之间,收到 {}",
                self.threshold
            ));
        }
        if !(500..=60_000).contains(&self.timeout_ms) {
            return Err(format!(
                "超时必须在 500–60000 毫秒之间,收到 {}",
                self.timeout_ms
            ));
        }
        if !AUTO_MAX_STEPS_RANGE.contains(&self.auto_max_steps) {
            return Err(format!(
                "单次自动执行步数上限必须在 1–500 之间,收到 {}",
                self.auto_max_steps
            ));
        }
        let url = self.base_url.trim();
        if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(format!("base_url 必须以 http:// 或 https:// 开头:{url}"));
        }
        if self.model.trim().is_empty() {
            return Err("模型名不能为空".to_string());
        }
        Ok(())
    }
}

/// 读一个 settings 键(失败/缺省返回 None)。settings 表经全局 pool 访问,
/// 不需要 AppHandle(与 browser::engine_setting 同模式)。
async fn setting(key: &str) -> Option<String> {
    let pool = crate::db::get_pool().ok()?;
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .filter(|v| !v.trim().is_empty())
}

/// 读取 Jev 决策配置(缺省值见 [`JevConfig::default`];库未就绪时全默认=关)。
pub async fn jev_config(_app: &AppHandle) -> JevConfig {
    let mut config = JevConfig::default();
    if let Some(value) = setting(CONFIG_ENABLED).await {
        config.enabled = value.trim() == "1";
    }
    if let Some(value) = setting(CONFIG_BASE_URL).await {
        config.base_url = value.trim().to_string();
    }
    if let Some(value) = setting(CONFIG_MODEL).await {
        config.model = value.trim().to_string();
    }
    if let Some(value) = setting(CONFIG_THRESHOLD).await {
        if let Ok(threshold) = value.trim().parse::<f64>() {
            config.threshold = threshold.clamp(0.0, 1.0);
        }
    }
    if let Some(value) = setting(CONFIG_TIMEOUT_MS).await {
        if let Ok(ms) = value.trim().parse::<u64>() {
            config.timeout_ms = ms.clamp(500, 60_000);
        }
    }
    if let Some(value) = setting(CONFIG_AUTO_MAX_STEPS).await {
        if let Ok(steps) = value.trim().parse::<u64>() {
            config.auto_max_steps = steps.clamp(
                *AUTO_MAX_STEPS_RANGE.start(),
                *AUTO_MAX_STEPS_RANGE.end(),
            );
        }
    }
    config
}

/// 写入 Jev 决策配置(6 个 settings 键;调用方先过 [`JevConfig::validate`])。
pub async fn save_jev_config(_app: &AppHandle, config: &JevConfig) -> Result<(), String> {
    let pool = crate::db::get_pool().map_err(|e| e.to_string())?;
    let entries = [
        (CONFIG_ENABLED, if config.enabled { "1" } else { "0" }.to_string()),
        (CONFIG_BASE_URL, config.base_url.trim().to_string()),
        (CONFIG_MODEL, config.model.trim().to_string()),
        (CONFIG_THRESHOLD, format!("{:.2}", config.threshold)),
        (CONFIG_TIMEOUT_MS, config.timeout_ms.to_string()),
        (CONFIG_AUTO_MAX_STEPS, config.auto_max_steps.to_string()),
    ];
    for (key, value) in entries {
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now')) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| format!("保存 Jev 配置失败:{e}"))?;
    }
    Ok(())
}

// ------------------------------------------------------------
// 决策结果(纯数据,单测可断言)
// ------------------------------------------------------------

/// 一次结构化决策(只读结论,不执行)。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Decision {
    /// 白名单动词(click/type/scroll/press_key/select_option/done)。
    pub action: String,
    /// 元素编号(纯数字;done/scroll/press_key 时为 None)。
    pub element_id: Option<String>,
    /// 置信度(缺省时回退为所选候选的概率)。
    pub confidence: f64,
    /// 完整概率分布(按概率降序),用于「备选」回显。
    pub probabilities: Vec<(String, f64)>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

// ------------------------------------------------------------
// 纯函数:请求构造 / 快照解析 / 响应校验 / 端点归一
// ------------------------------------------------------------

/// 从 extract 文本解析元素候选 `(编号, 标签)`。
/// 行格式:`[12] <button> "登录" …`(可能带 `[shadow]`/`[frame1] ` 前缀)。
pub(crate) fn element_candidates(snapshot: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in snapshot.lines() {
        if out.len() >= MAX_ELEMENT_CANDIDATES {
            break;
        }
        let Some((id, label)) = parse_element_line(line) else { continue };
        let label: String = label.trim().chars().take(120).collect();
        out.push((id.to_string(), label));
    }
    out
}

/// 解析一行元素描述:跳过可选 frame 前缀后,须为 `[纯数字] <标签> …`。
fn parse_element_line(line: &str) -> Option<(&str, &str)> {
    let mut rest = line.trim_start();
    // 最多容忍两段 frame 前缀(如 `[shadow] `、`[frame1] `)。
    for _ in 0..2 {
        if !rest.starts_with('[') {
            return None;
        }
        let close = rest.find(']')?;
        let inner = &rest[1..close];
        if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
            // `<tag>` 紧随其后的才是元素行(正文里的 `[注]` 不会命中)。
            return rest[close + 1..]
                .strip_prefix(" <")
                .map(|after| (inner, after));
        }
        rest = rest[close + 1..].trim_start();
    }
    None
}

/// 取快照头两行的 url/title(extract 输出固定以 `url:`/`title:` 开头)。
pub(crate) fn snapshot_url_title(snapshot: &str) -> (String, String) {
    let mut url = String::new();
    let mut title = String::new();
    for line in snapshot.lines().take(2) {
        if let Some(rest) = line.strip_prefix("url: ") {
            url = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("title: ") {
            title = rest.trim().to_string();
        }
    }
    (url, title)
}

/// 构造 Jev 请求体(`state` + `questions`,纯函数)。
pub(crate) fn build_request(config: &JevConfig, goal: &str, snapshot: &str) -> Value {
    let (url, title) = snapshot_url_title(snapshot);
    let snapshot: String = snapshot.chars().take(MAX_STATE_CHARS).collect();
    let state = format!(
        "目标:{goal}\n当前页面:{title} ({url})\n页面快照(编号元素 + 正文):\n{snapshot}"
    );

    let mut questions = serde_json::Map::new();
    let action_criteria: serde_json::Map<String, Value> = ACTION_CRITERIA
        .iter()
        .map(|(key, desc)| ((*key).to_string(), Value::String((*desc).to_string())))
        .collect();
    questions.insert(
        "action".to_string(),
        json!({
            "type": "choice",
            "instructions": "为了达成目标,下一步应对页面做什么?目标已达成、或页面上没有可推进目标的元素时选 done",
            "criteria": action_criteria,
        }),
    );
    let candidates = element_candidates(&snapshot);
    if !candidates.is_empty() {
        let element_criteria: serde_json::Map<String, Value> = candidates
            .into_iter()
            .map(|(id, label)| (id, Value::String(label)))
            .collect();
        questions.insert(
            "element".to_string(),
            json!({
                "type": "choice",
                "instructions": "如果动作是 click/type/select_option,应操作哪个元素?按编号选择;其它动作任意选一个即可",
                "criteria": element_criteria,
            }),
        );
    }

    json!({
        "model": config.model,
        "state": state,
        "questions": Value::Object(questions),
    })
}

/// 端点归一:base_url 允许带/不带尾斜杠与 `/v1`,统一拼到 `/v1/systemone`。
/// 绝不接受别的形态——OpenAI 客户端的 `base_url + /chat/completions` 自动
/// 拼接是错路径(见模块文档)。
pub(crate) fn endpoint(base_url: &str) -> Result<String, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("[Error] Jev base_url 未配置".to_string());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err(format!(
            "[Error] Jev base_url 必须以 http:// 或 https:// 开头:{base}"
        ));
    }
    let base = base.trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    Ok(format!("{base}/v1/systemone"))
}

/// 从 choice 答案取概率分布(按概率降序)。
fn choice_probabilities(answer: &Value) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, value)| (key.clone(), value.as_f64().unwrap_or(0.0)))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out
}

/// 解析 Jev 应答为 [`Decision`](crate::browser::decide::Decision)(纯函数)。
/// `threshold` 只参与日志/回显判定,不在这里做路由。
pub(crate) fn parse_decision(body: &str, threshold: f64) -> Result<Decision, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|e| format!("[Error] Jev 响应不是合法 JSON:{e}"))?;
    let answers = value
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| "[Error] Jev 响应缺少 answers 对象".to_string())?;

    let action = answers
        .get("action")
        .ok_or_else(|| "[Error] Jev 响应缺少 action 答案".to_string())?;
    let answer_type = action.get("type").and_then(Value::as_str).unwrap_or("");
    if answer_type != "choice" {
        return Err(format!(
            "[Error] Jev action 答案类型应为 choice,收到「{answer_type}」"
        ));
    }
    let choice = action
        .get("choice")
        .and_then(Value::as_str)
        .ok_or_else(|| "[Error] Jev action 答案缺少 choice 字段".to_string())?;
    if !ACTION_CRITERIA.iter().any(|(key, _)| *key == choice) {
        return Err(format!(
            "[Error] Jev 返回了白名单之外的动作「{choice}」,已拒收"
        ));
    }

    let probabilities = choice_probabilities(action);
    // 置信度缺省时回退为所选候选的概率;两者都缺省按 0 处理(必然 LOWCONF,
    // 交给主模型兜底——保守方向不会误自动化)。
    let confidence = action
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|c| (0.0..=1.0).contains(c))
        .or_else(|| {
            probabilities
                .iter()
                .find(|(key, _)| key == choice)
                .map(|(_, p)| *p)
        })
        .unwrap_or(0.0);

    let element_id = match answers.get("element") {
        Some(element) => {
            let element_type = element.get("type").and_then(Value::as_str).unwrap_or("");
            if element_type != "choice" {
                return Err(format!(
                    "[Error] Jev element 答案类型应为 choice,收到「{element_type}」"
                ));
            }
            let id = element
                .get("choice")
                .and_then(Value::as_str)
                .ok_or_else(|| "[Error] Jev element 答案缺少 choice 字段".to_string())?;
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!(
                    "[Error] Jev 返回的元素编号「{id}」不是纯数字(须为 browser_extract 的编号)"
                ));
            }
            Some(id.to_string())
        }
        None => None,
    };

    let _ = threshold; // 阈值只影响渲染层路由,不参与解析
    Ok(Decision {
        action: choice.to_string(),
        element_id,
        confidence,
        probabilities,
        input_tokens: value.pointer("/usage/input_tokens").and_then(Value::as_u64),
        output_tokens: value
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64),
    })
}

/// 渲染模型可读的决策文本(不执行任何动作)。
pub(crate) fn render_decision(config: &JevConfig, decision: &Decision, snapshot: &str) -> String {
    let (url, title) = snapshot_url_title(snapshot);
    let lowconf = decision.confidence < config.threshold;
    let mut out = String::new();
    if lowconf {
        out.push_str(&format!(
            "[LOWCONF] 置信度 {:.2} 低于阈值 {:.2},以下决策仅供参考,请自行判断:\n",
            decision.confidence, config.threshold
        ));
    }
    let target = match &decision.element_id {
        Some(id) => format!("元素[{id}]"),
        None => String::new(),
    };
    out.push_str(&format!(
        "决策:{}{}(confidence {:.2})\n",
        decision.action,
        if target.is_empty() {
            String::new()
        } else {
            format!(" {target}")
        },
        decision.confidence
    ));
    let alternatives: Vec<String> = decision
        .probabilities
        .iter()
        .filter(|(key, _)| *key != decision.action)
        .take(3)
        .map(|(key, p)| format!("{key}({p:.2})"))
        .collect();
    if !alternatives.is_empty() {
        out.push_str(&format!("备选:{}\n", alternatives.join(" ")));
    }
    let hint = match decision.action.as_str() {
        "click" => decision
            .element_id
            .as_ref()
            .map(|id| format!("下一步:调用 browser_click {{\"id\":\"{id}\"}}"))
            .unwrap_or_else(|| "下一步:请提供要点击的元素编号后调用 browser_click".to_string()),
        "type" => decision
            .element_id
            .as_ref()
            .map(|id| {
                format!("下一步:调用 browser_click 聚焦或 browser_type 输入(元素编号 {id},要输入的文本由你决定)")
            })
            .unwrap_or_else(|| "下一步:请提供输入框编号后调用 browser_type".to_string()),
        "scroll" => "下一步:调用 browser_scroll(可指定方向/像素量)".to_string(),
        "press_key" => "下一步:调用 browser_press_key(通常是 Enter)".to_string(),
        "select_option" => decision
            .element_id
            .as_ref()
            .map(|id| {
                format!("下一步:调用 browser_select_option(元素编号 {id},选项值由你决定)")
            })
            .unwrap_or_else(|| "下一步:请提供下拉框编号后调用 browser_select_option".to_string()),
        _ => "目标已达成或无法继续,可以收尾或改由你自行决策".to_string(),
    };
    out.push_str(&hint);
    out.push('\n');
    if let (Some(input), Some(output)) = (decision.input_tokens, decision.output_tokens) {
        out.push_str(&format!("usage:{input} in / {output} out\n"));
    }
    out.push_str(&format!("当前页面:{title} ({url})"));
    out
}

// ------------------------------------------------------------
// HTTP 客户端与桥入口
// ------------------------------------------------------------

/// 共享 reqwest Client(复用连接池/TLS),仿 commands/alert.rs::webhook_client。
fn jev_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    Ok(CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    }))
}

/// 调一次 Jev(可注入 base/key,便于将来做连通性测试)。
pub(crate) async fn decide_with(
    config: &JevConfig,
    api_key: &str,
    goal: &str,
    snapshot: &str,
) -> Result<Decision, String> {
    let url = endpoint(&config.base_url)?;
    let body = build_request(config, goal, snapshot);
    let response = jev_client()?
        .post(&url)
        .bearer_auth(api_key)
        .timeout(Duration::from_millis(config.timeout_ms))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("[Error] Jev 请求失败:{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("[Error] Jev 响应读取失败:{e}"))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!(
            "[Error] Jev 返回 HTTP {}({snippet})",
            status.as_u16()
        ));
    }
    parse_decision(&text, config.threshold)
}

/// 桥入口(`browser_decide` 工具在 mod.rs 的 Decide 分支调用):
/// 配置门 → 密钥 → HTTP → 决策文本。任何失败都是软错误(模型可纠正重试)。
pub async fn decide(app: &AppHandle, goal: &str, snapshot: &str) -> Result<String, String> {
    let (config, decision) = decide_struct(app, goal, snapshot).await?;
    Ok(render_decision(&config, &decision, snapshot))
}

/// 配置门 → 密钥 → HTTP → 结构化决策(`browser_decide` 与 `browser_auto`
/// 循环共用)。失败均为软错误;成功时落 `Jev 决策` info 行(循环内每一步
/// 各一条,starhub.log 可 grep 还原整条自动轨迹)。
pub(crate) async fn decide_struct(
    app: &AppHandle,
    goal: &str,
    snapshot: &str,
) -> Result<(JevConfig, Decision), String> {
    let config = jev_config(app).await;
    if !config.enabled {
        return Err("[Error] Jev 决策未启用:请在 设置 → AI 浏览器 打开「Jev 决策」并保存".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err(format!(
            "[Error] Jev base_url 未配置:请在 设置 → AI 浏览器 填写(默认 {DEFAULT_BASE_URL})"
        ));
    }
    let api_key = match crate::keyring::load_ai_model_api_key(API_KEY_ID.to_string()).await {
        Ok(key) if !key.trim().is_empty() => key,
        _ => {
            return Err("[Error] 未配置 Jev API key:请在 设置 → AI 浏览器 填写".to_string());
        }
    };
    let started = std::time::Instant::now();
    let decision = decide_with(&config, &api_key, goal, snapshot).await?;
    // 落一条日志:starhub.log 可 grep「Jev 决策」核对「这次浏览器任务到底有没有
    // 走 Jev」(审计表另有 action=browser_decide 的行,双通道可对照)。
    tracing::info!(
        action = %decision.action,
        element = %decision.element_id.as_deref().unwrap_or("-"),
        confidence = %decision.confidence,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "Jev 决策完成"
    );
    Ok((config, decision))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> JevConfig {
        JevConfig {
            enabled: true,
            base_url: "https://api.typesafe.ai".to_string(),
            model: "jev-latest".to_string(),
            threshold: 0.60,
            timeout_ms: 8_000,
            auto_max_steps: 50,
        }
    }

    const SNAPSHOT: &str = "url: https://example.com/login\ntitle: 登录页\n可交互元素 3 个(编号即 click/type 的 id;页面变化后需重新 extract):\n[1] <input> \"用户名\" type=text name=user\n[shadow] [2] <button> \"登录\"\n[3] <a> \"忘记密码\" href=/reset\n--- 页面正文(截取 5/6000 字符)---\n请登录";

    // ---------- endpoint ----------

    #[test]
    fn endpoint_normalizes_base_url_variants() {
        assert_eq!(
            endpoint("https://api.typesafe.ai").expect("bare"),
            "https://api.typesafe.ai/v1/systemone"
        );
        assert_eq!(
            endpoint("https://api.typesafe.ai/").expect("trailing slash"),
            "https://api.typesafe.ai/v1/systemone"
        );
        assert_eq!(
            endpoint("https://api.typesafe.ai/v1").expect("v1 suffix"),
            "https://api.typesafe.ai/v1/systemone"
        );
        assert_eq!(
            endpoint("http://jev.internal:8080/v1/").expect("internal"),
            "http://jev.internal:8080/v1/systemone"
        );
        assert!(endpoint("").is_err(), "空 base_url 报错");
        assert!(endpoint("ftp://x").is_err(), "只允许 http/https");
        // 绝不拼成 OpenAI 的 /chat/completions
        assert!(!endpoint("https://api.typesafe.ai")
            .expect("ok")
            .contains("chat/completions"));
    }

    // ---------- element_candidates ----------

    #[test]
    fn element_candidates_parses_numbered_lines() {
        let candidates = element_candidates(SNAPSHOT);
        assert_eq!(candidates.len(), 3);
        assert_eq!(candidates[0].0, "1");
        assert!(candidates[0].1.contains("用户名"));
        assert_eq!(candidates[1].0, "2", "带 [shadow] 前缀的编号行也要认");
        assert_eq!(candidates[2].0, "3");
    }

    #[test]
    fn element_candidates_ignores_non_element_lines() {
        let candidates = element_candidates("url: https://a.b\ntitle: t\n正文没有编号");
        assert!(candidates.is_empty());
    }

    #[test]
    fn element_candidates_caps_count() {
        let mut snapshot = String::new();
        for i in 1..=100 {
            snapshot.push_str(&format!("[{i}] <button> \"按钮{i}\"\n"));
        }
        assert_eq!(element_candidates(&snapshot).len(), MAX_ELEMENT_CANDIDATES);
    }

    // ---------- build_request ----------

    #[test]
    fn build_request_shapes_state_and_questions() {
        let request = build_request(&config(), "找到登录并进入", SNAPSHOT);
        assert_eq!(request["model"], "jev-latest");
        let state = request["state"].as_str().expect("state");
        assert!(state.contains("目标:找到登录并进入"));
        assert!(state.contains("https://example.com/login"));
        assert!(state.contains("登录页"));

        let criteria = request["questions"]["action"]["criteria"]
            .as_object()
            .expect("action criteria");
        for (key, _) in ACTION_CRITERIA {
            assert!(criteria.contains_key(*key), "动作白名单缺 {key}");
        }
        assert_eq!(request["questions"]["action"]["type"], "choice");

        let element_criteria = request["questions"]["element"]["criteria"]
            .as_object()
            .expect("element criteria");
        assert_eq!(element_criteria.len(), 3);
        assert!(element_criteria.contains_key("1"));
        assert!(element_criteria.contains_key("2"));
        assert!(element_criteria.contains_key("3"));
    }

    #[test]
    fn build_request_omits_element_question_without_elements() {
        let request = build_request(&config(), "看页面", "url: https://a.b\ntitle: t\n无元素");
        assert!(
            request["questions"].get("element").is_none(),
            "没有编号元素时不应问 element"
        );
        assert!(request["questions"]["action"].is_object());
    }

    // ---------- parse_decision ----------

    fn response(action: &str, element: Option<&str>, confidence: Option<f64>) -> String {
        let mut action_answer = json!({
            "type": "choice",
            "choice": action,
            "probabilities": { action: 1.0 }
        });
        if let Some(c) = confidence {
            action_answer["confidence"] = json!(c);
        }
        let mut answers = serde_json::Map::new();
        answers.insert("action".to_string(), action_answer);
        if let Some(id) = element {
            answers.insert(
                "element".to_string(),
                json!({ "type": "choice", "choice": id, "probabilities": { id: 1.0 } }),
            );
        }
        serde_json::to_string(&json!({
            "model": "jev-1.13.0",
            "answers": answers,
            "usage": { "input_tokens": 318, "output_tokens": 34 }
        }))
        .expect("json")
    }

    #[test]
    fn parse_decision_accepts_whitelisted_action_numeric_id() {
        let decision =
            parse_decision(&response("click", Some("12"), Some(0.87)), 0.60).expect("parse");
        assert_eq!(decision.action, "click");
        assert_eq!(decision.element_id.as_deref(), Some("12"));
        assert!((decision.confidence - 0.87).abs() < f64::EPSILON);
        assert_eq!(decision.input_tokens, Some(318));
        assert_eq!(decision.output_tokens, Some(34));
    }

    #[test]
    fn parse_decision_done_without_element() {
        let decision = parse_decision(&response("done", None, Some(0.91)), 0.60).expect("parse");
        assert_eq!(decision.action, "done");
        assert!(decision.element_id.is_none());
    }

    #[test]
    fn parse_decision_falls_back_to_chosen_probability() {
        let body = r#"{"answers":{"action":{"type":"choice","choice":"scroll","probabilities":{"scroll":0.44,"done":0.31}}}}"#;
        let decision = parse_decision(body, 0.60).expect("parse");
        assert!((decision.confidence - 0.44).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_decision_rejects_unknown_action_and_non_numeric_id() {
        assert!(parse_decision(&response("rm_rf", None, Some(0.9)), 0.60).is_err());
        assert!(parse_decision(&response("click", Some("12a"), Some(0.9)), 0.60).is_err());
        assert!(parse_decision(&response("click", Some(""), Some(0.9)), 0.60).is_err());
    }

    #[test]
    fn parse_decision_rejects_wrong_answer_type_and_bad_json() {
        let body = r#"{"answers":{"action":{"type":"noul","noul":0.9}}}"#;
        assert!(parse_decision(body, 0.60).is_err());
        assert!(parse_decision("not json", 0.60).is_err());
    }

    // ---------- render ----------

    #[test]
    fn render_marks_low_confidence_and_names_next_tool() {
        let config = config();
        let decision = Decision {
            action: "click".to_string(),
            element_id: Some("2".to_string()),
            confidence: 0.31,
            probabilities: vec![("click".into(), 0.31), ("scroll".into(), 0.08), ("done".into(), 0.05)],
            input_tokens: Some(318),
            output_tokens: Some(34),
        };
        let text = render_decision(&config, &decision, SNAPSHOT);
        assert!(text.starts_with("[LOWCONF]"), "{text}");
        assert!(text.contains("决策:click 元素[2]"), "{text}");
        assert!(text.contains("browser_click {\"id\":\"2\"}"), "{text}");
        assert!(text.contains("备选:scroll(0.08) done(0.05)"), "{text}");
        assert!(text.contains("当前页面:登录页 (https://example.com/login)"), "{text}");
    }

    #[test]
    fn render_high_confidence_has_no_lowconf_prefix() {
        let config = config();
        let decision = Decision {
            action: "done".to_string(),
            element_id: None,
            confidence: 0.91,
            probabilities: vec![("done".into(), 0.91)],
            input_tokens: None,
            output_tokens: None,
        };
        let text = render_decision(&config, &decision, SNAPSHOT);
        assert!(!text.contains("[LOWCONF]"), "{text}");
        assert!(text.starts_with("决策:done"), "{text}");
        assert!(!text.contains("usage:"), "{text}");
    }

    // ---------- config validate ----------

    #[test]
    fn default_config_falls_back_to_official_base_url() {
        // 缺省 base_url 必须是官方端点:历史上默认空串会让设置页显示空字段、
        // 保存后 browser_decide 必然软失败(base_url 未配置)。
        assert_eq!(JevConfig::default().base_url, DEFAULT_BASE_URL);
        assert!(!JevConfig::default().enabled, "启用开关仍默认关");
    }

    #[test]
    fn config_validate_ranges_and_url() {
        let mut bad = config();
        bad.threshold = 1.2;
        assert!(bad.validate().is_err());
        let mut bad = config();
        bad.timeout_ms = 100;
        assert!(bad.validate().is_err());
        let mut bad = config();
        bad.base_url = "jev.typesafe.ai".to_string();
        assert!(bad.validate().is_err());
        let mut ok = config();
        ok.base_url = String::new();
        assert!(ok.validate().is_ok(), "空 base_url 允许(等于未配置)");
        assert!(config().validate().is_ok());
    }

    #[test]
    fn auto_max_steps_default_validate_and_clamp_range() {
        assert_eq!(JevConfig::default().auto_max_steps, DEFAULT_AUTO_MAX_STEPS);
        for bad in [0u64, 501] {
            let mut config = config();
            config.auto_max_steps = bad;
            assert!(config.validate().is_err(), "步数上限 {bad} 必须拒绝");
        }
        for ok in [1u64, 50, 500] {
            let mut config = config();
            config.auto_max_steps = ok;
            assert!(config.validate().is_ok(), "步数上限 {ok} 必须允许");
        }
        assert_eq!(
            (*AUTO_MAX_STEPS_RANGE.start(), *AUTO_MAX_STEPS_RANGE.end()),
            (1, 500),
            "区间端点即设置页 min/max"
        );
    }
}
