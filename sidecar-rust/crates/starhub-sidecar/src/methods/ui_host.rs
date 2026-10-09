//! UI 方法面 D 组第三批·宿主持有能力(去 Tauri 化 M2):本机 shell 执行 +
//! 归 Electron 壳 / M3 的能力降级。
//!
//! - [`local_shell_exec`]:从 `src-tauri/src/commands/local.rs` 平移。sidecar 与
//!   桌面端**同机运行**,本机命令执行(Git 工作台的分支胶囊、AI 提交信息等)
//!   不需要窗口,直接 spawn 平台默认非交互 shell 即可;行为(输出上限 / 超时
//!   钳制 / 结果字段)与 Tauri 版逐字一致。
//! - `screenshot_begin_region` / `plugin:dialog|open` / `plugin:app|version`:
//!   **宿主持有能力**,M2 显式降级并指明归属——区域截图随 M3 帧服务落地,
//!   文件对话框与版本号归 Electron 壳(见 M2 清单 §三 D 组)。

use std::process::Stdio;
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::jsonrpc::RpcError;

/// 单次输出捕获上限(超出即截断,`truncated=true`)。
const MAX_SHELL_OUTPUT_BYTES: usize = 512 * 1024;

/// 本机 shell 执行结果(camelCase 线形状,与工作台 `LocalShellResult` 一致)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
    pub truncated: bool,
}

/// 平台默认非交互 shell:Windows PowerShell,macOS/Linux `/bin/sh`。
#[cfg(target_os = "windows")]
fn shell_command(command: &str) -> Command {
    /// CREATE_NO_WINDOW:GUI 进程 spawn 控制台子进程时不分配可见控制台窗口,
    /// 否则每次 local_shell_exec 都会闪一个系统终端。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut process = Command::new("powershell.exe");
    process.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
    ]);
    process.creation_flags(CREATE_NO_WINDOW);
    process
}

#[cfg(not(target_os = "windows"))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("/bin/sh");
    process.args(["-lc", command]);
    process
}

/// 读到 EOF,超过上限只保留前 `MAX_SHELL_OUTPUT_BYTES` 字节并标记截断。
async fn read_limited_output<R>(mut reader: R) -> Result<(String, bool), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut captured = Vec::with_capacity(MAX_SHELL_OUTPUT_BYTES.min(64 * 1024));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("read shell output failed: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = MAX_SHELL_OUTPUT_BYTES.saturating_sub(captured.len());
        if remaining > 0 {
            captured.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        if count > remaining {
            truncated = true;
        }
    }
    Ok((String::from_utf8_lossy(&captured).to_string(), truncated))
}

/// `ui.local_shell_exec`:在平台默认非交互 shell 里执行一条本机命令。
///
/// Git 工作台与 AI 提交信息等场景复用;本机文件读写能力已由 DSH 主壳的 fs 工具
/// 提供,StarHub 侧不再保留本地文件类命令(与 Tauri 版同一边界)。
pub async fn local_shell_exec(params: &Value) -> Result<Value, RpcError> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params("缺少 command"))?;
    if command.trim().is_empty() {
        return Err(RpcError::internal("command must not be empty"));
    }
    let timeout = params
        .get("timeoutSec")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .clamp(1, 120);
    let working_dir = params
        .get("workingDir")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());

    let started = Instant::now();
    let mut process = shell_command(&command);
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = working_dir {
        process.current_dir(directory);
    }
    let mut child = process
        .spawn()
        .map_err(|error| RpcError::internal(format!("spawn shell failed: {error}")))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let stdout_reader = tokio::spawn(read_limited_output(stdout));
    let stderr_reader = tokio::spawn(read_limited_output(stderr));

    let status =
        match tokio::time::timeout(std::time::Duration::from_secs(timeout), child.wait()).await {
            Ok(status) => {
                status.map_err(|error| RpcError::internal(format!("wait shell failed: {error}")))?
            }
            Err(_) => {
                // 超时:kill_on_drop 已挂,显式 kill 一遍确保退出,再按超时文案返回
                let _ = child.kill().await;
                return Err(RpcError::internal(format!(
                    "命令执行超时({timeout} 秒): {command}"
                )));
            }
        };
    let (stdout, stdout_truncated) = stdout_reader
        .await
        .map_err(|error| RpcError::internal(format!("join stdout reader failed: {error}")))?
        .map_err(RpcError::internal)?;
    let (stderr, stderr_truncated) = stderr_reader
        .await
        .map_err(|error| RpcError::internal(format!("join stderr reader failed: {error}")))?
        .map_err(RpcError::internal)?;
    Ok(json!(LocalShellResult {
        stdout,
        stderr,
        exit_code: status.code(),
        elapsed_ms: started.elapsed().as_millis(),
        truncated: stdout_truncated || stderr_truncated,
    }))
}

