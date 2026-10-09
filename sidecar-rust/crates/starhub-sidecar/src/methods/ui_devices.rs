//! UI 方法面 D 组第二批(去 Tauri 化 M2):Android 设备设置与沙箱桌面的 UI 命令。
//!
//! 与模型面(`android_*` / `desktop_*` 工具)分离:这些是设置页 / 沙箱 tab 的
//! 状态读写,**不做任何设备/容器写操作**(写操作只由 AI 工具路径驱动,审批语义
//! 不被 UI 绕过)。Tauri 版契约见 `src-tauri/src/commands/{android,desktop}.rs`,
//! 字段与文案逐字保持。
//!
//! 存储侧多数已在 sidecar:沙箱实例/模板/回放帧在
//! [`FileInstanceStore`](crate::desktop_store::FileInstanceStore),设置在
//! [`FileSettingsStore`](crate::desktop_runtime::FileSettingsStore)(与 Android
//! 域共用同一份文件),人工介入应答在 [`DesktopManager`] 的待应答表里。
//! 本模块补两件 sidecar 侧没有的东西:
//! 1. `FileInstanceStore` 的 UI 投影方法(全量实例 / 模板 upsert / 删除 / 全量帧);
//! 2. `FileSettingsStore` 的 `set` / `remove`(域工具只需要读,UI 面才需要写)。
//!
//! `android_ui_open_live` 在 M3 已真开通道(帧出口);`desktop_ui_open_live_window`
//! 则是终态降级——沙箱直播/接管线去掉,上游 dsh 原生 computer-use 承接。

use serde_json::{json, Value};
use starhub_domain_android::adb::Adb;

use crate::android_runtime::AndroidRuntime;
use crate::desktop_runtime::DesktopRuntime;
use crate::jsonrpc::RpcError;

/// 沙箱平台设置键(与 desktop 域的 `PLATFORM_SETTING_KEY` 同一把 key)。
const PLATFORM_SETTING_KEY: &str = "desktop.platform_asset_id";

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

// ── 沙箱桌面(前端沙箱 tab / 设置页 / 模板管理) ────────────────

/// `ui.desktop_ui_overview`:实例列表 + 模板列表 + 当前平台选择。
pub fn desktop_overview(desktop: &DesktopRuntime) -> Result<Value, RpcError> {
    let instances = desktop
        .store()
        .all_instances()
        .map_err(RpcError::internal)?
        .into_iter()
        .map(|instance| {
            json!({
                "id": instance.id,
                "containerId": instance.container_id,
                "platform": instance.platform,
                "novncPort": instance.novnc_port,
                "status": instance.status,
                "task": instance.task,
                "createdAt": instance.created_at,
            })
        })
        .collect::<Vec<_>>();
    let templates = desktop
        .store()
        .all_templates()
        .map_err(RpcError::internal)?
        .into_iter()
        .map(|template| {
            json!({
                "id": template.id,
                "name": template.name,
                "recipe": template.recipe,
                "imageTag": template.image_tag,
                "createdAt": template.created_at,
            })
        })
        .collect::<Vec<_>>();
    let platform = desktop
        .settings()
        .read_all()
        .map_err(RpcError::internal)?
        .get(PLATFORM_SETTING_KEY)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    Ok(json!({
        "instances": instances,
        "templates": templates,
        "platformAssetId": platform,
    }))
}

/// `ui.desktop_ui_set_platform`:设置页「沙箱平台」选择器(空 = 默认本机 Docker)。
pub fn desktop_set_platform(desktop: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    let asset_id = params
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    match asset_id {
        Some(id) => {
            // 只允许指向 docker 类型资产(平台选择是安全决策,写前校验)
            let asset_type = desktop
                .assets()
                .load_asset_config(&id)
                .map_err(RpcError::internal)?
                .0;
            if asset_type != "docker" {
                return Err(RpcError::internal(format!(
                    "资产 {id} 不是 Docker 连接({asset_type})"
                )));
            }
            desktop
                .settings()
                .set(PLATFORM_SETTING_KEY, &id)
                .map_err(RpcError::internal)?;
        }
        None => {
            desktop
                .settings()
                .remove(PLATFORM_SETTING_KEY)
                .map_err(RpcError::internal)?;
        }
    }
    Ok(Value::Null)
}

