//! 领域事件 schema 与构造(StarHub × dsh 联动,契约 §1,docs/联动实施-桥接契约-2026-08-17.md)。
//!
//! 四方(Rust / dsh 插件 / client-nav / Vue 面板)共用同一份事件形状:
//! `{ kind, assetId?, ts, summary, data, origin? }`;ts 为秒级 unix 时间戳,
//! `origin` 省略等价于 `"user"`。
//!
//! 规则(契约 §1):
//! - 终端高频输出不进事件流,只记「命令提交/完成」粒度;
//! - `summary` 单行、≤200 字符、不含敏感值(密码/密钥一律不落);
//! - AI 起源事件由 Rust 在 `starhub/tool.execute` 成功后自动生成(origin=ai),
//!   用户起源事件由前端经 `dsh_report_domain_event` 上报。

use serde::{Deserialize, Serialize};

/// summary 单行长度上限(契约 §1:≤200 字符)。
pub const MAX_SUMMARY_CHARS: usize = 200;
/// recentExecs / live.snapshot 中输出尾部的字节上限(契约 §2.2:≤2KB)。
pub const MAX_EXEC_TAIL_BYTES: usize = 2 * 1024;

/// 领域事件(契约 §1)。`origin` 省略 = "user",序列化时 None 不落盘。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainEvent {
    /// 事件类型,如 ssh.exec_completed / db.query_executed / sftp.transfer_completed。
    pub kind: String,
    /// 资产 id;无资产上下文时省略。
    #[serde(rename = "assetId", default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// 秒级 unix 时间戳;反序列化缺省 0,由接收方/command 层补当前时间。
    #[serde(default)]
    pub ts: i64,
    /// 模型可读单行摘要(≤200 字符)。
    #[serde(default)]
    pub summary: String,
    /// 领域负载(exitCode / rowCount / bytes / database / table ...)。
    #[serde(default)]
    pub data: serde_json::Value,
    /// 事件起源:"user" | "ai";省略 = user。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl DomainEvent {
    /// 构造一条当前时刻的事件;summary 经 [`normalize_summary`] 收敛为单行 ≤200 字符。
    pub fn now(
        kind: impl Into<String>,
        asset_id: Option<String>,
        summary: &str,
        data: serde_json::Value,
        origin: Option<&str>,
    ) -> Self {
        Self {
            kind: kind.into(),
            asset_id,
            ts: unix_now(),
            summary: normalize_summary(summary),
            data,
            origin: origin.map(str::to_string),
        }
    }
}

/// 秒级 unix 时间戳(契约 §1 ts 字段)。
pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 把任意文本收敛为合法 summary:压缩全部空白(含换行)为单个空格,
/// 截断到 ≤200 字符(截断时尾部加省略号,总长度仍 ≤200)。
pub fn normalize_summary(raw: &str) -> String {
    let single_line: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= MAX_SUMMARY_CHARS {
        return single_line;
    }
    let kept: String = single_line.chars().take(MAX_SUMMARY_CHARS - 1).collect();
    format!("{kept}…")
}

/// 取文本尾部 ≤2KB(char 边界安全),供 recentExecs / live.snapshot 的 tail 字段。
pub fn tail_of(text: &str) -> String {
    if text.len() <= MAX_EXEC_TAIL_BYTES {
        return text.to_string();
    }
    let mut start = text.len() - MAX_EXEC_TAIL_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

/// 工具名 → 领域事件 kind 映射表(契约 §1/M4;未匹配的工具用 tool.executed)。
pub fn kind_for_tool(tool: &str) -> &'static str {
    match tool {
        // SSH 命令类
        "ssh_exec" | "ssh_exec_background" | "ssh_wait_task" => "ssh.exec_completed",
        // sftp 传输类
        "sftp_upload" | "sftp_download" => "sftp.transfer_completed",
        // db 查询类(db_query / redis_exec / es_* 查询)
        "db_query" | "redis_exec" => "db.query_executed",
        other if other.starts_with("es_") => "db.query_executed",
        // AI 浏览器(无痕独立窗口)动作类
        other if other.starts_with("browser_") => "browser.action",
        _ => "tool.executed",
    }
}