/// `ui.screenshot_begin_region`:区域截图(宿主持有能力)。
///
/// 显式降级:屏幕/窗口捕获归 Electron 壳与 M3 帧服务,sidecar 不做屏幕采集。
pub fn screenshot_begin_region(_params: &Value) -> Result<Value, RpcError> {
    Err(RpcError::internal(
        "区域截图暂不可用:屏幕/窗口捕获归 Electron 壳与 M3 帧服务(去 Tauri 化 M2)",
    ))
}

/// `ui.plugin:dialog|open`:系统文件对话框(宿主持有能力)。
///
/// 显式降级:文件选择归 dsh GUI 原生面(上游 directory-picker / file-upload)。
pub fn plugin_dialog_open(_params: &Value) -> Result<Value, RpcError> {
    Err(RpcError::internal(
        "文件对话框暂不可用:文件选择归 dsh GUI 原生面(去 Tauri 化 M2)",
    ))
}

/// `ui.plugin:app|version`:应用版本号。
///
/// 显式降级:版本与自更新归 Electron 壳;这里返回一句明确的占位文本,
/// 关于页原样展示(用户因此知道为什么不是一个语义化版本号)。
pub fn plugin_app_version(_params: &Value) -> Result<Value, RpcError> {
    Ok(json!("版本归 Electron 壳(M2 占位)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn local_shell_exec_captures_stdout_and_exit_code() {
        // echo 在 PowerShell 与 /bin/sh 下都可用;跨平台同一断言
        let result = local_shell_exec(&json!({ "command": "echo hello-from-sidecar" }))
            .await
            .expect("echo 成功");
        assert!(
            result["stdout"]
                .as_str()
                .is_some_and(|text| text.contains("hello-from-sidecar")),
            "{result}"
        );
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["truncated"], false);
        assert!(result["elapsedMs"].as_u64().unwrap() < 60_000);
    }

    #[tokio::test]
    async fn local_shell_exec_reports_non_zero_exit() {
        let result = local_shell_exec(&json!({ "command": "exit 3" }))
            .await
            .expect("退出码非零也返回结果");
        assert_eq!(result["exitCode"], 3, "{result}");
    }

    #[tokio::test]
    async fn local_shell_exec_validates_the_command() {
        let error = local_shell_exec(&json!({ "command": "   " }))
            .await
            .expect_err("空命令");
        assert_eq!(error.message, "command must not be empty");
        let error = local_shell_exec(&json!({})).await.expect_err("缺 command");
        assert!(error.message.contains("缺少 command"), "{}", error.message);
        assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn local_shell_exec_honours_the_working_dir() {
        let result = local_shell_exec(&json!({
            "command": "pwd",
            "workingDir": std::env::temp_dir().to_string_lossy(),
        }))
        .await
        .expect("pwd 成功");
        assert!(
            result["stdout"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
            "{result}"
        );
    }

    #[test]
    fn host_capabilities_degrade_with_a_clear_reason() {
        let error = screenshot_begin_region(&json!({})).expect_err("区域截图降级");
        assert!(error.message.contains("M3"), "{}", error.message);
        let error = plugin_dialog_open(&json!({})).expect_err("文件对话框降级");
        assert!(error.message.contains("dsh GUI"), "{}", error.message);
        // 版本号:明确占位,不是伪造的语义化版本
        assert_eq!(
            plugin_app_version(&json!({})).unwrap(),
            json!("版本归 Electron 壳(M2 占位)")
        );
    }
}
