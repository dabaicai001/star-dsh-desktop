//! UI 方法面 B 组(去 Tauri 化 M2):交互会话——SSH 终端与 SFTP 面板。
//!
//! 工作台持有 connId(会话 id),与模型面(assetId)是两套定位方式:模型面
//! `ssh_exec(assetId, command)` 由域工具执行器建连,UI 面 `ui.ssh_write(id, data)`
//! 只对已存在的会话做读写。会话实体([`SshManager`])与传输任务
//! ([`TransferManager`])本就住在 sidecar,本模块只做命令面平移:
//! **参数形状、返回形状、错误文案与 `src-tauri/src/commands/{ssh,sftp}.rs`
//! 逐字一致**(用户可读文本是契约,不许漂移)。
//!
//! 窗口类动作(`ui.ssh_open_web_window`)在本批显式降级:网页访问面板随 M3
//! 面板化落地,这里返回明确的中文指引,而不是 -32601 的晦涩错误。

use std::sync::Arc;

use serde_json::{json, Value};
use starhub_domain_ssh::manager::{connect_session, ssh_exec_core, SshManager};
use starhub_domain_ssh::session::SshSession;
use starhub_domain_ssh::sftp_types::SftpEntry;
use starhub_domain_ssh::{SshConfig, SshSessionInfo};
use tokio::sync::Mutex;

use crate::bridge::REGISTRY_SYNC_METHOD;
use crate::jsonrpc::RpcError;
use crate::runtime::SshRuntime;

/// 取必填字符串参数(缺失即参数错误;文案与 A 组 `ui.*` 一致)。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
}

/// 取必填字符串数组(非字符串元素忽略)。
fn required_str_list(params: &Value, key: &str) -> Result<Vec<String>, RpcError> {
    let items = params
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))?;
    Ok(items
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect())
}

/// 取可选 u64(缺失或非数字均为 None)。
fn optional_u64(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

/// 从会话表取 Arc 并立即释放主锁(不存在即 Tauri 同款文案)。
async fn session_arc(manager: &SshManager, id: &str) -> Result<Arc<Mutex<SshSession>>, RpcError> {
    let sessions = manager.sessions.lock().await;
    sessions
        .get(id)
        .cloned()
        .ok_or_else(|| RpcError::internal("Session not found"))
}

/// 断开的是受跟踪会话时,向 dsh 补发注册表全量快照(契约 §2.1「断线」)。
fn notify_registry_sync(ssh: &SshRuntime, live_ids: &std::collections::HashSet<String>) {
    let (sessions, _pruned) = ssh.registry().snapshot(live_ids);
    ssh.sink()
        .emit(REGISTRY_SYNC_METHOD, json!({ "sessions": sessions }));
}

// ── SSH 交互会话 ─────────────────────────────────────────────

/// `ui.ssh_connect`:建立带 PTY 的交互会话(interactive=true)。
pub async fn ssh_connect(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let config: SshConfig =
        serde_json::from_value(params.get("config").cloned().unwrap_or(Value::Null))
            .map_err(|error| RpcError::invalid_params(format!("config 解析失败: {error}")))?;
    let info = connect_session(ssh.manager(), ssh.transfers(), id, config, ssh.sink(), true)
        .await
        .map_err(RpcError::internal)?;
    Ok(json!(info))
}

/// `ui.ssh_write`:向交互 channel 写文本(UTF-8 字节)。
pub async fn ssh_write(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let data = required_str(params, "data")?;
    // 克隆 sender 后立即释放 channels 锁再 await send(背压)
    let tx = {
        let channels = ssh.manager().channels.lock().await;
        channels.get(&id).map(|(_, tx)| tx.clone())
    };
    if let Some(tx) = tx {
        tx.send(data.into_bytes())
            .await
            .map_err(|_| RpcError::internal("Failed to send data to channel"))?;
    }
    Ok(Value::Null)
}

/// `ui.ssh_write_binary`:向交互 channel 写原始字节(ZMODEM rz/sz 二进制协议)。
pub async fn ssh_write_binary(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let data = params
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::invalid_params("缺少 data"))?
        .iter()
        .map(|item| {
            item.as_u64()
                .and_then(|value| u8::try_from(value).ok())
                .ok_or_else(|| RpcError::invalid_params("data 必须是字节数组(0-255)"))
        })
        .collect::<Result<Vec<u8>, RpcError>>()?;
    let tx = {
        let channels = ssh.manager().channels.lock().await;
        channels.get(&id).map(|(_, tx)| tx.clone())
    };
    if let Some(tx) = tx {
        tx.send(data)
            .await
            .map_err(|_| RpcError::internal("Failed to send binary data to channel"))?;
    }
    Ok(Value::Null)
}

