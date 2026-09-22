use serde::Serialize;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const MAX_SHELL_OUTPUT_BYTES: usize = 512 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    elapsed_ms: u128,
    truncated: bool,
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str) -> Command {
    /// CREATE_NO_WINDOW:GUI 进程 spawn 控制台子进程时不分配可见控制台窗口,
    /// 否则每次 local_shell_exec(如会话切换时分支胶囊跑 git)都会闪一个系统终端。
    /// (tokio Command 自带 creation_flags,无需 std 的 CommandExt)
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

/// 使用平台默认非交互 Shell 执行命令:Windows PowerShell,macOS/Linux /bin/sh。
/// Git 工作台(git-service)与 AI 提交信息等本机命令执行场景复用本命令;
/// 本机文件读写能力已由 DSH 主壳的 fs 工具(read/write/edit/glob/grep)提供,
/// StarHub 侧不再保留本地文件类命令(v0.121.8)。
#[tauri::command]
pub async fn local_shell_exec(
    command: String,
    working_dir: Option<String>,
    timeout_sec: Option<u64>,
) -> Result<LocalShellResult, String> {
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let timeout = timeout_sec.unwrap_or(30).clamp(1, 120);
    let mut process = shell_command(&command);
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = working_dir.filter(|value| !value.trim().is_empty()) {
        let path = std::path::PathBuf::from(directory);
        if !path.is_dir() {
            return Err(format!("working directory does not exist: {}", path.to_string_lossy()));
        }
        process.current_dir(path);
    }

    let started = Instant::now();
    let mut child = process
        .spawn()
        .map_err(|error| format!("local shell failed: {error}"))?;
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "local shell stdout pipe unavailable".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "local shell stderr pipe unavailable".to_string())?;
    let execution = async {
        let (status, stdout, stderr) = tokio::join!(
            child.wait(),
            read_limited_output(stdout_pipe),
            read_limited_output(stderr_pipe)
        );
        (status, stdout, stderr)
    };
    let (status, stdout, stderr) =
        match tokio::time::timeout(std::time::Duration::from_secs(timeout), execution).await {
            Ok(result) => result,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!("local shell timed out after {timeout}s"));
            }
        };
    let status = status.map_err(|error| format!("wait for local shell failed: {error}"))?;
    let (stdout, stdout_truncated) = stdout?;
    let (stderr, stderr_truncated) = stderr?;
    Ok(LocalShellResult {
        stdout,
        stderr,
        exit_code: status.code(),
        elapsed_ms: started.elapsed().as_millis(),
        truncated: stdout_truncated || stderr_truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn executes_non_interactive_shell() {
        // CI runner 上 PowerShell 冷启动可能超过 5 秒,放宽到 30 秒避免 flaky。
        let result = local_shell_exec("echo starhub-local-test".to_string(), None, Some(30))
            .await
            .expect("shell output");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.to_lowercase().contains("starhub-local-test"));
    }
}
