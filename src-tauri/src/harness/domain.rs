//! 进程内域工具执行器(方案1:域工具直接在 Rust 主进程执行,不再依赖前端面板)。
//!
//! 背景:旧实现(方案0)把域工具(ssh_exec / sftp_* / db_query / redis_exec /
//! es_* / docker_*)经 `dsh://tool-exec` 事件转发给拥有该会话的【前端 webview
//! 面板】执行,再等 `dsh_tool_exec_reply` 应答。两个致命问题:
//! 1. 前端面板窗口关闭 / 审批卡住 → 应答永远不来 → 180s 后报
//!    「前端执行超时或窗口已关闭」(BUG.md #1);
//! 2. 停止生成只杀 dsh 进程,前端面板里正在执行的命令不会被中断。
//!
//! 本模块把全部可进程内执行的域工具改为在 Rust 主进程直接执行:
//! - SSH / SFTP:复用 [`SshManager`](crate::commands::ssh::SshManager) 的既有
//!   会话(connId `dsh:{asset_id}:ssh`,与前端 AI 执行器同 key,可复用已建会话),
//!   经 [`ssh_exec_core`] / session 的 exec / SFTP 通道执行;exec 带 exec_id
//!   注册到桥的 [`InflightAbort`],停止生成时由 `bridge.drain()` 真正中断。
//! - DB / Redis / ES / Docker:直接经 [`SidecarManager`] 的 stdio JSON-RPC
//!   (connect → 执行 → format → disconnect),资产连接参数从 assets 表 + Keyring
//!   合并(与 [`asset_ssh_config`] 同源,绝不含明文密钥泄漏)。
//! - Excel / MCP / skill_save 保持前端桥接:工作簿状态 / MCP server 配置 /
//!   Skill 落库都在前端侧,无法脱离 webview。
//!
//! 结果文本格式与前端 `src/services/dshToolExecutor.ts` 对齐(模型可读文本),
//! 行为语义照搬前端实现,便于模型无感迁移。

use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

use crate::commands::ssh::SshManager;
use crate::sftp::transfer::TransferManager;
use crate::sidecar::SidecarManager;

use super::{HostBridgeState, InflightAbort};

/// connId 前缀:与前端 dshToolExecutor 的 `dsh:{assetId}:ssh` 保持一致,
/// 可复用前端已建立的 AI exec 会话(避免重复连接)。
fn ai_ssh_conn_id(asset_id: &str) -> String {
    format!("dsh:{asset_id}:ssh")
}

/// 把资产 id 解析为完整连接配置(含 Keyring 合并的敏感字段)。
/// 返回 (asset_type, config);资产不存在时报错。
async fn load_asset_config(asset_id: &str) -> Result<(String, Value), String> {
    let pool = crate::db::get_pool()?;
    let row = sqlx::query("SELECT type, config_json, key_id FROM assets WHERE id = ?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取资产失败: {e}"))?
        .ok_or_else(|| format!("资产不存在: {asset_id}"))?;
    use sqlx::Row;
    let asset_type: String = row.try_get("type").map_err(|e| e.to_string())?;
    let config_json: String = row.try_get("config_json").map_err(|e| e.to_string())?;
    let key_id: Option<String> = row.try_get("key_id").map_err(|e| e.to_string())?;
    let mut config: Value = serde_json::from_str(&config_json)
        .unwrap_or_else(|_| Value::Object(Default::default()));
    if let Some(key_id) = key_id {
        let secrets = crate::keyring::load(key_id).await?;
        config = crate::keyring::merge_config(config, secrets);
    }
    Ok((asset_type, config))
}

fn as_str(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

fn as_u16(value: &Value, default: u16) -> u16 {
    value.as_u64().map(|v| v as u16).unwrap_or(default)
}

fn as_bool(value: &Value, default: bool) -> bool {
    value.as_bool().unwrap_or(default)
}

fn as_number(value: &Value, default: u64) -> u64 {
    value.as_u64().unwrap_or(default)
}

/// 格式化查询结果(与前端 formatQueryResult 对齐)。
fn format_query_result(value: &Value) -> String {
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return format!("[Error] {error}");
    }
    let columns: Vec<String> = value
        .get("columns")
        .and_then(Value::as_array)
        .map(|cols| {
            cols.iter()
                .map(|col| as_str(col.get("name").unwrap_or(&Value::Null)))
                .collect()
        })
        .unwrap_or_default();
    let rows = value.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let rows_affected = as_number(value.get("rowsAffected").unwrap_or(&Value::Null), 0);
    if rows.is_empty() {
        return if rows_affected > 0 {
            format!("(0 行, {rows_affected} 行受影响)")
        } else {
            "(0 行)".to_string()
        };
    }
    let lines: Vec<String> = rows.iter().take(20).map(|row| {
        let cells: Vec<String> = match row {
            Value::Array(items) => items.iter().enumerate().map(|(index, cell)| {
                let fallback = index.to_string();
                let name = columns.get(index).map(|s| s.as_str()).unwrap_or(&fallback);
                format!("{name}={}", format_value(cell))
            }).collect(),
            other => vec![format_value(other)],
        };
        cells.join(" | ")
    }).collect();
    let mut text = format!("列: {}\n{}", columns.join(", "), lines.join("\n"));
    if rows.len() > 20 {
        text.push_str(&format!("\n… (共 {} 行)", rows.len()));
    }
    text
}

fn format_value(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        // 与前端 formatValue(String(value)) 对齐:字符串原样输出,不加 JSON 引号
        Value::String(text) => truncate_text(text),
        Value::Object(_) | Value::Array(_) => value.to_string(),
        other => truncate_text(&other.to_string()),
    }
}

