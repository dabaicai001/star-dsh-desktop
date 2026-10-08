//! Built-in methods plus the domain method surface.
//!
//! `ping` is the liveness probe the bridge uses after spawn; the capability
//! report is the seed of the model-facing `starhub_list_capabilities` tool —
//! it reads the live registry so the inventory can never drift from the
//! registered method surface.
//!
//! Domain modules (ssh/sftp, then db/redis/es/docker; browser/android/desktop
//! next) register through the runtime shim: their handlers are async, the
//! registry surface stays synchronous, so [`registry_with_domains`] wraps each
//! handler in `Runtime::block_on`. The stdio loop processes one request at a
//! time, so blocking the loop thread for the duration of a domain call
//! preserves request/response ordering without any extra synchronization.

use std::sync::{Arc, Weak};

use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::android_runtime::AndroidRuntime;
use crate::db_runtime::DbRuntime;
use crate::desktop_runtime::DesktopRuntime;
use crate::jsonrpc::RpcError;
use crate::registry::{MethodRegistry, SIDECAR_PROTOCOL_VERSION};
use crate::runtime::SshRuntime;

pub mod android;
pub mod db;
pub mod desktop;
pub mod ssh;

/// Liveness probe.
pub fn ping(_params: &Value) -> Result<Value, RpcError> {
    Ok(json!({ "pong": true, "protocol": SIDECAR_PROTOCOL_VERSION }))
}

/// Registry inventory report.
pub fn capabilities(registry: &MethodRegistry) -> Result<Value, RpcError> {
    Ok(json!({
        "protocol": SIDECAR_PROTOCOL_VERSION,
        "methods": registry.method_names(),
    }))
}

/// Build the registry with the built-in methods.
///
/// The capability report reads the live registry through a weak self
/// reference; dispatch only runs while the caller holds the strong `Arc`,
/// so the upgrade cannot fail in practice.
pub fn registry_with_builtins() -> Arc<MethodRegistry> {
    Arc::new_cyclic(|weak| {
        let mut registry = MethodRegistry::new();
        registry.register("ping", ping);
        let handle: Weak<MethodRegistry> = weak.clone();
        registry.register("starhub_list_capabilities", move |_params| {
            let registry = handle.upgrade().expect("registry alive during dispatch");
            capabilities(&registry)
        });
        registry
    })
}

/// 注册一个异步域方法:闭包在 stdio 线程上 `block_on` 到完成。
///
/// 域 handler 形如 `async fn(&Runtime, &Value) -> Result<Value, RpcError>`;
/// future 在闭包体内创建并当场消费,借用不越过调用,因此 registry 的同步
/// handler 面(`Fn(&Value) -> Result<Value, RpcError>`)无需任何特判。
macro_rules! register_async {
    ($registry:expr, $runtime:expr, $state:expr, $name:literal, $handler:path) => {
        $registry.register($name, {
            let runtime = Arc::clone(&$runtime);
            let state = Arc::clone(&$state);
            move |params: &Value| runtime.block_on($handler(&state, params))
        });
    };
}

