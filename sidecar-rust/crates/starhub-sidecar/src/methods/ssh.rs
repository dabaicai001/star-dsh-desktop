//! `ssh_*` / `sftp_*` 方法面(M1 第 4 步):把 8 个模型工具一对一映射到
//! JSON-RPC 方法,内部转调 [`SshRuntime`] 的域操作。
//!
//! 方法名 = 工具名(与 `BRIDGED_TOOLS` 一致),bridge 的
//! `starhub/tool.execute {sessionId,name,args}` 兼容层最终也落到这里。
//! 参数形状错误 → `-32602`;handler 失败 → `-32603`(message 透传,模型可读)。

use serde_json::{json, Value};

use crate::jsonrpc::RpcError;
use crate::runtime::{resolve_asset_id, SshRuntime};

/// 取工具参数:`args` 信封(bridge 的 `starhub/tool.execute` 形态)优先,
/// 否则参数平铺(工具直调形态)。
pub fn tool_args(params: &Value) -> Value {
    params
        .get("args")
        .cloned()
        .unwrap_or_else(|| params.clone())
}

/// 域执行的硬错误 → `-32603`(message 透传,模型可读);软错误(空命令 /
/// 长 sleep 引导等)以 `Ok` 文本返回,由模型决策下一步。
pub fn domain_error(message: String) -> RpcError {
    RpcError::internal(message)
}

/// 工具族校验:资产类型与工具不匹配 → 软错误(Ok 文本)。
///
/// 与 Tauri 版 `execute_domain_tool` 的 `check_tool_asset_type` 同语义:
/// 「@ 数据库资产却调 ssh_exec」这类误路由必须拦下并给引导,而不是让域逻辑
/// 报一句难懂的类型错误。资产不存在时返回 None(交给后续硬错误路径)。
fn check_asset_family(runtime: &SshRuntime, name: &str, asset_id: &str) -> Option<Value> {
    let record = runtime.assets().get(asset_id).ok()?;
    let kind = if record.asset_type == "db" {
        record
            .config
            .get("dbType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        record.asset_type.clone()
    };
    starhub_domain_db::check_tool_asset_type(&record.asset_type, &kind, name)
        .err()
        .map(|hint| json!({ "text": hint }))
}

/// `ssh_exec` / `ssh_exec_background` / `ssh_wait_task` 的公共入口。
async fn ssh_exec(runtime: &SshRuntime, name: &str, params: &Value) -> Result<Value, RpcError> {
    let asset_id =
        resolve_asset_id(runtime.bindings(), params).map_err(RpcError::invalid_params)?;
    if let Some(soft) = check_asset_family(runtime, name, &asset_id) {
        return Ok(soft);
    }
    let args = tool_args(params);
    let text = runtime
        .execute_ssh(name, &asset_id, &args)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn ssh_exec_method(runtime: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    ssh_exec(runtime, "ssh_exec", params).await
}

pub async fn ssh_exec_background_method(
    runtime: &SshRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    ssh_exec(runtime, "ssh_exec_background", params).await
}

pub async fn ssh_wait_task_method(runtime: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    ssh_exec(runtime, "ssh_wait_task", params).await
}

/// `ssh_session_status`:只读会话状态,不触发连接。
pub async fn ssh_session_status_method(
    runtime: &SshRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let asset_id =
        resolve_asset_id(runtime.bindings(), params).map_err(RpcError::invalid_params)?;
    if let Some(soft) = check_asset_family(runtime, "ssh_session_status", &asset_id) {
        return Ok(soft);
    }
    let text = runtime
        .execute_ssh_status(&asset_id)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

/// `sftp_list` / `sftp_stat` / `sftp_upload` / `sftp_download` 的公共入口。
async fn sftp(runtime: &SshRuntime, name: &str, params: &Value) -> Result<Value, RpcError> {
    let asset_id =
        resolve_asset_id(runtime.bindings(), params).map_err(RpcError::invalid_params)?;
    if let Some(soft) = check_asset_family(runtime, name, &asset_id) {
        return Ok(soft);
    }
    let args = tool_args(params);
    let text = runtime
        .execute_sftp(name, &asset_id, &args)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn sftp_list_method(runtime: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    sftp(runtime, "sftp_list", params).await
}

pub async fn sftp_stat_method(runtime: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    sftp(runtime, "sftp_stat", params).await
}

pub async fn sftp_upload_method(runtime: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    sftp(runtime, "sftp_upload", params).await
}

pub async fn sftp_download_method(runtime: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    sftp(runtime, "sftp_download", params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetStore, MemorySecretStore};
    use crate::runtime::SshRuntime;
    use starhub_domain_ssh::events::{EventSink, MemoryKnownHostsStore};
    use std::sync::Arc;

    struct NoopSink;

    impl EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    /// 空资产库 + 内存密钥的运行时(不触网)。
    fn runtime_in_temp(label: &str) -> (Arc<SshRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-methods-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(MemorySecretStore::new()),
        ));
        let runtime = Arc::new(SshRuntime::new(
            Arc::clone(&assets),
            Arc::new(NoopSink),
            Arc::new(MemoryKnownHostsStore::default()),
            Arc::new(crate::bindings::SessionBindings::new()),
        ));
        (runtime, dir)
    }

    #[tokio::test]
    async fn ssh_methods_report_missing_asset_as_invalid_params() {
        let (runtime, dir) = runtime_in_temp("missing");
        let error = ssh_exec_method(&runtime, &json!({ "command": "ls" }))
            .await
            .expect_err("无 assetId 也无会话绑定");
        assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
        assert!(
            error.message.contains("bind_asset_context"),
            "{}",
            error.message
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ssh_methods_report_unknown_asset_verbatim() {
        let (runtime, dir) = runtime_in_temp("unknown");
        let error = ssh_exec_method(&runtime, &json!({ "assetId": "ghost", "command": "ls" }))
            .await
            .expect_err("资产不存在是硬错误");
        assert_eq!(error.code, crate::jsonrpc::error_codes::INTERNAL_ERROR);
        assert_eq!(error.message, "资产不存在: ghost");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn session_status_answers_without_connecting() {
        let (runtime, dir) = runtime_in_temp("status");
        let result = ssh_session_status_method(&runtime, &json!({ "assetId": "ghost" }))
            .await
            .expect("状态查询不解析资产存在性");
        assert!(
            result["text"]
                .as_str()
                .unwrap()
                .contains("SSH 会话未建立(资产 ghost)"),
            "{result}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sftp_methods_share_the_same_asset_resolution() {
        let (runtime, dir) = runtime_in_temp("sftp");
        for name in ["sftp_list", "sftp_stat", "sftp_upload", "sftp_download"] {
            let error = runtime
                .execute_sftp(name, "ghost", &json!({ "path": "/tmp" }))
                .await
                .expect_err("资产不存在");
            assert_eq!(error, "资产不存在: ghost", "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn args_envelope_is_optional() {
        // bridge 的 starhub/tool.execute 形态 {sessionId,name,args} 与工具直调
        // 形态(参数平铺)都能解析:assetId 平铺时也应命中。
        let (runtime, dir) = runtime_in_temp("flat");
        let error = ssh_wait_task_method(
            &runtime,
            &json!({ "assetId": "ghost", "task_id": "task-x" }),
        )
        .await
        .expect_err("资产不存在");
        assert_eq!(error.message, "资产不存在: ghost");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
