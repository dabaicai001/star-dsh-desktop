//! 审计日志存储(去 Tauri 化 M2 D 组):Tauri SQLite `audit_log` 表的 sidecar
//! JSON 版承载。
//!
//! 与 `src-tauri/src/commands/audit.rs` 的字段/语义逐字对齐:
//! - 条目字段 snake_case 线形状(`session_id` / `asset_id`,与工作台
//!   `AuditLogEntry` 接口一致);
//! - `list` 按 `timestamp DESC, id DESC` 分页(与 SQL 的 ORDER BY 同序);
//! - `clear(before)` 只删该时间戳之前的,返回删除条数;
//! - `stats` 按「类别 + 本地日期」分组,`day DESC, category ASC` 排序
//!   (SQL 的 `date(timestamp,'unixepoch','localtime')` 同语义);
//! - 写入后修剪到 `MAX_AUDIT_ROWS` 条,只保留最新的(超上限删最早)。
//!
//! 写入方有两个:工作台的 `ui.audit_log`(UI 操作审计)与
//! [`record_tool_call`](AI 工具调用审计,category="ai")——后者与 Tauri 版
//! `harness::tools` 的审计同口径:action = 工具名,target = 绑定资产名
//! (资产已删回退 id),detail 只取白名单参数(定位信息,绝不取凭据)。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::TimeZone;
use serde::{Deserialize, Serialize};

/// 审计日志条数上限:超出后自动删除最早的记录(与 Tauri 版一致)。
pub const MAX_AUDIT_ROWS: usize = 5000;

/// detail 里允许携带的参数白名单(与 Tauri 版 `AUDIT_ARG_WHITELIST` 逐字一致:
/// 只取命令文本 / SQL / 索引 / 容器 / 路径等定位信息,绝不取凭据字段)。
const AUDIT_ARG_WHITELIST: &[&str] = &[
    "command",
    "sql",
    "index",
    "container",
    "target",
    "path",
    "query",
    "server",
    "tool",
    "task_id",
    "url",
    "id",
    "key",
    "goal",
    "host",
    "remotePath",
    "localDir",
    "remoteDir",
    "serial",
];

/// detail 里单个参数值的截断长度(字符)。
const DETAIL_VALUE_MAX_CHARS: usize = 500;

/// 审计日志条目(SQLite `audit_log` 行;线形状 snake_case)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: i64,
    pub timestamp: i64,
    pub category: String,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<serde_json::Value>,
    pub session_id: Option<String>,
    pub asset_id: Option<String>,
    pub success: bool,
}

/// 审计统计项(按类别 + 日期分组)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditStatItem {
    pub category: String,
    pub date: String,
    pub total: i64,
    pub success: i64,
    pub failed: i64,
}

/// JSON 文件版审计存储。
pub struct AuditStore {
    path: PathBuf,
    /// 进程内缓存:写穿透保持一致,读免落盘。
    cache: Mutex<Option<Vec<AuditEntry>>>,
}

