use crate::harness::HarnessManager;
use crate::registry::{DetachOutcome, SessionRegistry};
use crate::sftp::transfer::TransferManager;
use crate::ssh::session::SshSession;
use crate::ssh::{
    KeyboardInteractiveConfig, PendingBastionResponses, PendingHostKeyResponses,
    PendingKeyboardResponses, SftpLaunchMode, SshAuth, SshConfig, SshSessionInfo, SshWriteChannels,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

const MAX_PRIVATE_KEY_FILE_SIZE: u64 = 2 * 1024 * 1024;

fn looks_like_supported_private_key(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("PuTTY-User-Key-File-")
        || [
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN EC PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        ]
        .iter()
        .any(|header| text.starts_with(header))
}

/// Sanitize private key content: strip UTF-8 BOM and normalize CRLF to LF.
/// Fixes keys saved by Windows Notepad / editors that use CRLF line endings.
fn sanitize_key(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn decode_private_key_file(bytes: &[u8]) -> Result<String, String> {
    let text = if let Some(content) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8(content.to_vec())
            .map_err(|_| "[KEY_FILE_ENCODING] Private key is not valid UTF-8".to_string())?
    } else if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if content.len() % 2 != 0 {
            return Err("[KEY_FILE_ENCODING] Invalid UTF-16 LE private key".to_string());
        }
        let units = content
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units)
            .map_err(|_| "[KEY_FILE_ENCODING] Invalid UTF-16 LE private key".to_string())?
    } else if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        if content.len() % 2 != 0 {
            return Err("[KEY_FILE_ENCODING] Invalid UTF-16 BE private key".to_string());
        }
        let units = content
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units)
            .map_err(|_| "[KEY_FILE_ENCODING] Invalid UTF-16 BE private key".to_string())?
    } else {
        String::from_utf8(bytes.to_vec())
            .map_err(|_| "[KEY_FILE_ENCODING] Private key is not valid UTF-8".to_string())?
    };

    if !looks_like_supported_private_key(&text) {
        return Err(
            "[KEY_FILE_FORMAT] Selected file is not a supported SSH private key".to_string(),
        );
    }
    Ok(sanitize_key(&text))
}

pub struct SshManager {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SshSession>>>>>,
    channels: SshWriteChannels,
    pub pending_kb: PendingKeyboardResponses,
    pub pending_hostkey: PendingHostKeyResponses,
    /// 堡垒机 AI exec 的「选择机器」待应答通道(session_id → 用户选择的机器)。
    /// 方案A(v0.95.6):AI exec 走带 pty 的 shell 时,先由用户在这里选机器。
    pub pending_bastion: PendingBastionResponses,
    attempts: Arc<Mutex<HashMap<String, u64>>>,
    /// 在途 exec 命令的中断句柄:exec_id → 发送端。
    /// 放在 manager 层而不是 SshSession 里:exec 期间 session 锁被持有,
    /// `ssh_exec_abort` 只需要拿这把独立的 map 锁就能中断,不会死锁。
    exec_aborts: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            pending_kb: Arc::new(Mutex::new(HashMap::new())),
            pending_hostkey: Arc::new(Mutex::new(HashMap::new())),
            pending_bastion: Arc::new(Mutex::new(HashMap::new())),
            attempts: Arc::new(Mutex::new(HashMap::new())),
            exec_aborts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn begin_attempt(&self, id: &str) -> u64 {
        let mut attempts = self.attempts.lock().await;
        let next = attempts
            .get(id)
            .copied()
            .unwrap_or_default()
            .wrapping_add(1)
            .max(1);
        attempts.insert(id.to_string(), next);
        next
    }

    async fn invalidate_attempt(&self, id: &str) -> u64 {
        self.begin_attempt(id).await
    }

    async fn is_current_attempt(&self, id: &str, generation: u64) -> bool {
        self.attempts.lock().await.get(id).copied() == Some(generation)
    }

    async fn remove_channel_for_attempt(&self, id: &str, generation: u64) {
        let mut channels = self.channels.lock().await;
        if channels
            .get(id)
            .is_some_and(|(current, _)| *current == generation)
        {
            channels.remove(id);
        }
    }
}

#[tauri::command]
pub async fn ssh_get_trusted_host_key(host: String, port: u16) -> Result<Option<String>, String> {
    crate::ssh::known_hosts::get_trusted_public_key(&host, port).await
}

