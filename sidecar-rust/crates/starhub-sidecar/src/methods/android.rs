//! `android_*` 方法面(M1 第 6 步):20 个 Android 工具一对一落到 JSON-RPC 方法。
//!
//! 与其它域同一套约定:方法名 = 工具名;结果文本逐字保持(契约)。
//! 直播(scrcpy 帧 / 接管输入)是窗口面,M3 面板化;这里只经
//! [`LiveLauncher`] seam 表达「打开直播」意图,接管状态由桥命令下发。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use starhub_domain_android::store::{FrameStore, ReplayFrame};
use starhub_domain_android::{BoxFuture, CacheDir, LiveLauncher, TakeoverState};

use crate::android_runtime::AndroidRuntime;
use crate::desktop_runtime::FileSettingsStore;
use crate::jsonrpc::RpcError;

use super::ssh::{domain_error, tool_args};

/// 文件设置存储(与 desktop 域共用 `starhub-settings.json`)。
pub type AndroidSettingsStore = FileSettingsStore;

impl starhub_domain_android::SettingsStore for FileSettingsStore {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        let outcome = (|| {
            let stored = self.read_all()?;
            Ok(stored
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string))
        })();
        Box::pin(async move { outcome })
    }
}

/// 缓存目录:`STARHUB_CACHE_DIR`(与 desktop 域同根)。
pub struct EnvCacheDir;

impl CacheDir for EnvCacheDir {
    fn dir(&self, sub: &str) -> Result<PathBuf, String> {
        let root = std::env::var("STARHUB_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-cache"));
        Ok(root.join(sub))
    }
}

/// 直播启动:注册一次会话并通知 bridge(M3 的面板消费该通知)。
pub struct NotifyLiveLauncher {
    sink: Arc<dyn starhub_domain_ssh::events::EventSink>,
}

impl NotifyLiveLauncher {
    pub fn new(sink: Arc<dyn starhub_domain_ssh::events::EventSink>) -> Self {
        Self { sink }
    }
}

impl LiveLauncher for NotifyLiveLauncher {
    fn open<'a>(
        &'a self,
        serial: &'a str,
        resolution: (i64, i64),
    ) -> BoxFuture<'a, Result<(), String>> {
        self.sink.emit(
            "starhub://android-live",
            json!({ "serial": serial, "width": resolution.0, "height": resolution.1 }),
        );
        Box::pin(async move { Ok(()) })
    }
}

/// 接管状态:由桥命令 `starhub/android.takeover` 维护(内存集合)。
#[derive(Default)]
pub struct MemoryTakeover {
    active: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl MemoryTakeover {
    pub fn set(&self, serial: &str, active: bool) {
        let mut set = self.active.lock().unwrap();
        if active {
            set.insert(serial.to_string());
        } else {
            set.remove(serial);
        }
    }
}

impl TakeoverState for MemoryTakeover {
    fn is_takeover(&self, serial: &str) -> bool {
        self.active.lock().unwrap().contains(serial)
    }
}

/// JSON 文件版回放帧存储(与沙箱/资产同一套路:写穿透)。
pub struct FileFrameStore {
    path: PathBuf,
}

impl FileFrameStore {
    /// 按环境变量解析:`STARHUB_ANDROID_FRAMES_FILE`,缺省 `<cwd>/starhub-android-frames.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_ANDROID_FRAMES_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-android-frames.json"));
        Self { path }
    }

    fn read_all(&self) -> Result<Vec<serde_json::Value>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<Vec<serde_json::Value>>(&bytes)
                .map_err(|e| format!("回放帧文件解析失败: {e}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!("回放帧文件读取失败: {error}")),
        }
    }

    fn write_all(&self, frames: &[serde_json::Value]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("回放帧目录创建失败: {e}"))?;
            }
        }
        let text =
            serde_json::to_string_pretty(frames).map_err(|e| format!("回放帧序列化失败: {e}"))?;
        std::fs::write(&self.path, text).map_err(|e| format!("回放帧文件写入失败: {e}"))
    }
}

impl FrameStore for FileFrameStore {
    fn insert_frame<'a>(
        &'a self,
        serial: &'a str,
        session_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        let outcome = (|| {
            let mut frames = self.read_all()?;
            frames.push(json!({
                "serial": serial,
                "sessionId": session_id,
                "action": action,
                "shotPath": shot_path,
                "createdAt": chrono::Utc::now().timestamp(),
            }));
            self.write_all(&frames)
        })();
        Box::pin(async move { outcome })
    }

    fn list_frames<'a>(
        &'a self,
        serial: &'a str,
        limit: i64,
    ) -> BoxFuture<'a, Result<Vec<ReplayFrame>, String>> {
        let outcome = self.read_all().map(|frames| {
            frames
                .into_iter()
                .filter(|f| f.get("serial").and_then(Value::as_str) == Some(serial))
                .take(limit.max(0) as usize)
                .map(|f| ReplayFrame {
                    action: f
                        .get("action")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    shot_path: f
                        .get("shotPath")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    created_at: f.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
                })
                .collect()
        });
        Box::pin(async move { outcome })
    }
}

/// 解析目标会话(与 desktop 同规则:缺省 `default`)。
fn resolve_session(params: &Value) -> String {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string()
}

/// 20 个工具的公共入口。
async fn android_tool(
    runtime: &AndroidRuntime,
    name: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    let session_id = resolve_session(params);
    let args = tool_args(params);
    let text = starhub_domain_android::execute(&runtime.context(&session_id), name, &args)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn list_devices_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_list_devices", params).await
}

pub async fn connect_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_connect", params).await
}

pub async fn disconnect_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_disconnect", params).await
}

pub async fn device_status_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_device_status", params).await
}

pub async fn replay_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_replay", params).await
}

pub async fn wireless_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_wireless", params).await
}

pub async fn screenshot_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_screenshot", params).await
}

pub async fn current_app_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_current_app", params).await
}

pub async fn ui_tree_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_ui_tree", params).await
}

pub async fn tap_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_tap", params).await
}

pub async fn double_tap_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_double_tap", params).await
}

pub async fn swipe_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_swipe", params).await
}

pub async fn scroll_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_scroll", params).await
}

pub async fn type_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_type", params).await
}

pub async fn press_key_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_press_key", params).await
}

pub async fn launch_app_method(
    runtime: &AndroidRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    android_tool(runtime, "android_launch_app", params).await
}

pub async fn open_live_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_open_live", params).await
}

pub async fn pull_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_pull", params).await
}

pub async fn push_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_push", params).await
}

pub async fn exec_method(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    android_tool(runtime, "android_exec", params).await
}

/// 接管开关(桥命令,不是工具):用户在直播面板点「接管」时由 bridge 下行。
pub fn handle_takeover(runtime: &AndroidRuntime, params: &Value) -> Result<Value, RpcError> {
    let serial = params
        .get("serial")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("starhub/android.takeover 缺少 serial"))?
        .to_string();
    let active = params
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    runtime.set_takeover(&serial, active);
    Ok(json!({ "ok": true, "active": active }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_session_defaults_to_the_single_session() {
        assert_eq!(resolve_session(&json!({})), "default");
        assert_eq!(resolve_session(&json!({ "sessionId": "s1" })), "s1");
    }

    #[test]
    fn takeover_memory_toggles() {
        let takeover = MemoryTakeover::default();
        assert!(!takeover.is_takeover("serial-1"));
        takeover.set("serial-1", true);
        assert!(takeover.is_takeover("serial-1"));
        assert!(!takeover.is_takeover("serial-2"));
        takeover.set("serial-1", false);
        assert!(!takeover.is_takeover("serial-1"));
    }
}
