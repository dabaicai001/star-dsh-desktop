//! UI 方法面 D 组第一批(去 Tauri 化 M2):设置页的审计与告警。
//!
//! 两者在 Tauri 版都是 SQLite 表(`audit_log` / `alert_rule`),sidecar 换成
//! 自有 JSON 存储(见 [`crate::audit_store`] / [`crate::alert_store`]),**字段、
//! 缺省、排序与文案逐字保持**:工作台 `AuditLogEntry` / `AlertRule` 接口是
//! snake_case,方法返回就按 snake_case 序列化。
//!
//! 参数形态沿用 Tauri command 签名:`audit_list(limit?, offset?, categoryFilter?)`
//! 平铺;`alert_create(input)` / `alert_update(id, input)` 把规则体包在 `input`
//! 键里。缺失即 -32602,文案与 A/B/C 组一致。

use serde_json::{json, Value};

use crate::alert_store::AlertRuleInput;
use crate::jsonrpc::RpcError;
use crate::ui_runtime::UiRuntime;

/// 取可选 i64(缺失或非数字均为 None)。
fn optional_i64(params: &Value, key: &str) -> Option<i64> {
    params.get(key).and_then(Value::as_i64)
}
/// 取必填字符串参数。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
}

/// 解析告警规则输入(`input` 信封;缺省即参数错误)。
fn rule_input(params: &Value) -> Result<AlertRuleInput, RpcError> {
    let input = params
        .get("input")
        .filter(|value| !value.is_null())
        .ok_or_else(|| RpcError::invalid_params("缺少 input"))?;
    serde_json::from_value::<AlertRuleInput>(input.clone())
        .map_err(|error| RpcError::invalid_params(format!("input 解析失败: {error}")))
}

/// `ui.audit_list`:分页查询(类别可选)。
///
/// 缺省 `limit` 200、上限 1000(与 Tauri 版一致);负 limit 沿用 SQLite 语义
/// (LIMIT -1 = 不限条数),负 offset 当作 0。
pub fn audit_list(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let limit = optional_i64(params, "limit").unwrap_or(200).min(1000);
    let offset = optional_i64(params, "offset").unwrap_or(0).max(0);
    let category_filter = params
        .get("categoryFilter")
        .and_then(Value::as_str)
        .map(str::to_string);
    let entries = ui
        .audit()
        .list(limit, offset, category_filter.as_deref())
        .map_err(RpcError::internal)?;
    Ok(json!(entries))
}

/// `ui.audit_clear`:清理指定时间戳之前的日志(不传则清空),返回删除条数。
pub fn audit_clear(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let before = optional_i64(params, "beforeTimestamp");
    let count = ui.audit().clear(before).map_err(RpcError::internal)?;
    Ok(json!(count))
}

/// `ui.audit_stats`:按「类别 + 本地日期」分组统计。
pub fn audit_stats(ui: &UiRuntime, _params: &Value) -> Result<Value, RpcError> {
    let stats = ui.audit().stats().map_err(RpcError::internal)?;
    Ok(json!(stats))
}

/// `ui.alert_create`:新建规则(id 由 sidecar 生成,与 Tauri 版 uuid 同地位)。
pub fn alert_create(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let input = rule_input(params)?;
    let rule = ui
        .alerts()
        .create(uuid::Uuid::new_v4().to_string(), &input)
        .map_err(RpcError::internal)?;
    Ok(json!(rule))
}

/// `ui.alert_update`:更新规则;不存在即硬错误(文案与 Tauri 版一致)。
pub fn alert_update(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let input = rule_input(params)?;
    let rule = ui
        .alerts()
        .update(&id, &input)
        .map_err(RpcError::internal)?;
    Ok(json!(rule))
}