/// 读取用户通过原生文件对话框选择的 SSH 私钥。
///
/// 限制文件大小和格式，避免把通用任意文件读取能力暴露给连接表单。
#[tauri::command]
pub async fn read_ssh_private_key_file(path: String) -> Result<String, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("[KEY_FILE_READ] Failed to inspect private key: {error}"))?;
    if !metadata.is_file() {
        return Err("[KEY_FILE_READ] Selected path is not a file".to_string());
    }
    if metadata.len() > MAX_PRIVATE_KEY_FILE_SIZE {
        return Err("[KEY_FILE_SIZE] Private key file exceeds 2MB".to_string());
    }

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("[KEY_FILE_READ] Failed to read private key: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PRIVATE_KEY_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("[KEY_FILE_READ] Failed to read private key: {error}"))?;
    if bytes.len() as u64 > MAX_PRIVATE_KEY_FILE_SIZE {
        return Err("[KEY_FILE_SIZE] Private key file exceeds 2MB".to_string());
    }
    decode_private_key_file(&bytes)
}

#[tauri::command]
pub async fn ssh_connect(
    manager: State<'_, SshManager>,
    transfer_manager: State<'_, TransferManager>,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
) -> Result<SshSessionInfo, String> {
    connect_session(&manager, &transfer_manager, id, config, app_handle, true).await
}

/// 为 AI / 仪表盘的一次性命令建立无 PTY 的 SSH 会话。
///
/// 与交互终端分开，避免无用的远端登录 shell、启动脚本和后台任务占用服务器资源。
#[tauri::command]
pub async fn ssh_connect_exec(
    manager: State<'_, SshManager>,
    transfer_manager: State<'_, TransferManager>,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
) -> Result<SshSessionInfo, String> {
    connect_session(&manager, &transfer_manager, id, config, app_handle, false).await
}

/// 建立 SSH 会话(interactive=true 开 PTY shell,false 为一次性 exec 通道)。
/// pub(crate):harness/domain.rs 进程内域工具执行器复用。
pub(crate) async fn connect_session(
    manager: &SshManager,
    transfer_manager: &TransferManager,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
    interactive: bool,
) -> Result<SshSessionInfo, String> {
    let started_at = std::time::Instant::now();
    // 每次显式连接都有独立代次。失败后的 disconnect 只会让旧代次失效，
    // 不会像永久 abandoned 标记那样污染同一 tab/窗口里的下一次重试。
    let attempt_generation = manager.begin_attempt(&id).await;

    // 网络 I/O 在锁外执行 — 否则 connect() 期间持有 sessions 锁会阻塞
    // 所有其他 SSH 操作(resize / disconnect / 新 connect),导致第二个 tab
    // 永远卡在 "Connecting to"。
    let mut session = SshSession::new(config.clone());
    session
        .connect(
            &id,
            Some(&app_handle),
            &manager.pending_kb,
            &manager.pending_hostkey,
        )
        .await?;
    let auth_elapsed = started_at.elapsed();

    if !manager.is_current_attempt(&id, attempt_generation).await {
        session.disconnect();
        return Err("Connection aborted by client".to_string());
    }
    if interactive {
        if let Err(error) = session
            .open_shell(
                &id,
                attempt_generation,
                app_handle.clone(),
                manager.channels.clone(),
            )
            .await
        {
            session.disconnect();
            return Err(error);
        }
    }

    tracing::info!(
        session_id = %id,
        host = %config.host,
        port = config.port,
        interactive,
        auth_ms = auth_elapsed.as_millis(),
        total_ms = started_at.elapsed().as_millis(),
        "SSH session connected"
    );

    let info = SshSessionInfo {
        id: id.clone(),
        host: config.host,
        port: config.port,
        username: config.username,
        connected: true,
    };

    // 覆盖同 id 的旧会话前,先注销 TransferManager 里挂在其上的 SFTP 通道。
    // 否则自动重连后 sftp_ensure_session 的 has_session 短路会直接复用旧(已死)通道,
    // 之后所有上传/下载都在死句柄上失败。注销后下一次 ensure 会在新会话上重建通道。
    // 放在取 attempts/sessions 锁之前,避免引入新的锁顺序。
    transfer_manager.unregister_sftp(&id).await;

    // 只在插入 map 时短暂持锁。锁顺序固定为 attempts -> sessions:
    // 先取 attempts 锁(校验代次),再取 sessions 锁插入,
    // 避免持 sessions 锁时 await attempts 锁的锁内 await 反模式,
    // 同时关闭 disconnect / 新 connect 与当前尝试完成之间的竞态窗口。
    let attempts = manager.attempts.lock().await;
    let mut sessions = manager.sessions.lock().await;
    if attempts.get(&id).copied() != Some(attempt_generation) {
        drop(sessions);
        drop(attempts);
        manager
            .remove_channel_for_attempt(&id, attempt_generation)
            .await;
        session.disconnect();
        return Err("Connection aborted by client".to_string());
    }
    // 目标机认证完成后:若本次连接实际走了 keyboard-interactive(MFA),向对应
    // 弹窗发精确的「目标机已连接」信号,让 MFA 弹窗等用户在确认连接成功后复用该
    // 会话。注意:仅认证链(含跳板机/堡垒机选机器后的目标机)全部完成才算成功,
    // 跳板机本身的 MFA 不算「连接成功」。发射前先取 mfa_used,再把 session 移入 Arc。
    let mfa_used = session.mfa_used();
    sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
    if mfa_used {
        use tauri::Emitter;
        let _ = app_handle.emit(&format!("ssh:mfa-connected:{id}"), id.clone());
    }

    Ok(info)
}
// ── 联动 M1(docs/联动实施-桥接契约-2026-08-17.md §4):ssh_attach / ssh_detach ──
// 附着语义:SessionRegistry 维护 assetId → sessionId 视图(refcount + attachedBy);
// 有活 session 复用(refcount+1),否则按资产存档建连;detach 归零才真断。
// 每次变更后向 dsh 补发 `starhub/registry.sync` 全量快照(无 runtime 静默跳过)。