/// 与前端 formatValue 截断语义一致:超过 120 字符截断并追加省略号。
/// 按字符截断(非字节),避免切在 UTF-8 多字节边界上 panic。
fn truncate_text(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn format_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

// ============================================================
// SSH 域
// ============================================================

/// 确保 AI exec SSH 会话存在(connId 与前端一致,复用已建会话)。
/// 返回 connId。
async fn ensure_ssh_session(
    bridge: &HostBridgeState,
    asset_id: &str,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法建立 SSH 会话".to_string())?;
    let conn_id = ai_ssh_conn_id(asset_id);
    {
        let manager = app.state::<SshManager>();
        let sessions = manager.sessions.lock().await;
        if sessions.contains_key(&conn_id) {
            return Ok(conn_id);
        }
    }
    // 无会话:按资产配置建立(密码/密钥从 Keyring 合并)
    let (_name, config) = crate::commands::ssh::asset_ssh_config(asset_id).await?;
    let manager = app.state::<SshManager>();
    let transfer_manager = app.state::<TransferManager>();
    crate::commands::ssh::connect_session(
        &manager,
        &transfer_manager,
        conn_id.clone(),
        config,
        app.clone(),
        false,
    )
    .await?;
    Ok(conn_id)
}

/// 执行 ssh_exec:带 exec_id 的进程内执行,注册取消句柄。
async fn exec_ssh_command(
    bridge: &HostBridgeState,
    conn_id: &str,
    command: &str,
    timeout_sec: u64,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 SSH 命令".to_string())?;
    let manager = app.state::<SshManager>();
    let exec_id = format!("dsh-exec-{}", uuid::Uuid::new_v4());
    // 注册在途取消句柄:停止生成(cancel → drain)时 abort 这条 exec
    bridge.inflight_tools.lock().unwrap().insert(
        exec_id.clone(),
        InflightAbort::SshExec {
            conn_id: conn_id.to_string(),
            exec_id: exec_id.clone(),
        },
    );
    let result = crate::commands::ssh::ssh_exec_core(
        &manager,
        &app,
        conn_id,
        command,
        Some(timeout_sec),
        Some(&exec_id),
        true,
    )
    .await;
    bridge.inflight_tools.lock().unwrap().remove(&exec_id);
    result
}

/// 端口 sshBackgroundTask.ts 的后台任务纯函数。
const AI_BG_TASK_ROOT: &str = "/tmp/starhub-ai-bg";
const AI_BG_MAX_WAIT_S: u64 = 55;
const AI_BG_LOG_TAIL_BYTES: u64 = 4000;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// UTF-8 安全 base64(与前端 TextEncoder+btoa 等价;自实现避免新增依赖)。
fn to_base64(text: &str) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn new_background_task_id() -> String {
    format!("task-{}", uuid::Uuid::new_v4().simple())
}

fn is_valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 64
        && task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn clamp_task_wait_seconds(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(30).clamp(1, AI_BG_MAX_WAIT_S)
}

fn build_background_start_command(command: &str, task_id: &str) -> String {
    let dir = format!("{AI_BG_TASK_ROOT}/{task_id}");
    let b64 = to_base64(command);
    [
        format!("d={}", shell_quote(&dir)),
        "mkdir -p \"$d\"".to_string(),
        format!("printf '%s' {} | base64 -d > \"$d/run.sh\"", shell_quote(&b64)),
        "chmod +x \"$d/run.sh\"".to_string(),
        "{ nohup bash -c 'bash \"$1\" > \"$2\" 2>&1; echo $? > \"$3\"' _ \"$d/run.sh\" \"$d/out.log\" \"$d/exit\" >/dev/null 2>&1 & echo $! > \"$d/pid\"; }".to_string(),
        format!("echo \"[TASK] {task_id} STARTED PID=$(cat \"$d/pid\")\""),
    ]
    .join(" && ")
}

fn build_task_poll_command(task_id: &str, wait_seconds: u64) -> String {
    let dir = format!("{AI_BG_TASK_ROOT}/{task_id}");
    let w = wait_seconds.clamp(1, AI_BG_MAX_WAIT_S);
    format!(
        "d={dir}; if [ ! -d \"$d\" ]; then echo \"[STATUS] NOT_FOUND\"; exit 1; fi; i=0; while [ \"$i\" -lt {w} ] && [ ! -f \"$d/exit\" ]; do sleep 1; i=$((i+1)); done; if [ -f \"$d/exit\" ]; then echo \"[STATUS] FINISHED EXIT=$(cat \"$d/exit\" 2>/dev/null)\"; else echo \"[STATUS] RUNNING PID=$(cat \"$d/pid\" 2>/dev/null)\"; fi; echo \"[LOG TAIL]\"; tail -c {AI_BG_LOG_TAIL_BYTES} \"$d/out.log\" 2>/dev/null"
    )
}

/// 检测命令里的长 sleep(阈值 15s,支持 s/m/h 后缀),返回等待秒数。
/// 自实现轻量扫描(与前端 findLongSleepSeconds 语义一致),避免 regex 依赖。
fn find_long_sleep_seconds(command: &str, threshold_sec: f64) -> Option<f64> {
    let lower = command.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"sleep") {
            let after = &bytes[index + 5..];
            let trimmed = after.iter().take_while(|b| b.is_ascii_whitespace()).count();
            let num_start = index + 5 + trimmed;
            let mut num_end = num_start;
            while num_end < bytes.len()
                && (bytes[num_end].is_ascii_digit() || bytes[num_end] == b'.')
            {
                num_end += 1;
            }
            if num_end > num_start {
                if let Ok(value) = lower[num_start..num_end].parse::<f64>() {
                    let unit = lower[num_end..].chars().next().unwrap_or(' ');
                    let seconds = match unit {
                        'm' => value * 60.0,
                        'h' => value * 3600.0,
                        _ => value,
                    };
                    if seconds >= threshold_sec {
                        return Some(seconds);
                    }
                }
            }
            index = num_end.max(index + 5);
        } else {
            index += 1;
        }
    }
    None
}