/// `ui.alert_delete`:删除规则;不存在即硬错误。
pub fn alert_delete(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    ui.alerts().delete(&id).map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.alert_list`:全部规则(created_at DESC)。
pub fn alert_list(ui: &UiRuntime, _params: &Value) -> Result<Value, RpcError> {
    let rules = ui.alerts().list().map_err(RpcError::internal)?;
    Ok(json!(rules))
}

/// `ui.alert_test_webhook`:webhook 连通性测试。
///
/// **M4 实做**:给 sidecar 引入 reqwest(0.12,本地 registry 缓存可离线装)。
/// 当初判「不为一个测试按钮引入 reqwest 全家桶」不划算;现在判「划算」——
/// sidecar 已有 tokio runtime,reqwest 只是复用它的连接器,且告警外发本就是
/// sidecar 该做的事(归口后不再依赖 Electron 壳是否暴露同类能力)。
///
/// 语义(与 Tauri 版 `alert_test_webhook` 对齐):
/// - `url` 必填,缺失即 -32602;非 http(s) 直接报错(不发起请求);
/// - POST 一个探测载荷,3s 超时(测试按钮不该让用户等);
/// - 2xx → `{ok:true,status}`;非 2xx / 网络错误 → 硬错误,文案带原因。
pub async fn alert_test_webhook(_ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let url = required_str(params, "url")?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(RpcError::internal(format!(
            "Webhook 地址必须以 http:// 或 https:// 开头: {url}"
        )));
    }
    let payload = json!({
        "msgtype": "text",
        "text": { "content": "StarHub 告警 Webhook 测试:这是一条连通性探测消息。" }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| RpcError::internal(format!("Webhook 客户端创建失败: {e}")))?;
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| RpcError::internal(format!("Webhook 请求失败: {e}")))?;
    let status = response.status();
    if status.is_success() {
        Ok(json!({ "ok": true, "status": status.as_u16() }))
    } else {
        Err(RpcError::internal(format!(
            "Webhook 返回非 2xx 状态: {}",
            status.as_u16()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alert_store::AlertStore;
    use crate::audit_store::AuditStore;
    use serde_json::json;

    fn ui_in_temp(label: &str) -> (UiRuntime, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "starhub-ui-settings-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ui = UiRuntime::new(
            AuditStore::new(dir.join("audit.json")),
            AlertStore::new(dir.join("alerts.json")),
            crate::settings_store::FileSettingsStore::new(dir.join("settings.json")),
        );
        (ui, dir)
    }

    #[test]
    fn audit_list_applies_the_same_defaults_as_sql() {
        let (ui, dir) = ui_in_temp("audit");
        for index in 0..3 {
            ui.audit()
                .insert(crate::audit_store::AuditEntry {
                    id: 0,
                    timestamp: 1_000 + index,
                    category: "ai".to_string(),
                    action: "ssh_exec".to_string(),
                    target: None,
                    detail: None,
                    session_id: None,
                    asset_id: None,
                    success: true,
                })
                .unwrap();
        }
        // 缺省 limit 200 / offset 0
        let listed = audit_list(&ui, &json!({})).expect("list");
        assert_eq!(listed.as_array().unwrap().len(), 3);
        // 显式分页 + 类别筛选(null 与缺省等价)
        let page = audit_list(&ui, &json!({ "limit": 2, "offset": 1 })).expect("page");
        assert_eq!(page.as_array().unwrap().len(), 2);
        let filtered = audit_list(&ui, &json!({ "categoryFilter": null })).expect("filtered");
        assert_eq!(filtered.as_array().unwrap().len(), 3);
        let none = audit_list(&ui, &json!({ "categoryFilter": "ssh" })).expect("none");
        assert_eq!(none, json!([]));
        // 线形状 snake_case(工作台 AuditLogEntry)
        let first = &listed.as_array().unwrap()[0];
        assert!(first.get("session_id").is_some(), "{first}");
        assert!(first.get("asset_id").is_some(), "{first}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_clear_and_stats_roundtrip() {
        let (ui, dir) = ui_in_temp("stats");
        let now = chrono::Utc::now().timestamp();
        for (offset, success) in [(0_i64, true), (1, false)] {
            ui.audit()
                .insert(crate::audit_store::AuditEntry {
                    id: 0,
                    timestamp: now + offset,
                    category: "ai".to_string(),
                    action: "ssh_exec".to_string(),
                    target: None,
                    detail: None,
                    session_id: None,
                    asset_id: None,
                    success,
                })
                .unwrap();
        }
        let stats = audit_stats(&ui, &json!({})).expect("stats");
        let stats = stats.as_array().unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0]["category"], "ai");
        assert_eq!(stats[0]["total"], 2);
        assert_eq!(stats[0]["success"], 1);
        assert_eq!(stats[0]["failed"], 1);
        let cleared = audit_clear(&ui, &json!({})).expect("clear");
        assert_eq!(cleared, 2);
        assert_eq!(audit_list(&ui, &json!({})).expect("list"), json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn alert_crud_roundtrips_with_the_input_envelope() {
        let (ui, dir) = ui_in_temp("alerts");
        let created = alert_create(
            &ui,
            &json!({ "input": {
                "name": "错误率", "category": "ai", "metric": "ai.error_rate",
                "operator": ">", "threshold": 5,
            } }),
        )
        .expect("create");
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["name"], "错误率");
        assert_eq!(created["enabled"], true);
        assert_eq!(created["duration_sec"], 0);
        assert_eq!(created["cooldown_sec"], 300);
        // snake_case 线形状(工作台 AlertRule)
        assert!(created.get("webhook_url").is_some(), "{created}");
        assert!(created.get("created_at").is_some(), "{created}");

        let listed = alert_list(&ui, &json!({})).expect("list");
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let updated = alert_update(
            &ui,
            &json!({ "id": id, "input": {
                "name": "新名", "enabled": false, "category": "ai",
                "metric": "ai.error_rate", "operator": ">=", "threshold": 9,
            } }),
        )
        .expect("update");
        assert_eq!(updated["name"], "新名");
        assert_eq!(updated["enabled"], false);

        assert_eq!(
            alert_delete(&ui, &json!({ "id": id })).expect("delete"),
            json!(null)
        );
        assert_eq!(alert_list(&ui, &json!({})).expect("list"), json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn alert_errors_keep_the_tauri_wording() {
        let (ui, dir) = ui_in_temp("alert-errors");
        // 不存在:硬错误,文案与 Tauri 版一致
        let error = alert_update(
            &ui,
            &json!({ "id": "ghost", "input": {
                "name": "x", "category": "ai", "metric": "m", "operator": ">", "threshold": 1,
            } }),
        )
        .expect_err("规则不存在");
        assert_eq!(error.message, "Alert rule not found");
        assert_eq!(error.code, crate::jsonrpc::error_codes::INTERNAL_ERROR);
        let error = alert_delete(&ui, &json!({ "id": "ghost" })).expect_err("规则不存在");
        assert_eq!(error.message, "Alert rule not found");
        // 缺 id / 缺 input:参数错误
        let error = alert_delete(&ui, &json!({})).expect_err("缺 id");
        assert!(error.message.contains("缺少 id"), "{}", error.message);
        assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
        let error = alert_create(&ui, &json!({})).expect_err("缺 input");
        assert!(error.message.contains("缺少 input"), "{}", error.message);
        // input 结构不对:参数错误(带解析原因)
        let error =
            alert_create(&ui, &json!({ "input": { "name": "x" } })).expect_err("input 缺必填字段");
        assert!(
            error.message.starts_with("input 解析失败"),
            "{}",
            error.message
        );
        assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn webhook_test_validates_the_url_before_any_request() {
        let (ui, dir) = ui_in_temp("webhook");
        // 缺 url:参数错误(不发起请求)
        let error = alert_test_webhook(&ui, &json!({}))
            .await
            .expect_err("缺 url");
        assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
        assert!(error.message.contains("缺少 url"), "{}", error.message);
        // 非 http(s):同样在请求前拒绝(不摸网络)
        for bad in ["ftp://x", "example.com", ""] {
            let error = alert_test_webhook(&ui, &json!({ "url": bad }))
                .await
                .expect_err("协议不符");
            assert!(
                error.message.contains("必须以 http:// 或 https:// 开头"),
                "{bad}: {}",
                error.message
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