/// Build the registry with the built-ins plus every registered domain method.
///
/// `runtime` drives the async domain handlers; `ssh` owns the SSH/SFTP session
/// state, `db` the Go sidecar client, `desktop` the sandbox-desktop state and
/// `android` the device state. Keeping them behind `Arc` lets the registered
/// closures stay `'static + Send + Sync`.
pub fn registry_with_domains(
    runtime: Arc<Runtime>,
    ssh: Arc<SshRuntime>,
    db: Arc<DbRuntime>,
    desktop: Arc<DesktopRuntime>,
    android: Arc<AndroidRuntime>,
) -> Arc<MethodRegistry> {
    Arc::new_cyclic(|weak| {
        let mut registry = MethodRegistry::new();
        registry.register("ping", ping);
        let handle: Weak<MethodRegistry> = weak.clone();
        registry.register("starhub_list_capabilities", move |_params| {
            let registry = handle.upgrade().expect("registry alive during dispatch");
            capabilities(&registry)
        });

        // 全局:资产清单(依赖资产存储;模型发现资产 id 的入口)
        {
            let ssh = Arc::clone(&ssh);
            registry.register("starhub_list_assets", move |params| {
                let type_filter = params
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let text = ssh
                    .assets()
                    .list_assets_text(type_filter.as_deref())
                    .map_err(RpcError::internal)?;
                Ok(json!({ "text": text }))
            });
        }

        // 全局:会话 → 资产绑定(bind_asset_context)。open_connection /
        // focus_terminal 的窗口动作在新架构里是 bridge 插件事件,不占方法面。
        {
            let ssh = Arc::clone(&ssh);
            registry.register("bind_asset_context", move |params| {
                let asset_id = params
                    .get("assetId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| RpcError::invalid_params("bind_asset_context 缺少 assetId"))?
                    .to_string();
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| RpcError::invalid_params("bind_asset_context 缺少 sessionId"))?
                    .to_string();
                let asset_type = ssh
                    .assets()
                    .get(&asset_id)
                    .map_err(RpcError::internal)?
                    .asset_type;
                ssh.bind_session(&session_id, &asset_type, &asset_id);
                Ok(json!({ "ok": true, "action": "bound" }))
            });
        }

        // SSH / SFTP 域:8 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_exec",
            crate::methods::ssh::ssh_exec_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_exec_background",
            crate::methods::ssh::ssh_exec_background_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_wait_task",
            crate::methods::ssh::ssh_wait_task_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_session_status",
            crate::methods::ssh::ssh_session_status_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_list",
            crate::methods::ssh::sftp_list_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_stat",
            crate::methods::ssh::sftp_stat_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_upload",
            crate::methods::ssh::sftp_upload_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_download",
            crate::methods::ssh::sftp_download_method
        );

        // DB / Redis / ES / Docker 域:15 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            db,
            "db_query",
            crate::methods::db::db_query_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "redis_exec",
            crate::methods::db::redis_exec_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_list_indices",
            crate::methods::db::es_list_indices_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_cluster_health",
            crate::methods::db::es_cluster_health_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_get_mapping",
            crate::methods::db::es_get_mapping_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_search",
            crate::methods::db::es_search_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_get_document",
            crate::methods::db::es_get_document_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_count",
            crate::methods::db::es_count_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_index_document",
            crate::methods::db::es_index_document_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_delete_document",
            crate::methods::db::es_delete_document_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_delete_index",
            crate::methods::db::es_delete_index_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_list_containers",
            crate::methods::db::docker_list_containers_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_logs",
            crate::methods::db::docker_logs_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_inspect",
            crate::methods::db::docker_inspect_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_exec",
            crate::methods::db::docker_exec_method
        );

        // Desktop 域:22 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_list_templates",
            crate::methods::desktop::list_templates_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_build_template",
            crate::methods::desktop::build_template_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_create_sandbox",
            crate::methods::desktop::create_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_sandbox_status",
            crate::methods::desktop::sandbox_status_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_pause_sandbox",
            crate::methods::desktop::pause_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_resume_sandbox",
            crate::methods::desktop::resume_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_destroy_sandbox",
            crate::methods::desktop::destroy_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_commit_sandbox",
            crate::methods::desktop::commit_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_sandbox_replay",
            crate::methods::desktop::sandbox_replay_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_screenshot",
            crate::methods::desktop::screenshot_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_list_windows",
            crate::methods::desktop::list_windows_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_get_foreground_window",
            crate::methods::desktop::get_foreground_window_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_focus_window",
            crate::methods::desktop::focus_window_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_click",
            crate::methods::desktop::click_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_double_click",
            crate::methods::desktop::double_click_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_move_mouse",
            crate::methods::desktop::move_mouse_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_scroll",
            crate::methods::desktop::scroll_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_drag",
            crate::methods::desktop::drag_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_type",
            crate::methods::desktop::type_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_press_key",
            crate::methods::desktop::press_key_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_exec",
            crate::methods::desktop::exec_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_request_user_action",
            crate::methods::desktop::request_user_action_method
        );

        // Android 域:20 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_list_devices",
            crate::methods::android::list_devices_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_connect",
            crate::methods::android::connect_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_disconnect",
            crate::methods::android::disconnect_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_device_status",
            crate::methods::android::device_status_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_replay",
            crate::methods::android::replay_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_wireless",
            crate::methods::android::wireless_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_screenshot",
            crate::methods::android::screenshot_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_current_app",
            crate::methods::android::current_app_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_ui_tree",
            crate::methods::android::ui_tree_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_tap",
            crate::methods::android::tap_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_double_tap",
            crate::methods::android::double_tap_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_swipe",
            crate::methods::android::swipe_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_scroll",
            crate::methods::android::scroll_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_type",
            crate::methods::android::type_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_press_key",
            crate::methods::android::press_key_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_launch_app",
            crate::methods::android::launch_app_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_open_live",
            crate::methods::android::open_live_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_pull",
            crate::methods::android::pull_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_push",
            crate::methods::android::push_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_exec",
            crate::methods::android::exec_method
        );

        registry
    })
}

/// Convenience: build a multi-thread tokio runtime for the stdio loop.
pub fn build_runtime() -> Result<Runtime, String> {
    Runtime::new().map_err(|error| format!("tokio runtime 创建失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::InboundFrame;

    #[test]
    fn ping_reports_protocol() {
        let registry = registry_with_builtins();
        let frame =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        assert_eq!(result["pong"], true);
        assert_eq!(result["protocol"], SIDECAR_PROTOCOL_VERSION);
    }

    #[test]
    fn capabilities_reports_the_live_method_table() {
        let registry = registry_with_builtins();
        let frame =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","id":2,"method":"starhub_list_capabilities"}"#)
                .expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        assert_eq!(
            result["methods"],
            serde_json::json!(["ping", "starhub_list_capabilities"])
        );
    }
}
