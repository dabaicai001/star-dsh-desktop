//! UI 方法面 D 组第二批(去 Tauri 化 M2):Android 设备设置与直播入口的 UI 命令。
//!
//! 与模型面(`android_*` 工具)分离:这些是设置页 / 直播面板的状态读写,**不做
//! 任何设备写操作**(写操作只由 AI 工具路径驱动,审批语义不被 UI 绕过)。Tauri 版
//! 契约见 `src-tauri/src/commands/android.rs`,字段与文案逐字保持。
//!
//! 设置在 [`FileSettingsStore`](crate::settings_store::FileSettingsStore)(与直播泵
//! 共用同一份文件),本模块提供设置页与直播面板需要的三件事:adb 路径读 / 写 /
//! 清除、设备列表只读、直播通道开启——`android_ui_open_live` 在 M3 真开通道
//! (帧出口)。

use serde_json::{json, Value};
use starhub_domain_android::adb::Adb;

use crate::android_runtime::AndroidRuntime;
use crate::jsonrpc::RpcError;

/// adb 路径设置键(与 android 域的 `ADB_PATH_SETTING_KEY` 同一把 key)。
const ADB_PATH_SETTING_KEY: &str = starhub_domain_android::manager::ADB_PATH_SETTING_KEY;

/// 取必填字符串参数。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
}

// ── Android 设备设置(设置页「Android 设备」tab) ──────────────

/// `ui.android_ui_get_config`:显式设置的 adb 路径 + 当前实际解析到的路径。
pub async fn android_get_config(android: &AndroidRuntime) -> Result<Value, RpcError> {
    let configured = android
        .settings()
        .read_all()
        .map_err(RpcError::internal)?
        .get(ADB_PATH_SETTING_KEY)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    let resolved = android.manager().cached_adb_path().await;
    Ok(json!({ "adbPath": configured, "resolvedAdb": resolved }))
}

/// `ui.android_ui_set_adb_path`:保存(空 = 清除,回落自动探测)。
///
/// 写前校验文件存在(文案与 Tauri 版一致);保存后清解析缓存,下一次 adb 调用
/// 按新值生效。
pub async fn android_set_adb_path(
    android: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_string);
    match path.filter(|value| !value.trim().is_empty()) {
        Some(trimmed) => {
            if !std::path::Path::new(&trimmed).is_file() {
                return Err(RpcError::internal(format!(
                    "adb 路径不存在或不是文件: {trimmed}"
                )));
            }
            android
                .settings()
                .set(ADB_PATH_SETTING_KEY, &trimmed)
                .map_err(RpcError::internal)?;
        }
        None => {
            android
                .settings()
                .remove(ADB_PATH_SETTING_KEY)
                .map_err(RpcError::internal)?;
        }
    }
    android.manager().invalidate_adb_cache().await;
    Ok(Value::Null)
}

/// `ui.android_ui_list_devices`:adb 设备列表(serial/state/model)。只读。
pub async fn android_list_devices(android: &AndroidRuntime) -> Result<Value, RpcError> {
    let adb = starhub_domain_android::adb::resolve_adb(android.manager(), android.settings())
        .await
        .map_err(RpcError::internal)?;
    let (stdout, _, _) = android
        .adb()
        .raw(&adb, None, &["devices".to_string(), "-l".to_string()], 15)
        .await
        .map_err(RpcError::internal)?;
    let devices = starhub_domain_android::keys::parse_devices(&String::from_utf8_lossy(&stdout));
    Ok(json!(devices
        .iter()
        .map(|device| {
            json!({
                "serial": device.serial,
                "state": device.state,
                "model": device.model,
            })
        })
        .collect::<Vec<_>>()))
}

/// `ui.android_ui_open_live`:打开设备直播通道(M3 面板化的帧出口)。
///
/// 用户点「直播」按钮 = 审批表达(与 Tauri 版 `ui_open_live` 同口径,不需要
/// 设备授权)。返回端点 + 首个一次性令牌:bridge 拿它代理 WS 给壳内面板。
pub async fn android_open_live(
    live: &crate::live_runtime::LiveRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let serial = required_str(params, "serial")?;
    crate::methods::ui_live::live_open(live, &json!({ "kind": "android", "serial": serial })).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::MemorySecretStore;
    use crate::bindings::SessionBindings;
    use std::sync::Arc;

    struct NoopSink;

    impl starhub_domain_ssh::events::EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    #[tokio::test]
    async fn android_config_roundtrips_the_adb_path_setting() {
        let dir = std::env::temp_dir().join(format!("starhub-ui-android-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 用一个真实存在的文件当 adb(不执行它,只验设置读写)
        let fake_adb = dir.join("adb.exe");
        std::fs::write(&fake_adb, b"").unwrap();
        let android = AndroidRuntime::with_paths(
            Arc::new(crate::assets::AssetStore::new(
                dir.join("assets.json"),
                Box::new(MemorySecretStore::new()),
            )),
            Arc::new(SessionBindings::new()),
            Arc::new(NoopSink),
            crate::settings_store::FileSettingsStore::new(dir.join("settings.json")),
            crate::methods::android::EnvCacheDir,
            crate::methods::android::FileFrameStore::new(dir.join("frames.json")),
        );
        // 初始:未配置
        let config = android_get_config(&android).await.expect("config");
        assert_eq!(config["adbPath"], Value::Null);
        assert_eq!(config["resolvedAdb"], Value::Null);
        // 写入
        android_set_adb_path(&android, &json!({ "path": fake_adb.to_string_lossy() }))
            .await
            .expect("set adb path");
        let config = android_get_config(&android).await.expect("config");
        assert_eq!(config["adbPath"], fake_adb.to_string_lossy().to_string());
        // 不存在的路径:文案与 Tauri 版一致
        let error = android_set_adb_path(
            &android,
            &json!({ "path": dir.join("nope").to_string_lossy() }),
        )
        .await
        .expect_err("路径不存在");
        assert!(
            error.message.starts_with("adb 路径不存在或不是文件"),
            "{}",
            error.message
        );
        // 清除(空串 = 回落自动探测)
        android_set_adb_path(&android, &json!({ "path": "" }))
            .await
            .expect("clear");
        let config = android_get_config(&android).await.expect("config");
        assert_eq!(config["adbPath"], Value::Null);
        // 直播通道(M3):WS server 未启动时给出明确原因,而不是 -32601
        let live = crate::live_runtime::LiveRuntime::without_server(
            Arc::new(crate::settings_store::FileSettingsStore::new(
                dir.join("live-settings.json"),
            )),
            Arc::new(starhub_domain_android::AndroidManager::new()),
        );
        let error = live_open_via_ui(&live, &json!({ "serial": "s1" }))
            .await
            .expect_err("WS 未启动");
        assert!(
            error.message.contains("直播帧通道未启动"),
            "{}",
            error.message
        );
        let error = live_open_via_ui(&live, &json!({}))
            .await
            .expect_err("缺 serial");
        assert!(error.message.contains("缺少 serial"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 测试替身:与 `android_open_live` 同路径(它只是 live_open 的 android 包装)。
    async fn live_open_via_ui(
        live: &crate::live_runtime::LiveRuntime,
        params: &Value,
    ) -> Result<Value, RpcError> {
        crate::methods::ui_live::live_open(live, params).await
    }
}
