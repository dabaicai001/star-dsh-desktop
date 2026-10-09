//! 告警规则存储(去 Tauri 化 M2 D 组):Tauri SQLite `alert_rule` 表的 sidecar
//! JSON 版承载。
//!
//! 与 `src-tauri/src/commands/alert.rs` 的字段/缺省/文案逐字对齐:
//! - 线形状 snake_case(`duration_sec` / `webhook_url` / `cooldown_sec` /
//!   `created_at` / `updated_at`,与工作台 `AlertRule` 接口一致);
//! - 缺省:`enabled` = true、`duration_sec` = 0、`cooldown_sec` = 300;
//! - `list` 按 `created_at DESC`(同时间戳保持插入倒序);
//! - `update` / `delete` 对不存在的 id 报 `Alert rule not found`;
//! - `update` 保留 `created_at`、刷新 `updated_at`(与 SQL 版一致)。
//!
//! `alert_check`(规则求值 + webhook 外发)工作台不调用,且 sidecar 刻意零 HTTP
//! 依赖,故不在本批平移;`ui.alert_test_webhook` 显式降级(见 methods/ui_settings)。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 告警规则(SQLite `alert_rule` 行;线形状 snake_case)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub category: String,
    pub metric: String,
    pub operator: String,
    pub threshold: f64,
    pub duration_sec: i64,
    pub webhook_url: Option<String>,
    pub cooldown_sec: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 创建/更新告警规则的参数(可选字段的缺省与 SQL 版一致)。
#[derive(Debug, Clone, Deserialize)]
pub struct AlertRuleInput {
    pub name: String,
    pub enabled: Option<bool>,
    pub category: String,
    pub metric: String,
    pub operator: String,
    pub threshold: f64,
    pub duration_sec: Option<i64>,
    pub webhook_url: Option<String>,
    pub cooldown_sec: Option<i64>,
}

/// JSON 文件版告警规则存储。
pub struct AlertStore {
    path: PathBuf,
    cache: Mutex<Option<Vec<AlertRule>>>,
}

impl AlertStore {
    /// 按环境变量解析路径:`STARHUB_ALERTS_FILE`,缺省 `<cwd>/starhub-alerts.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_ALERTS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-alerts.json"));
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

