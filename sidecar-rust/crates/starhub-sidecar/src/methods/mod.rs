//! Built-in methods available before any domain module is extracted.
//!
//! `ping` is the liveness probe the bridge uses after spawn; the capability
//! report is the seed of the model-facing `starhub_list_capabilities` tool —
//! it reads the live registry so the inventory can never drift from the
//! registered method surface.
//!
//! Domain modules (ssh/sftp today, db/browser/android/desktop next) register
//! through the runtime shim: their handlers are async, the registry surface
//! stays synchronous, so [`registry_with_domains`] wraps each handler in
//! `Runtime::block_on`. The stdio loop processes one request at a time, so
//! blocking the loop thread for the duration of a domain call preserves
//! request/response ordering without any extra synchronization.

use std::sync::{Arc, Weak};

use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::jsonrpc::RpcError;
use crate::registry::{MethodRegistry, SIDECAR_PROTOCOL_VERSION};
use crate::runtime::SshRuntime;

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
/// 域 handler 形如 `async fn(&SshRuntime, &Value) -> Result<Value, RpcError>`;
/// future 在闭包体内创建并当场消费,借用不越过调用,因此 registry 的同步
/// handler 面(`Fn(&Value) -> Result<Value, RpcError>`)无需任何特判。
macro_rules! register_async {
    ($registry:expr, $runtime:expr, $ssh:expr, $name:literal, $handler:path) => {
        $registry.register($name, {
            let runtime = Arc::clone(&$runtime);
            let ssh = Arc::clone(&$ssh);
            move |params: &Value| runtime.block_on($handler(&ssh, params))
        });
    };
}

/// Build the registry with the built-ins plus every registered domain method.
///
/// `runtime` drives the async domain handlers; `ssh` owns the SSH/SFTP session
/// state. Keeping both behind `Arc` lets the registered closures stay
/// `'static + Send + Sync`.
pub fn registry_with_domains(runtime: Arc<Runtime>, ssh: Arc<SshRuntime>) -> Arc<MethodRegistry> {
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