/// 执行 ssh_exec / ssh_exec_background / ssh_wait_task。
async fn execute_ssh(
    bridge: &HostBridgeState,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let asset_id = args.get("assetId").and_then(Value::as_str).unwrap_or("");
    if asset_id.is_empty() {
        return Err("缺少 assetId,无法执行 SSH 工具".to_string());
    }
    let conn_id = ensure_ssh_session(bridge, asset_id).await?;

    if name == "ssh_wait_task" {
        let task_id = as_str(args.get("task_id").unwrap_or(&Value::Null)).trim().to_string();
        if !is_valid_task_id(&task_id) {
            return Ok("[Error] 无效的 task_id".to_string());
        }
        let wait_sec = clamp_task_wait_seconds(args.get("wait_seconds"));
        let output = exec_ssh_command(bridge, &conn_id, &build_task_poll_command(&task_id, wait_sec), wait_sec + 15).await?;
        return Ok(if output.is_empty() { "(无输出)".to_string() } else { output });
    }

    let command = as_str(args.get("command").unwrap_or(&Value::Null)).trim().to_string();
    if command.is_empty() {
        return Ok("[Error] Empty command".to_string());
    }
    let is_background = name == "ssh_exec_background";
    if !is_background {
        if let Some(sleep_sec) = find_long_sleep_seconds(&command, 15.0) {
            return Ok(format!(
                "命令包含 sleep 约 {:.0} 秒的长时间等待;请改用 ssh_exec_background 后台执行,再用 ssh_wait_task 轮询结果",
                sleep_sec
            ));
        }
    }

    let task_id = if is_background { new_background_task_id() } else { String::new() };
    let final_command = if is_background {
        build_background_start_command(&command, &task_id)
    } else {
        command.clone()
    };
    let output = exec_ssh_command(bridge, &conn_id, &final_command, 30).await?;
    if is_background {
        Ok(format!(
            "{output}\n后台任务已启动,task_id: {task_id};请调用 ssh_wait_task(task_id=\"{task_id}\") 查询进度与结果。"
        ))
    } else {
        Ok(if output.is_empty() { "(无输出)".to_string() } else { output })
    }
}

// ============================================================
// SFTP 域(复用 SSH 会话)
// ============================================================

async fn execute_sftp(
    bridge: &HostBridgeState,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let asset_id = args.get("assetId").and_then(Value::as_str).unwrap_or("");
    if asset_id.is_empty() {
        return Err("缺少 assetId,无法执行 SFTP 工具".to_string());
    }
    let conn_id = ensure_ssh_session(bridge, asset_id).await?;
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 SFTP 工具".to_string())?;
    let manager = app.state::<SshManager>();
    let transfer_manager = app.state::<TransferManager>();

    // 确保 SFTP 通道已注册(惰性建立)
    if !transfer_manager.has_session(&conn_id).await {
        let session_arc = {
            let sessions = manager.sessions.lock().await;
            sessions
                .get(&conn_id)
                .cloned()
                .ok_or_else(|| format!("SSH session {conn_id} not found"))?
        };
        let mut session = session_arc.lock().await;
        let (sftp, _launch_info) = session.open_sftp_with_info().await?;
        transfer_manager
            .register_sftp(conn_id.clone(), Arc::new(tokio::sync::Mutex::new(sftp)))
            .await;
    }

    match name {
        "sftp_list" => {
            let path = required_remote_path(args.get("path"))?;
            let session_arc = {
                let sessions = manager.sessions.lock().await;
                sessions.get(&conn_id).cloned().ok_or_else(|| "session not found".to_string())?
            };
            let mut session = session_arc.lock().await;
            let entries = session
                .with_browse_sftp(|sftp| {
                    Box::pin(async move { sftp.read_dir(&path).await.map_err(|e| e.to_string()) })
                })
                .await?;
            let mut lines: Vec<String> = Vec::new();
            for entry in entries {
                let is_dir = entry.metadata().is_dir();
                let size = if is_dir { 0 } else { entry.metadata().size.unwrap_or(0) };
                let path = entry.path();
                lines.push(format!(
                    "{} | {} | {} | {:o}",
                    if is_dir { "DIR " } else { "FILE" },
                    path,
                    if is_dir { "-".to_string() } else { size.to_string() },
                    entry.metadata().permissions.unwrap_or(0)
                ));
            }
            if lines.len() > 200 {
                let shown = lines.len();
                lines.truncate(200);
                lines.push(format!("… (共 {shown} 项,仅显示前 200 项)"));
            }
            Ok(if lines.is_empty() { "(空目录)".to_string() } else { lines.join("\n") })
        }
        "sftp_stat" => {
            let path = required_remote_path(args.get("path"))?;
            let session_arc = {
                let sessions = manager.sessions.lock().await;
                sessions.get(&conn_id).cloned().ok_or_else(|| "session not found".to_string())?
            };
            let mut session = session_arc.lock().await;
            let meta_path = path.clone();
            let metadata = session
                .with_browse_sftp(|sftp| {
                    Box::pin(async move { sftp.metadata(&meta_path).await.map_err(|e| e.to_string()) })
                })
                .await?;
            Ok(format_json(&serde_json::json!({
                "path": path,
                "is_dir": metadata.is_dir(),
                "size": metadata.size.unwrap_or(0),
                "permissions": metadata.permissions.unwrap_or(0),
            })))
        }
        "sftp_upload" | "sftp_download" => {
            let speed_limit = as_number(args.get("speedLimit").unwrap_or(&Value::Null), 0);
            if name == "sftp_upload" {
                let local_paths: Vec<String> = args
                    .get("localPaths")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().map(|v| as_str(v)).collect())
                    .unwrap_or_default();
                if local_paths.is_empty() {
                    return Err("localPaths 不能为空".to_string());
                }
                let remote_dir = required_remote_path(args.get("remoteDir"))?;
                let transfer_id = transfer_manager
                    .upload(&conn_id, local_paths, remote_dir, speed_limit)
                    .await
                    .map_err(|e| e.to_string())?;
                let summary = wait_for_transfer(&transfer_manager, &conn_id, &transfer_id).await?;
                Ok(summary)
            } else {
                let remote_paths: Vec<String> = args
                    .get("remotePaths")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().map(|v| as_str(v)).collect())
                    .unwrap_or_default();
                if remote_paths.is_empty() {
                    return Err("remotePaths 不能为空".to_string());
                }
                let local_dir = required_path(args.get("localDir"))?;
                let transfer_id = transfer_manager
                    .download(&conn_id, remote_paths, local_dir, speed_limit)
                    .await
                    .map_err(|e| e.to_string())?;
                let summary = wait_for_transfer(&transfer_manager, &conn_id, &transfer_id).await?;
                Ok(summary)
            }
        }
        other => Err(format!("Unknown SFTP tool: {other}")),
    }
}

