//! SSH/SFTP 域工具执行体(去 Tauri 化 M1 的唯一事实源)。
//!
//! 从 `src-tauri/src/harness/domain.rs` 的 SSH/SFTP 执行器与 sidecar 的
//! `runtime.rs` 合并而来:两边原本是同一份代码的两份拷贝,现在收敛成一组
//! **自由函数 + 依赖注入**——
//!
//! - [`AssetSource`]:资产 id → SSH 连接配置(Tauri 侧 = SQLite + Keyring,
//!   sidecar 侧 = assets.json + 密钥存储);
//! - [`ExecTracker`]:在途 exec 的 exec_id 登记(Tauri 侧 = 桥的
//!   `inflight_tools`,停止生成时 `drain()` 中断;sidecar 侧 = 自有 map,
//!   经 `starhub/exec.abort` 通知中断);
//! - [`ToolContext`]:把 manager / transfers / assets / sink / tracker 打包,
//!   执行体对宿主零特判。
//!
//! 结果文本格式与前端 `src/services/dshToolExecutor.ts` 对齐(模型可读文本),
//! **文本是契约,不许漂移**;connId 规则(`dsh:{asset_id}:ssh`)、连接级失败
//! 重建一次、长 sleep 软引导、后台任务命令拼装全部原样保持。

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::events::{EventSink, StoreFuture};
use crate::manager::{connect_session, ssh_exec_core, SshManager};
use crate::sftp::transfer::TransferManager;
use crate::SshConfig;

/// connId 前缀:与前端 dshToolExecutor 的 `dsh:{assetId}:ssh` 保持一致,
/// 可复用前端已建立的 AI exec 会话(避免重复连接)。
pub fn ai_conn_id(asset_id: &str) -> String {
    format!("dsh:{asset_id}:ssh")
}

