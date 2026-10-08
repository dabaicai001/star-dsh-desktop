//! `desktop_*` 方法面(M1 第 6 步):22 个沙箱桌面工具一对一落到 JSON-RPC 方法。
//!
//! 与 SSH/DB 域同一套约定:方法名 = 工具名;结果文本逐字保持(契约);
//! 资产/会话解析失败走 `-32602`(参数)或 `-32603`(handler 失败)。
//!
//! 会话维度的两个入口(`set_takeover` / `resolve_user_action`)在 M1 里不是
//! 工具而是**桥命令**——bridge 插件以通知形态下行,见 [`crate::methods::desktop::handle_takeover`]。

use serde_json::{json, Value};

use crate::desktop_runtime::DesktopRuntime;
use crate::jsonrpc::RpcError;

use super::ssh::{domain_error, tool_args};

/// 解析目标会话:显式 `sessionId` 优先,否则用当前唯一会话(`default`)。
///
/// 沙箱域与 ssh/db 域不同:它的授权是 **session → sandbox** 的映射,模型
/// 工具通常不带 sessionId(bridge 已按会话填充 assetId 的那套在这里不适用),
/// 因此缺省落到 `default` 会话——单会话场景(本机/dsh web)下的正确近似。
fn resolve_session(params: &Value) -> String {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string()
}

/// 22 个工具的公共入口。
async fn desktop_tool(
    runtime: &DesktopRuntime,
    name: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    let session_id = resolve_session(params);
    let args = tool_args(params);
    let text = starhub_domain_desktop::execute(&runtime.context(&session_id), name, &args)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn list_templates_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_list_templates", params).await
}

pub async fn build_template_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_build_template", params).await
}

pub async fn create_sandbox_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_create_sandbox", params).await
}

pub async fn sandbox_status_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_sandbox_status", params).await
}

pub async fn pause_sandbox_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_pause_sandbox", params).await
}

pub async fn resume_sandbox_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_resume_sandbox", params).await
}

pub async fn destroy_sandbox_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_destroy_sandbox", params).await
}

pub async fn commit_sandbox_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_commit_sandbox", params).await
}

pub async fn sandbox_replay_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_sandbox_replay", params).await
}

pub async fn screenshot_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_screenshot", params).await
}

pub async fn list_windows_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_list_windows", params).await
}

pub async fn get_foreground_window_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_get_foreground_window", params).await
}

pub async fn focus_window_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_focus_window", params).await
}

pub async fn click_method(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_click", params).await
}

pub async fn double_click_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_double_click", params).await
}

pub async fn move_mouse_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_move_mouse", params).await
}

pub async fn scroll_method(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_scroll", params).await
}

pub async fn drag_method(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_drag", params).await
}

pub async fn type_method(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_type", params).await
}

pub async fn press_key_method(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_press_key", params).await
}

pub async fn exec_method(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_exec", params).await
}

pub async fn request_user_action_method(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    desktop_tool(runtime, "desktop_request_user_action", params).await
}

/// 接管开关(桥命令,不是工具):用户在直播面板点「接管」时由 bridge 下行。
pub fn handle_takeover(runtime: &DesktopRuntime, params: &Value) -> Result<Value, RpcError> {
    let container_id = params
        .get("containerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("starhub/desktop.takeover 缺少 containerId"))?
        .to_string();
    let active = params
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let manager = runtime.manager();
    // 同步桥命令:takeover 状态是瞬时 map 操作,用 block_in_place 之外的
    // 直接锁定不可行(tokio 上下文),因此交给 block_on。
    let handle = tokio::runtime::Handle::try_current();
    match handle {
        Ok(handle) => handle.block_on(manager.set_takeover(&container_id, active)),
        Err(_) => {
            return Err(RpcError::internal(
                "takeover 需要在 tokio 运行时上下文中执行",
            ))
        }
    }
    Ok(json!({ "ok": true, "active": active }))
}

/// 「请求用户人工介入」应答(桥命令,不是工具):用户在直播 tab 点「已完成」。
pub fn handle_user_action_reply(
    runtime: &DesktopRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            RpcError::invalid_params("starhub/desktop.user-action-reply 缺少 requestId")
        })?
        .to_string();
    let done = params.get("done").and_then(Value::as_bool).unwrap_or(true);
    let manager = runtime.manager();
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| RpcError::internal("user-action-reply 需要在 tokio 运行时上下文中执行"))?;
    let known = handle.block_on(manager.resolve_user_action(&request_id, done));
    Ok(json!({ "ok": known }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_session_defaults_to_the_single_session() {
        assert_eq!(resolve_session(&json!({})), "default");
        assert_eq!(resolve_session(&json!({ "sessionId": "s1" })), "s1");
        assert_eq!(resolve_session(&json!({ "sessionId": "  " })), "default");
    }
}
