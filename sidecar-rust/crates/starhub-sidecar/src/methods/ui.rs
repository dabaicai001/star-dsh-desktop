//! UI 方法面(`ui.<tauriCommand>`,去 Tauri 化 M2):React 工作台的前端命令。
//!
//! 与模型面(方法名 = 模型工具名)分开注册——两个面对同一样资源的不同参数面
//! (最典型:`sftp_list` 工具吃 `(assetId, path)`,工作台命令吃 `(id, path)`)。
//! bridge 的 `POST /starhub/api/invoke` 把 `cmd` 统一加成 `ui.<cmd>` 前缀,
//! 因此工作台的 113 个调用点一字不改,两个面也不可能互相踩。
//!
//! 命名/返回形状以 **Tauri command 为契约**:工作台 `RustAsset` 是 snake_case,
//! `ui.get_assets` 就返回 snake_case;错误文案与 `src-tauri/src/commands/asset.rs`
//! 逐字一致(用户可读文本是契约,不许漂移)。
//!
//! 本模块先落 A 组(资产 CRUD,存储已在 sidecar 手里);B/C/D 组按
//! `docs/去Tauri化-M2-命令映射清单.md` 的步骤逐个搬。

use serde_json::{json, Value};

use crate::assets::{AssetRecord, AssetStore};
use crate::jsonrpc::RpcError;

/// 资产类型白名单(与 Tauri `assets` 表 CHECK 一致;Excel 已删)。
const ASSET_TYPES: &[&str] = &["ssh", "db", "docker", "local"];

/// 取必填字符串参数。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
}