/// `ui.ssh_resize`:调整 PTY 尺寸。
pub async fn ssh_resize(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let cols = optional_u64(params, "cols")
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| RpcError::invalid_params("缺少 cols"))?;
    let rows = optional_u64(params, "rows")
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| RpcError::invalid_params("缺少 rows"))?;
    let session = session_arc(ssh.manager(), &id).await?;
    let session = session.lock().await;
    session
        .resize(cols, rows)
        .await
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.ssh_disconnect`:断开会话并清理(代次守卫 + pending 应答 + 注册表)。
pub async fn ssh_disconnect(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let manager = ssh.manager();
    // 代次守卫:清理期间若用户已重开连接(新代次),失效/通道/pending 清理全部跳过
    let target_generation = manager.current_attempt(&id).await;
    // SFTP 通道由 TransferManager 单独持有;先移除,避免残留失效句柄
    ssh.transfers().unregister_sftp(&id).await;
    let session_arc = {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&id)
    };
    if let Some(session) = session_arc {
        let mut session = session.lock().await;
        session.disconnect();
    }
    let invalidated_generation = match target_generation {
        Some(guard) => manager.invalidate_attempt_if_current(&id, guard).await,
        None => None,
    };
    if let Some(invalidated_generation) = invalidated_generation {
        manager
            .remove_write_channel_for_attempt(&id, invalidated_generation.wrapping_sub(1))
            .await;
        // 丢弃仍在等待前端输入的 MFA / 主机密钥 / 堡垒机选机器应答通道,
        // 否则 in-flight connect 会阻塞到 360s 超时
        manager.pending_kb.lock().await.remove(&id);
        manager.pending_hostkey.lock().await.remove(&id);
        manager.pending_bastion.lock().await.remove(&id);
    }
    if ssh.registry().remove_session(&id).is_some() {
        let live_ids = {
            let sessions = manager.sessions.lock().await;
            sessions.keys().cloned().collect()
        };
        notify_registry_sync(ssh, &live_ids);
    }
    Ok(Value::Null)
}

/// `ui.ssh_get_sessions`:全部会话及其连接目标(广播对话框用)。
pub async fn ssh_get_sessions(ssh: &SshRuntime, _params: &Value) -> Result<Value, RpcError> {
    let manager = ssh.manager();
    let snapshot: Vec<(String, Arc<Mutex<SshSession>>)> = {
        let sessions = manager.sessions.lock().await;
        sessions
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect()
    };
    let channels = manager.channels.lock().await;
    let mut infos = Vec::with_capacity(snapshot.len());
    for (id, session_arc) in snapshot {
        let session = session_arc.lock().await;
        let (host, port, username) = session.endpoint();
        infos.push(SshSessionInfo {
            id: id.clone(),
            host,
            port,
            username,
            connected: channels.contains_key(&id),
        });
    }
    Ok(json!(infos))
}

/// `ui.ssh_exec`:在已有会话上跑一条命令,返回 stdout(仪表盘/一次性采集)。
pub async fn ssh_exec(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let command = required_str(params, "command")?;
    let timeout_sec = optional_u64(params, "timeoutSec");
    let exec_id = params
        .get("execId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let output = ssh_exec_core(
        ssh.manager(),
        ssh.sink(),
        &id,
        &command,
        timeout_sec,
        exec_id.as_deref(),
        false,
    )
    .await
    .map_err(RpcError::internal)?;
    Ok(json!(output))
}

/// `ui.ssh_kb_response`:前端回复 keyboard-interactive(MFA)响应。
pub async fn ssh_kb_response(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let responses = required_str_list(params, "responses")?;
    let sender = {
        let mut map = ssh.manager().pending_kb.lock().await;
        map.remove(&id)
            .ok_or_else(|| RpcError::internal(format!("No pending kb prompt for session {id}")))?
    };
    sender
        .send(responses)
        .map_err(|_| RpcError::internal("Failed to send kb response (handler dropped)"))?;
    Ok(Value::Null)
}

/// `ui.ssh_hostkey_response`:前端回复主机密钥(TOFU)确认。
pub async fn ssh_hostkey_response(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let allowed = params
        .get("allowed")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::invalid_params("缺少 allowed"))?;
    let persist = params
        .get("persist")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::invalid_params("缺少 persist"))?;
    let sender = {
        let mut map = ssh.manager().pending_hostkey.lock().await;
        map.remove(&id).ok_or_else(|| {
            RpcError::internal(format!("No pending hostkey prompt for session {id}"))
        })?
    };
    sender
        .send((allowed, persist))
        .map_err(|_| RpcError::internal("Failed to send hostkey response (handler dropped)"))?;
    Ok(Value::Null)
}

/// `ui.ssh_bastion_response`:堡垒机「选机器」回复(空串 = 用户放弃)。
pub async fn ssh_bastion_response(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let selection = required_str(params, "selection")?;
    let sender = {
        let mut map = ssh.manager().pending_bastion.lock().await;
        map.remove(&id).ok_or_else(|| {
            RpcError::internal(format!("No pending bastion prompt for session {id}"))
        })?
    };
    sender
        .send(selection)
        .map_err(|_| RpcError::internal("Failed to send bastion response (handler dropped)"))?;
    Ok(Value::Null)
}

/// `ui.ssh_get_trusted_host_key`:该 host:port 最近确认过的 OpenSSH 公钥。
pub async fn ssh_get_trusted_host_key(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let host = required_str(params, "host")?;
    let port = optional_u64(params, "port")
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| RpcError::invalid_params("缺少 port"))?;
    let key = ssh
        .manager()
        .known_hosts
        .trusted_public_key(&host, port)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    Ok(json!(key))
}

/// `ui.test_ssh_connection`:测试连接(不写入会话表,连完即断)。
pub async fn test_ssh_connection(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let config: SshConfig =
        serde_json::from_value(params.get("config").cloned().unwrap_or(Value::Null))
            .map_err(|error| RpcError::invalid_params(format!("config 解析失败: {error}")))?;
    let test_session_id = required_str(params, "testSessionId")?;
    let manager = ssh.manager();
    let mut session = SshSession::new(config.clone(), Arc::clone(&manager.known_hosts));
    let start = std::time::Instant::now();
    let result = session
        .connect(
            &test_session_id,
            Some(ssh.sink()),
            &manager.pending_kb,
            &manager.pending_hostkey,
        )
        .await;
    {
        let mut map = manager.pending_kb.lock().await;
        map.remove(&test_session_id);
    }
    {
        let mut map = manager.pending_hostkey.lock().await;
        map.remove(&test_session_id);
    }
    if let Err(error) = result {
        return Ok(json!({ "ok": false, "message": error }));
    }
    let elapsed_ms = start.elapsed().as_millis() as u64;
    session.disconnect();
    // 给一点时间让 disconnect 走完(它是 spawn 出去的)
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Ok(json!({
        "ok": true,
        "message": format!(
            "OK in {}ms ({}@{}:{})",
            elapsed_ms, config.username, config.host, config.port
        ),
        "elapsed_ms": elapsed_ms,
    }))
}

/// `ui.ssh_open_web_window`:窗口类动作,M3 面板化前显式降级。
///
/// 无状态(不查会话):面板落地前任何调用都拿同一句指引。
pub fn ssh_open_web_window(params: &Value) -> Result<Value, RpcError> {
    let _ = required_str(params, "sessionId")?;
    let _ = required_str(params, "assetName")?;
    Err(RpcError::internal(
        "网页访问面板随 M3 面板化落地(去 Tauri 化 M2 窗口类动作暂不提供)",
    ))
}

// ── SFTP 浏览面 ──────────────────────────────────────────────

/// `ui.sftp_ensure_session`:在会话上开 SFTP 通道并注册到 TransferManager。
///
/// 已注册时先轻量探活:SSH 正常但 sftp 通道死亡时注销旧通道并重建
/// (此前 has_session 直接短路,死通道永久不自愈)。
pub async fn sftp_ensure_session(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    if ssh.transfers().has_session(&id).await {
        if ssh.transfers().probe_sftp(&id).await {
            return Ok(Value::Null);
        }
        ssh.transfers().unregister_sftp(&id).await;
    }
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    let (sftp, launch_info) = session
        .open_sftp_with_info()
        .await
        .map_err(RpcError::internal)?;
    ssh.transfers()
        .register_sftp(id.clone(), Arc::new(Mutex::new(sftp)))
        .await;
    Ok(json!(launch_info))
}

/// `ui.sftp_home_dir`:SFTP 会话的起始目录(realpath ".")。
pub async fn sftp_home_dir(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    let dir = session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.canonicalize(".").await.map_err(|e| e.to_string()) })
        })
        .await
        .map_err(RpcError::internal)?;
    Ok(json!(dir))
}

/// `ui.sftp_list`:远程目录列举(目录在前、文件在后,字母序)。
pub async fn sftp_list(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let path = required_str(params, "path")?;
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    let read_dir = session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.read_dir(&path).await.map_err(|e| e.to_string()) })
        })
        .await
        .map_err(RpcError::internal)?;
    let mut entries: Vec<SftpEntry> = Vec::new();
    for dir_entry in read_dir {
        let name = dir_entry.file_name();
        let metadata = dir_entry.metadata();
        let full_path = dir_entry.path();
        let is_dir = metadata.is_dir();
        let size = if is_dir {
            0
        } else {
            metadata.size.unwrap_or(0)
        };
        let modified = metadata.mtime.map(|t| (t as u64) * 1000);
        entries.push(SftpEntry {
            name,
            path: full_path,
            is_dir,
            size,
            modified,
            permissions: metadata.permissions.unwrap_or(0),
            uid: metadata.uid,
            gid: metadata.gid,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(json!(entries))
}

/// `ui.sftp_stat`:远程路径元数据。
pub async fn sftp_stat(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let path = required_str(params, "path")?;
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    let meta_path = path.clone();
    let metadata = session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.metadata(&meta_path).await.map_err(|e| e.to_string()) })
        })
        .await
        .map_err(RpcError::internal)?;
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path)
        .to_string();
    Ok(json!(SftpEntry {
        name,
        path: path.clone(),
        is_dir: metadata.is_dir(),
        size: metadata.size.unwrap_or(0),
        modified: metadata.mtime.map(|t| (t as u64) * 1000),
        permissions: metadata.permissions.unwrap_or(0),
        uid: metadata.uid,
        gid: metadata.gid,
    }))
}

/// `ui.sftp_mkdir`:创建远程目录。
pub async fn sftp_mkdir(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let path = required_str(params, "path")?;
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.create_dir(&path).await.map_err(|e| e.to_string()) })
        })
        .await
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.sftp_remove`:删除远程文件或空目录(自动判断)。
pub async fn sftp_remove(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let path = required_str(params, "path")?;
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move {
                let metadata = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
                if metadata.is_dir() {
                    sftp.remove_dir(&path).await.map_err(|e| e.to_string())?;
                } else {
                    sftp.remove_file(&path).await.map_err(|e| e.to_string())?;
                }
                Ok(())
            })
        })
        .await
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