fn required_path(value: Option<&Value>) -> Result<String, String> {
    let text = as_str(value.unwrap_or(&Value::Null)).trim().to_string();
    if text.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if text.len() > 4096 {
        return Err("路径过长".to_string());
    }
    Ok(text)
}

fn required_remote_path(value: Option<&Value>) -> Result<String, String> {
    let text = required_path(value)?;
    if !text.starts_with('/') && !text.starts_with('~') {
        return Err(format!("必须是远端绝对路径(以 / 或 ~ 开头),收到: {text}"));
    }
    Ok(text)
}

const TRANSFER_POLL_MS: u64 = 400;
const TRANSFER_TIMEOUT_MS: u64 = 30 * 60 * 1000;

async fn wait_for_transfer(
    transfer_manager: &TransferManager,
    conn_id: &str,
    transfer_id: &str,
) -> Result<String, String> {
    use crate::sftp::{TransferDirection, TransferStatus};
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(TRANSFER_TIMEOUT_MS);
    loop {
        let task = transfer_manager
            .list_tasks(conn_id)
            .await
            .into_iter()
            .find(|t| t.id == transfer_id);
        if let Some(task) = task {
            match task.status {
                TransferStatus::Done => {
                    let direction = match task.direction {
                        TransferDirection::Upload => "上传",
                        TransferDirection::Download => "下载",
                    };
                    return Ok(format!(
                        "传输已完成 ({direction}):\n任务: {}\n文件: {}\n大小: {}",
                        task.id,
                        task.files.len(),
                        task.total_bytes
                    ));
                }
                TransferStatus::Failed => {
                    return Err(format!(
                        "SFTP 传输失败: {}{}",
                        transfer_id,
                        task.error
                            .as_deref()
                            .map(|e| format!(" ({e})"))
                            .unwrap_or_default()
                    ));
                }
                TransferStatus::Cancelled => {
                    return Err(format!("SFTP 传输已取消: {transfer_id}"));
                }
                TransferStatus::Paused => {
                    return Err(format!(
                        "SFTP 传输已被用户暂停: {transfer_id}。如需继续,请在传输队列中恢复后重试。"
                    ));
                }
                TransferStatus::Queued | TransferStatus::Running => {}
            }
        }
        if std::time::Instant::now() > deadline {
            return Err(format!("SFTP 传输等待超过 30 分钟: {transfer_id}"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(TRANSFER_POLL_MS)).await;
    }
}

// ============================================================
// DB / Redis / ES / Docker 域(经 Sidecar)
// ============================================================

async fn sidecar_call(bridge: &HostBridgeState, method: &str, params: Value) -> Result<Value, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法调用 sidecar".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    sidecar.call(method, params).await
}

/// 按资产配置建立连接,返回 connId。
async fn connect_sidecar(
    bridge: &HostBridgeState,
    asset_type: &str,
    config: &Value,
) -> Result<String, String> {
    let (method, params) = match asset_type {
        "mysql" | "db" => {
            let db_type = as_str(config.get("dbType").unwrap_or(&Value::Null));
            if db_type == "redis" {
                ("db.redis.connect", serde_json::json!({
                    "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                    "port": as_u16(config.get("port").unwrap_or(&Value::Null), 6379),
                    "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                    "db": as_number(config.get("redisDb").unwrap_or(&Value::Null), 0),
                    "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                }))
            } else if db_type == "clickhouse" {
                ("db.clickhouse.connect", serde_json::json!({
                    "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                    "port": as_u16(config.get("port").unwrap_or(&Value::Null), 9000),
                    "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                    "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                    "database": as_str(config.get("database").unwrap_or(&Value::Null)),
                    "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                }))
            } else if db_type == "postgresql" {
                ("db.postgres.connect", serde_json::json!({
                    "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                    "port": as_u16(config.get("port").unwrap_or(&Value::Null), 5432),
                    "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                    "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                    "database": as_str(config.get("database").unwrap_or(&Value::Null)),
                    "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                }))
            } else {
                ("db.mysql.connect", serde_json::json!({
                    "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                    "port": as_u16(config.get("port").unwrap_or(&Value::Null), 3306),
                    "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                    "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                    "database": as_str(config.get("database").unwrap_or(&Value::Null)),
                    "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                }))
            }
        }
        "redis" => ("db.redis.connect", serde_json::json!({
            "host": as_str(config.get("host").unwrap_or(&Value::Null)),
            "port": as_u16(config.get("port").unwrap_or(&Value::Null), 6379),
            "password": as_str(config.get("password").unwrap_or(&Value::Null)),
            "db": as_number(config.get("redisDb").unwrap_or(&Value::Null), 0),
            "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
        })),
        "elasticsearch" => ("db.es.connect", serde_json::json!({
            "addresses": config.get("addresses").cloned().unwrap_or(Value::Null),
            "address": as_str(config.get("address").unwrap_or(&Value::Null)),
            "host": as_str(config.get("host").unwrap_or(&Value::Null)),
            "port": as_u16(config.get("port").unwrap_or(&Value::Null), 9200),
            "username": as_str(config.get("username").unwrap_or(&Value::Null)),
            "password": as_str(config.get("password").unwrap_or(&Value::Null)),
            "useSSL": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
        })),
        "docker" => ("docker.connect", docker_params(config).await?),
        other => return Err(format!("不支持直接连接的资产类型: {other}")),
    };
    let result = sidecar_call(bridge, method, params).await?;
    result
        .get("connId")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{method} 未返回 connId: {result}"))
}

/// 构建 Docker 连接参数(与前端 dshToolExecutor.dockerParams 语义对齐)。
/// SSH 传输:解析 dockerSshAssetId 指向的 SSH 资产(含 Keyring 密钥 + 已知主机密钥),
/// 输出与 sidecar DockerSSHConfig 契约一致的 ssh 子对象。
async fn docker_params(config: &Value) -> Result<Value, String> {
    let transport = as_str(config.get("dockerTransport").unwrap_or(&Value::Null));
    let transport = if transport.is_empty() {
        if as_str(config.get("remoteHost").unwrap_or(&Value::Null)).is_empty() {
            "socket".to_string()
        } else {
            "tcp".to_string()
        }
    } else {
        transport
    };
    match transport.as_str() {
        "tcp" => Ok(serde_json::json!({
            "transport": "tcp",
            "host": as_str(config.get("remoteHost").unwrap_or(&Value::Null)),
        })),
        "socket" => {
            let socket_path = as_str(config.get("socketPath").unwrap_or(&Value::Null));
            let socket_path = if socket_path.is_empty() { "/var/run/docker.sock".to_string() } else { socket_path };
            Ok(serde_json::json!({
                "transport": "socket",
                "host": if socket_path.contains("://") { socket_path } else { format!("unix://{socket_path}") },
            }))
        }
        "ssh" => {
            let ssh_asset_id = as_str(config.get("dockerSshAssetId").unwrap_or(&Value::Null));
            if ssh_asset_id.is_empty() {
                return Err("Docker SSH 传输需要配置 SSH 资产(dockerSshAssetId)".to_string());
            }
            let (_asset_type, ssh_config) = load_asset_config(&ssh_asset_id).await?;
            let host = as_str(ssh_config.get("host").unwrap_or(&Value::Null));
            let username = as_str(ssh_config.get("username").unwrap_or(&Value::Null));
            if host.is_empty() || username.is_empty() {
                return Err(format!("Docker SSH 资产「{ssh_asset_id}」配置不完整(缺 host 或 username)"));
            }
            let use_password = as_bool(ssh_config.get("usePasswordAuth").unwrap_or(&Value::Null), true);
            let use_key = as_bool(ssh_config.get("useKeyAuth").unwrap_or(&Value::Null), false);
            let password = as_str(ssh_config.get("password").unwrap_or(&Value::Null));
            let private_key = as_str(ssh_config.get("privateKey").unwrap_or(&Value::Null));
            let passphrase = {
                let value = as_str(ssh_config.get("passphrase").unwrap_or(&Value::Null));
                (!value.is_empty()).then(|| value)
            };
            let known_host_key = crate::commands::ssh::ssh_get_trusted_host_key(
                host.clone(),
                as_u16(ssh_config.get("port").unwrap_or(&Value::Null), 22),
            )
            .await?;
            if known_host_key.is_none() {
                return Err(format!(
                    "Docker SSH 主机 {host} 尚未确认主机密钥,请先在 SSH 终端连接一次"
                ));
            }
            let auth = if use_password && use_key && !password.is_empty() && !private_key.is_empty() {
                serde_json::json!({ "PasswordAndKey": { "password": password, "key": private_key, "passphrase": passphrase } })
            } else if use_password && !password.is_empty() {
                serde_json::json!({ "Password": password })
            } else if use_key && !private_key.is_empty() {
                serde_json::json!({ "PrivateKey": { "key": private_key, "passphrase": passphrase } })
            } else {
                serde_json::json!({ "Password": "" })
            };
            let _ = auth; // 认证字段随 ssh 子对象传递(与前端一致)
            let jump_host = as_str(ssh_config.get("jumpHost").unwrap_or(&Value::Null));
            let mut ssh = serde_json::json!({
                "host": host,
                "port": as_u16(ssh_config.get("port").unwrap_or(&Value::Null), 22),
                "username": username,
                "password": password,
                "privateKey": private_key,
                "passphrase": passphrase,
                "knownHostKey": known_host_key,
            });
            if !jump_host.is_empty() {
                ssh["jumpHost"] = Value::String(jump_host.clone());
                ssh["jumpPort"] = serde_json::json!(as_u16(ssh_config.get("jumpPort").unwrap_or(&Value::Null), 22));
                ssh["jumpUsername"] = Value::String(as_str(ssh_config.get("jumpUsername").unwrap_or(&Value::Null)));
                ssh["jumpPassword"] = Value::String(as_str(ssh_config.get("jumpPassword").unwrap_or(&Value::Null)));
                ssh["jumpPrivateKey"] = Value::String(as_str(ssh_config.get("jumpPrivateKey").unwrap_or(&Value::Null)));
                ssh["jumpPassphrase"] = Value::String(as_str(ssh_config.get("jumpPassphrase").unwrap_or(&Value::Null)));
                if let Ok(jump_key) = crate::commands::ssh::ssh_get_trusted_host_key(
                    jump_host.clone(),
                    as_u16(ssh_config.get("jumpPort").unwrap_or(&Value::Null), 22),
                )
                .await
                {
                    if let Some(jump_key) = jump_key {
                        ssh["jumpKnownHostKey"] = Value::String(jump_key);
                    }
                }
            }
            Ok(serde_json::json!({
                "transport": "ssh",
                "host": as_str(config.get("remoteHost").unwrap_or(&Value::Null)),
                "socketPath": as_str(config.get("socketPath").unwrap_or(&Value::Null)),
                "ssh": ssh,
            }))
        }
        other => Err(format!("不支持的 dockerTransport: {other}")),
    }
}

async fn execute_relational_db(
    bridge: &HostBridgeState,
    asset_type: &str,
    config: &Value,
    args: &Value,
) -> Result<String, String> {
    let sql = as_str(args.get("sql").unwrap_or(&Value::Null)).trim().to_string();
    if sql.is_empty() {
        return Ok("[Error] Empty SQL".to_string());
    }
    let database = as_str(config.get("database").unwrap_or(&Value::Null));
    let conn_id = connect_sidecar(bridge, asset_type, config).await?;
    let method = if asset_type == "clickhouse" { "db.clickhouse.execute" } else { "db.mysql.execute" };
    let result = sidecar_call(bridge, method, serde_json::json!({
        "connId": conn_id,
        "sql": sql,
        "database": database,
    }))
    .await?;
    let _ = sidecar_call(bridge, &format!("{}.disconnect", method.rsplit_once('.').map(|(p, _)| p).unwrap_or("db.mysql")), serde_json::json!({ "connId": conn_id })).await;
    Ok(format_query_result(&result))
}

async fn execute_redis(
    bridge: &HostBridgeState,
    config: &Value,
    args: &Value,
) -> Result<String, String> {
    let command = as_str(args.get("command").unwrap_or(&Value::Null)).trim().to_string();
    if command.is_empty() {
        return Ok("[Error] Empty command".to_string());
    }
    let conn_id = connect_sidecar(bridge, "redis", config).await?;
    let result = sidecar_call(bridge, "db.redis.execute", serde_json::json!({
        "connId": conn_id,
        "command": command,
    }))
    .await?;
    let _ = sidecar_call(bridge, "db.redis.disconnect", serde_json::json!({ "connId": conn_id })).await;
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return Ok(format!("[Error] {error}"));
    }
    let value = result.get("result").cloned().unwrap_or(Value::Null);
    Ok(match value {
        Value::Null => "(无输出)".to_string(),
        Value::String(s) => s,
        other => format_json(&other),
    })
}

async fn execute_es(
    bridge: &HostBridgeState,
    config: &Value,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let conn_id = connect_sidecar(bridge, "elasticsearch", config).await?;
    let result = match name {
        "es_list_indices" => {
            let r = sidecar_call(bridge, "db.es.listIndices", serde_json::json!({ "connId": conn_id })).await?;
            let indices = r.as_array().cloned().unwrap_or_default();
            Ok(indices.iter().map(|i| format!(
                "{} | {} | {} | {}",
                as_str(i.get("name").unwrap_or(&Value::Null)),
                as_number(i.get("docsCount").unwrap_or(&Value::Null), 0),
                as_str(i.get("storeSize").unwrap_or(&Value::Null)),
                as_str(i.get("health").unwrap_or(&Value::Null)),
            )).collect::<Vec<_>>().join("\n"))
        }
        "es_cluster_health" => sidecar_call(bridge, "db.es.clusterHealth", serde_json::json!({ "connId": conn_id })).await.map(|r| format_json(&r)),
        "es_get_mapping" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            sidecar_call(bridge, "db.es.getMapping", serde_json::json!({ "connId": conn_id, "index": index })).await.map(|r| format_json(&r))
        }
        "es_search" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let query: Value = serde_json::from_str(&as_str(args.get("query").unwrap_or(&Value::Null))).map_err(|_| "Invalid JSON in query DSL".to_string())?;
            let from = args.get("from").and_then(Value::as_u64).unwrap_or(0);
            let size = args.get("size").and_then(Value::as_u64).unwrap_or(20);
            let r = sidecar_call(bridge, "db.es.search", serde_json::json!({
                "connId": conn_id, "index": index, "body": query, "from": from, "size": size,
            })).await?;
            Ok(format_json(&r))
        }
        "es_get_document" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let id = as_str(args.get("id").unwrap_or(&Value::Null));
            sidecar_call(bridge, "db.es.getDocument", serde_json::json!({ "connId": conn_id, "index": index, "id": id })).await.map(|r| format_json(&r))
        }
        "es_count" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let body = args.get("query").cloned();
            let mut params = serde_json::json!({ "connId": conn_id, "index": index });
            if let Some(b) = body {
                params["body"] = b;
            }
            sidecar_call(bridge, "db.es.count", params).await.map(|r| format_json(&r))
        }
        "es_index_document" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let body: Value = serde_json::from_str(&as_str(args.get("body").unwrap_or(&Value::Null))).map_err(|_| "Invalid JSON in body".to_string())?;
            let id = as_str(args.get("id").unwrap_or(&Value::Null));
            let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
            if !id.is_empty() { params["id"] = Value::String(id); }
            sidecar_call(bridge, "db.es.indexDocument", params).await.map(|r| format_json(&r))
        }
        "es_delete_document" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let id = as_str(args.get("id").unwrap_or(&Value::Null));
            sidecar_call(bridge, "db.es.deleteDocument", serde_json::json!({ "connId": conn_id, "index": index, "id": id })).await.map(|r| format_json(&r))
        }
        "es_delete_index" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            sidecar_call(bridge, "db.es.deleteIndex", serde_json::json!({ "connId": conn_id, "index": index })).await.map(|r| format_json(&r))
        }
        other => Err(format!("Unknown Elasticsearch tool: {other}")),
    };
    let _ = sidecar_call(bridge, "db.es.disconnect", serde_json::json!({ "connId": conn_id })).await;
    result
}

async fn execute_docker(
    bridge: &HostBridgeState,
    config: &Value,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let conn_id = connect_sidecar(bridge, "docker", config).await?;
    let result = match name {
        "docker_list_containers" => {
            let all = args.get("all").map(|v| v.as_str().unwrap_or("") != "false").unwrap_or(true);
            let r = sidecar_call(bridge, "docker.listContainers", serde_json::json!({ "connId": conn_id, "all": all })).await?;
            let containers = r.as_array().cloned().unwrap_or_default();
            Ok(containers.iter().take(50).map(|c| format!(
                "{} | {} | {} | {} | {}",
                as_str(c.get("id").unwrap_or(&Value::Null)).chars().take(12).collect::<String>(),
                as_str(c.get("name").unwrap_or(&Value::Null)),
                as_str(c.get("image").unwrap_or(&Value::Null)),
                as_str(c.get("state").unwrap_or(&Value::Null)),
                as_str(c.get("status").unwrap_or(&Value::Null)),
            )).collect::<Vec<_>>().join("\n"))
        }
        "docker_logs" => {
            let container = as_str(args.get("container").unwrap_or(&Value::Null));
            let tail = as_str(args.get("tail").unwrap_or(&Value::Null));
            let tail = if tail.is_empty() { "200".to_string() } else { tail };
            let r = sidecar_call(bridge, "docker.containerLogs", serde_json::json!({ "connId": conn_id, "container": container, "tail": tail })).await?;
            let logs = r.as_array().cloned().unwrap_or_default();
            Ok(logs.iter().map(|l| format!("[{}] {}", as_str(l.get("stream").unwrap_or(&Value::Null)), as_str(l.get("message").unwrap_or(&Value::Null)))).collect::<Vec<_>>().join("\n"))
        }
        "docker_inspect" => {
            let target = as_str(args.get("target").unwrap_or(&Value::Null));
            sidecar_call(bridge, "docker.inspectContainer", serde_json::json!({ "connId": conn_id, "containerId": target })).await.map(|r| format_json(&r))
        }
        "docker_exec" => {
            let container = as_str(args.get("container").unwrap_or(&Value::Null));
            let command = as_str(args.get("command").unwrap_or(&Value::Null));
            let r = sidecar_call(bridge, "docker.exec", serde_json::json!({
                "connId": conn_id,
                "container": container,
                "cmd": ["sh", "-c", command],
                "timeoutSec": 30,
            })).await?;
            let stdout = as_str(r.get("stdout").unwrap_or(&Value::Null));
            let stderr = as_str(r.get("stderr").unwrap_or(&Value::Null));
            let exit_code = as_number(r.get("exitCode").unwrap_or(&Value::Null), 0);
            Ok([stdout, if stderr.is_empty() { String::new() } else { format!("[stderr]\n{stderr}") }, if exit_code > 0 { format!("[exit {exit_code}]") } else { String::new() }].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"))
        }
        other => Err(format!("Unknown Docker tool: {other}")),
    };
    let _ = sidecar_call(bridge, "docker.disconnect", serde_json::json!({ "connId": conn_id })).await;
    result
}

// ============================================================
// 入口
// ============================================================

/// 会话资产绑定解析:bridge.resolve_asset 沿 subagent 父链解析。
/// 返回 (asset_type, asset_id)。
fn resolve_asset(bridge: &HostBridgeState, session_id: &str) -> Option<(String, String)> {
    bridge.resolve_asset(session_id)
}

/// 进程内执行一个域工具(方案1)。返回模型可读文本;Err 为硬错误。
/// 调用方(tools.rs)负责成功事件的 on_ai_tool_success 回写。
pub(crate) async fn execute_domain_tool(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let (asset_type, asset_id) = resolve_asset(bridge, session_id)
        .ok_or_else(|| "当前会话未绑定资产,无法执行域工具:请先调用 starhub_list_assets 查看可用资产,再调用 bind_asset_context 绑定目标资产(不打开窗口),或调用 open_connection / focus_terminal 打开目标资产后重试".to_string())?;

    // 全局工具名内嵌资产 id 参数(桥接层在 starhub-tools 里已按会话填充)。
    // 为避免改 dsh 侧插件,域执行统一以 assetId 参数 + 会话绑定双重来源:
    // 这里把解析到的 asset_id 补进 args,供 SSH/SFTP 执行器取用。
    let mut merged_args = args.clone();
    if !merged_args.is_object() {
        merged_args = serde_json::json!({});
    }
    if merged_args.get("assetId").and_then(Value::as_str).unwrap_or("").is_empty() {
        if let Value::Object(map) = &mut merged_args {
            map.insert("assetId".to_string(), Value::String(asset_id.clone()));
        }
    }

    // 域名判定与执行
    if name.starts_with("ssh_") {
        return execute_ssh(bridge, name, &merged_args).await;
    }
    if name.starts_with("sftp_") {
        return execute_sftp(bridge, name, &merged_args).await;
    }

    // DB / Redis / ES / Docker 需要资产连接配置
    let (_asset_type, config) = load_asset_config(&asset_id).await?;
    let kind = if asset_type == "db" {
        as_str(config.get("dbType").unwrap_or(&Value::Null))
    } else {
        asset_type.clone()
    };

    if name == "db_query" {
        return execute_relational_db(bridge, &kind, &config, &merged_args).await;
    }
    if name == "redis_exec" {
        return execute_redis(bridge, &config, &merged_args).await;
    }
    if name.starts_with("es_") {
        return execute_es(bridge, &config, name, &merged_args).await;
    }
    if name.starts_with("docker_") {
        return execute_docker(bridge, &config, name, &merged_args).await;
    }

    Err(format!("unsupported in-process StarHub tool: {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 纯函数:base64 / 后台任务命令 / sleep 检测 ----------

    #[test]
    fn base64_roundtrip_matches_standard() {
        // 与前端 TextEncoder + btoa 等价:ASCII、中文、空串、3 字节对齐边界
        for text in ["", "a", "ab", "abc", "abcd", "ls -la /var/log", "你好世界"] {
            let encoded = to_base64(text);
            // 标准 base64 已知向量:ASCII 输入的前端 btoa 结果即标准 base64
            let expected: &str = match text {
                "" => "",
                "a" => "YQ==",
                "ab" => "YWI=",
                "abc" => "YWJj",
                "abcd" => "YWJjZA==",
                "ls -la /var/log" => "bHMgLWxhIC92YXIvbG9n",
                "你好世界" => "5L2g5aW95LiW55WM",
                _ => unreachable!(),
            };
            assert_eq!(encoded, expected, "base64 编码不符: {text:?}");
            // 往返解码回原文(验证编码不自毁)
            let decoded = decode_base64_for_test(&encoded);
            assert_eq!(decoded, text.as_bytes(), "base64 往返失败: {text:?} → {encoded}");
        }
    }

    fn decode_base64_for_test(encoded: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buffer = 0u32;
        let mut bits = 0u32;
        for ch in encoded.chars() {
            if ch == '=' {
                break;
            }
            let value = ALPHABET.iter().position(|&c| c as char == ch);
            let Some(value) = value else { continue };
            buffer = (buffer << 6) | value as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
        out
    }

    #[test]
    fn background_start_command_builds_expected_shape() {
        let command = "echo hi";
        let task_id = "task-abc123";
        let built = build_background_start_command(command, task_id);
        assert!(built.contains(&format!("/tmp/starhub-ai-bg/{task_id}")), "{built}");
        assert!(built.contains("mkdir -p"), "{built}");
        assert!(built.contains("nohup bash"), "{built}");
        assert!(built.contains("run.sh"), "{built}");
        assert!(built.contains("out.log"), "{built}");
        // 命令体经 base64 落盘,不应以明文出现
        assert!(!built.contains("echo hi"), "命令应以 base64 传输: {built}");
        assert!(built.contains("[TASK] task-abc123 STARTED"), "{built}");
    }

    #[test]
    fn poll_command_validates_and_writes_status() {
        let built = build_task_poll_command("task-x", 30);
        assert!(built.contains("NOT_FOUND"), "{built}");
        assert!(built.contains("FINISHED EXIT"), "{built}");
        assert!(built.contains("RUNNING PID"), "{built}");
        assert!(built.contains("[LOG TAIL]"), "{built}");
        assert!(built.contains("tail -c 4000"), "{built}");
    }

    #[test]
    fn task_id_validation() {
        assert!(is_valid_task_id("task-abc_123"));
        assert!(is_valid_task_id("TASK-x9"));
        assert!(!is_valid_task_id(""));
        assert!(!is_valid_task_id("task id with spaces"));
        assert!(!is_valid_task_id(&"x".repeat(65)));
        assert!(!is_valid_task_id("task;rm -rf /"));
    }

    #[test]
    fn clamp_wait_seconds_bounds() {
        assert_eq!(clamp_task_wait_seconds(None), 30);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(1))), 1);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(55))), 55);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(999))), 55);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(0))), 1);
    }

    #[test]
    fn long_sleep_detection() {
        assert!(find_long_sleep_seconds("sleep 30", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 1m", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 1h", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 5", 15.0).is_none());
        assert!(find_long_sleep_seconds("ls -la", 15.0).is_none());
        assert!(find_long_sleep_seconds("SLEEP 20 && echo x", 15.0).is_some());
        assert!(find_long_sleep_seconds("echo 'sleep 999'", 15.0).is_some(), "字符串内也应命中(与前端 regex 一致)");
    }

    // ---------- 结果格式化 ----------

    #[test]
    fn format_query_result_basic() {
        let value = serde_json::json!({
            "columns": [{ "name": "id" }, { "name": "name" }],
            "rows": [[1, "alice"], [2, "bob"]],
            "rowsAffected": 0,
        });
        let text = format_query_result(&value);
        assert!(text.contains("列: id, name"), "{text}");
        assert!(text.contains("id=1 | name=alice"), "{text}");
        assert!(text.contains("id=2 | name=bob"), "{text}");
    }

    #[test]
    fn format_query_result_error_and_empty() {
        let err = format_query_result(&serde_json::json!({ "error": "syntax error" }));
        assert!(err.contains("[Error] syntax error"), "{err}");
        let empty = format_query_result(&serde_json::json!({ "columns": [], "rows": [], "rowsAffected": 3 }));
        assert!(empty.contains("3 行受影响"), "{empty}");
    }

    #[test]
    fn format_query_result_truncates_long_values() {
        let long = "x".repeat(300);
        let value = serde_json::json!({
            "columns": [{ "name": "v" }],
            "rows": [[long]],
        });
        let text = format_query_result(&value);
        assert!(text.contains("…"), "{text}");
    }
}