impl AuditStore {
    /// 按环境变量解析路径:`STARHUB_AUDIT_FILE`,缺省 `<cwd>/starhub-audit.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_AUDIT_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-audit.json"));
        Self::new(path)
    }

    /// 用指定路径构造(测试用)。
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cache: Mutex::new(None),
        }
    }

    /// 存储文件路径(诊断信息用)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> Result<Vec<AuditEntry>, String> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(entries) = cache.as_ref() {
            return Ok(entries.clone());
        }
        let entries = match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<Vec<AuditEntry>>(&bytes)
                .map_err(|error| format!("审计文件解析失败({}): {error}", self.path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(format!(
                    "审计文件读取失败({}): {error}",
                    self.path.display()
                ));
            }
        };
        *cache = Some(entries.clone());
        Ok(entries)
    }

    fn persist(&self, entries: &[AuditEntry]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("审计目录创建失败({}): {error}", parent.display()))?;
            }
        }
        let text = serde_json::to_string_pretty(entries)
            .map_err(|error| format!("审计文件序列化失败: {error}"))?;
        std::fs::write(&self.path, text)
            .map_err(|error| format!("审计文件写入失败({}): {error}", self.path.display()))?;
        *self.cache.lock().unwrap() = Some(entries.to_vec());
        Ok(())
    }

    /// 读-改-写:持锁变更并落盘。
    fn update<T>(&self, mutate: impl FnOnce(&mut Vec<AuditEntry>) -> T) -> Result<T, String> {
        let mut entries = self.load()?;
        let outcome = mutate(&mut entries);
        self.persist(&entries)?;
        Ok(outcome)
    }

    /// 追加一条审计日志并修剪到上限;返回新条目 id。
    pub fn insert(&self, entry: AuditEntry) -> Result<i64, String> {
        self.update(|entries| {
            let next_id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
            let mut entry = entry;
            entry.id = next_id;
            entries.push(entry);
            trim_to_max(entries);
            next_id
        })
    }

    /// 分页查询(类别可选);按 `timestamp DESC, id DESC`。
    pub fn list(
        &self,
        limit: i64,
        offset: i64,
        category_filter: Option<&str>,
    ) -> Result<Vec<AuditEntry>, String> {
        let mut entries = self.load()?;
        if let Some(category) = category_filter {
            entries.retain(|entry| entry.category == category);
        }
        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id)));
        let start = offset.max(0) as usize;
        let count = limit.max(0) as usize;
        Ok(entries.into_iter().skip(start).take(count).collect())
    }

    /// 清理指定时间戳之前的日志(不传则清空);返回删除条数。
    pub fn clear(&self, before_timestamp: Option<i64>) -> Result<i64, String> {
        self.update(|entries| {
            let before = entries.len();
            match before_timestamp {
                Some(before_ts) => entries.retain(|entry| entry.timestamp >= before_ts),
                None => entries.clear(),
            }
            (before - entries.len()) as i64
        })
    }

    /// 按「类别 + 本地日期」分组统计,`day DESC, category ASC` 排序。
    pub fn stats(&self) -> Result<Vec<AuditStatItem>, String> {
        let entries = self.load()?;
        let mut grouped: Vec<(String, String, AuditStatItem)> = Vec::new();
        for entry in &entries {
            let date = chrono::Local
                .timestamp_opt(entry.timestamp, 0)
                .single()
                .map(|moment| moment.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            let slot = grouped
                .iter_mut()
                .find(|(category, day, _)| *category == entry.category && *day == date);
            match slot {
                Some((_, _, stat)) => {
                    stat.total += 1;
                    if entry.success {
                        stat.success += 1;
                    } else {
                        stat.failed += 1;
                    }
                }
                None => {
                    let date_for_item = date.clone();
                    grouped.push((
                        entry.category.clone(),
                        date,
                        AuditStatItem {
                            category: entry.category.clone(),
                            date: date_for_item,
                            total: 1,
                            success: i64::from(entry.success),
                            failed: i64::from(!entry.success),
                        },
                    ))
                }
            }
        }
        grouped.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(grouped.into_iter().map(|(_, _, stat)| stat).collect())
    }
}

/// 修剪到上限:只保留最新的 `MAX_AUDIT_ROWS` 条(按 timestamp, id 排序后取尾)。
///
/// 纯函数:写入路径(`insert`)与测试共用同一份排序/淘汰语义。
fn trim_to_max(entries: &mut Vec<AuditEntry>) {
    if entries.len() <= MAX_AUDIT_ROWS {
        return;
    }
    entries.sort_by(|a, b| a.timestamp.cmp(&b.timestamp).then_with(|| a.id.cmp(&b.id)));
    let excess = entries.len() - MAX_AUDIT_ROWS;
    entries.drain(..excess);
}

/// 字符截断(超长补省略号;与 Tauri 版 `truncate_chars` 同语义)。
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let kept: String = text.chars().take(max).collect();
        format!("{kept}\u{2026}")
    } else {
        text.to_string()
    }
}

/// AI 工具调用审计的上下文(由 stdio 主循环组装)。
pub struct ToolCallRecord<'a> {
    /// 工具名(= 方法名)。
    pub name: &'a str,
    /// 工具参数(只取白名单键进 detail)。
    pub args: &'a serde_json::Value,
    /// 会话绑定资产的名称(资产已删回退 id,无绑定为空)。
    pub asset_name: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub asset_id: Option<&'a str>,
    pub success: bool,
    pub duration_ms: u128,
    /// 失败时的错误原文(截断后进 detail)。
    pub error: Option<&'a str>,
}