/// `ui.sftp_rename`:重命名/移动远程路径。
pub async fn sftp_rename(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let from = required_str(params, "from")?;
    let to = required_str(params, "to")?;
    let session = session_arc(ssh.manager(), &id).await?;
    let mut session = session.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.rename(&from, &to).await.map_err(|e| e.to_string()) })
        })
        .await
        .map_err(RpcError::internal)?;
    Ok(Value::Null)
}

// ── SFTP 流式传输面 ──────────────────────────────────────────

/// `ui.sftp_start_upload`:启动流式上传,返回 transfer id。
pub async fn sftp_start_upload(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let local_paths = required_str_list(params, "localPaths")?;
    let remote_dir = required_str(params, "remoteDir")?;
    let speed_limit = optional_u64(params, "speedLimit").unwrap_or(0);
    let transfer_id = ssh
        .transfers()
        .upload(&id, local_paths, remote_dir, speed_limit)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    Ok(json!(transfer_id))
}

/// `ui.sftp_start_download`:启动流式下载,返回 transfer id。
pub async fn sftp_start_download(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let remote_paths = required_str_list(params, "remotePaths")?;
    let local_dir = required_str(params, "localDir")?;
    let speed_limit = optional_u64(params, "speedLimit").unwrap_or(0);
    let transfer_id = ssh
        .transfers()
        .download(&id, remote_paths, local_dir, speed_limit)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    Ok(json!(transfer_id))
}