/// `ssh_attach` 的返回形状(契约 §4):`{ sessionId, reused }`。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAttachResult {
    pub session_id: String,
    pub reused: bool,
}

/// 向 dsh 补发注册表全量快照(契约 §2.1);无活跃 runtime 时 HarnessManager::notify
/// 静默跳过(记日志),不报错。快照同时以 SshManager 存活表剔除断线条目。
async fn notify_registry_sync(harness: &HarnessManager, registry: &SessionRegistry, ssh: &SshManager) {
    let live_ids: std::collections::HashSet<String> = {
        let sessions = ssh.sessions.lock().await;
        sessions.keys().cloned().collect()
    };
    let (snapshot, _pruned) = registry.snapshot(&live_ids);
    harness
        .notify(
            crate::harness::REGISTRY_SYNC_METHOD,
            serde_json::json!({ "sessions": snapshot }),
        )
        .await;
}

/// 按资产存档组装 SSH 连接配置(与前端 src/services/ssh.ts assetConfigToSshConfig
/// 语义对齐;密码/私钥等敏感字段从 Keyring 合并,绝不落日志)。
/// 返回 (资产名, 配置);资产不存在 / 类型不是 ssh / 配置不完整时报错。
/// pub(crate):harness/domain.rs 进程内域工具执行器复用。
pub(crate) async fn asset_ssh_config(asset_id: &str) -> Result<(String, SshConfig), String> {
    let pool = crate::db::get_pool()?;
    let row = sqlx::query("SELECT type, name, config_json, key_id FROM assets WHERE id = ?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取资产失败: {e}"))?
        .ok_or_else(|| format!("资产不存在: {asset_id}"))?;
    use sqlx::Row;
    let asset_type: String = row.try_get("type").map_err(|e| e.to_string())?;
    if asset_type != "ssh" {
        return Err(format!(
            "资产 {asset_id} 类型不是 ssh(实际是 {asset_type}):SSH 域工具(ssh_exec 等)需要绑定 SSH 资产。\
             当前会话绑定的不是 SSH 资产,请重新 @ 绑定 SSH 资产,或调用 bind_asset_context 切换后重试"
        ));
    }
    let name: String = row.try_get("name").map_err(|e| e.to_string())?;
    let config_json: String = row.try_get("config_json").map_err(|e| e.to_string())?;
    let key_id: Option<String> = row.try_get("key_id").map_err(|e| e.to_string())?;
    let mut config: Value = serde_json::from_str(&config_json)
        .unwrap_or_else(|_| Value::Object(Default::default()));
    if let Some(key_id) = key_id {
        let secrets = crate::keyring::load(key_id).await?;
        config = crate::keyring::merge_config(config, secrets);
    }

    let get = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
    let get_bool = |key: &str, default: bool| {
        config.get(key).and_then(Value::as_bool).unwrap_or(default)
    };
    let port = config
        .get("port")
        .and_then(Value::as_u64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let username = get("username");
    if get("host").is_empty() || username.is_empty() {
        return Err(format!("SSH 资产「{name}」配置不完整(缺 host 或 username)"));
    }

    let use_password = get_bool("usePasswordAuth", true);
    let use_key = get_bool("useKeyAuth", false);
    let password = get("password");
    let private_key = get("privateKey");
    let passphrase = {
        let value = get("passphrase");
        (!value.is_empty()).then(|| value.to_string())
    };
    let auth = if use_password && use_key && !password.is_empty() && !private_key.is_empty() {
        SshAuth::PasswordAndKey {
            password: password.to_string(),
            key: private_key.to_string(),
            passphrase,
        }
    } else if use_password && !password.is_empty() {
        SshAuth::Password(password.to_string())
    } else if use_key && !private_key.is_empty() {
        SshAuth::PrivateKey {
            key: private_key.to_string(),
            passphrase,
        }
    } else {
        SshAuth::Password(String::new())
    };

    let kb_interactive = if get_bool("mfaEnabled", false) {
        let mfa_password = get("mfaPassword");
        Some(KeyboardInteractiveConfig {
            enabled: true,
            password: (!mfa_password.is_empty()).then(|| mfa_password.to_string()),
        })
    } else {
        None
    };

    let jump_host = get("jumpHost");
    let jump_auth = if jump_host.is_empty() {
        None
    } else {
        let jump_password = get("jumpPassword");
        let jump_private_key = get("jumpPrivateKey");
        let jump_passphrase = {
            let value = get("jumpPassphrase");
            (!value.is_empty()).then(|| value.to_string())
        };
        Some(if !jump_private_key.is_empty() {
            SshAuth::PrivateKey {
                key: jump_private_key.to_string(),
                passphrase: jump_passphrase,
            }
        } else if !jump_password.is_empty() {
            SshAuth::Password(jump_password.to_string())
        } else {
            auth.clone()
        })
    };

    let sftp_launch_mode = match get("sftpLaunchMode") {
        "subsystem" => SftpLaunchMode::Subsystem,
        "custom" => SftpLaunchMode::Custom,
        _ => SftpLaunchMode::Auto,
    };

    Ok((
        name,
        SshConfig {
            host: get("host").to_string(),
            port,
            username: username.to_string(),
            auth,
            pty_cols: None,
            pty_rows: None,
            sftp_timeout_sec: config
                .get("sftpTimeoutSec")
                .and_then(Value::as_u64)
                .unwrap_or(crate::ssh::DEFAULT_SFTP_TIMEOUT_SEC),
            sftp_launch_mode,
            sftp_server_path: {
                let value = get("sftpServerPath");
                (!value.is_empty()).then(|| value.to_string())
            },
            kb_interactive,
            jump_host: (!jump_host.is_empty()).then(|| jump_host.to_string()),
            jump_port: config
                .get("jumpPort")
                .and_then(Value::as_u64)
                .map(|p| p as u16)
                .or(Some(22)),
            jump_username: {
                let value = get("jumpUsername");
                if value.is_empty() {
                    Some(username.to_string())
                } else {
                    Some(value.to_string())
                }
            },
            jump_auth,
        },
    ))
}

