//! 沙箱桌面的 UI Tauri Command(前端沙箱 tab / 设置页 / 模板管理用)。
//!
//! 与 AI 工具路径(desktop/mod.rs,经 dsh 桥)分离:这些是主窗口 UI 的状态读写,
//! 不做任何容器写操作(容器生命周期只由 AI 工具路径驱动,审批语义不被 UI 绕过)。

use crate::desktop::{recipe, DesktopManager};
use sqlx::Row;
use tauri::{AppHandle, State};

/// 沙箱 tab 的停止(pause)/恢复(resume)/销毁(destroy)按钮。
#[tauri::command]
pub async fn desktop_ui_lifecycle(
    app: AppHandle,
    sandbox_id: String,
    action: String,
) -> Result<String, String> {
    crate::desktop::ui_lifecycle(&app, &sandbox_id, &action).await
}

/// 围观/接管开关:active=true 期间 AI 写操作一律拒绝(授权不撤销)。
#[tauri::command]
pub async fn desktop_set_takeover(
    manager: State<'_, DesktopManager>,
    container_id: String,
    active: bool,
) -> Result<(), String> {
    manager.set_takeover(&container_id, active).await;
    Ok(())
}

/// 沙箱 tab 总览:实例列表 + 模板列表 + 当前平台选择。
#[tauri::command]
pub async fn desktop_ui_overview() -> Result<serde_json::Value, String> {
    let pool = crate::db::get_pool()?;

    let instances = sqlx::query(
        "SELECT id, container_id, platform, novnc_port, status, task, created_at FROM sandbox_instances ORDER BY created_at DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取沙箱实例失败: {e}"))?
    .into_iter()
    .map(|row| {
        serde_json::json!({
            "id": row.try_get::<String, _>("id").unwrap_or_default(),
            "containerId": row.try_get::<String, _>("container_id").unwrap_or_default(),
            "platform": row.try_get::<String, _>("platform").unwrap_or_default(),
            "novncPort": row.try_get::<i64, _>("novnc_port").unwrap_or(0),
            "status": row.try_get::<String, _>("status").unwrap_or_default(),
            "task": row.try_get::<String, _>("task").unwrap_or_default(),
            "createdAt": row.try_get::<i64, _>("created_at").unwrap_or(0),
        })
    })
    .collect::<Vec<_>>();

    let templates = sqlx::query(
        "SELECT id, name, recipe, image_tag, created_at FROM sandbox_templates ORDER BY created_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取模板失败: {e}"))?
    .into_iter()
    .map(|row| {
        serde_json::json!({
            "id": row.try_get::<String, _>("id").unwrap_or_default(),
            "name": row.try_get::<String, _>("name").unwrap_or_default(),
            "recipe": row.try_get::<String, _>("recipe").unwrap_or_default(),
            "imageTag": row.try_get::<Option<String>, _>("image_tag").unwrap_or(None),
            "createdAt": row.try_get::<i64, _>("created_at").unwrap_or(0),
        })
    })
    .collect::<Vec<_>>();

    let platform: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'desktop.platform_asset_id'")
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读取沙箱平台设置失败: {e}"))?
            .filter(|v: &String| !v.trim().is_empty());

    Ok(serde_json::json!({
        "instances": instances,
        "templates": templates,
        "platformAssetId": platform,
    }))
}

/// 设置页「沙箱平台」选择器:asset_id 为空 = 默认本机 Docker。
#[tauri::command]
pub async fn desktop_ui_set_platform(asset_id: Option<String>) -> Result<(), String> {
    let pool = crate::db::get_pool()?;
    match asset_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            // 只允许指向 docker 类型资产(平台选择是安全决策,写前校验)
            let asset_type: Option<String> =
                sqlx::query_scalar("SELECT type FROM assets WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("校验平台资产失败: {e}"))?;
            match asset_type.as_deref() {
                Some("docker") => {}
                Some(other) => return Err(format!("资产 {id} 不是 Docker 连接({other})")),
                None => return Err(format!("资产不存在: {id}")),
            }
            sqlx::query(
                "INSERT INTO settings (key, value, updated_at) VALUES ('desktop.platform_asset_id', ?, strftime('%s','now')) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            )
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| format!("保存沙箱平台设置失败: {e}"))?;
        }
        None => {
            sqlx::query("DELETE FROM settings WHERE key = 'desktop.platform_asset_id'")
                .execute(pool)
                .await
                .map_err(|e| format!("清除沙箱平台设置失败: {e}"))?;
        }
    }
    Ok(())
}

/// 模板新增/更新(按 name 唯一);配方先经 recipe 校验才落库。
#[tauri::command]
pub async fn desktop_ui_upsert_template(name: String, recipe_toml: String) -> Result<(), String> {
    let parsed = recipe::parse_recipe(&recipe_toml)?;
    if parsed.name != name {
        return Err(format!(
            "配方内 name({})与模板名({name})不一致",
            parsed.name
        ));
    }
    let pool = crate::db::get_pool()?;
    sqlx::query(
        "INSERT INTO sandbox_templates (id, name, recipe) VALUES (?, ?, ?) \
         ON CONFLICT(name) DO UPDATE SET recipe = excluded.recipe",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&name)
    .bind(&recipe_toml)
    .execute(pool)
    .await
    .map_err(|e| format!("保存模板失败: {e}"))?;
    Ok(())
}

/// 模板删除(不影响已从它创建的实例)。
#[tauri::command]
pub async fn desktop_ui_delete_template(name: String) -> Result<(), String> {
    let pool = crate::db::get_pool()?;
    sqlx::query("DELETE FROM sandbox_templates WHERE name = ?")
        .bind(&name)
        .execute(pool)
        .await
        .map_err(|e| format!("删除模板失败: {e}"))?;
    Ok(())
}

/// 「请求用户人工介入」应答:前端横幅的「已完成」(done=true)/「无法完成」(false)。
#[tauri::command]
pub async fn desktop_user_action_reply(
    manager: State<'_, DesktopManager>,
    request_id: String,
    done: bool,
) -> Result<(), String> {
    if !manager.resolve_user_action(&request_id, done).await {
        // 已超时/未知请求:幂等吞掉,不向前端报错
        tracing::debug!("desktop_user_action_reply: 未知或已过期的 requestId {request_id}");
    }
    Ok(())
}

/// 回放查看器数据:某沙箱的全部回放帧。
#[tauri::command]
pub async fn desktop_ui_replay_frames(sandbox_id: String) -> Result<serde_json::Value, String> {
    let pool = crate::db::get_pool()?;
    let frames = sqlx::query(
        "SELECT action, shot_path, created_at FROM sandbox_replay_frames WHERE sandbox_id = ? ORDER BY id",
    )
    .bind(&sandbox_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取回放帧失败: {e}"))?
    .into_iter()
    .map(|row| {
        serde_json::json!({
            "action": row.try_get::<String, _>("action").unwrap_or_default(),
            "shotPath": row.try_get::<Option<String>, _>("shot_path").unwrap_or(None),
            "createdAt": row.try_get::<i64, _>("created_at").unwrap_or(0),
        })
    })
    .collect::<Vec<_>>();
    Ok(serde_json::json!({ "frames": frames }))
}
