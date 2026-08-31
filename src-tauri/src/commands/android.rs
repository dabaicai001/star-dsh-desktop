//! Android 实体机的 UI Tauri Command(设置页「Android 设备」tab)。
//!
//! 与 AI 工具路径(android/mod.rs,经 dsh 桥)分离:只读写 adb 二进制配置,
//! 不做任何设备操作(设备写操作只由 AI 工具路径驱动,审批语义不被 UI 绕过)。

use tauri::{AppHandle, Manager};

/// 读取配置:显式设置的 adb 路径(可为空 = 自动探测)+ 当前实际解析到的路径。
#[tauri::command]
pub async fn android_ui_get_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let pool = crate::db::get_pool()?;
    let configured: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(crate::android::ADB_PATH_SETTING_KEY)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读取 adb 路径设置失败: {e}"))?
            .filter(|v: &String| !v.trim().is_empty());
    let manager = app.state::<crate::android::AndroidManager>();
    let resolved = manager.cached_adb_path().await;
    Ok(serde_json::json!({
        "adbPath": configured,
        "resolvedAdb": resolved,
    }))
}

/// 保存 adb 显式路径(空 = 清除,回落自动探测)。写前校验文件存在;
/// 保存后清解析缓存,下一次 adb 调用按新值生效。
#[tauri::command]
pub async fn android_ui_set_adb_path(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let pool = crate::db::get_pool()?;
    match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let trimmed = p.trim().to_string();
            if !std::path::Path::new(&trimmed).is_file() {
                return Err(format!("adb 路径不存在或不是文件: {trimmed}"));
            }
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES (?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(crate::android::ADB_PATH_SETTING_KEY)
            .bind(&trimmed)
            .execute(pool)
            .await
            .map_err(|e| format!("保存 adb 路径失败: {e}"))?;
        }
        None => {
            sqlx::query("DELETE FROM settings WHERE key = ?")
                .bind(crate::android::ADB_PATH_SETTING_KEY)
                .execute(pool)
                .await
                .map_err(|e| format!("清除 adb 路径失败: {e}"))?;
        }
    }
    app.state::<crate::android::AndroidManager>()
        .invalidate_adb_cache()
        .await;
    Ok(())
}
