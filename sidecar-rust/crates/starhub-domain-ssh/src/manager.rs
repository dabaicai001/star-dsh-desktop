//! SSH 会话管理器与进程内执行核心(去 Tauri 化 M1 从 `src-tauri/src/commands/ssh.rs` 平移)。
//!
//! 这里只保留与宿主无关的部分:会话表 / 代次守卫 / 在途 exec 取消句柄 /
//! 建连与一次性 exec 通道。Tauri 专属的三件事留在 `src-tauri` 侧:
//! 1. [`crate::events::EventSink`] 的 Tauri 实现(`adapters::TauriEventSink`);
//! 2. [`crate::events::KnownHostsStore`] 的 SQLite 实现;
//! 3. `#[tauri::command]` 命令面(薄封装,转调本模块的 `*_core` 函数)。
//!
//! sidecar 侧以同一份代码建连/执行,只是注入自己的 sink 与存储实现。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::events::{EventSink, EventSinkExt, KnownHostsStore};
use crate::session::SshSession;
use crate::sftp::transfer::TransferManager;
use crate::{
    PendingBastionResponses, PendingHostKeyResponses, PendingKeyboardResponses, SshConfig,
    SshSessionInfo, SshWriteChannels,
};

/// SSH 会话管理器:会话实体唯一所有者 + 代次守卫 + 在途 exec 取消句柄。
///
/// 域工具执行器(sidecar 的 `ssh_*` 方法面 / Tauri 的 `harness/domain.rs`)
/// 与本命令面共用同一张会话表,因此 AI 执行器与交互终端可复用同一会话
/// (connId `dsh:{asset_id}:ssh` 与前端一致)。
pub struct SshManager {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SshSession>>>>>,
    /// 会话写通道(session_id → (代次, 发送端));交互终端 resize / 断开清理用。
    pub channels: SshWriteChannels,
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
    /// TOFU 主机密钥策略存储(宿主注入:SQLite / sidecar 自有存储)。
    pub known_hosts: Arc<dyn KnownHostsStore>,
}