/// 连接级失败判定:exec 通道都打不开 / 会话句柄不在位——命令一定没有在远端
/// 开始执行,丢弃会话重建后重试是安全的。业务级失败(退出码非 0 /
/// [EXEC_TIMEOUT] / [EXEC_ABORTED])不在此列,原样返回由模型决策。
pub fn is_connection_level_failure(error: &str) -> bool {
    error.starts_with("[EXEC_FAILED]")
        || error.starts_with("[CONN_FAILED]")
        || error.contains("SSH session not connected")
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
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

pub fn new_background_task_id() -> String {
    format!("task-{}", uuid::Uuid::new_v4().simple())
}

pub fn is_valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 64
        && task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn clamp_task_wait_seconds(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .clamp(1, AI_BG_MAX_WAIT_S)
}

pub fn build_background_start_command(command: &str, task_id: &str) -> String {
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

pub fn build_task_poll_command(task_id: &str, wait_seconds: u64) -> String {
    let dir = format!("{AI_BG_TASK_ROOT}/{task_id}");
    let w = wait_seconds.clamp(1, AI_BG_MAX_WAIT_S);
    format!(
        "d={dir}; if [ ! -d \"$d\" ]; then echo \"[STATUS] NOT_FOUND\"; exit 1; fi; i=0; while [ \"$i\" -lt {w} ] && [ ! -f \"$d/exit\" ]; do sleep 1; i=$((i+1)); done; if [ -f \"$d/exit\" ]; then echo \"[STATUS] FINISHED EXIT=$(cat \"$d/exit\" 2>/dev/null)\"; else echo \"[STATUS] RUNNING PID=$(cat \"$d/pid\" 2>/dev/null)\"; fi; echo \"[LOG TAIL]\"; tail -c {AI_BG_LOG_TAIL_BYTES} \"$d/out.log\" 2>/dev/null"
    )
}

/// 检测命令里的长 sleep(阈值 15s,支持 s/m/h 后缀),返回等待秒数。
/// 自实现轻量扫描(与前端 findLongSleepSeconds 语义一致),避免 regex 依赖。
pub fn find_long_sleep_seconds(command: &str, threshold_sec: f64) -> Option<f64> {
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

const TRANSFER_POLL_MS: u64 = 400;
const TRANSFER_TIMEOUT_MS: u64 = 30 * 60 * 1000;

fn as_str(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

pub fn required_path(value: Option<&Value>) -> Result<String, String> {
    let text = as_str(value.unwrap_or(&Value::Null)).trim().to_string();
    if text.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if text.len() > 4096 {
        return Err("路径过长".to_string());
    }
    Ok(text)
}

pub fn required_remote_path(value: Option<&Value>) -> Result<String, String> {
    let text = required_path(value)?;
    if !text.starts_with('/') && !text.starts_with('~') {
        return Err(format!("必须是远端绝对路径(以 / 或 ~ 开头),收到: {text}"));
    }
    Ok(text)
}

pub fn format_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// 资产配置来源(宿主注入)。
pub trait AssetSource: Send + Sync {
    /// 资产 id → (资产名, SSH 连接配置);资产不存在 / 类型不符 / 配置不完整时报错。
    fn asset_ssh_config<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> StoreFuture<'a, Result<(String, SshConfig), String>>;
}

/// 在途 exec 登记(宿主注入):停止生成时按 exec_id 中断。
pub trait ExecTracker: Send + Sync {
    /// 登记一条在途 exec(exec_id → conn_id)。
    fn register(&self, exec_id: &str, conn_id: &str);
    /// 解除登记(exec 结束后必须调用,避免 map 泄漏)。
    fn unregister(&self, exec_id: &str);
}

/// 执行上下文:两个宿主持有各自的实现,执行体完全共用。
pub struct ToolContext<'a> {
    pub manager: &'a SshManager,
    pub transfers: &'a TransferManager,
    pub assets: &'a dyn AssetSource,
    pub sink: &'a Arc<dyn EventSink>,
    pub tracker: &'a dyn ExecTracker,
}

/// 丢弃一个(死)SSH 会话:map 条目 + 代次 + pending 应答通道一并清理,
/// 下一次 ensure_ssh_session 按资产配置重建。
pub async fn drop_ssh_session(ctx: &ToolContext<'_>, conn_id: &str) {
    ctx.manager.drop_session(conn_id).await;
}

/// 确保 AI exec SSH 会话存在(connId 与前端一致,复用已建会话)。
/// 返回 connId。死会话自动丢弃重建(网络断开 / 被服务端踢掉时自愈)。
pub async fn ensure_ssh_session(ctx: &ToolContext<'_>, asset_id: &str) -> Result<String, String> {
    let conn_id = ai_conn_id(asset_id);
    {
        let session_arc = ctx.manager.sessions.lock().await.get(&conn_id).cloned();
        match session_arc {
            Some(arc) if arc.lock().await.is_alive() => return Ok(conn_id),
            Some(_) => {
                // 死会话:丢弃后走下方建连路径重建(MFA 资产重建会重新弹验证卡,
                // 属于人工配合的必要环节)。
                drop_ssh_session(ctx, &conn_id).await;
            }
            None => {}
        }
    }
    // 无会话:按资产配置建立(密码/密钥由 AssetSource 合并)
    let (_name, config) = ctx.assets.asset_ssh_config(asset_id).await?;
    connect_session(
        ctx.manager,
        ctx.transfers,
        conn_id.clone(),
        config,
        ctx.sink,
        false,
    )
    .await?;
    Ok(conn_id)
}

/// 带 exec_id 的进程内执行,登记在途取消句柄(停止生成时中断)。
async fn exec_ssh_command(
    ctx: &ToolContext<'_>,
    conn_id: &str,
    command: &str,
    timeout_sec: u64,
) -> Result<String, String> {
    let exec_id = format!("dsh-exec-{}", uuid::Uuid::new_v4());
    ctx.tracker.register(&exec_id, conn_id);
    let result = ssh_exec_core(
        ctx.manager,
        ctx.sink,
        conn_id,
        command,
        Some(timeout_sec),
        Some(&exec_id),
        true,
    )
    .await;
    ctx.tracker.unregister(&exec_id);
    result
}

/// 执行一条 AI SSH 命令;连接级失败时丢弃死会话、重建一次并重试——
/// 连接级失败意味着命令尚未在远端开始执行,重试安全。业务级失败原样返回,
/// 由模型决策下一步。
async fn exec_with_reconnect(
    ctx: &ToolContext<'_>,
    asset_id: &str,
    conn_id: &str,
    command: &str,
    timeout_sec: u64,
) -> Result<String, String> {
    match exec_ssh_command(ctx, conn_id, command, timeout_sec).await {
        Ok(output) => Ok(output),
        Err(error) if is_connection_level_failure(&error) => {
            drop_ssh_session(ctx, conn_id).await;
            let fresh_conn = ensure_ssh_session(ctx, asset_id).await?;
            exec_ssh_command(ctx, &fresh_conn, command, timeout_sec).await
        }
        Err(error) => Err(error),
    }
}

/// 执行 ssh_exec / ssh_exec_background / ssh_wait_task。
pub async fn execute_ssh(
    ctx: &ToolContext<'_>,
    name: &str,
    asset_id: &str,
    args: &Value,
) -> Result<String, String> {
    if asset_id.is_empty() {
        return Err("缺少 assetId,无法执行 SSH 工具".to_string());
    }
    let conn_id = ensure_ssh_session(ctx, asset_id).await?;
    if name == "ssh_wait_task" {
        let task_id = as_str(args.get("task_id").unwrap_or(&Value::Null))
            .trim()
            .to_string();
        if !is_valid_task_id(&task_id) {
            return Ok("[Error] 无效的 task_id".to_string());
        }
        let wait_sec = clamp_task_wait_seconds(args.get("wait_seconds"));
        let output = exec_with_reconnect(
            ctx,
            asset_id,
            &conn_id,
            &build_task_poll_command(&task_id, wait_sec),
            wait_sec + 15,
        )
        .await?;
        return Ok(if output.is_empty() {
            "(无输出)".to_string()
        } else {
            output
        });
    }

    let command = as_str(args.get("command").unwrap_or(&Value::Null))
        .trim()
        .to_string();
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

    let task_id = if is_background {
        new_background_task_id()
    } else {
        String::new()
    };
    let final_command = if is_background {
        build_background_start_command(&command, &task_id)
    } else {
        command.clone()
    };
    let output = exec_with_reconnect(ctx, asset_id, &conn_id, &final_command, 30).await?;
    if is_background {
        Ok(format!(
            "{output}\n后台任务已启动,task_id: {task_id};请调用 ssh_wait_task(task_id=\"{task_id}\") 查询进度与结果。"
        ))
    } else {
        Ok(if output.is_empty() {
            "(无输出)".to_string()
        } else {
            output
        })
    }
}

/// 查询当前绑定资产 SSH 会话状态(功能①:给模型透出「已选中机器」等状态)。
///
/// **不触发连接**:只读 `SshManager.sessions`,让模型在发命令前判断是否会
/// 弹「选机器」浮层 / 命令是否静默执行。
pub async fn execute_ssh_status(ctx: &ToolContext<'_>, asset_id: &str) -> Result<String, String> {
    let conn_id = ai_conn_id(asset_id);
    let session_arc = {
        let sessions = ctx.manager.sessions.lock().await;
        sessions.get(&conn_id).cloned()
    };
    let Some(session_arc) = session_arc else {
        return Ok(format!(
            "SSH 会话未建立(资产 {asset_id}):首次命令会自动连接,堡垒机会依次弹出 MFA 验证卡与「选机器」终端,需要一次人工配合;之后会话复用,命令静默执行。"
        ));
    };
    let session = session_arc.lock().await;
    if !session.is_alive() {
        return Ok(format!(
            "SSH 会话已断开(资产 {asset_id}):连接已死亡(网络断开或被服务端踢掉),下一条命令会自动重建连接;堡垒机资产重建时会重新弹出 MFA 验证与选机器流程。"
        ));
    }
    if session.bastion_shell_ready() {
        Ok(format!(
            "SSH 会话已就绪(资产 {asset_id}):堡垒机已选中目标机器,后续命令直接静默执行,不会弹窗。"
        ))
    } else if session.is_bastion() {
        Ok(format!(
            "SSH 会话已连接(资产 {asset_id},堡垒机):尚未选择目标机器,下一条命令会弹出「选机器」实时终端,请准备在终端里输入序号选择。"
        ))
    } else {
        Ok(format!(
            "SSH 会话已连接(资产 {asset_id}),命令将直接执行,不会弹窗。"
        ))
    }
}

/// 执行 sftp_list / sftp_stat / sftp_upload / sftp_download(复用 SSH 会话)。
pub async fn execute_sftp(
    ctx: &ToolContext<'_>,
    name: &str,
    asset_id: &str,
    args: &Value,
) -> Result<String, String> {
    if asset_id.is_empty() {
        return Err("缺少 assetId,无法执行 SFTP 工具".to_string());
    }
    let conn_id = ensure_ssh_session(ctx, asset_id).await?;

    // 确保 SFTP 通道已注册(惰性建立)
    if !ctx.transfers.has_session(&conn_id).await {
        let session_arc = {
            let sessions = ctx.manager.sessions.lock().await;
            sessions
                .get(&conn_id)
                .cloned()
                .ok_or_else(|| format!("SSH session {conn_id} not found"))?
        };
        let mut session = session_arc.lock().await;
        let (sftp, _launch_info) = session.open_sftp_with_info().await?;
        ctx.transfers
            .register_sftp(conn_id.clone(), Arc::new(Mutex::new(sftp)))
            .await;
    }

    match name {
        "sftp_list" => {
            let path = required_remote_path(args.get("path"))?;
            let session_arc = {
                let sessions = ctx.manager.sessions.lock().await;
                sessions
                    .get(&conn_id)
                    .cloned()
                    .ok_or_else(|| "session not found".to_string())?
            };
            let mut session = session_arc.lock().await;
            let entries = session
                .with_browse_sftp(|sftp| {
                    Box::pin(async move { sftp.read_dir(&path).await.map_err(|e| e.to_string()) })
                })
                .await?;
            let mut lines: Vec<String> = Vec::new();
            for entry in entries {
                let metadata = entry.metadata();
                let is_dir = metadata.is_dir();
                let size = if is_dir {
                    0
                } else {
                    metadata.size.unwrap_or(0)
                };
                let path = entry.path();
                lines.push(format!(
                    "{} | {} | {} | {:o}",
                    if is_dir { "DIR " } else { "FILE" },
                    path,
                    if is_dir {
                        "-".to_string()
                    } else {
                        size.to_string()
                    },
                    metadata.permissions.unwrap_or(0)
                ));
            }
            if lines.len() > 200 {
                let shown = lines.len();
                lines.truncate(200);
                lines.push(format!("… (共 {shown} 项,仅显示前 200 项)"));
            }
            Ok(if lines.is_empty() {
                "(空目录)".to_string()
            } else {
                lines.join("\n")
            })
        }
        "sftp_stat" => {
            let path = required_remote_path(args.get("path"))?;
            let session_arc = {
                let sessions = ctx.manager.sessions.lock().await;
                sessions
                    .get(&conn_id)
                    .cloned()
                    .ok_or_else(|| "session not found".to_string())?
            };
            let mut session = session_arc.lock().await;
            let meta_path = path.clone();
            let metadata = session
                .with_browse_sftp(|sftp| {
                    Box::pin(
                        async move { sftp.metadata(&meta_path).await.map_err(|e| e.to_string()) },
                    )
                })
                .await?;
            Ok(format_json(&json!({
                "path": path,
                "is_dir": metadata.is_dir(),
                "size": metadata.size.unwrap_or(0),
                "permissions": metadata.permissions.unwrap_or(0),
            })))
        }
        "sftp_upload" | "sftp_download" => {
            let speed_limit = args.get("speedLimit").and_then(Value::as_u64).unwrap_or(0);
            if name == "sftp_upload" {
                let local_paths: Vec<String> = args
                    .get("localPaths")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().map(as_str).collect())
                    .unwrap_or_default();
                if local_paths.is_empty() {
                    return Err("localPaths 不能为空".to_string());
                }
                let remote_dir = required_remote_path(args.get("remoteDir"))?;
                let transfer_id = ctx
                    .transfers
                    .upload(&conn_id, local_paths, remote_dir, speed_limit)
                    .await
                    .map_err(|e| e.to_string())?;
                wait_for_transfer(ctx, &conn_id, &transfer_id).await
            } else {
                let remote_paths: Vec<String> = args
                    .get("remotePaths")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().map(as_str).collect())
                    .unwrap_or_default();
                if remote_paths.is_empty() {
                    return Err("remotePaths 不能为空".to_string());
                }
                let local_dir = required_path(args.get("localDir"))?;
                let transfer_id = ctx
                    .transfers
                    .download(&conn_id, remote_paths, local_dir, speed_limit)
                    .await
                    .map_err(|e| e.to_string())?;
                wait_for_transfer(ctx, &conn_id, &transfer_id).await
            }
        }
        other => Err(format!("Unknown SFTP tool: {other}")),
    }
}

/// 等一次传输到达终态,返回模型可读汇总(文案与前端实现逐字一致)。
async fn wait_for_transfer(
    ctx: &ToolContext<'_>,
    conn_id: &str,
    transfer_id: &str,
) -> Result<String, String> {
    use crate::sftp::{TransferDirection, TransferStatus};
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(TRANSFER_TIMEOUT_MS);
    loop {
        let task = ctx
            .transfers
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

/// 空实现:不跟踪在途 exec 的宿主(测试 / 无中断需求的场景)。
pub struct NoopExecTracker;

impl ExecTracker for NoopExecTracker {
    fn register(&self, _exec_id: &str, _conn_id: &str) {}
    fn unregister(&self, _exec_id: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::MemoryKnownHostsStore;

    // ---------- 纯函数:base64 / 后台任务命令 / sleep 检测 ----------

    #[test]
    fn base64_roundtrip_matches_standard() {
        // 与前端 TextEncoder + btoa 等价:ASCII、中文、空串、3 字节对齐边界
        for text in ["", "a", "ab", "abc", "abcd", "ls -la /var/log", "你好世界"] {
            let encoded = to_base64(text);
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
            let decoded = decode_base64_for_test(&encoded);
            assert_eq!(decoded, text.as_bytes(), "base64 往返失败: {text:?}");
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
        assert!(
            built.contains(&format!("/tmp/starhub-ai-bg/{task_id}")),
            "{built}"
        );
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
        assert_eq!(clamp_task_wait_seconds(Some(&json!(1))), 1);
        assert_eq!(clamp_task_wait_seconds(Some(&json!(55))), 55);
        assert_eq!(clamp_task_wait_seconds(Some(&json!(999))), 55);
        assert_eq!(clamp_task_wait_seconds(Some(&json!(0))), 1);
    }

    #[test]
    fn long_sleep_detection() {
        assert!(find_long_sleep_seconds("sleep 30", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 1m", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 1h", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 5", 15.0).is_none());
        assert!(find_long_sleep_seconds("ls -la", 15.0).is_none());
        assert!(find_long_sleep_seconds("SLEEP 20 && echo x", 15.0).is_some());
        assert!(
            find_long_sleep_seconds("echo 'sleep 999'", 15.0).is_some(),
            "字符串内也应命中(与前端 regex 一致)"
        );
    }

    // ---------- 连接级失败判定 ----------

    #[test]
    fn connection_level_failure_matches_only_transport_errors() {
        assert!(is_connection_level_failure(
            "[EXEC_FAILED] Failed to open exec channel: Channel send error"
        ));
        assert!(is_connection_level_failure("SSH session not connected"));
        assert!(is_connection_level_failure(
            "[CONN_FAILED] Failed to connect to 10.0.0.7:22: timeout"
        ));
        assert!(!is_connection_level_failure(
            "Command exited with code 1: no such file"
        ));
        assert!(!is_connection_level_failure(
            "[EXEC_TIMEOUT] Command timed out after 30s: apt-get install"
        ));
        assert!(!is_connection_level_failure(
            "[EXEC_ABORTED] Command aborted by user: ls"
        ));
    }

    // ---------- 路径参数校验 ----------

    #[test]
    fn remote_path_requires_absolute_or_tilde() {
        assert_eq!(
            required_remote_path(Some(&json!("/var/log"))).unwrap(),
            "/var/log"
        );
        assert_eq!(required_remote_path(Some(&json!("~/x"))).unwrap(), "~/x");
        let err = required_remote_path(Some(&json!("var/log"))).unwrap_err();
        assert!(err.contains("必须是远端绝对路径"), "{err}");
        assert!(required_remote_path(Some(&json!("  "))).is_err());
        assert!(required_remote_path(None).is_err());
    }

    // ---------- connId 规则 ----------

    #[test]
    fn ai_conn_id_matches_the_frontend_key() {
        assert_eq!(ai_conn_id("asset-1"), "dsh:asset-1:ssh");
    }
}
