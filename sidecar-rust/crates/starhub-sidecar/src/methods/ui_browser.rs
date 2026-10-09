//! UI 方法面 D 组第三批(去 Tauri 化 M2):AI 浏览器设置与 AI 模型密钥。
//!
//! Tauri 版契约见 `src-tauri/src/commands/{browser,secret}.rs`:
//! - 引擎(`browser.engine` 设置键)与 Jev 配置(6 个 `ai.jev.*` 设置键)都是
//!   **非密设置**,落 `FileSettingsStore`;Jev 配置结构体/缺省/校验/settings 键
//!   已平移到 [`starhub_domain_browser::jev`](两侧同一份,不可能漂移);
//! - AI 模型 API key 走密钥存储(Tauri = 系统 Keyring,sidecar = 密钥文件 /
//!   内存;key_id = `ai-model:<id>`,与资产密钥的 `asset:<id>` 同一套 seam)。
//!
//! 引擎设置只是**读写配置**:真正的 webview 窗口 / obscura 无头引擎随 M3 面板化
//! 落地,本批先把设置页的保存/回显语义补齐。

use serde_json::{json, Value};

use crate::assets::AssetStore;
use crate::jsonrpc::RpcError;
use crate::ui_runtime::UiRuntime;

/// 浏览器引擎设置键(与 Tauri 版 `ENGINE_SETTING_KEY` 同一把 key)。
const ENGINE_SETTING_KEY: &str = "browser.engine";

/// 取必填字符串参数。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
}

/// `ui.browser_get_engine`:当前 AI 浏览器引擎(webview | obscura;缺省 webview)。
pub fn browser_get_engine(ui: &UiRuntime) -> Result<Value, RpcError> {
    let engine = ui
        .settings()
        .read_all()
        .map_err(RpcError::internal)?
        .get(ENGINE_SETTING_KEY)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "webview".to_string());
    Ok(json!(engine))
}

