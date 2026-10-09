//! UI 方法面:AI 模型密钥(去 Tauri 化 M2 落地的 `ui.*_ai_model_api_key` 三方法)。
//!
//! 原本与「AI 浏览器」设置同住一个模块;M4 定稿把 AI 浏览器整体删除(上游 dsh
//! 原生提供 browser-use)之后,引擎与 Jev 配置那半边随 `starhub-domain-browser`
//! 一起退役,剩下的是这三个**与具体域无关**的密钥方法——按 id 寻址
//! (`ai-model:<id>`),谁都能用,因此单独成模块。
//!
//! Tauri 版契约见 `src-tauri/src/commands/secret.rs`(壳已退役,契约由这里的
//! 测试与验收脚本钉住):密钥走 `AssetStore` 的 SecretStore seam,Tauri 侧是系统
//! Keyring,sidecar 侧是密钥文件 / 内存——同一套 seam,§六 credentials 迁移的
//! 座席。不存在时报 `no entry found`(工作台据此显示「未设置」),**不存密码**
//! 进审计。

use serde_json::{json, Value};

use crate::assets::AssetStore;
use crate::jsonrpc::RpcError;

/// 取必填字符串参数。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
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

    fn assets_in_temp(label: &str) -> (AssetStore, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-keys-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = AssetStore::new(dir.join("assets.json"), Box::new(MemorySecretStore::new()));
        (assets, dir)
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

    #[test]
    fn ai_model_api_key_requires_an_id() {
        let (assets, dir) = assets_in_temp("no-id");
        for method in [
            get_ai_model_api_key as fn(&AssetStore, &Value) -> Result<Value, crate::jsonrpc::RpcError>,
            set_ai_model_api_key,
            delete_ai_model_api_key,
        ] {
            let error = method(&assets, &json!({})).expect_err("缺 id");
            assert_eq!(error.code, -32602);
            assert!(error.message.contains("缺少 id"), "{}", error.message);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