/// M1 附着(契约 §4):按 assetId 复用或建立一条共享 SSH 会话。
/// 有活 session(注册表已有且 SshManager 存活)则 refcount+1 返回 `{reused: true}`;
/// 否则按资产存档建连(无 PTY,一次性命令通道),附着后返回 `{reused: false}`。
/// 注册表变更后向 dsh 补发 `starhub/registry.sync`。
#[tauri::command]
pub async fn ssh_attach(
    manager: State<'_, SshManager>,
    transfer_manager: State<'_, TransferManager>,
    registry: State<'_, SessionRegistry>,
    harness: State<'_, HarnessManager>,
    app_handle: tauri::AppHandle,
    asset_id: String,
) -> Result<SshAttachResult, String> {
    // 复用路径:注册表已有该资产的 session 且 SshManager 中仍存活
    if let Some(session_id) = registry.session_for_asset(&asset_id) {
        let live = manager.sessions.lock().await.contains_key(&session_id);
        if live {
            registry.attach(&asset_id, &session_id, "ssh", "frontend");
            notify_registry_sync(&harness, &registry, &manager).await;
            return Ok(SshAttachResult {
                session_id,
                reused: true,
            });
        }
    }

    // 建连路径:按资产存档连接,会话 id 固定为该资产 id(多方共享,registry 反查用)
    let (_asset_name, config) = asset_ssh_config(&asset_id).await?;
    let session_id = asset_id.clone();
    connect_session(
        &manager,
        &transfer_manager,
        session_id.clone(),
        config,
        app_handle,
        false,
    )
    .await?;
    registry.attach(&asset_id, &session_id, "ssh", "frontend");
    notify_registry_sync(&harness, &registry, &manager).await;
    Ok(SshAttachResult {
        session_id,
        reused: false,
    })
}