/// 取可选字符串参数(空串/缺省一律按缺省处理)。
fn optional_str(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 工作台参数负载:工作台按 Tauri command 契约把配置包在 `params` 键里
/// (`invoke('create_asset', { params })`);直接发 JSON-RPC 的调用方(协议
/// 测试、脚本)平铺下发。两种形态都受理,`params` 不是对象时退回平铺。
fn payload(params: &Value) -> &Value {
    params
        .get("params")
        .filter(|value| value.is_object())
        .unwrap_or(params)
}

/// 取标签数组(缺省空;非字符串元素忽略)。
fn tags_of(params: &Value) -> Vec<String> {
    params
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 校验资产类型(非法即参数错误,文案与 Tauri 侧一致)。
fn check_asset_type(asset_type: &str) -> Result<(), RpcError> {
    if ASSET_TYPES.contains(&asset_type) {
        return Ok(());
    }
    Err(RpcError::invalid_params(format!(
        "不支持的资产类型: {asset_type}(可用: {})",
        ASSET_TYPES.join(" / ")
    )))
}

/// `ui.get_assets`:全量资产(snake_case,与工作台 `RustAsset` 对齐;不含密钥)。
pub fn get_assets(store: &AssetStore, _params: &Value) -> Result<Value, RpcError> {
    let records = store.list().map_err(RpcError::internal)?;
    Ok(json!(records
        .iter()
        .map(AssetRecord::to_ui_json)
        .collect::<Vec<_>>()))
}

/// `ui.create_asset` / `ui.update_asset`:新建或更新资产。
///
/// 参数与 Tauri command 同形:`params` 里是
/// `{ id?, type, name, config, groupId?, tags?, favorite? }`,update 另把 `id`
/// 平铺在顶层(`{ id, params: { name, config } }`)。`id` 缺省即新建,**由 sidecar
/// 生成 uuid**(与 Tauri 版 `create_asset(name, type, config) -> Asset` 同一约定):
/// 工作台「新建连接」对话框从来不带 id,此前这里硬要 `id`,界面上的表现是
/// 「点创建没反应」——实际是 -32602「缺少 id」(2026-10-10 实测)。
///
/// 未下发的字段沿用既有行:update 只改名/改配置时,不会顺手清空 tags / favorite /
/// 分组,也不会把资产类型丢掉(`type` 缺省取既有行的类型)。
pub fn upsert_asset(store: &AssetStore, params: &Value) -> Result<Value, RpcError> {
    let payload = payload(params);
    let id = optional_str(params, "id")
        .or_else(|| optional_str(payload, "id"))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing = store.get(&id).ok();
    let asset_type = optional_str(payload, "type")
        .or_else(|| existing.as_ref().map(|record| record.asset_type.clone()))
        .ok_or_else(|| RpcError::invalid_params("缺少 type"))?;
    check_asset_type(&asset_type)?;
    let name = optional_str(payload, "name")
        .or_else(|| existing.as_ref().map(|record| record.name.clone()))
        .ok_or_else(|| RpcError::invalid_params("缺少 name"))?;
    let config = payload
        .get("config")
        .cloned()
        .or_else(|| existing.as_ref().map(|record| record.config.clone()))
        .unwrap_or(Value::Null);
    // 分组键两种拼法都认:工作台对话框发 snake_case 的 `group_id`,sidecar 契约
    // 是 camelCase 的 `groupId`(Tauri 侧 command 参数名)。
    let group_id = payload
        .get("groupId")
        .or_else(|| payload.get("group_id"))
        .and_then(Value::as_i64)
        .or_else(|| existing.as_ref().and_then(|record| record.group_id));
    let tags = match payload.get("tags") {
        Some(_) => tags_of(payload),
        None => existing
            .as_ref()
            .map(|record| record.tags.clone())
            .unwrap_or_default(),
    };
    let favorite = payload
        .get("favorite")
        .and_then(Value::as_bool)
        .or_else(|| existing.as_ref().map(|record| record.favorite))
        .unwrap_or(false);
    let record = store
        .upsert(&id, &asset_type, &name, config, group_id, tags, favorite)
        .map_err(RpcError::internal)?;
    Ok(record.to_ui_json())
}

/// `ui.delete_asset`:删除资产及其密钥(不存在即硬错误)。
pub fn delete_asset(store: &AssetStore, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    store.remove(&id).map_err(RpcError::internal)?;
    Ok(json!({ "ok": true, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::MemorySecretStore;
    use std::sync::Arc;

    fn store(label: &str) -> (Arc<AssetStore>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-assets-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(MemorySecretStore::new()),
        ));
        (store, dir)
    }

    #[test]
    fn create_then_list_returns_the_snake_case_wire_shape() {
        let (store, dir) = store("create");
        let created = upsert_asset(
            &store,
            &json!({
                "id": "a1",
                "type": "ssh",
                "name": "验收机",
                "config": { "host": "10.0.0.1", "port": 22, "username": "root", "password": "s3cret" },
                "groupId": 3,
                "tags": ["prod", "prod"],
                "favorite": true,
            }),
        )
        .expect("create");
        // snake_case 线形状(工作台 RustAsset)
        assert_eq!(created["id"], "a1");
        assert_eq!(created["type"], "ssh");
        assert_eq!(created["group_id"], 3);
        assert_eq!(created["key_id"], "asset:a1");
        assert_eq!(created["favorite"], true);
        assert_eq!(created["tags"], json!(["prod", "prod"]));
        assert!(created["created_at"].as_i64().unwrap() > 0);
        // 敏感字段被拆走:返回与列表都不带 password
        assert!(created["config"].get("password").is_none());
        let listed = get_assets(&store, &json!({})).expect("list");
        let items = listed.as_array().expect("array");
        assert_eq!(items.len(), 1);
        assert!(serde_json::to_string(&items[0])
            .unwrap()
            .contains("group_id"));
        assert!(!serde_json::to_string(&items[0]).unwrap().contains("s3cret"));
        // 合并密钥后仍拿得到密码(连接面用)
        let (_type, merged) = store.load_asset_config("a1").expect("load");
        assert_eq!(merged["password"], "s3cret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_keeps_id_and_timestamps_and_replaces_the_payload() {
        let (store, dir) = store("update");
        upsert_asset(
            &store,
            &json!({ "id": "a1", "type": "ssh", "name": "旧名", "config": {} }),
        )
        .expect("create");
        let updated = upsert_asset(
            &store,
            &json!({ "id": "a1", "type": "ssh", "name": "新名", "config": { "host": "h" }, "favorite": true }),
        )
        .expect("update");
        assert_eq!(updated["name"], "新名");
        assert_eq!(updated["favorite"], true);
        let listed = get_assets(&store, &json!({})).expect("list");
        assert_eq!(listed.as_array().expect("array").len(), 1, "更新不新增行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_the_row_and_its_secrets() {
        let (store, dir) = store("delete");
        upsert_asset(
            &store,
            &json!({ "id": "a1", "type": "db", "name": "库", "config": { "password": "p" } }),
        )
        .expect("create");
        let result = delete_asset(&store, &json!({ "id": "a1" })).expect("delete");
        assert_eq!(result["ok"], true);
        assert!(store.list().expect("list").is_empty());
        assert!(store.load_asset_config("a1").is_err(), "密钥应一并删除");
        let error = delete_asset(&store, &json!({ "id": "a1" })).expect_err("重复删除");
        assert!(error.message.contains("资产不存在"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workbench_create_accepts_the_wrapped_shape_and_generates_the_id() {
        let (store, dir) = store("workbench");
        // 工作台「新建连接」的真实负载:配置包在 `params` 里、不带 id、分组键是 group_id
        let created = upsert_asset(
            &store,
            &json!({
                "params": {
                    "type": "ssh",
                    "name": "测试服务器",
                    "group_id": null,
                    "config": { "host": "10.0.0.9", "port": 22, "username": "work", "password": "pw" },
                    "tags": [],
                }
            }),
        )
        .expect("create");
        let id = created["id"]
            .as_str()
            .expect("sidecar 生成的 id")
            .to_string();
        assert!(!id.is_empty());
        assert_eq!(created["name"], "测试服务器");
        assert_eq!(created["group_id"], Value::Null);
        // 保存(update)是另一种形态:id 平铺在顶层、`params` 里只有 name/config
        let updated = upsert_asset(
            &store,
            &json!({
                "id": id,
                "params": {
                    "name": "改名",
                    "config": { "host": "10.0.0.9", "port": 2222, "username": "work" },
                },
            }),
        )
        .expect("update");
        assert_eq!(updated["id"], id);
        assert_eq!(updated["name"], "改名");
        assert_eq!(updated["type"], "ssh", "type 缺省沿用既有行");
        assert_eq!(updated["config"]["port"], 2222);
        assert_eq!(store.list().expect("list").len(), 1, "更新不新增行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parameter_validation_matches_the_tauri_wording() {
        let (store, dir) = store("validate");
        let missing_type = upsert_asset(&store, &json!({ "name": "x" })).expect_err("缺 type");
        assert!(
            missing_type.message.contains("缺少 type"),
            "{}",
            missing_type.message
        );
        let missing_name = upsert_asset(&store, &json!({ "type": "ssh" })).expect_err("缺 name");
        assert!(
            missing_name.message.contains("缺少 name"),
            "{}",
            missing_name.message
        );
        let bad_type =
            upsert_asset(&store, &json!({ "type": "excel", "name": "x" })).expect_err("Excel 已删");
        assert!(
            bad_type.message.contains("不支持的资产类型"),
            "{}",
            bad_type.message
        );
        assert!(
            bad_type.message.contains("ssh / db / docker / local"),
            "{}",
            bad_type.message
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_legacy_minimal_file_format_still_reads() {
        let (store, dir) = store("legacy");
        std::fs::write(
            store.path(),
            r#"{"assets":[{"id":"a1","type":"ssh","name":"老资产","config":{"host":"h"}}]}"#,
        )
        .expect("seed");
        let listed = get_assets(&store, &json!({})).expect("list");
        let first = &listed.as_array().expect("array")[0];
        assert_eq!(first["id"], "a1");
        assert_eq!(first["group_id"], Value::Null);
        assert_eq!(first["tags"], json!([]));
        assert_eq!(first["favorite"], false);
        assert_eq!(first["created_at"], 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