/// `ui.sftp_cancel_transfer`:取消传输(终态)。
pub async fn sftp_cancel_transfer(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let transfer_id = required_str(params, "transferId")?;
    ssh.transfers().cancel(&transfer_id).await;
    Ok(Value::Null)
}

/// `ui.sftp_pause_transfer`:暂停传输(保留断点偏移)。
pub async fn sftp_pause_transfer(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let transfer_id = required_str(params, "transferId")?;
    ssh.transfers().pause(&transfer_id).await;
    Ok(Value::Null)
}

/// `ui.sftp_resume_transfer`:从断点偏移续传。
pub async fn sftp_resume_transfer(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let transfer_id = required_str(params, "transferId")?;
    ssh.transfers()
        .resume(&transfer_id)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    Ok(Value::Null)
}

/// `ui.sftp_retry_transfer`:重试失败/已取消的传输(复用原任务 id)。
pub async fn sftp_retry_transfer(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let transfer_id = required_str(params, "transferId")?;
    let transfer_id = ssh
        .transfers()
        .retry(&transfer_id)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    Ok(json!(transfer_id))
}

/// `ui.sftp_set_speed_limit`:动态修改限速(bytes/sec,0 = 不限)。
pub async fn sftp_set_speed_limit(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let transfer_id = required_str(params, "transferId")?;
    let speed_limit = optional_u64(params, "speedLimit").unwrap_or(0);
    ssh.transfers()
        .set_speed_limit(&transfer_id, speed_limit)
        .await;
    Ok(Value::Null)
}