/// M1 解除附着(契约 §4):refcount-1;归零才真正断开 session。
/// 注册表变更后向 dsh 补发 `starhub/registry.sync`;未跟踪的 sessionId 幂等成功。
#[tauri::command]
pub async fn ssh_detach(
    manager: State<'_, SshManager>,
    transfer_manager: State<'_, TransferManager>,
    registry: State<'_, SessionRegistry>,
    harness: State<'_, HarnessManager>,
    session_id: String,
) -> Result<(), String> {
    match registry.detach(&session_id, "frontend") {
        DetachOutcome::Removed { .. } => {
            // 归零:与 ssh_disconnect 相同的清理路径(SFTP 通道先注销,再断 session)
            transfer_manager.unregister_sftp(&session_id).await;
            let session_arc = {
                let mut sessions = manager.sessions.lock().await;
                sessions.remove(&session_id)
            };
            if let Some(session) = session_arc {
                let mut session = session.lock().await;
                session.disconnect();
            }
            let invalidated = manager.invalidate_attempt(&session_id).await;
            manager
                .remove_channel_for_attempt(&session_id, invalidated.wrapping_sub(1))
                .await;
            notify_registry_sync(&harness, &registry, &manager).await;
        }
        DetachOutcome::StillAttached { .. } => {
            notify_registry_sync(&harness, &registry, &manager).await;
        }
        DetachOutcome::NotTracked => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    manager: State<'_, SshManager>,
    transfer_manager: State<'_, TransferManager>,
    registry: State<'_, SessionRegistry>,
    harness: State<'_, HarnessManager>,
    id: String,
) -> Result<(), String> {
    // SFTP 通道由 TransferManager 单独持有；先移除，避免关闭 SSH 后仍残留失效句柄。
    transfer_manager.unregister_sftp(&id).await;
    // 先从 map 中移除(短暂持锁),再对单个 session 加锁断开,
    // 避免 disconnect 期间阻塞其他 session 的操作。
    let session_arc = {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&id)
    };
    if let Some(session) = session_arc {
        let mut session = session.lock().await;
        session.disconnect();
    }

    // 无论 session 是否已经注册，都让正在进行的连接代次失效。
    let invalidated_generation = manager.invalidate_attempt(&id).await;

    // 只移除本次 disconnect 取消的旧写通道；如果新的 connect 已经开始，
    // 它拥有更高代次，不能被较晚完成的旧清理误删。
    manager
        .remove_channel_for_attempt(&id, invalidated_generation.wrapping_sub(1))
        .await;

    // 联动 M1(契约 §2.1「断线」):断开的是受跟踪会话时,注册表条目一并移除,
    // 并向 dsh 补发 registry.sync 全量快照(无 runtime 静默跳过)。
    if registry.remove_session(&id).is_some() {
        notify_registry_sync(&harness, &registry, &manager).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    manager: State<'_, SshManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    // 克隆 sender 后立即释放 channels 锁再 await send(背压),
    // 避免慢网络下写满缓冲时持锁阻塞 disconnect / 其他操作。
    let tx = {
        let channels = manager.channels.lock().await;
        channels.get(&id).map(|(_, tx)| tx.clone())
    };

    if let Some(tx) = tx {
        tx.send(data.into_bytes())
            .await
            .map_err(|_| "Failed to send data to channel".to_string())?;
    }

    Ok(())
}

/// 向交互式 SSH channel 写入原始字节。
///
/// ZMODEM(rz/sz)是二进制协议,不能经过 UTF-8 String 转换,否则高位字节
/// 会被替换而导致握手或文件内容损坏。
#[tauri::command]
pub async fn ssh_write_binary(
    manager: State<'_, SshManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // 与 ssh_write 同理:锁外 await send,形成背压。
    let tx = {
        let channels = manager.channels.lock().await;
        channels.get(&id).map(|(_, tx)| tx.clone())
    };

    if let Some(tx) = tx {
        tx.send(data)
            .await
            .map_err(|_| "Failed to send binary data to channel".to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    manager: State<'_, SshManager>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    // 先从 map 中取出 Arc(只持有主锁一瞬间),然后释放主锁,
    // 再对单个 session 加锁。这样不同 session 的 resize 不会互相阻塞,
    // 也不会被 connect 阻塞。
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions.get(&id).cloned()
    };
    if let Some(session) = session_arc {
        let session = session.lock().await;
        session.resize(cols, rows).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_get_sessions(
    manager: State<'_, SshManager>,
) -> Result<Vec<SshSessionInfo>, String> {
    // 先拷贝 (id, Arc) 快照再释放主锁,然后逐个会话加锁读配置,
    // 避免持 sessions 主锁时 await 单会话锁的锁内 await 反模式。
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
    Ok(infos)
}

/// 测试 SSH 连接:不写入 SshManager,connect 完立即 disconnect,仅返回成功/失败
#[tauri::command]
pub async fn test_ssh_connection(
    manager: State<'_, SshManager>,
    config: SshConfig,
    test_session_id: String,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use std::time::Duration;
    let mut session = SshSession::new(config.clone());
    let start = std::time::Instant::now();

    let result = session
        .connect(
            &test_session_id,
            Some(&app_handle),
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

    if let Err(e) = result {
        return Ok(serde_json::json!({
            "ok": false,
            "message": e,
        }));
    }
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // 主动断开
    session.disconnect();
    // 给一点时间让 disconnect 走完(它是 spawn 出去的)
    tokio::time::sleep(Duration::from_millis(50)).await;

    Ok(serde_json::json!({
        "ok": true,
        "message": format!("OK in {}ms ({}@{}:{})", elapsed_ms, config.username, config.host, config.port),
        "elapsed_ms": elapsed_ms,
    }))
}

/// 在已有 SSH 会话上跑一条命令,返回 stdout。
/// 给仪表盘 / 一次性数据采集用(系统指标、配置查询等)。
///
/// - `id` SshManager 中的 session id(由前端用 `assetId-<instanceId>` 形式)
/// - `command` 要执行的 shell 命令
/// - `timeout_sec` 超时秒数,默认 10,内部强制 >=1
/// - `exec_id` 可选的执行 ID(前端生成);传入后可用 `ssh_exec_abort` 中断本次执行
#[tauri::command]
pub async fn ssh_exec(
    app: tauri::AppHandle,
    manager: State<'_, SshManager>,
    id: String,
    command: String,
    timeout_sec: Option<u64>,
    exec_id: Option<String>,
) -> Result<String, String> {
    ssh_exec_core(&manager, &app, &id, &command, timeout_sec, exec_id.as_deref(), false).await
}

/// ssh_exec 的进程内核心(harness/domain.rs 复用;State 解引用为 &SshManager)。
/// `bastion_interactive` = true 时(AI 域工具路径):资产启用 kb_interactive
/// MFA(堡垒机,含直连堡垒机与跳板机两种形态)时改走带 pty 的 shell,
/// 先由用户选机器再执行命令。
pub(crate) async fn ssh_exec_core(
    manager: &SshManager,
    app_handle: &tauri::AppHandle,
    id: &str,
    command: &str,
    timeout_sec: Option<u64>,
    exec_id: Option<&str>,
    bastion_interactive: bool,
) -> Result<String, String> {
    // 执行主体包一层:成功后统一广播执行结果(主壳迷你面板展示最近一次
    // 命令输出,普通 SSH 资产与堡垒机首次/复用路径全覆盖)。
    let result = async {
        // 先从 sessions map 中取出 Arc(只持有主锁一瞬间),然后释放主锁,
        // 再对单个 session 加锁执行命令。这样不同 session 的 exec 和 connect
        // 不会互相阻塞。
        let session_arc = {
            let sessions = manager.sessions.lock().await;
            sessions
                .get(id)
                .cloned()
                .ok_or_else(|| format!("SSH session {} not found", id))?
        };

        let mut session = session_arc.lock().await;
        // 堡垒机 pty 路径:启用 kb_interactive MFA(直连堡垒机或跳板机)时,普通
        // exec 通道被服务端拒绝(Channel send error),需先经 pty 让用户选机器。
        // 仅 AI 域工具路径启用。
        if bastion_interactive && session.is_bastion() {
            return session
                .exec_via_bastion_pty(
                    id,
                    Some(app_handle),
                    &manager.pending_bastion,
                    manager.channels.clone(),
                    command,
                    timeout_sec.unwrap_or(10),
                )
                .await;
        }
        match exec_id {
            Some(eid) => {
                let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
                manager
                    .exec_aborts
                    .lock()
                    .await
                    .insert(eid.to_string(), abort_tx);
                let result = session
                    .exec_abortable(command, timeout_sec.unwrap_or(10), abort_rx)
                    .await;
                // 无论结果如何都清理注册,避免 map 泄漏
                manager.exec_aborts.lock().await.remove(eid);
                result
            }
            None => session.exec(command, timeout_sec.unwrap_or(10)).await,
        }
    }
    .await;

    if let Ok(output) = &result {
        use tauri::Emitter;
        let _ = app_handle.emit("ssh:exec-done", serde_json::json!({
            "sessionId": id,
            "command": command,
            "output": output.chars().take(4000).collect::<String>(),
        }));
    }
    result
}

/// 中断一个仍在执行的 exec 命令(通过 `ssh_exec` 传入的 `exec_id` 定位)。
/// 关闭对应 channel,使 `ssh_exec` 以 `[EXEC_ABORTED]` 错误返回已收到的部分输出。
/// 返回是否确实中断了在途命令。
#[tauri::command]
pub async fn ssh_exec_abort(
    manager: State<'_, SshManager>,
    id: String,
    exec_id: String,
) -> Result<bool, String> {
    ssh_exec_abort_core(&manager, &id, &exec_id).await
}

/// ssh_exec_abort 的进程内核心(harness/domain.rs 复用;停止生成时中断在途命令)。
pub(crate) async fn ssh_exec_abort_core(
    manager: &SshManager,
    id: &str,
    exec_id: &str,
) -> Result<bool, String> {
    // exec_id 由前端按 session 生成且全局唯一(uuid),这里只做防御性的存在性校验
    {
        let sessions = manager.sessions.lock().await;
        if !sessions.contains_key(id) {
            return Err(format!("SSH session {} not found", id));
        }
    }
    let tx = manager.exec_aborts.lock().await.remove(exec_id);
    match tx {
        // 发送失败说明接收端(exec)已结束并清理,视为未中断
        Some(tx) => Ok(tx.send(()).is_ok()),
        None => Ok(false),
    }
}

/// 前端回复 keyboard-interactive 响应
#[tauri::command]
pub async fn ssh_kb_response(
    manager: State<'_, SshManager>,
    id: String,
    responses: Vec<String>,
) -> Result<(), String> {
    let sender = {
        let mut map = manager.pending_kb.lock().await;
        map.remove(&id)
            .ok_or_else(|| format!("No pending kb prompt for session {}", id))?
    };
    sender
        .send(responses)
        .map_err(|_| "Failed to send kb response (handler dropped)".to_string())
}

/// 触发堡垒机 AI exec 在「实时终端」里执行 AI 命令。
///
/// v0.98.7 起堡垒机选机器改为「原汁原味实时终端」:底层 pty 输出持续流式广播到
/// 前端内嵌 xterm,用户在终端里敲序号选机器;本命令即前端点击「执行 AI 命令」后
/// 回传的 run 信号,由 pending 通道恢复 `exec_via_bastion_pty` 的阶段2(写命令)。
///
/// 传空字符串表示用户放弃(取消),后端按取消处理;传任意非空串表示继续执行。
#[tauri::command]
pub async fn ssh_bastion_response(
    manager: State<'_, SshManager>,
    id: String,
    selection: String,
) -> Result<(), String> {
    let sender = {
        let mut map = manager.pending_bastion.lock().await;
        map.remove(&id)
            .ok_or_else(|| format!("No pending bastion prompt for session {}", id))?
    };
    sender
        .send(selection)
        .map_err(|_| "Failed to send bastion response (handler dropped)".to_string())
}

#[tauri::command]
pub async fn ssh_hostkey_response(
    manager: State<'_, SshManager>,
    id: String,
    allowed: bool,
    persist: bool,
) -> Result<(), String> {
    let sender = {
        let mut map = manager.pending_hostkey.lock().await;
        map.remove(&id)
            .ok_or_else(|| format!("No pending hostkey prompt for session {}", id))?
    };
    sender
        .send((allowed, persist))
        .map_err(|_| "Failed to send hostkey response (handler dropped)".to_string())
}

/// 添加本地端口转发
#[tauri::command]
pub async fn ssh_add_local_forward(
    manager: State<'_, SshManager>,
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<u16, String> {
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("SSH session {} not found", id))?
    };
    let mut session = session_arc.lock().await;
    session
        .add_local_port_forward(local_port, &remote_host, remote_port)
        .await
}

/// 添加 Web 代理转发(改写 HTTP Host 头,修复经 127.0.0.1 访问虚拟主机站点 404)
#[tauri::command]
pub async fn ssh_add_web_proxy_forward(
    manager: State<'_, SshManager>,
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<u16, String> {
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("SSH session {} not found", id))?
    };
    let mut session = session_arc.lock().await;
    session
        .add_web_proxy_forward(local_port, &remote_host, remote_port)
        .await
}

/// 添加远程端口转发
#[tauri::command]
pub async fn ssh_add_remote_forward(
    manager: State<'_, SshManager>,
    id: String,
    remote_port: u16,
    local_host: String,
    local_port: u16,
) -> Result<u16, String> {
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("SSH session {} not found", id))?
    };
    let mut session = session_arc.lock().await;
    session
        .add_remote_port_forward(remote_port, &local_host, local_port)
        .await
}

/// 移除端口转发
#[tauri::command]
pub async fn ssh_remove_forward(
    manager: State<'_, SshManager>,
    id: String,
    bound_port: u16,
    is_remote: bool,
) -> Result<(), String> {
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("SSH session {} not found", id))?
    };
    let mut session = session_arc.lock().await;
    session.remove_port_forward(bound_port, is_remote).await
}