/// 工具参数摘要:单行、只取非敏感字段(命令文本 / SQL / 路径 / index),
/// 绝不取 password/privateKey 等凭据字段(这些字段也不会出现在工具参数里,
/// 这里再做一层白名单防御)。
fn tool_summary(tool: &str, args: &serde_json::Value) -> String {
    let get = |key: &str| args.get(key).and_then(serde_json::Value::as_str).unwrap_or("");
    let count_of = |key: &str| {
        args.get(key)
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len)
    };
    match tool {
        "ssh_exec" | "ssh_exec_background" => {
            let command = get("command");
            if command.is_empty() {
                format!("{tool} 执行成功")
            } else {
                format!("{tool}: {command}")
            }
        }
        "ssh_wait_task" => format!("ssh_wait_task: {}", get("taskId")),
        "db_query" => {
            let sql = get("sql");
            if sql.is_empty() {
                "db_query 执行成功".to_string()
            } else {
                format!("db_query: {sql}")
            }
        }
        "redis_exec" => format!("redis_exec: {}", get("command")),
        "sftp_upload" => format!(
            "sftp_upload: {} 个文件 → {}",
            count_of("localPaths"),
            get("remoteDir")
        ),
        "sftp_download" => {
            format!("sftp_download: {} 个文件 ← 本地", count_of("remotePaths"))
        }
        other if other.starts_with("es_") => {
            let index = get("index");
            if index.is_empty() {
                format!("{other} 执行成功")
            } else {
                format!("{other}: {index}")
            }
        }
        other if other.starts_with("browser_") => {
            let url = get("url");
            if url.is_empty() {
                format!("{other} 执行成功")
            } else {
                format!("{other}: {url}")
            }
        }
        other => format!("{other} 执行成功"),
    }
}

/// `starhub/tool.execute` 成功后的 AI 起源领域事件(契约 §1/M4):
/// kind 按工具名映射,summary 单行 ≤200 字符且不含敏感值,origin=ai。
pub fn ai_tool_event(
    tool: &str,
    args: &serde_json::Value,
    asset_id: Option<String>,
) -> DomainEvent {
    DomainEvent::now(
        kind_for_tool(tool),
        asset_id,
        &tool_summary(tool, args),
        serde_json::json!({ "tool": tool }),
        Some("ai"),
    )
}

