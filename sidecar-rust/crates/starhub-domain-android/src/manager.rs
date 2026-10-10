//! Android 管理器:任务级授权 + adb 路径缓存(从 `src-tauri/src/android/mod.rs`
//! 平移,零改动;直播注册表留在宿主——那是窗口面)。
//!
//! 授权语义:任务级——`android_connect` 建立 session → serial 授权(60 分钟),
//! 执行点强制存在性 / 过期 / serial 匹配。

use std::collections::HashMap;

/// 设置表 key:adb 二进制显式路径(设置页「Android 设备」可写)。
pub const ADB_PATH_SETTING_KEY: &str = "android.adb_path";
/// 环境变量:adb 二进制路径(设置项的兜底)。
pub const ADB_PATH_ENV_KEY: &str = "STARHUB_ADB_PATH";
/// 任务授权时长(秒)。
pub const AUTHZ_TTL_SECS: i64 = 60 * 60;

/// 授权条目:android_connect 建立,到期/断开即失效。
#[derive(Debug, Clone)]
pub struct Authz {
    pub serial: String,
    /// connect 时探测的物理分辨率(w,h),scroll 默认中心点用。
    pub resolution: (i64, i64),
    pub expires_at: i64,
}

#[derive(Default)]
struct AndroidState {
    /// session_id → 任务级授权。
    authz: HashMap<String, Authz>,
    /// adb 二进制路径解析缓存(NotFound 时清除重解析)。
    adb_path: Option<String>,
}

/// Android 管理器(两个宿主各持一份)。
pub struct AndroidManager {
    state: tokio::sync::Mutex<AndroidState>,
}

impl Default for AndroidManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AndroidManager {
    pub fn new() -> Self {
        Self {
            state: tokio::sync::Mutex::new(AndroidState::default()),
        }
    }

    pub async fn grant(&self, session_id: &str, serial: &str, resolution: (i64, i64)) {
        let expires_at = chrono::Utc::now().timestamp() + AUTHZ_TTL_SECS;
        self.state.lock().await.authz.insert(
            session_id.to_string(),
            Authz {
                serial: serial.to_string(),
                resolution,
                expires_at,
            },
        );
    }

    pub async fn revoke(&self, session_id: &str) {
        self.state.lock().await.authz.remove(session_id);
    }

    /// adb 路径设置被设置页修改后清缓存,下次调用重新解析。
    pub async fn invalidate_adb_cache(&self) {
        self.state.lock().await.adb_path = None;
    }

    /// 当前解析到的 adb 路径(设置页展示用;None = 尚未解析过)。
    pub async fn cached_adb_path(&self) -> Option<String> {
        self.state.lock().await.adb_path.clone()
    }

    /// 校验会话对目标设备的写授权;返回授权条目(serial + 分辨率)。
    pub async fn require_authz(
        &self,
        session_id: &str,
        serial_arg: Option<&str>,
    ) -> Result<Authz, String> {
        let state = self.state.lock().await;
        let authz = state.authz.get(session_id).ok_or_else(|| {
            "当前会话没有设备授权:请先调用 android_connect 连接设备(会请求用户确认)".to_string()
        })?;
        if authz.expires_at < chrono::Utc::now().timestamp() {
            return Err("设备授权已过期(60 分钟),请重新 android_connect".to_string());
        }
        if let Some(want) = serial_arg {
            if !want.is_empty() && want != authz.serial {
                return Err(format!("授权仅覆盖设备 {},不能操作 {want}", authz.serial));
            }
        }
        Ok(authz.clone())
    }

    /// 缓存解析到的 adb 路径。
    pub(crate) async fn set_adb_path(&self, path: &str) {
        self.state.lock().await.adb_path = Some(path.to_string());
    }

    /// 取缓存的 adb 路径。
    pub(crate) async fn adb_path_cache(&self) -> Option<String> {
        self.state.lock().await.adb_path.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn authz_grants_expires_and_scopes_to_one_serial() {
        let manager = AndroidManager::new();
        let err = manager.require_authz("s1", None).await.unwrap_err();
        assert!(err.contains("没有设备授权"), "{err}");

        manager.grant("s1", "serial-a", (1080, 2400)).await;
        let authz = manager.require_authz("s1", None).await.unwrap();
        assert_eq!(authz.serial, "serial-a");
        assert_eq!(authz.resolution, (1080, 2400));
        assert_eq!(
            manager
                .require_authz("s1", Some("serial-a"))
                .await
                .unwrap()
                .serial,
            "serial-a"
        );
        let err = manager
            .require_authz("s1", Some("serial-b"))
            .await
            .unwrap_err();
        assert!(err.contains("授权仅覆盖设备"), "{err}");

        manager.revoke("s1").await;
        assert!(manager.require_authz("s1", None).await.is_err());
    }

    #[tokio::test]
    async fn adb_path_cache_roundtrips_and_invalidates() {
        let manager = AndroidManager::new();
        assert_eq!(manager.cached_adb_path().await, None);
        manager.set_adb_path("/usr/bin/adb").await;
        assert_eq!(
            manager.cached_adb_path().await.as_deref(),
            Some("/usr/bin/adb")
        );
        manager.invalidate_adb_cache().await;
        assert_eq!(manager.cached_adb_path().await, None);
    }
}
