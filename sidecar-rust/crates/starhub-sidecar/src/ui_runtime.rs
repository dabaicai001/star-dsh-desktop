//! UI 面 D 组的宿主持有状态(去 Tauri 化 M2):设置/审计/告警。
//!
//! 与 [`SshRuntime`](crate::runtime::SshRuntime) / [`DbRuntime`](crate::db_runtime::DbRuntime)
//! 平级:审计日志与告警规则都是低频小数据,JSON 文件承载(不值得引入 SQLite),
//! 字段与语义以 Tauri 版 SQLite 表为契约。
//!
//! D 组其余部分(android 配置 / 沙箱平台 / 浏览器引擎 / AI key)随下一批接入,
//! 届时往本结构加字段即可,主循环的装配点不变。

use crate::alert_store::AlertStore;
use crate::audit_store::AuditStore;

/// UI 面 D 组状态(审计 + 告警)。
pub struct UiRuntime {
    audit: AuditStore,
    alerts: AlertStore,
}

impl UiRuntime {
    /// 按环境变量装配(路径缺省落在 `<cwd>`,与其余存储一致)。
    pub fn from_env() -> Self {
        Self {
            audit: AuditStore::from_env(),
            alerts: AlertStore::from_env(),
        }
    }

    /// 用指定存储构造(测试 / 装配点用)。
    pub fn new(audit: AuditStore, alerts: AlertStore) -> Self {
        Self { audit, alerts }
    }

    /// 审计日志存储。
    pub fn audit(&self) -> &AuditStore {
        &self.audit
    }

    /// 告警规则存储。
    pub fn alerts(&self) -> &AlertStore {
        &self.alerts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_both_stores() {
        let dir = std::env::temp_dir().join(format!("starhub-ui-runtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ui = UiRuntime::new(
            AuditStore::new(dir.join("audit.json")),
            AlertStore::new(dir.join("alerts.json")),
        );
        assert!(ui.audit().list(10, 0, None).unwrap().is_empty());
        assert!(ui.alerts().list().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