/// 每个资产最近一次 AI 工具执行的缓存条目(契约 §2.2 live.snapshot recentExecs)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentExec {
    pub asset_id: String,
    pub tool_name: String,
    pub summary: String,
    /// 输出尾部(≤2KB,char 边界安全)。
    pub tail: String,
    pub ts: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_summary_collapses_lines_and_truncates() {
        assert_eq!(normalize_summary("a\nb\r\nc   d"), "a b c d");
        assert_eq!(normalize_summary("  首尾空白  "), "首尾空白");

        let long = "x".repeat(500);
        let normalized = normalize_summary(&long);
        assert_eq!(normalized.chars().count(), MAX_SUMMARY_CHARS);
        assert!(normalized.ends_with('…'));

        // 多字节字符截断不炸
        let long_mb = "汉".repeat(300);
        let normalized = normalize_summary(&long_mb);
        assert_eq!(normalized.chars().count(), MAX_SUMMARY_CHARS);
    }

    #[test]
    fn tail_of_caps_at_2kb_char_boundary_safe() {
        let short = "hello";
        assert_eq!(tail_of(short), short);

        // 正好 2048 个 ASCII 字节
        let exact = "a".repeat(MAX_EXEC_TAIL_BYTES);
        assert_eq!(tail_of(&exact).len(), MAX_EXEC_TAIL_BYTES);

        // 超出且含多字节字符:按 char 边界对齐,不超上限
        let mut text = "汉".repeat(1024); // 3072 字节
        text.push_str("尾");
        let tail = tail_of(&text);
        assert!(tail.len() <= MAX_EXEC_TAIL_BYTES);
        assert!(text.ends_with(&tail));
    }

    #[test]
    fn kind_mapping_covers_known_domains_and_fallback() {
        assert_eq!(kind_for_tool("ssh_exec"), "ssh.exec_completed");
        assert_eq!(kind_for_tool("ssh_exec_background"), "ssh.exec_completed");
        assert_eq!(kind_for_tool("ssh_wait_task"), "ssh.exec_completed");
        assert_eq!(kind_for_tool("db_query"), "db.query_executed");
        assert_eq!(kind_for_tool("redis_exec"), "db.query_executed");
        assert_eq!(kind_for_tool("es_search"), "db.query_executed");
        assert_eq!(kind_for_tool("sftp_upload"), "sftp.transfer_completed");
        assert_eq!(kind_for_tool("sftp_download"), "sftp.transfer_completed");
        assert_eq!(kind_for_tool("docker_logs"), "tool.executed");
        assert_eq!(kind_for_tool("memory"), "tool.executed");
        assert_eq!(kind_for_tool("no_such_tool"), "tool.executed");
    }

    #[test]
    fn ai_event_has_origin_ai_and_single_line_summary() {
        let event = ai_tool_event(
            "ssh_exec",
            &serde_json::json!({ "command": "tail -n 5 /var/log/syslog\n第二行" }),
            Some("a1".to_string()),
        );
        assert_eq!(event.kind, "ssh.exec_completed");
        assert_eq!(event.origin.as_deref(), Some("ai"));
        assert_eq!(event.asset_id.as_deref(), Some("a1"));
        assert!(event.ts > 0);
        assert!(!event.summary.contains('\n'));
        assert!(event.summary.starts_with("ssh_exec: tail -n 5 /var/log/syslog"));
        assert!(event.summary.chars().count() <= MAX_SUMMARY_CHARS);
    }

    #[test]
    fn ai_event_summary_uses_whitelisted_arg_fields() {
        let event = ai_tool_event(
            "db_query",
            &serde_json::json!({ "sql": "SELECT * FROM t" }),
            None,
        );
        assert_eq!(event.summary, "db_query: SELECT * FROM t");

        let event = ai_tool_event(
            "sftp_upload",
            &serde_json::json!({ "localPaths": ["a", "b"], "remoteDir": "/tmp" }),
            None,
        );
        assert_eq!(event.summary, "sftp_upload: 2 个文件 → /tmp");

        // 未知工具:不带参数细节
        let event = ai_tool_event("docker_logs", &serde_json::json!({}), None);
        assert_eq!(event.summary, "docker_logs 执行成功");
        assert_eq!(event.kind, "tool.executed");
    }

    #[test]
    fn domain_event_serde_matches_contract_shape() {
        let event = DomainEvent::now(
            "db.query_executed",
            Some("a1".into()),
            "查了一张表",
            serde_json::json!({ "rowCount": 3 }),
            Some("user"),
        );
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["assetId"], "a1");
        assert_eq!(value["origin"], "user");
        assert!(value.get("asset_id").is_none(), "应序列化为 assetId");
        assert!(value["ts"].as_i64().expect("ts") > 0);

        // assetId / origin 缺省时省略键(契约:省略 = user)
        let event = DomainEvent::now("tool.executed", None, "x", serde_json::Value::Null, None);
        let value = serde_json::to_value(&event).expect("serialize");
        assert!(value.get("assetId").is_none());
        assert!(value.get("origin").is_none());

        // 前端上报形状(可缺 ts/data/origin)能反序列化
        let parsed: DomainEvent = serde_json::from_value(serde_json::json!({
            "kind": "db.query_executed",
            "assetId": "a2",
            "summary": "前端上报",
        }))
        .expect("deserialize");
        assert_eq!(parsed.ts, 0);
        assert_eq!(parsed.origin, None);
    }
}
