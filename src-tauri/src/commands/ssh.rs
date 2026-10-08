use crate::harness::HarnessManager;
use crate::registry::{DetachOutcome, SessionRegistry};
use crate::sftp::transfer::TransferManager;
use crate::ssh::adapters::{tauri_sink, SqliteKnownHostsStore};
use starhub_domain_ssh::asset_config::ssh_config_from_asset;
use starhub_domain_ssh::events::KnownHostsStore;
// SshManager / connect_session / ssh_exec_core / ssh_exec_abort_core 已平移到
// starhub-domain-ssh(去 Tauri 化 M1),这里再导出以沿用 `crate::commands::ssh::*` 旧路径。
pub use starhub_domain_ssh::manager::{
    connect_session, ssh_exec_abort_core, ssh_exec_core, SshManager,
};
use crate::ssh::session::SshSession;
use crate::ssh::{SshConfig, SshSessionInfo};
use serde_json::Value;
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

// ── SshManager(会话表 / 代次守卫 / 在途 exec 取消句柄)与 connect_session /
//    ssh_exec_core / ssh_exec_abort_core 已平移到 starhub-domain-ssh::manager
//    (去 Tauri 化 M1,唯一事实源);Tauri 侧只保留 #[tauri::command] 薄封装,
//    注入 adapters::TauriEventSink 与 SqliteKnownHostsStore 两个 seam 实现。 ──

#[tauri::command]
pub async fn ssh_get_trusted_host_key(host: String, port: u16) -> Result<Option<String>, String> {
    SqliteKnownHostsStore
            .trusted_public_key(&host, port)
            .await
            .map_err(|e| e.to_string())
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
    connect_session(&manager, &transfer_manager, id, config, &tauri_sink(app_handle.clone()), true).await
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
    connect_session(&manager, &transfer_manager, id, config, &tauri_sink(app_handle.clone()), false).await
}