/// 列出端口转发
#[tauri::command]
pub async fn ssh_list_forwards(
    manager: State<'_, SshManager>,
    id: String,
) -> Result<Vec<crate::ssh::PortForwardInfo>, String> {
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("SSH session {} not found", id))?
    };
    let session = session_arc.lock().await;
    Ok(session.list_port_forwards())
}

/// SSH Config 主机条目
#[derive(Debug, serde::Serialize)]
pub struct SshConfigHost {
    pub name: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

/// 解析 SSH config 文件,返回主机列表
#[tauri::command]
pub async fn ssh_parse_config_file(
    config_path: Option<String>,
) -> Result<Vec<SshConfigHost>, String> {
    use std::path::PathBuf;

    let path = match config_path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            let home = home_dir()?;
            home.join(".ssh").join("config")
        }
    };

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read SSH config {}: {}", path.display(), e))?;

    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut current: Option<SshConfigHost> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (key, value) = match line.split_once(char::is_whitespace) {
            Some((k, v)) => (k.trim().to_lowercase(), v.trim()),
            None => continue,
        };

        if key == "host" {
            if let Some(h) = current.take() {
                hosts.push(h);
            }
            current = Some(SshConfigHost {
                name: value.to_string(),
                host: None,
                port: None,
                user: None,
                identity_file: None,
                proxy_jump: None,
            });
        } else if let Some(ref mut h) = current {
            match key.as_str() {
                "hostname" => h.host = Some(value.to_string()),
                "port" => h.port = value.parse().ok(),
                "user" => h.user = Some(value.to_string()),
                "identityfile" => h.identity_file = Some(value.to_string()),
                "proxyjump" => h.proxy_jump = Some(value.to_string()),
                _ => {}
            }
        }
    }

    if let Some(h) = current.take() {
        hosts.push(h);
    }

    Ok(hosts)
}