/// `ui.browser_set_engine`:设置引擎;值非法报错(文案与 Tauri 版一致)。
pub fn browser_set_engine(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let engine = required_str(params, "engine")?;
    match engine.as_str() {
        "webview" | "obscura" => {}
        other => {
            return Err(RpcError::internal(format!(
                "未知浏览器引擎「{other}」,只支持 webview/obscura"
            )))
        }
    }
    ui.settings()
        .set(ENGINE_SETTING_KEY, &engine)
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.browser_get_jev_config`:Jev 决策配置(缺省全关;camelCase 线形状)。
pub fn browser_get_jev_config(ui: &UiRuntime) -> Result<Value, RpcError> {
    let settings = ui.settings().read_all().map_err(RpcError::internal)?;
    let config = starhub_domain_browser::jev::JevConfig::from_settings(&settings);
    Ok(json!(config))
}

/// `ui.browser_set_jev_config`:保存 Jev 决策配置(先过 validate,文案逐字)。
pub fn browser_set_jev_config(ui: &UiRuntime, params: &Value) -> Result<Value, RpcError> {
    let config: starhub_domain_browser::jev::JevConfig = serde_json::from_value(params.clone())
        .map_err(|error| RpcError::invalid_params(format!("参数解析失败: {error}")))?;
    config.validate().map_err(RpcError::internal)?;
    for (key, value) in config.to_settings() {
        ui.settings().set(key, &value).map_err(RpcError::internal)?;
    }
    Ok(Value::Null)
}

/// `ui.get_ai_model_api_key`:读 AI 模型密钥(不存在即硬错误,与 Tauri 版
/// `load_ai_model_api_key` 的 "no entry found" 语义一致——工作台据此显示
/// 「未设置」)。
pub fn get_ai_model_api_key(assets: &AssetStore, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let key_id = format!("{}{id}", AssetStore::AI_MODEL_KEY_PREFIX);
    assets
        .get_secret(&key_id)
        .map(|value| json!(value))
        .ok_or_else(|| RpcError::internal("Failed to load AI model API key: no entry found"))
}

/// `ui.set_ai_model_api_key`:写 AI 模型密钥。
pub fn set_ai_model_api_key(assets: &AssetStore, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let value = required_str(params, "value")?;
    let key_id = format!("{}{id}", AssetStore::AI_MODEL_KEY_PREFIX);
    assets
        .set_secret(&key_id, &value)
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.delete_ai_model_api_key`:删 AI 模型密钥(不存在即幂等成功)。
pub fn delete_ai_model_api_key(assets: &AssetStore, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let key_id = format!("{}{id}", AssetStore::AI_MODEL_KEY_PREFIX);
    assets.delete_secret(&key_id).map_err(RpcError::internal)?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetStore, MemorySecretStore};
    use serde_json::json;

    fn ui_in_temp(label: &str) -> (UiRuntime, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-browser-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ui = UiRuntime::new(
            crate::audit_store::AuditStore::new(dir.join("audit.json")),
            crate::alert_store::AlertStore::new(dir.join("alerts.json")),
            crate::desktop_runtime::FileSettingsStore::new(dir.join("settings.json")),
        );
        (ui, dir)
    }

    fn assets_in_temp(label: &str) -> (AssetStore, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-secrets-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = AssetStore::new(dir.join("assets.json"), Box::new(MemorySecretStore::new()));
        (assets, dir)
    }

    #[test]
    fn engine_setting_defaults_to_webview_and_validates() {
        let (ui, dir) = ui_in_temp("engine");
        assert_eq!(browser_get_engine(&ui).unwrap(), json!("webview"));
        browser_set_engine(&ui, &json!({ "engine": "obscura" })).unwrap();
        assert_eq!(browser_get_engine(&ui).unwrap(), json!("obscura"));
        let error = browser_set_engine(&ui, &json!({ "engine": "gecko" })).expect_err("非法引擎");
        assert_eq!(
            error.message,
            "未知浏览器引擎「gecko」,只支持 webview/obscura"
        );
        let error = browser_set_engine(&ui, &json!({})).expect_err("缺 engine");
        assert!(error.message.contains("缺少 engine"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn jev_config_roundtrips_through_the_settings_store() {
        let (ui, dir) = ui_in_temp("jev");
        // 缺省全关 + 官方端点
        let config = browser_get_jev_config(&ui).unwrap();
        assert_eq!(config["enabled"], false);
        assert_eq!(config["baseUrl"], "https://api.typesafe.ai");
        assert_eq!(config["autoMaxSteps"], 50);
        // 保存
        browser_set_jev_config(
            &ui,
            &json!({
                "enabled": true,
                "baseUrl": "https://jev.internal",
                "model": "jev-2",
                "threshold": 0.7,
                "timeoutMs": 9000,
                "autoMaxSteps": 120,
            }),
        )
        .unwrap();
        let config = browser_get_jev_config(&ui).unwrap();
        assert_eq!(config["enabled"], true);
        assert_eq!(config["baseUrl"], "https://jev.internal");
        assert_eq!(config["model"], "jev-2");
        assert_eq!(config["threshold"], 0.7);
        assert_eq!(config["timeoutMs"], 9000);
        assert_eq!(config["autoMaxSteps"], 120);
        // 校验失败:文案逐字(阈值越界)
        let error = browser_set_jev_config(
            &ui,
            &json!({
                "enabled": true, "baseUrl": "", "model": "m",
                "threshold": 2, "timeoutMs": 9000, "autoMaxSteps": 10,
            }),
        )
        .expect_err("阈值越界");
        assert_eq!(error.message, "阈值必须在 0.00–1.00 之间,收到 2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ai_model_api_key_roundtrips_through_the_secret_store() {
        let (assets, dir) = assets_in_temp("key");
        // 不存在:硬错误(工作台据此显示「未设置」)
        let error = get_ai_model_api_key(&assets, &json!({ "id": "jev" })).expect_err("密钥不存在");
        assert!(
            error.message.contains("no entry found"),
            "{}",
            error.message
        );
        set_ai_model_api_key(&assets, &json!({ "id": "jev", "value": "sk-test" })).unwrap();
        assert_eq!(
            get_ai_model_api_key(&assets, &json!({ "id": "jev" })).unwrap(),
            json!("sk-test")
        );
        // 不同 id 互相隔离
        let error = get_ai_model_api_key(&assets, &json!({ "id": "other" }))
            .expect_err("另一个 id 仍不存在");
        assert!(error.message.contains("no entry found"));
        // 删除幂等
        delete_ai_model_api_key(&assets, &json!({ "id": "jev" })).unwrap();
        delete_ai_model_api_key(&assets, &json!({ "id": "jev" })).unwrap();
        assert!(get_ai_model_api_key(&assets, &json!({ "id": "jev" })).is_err());
        // 缺参数
        let error = set_ai_model_api_key(&assets, &json!({ "id": "jev" })).expect_err("缺 value");
        assert!(error.message.contains("缺少 value"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