/// AI 工具调用审计(设置 → 审计「AI」类别;与 Tauri 版 `harness::tools` 同口径)。
///
/// action = 工具名,target = 绑定资产名,detail 只取白名单参数 + `durationMs`,
/// 失败时附 `error`。写入失败只告警,不阻断工具调用本身。
pub fn record_tool_call(store: &AuditStore, record: &ToolCallRecord<'_>) {
    let mut detail = serde_json::Map::new();
    detail.insert(
        "tool".to_string(),
        serde_json::Value::String(record.name.to_string()),
    );
    for key in AUDIT_ARG_WHITELIST {
        if let Some(value) = record
            .args
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            detail.insert(
                (*key).to_string(),
                serde_json::Value::String(truncate_chars(value, DETAIL_VALUE_MAX_CHARS)),
            );
        }
    }
    detail.insert(
        "durationMs".to_string(),
        serde_json::Value::from(record.duration_ms as u64),
    );
    if let Some(error) = record.error {
        detail.insert(
            "error".to_string(),
            serde_json::Value::String(truncate_chars(error, DETAIL_VALUE_MAX_CHARS)),
        );
    }
    let entry = AuditEntry {
        id: 0,
        timestamp: chrono::Utc::now().timestamp(),
        category: "ai".to_string(),
        action: record.name.to_string(),
        target: record.asset_name.map(str::to_string),
        detail: Some(serde_json::Value::Object(detail)),
        session_id: record.session_id.map(str::to_string),
        asset_id: record.asset_id.map(str::to_string),
        success: record.success,
    };
    if let Err(error) = store.insert(entry) {
        eprintln!(
            "starhub-sidecar-rust: AI 工具审计写入失败({}): {error}",
            record.name
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store_in_temp(label: &str) -> (AuditStore, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-audit-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (AuditStore::new(dir.join("audit.json")), dir)
    }

    fn entry(timestamp: i64, category: &str, success: bool) -> AuditEntry {
        AuditEntry {
            id: 0,
            timestamp,
            category: category.to_string(),
            action: "ssh_exec".to_string(),
            target: Some("验收机".to_string()),
            detail: Some(json!({ "tool": "ssh_exec" })),
            session_id: Some("s1".to_string()),
            asset_id: Some("a1".to_string()),
            success,
        }
    }

    #[test]
    fn insert_assigns_increasing_ids_and_persists() {
        let (store, dir) = store_in_temp("insert");
        let first = store.insert(entry(1000, "ai", true)).unwrap();
        let second = store.insert(entry(1001, "db", false)).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 2);
        // 落盘后可被新实例读回
        let reopened = AuditStore::new(store.path());
        let listed = reopened.list(10, 0, None).unwrap();
        assert_eq!(listed.len(), 2);
        // timestamp DESC,id DESC:新的在前
        assert_eq!(listed[0].id, 2);
        assert_eq!(listed[1].id, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_filters_by_category_and_paginates() {
        let (store, dir) = store_in_temp("list");
        for index in 0..5 {
            let category = if index % 2 == 0 { "ai" } else { "db" };
            store.insert(entry(1000 + index, category, true)).unwrap();
        }
        let ai = store.list(10, 0, Some("ai")).unwrap();
        assert_eq!(ai.len(), 3, "ai 三条");
        assert!(ai.iter().all(|e| e.category == "ai"));
        let page = store.list(2, 1, None).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, 4, "跳过最新一条");
        let empty = store.list(10, 0, Some("ssh")).unwrap();
        assert!(empty.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_only_older_entries_and_counts() {
        let (store, dir) = store_in_temp("clear");
        for timestamp in [100, 200, 300] {
            store.insert(entry(timestamp, "ai", true)).unwrap();
        }
        let removed = store.clear(Some(200)).unwrap();
        assert_eq!(removed, 1, "只删 200 之前的");
        assert_eq!(store.list(10, 0, None).unwrap().len(), 2);
        let removed = store.clear(None).unwrap();
        assert_eq!(removed, 2, "不传时间戳清空");
        assert!(store.list(10, 0, None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stats_groups_by_category_and_local_day() {
        let (store, dir) = store_in_temp("stats");
        let today = chrono::Local::now().timestamp();
        store.insert(entry(today, "ai", true)).unwrap();
        store.insert(entry(today, "ai", false)).unwrap();
        store.insert(entry(today, "db", true)).unwrap();
        let stats = store.stats().unwrap();
        assert_eq!(stats.len(), 2, "按类别 + 日期分组");
        // 同一天:category ASC → ai 在前
        assert_eq!(stats[0].category, "ai");
        assert_eq!(stats[0].total, 2);
        assert_eq!(stats[0].success, 1);
        assert_eq!(stats[0].failed, 1);
        assert_eq!(stats[1].category, "db");
        assert_eq!(stats[1].total, 1);
        assert_eq!(stats[1].failed, 0);
        // 日期是本地 YYYY-MM-DD
        assert_eq!(stats[0].date.len(), 10, "{}", stats[0].date);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trim_keeps_the_newest_rows_only() {
        // 纯函数直测:5050 条里最早 50 条被淘汰(不走文件 I/O,秒级完成)。
        // 走真实存储的等价用例要 5000+ 次写穿透(O(n²)),语义已由本测覆盖。
        let base = 1_000_000_i64;
        let mut entries: Vec<AuditEntry> = (0..(MAX_AUDIT_ROWS + 50))
            .map(|index| entry(base + index as i64, "db", true))
            .collect();
        for (slot, item) in entries.iter_mut().enumerate() {
            item.id = slot as i64 + 1;
        }
        trim_to_max(&mut entries);
        assert_eq!(entries.len(), MAX_AUDIT_ROWS);
        // 排序后取尾:首条是最新保留的(base+50),末条是最新的(base+MAX+49)
        assert_eq!(entries[0].timestamp, base + 50, "最早 50 条应被删除");
        assert_eq!(
            entries[MAX_AUDIT_ROWS - 1].timestamp,
            base + (MAX_AUDIT_ROWS + 49) as i64,
            "最新一条必须保留"
        );
        // 未超上限时不动
        let mut small: Vec<AuditEntry> = (0..10).map(|index| entry(index, "db", true)).collect();
        trim_to_max(&mut small);
        assert_eq!(small.len(), 10);
    }

    #[test]
    fn record_tool_call_takes_only_whitelisted_args() {
        let (store, dir) = store_in_temp("tool");
        record_tool_call(
            &store,
            &ToolCallRecord {
                name: "ssh_exec",
                args: &json!({ "command": "systemctl status nginx", "password": "s3cret", "assetId": "a1" }),
                asset_name: Some("验收机"),
                session_id: Some("s1"),
                asset_id: Some("a1"),
                success: true,
                duration_ms: 12,
                error: None,
            },
        );
        let listed = store.list(10, 0, None).unwrap();
        assert_eq!(listed.len(), 1);
        let item = &listed[0];
        assert_eq!(item.category, "ai");
        assert_eq!(item.action, "ssh_exec");
        assert_eq!(item.target.as_deref(), Some("验收机"));
        assert_eq!(item.session_id.as_deref(), Some("s1"));
        assert_eq!(item.asset_id.as_deref(), Some("a1"));
        assert!(item.success);
        let detail = item.detail.as_ref().unwrap();
        assert_eq!(detail["tool"], "ssh_exec");
        assert_eq!(detail["command"], "systemctl status nginx");
        assert_eq!(detail["durationMs"], 12);
        // 凭据字段绝不进审计
        assert!(detail.get("password").is_none());
        let serialized = serde_json::to_string(item).unwrap();
        assert!(!serialized.contains("s3cret"), "{serialized}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_tool_call_truncates_long_values_and_errors() {
        let (store, dir) = store_in_temp("truncate");
        let long = "x".repeat(600);
        record_tool_call(
            &store,
            &ToolCallRecord {
                name: "db_query",
                args: &json!({ "sql": long }),
                asset_name: None,
                session_id: None,
                asset_id: None,
                success: false,
                duration_ms: 1,
                error: Some("boom"),
            },
        );
        let listed = store.list(10, 0, None).unwrap();
        let detail = listed[0].detail.as_ref().unwrap();
        let sql = detail["sql"].as_str().unwrap();
        assert_eq!(
            sql.chars().count(),
            DETAIL_VALUE_MAX_CHARS + 1,
            "截断 + 省略号"
        );
        assert!(sql.ends_with('\u{2026}'));
        assert_eq!(detail["error"], "boom");
        assert!(listed[0].target.is_none(), "无资产绑定时 target 为空");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_fails_loud() {
        let (store, dir) = store_in_temp("corrupt");
        std::fs::write(store.path(), b"not json").unwrap();
        let error = store.list(10, 0, None).unwrap_err();
        assert!(error.contains("审计文件解析失败"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