/// `ui.sftp_clear_transfers`:清除终态任务,返回清除条数。
pub async fn sftp_clear_transfers(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    let transfer_id = params
        .get("transferId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cleared = ssh
        .transfers()
        .clear_terminal(&id, transfer_id.as_deref())
        .await;
    Ok(json!(cleared))
}

/// `ui.sftp_list_transfers`:某会话的全部传输任务。
pub async fn sftp_list_transfers(ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "id")?;
    Ok(json!(ssh.transfers().list_tasks(&id).await))
}

/// `ui.sftp_reveal_local`:在本机文件管理器里显示下载产物。
///
/// sidecar 与桌面端同机运行,直接 spawn 宿主的文件管理器即可。
pub async fn sftp_reveal_local(_ssh: &SshRuntime, params: &Value) -> Result<Value, RpcError> {
    let path = required_str(params, "path")?;
    let target = std::path::PathBuf::from(&path);
    if !target.exists() {
        return Err(RpcError::internal(format!("路径不存在: {path}")));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(path.replace('/', "\\"))
            .spawn()
            .map_err(|error| RpcError::internal(error.to_string()))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|error| RpcError::internal(error.to_string()))?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if target.is_dir() {
            path.clone()
        } else {
            target
                .parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|error| RpcError::internal(error.to_string()))?;
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetStore, MemorySecretStore};
    use starhub_domain_ssh::events::{EventSink, MemoryKnownHostsStore};

    struct NoopSink;

    impl EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    /// 空资产库 + 内存密钥的运行时(不触网)。
    fn runtime_in_temp(label: &str) -> (Arc<SshRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-ssh-{label}-{}", std::process::id()));
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
    async fn session_scoped_methods_report_missing_session_verbatim() {
        let (ssh, dir) = runtime_in_temp("missing-session");
        for result in [
            ssh_resize(&ssh, &json!({ "id": "ghost", "cols": 80, "rows": 24 })).await,
            sftp_list(&ssh, &json!({ "id": "ghost", "path": "/tmp" })).await,
            sftp_stat(&ssh, &json!({ "id": "ghost", "path": "/tmp" })).await,
            sftp_home_dir(&ssh, &json!({ "id": "ghost" })).await,
            sftp_mkdir(&ssh, &json!({ "id": "ghost", "path": "/tmp/x" })).await,
            sftp_remove(&ssh, &json!({ "id": "ghost", "path": "/tmp/x" })).await,
            sftp_rename(&ssh, &json!({ "id": "ghost", "from": "/a", "to": "/b" })).await,
            sftp_ensure_session(&ssh, &json!({ "id": "ghost" })).await,
        ] {
            let error = result.expect_err("会话不存在应是硬错误");
            assert_eq!(error.message, "Session not found");
            assert_eq!(error.code, crate::jsonrpc::error_codes::INTERNAL_ERROR);
        }
        // 断开会话是幂等的(与 Tauri 版一致:不存在也返回 Ok)
        ssh_disconnect(&ssh, &json!({ "id": "ghost" }))
            .await
            .expect("断开未知会话幂等成功");
        // 空会话表
        let sessions = ssh_get_sessions(&ssh, &json!({})).await.expect("list");
        assert_eq!(sessions, json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn parameter_validation_uses_the_shared_wording() {
        let (ssh, dir) = runtime_in_temp("validate");
        let error = ssh_write(&ssh, &json!({ "data": "x" }))
            .await
            .expect_err("缺 id");
        assert!(error.message.contains("缺少 id"), "{}", error.message);
        let error = ssh_write_binary(&ssh, &json!({ "id": "s1", "data": [300] }))
            .await
            .expect_err("字节越界");
        assert!(
            error.message.contains("data 必须是字节数组"),
            "{}",
            error.message
        );
        let error = ssh_resize(&ssh, &json!({ "id": "s1", "cols": 80 }))
            .await
            .expect_err("缺 rows");
        assert!(error.message.contains("缺少 rows"), "{}", error.message);
        let error = sftp_start_upload(&ssh, &json!({ "id": "s1", "remoteDir": "/tmp" }))
            .await
            .expect_err("缺 localPaths");
        assert!(
            error.message.contains("缺少 localPaths"),
            "{}",
            error.message
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn write_paths_are_noops_without_a_live_channel() {
        // 与 Tauri 版一致:会话存在但没有写通道时,写操作静默成功(Ok),
        // 由事件流(ssh:close)告知前端会话已断开。
        let (ssh, dir) = runtime_in_temp("no-channel");
        ssh_write(&ssh, &json!({ "id": "s1", "data": "ls\n" }))
            .await
            .expect("无写通道时静默成功");
        ssh_write_binary(&ssh, &json!({ "id": "s1", "data": [1, 2, 3] }))
            .await
            .expect("无写通道时静默成功");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pending_response_channels_report_missing_prompts() {
        let (ssh, dir) = runtime_in_temp("pending");
        let error = ssh_kb_response(&ssh, &json!({ "id": "s1", "responses": ["123456"] }))
            .await
            .expect_err("无待应答");
        assert_eq!(error.message, "No pending kb prompt for session s1");
        let error = ssh_hostkey_response(
            &ssh,
            &json!({ "id": "s1", "allowed": true, "persist": false }),
        )
        .await
        .expect_err("无待应答");
        assert_eq!(error.message, "No pending hostkey prompt for session s1");
        let error = ssh_bastion_response(&ssh, &json!({ "id": "s1", "selection": "" }))
            .await
            .expect_err("无待应答");
        assert_eq!(error.message, "No pending bastion prompt for session s1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn transfer_task_queries_work_without_any_task() {
        let (ssh, dir) = runtime_in_temp("transfers");
        // 未注册的会话:列举为空、清除为 0、未知 transfer 的操作幂等
        let tasks = sftp_list_transfers(&ssh, &json!({ "id": "s1" }))
            .await
            .expect("list");
        assert_eq!(tasks, json!([]));
        let cleared = sftp_clear_transfers(&ssh, &json!({ "id": "s1" }))
            .await
            .expect("clear");
        assert_eq!(cleared, json!(0));
        sftp_pause_transfer(&ssh, &json!({ "id": "s1", "transferId": "t1" }))
            .await
            .expect("暂停未知任务幂等");
        sftp_cancel_transfer(&ssh, &json!({ "id": "s1", "transferId": "t1" }))
            .await
            .expect("取消未知任务幂等");
        sftp_set_speed_limit(
            &ssh,
            &json!({ "id": "s1", "transferId": "t1", "speedLimit": 1024 }),
        )
        .await
        .expect("限速未知任务幂等");
        let error = sftp_resume_transfer(&ssh, &json!({ "id": "s1", "transferId": "t1" }))
            .await
            .expect_err("恢复未知任务是硬错误");
        assert!(!error.message.is_empty(), "{}", error.message);
        let error = sftp_retry_transfer(&ssh, &json!({ "id": "s1", "transferId": "t1" }))
            .await
            .expect_err("重试未知任务是硬错误");
        assert!(!error.message.is_empty(), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reveal_local_rejects_missing_paths() {
        let (ssh, dir) = runtime_in_temp("reveal");
        let error = sftp_reveal_local(
            &ssh,
            &json!({ "path": dir.join("nope.txt").to_string_lossy() }),
        )
        .await
        .expect_err("路径不存在");
        assert!(error.message.starts_with("路径不存在"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn web_window_is_degraded_until_the_panel_lands() {
        let error = ssh_open_web_window(&json!({ "sessionId": "s1", "assetName": "x" }))
            .expect_err("窗口类动作 M2 显式降级");
        assert!(error.message.contains("M3"), "{}", error.message);
        let error = ssh_open_web_window(&json!({ "sessionId": "s1" }))
            .expect_err("缺 assetName 先报参数错误");
        assert!(
            error.message.contains("缺少 assetName"),
            "{}",
            error.message
        );
    }

    #[tokio::test]
    async fn test_connection_reports_the_failure_shape() {
        let (ssh, dir) = runtime_in_temp("test-conn");
        // 直连一个必不通的地址:ok=false + 后端原文(不发 elapsed_ms)
        let result = test_ssh_connection(
            &ssh,
            &json!({
                "config": { "host": "127.0.0.1", "port": 1, "username": "root", "auth": { "Password": "" } },
                "testSessionId": "test-1",
            }),
        )
        .await
        .expect("测试连接失败也是 Ok(形状由 ok 字段表达)");
        assert_eq!(result["ok"], false);
        assert!(result["elapsed_ms"].is_null(), "{result}");
        assert!(
            result["message"].as_str().is_some_and(|m| !m.is_empty()),
            "{result}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