impl SshManager {
    /// 建管理器;主机密钥策略存储由宿主注入。
    pub fn new(known_hosts: Arc<dyn KnownHostsStore>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            pending_kb: Arc::new(Mutex::new(HashMap::new())),
            pending_hostkey: Arc::new(Mutex::new(HashMap::new())),
            pending_bastion: Arc::new(Mutex::new(HashMap::new())),
            attempts: Arc::new(Mutex::new(HashMap::new())),
            exec_aborts: Arc::new(Mutex::new(HashMap::new())),
            known_hosts,
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

    /// 读取 id 当前代次(只读,不递增)。无记录返回 None。
    pub async fn current_attempt(&self, id: &str) -> Option<u64> {
        self.attempts.lock().await.get(id).copied()
    }

    async fn invalidate_attempt(&self, id: &str) -> u64 {
        self.begin_attempt(id).await
    }

    /// 代次守卫的失效:仅当 id 当前代次仍等于 `guard` 时才递增,否则不动。
    ///
    /// 修复「关闭→重连失败」竞态:旧会话的 disconnect 在 session 锁上被
    /// 在途 exec 阻塞数秒,期间用户重开连接(新代次);旧 disconnect 醒来后
    /// 若盲目 invalidate 会作废新连接(报 Connection aborted / 删新写通道 /
    /// 删新 MFA 应答通道)。带守卫后旧 disconnect 对新连接零影响。
    /// @returns Some(新代次) = 守卫命中已失效;None = 代次已前移,跳过清理。
    pub async fn invalidate_attempt_if_current(&self, id: &str, guard: u64) -> Option<u64> {
        let mut attempts = self.attempts.lock().await;
        if attempts.get(id).copied() != Some(guard) {
            return None;
        }
        let next = guard.wrapping_add(1).max(1);
        attempts.insert(id.to_string(), next);
        Some(next)
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

    /// 按代次守卫清理写通道(宿主的 disconnect 路径用)。
    pub async fn remove_write_channel_for_attempt(&self, id: &str, generation: u64) {
        self.remove_channel_for_attempt(id, generation).await;
    }

    /// 丢弃一个会话(死会话自愈路径):从 map 移除 + 作废当前代次 +
    /// 清掉全部 pending 应答通道。供域工具执行器在连接级失败后调用,
    /// 下一次 ensure_ssh_session 会按资产配置重建会话。
    pub async fn drop_session(&self, id: &str) {
        if let Some(session_arc) = self.sessions.lock().await.remove(id) {
            let mut session = session_arc.lock().await;
            session.disconnect();
        }
        self.invalidate_attempt(id).await;
        self.pending_kb.lock().await.remove(id);
        self.pending_hostkey.lock().await.remove(id);
        self.pending_bastion.lock().await.remove(id);
    }
}

/// 建立 SSH 会话(interactive=true 开 PTY shell,false 为一次性 exec 通道)。
///
/// 事件经 `sink` 送出(Tauri 侧是 Emitter,sidecar 侧是 JSON-RPC 通知);
/// 主机密钥策略取自 manager 注入的 [`KnownHostsStore`]。
pub async fn connect_session(
    manager: &SshManager,
    transfer_manager: &TransferManager,
    id: String,
    config: SshConfig,
    sink: &Arc<dyn EventSink>,
    interactive: bool,
) -> Result<SshSessionInfo, String> {
    let started_at = std::time::Instant::now();
    // 每次显式连接都有独立代次。失败后的 disconnect 只会让旧代次失效,
    // 不会像永久 abandoned 标记那样污染同一 tab/窗口里的下一次重试。
    let attempt_generation = manager.begin_attempt(&id).await;

    // 网络 I/O 在锁外执行 — 否则 connect() 期间持有 sessions 锁会阻塞
    // 所有其他 SSH 操作(resize / disconnect / 新 connect),导致第二个 tab
    // 永远卡在 "Connecting to"。
    let mut session = SshSession::new(config.clone(), Arc::clone(&manager.known_hosts));
    session
        .connect(
            &id,
            Some(sink),
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
                Arc::clone(sink),
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
        sink.emit_ser(&format!("ssh:mfa-connected:{id}"), id.clone());
    }

    Ok(info)
}

/// ssh_exec 的进程内核心(命令面与域工具执行器共用)。
/// `bastion_interactive` = true 时(AI 域工具路径):资产启用 kb_interactive
/// MFA(堡垒机,含直连堡垒机与跳板机两种形态)时改走带 pty 的 shell,
/// 先由用户选机器再执行命令。
pub async fn ssh_exec_core(
    manager: &SshManager,
    sink: &Arc<dyn EventSink>,
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
        // 注册在途取消句柄:普通 exec 与堡垒机 pty 路径统一支持停止生成中断
        // (此前堡垒机路径不可中断,阶段1 等选机器最长扣住会话锁 360s)。
        let abort_rx = match exec_id {
            Some(eid) => {
                let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
                manager
                    .exec_aborts
                    .lock()
                    .await
                    .insert(eid.to_string(), abort_tx);
                Some(abort_rx)
            }
            None => None,
        };
        // 堡垒机 pty 路径:启用 kb_interactive MFA(直连堡垒机或跳板机)时,普通
        // exec 通道被服务端拒绝(Channel send error),需先经 pty 让用户选机器。
        // 仅 AI 域工具路径启用。
        let result = if bastion_interactive && session.is_bastion() {
            session
                .exec_via_bastion_pty(
                    id,
                    Some(sink),
                    &manager.pending_bastion,
                    manager.channels.clone(),
                    command,
                    timeout_sec.unwrap_or(10),
                    abort_rx,
                )
                .await
        } else {
            match abort_rx {
                Some(abort_rx) => {
                    session
                        .exec_abortable(command, timeout_sec.unwrap_or(10), abort_rx)
                        .await
                }
                None => session.exec(command, timeout_sec.unwrap_or(10)).await,
            }
        };
        // 无论结果如何都清理注册,避免 map 泄漏
        if let Some(eid) = exec_id {
            manager.exec_aborts.lock().await.remove(eid);
        }
        result
    }
    .await;

    if let Ok(output) = &result {
        sink.emit_ser(
            "ssh:exec-done",
            serde_json::json!({
                "sessionId": id,
                "command": command,
                "output": output.chars().take(4000).collect::<String>(),
            }),
        );
    }
    result
}

/// ssh_exec_abort 的进程内核心(停止生成时中断在途命令)。
pub async fn ssh_exec_abort_core(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::MemoryKnownHostsStore;

    #[tokio::test]
    async fn reconnect_uses_a_fresh_attempt_generation() {
        let manager = SshManager::new(Arc::new(MemoryKnownHostsStore::default()));
        let first = manager.begin_attempt("same-session").await;
        manager.invalidate_attempt("same-session").await;
        assert!(!manager.is_current_attempt("same-session", first).await);

        let retry = manager.begin_attempt("same-session").await;
        assert!(retry > first);
        assert!(manager.is_current_attempt("same-session", retry).await);
    }

    #[tokio::test]
    async fn invalidate_attempt_if_current_only_bumps_matching_generation() {
        // 修复「关闭→重连失败」竞态的守卫语义:旧 disconnect 的失效操作在
        // 新 connect 已开跑(代次前移)后必须被拒绝,而不是作废新连接。
        let manager = SshManager::new(Arc::new(MemoryKnownHostsStore::default()));
        let first = manager.begin_attempt("asset-a").await; // 1
                                                            // 守卫命中:递增到 2
        assert_eq!(
            manager
                .invalidate_attempt_if_current("asset-a", first)
                .await,
            Some(2)
        );
        // 旧代次守卫不再命中:返回 None 且代次不动
        assert_eq!(
            manager
                .invalidate_attempt_if_current("asset-a", first)
                .await,
            None
        );
        assert_eq!(manager.current_attempt("asset-a").await, Some(2));
        // 无记录的 id:current 为 None
        assert_eq!(manager.current_attempt("asset-b").await, None);
    }
}