    fn load(&self) -> Result<Vec<AlertRule>, String> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(rules) = cache.as_ref() {
            return Ok(rules.clone());
        }
        let rules = match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<Vec<AlertRule>>(&bytes)
                .map_err(|error| format!("告警文件解析失败({}): {error}", self.path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(format!(
                    "告警文件读取失败({}): {error}",
                    self.path.display()
                ));
            }
        };
        *cache = Some(rules.clone());
        Ok(rules)
    }

    fn persist(&self, rules: &[AlertRule]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("告警目录创建失败({}): {error}", parent.display()))?;
            }
        }
        let text = serde_json::to_string_pretty(rules)
            .map_err(|error| format!("告警文件序列化失败: {error}"))?;
        std::fs::write(&self.path, text)
            .map_err(|error| format!("告警文件写入失败({}): {error}", self.path.display()))?;
        *self.cache.lock().unwrap() = Some(rules.to_vec());
        Ok(())
    }

    /// 读-改-写:持锁变更并落盘。
    fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Vec<AlertRule>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut rules = self.load()?;
        let outcome = change(&mut rules)?;
        self.persist(&rules)?;
        Ok(outcome)
    }

    /// 新建规则(id 由调用方生成;created_at/updated_at 同为当前时间)。
    pub fn create(&self, id: String, input: &AlertRuleInput) -> Result<AlertRule, String> {
        let now = chrono::Utc::now().timestamp();
        let rule = AlertRule {
            id,
            name: input.name.clone(),
            enabled: input.enabled.unwrap_or(true),
            category: input.category.clone(),
            metric: input.metric.clone(),
            operator: input.operator.clone(),
            threshold: input.threshold,
            duration_sec: input.duration_sec.unwrap_or(0),
            webhook_url: input.webhook_url.clone(),
            cooldown_sec: input.cooldown_sec.unwrap_or(300),
            created_at: now,
            updated_at: now,
        };
        self.mutate(|rules| {
            rules.push(rule.clone());
            Ok(rule)
        })
    }

    /// 更新规则(保留 created_at,刷新 updated_at);不存在即 `Alert rule not found`。
    pub fn update(&self, id: &str, input: &AlertRuleInput) -> Result<AlertRule, String> {
        let now = chrono::Utc::now().timestamp();
        self.mutate(|rules| {
            let rule = rules
                .iter_mut()
                .find(|rule| rule.id == id)
                .ok_or_else(|| "Alert rule not found".to_string())?;
            rule.name = input.name.clone();
            rule.enabled = input.enabled.unwrap_or(true);
            rule.category = input.category.clone();
            rule.metric = input.metric.clone();
            rule.operator = input.operator.clone();
            rule.threshold = input.threshold;
            rule.duration_sec = input.duration_sec.unwrap_or(0);
            rule.webhook_url = input.webhook_url.clone();
            rule.cooldown_sec = input.cooldown_sec.unwrap_or(300);
            rule.updated_at = now;
            Ok(rule.clone())
        })
    }

    /// 删除规则;不存在即 `Alert rule not found`。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.mutate(|rules| {
            let before = rules.len();
            rules.retain(|rule| rule.id != id);
            if rules.len() == before {
                return Err("Alert rule not found".to_string());
            }
            Ok(())
        })
    }

    /// 全部规则,按 `created_at DESC`(同时间戳保持插入倒序)。
    pub fn list(&self) -> Result<Vec<AlertRule>, String> {
        let mut rules = self.load()?;
        rules.reverse();
        Ok(rules)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in_temp(label: &str) -> (AlertStore, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-alerts-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (AlertStore::new(dir.join("alerts.json")), dir)
    }

    fn input(name: &str) -> AlertRuleInput {
        AlertRuleInput {
            name: name.to_string(),
            enabled: None,
            category: "ai".to_string(),
            metric: "ai.error_count".to_string(),
            operator: ">".to_string(),
            threshold: 3.0,
            duration_sec: None,
            webhook_url: Some("https://hooks.example/abc".to_string()),
            cooldown_sec: None,
        }
    }

    #[test]
    fn create_applies_the_same_defaults_as_sql() {
        let (store, dir) = store_in_temp("create");
        let rule = store
            .create("r1".to_string(), &input("错误率告警"))
            .unwrap();
        assert_eq!(rule.id, "r1");
        assert!(rule.enabled, "enabled 缺省 true");
        assert_eq!(rule.duration_sec, 0, "duration_sec 缺省 0");
        assert_eq!(rule.cooldown_sec, 300, "cooldown_sec 缺省 300");
        assert_eq!(rule.created_at, rule.updated_at);
        assert!(rule.created_at > 0);
        assert_eq!(
            rule.webhook_url.as_deref(),
            Some("https://hooks.example/abc")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_keeps_created_at_and_rejects_unknown_ids() {
        let (store, dir) = store_in_temp("update");
        let created = store.create("r1".to_string(), &input("旧名")).unwrap();
        let updated = store
            .update(
                "r1",
                &AlertRuleInput {
                    name: "新名".to_string(),
                    enabled: Some(false),
                    ..input("新名")
                },
            )
            .unwrap();
        assert_eq!(updated.name, "新名");
        assert!(!updated.enabled);
        assert_eq!(updated.created_at, created.created_at, "created_at 不动");
        assert!(updated.updated_at >= created.updated_at);
        let error = store.update("ghost", &input("x")).unwrap_err();
        assert_eq!(error, "Alert rule not found");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_rejects_unknown_ids_and_removes_the_row() {
        let (store, dir) = store_in_temp("delete");
        store.create("r1".to_string(), &input("a")).unwrap();
        store.create("r2".to_string(), &input("b")).unwrap();
        store.delete("r1").unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "r2");
        let error = store.delete("r1").unwrap_err();
        assert_eq!(error, "Alert rule not found");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_orders_by_created_at_descending() {
        let (store, dir) = store_in_temp("list");
        for name in ["a", "b", "c"] {
            store.create(format!("r-{name}"), &input(name)).unwrap();
            // 同一秒内创建也能靠插入倒序区分(与 SQL 的稳定行为一致)
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let listed = store.list().unwrap();
        assert_eq!(
            listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["r-c", "r-b", "r-a"],
            "最新的在前"
        );
        // 落盘后可被新实例读回
        let reopened = AlertStore::new(store.path());
        assert_eq!(reopened.list().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_fails_loud() {
        let (store, dir) = store_in_temp("corrupt");
        std::fs::write(store.path(), b"not json").unwrap();
        let error = store.list().unwrap_err();
        assert!(error.contains("告警文件解析失败"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