fn home_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return Ok(std::path::PathBuf::from(home));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Ok(std::path::PathBuf::from(home));
        }
    }
    Err("Could not determine home directory".to_string())
}

// ── Web 网关 Tauri commands ──

/// 在系统默认浏览器中打开外部 URL(网页网关右键菜单「在外部浏览器打开」)。
#[tauri::command]
pub async fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    // shell open 已标 deprecated(官方建议改用 opener 插件),但项目未引入
    // tauri-plugin-opener,为最小改动继续复用已注册的 shell 插件。
    #[allow(deprecated)]
    app.shell()
        .open(&url, None)
        .map_err(|e| format!("open external url failed: {e}"))
}

#[tauri::command]
pub async fn ssh_start_web_gateway(
    session_id: String,
    state: tauri::State<'_, crate::SshManager>,
) -> Result<u16, String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let mut session = session.lock().await;
    session.start_web_gateway().await
}

#[tauri::command]
pub async fn ssh_stop_web_gateway(
    session_id: String,
    state: tauri::State<'_, crate::SshManager>,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    session.lock().await.stop_web_gateway();
    Ok(())
}

#[tauri::command]
pub async fn ssh_web_gateway_port(
    session_id: String,
    state: tauri::State<'_, crate::SshManager>,
) -> Result<Option<u16>, String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let session = session.lock().await;
    Ok(session.web_gateway_port())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";

    #[test]
    fn private_key_file_decoder_accepts_utf8_bom() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(TEST_PRIVATE_KEY.as_bytes());
        assert_eq!(decode_private_key_file(&bytes).unwrap(), TEST_PRIVATE_KEY);
    }

    #[test]
    fn private_key_file_decoder_accepts_utf16_le() {
        let mut bytes = vec![0xff, 0xfe];
        for unit in TEST_PRIVATE_KEY.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_private_key_file(&bytes).unwrap(), TEST_PRIVATE_KEY);
    }

    #[test]
    fn private_key_file_decoder_rejects_public_keys() {
        let public_key = b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== user@example.com";
        assert!(decode_private_key_file(public_key)
            .unwrap_err()
            .starts_with("[KEY_FILE_FORMAT]"));
    }

    #[test]
    fn sanitize_key_normalizes_crlf_to_lf() {
        let crlf_key = "-----BEGIN PRIVATE KEY-----\r\nAAAA\r\n-----END PRIVATE KEY-----\r\n";
        assert_eq!(sanitize_key(crlf_key), TEST_PRIVATE_KEY);
    }

    #[test]
    fn decode_private_key_file_with_crlf_normalizes_to_lf() {
        let crlf_bytes = b"-----BEGIN PRIVATE KEY-----\r\nAAAA\r\n-----END PRIVATE KEY-----\r\n";
        assert_eq!(
            decode_private_key_file(crlf_bytes).unwrap(),
            TEST_PRIVATE_KEY
        );
    }

    #[tokio::test]
    async fn reconnect_uses_a_fresh_attempt_generation() {
        let manager = SshManager::new();
        let first = manager.begin_attempt("same-session").await;
        manager.invalidate_attempt("same-session").await;
        assert!(!manager.is_current_attempt("same-session", first).await);

        let retry = manager.begin_attempt("same-session").await;
        assert!(retry > first);
        assert!(manager.is_current_attempt("same-session", retry).await);
    }
}