// connect_session 已平移到 starhub-domain-ssh::manager(去 Tauri 化 M1,
// 唯一事实源);Tauri 侧经上方 `pub use` 再导出,签名由 app_handle 改为
// `&Arc<dyn EventSink>`,由 tauri 命令面传 adapters::tauri_sink(...) 进去。

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

    // config_json → SshConfig 的映射语义在 crate 的纯函数里(两侧逐字一致)
    let config = ssh_config_from_asset(&name, &config)?;
    Ok((name, config))
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
    // 复用路径:注册表已有该资产的 session 且 SshManager 中仍存活。
    // 存活 = 会话条目在位且心跳未判死(is_alive):此前只查 contains_key,
    // 网络断开后死会话滞留 map,attach 永远复用死连接,后续命令全部失败。
    if let Some(session_id) = registry.session_for_asset(&asset_id) {
        let session_arc = manager.sessions.lock().await.get(&session_id).cloned();
        let alive = match &session_arc {
            Some(arc) => arc.lock().await.is_alive(),
            None => false,
        };
        if alive {
            registry.attach(&asset_id, &session_id, "ssh", "frontend");
            notify_registry_sync(&harness, &registry, &manager).await;
            return Ok(SshAttachResult {
                session_id,
                reused: true,
            });
        }
        if session_arc.is_some() {
            // 死会话:丢弃(map 条目 + 代次 + pending 通道),走下方建连路径重建。
            manager.drop_session(&session_id).await;
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
        &tauri_sink(app_handle.clone()),
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
            // 归零:与 ssh_disconnect 相同的清理路径(SFTP 通道先注销,再断 session)。
            // 同样带代次守卫:session 锁被在途 exec 阻塞期间若用户重开连接,
            // 不作废新连接、不删新通道与 pending 应答。
            let target_generation = manager.current_attempt(&session_id).await;
            transfer_manager.unregister_sftp(&session_id).await;
            let session_arc = {
                let mut sessions = manager.sessions.lock().await;
                sessions.remove(&session_id)
            };
            if let Some(session) = session_arc {
                let mut session = session.lock().await;
                session.disconnect();
            }
            let invalidated = match target_generation {
                Some(guard) => {
                    manager
                        .invalidate_attempt_if_current(&session_id, guard)
                        .await
                }
                None => None,
            };
            if let Some(invalidated) = invalidated {
                manager
                    .remove_write_channel_for_attempt(&session_id, invalidated.wrapping_sub(1))
                    .await;
                // 与 ssh_disconnect 相同的清理路径:丢弃仍在等待前端输入的
                // MFA / 主机密钥 / 堡垒机选机器应答通道,避免 in-flight connect
                // 一直阻塞到 360s 超时。
                manager.pending_kb.lock().await.remove(&session_id);
                manager.pending_hostkey.lock().await.remove(&session_id);
                manager.pending_bastion.lock().await.remove(&session_id);
            }
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
    // 代次守卫:在触碰任何可能阻塞的状态前,先记录本次 disconnect 要作废的
    // 代次。若清理过程中(session 锁被在途 exec 阻塞数秒)用户已经重开连接
    // (新代次),本次 disconnect 的失效/通道/pending 清理全部跳过——否则会把
    // 新连接的写通道删掉(终端输入静默丢弃)、作废新 in-flight connect(报
    // Connection aborted by client)、删掉新 MFA 应答通道,表现为「关闭后再
    // 连接连不上」。
    let target_generation = manager.current_attempt(&id).await;
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

    // 代次守卫的失效:只有当 id 的当前代次仍是本次 disconnect 记录的那一个
    // (期间没有更新的 connect 开始)才执行失效与后续清理。
    let invalidated_generation = match target_generation {
        Some(guard) => manager.invalidate_attempt_if_current(&id, guard).await,
        None => None,
    };

    if let Some(invalidated_generation) = invalidated_generation {
        // 只移除本次 disconnect 取消的旧写通道；如果新的 connect 已经开始，
        // 它拥有更高代次，不能被较晚完成的旧清理误删。
        manager
            .remove_write_channel_for_attempt(&id, invalidated_generation.wrapping_sub(1))
            .await;

        // 主动断开(关闭窗口/取消连接)时,丢弃仍在等待前端输入的 MFA / 主机密钥
        // 应答通道。否则 in-flight connect 会一直阻塞到 360s 超时;期间用户重开
        // 同一资产的窗口会触发新的 connect,其 insert 会顶掉旧 sender,而旧任务
        // 醒来后盲目 remove(session_id) 会误删新 connect 的 sender,导致新窗口
        // 报 [MFA_FAILED] Keyboard-interactive response channel dropped(见图片2)。
        // 堡垒机 AI exec 的「选机器」待应答通道一并丢弃(v0.116.7 补齐)。
        manager.pending_kb.lock().await.remove(&id);
        manager.pending_hostkey.lock().await.remove(&id);
        manager.pending_bastion.lock().await.remove(&id);
    }

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
    let mut session = SshSession::new(config.clone(), Arc::clone(&manager.known_hosts));
    let start = std::time::Instant::now();

    let result = session
        .connect(
            &test_session_id,
            Some(&tauri_sink(app_handle.clone())),
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
    ssh_exec_core(&manager, &tauri_sink(app), &id, &command, timeout_sec, exec_id.as_deref(), false).await
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

/// 在独立 Tauri 窗口打开 SSH 网页访问(obscura 渲染,经网关代理访问内网)。
/// 替换原先「网页」tab 右侧栏 iframe 形态。首次打开会启动网关并创建查看器窗口。
#[tauri::command]
pub async fn ssh_open_web_window(
    app: tauri::AppHandle,
    session_id: String,
    asset_name: String,
    state: tauri::State<'_, crate::SshManager>,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let port = {
        let mut session = session.lock().await;
        session.start_web_gateway().await?
    };
    // 固定用原生 webview 壳(真实内核 wry),不再用 Obscura 无头渲染:
    // 内网站点在复杂 JS / 登录页上兼容性更好,也无需依赖 obscura 引擎。
    crate::browser::web_shell::open_web_shell_window(&app, &session_id, &asset_name, port).await
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

}