/// `ui.desktop_ui_upsert_template`:模板新增/更新(按 name 唯一;配方先校验)。
pub fn desktop_upsert_template(
    desktop: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let name = required_str(params, "name")?;
    let recipe_toml = required_str(params, "recipeToml")?;
    let parsed =
        starhub_domain_desktop::recipe::parse_recipe(&recipe_toml).map_err(RpcError::internal)?;
    if parsed.name != name {
        return Err(RpcError::internal(format!(
            "配方内 name({})与模板名({name})不一致",
            parsed.name
        )));
    }
    desktop
        .store()
        .upsert_template(&name, &recipe_toml)
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.desktop_ui_delete_template`:模板删除(不影响已从它创建的实例)。
pub fn desktop_delete_template(
    desktop: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let name = required_str(params, "name")?;
    desktop
        .store()
        .delete_template(&name)
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.desktop_ui_replay_frames`:某沙箱的全部回放帧。
pub fn desktop_replay_frames(desktop: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    let sandbox_id = required_str(params, "sandboxId")?;
    let frames = desktop
        .store()
        .all_frames(&sandbox_id)
        .map_err(RpcError::internal)?
        .into_iter()
        .map(|frame| {
            json!({
                "action": frame.action,
                "shotPath": frame.shot_path,
                "createdAt": frame.created_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "frames": frames }))
}

/// `ui.desktop_ui_lifecycle`:停止/恢复/销毁(与 AI 工具路径同一份编排,但**不经
/// 任务授权**——这是用户自己的手,按钮点击即审批表达)。
pub async fn desktop_lifecycle(
    desktop: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let sandbox_id = required_str(params, "sandboxId")?;
    let action = required_str(params, "action")?;
    // UI 调用没有会话上下文:授权相关的入口 ui_lifecycle 一概不碰,传空会话即可
    let text =
        starhub_domain_desktop::exec::ui_lifecycle(&desktop.context(""), &sandbox_id, &action)
            .await
            .map_err(RpcError::internal)?;
    Ok(json!(text))
}

/// `ui.desktop_ui_open_live_window`:沙箱直播/接管——**不再由 StarHub 提供**。
///
/// 去 Tauri 化 M3 定稿:browser 与沙箱桌面的直播/接管线去掉,上游 dsh 原生提供
/// browser-use / computer-use 及其可见面(沙箱桌面本身就是「computer use」的
/// 载体),StarHub 重复造一份只会双轨维护。参数仍然校验(调用方拿到的错误信息
/// 因此稳定),但不承诺任何落地时间。
pub fn desktop_open_live_window(
    _desktop: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let _sandbox_id = required_str(params, "sandboxId")?;
    let _container_id = required_str(params, "containerId")?;
    Err(RpcError::internal(
        "沙箱直播/接管已不由 StarHub 提供:上游 dsh 原生提供 computer-use 及其可见面(去 Tauri 化 M3 定稿)",
    ))
}

/// `ui.desktop_user_action_reply`:「请求用户人工介入」应答(已完成 / 无法完成)。
///
/// 已超时/未知请求幂等吞掉,不向前端报错(与 Tauri 版一致)。
pub async fn desktop_user_action_reply(
    desktop: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let request_id = required_str(params, "requestId")?;
    let done = params
        .get("done")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::invalid_params("缺少 done"))?;
    desktop
        .manager()
        .resolve_user_action(&request_id, done)
        .await;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetStore, MemorySecretStore};
    use crate::bindings::SessionBindings;
    use crate::db_runtime::DbRuntime;
    use starhub_domain_ssh::events::MemoryKnownHostsStore;
    use std::sync::Arc;

    struct NoopSink;

    impl starhub_domain_ssh::events::EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    /// 资产库 + 假 Go sidecar + 临时沙箱/设置文件的桌面域运行时。
    fn desktop_in_temp(label: &str) -> (Arc<DesktopRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-devices-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("assets.json"),
            serde_json::to_vec_pretty(&json!({
                "assets": [
                    { "id": "docker-1", "type": "docker", "name": "本机 Docker",
                      "config": { "dockerTransport": "socket" } },
                    { "id": "ssh-1", "type": "ssh", "name": "ssh",
                      "config": { "host": "10.0.0.7", "username": "root" } },
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let assets = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(MemorySecretStore::new()),
        ));
        let (python, args) =
            starhub_domain_db::fake_go_sidecar_command().expect("fake Go sidecar fixture present");
        let go = starhub_domain_db::GoSidecar::with_command(python, args);
        let db = Arc::new(DbRuntime::new(
            Arc::clone(&assets),
            Arc::new(go),
            Arc::new(MemoryKnownHostsStore::default()),
            Arc::new(SessionBindings::new()),
        ));
        let runtime = DesktopRuntime::with_paths(
            db,
            Arc::clone(&assets),
            crate::known_hosts_store::FileKnownHostsStore::new(dir.join("known-hosts.json")),
            Arc::new(NoopSink),
            dir.join("sandbox.json"),
            dir.join("settings.json"),
        );
        (Arc::new(runtime), dir)
    }

    /// 一条合法配方(name 与模板名一致)。
    const RECIPE: &str = "name = \"box\"\nresolution = \"1280x800\"\n";

    #[test]
    fn overview_is_empty_on_a_fresh_store() {
        let (desktop, dir) = desktop_in_temp("overview-empty");
        let overview = desktop_overview(&desktop).expect("overview");
        assert_eq!(overview["instances"], json!([]));
        assert_eq!(overview["templates"], json!([]));
        assert_eq!(overview["platformAssetId"], Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn platform_setting_validates_the_asset_type() {
        let (desktop, dir) = desktop_in_temp("platform");
        // docker 资产:接受
        desktop_set_platform(&desktop, &json!({ "assetId": "docker-1" })).expect("docker 资产");
        let overview = desktop_overview(&desktop).expect("overview");
        assert_eq!(overview["platformAssetId"], "docker-1");
        // 非 docker 资产:文案与 Tauri 版一致
        let error = desktop_set_platform(&desktop, &json!({ "assetId": "ssh-1" }))
            .expect_err("ssh 资产不能当平台");
        assert_eq!(error.message, "资产 ssh-1 不是 Docker 连接(ssh)");
        // 不存在的资产
        let error =
            desktop_set_platform(&desktop, &json!({ "assetId": "ghost" })).expect_err("资产不存在");
        assert!(error.message.contains("资产不存在"), "{}", error.message);
        // 空 = 清除,回落本机
        desktop_set_platform(&desktop, &json!({ "assetId": null })).expect("清除");
        let overview = desktop_overview(&desktop).expect("overview");
        assert_eq!(overview["platformAssetId"], Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn template_upsert_requires_the_recipe_name_to_match() {
        let (desktop, dir) = desktop_in_temp("template");
        desktop_upsert_template(&desktop, &json!({ "name": "box", "recipeToml": RECIPE }))
            .expect("upsert");
        let overview = desktop_overview(&desktop).expect("overview");
        let templates = overview["templates"].as_array().unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0]["name"], "box");
        assert_eq!(templates[0]["imageTag"], Value::Null);
        assert!(templates[0]["createdAt"].as_i64().unwrap() > 0);
        // 配方内 name 与模板名不一致:文案与 Tauri 版一致
        let error =
            desktop_upsert_template(&desktop, &json!({ "name": "other", "recipeToml": RECIPE }))
                .expect_err("name 不匹配");
        assert_eq!(error.message, "配方内 name(box)与模板名(other)不一致");
        // 同名再存:仍一条
        desktop_upsert_template(&desktop, &json!({ "name": "box", "recipeToml": RECIPE }))
            .expect("upsert again");
        assert_eq!(
            desktop_overview(&desktop).expect("overview")["templates"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // 删除
        desktop_delete_template(&desktop, &json!({ "name": "box" })).expect("delete");
        assert!(desktop_overview(&desktop).expect("overview")["templates"]
            .as_array()
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_frames_wrap_the_array_like_the_tauri_command() {
        let (desktop, dir) = desktop_in_temp("frames");
        // 直接在存储上落一帧(帧由域工具执行体写入,UI 面只读)
        desktop
            .store()
            .insert_frame_now("box-1", "click(1,2)", Some("/tmp/shot.png"))
            .expect("seed frame");
        let result = desktop_replay_frames(&desktop, &json!({ "sandboxId": "box-1" }))
            .expect("replay frames");
        let frames = result["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["action"], "click(1,2)");
        assert_eq!(frames[0]["shotPath"], "/tmp/shot.png");
        assert!(frames[0]["createdAt"].as_i64().unwrap() > 0);
        // 未知沙箱:空数组(与 Tauri 版一致)
        let result = desktop_replay_frames(&desktop, &json!({ "sandboxId": "ghost" }))
            .expect("empty frames");
        assert_eq!(result["frames"], json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn user_action_reply_is_idempotent_for_unknown_requests() {
        let (desktop, dir) = desktop_in_temp("user-action");
        desktop_user_action_reply(&desktop, &json!({ "requestId": "ghost", "done": true }))
            .await
            .expect("未知 requestId 幂等成功");
        let error = desktop_user_action_reply(&desktop, &json!({ "requestId": "ghost" }))
            .await
            .expect_err("缺 done");
        assert!(error.message.contains("缺少 done"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn window_class_actions_degrade_until_the_panel_lands() {
        let (desktop, dir) = desktop_in_temp("windows");
        let error = desktop_open_live_window(
            &desktop,
            &json!({ "sandboxId": "box-1", "containerId": "c1", "novncPort": 15900, "takeover": true }),
        )
        .expect_err("沙箱直播/接管线已去掉(M3 定稿)");
        assert!(
            error.message.contains("已不由 StarHub 提供") && error.message.contains("computer-use"),
            "{}",
            error.message
        );
        let error = desktop_open_live_window(&desktop, &json!({ "sandboxId": "box-1" }))
            .expect_err("缺 containerId");
        assert!(
            error.message.contains("缺少 containerId"),
            "{}",
            error.message
        );
        let _ = std::fs::remove_dir_all(&dir);
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
            crate::desktop_runtime::FileSettingsStore::new(dir.join("settings.json")),
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
            Arc::new(crate::desktop_runtime::FileSettingsStore::new(
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
