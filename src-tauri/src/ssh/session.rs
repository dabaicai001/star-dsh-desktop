use super::sftp_transport::{SftpChannelDiagnostics, SftpChannelStream};
use super::{auth::RemoteForwards, SftpLaunchMode, SshAuth, SshConfig};
use russh::client::{self, Handle};
use russh::{ChannelMsg, MethodKind, MethodSet};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;
use tracing::debug;

/// exec 单次输出上限,超出后截断并在结果尾部标注,避免远端命令刷屏打爆内存。
const MAX_EXEC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// exec 超时秒数上限,防止调用方传入超大值让 channel 永远悬挂。
const MAX_EXEC_TIMEOUT_SEC: u64 = 600;
/// SSH 写通道缓冲条数上限:慢网络时发送端等待(背压),而不是无限堆积内存。
const SSH_WRITE_CHANNEL_CAPACITY: usize = 256;
/// SSH 固定心跳间隔。
///
/// russh 自带的 `keepalive_interval` 只在连接「完全空闲」时才发心跳——
/// 一旦 AI 长命令有零星输出(输出频率低于 NAT 空闲超时),russh 就判定连接
/// 「活跃」而不发 keepalive,但中间 NAT / 防火墙仍会按空闲踢掉会话。
/// 因此额外起一个固定节拍的心跳 task,无条件每此间隔发一个
/// `keepalive@openssh.com` global request,保证任意时刻都有包刷新 NAT 空闲
/// 定时器。间隔取 15s:小于绝大多数 NAT / LB 的空闲超时(≥30s),流量开销
/// 可忽略(单包几十字节,每天约 300KB)。
const SSH_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const SFTP_PROBE_MARKER: &str = "__STARHUB_SFTP_PATH__";
const SFTP_PROBE_NONE_MARKER: &str = "__STARHUB_SFTP_NONE__";
const SFTP_SERVER_CANDIDATES: &[&str] = &[
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/lib64/ssh/sftp-server",
    "/usr/libexec/ssh/sftp-server",
    "/usr/libexec/sftp-server",
    "/usr/local/libexec/openssh/sftp-server",
    "/usr/local/libexec/sftp-server",
    "/opt/local/libexec/sftp-server",
];

#[derive(Debug, Clone, Serialize)]
pub struct SftpLaunchInfo {
    pub mode: String,
    pub server_path: Option<String>,
    pub diagnostic: Option<String>,
}

#[derive(Debug)]
struct SftpAttemptError {
    code: &'static str,
    message: String,
    recoverable: bool,
}

impl SftpAttemptError {
    fn new(code: &'static str, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable,
        }
    }
}

impl std::fmt::Display for SftpAttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

#[derive(Debug)]
enum SftpRequest {
    Subsystem,
    Exec { path: String, command: String },
}

impl SftpRequest {
    fn description(&self) -> String {
        match self {
            Self::Subsystem => "SSH subsystem \"sftp\"".to_string(),
            Self::Exec { path, .. } => format!("remote sftp-server executable {path}"),
        }
    }

    fn rejection_code(&self) -> &'static str {
        match self {
            Self::Subsystem => "SFTP_SUBSYSTEM_REJECTED",
            Self::Exec { .. } => "SFTP_EXEC_REJECTED",
        }
    }
}

#[derive(Debug)]
enum SftpProbeResult {
    Found { path: String, diagnostic: String },
    NotFound { diagnostic: String },
    Failed { diagnostic: String },
}

#[derive(Debug, Default)]
struct RemoteProbeOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_status: Option<u32>,
    exit_signal: Option<String>,
}

/// 内部端口转发条目,用于跟踪活跃的转发任务
struct PortForwardEntry {
    forward_type: String,
    bound_port: u16,
    target_host: String,
    target_port: u16,
    /// 用于取消转发任务的 AbortHandle
    abort_handle: tokio::task::AbortHandle,
    /// 每条接入连接派生的子任务(channel 建立 + 双向拷贝)的 AbortHandle,
    /// 移除转发 / 断开 session 时一并终止,避免存量连接泄漏。
    connection_handles: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
}

impl PortForwardEntry {
    fn abort_all(&self) {
        self.abort_handle.abort();
        if let Ok(handles) = self.connection_handles.lock() {
            for handle in handles.iter() {
                handle.abort();
            }
        }
    }
}

pub struct SshSession {
    config: SshConfig,
    handle: Option<Arc<Handle<super::auth::SshHandler>>>,
    resize_tx: Option<watch::Sender<(u32, u32)>>,
    /// 固定节拍心跳 task 的取消句柄,disconnect 时一并终止。
    heartbeat_abort: Option<tokio::task::AbortHandle>,
    remote_forwards: RemoteForwards,
    port_forwards: Vec<PortForwardEntry>,
    /// Web 网关:本地 HTTP 代理,上游经 SSH direct-tcpip 通道转发。
    web_gateway: Option<super::web_gateway::GatewayHandle>,
    /// 浏览类 SFTP 操作(list/stat/remove/mkdir/rename/read/write)复用的通道,
    /// 避免每个操作都重新 channel open + subsystem 协商。断线或操作失败时失效重建。
    browse_sftp: Option<russh_sftp::client::SftpSession>,
}

impl SshSession {
    pub fn new(config: SshConfig) -> Self {
        Self {
            config,
            handle: None,
            resize_tx: None,
            heartbeat_abort: None,
            remote_forwards: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            port_forwards: Vec::new(),
            web_gateway: None,
            browse_sftp: None,
        }
    }

    pub fn sftp_timeout_sec(&self) -> u64 {
        self.config.effective_sftp_timeout_sec()
    }

    /// 是否为「堡垒机 pty exec」场景:启用 keyboard-interactive MFA。
    ///
    /// 这类资产的登录壳在验证码通过后,会先呈现「选择机器」交互菜单,普通
    /// exec 通道(无 pty、无机器选中)会被服务端拒绝。判定只认 kb_interactive:
    /// 既覆盖「跳板机 + MFA」形态(jump_host + kb),也覆盖「直连堡垒机 + MFA」
    /// 形态(host 即堡垒机,无 jump_host,如阿里云 BastionHost 公网入口)。
    /// 方案A(v0.95.6)起初要求 jump_host,导致直连堡垒机资产被漏判,AI exec
    /// 走普通通道在验证码通过后报错。
    pub fn is_bastion(&self) -> bool {
        self.config
            .kb_interactive
            .as_ref()
            .is_some_and(|kb| kb.enabled)
    }

    /// 返回会话配置中的连接目标(host, port, username),
    /// 供会话列表展示(如命令广播对话框)使用。
    pub fn endpoint(&self) -> (String, u16, String) {
        (
            self.config.host.clone(),
            self.config.port,
            self.config.username.clone(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn connect_and_auth(
        host: &str,
        port: u16,
        username: &str,
        auth: &SshAuth,
        kb_interactive: &Option<super::KeyboardInteractiveConfig>,
        session_id: &str,
        app_handle: Option<&tauri::AppHandle>,
        pending_kb: &super::PendingKeyboardResponses,
        pending_hostkey: &super::PendingHostKeyResponses,
        remote_forwards: RemoteForwards,
    ) -> Result<client::Handle<super::auth::SshHandler>, String> {
        let socket_addr = format!("{}:{}", host, port);

        let config = client::Config {
            inactivity_timeout: None,
            // SSH 层 keepalive:30s 一个 global-request,3 次无应答才判定死亡。
            // AI 场景下终端连接经常长时间零流量(AI 在独立连接上干活 /
            // 长命令无输出),没有心跳会被 NAT / LB / sshd ClientAlive 踢掉。
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        };

        let handler = super::auth::SshHandler::new(
            session_id.to_string(),
            app_handle.cloned(),
            Arc::clone(pending_hostkey),
            host.to_string(),
            port,
            remote_forwards,
        );

        let connect_timeout = Duration::from_secs(370); // 含 MFA 360s 等待
        let connect_and_auth_fut = async {
            let mut handle = client::connect(Arc::new(config), socket_addr, handler)
                .await
                .map_err(|e| {
                    format!(
                        "[CONN_FAILED] Failed to connect to {}:{}: {}",
                        host, port, e
                    )
                })?;

            let kb_enabled = kb_interactive.as_ref().map(|k| k.enabled).unwrap_or(false);

            // 始终先尝试主认证(password / key / password+key)
            let remaining = authenticate_primary(&mut handle, username, auth).await?;

            if remaining.is_empty() {
                // 主认证成功,无需 MFA
                debug!("Primary auth succeeded for {}:{}", host, port);
            } else if kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                // 主认证完成(密码已验证),服务器要求 keyboard-interactive 做第二因素(TOTP/MFA)
                debug!(
                    "Primary auth done, server requires keyboard-interactive MFA for {}:{}",
                    host, port
                );
                authenticate_keyboard_interactive(
                    &mut handle,
                    username,
                    kb_interactive,
                    session_id,
                    app_handle,
                    pending_kb,
                )
                .await?;
            } else if !kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                // 服务器支持 keyboard-interactive 但用户未启用 MFA
                return Err("[AUTH_FAILED] Server requires keyboard-interactive MFA. Enable MFA in connection settings.".to_string());
            } else {
                // 主认证失败且没有可用的后续方法
                return Err(
                    "[AUTH_FAILED] Authentication rejected and no further methods available"
                        .to_string(),
                );
            }

            Ok(handle)
        };

        match timeout(connect_timeout, connect_and_auth_fut).await {
            Ok(res) => res,
            Err(_) => Err(format!(
                "[CONN_TIMEOUT] SSH connect/auth timed out after {}s on {}:{}",
                connect_timeout.as_secs(),
                host,
                port
            )),
        }
    }

    pub async fn connect(
        &mut self,
        session_id: &str,
        app_handle: Option<&tauri::AppHandle>,
        pending_kb: &super::PendingKeyboardResponses,
        pending_hostkey: &super::PendingHostKeyResponses,
    ) -> Result<(), String> {
        let handle = if let Some(jump_host) = &self.config.jump_host {
            let jump_port = self.config.jump_port.unwrap_or(22);
            let jump_username = self
                .config
                .jump_username
                .as_deref()
                .unwrap_or(&self.config.username);
            let jump_auth = self.config.jump_auth.as_ref().unwrap_or(&self.config.auth);

            let jump_handle = Self::connect_and_auth(
                jump_host,
                jump_port,
                jump_username,
                jump_auth,
                // 跳板机也可能是堡垒机:密码之后同样要求 keyboard-interactive
                // (验证码 + 选择机器)。复用资产的 kb 配置——跳板机不要求 kb 时
                // 主认证成功即结束,不会多弹窗;要求 kb 时用户在同一弹窗流里
                // 依次完成验证码与机器选择,再走隧道进目标机。
                &self.config.kb_interactive,
                session_id,
                app_handle,
                pending_kb,
                pending_hostkey,
                Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            )
            .await?;

            let direct_tcpip = jump_handle
                .channel_open_direct_tcpip(
                    &self.config.host,
                    self.config.port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| {
                    format!(
                        "[CONN_FAILED] Failed to open tunnel through jump host: {}",
                        e
                    )
                })?;

            let config = client::Config {
                inactivity_timeout: None,
                // 同主连接:跳板机内层连接也开心跳,见上方注释。
                keepalive_interval: Some(Duration::from_secs(30)),
                keepalive_max: 3,
                ..Default::default()
            };

            let handler = super::auth::SshHandler::new(
                session_id.to_string(),
                app_handle.cloned(),
                Arc::clone(pending_hostkey),
                self.config.host.clone(),
                self.config.port,
                Arc::clone(&self.remote_forwards),
            );
            let channel_stream = direct_tcpip.into_stream();
            let mut handle = client::connect_stream(Arc::new(config), channel_stream, handler)
                .await
                .map_err(|e| {
                    format!(
                        "[CONN_FAILED] Failed to connect to target through tunnel: {}",
                        e
                    )
                })?;

            // 始终先尝试主认证(password / key / password+key)
            let kb_enabled = self
                .config
                .kb_interactive
                .as_ref()
                .map(|k| k.enabled)
                .unwrap_or(false);
            let remaining =
                authenticate_primary(&mut handle, &self.config.username, &self.config.auth).await?;

            if remaining.is_empty() {
                debug!("Primary auth succeeded for target via jump host");
            } else if kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                debug!("Primary auth done, server requires keyboard-interactive MFA for target via jump host");
                authenticate_keyboard_interactive(
                    &mut handle,
                    &self.config.username,
                    &self.config.kb_interactive,
                    session_id,
                    app_handle,
                    pending_kb,
                )
                .await?;
            } else if !kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                return Err("[AUTH_FAILED] Server requires keyboard-interactive MFA. Enable MFA in connection settings.".to_string());
            } else {
                return Err(
                    "[AUTH_FAILED] Authentication rejected and no further methods available"
                        .to_string(),
                );
            }

            handle
        } else {
            Self::connect_and_auth(
                &self.config.host,
                self.config.port,
                &self.config.username,
                &self.config.auth,
                &self.config.kb_interactive,
                session_id,
                app_handle,
                pending_kb,
                pending_hostkey,
                Arc::clone(&self.remote_forwards),
            )
            .await?
        };

        let handle = Arc::new(handle);
        self.spawn_heartbeat(&handle);
        self.handle = Some(handle);
        Ok(())
    }

    /// 启动固定节拍的应用层心跳,弥补 russh keepalive「只在空闲时发」的盲区。
    ///
    /// 连接建立(认证完成)后无条件每 `SSH_HEARTBEAT_INTERVAL` 发一个
    /// `keepalive@openssh.com` global request(want_reply=true)。对端正常回复会
    /// 重置 russh 的 keepalive 计时器,因此只要连接健康,russh keepalive 永不触发;
    /// 一旦连接黑洞(NAT 静默丢包),心跳无回复,russh keepalive 仍会照常判定死亡。
    /// 二者分工:本心跳负责刷新 NAT 空闲定时器,russh keepalive 负责死亡检测。
    fn spawn_heartbeat(&mut self, handle: &Arc<Handle<super::auth::SshHandler>>) {
        let handle = Arc::clone(handle);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SSH_HEARTBEAT_INTERVAL);
            // 首个 tick 立即触发,建链刚完成无需立刻发,先消费掉。
            ticker.tick().await;
            loop {
                ticker.tick().await;
                // sender 被 drop(连接已关)时返回 SendError,退出即可。
                if handle.send_keepalive(true).await.is_err() {
                    break;
                }
            }
        });
        self.heartbeat_abort = Some(task.abort_handle());
    }

    pub async fn open_shell(
        &mut self,
        session_id: &str,
        attempt_generation: u64,
        app_handle: tauri::AppHandle,
        channels: super::SshWriteChannels,
    ) -> Result<(), String> {
        let handle = self.handle.as_mut().ok_or("Not connected")?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open channel: {}", e))?;
        let (pty_cols, pty_rows) = self.config.effective_pty_size();
        channel
            .request_pty(true, "xterm-256color", pty_cols, pty_rows, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("Failed to request shell: {}", e))?;
        let mut writer = channel.make_writer();
        // bounded channel 提供背压:ZMODEM 大文件 + 慢网络时发送端会等待,
        // 而不是让未发送数据在内存里无限堆积。
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(SSH_WRITE_CHANNEL_CAPACITY);
        let (resize_tx, mut resize_rx) = watch::channel((pty_cols, pty_rows));
        self.resize_tx = Some(resize_tx);
        {
            let mut ch = channels.lock().await;
            ch.insert(session_id.to_string(), (attempt_generation, write_tx));
        }
        let id_for_read = session_id.to_string();
        let channels_clone = channels.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(data) = write_rx.recv().await {
                if writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            // 记录断开原因并透传到前端:此前统一打印 "Connection closed by
            // remote host",shell 正常退出与连接被踢无法区分,没法诊断。
            let mut close_cause = "connection-lost";
            loop {
                tokio::select! {
                    resize_result = resize_rx.changed() => {
                        if resize_result.is_err() {
                            break;
                        }
                        let (cols, rows) = *resize_rx.borrow_and_update();
                        if let Err(error) = channel.window_change(cols, rows, 0, 0).await {
                            tracing::warn!(
                                session_id = %id_for_read,
                                cols,
                                rows,
                                %error,
                                "Failed to resize SSH PTY"
                            );
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let _ = app_handle
                                    .emit(&format!("ssh:data:{}", id_for_read), data.to_vec());
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let _ = app_handle
                                    .emit(&format!("ssh:data:{}", id_for_read), data.to_vec());
                            }
                            Some(ChannelMsg::WindowChange { .. }) | Some(ChannelMsg::Success) => {}
                            // Eof:远程 shell 进程退出(exit / shell 被杀),连接本身可能还活着
                            Some(ChannelMsg::Eof) => {
                                close_cause = "shell-exited";
                                break;
                            }
                            // Close:服务端主动关通道
                            Some(ChannelMsg::Close) => {
                                close_cause = "channel-closed";
                                break;
                            }
                            // None:russh 连接句柄结束(TCP 断、服务端 disconnect、keepalive 超时)
                            None => break,
                            _ => {}
                        }
                    }
                }
            }
            let mut ch = channels_clone.lock().await;
            let was_current = ch
                .get(&id_for_read)
                .is_some_and(|(generation, _)| *generation == attempt_generation);
            if was_current {
                ch.remove(&id_for_read);
            }
            drop(ch);
            if was_current {
                tracing::warn!(
                    session_id = %id_for_read,
                    cause = close_cause,
                    "SSH shell channel closed"
                );
                let _ = app_handle.emit(&format!("ssh:close:{}", id_for_read), close_cause);
            }
        });
        Ok(())
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let Some(resize_tx) = &self.resize_tx else {
            return Ok(());
        };
        resize_tx
            .send((cols, rows))
            .map_err(|_| "SSH shell is no longer available".to_string())
    }

    async fn start_sftp_attempt(
        &mut self,
        request: SftpRequest,
    ) -> Result<russh_sftp::client::SftpSession, SftpAttemptError> {
        let sftp_timeout = Duration::from_secs(self.sftp_timeout_sec());
        let description = request.description();
        let handle = self.handle.as_mut().ok_or_else(|| {
            SftpAttemptError::new("SFTP_NOT_CONNECTED", "SSH session is not connected", false)
        })?;

        let mut channel = timeout(sftp_timeout, handle.channel_open_session())
            .await
            .map_err(|_| {
                SftpAttemptError::new(
                    "SFTP_CHANNEL_TIMEOUT",
                    format!(
                        "opening an SSH session channel timed out after {}s",
                        sftp_timeout.as_secs()
                    ),
                    false,
                )
            })?
            .map_err(|error| {
                SftpAttemptError::new(
                    "SFTP_CHANNEL_OPEN_FAILED",
                    format!("failed to open an SSH session channel: {error}"),
                    false,
                )
            })?;

        let send_result = match &request {
            SftpRequest::Subsystem => {
                timeout(sftp_timeout, channel.request_subsystem(true, "sftp")).await
            }
            SftpRequest::Exec { command, .. } => {
                timeout(sftp_timeout, channel.exec(true, command.as_bytes())).await
            }
        };
        send_result
            .map_err(|_| {
                SftpAttemptError::new(
                    "SFTP_REQUEST_TIMEOUT",
                    format!(
                        "sending the request for {description} timed out after {}s",
                        sftp_timeout.as_secs()
                    ),
                    false,
                )
            })?
            .map_err(|error| {
                SftpAttemptError::new(
                    "SFTP_REQUEST_SEND_FAILED",
                    format!("failed to send the request for {description}: {error}"),
                    false,
                )
            })?;

        let diagnostics = SftpChannelDiagnostics::default();
        let reply = timeout(sftp_timeout, async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => return Ok::<(), SftpAttemptError>(()),
                    Some(ChannelMsg::Failure) => {
                        diagnostics.record_request_failure();
                        let detail = diagnostics
                            .summary()
                            .unwrap_or_else(|| "remote server rejected the request".to_string());
                        return Err(SftpAttemptError::new(
                            request.rejection_code(),
                            format!("{description} was rejected: {detail}"),
                            true,
                        ));
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        diagnostics.record_extended_data(&data);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        diagnostics.record_exit_status(exit_status);
                    }
                    Some(ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    }) => {
                        diagnostics.record_exit_signal(
                            format!("{signal_name:?}"),
                            &error_message,
                        );
                        let detail = diagnostics.summary().unwrap_or_else(|| {
                            "remote process exited before accepting the request".to_string()
                        });
                        return Err(SftpAttemptError::new(
                            "SFTP_REMOTE_PROCESS_FAILED",
                            format!("{description} failed before startup: {detail}"),
                            true,
                        ));
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                        diagnostics.record_terminated();
                        let detail = diagnostics.summary().unwrap_or_else(|| {
                            "remote channel closed before accepting the request".to_string()
                        });
                        return Err(SftpAttemptError::new(
                            "SFTP_REMOTE_PROCESS_FAILED",
                            format!("{description} failed before startup: {detail}"),
                            true,
                        ));
                    }
                    Some(ChannelMsg::Data { .. }) => {
                        return Err(SftpAttemptError::new(
                            "SFTP_PROTOCOL_ERROR",
                            format!(
                                "{description} sent protocol data before acknowledging the SSH channel request"
                            ),
                            true,
                        ));
                    }
                    Some(_) => {}
                }
            }
        })
        .await
        .map_err(|_| {
            SftpAttemptError::new(
                "SFTP_REQUEST_TIMEOUT",
                format!(
                    "remote server did not acknowledge {description} within {}s{}",
                    sftp_timeout.as_secs(),
                    diagnostics
                        .summary()
                        .map(|detail| format!("; {detail}"))
                        .unwrap_or_default()
                ),
                false,
            )
        })?;

        if let Err(error) = reply {
            let _ = channel.close().await;
            return Err(error);
        }

        let stream = SftpChannelStream::new(channel, diagnostics.clone());
        let config = russh_sftp::client::Config {
            request_timeout_secs: self.sftp_timeout_sec(),
            ..Default::default()
        };
        let initialize = russh_sftp::client::SftpSession::new_with_config(stream, config);
        let termination = diagnostics.clone();
        tokio::pin!(initialize);

        tokio::select! {
            biased;
            result = &mut initialize => {
                match result {
                    Ok(session) => Ok(session),
                    Err(error) => {
                        let detail = diagnostics
                            .summary()
                            .map(|detail| format!("; {detail}"))
                            .unwrap_or_default();
                        let is_timeout = matches!(
                            error,
                            russh_sftp::client::error::Error::Timeout
                        );
                        Err(SftpAttemptError::new(
                            if is_timeout { "SFTP_INIT_TIMEOUT" } else { "SFTP_INIT_FAILED" },
                            format!(
                                "{description} failed during the SFTP protocol handshake: {error}{detail}"
                            ),
                            diagnostics.has_remote_failure() || !is_timeout,
                        ))
                    }
                }
            }
            _ = termination.wait_terminated() => {
                let detail = diagnostics.summary().unwrap_or_else(|| {
                    "remote channel closed before the SFTP handshake completed".to_string()
                });
                Err(SftpAttemptError::new(
                    "SFTP_REMOTE_PROCESS_FAILED",
                    format!("{description} terminated during the SFTP protocol handshake: {detail}"),
                    true,
                ))
            }
        }
    }

    async fn probe_sftp_server(&mut self) -> SftpProbeResult {
        let probe_timeout = Duration::from_secs(self.sftp_timeout_sec().min(10));
        let handle = match self.handle.as_mut() {
            Some(handle) => handle,
            None => {
                return SftpProbeResult::Failed {
                    diagnostic: "SSH session is not connected".to_string(),
                };
            }
        };
        let mut channel = match timeout(probe_timeout, handle.channel_open_session()).await {
            Ok(Ok(channel)) => channel,
            Ok(Err(error)) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "could not open an SSH exec channel for automatic diagnosis: {error}"
                    ),
                };
            }
            Err(_) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "opening the automatic-diagnosis channel timed out after {}s",
                        probe_timeout.as_secs()
                    ),
                };
            }
        };

        let probe_command = build_sftp_probe_command();
        if let Err(error) = timeout(probe_timeout, channel.exec(true, probe_command.as_bytes()))
            .await
            .map_err(|_| "sending the automatic-diagnosis command timed out".to_string())
            .and_then(|result| result.map_err(|error| error.to_string()))
        {
            let _ = channel.close().await;
            return SftpProbeResult::Failed { diagnostic: error };
        }

        let mut accepted = false;
        let mut output = RemoteProbeOutput::default();
        let collect = timeout(probe_timeout, async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => accepted = true,
                    Some(ChannelMsg::Failure) => {
                        return Err("remote server rejected the SSH exec request used for automatic diagnosis".to_string());
                    }
                    Some(ChannelMsg::Data { data }) => {
                        extend_limited(&mut output.stdout, &data);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        extend_limited(&mut output.stderr, &data);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        output.exit_status = Some(exit_status);
                    }
                    Some(ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    }) => {
                        output.exit_signal = Some(if error_message.trim().is_empty() {
                            format!("{signal_name:?}")
                        } else {
                            format!(
                                "{signal_name:?}: {}",
                                normalize_error_text(&error_message)
                            )
                        });
                        break;
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
            if accepted {
                Ok(())
            } else {
                Err("remote channel closed without accepting the automatic-diagnosis exec request".to_string())
            }
        })
        .await;
        let _ = channel.close().await;

        match collect {
            Err(_) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "automatic diagnosis timed out after {}s{}",
                        probe_timeout.as_secs(),
                        format_probe_details(&output)
                            .map(|detail| format!("; {detail}"))
                            .unwrap_or_default()
                    ),
                };
            }
            Ok(Err(error)) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "{error}{}",
                        format_probe_details(&output)
                            .map(|detail| format!("; {detail}"))
                            .unwrap_or_default()
                    ),
                };
            }
            Ok(Ok(())) => {}
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix(SFTP_PROBE_MARKER))
        {
            let path = path.trim();
            return match validate_sftp_server_path(path) {
                Ok(path) => SftpProbeResult::Found {
                    diagnostic: format!("found executable remote sftp-server at {path}"),
                    path,
                },
                Err(error) => SftpProbeResult::Failed {
                    diagnostic: format!(
                        "automatic diagnosis returned an unsafe or invalid path: {error}"
                    ),
                },
            };
        }

        if stdout
            .lines()
            .any(|line| line.trim() == SFTP_PROBE_NONE_MARKER)
        {
            return SftpProbeResult::NotFound {
                diagnostic: format!(
                    "remote shell is available, but no executable sftp-server was found in the supported locations: {}{}",
                    SFTP_SERVER_CANDIDATES.join(", "),
                    format_probe_details(&output)
                        .map(|detail| format!("; {detail}"))
                        .unwrap_or_default()
                ),
            };
        }

        SftpProbeResult::Failed {
            diagnostic: format!(
                "automatic diagnosis returned no recognizable result{}",
                format_probe_details(&output)
                    .map(|detail| format!("; {detail}"))
                    .unwrap_or_default()
            ),
        }
    }

    pub async fn exec(&mut self, command: &str, timeout_sec: u64) -> Result<String, String> {
        self.exec_inner(command, timeout_sec, None).await
    }

    /// 带中断接收端的 exec:`abort_rx` 触发时关闭 channel,
    /// 并把已收到的部分输出以 `[EXEC_ABORTED]` 前缀返回。
    pub async fn exec_abortable(
        &mut self,
        command: &str,
        timeout_sec: u64,
        abort_rx: oneshot::Receiver<()>,
    ) -> Result<String, String> {
        self.exec_inner(command, timeout_sec, Some(abort_rx)).await
    }

    async fn exec_inner(
        &mut self,
        command: &str,
        timeout_sec: u64,
        abort_rx: Option<oneshot::Receiver<()>>,
    ) -> Result<String, String> {
        let handle = self
            .handle
            .as_mut()
            .ok_or_else(|| "SSH session not connected".to_string())?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("[EXEC_FAILED] Failed to open exec channel: {}", e))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Failed to exec command: {}", e))?;

        // 无中断接收端时用一对 keepalive channel 顶替:发送端存活到函数结束,
        // 保证 select 的 abort 分支永远不会因 sender drop 而误触发。
        let (keepalive_tx, keepalive_rx) = oneshot::channel::<()>();
        let mut abort_rx = abort_rx.unwrap_or(keepalive_rx);
        let _keepalive_tx = keepalive_tx;

        let mut output = Vec::<u8>::new();
        let mut truncated = false;
        let mut exit_status: Option<u32> = None;
        let mut aborted = false;
        let collect = async {
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                truncated |= append_capped(&mut output, &data, MAX_EXEC_OUTPUT_BYTES);
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                truncated |= append_capped(&mut output, &data, MAX_EXEC_OUTPUT_BYTES);
                            }
                            Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                    _ = &mut abort_rx => {
                        aborted = true;
                        break;
                    }
                }
            }
        };
        let timeout_sec = timeout_sec.clamp(1, MAX_EXEC_TIMEOUT_SEC);
        let timeout_duration = Duration::from_secs(timeout_sec);
        let timed_out = timeout(timeout_duration, collect).await.is_err();

        if timed_out && !aborted {
            let _ = channel.close().await;
            return Err(format!(
                "[EXEC_TIMEOUT] Command timed out after {}s: {}",
                timeout_sec, command
            ));
        }
        let mut stdout = String::from_utf8_lossy(&output).to_string();
        if truncated {
            stdout.push_str(&format!(
                "\n[OUTPUT_TRUNCATED] output exceeded {} bytes and was truncated",
                MAX_EXEC_OUTPUT_BYTES
            ));
        }
        if aborted {
            let _ = channel.close().await;
            let partial = stdout.trim();
            return Err(format!(
                "[EXEC_ABORTED] Command aborted by user: {}{}",
                command,
                if partial.is_empty() {
                    String::new()
                } else {
                    format!("\n{}", partial)
                }
            ));
        }
        match exit_status {
            Some(0) => Ok(stdout),
            None => {
                tracing::warn!("Command exited with unknown status: {}", stdout);
                Ok(stdout)
            }
            Some(code) => Err(format!(
                "Command exited with code {}: {}",
                code,
                if stdout.is_empty() {
                    "<no output>"
                } else {
                    stdout.trim()
                }
            )),
        }
    }

    /// AI exec 会话在「跳板机 + kb_interactive」时的 pty 交互路径(方案A/v0.95.6)。
    ///
    /// 这类堡垒机在 keyboard-interactive 验证码通过后,登录壳会先呈现一个
    /// 「选择机器」交互菜单;普通 exec 通道(无 pty、无机器选中)会被服务端拒绝,
    /// 表现为 `[EXEC_FAILED] Failed to open exec channel: Channel send error`。
    /// 选机器与 AI 命令必须在**同一通道**——堡垒机每次会话独立登录,新开 exec
    /// 通道不会继承前面选中的机器。
    ///
    /// 这里改开带 pty 的 shell,分两阶段执行:
    ///   1. 先把初始菜单输出透传前端(事件 `ssh:bastion-select:<sessionId>`),
    ///      等用户经 `ssh_bastion_response` 选定机器,再把选择写入 pty;
    ///   2. 把 AI 命令写入同一 pty,收集输出直到通道 Eof/Close/ExitStatus 或超时。
    ///
    /// 成功后返回「菜单 + 命令输出」,便于 AI/用户核对;失败即快速返回明确
    /// 错误,不悬挂;普通 exec 路径(exec_inner)不受影响。
    #[allow(clippy::too_many_arguments)]
    pub async fn exec_via_bastion_pty(
        &mut self,
        session_id: &str,
        app_handle: Option<&tauri::AppHandle>,
        pending_bastion: &super::PendingBastionResponses,
        command: &str,
        timeout_sec: u64,
    ) -> Result<String, String> {
        let handle = self
            .handle
            .as_mut()
            .ok_or_else(|| "SSH session not connected".to_string())?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("[EXEC_FAILED] Failed to open exec channel: {}", e))?;
        let (pty_cols, pty_rows) = self.config.effective_pty_size();
        channel
            .request_pty(true, "xterm-256color", pty_cols, pty_rows, 0, 0, &[])
            .await
            .map_err(|e| format!("[BASTION_FAILED] Failed to request PTY: {}", e))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("[BASTION_FAILED] Failed to request shell: {}", e))?;

        // 读取「选择机器」菜单的首屏输出:先等一小段(等 shell 打印菜单),再关闭读端。
        let mut menu = Vec::<u8>::new();
        let menu_window = Duration::from_millis(1500);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let drain_menu = async {
            loop {
                tokio::select! {
                    msg = channel.wait() => match msg {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            menu.extend_from_slice(&data);
                            if menu.len() > 64 * 1024 { break; }
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    _ = tokio::time::sleep(menu_window) => break,
                }
            }
        };
        drain_menu.await;
        let menu_text = String::from_utf8_lossy(&menu).to_string();

        // 请求用户选择机器:emit 事件(通用事件带 sessionId,堡垒机浮层订阅)+
        // 等 ssh_bastion_response(360s 超时,同 MFA)。
        // 菜单为空说明登录壳没有「选择机器」交互(普通服务器只是做了
        // keyboard-interactive 二次验证,不经过堡垒机选机),跳过选机器直接
        // 执行命令,避免 AI 卡在无人应答的选机器浮层。
        if !menu_text.trim().is_empty() {
            if let Some(app) = app_handle {
                use tauri::Emitter;
                let payload = serde_json::json!({
                    "sessionId": session_id,
                    "menu": menu_text,
                });
                let _ = app.emit("ssh:bastion-select", payload.clone());
                let _ = app.emit(&format!("ssh:bastion-select:{}", session_id), payload);
            }
            let (resp_tx, resp_rx) = oneshot::channel();
            pending_bastion
                .lock()
                .await
                .insert(session_id.to_string(), resp_tx);
            let selection = match tokio::time::timeout(Duration::from_secs(360), resp_rx).await {
                Ok(Ok(s)) => s,
                Ok(Err(_)) => {
                    pending_bastion.lock().await.remove(session_id);
                    return Err("[BASTION_TIMEOUT] 选择机器应答通道已断开".to_string());
                }
                Err(_) => {
                    pending_bastion.lock().await.remove(session_id);
                    return Err("[BASTION_TIMEOUT] 等待选择机器超时(360s)".to_string());
                }
            };
            let selection = selection.trim().to_string();
            if selection.is_empty() {
                return Err("[BASTION_REJECTED] 未选择堡垒机目标机器".to_string());
            }

            let mut writer = channel.make_writer();
            // 写入机器选择 + 回车,让堡垒机进入目标机。
            writer
                .write_all(format!("{}\n", selection).as_bytes())
                .await
                .map_err(|e| format!("[BASTION_FAILED] 写入机器选择失败: {}", e))?;
            writer.flush().await.ok();
            tokio::time::sleep(Duration::from_millis(600)).await;

            // 把 AI 命令写入同一 pty;随后收集输出直到 Eof/Close/ExitStatus 或超时。
            writer
                .write_all(format!("{}\n", command).as_bytes())
                .await
                .map_err(|e| format!("[BASTION_FAILED] 写入命令失败: {}", e))?;
            writer.flush().await.ok();
            drop(writer);
        } else {
            // 无选机器菜单:直接把 AI 命令写入 pty 执行。
            let mut writer = channel.make_writer();
            writer
                .write_all(format!("{}\n", command).as_bytes())
                .await
                .map_err(|e| format!("[BASTION_FAILED] 写入命令失败: {}", e))?;
            writer.flush().await.ok();
            drop(writer);
        }

        let mut output = Vec::<u8>::new();
        let mut truncated = false;
        let mut exit_status: Option<u32> = None;
        let collect = async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        truncated |= append_capped(&mut output, &data, MAX_EXEC_OUTPUT_BYTES);
                        if let Some(app) = app_handle {
                            use tauri::Emitter;
                            let _ = app.emit(
                                &format!("ssh:bastion-output:{}", session_id),
                                data.to_vec(),
                            );
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        };
        let timeout_sec = timeout_sec.clamp(1, MAX_EXEC_TIMEOUT_SEC);
        let timed_out = timeout(Duration::from_secs(timeout_sec), collect).await.is_err();
        if timed_out {
            let _ = channel.close().await;
            return Err(format!(
                "[EXEC_TIMEOUT] 堡垒机命令超时({}s): {}",
                timeout_sec, command
            ));
        }

        let mut combined = String::new();
        if !menu_text.trim().is_empty() {
            combined.push_str(&format!("[堡垒机菜单]\n{}\n", menu_text.trim()));
        }
        let mut stdout = String::from_utf8_lossy(&output).to_string();
        if truncated {
            stdout.push_str(&format!(
                "\n[OUTPUT_TRUNCATED] output exceeded {} bytes and was truncated",
                MAX_EXEC_OUTPUT_BYTES
            ));
        }
        combined.push_str(&stdout);
        if exit_status.is_some_and(|c| c != 0) {
            return Err(format!(
                "[EXEC] 命令退出码 {}: {}",
                exit_status.unwrap_or(0),
                combined.trim()
            ));
        }
        Ok(combined)
    }

    pub async fn open_sftp_with_info(
        &mut self,
    ) -> Result<(russh_sftp::client::SftpSession, SftpLaunchInfo), String> {
        match self.config.sftp_launch_mode {
            SftpLaunchMode::Subsystem => self
                .start_sftp_attempt(SftpRequest::Subsystem)
                .await
                .map(|session| {
                    (
                        session,
                        SftpLaunchInfo {
                            mode: "subsystem".to_string(),
                            server_path: None,
                            diagnostic: None,
                        },
                    )
                })
                .map_err(|error| error.to_string()),
            SftpLaunchMode::Custom => {
                let configured_path = self
                    .config
                    .sftp_server_path
                    .as_deref()
                    .ok_or_else(|| {
                        "[SFTP_CONFIG_INVALID] Custom SFTP startup requires an absolute remote sftp-server path"
                            .to_string()
                    })?;
                let path = validate_sftp_server_path(configured_path)
                    .map_err(|error| format!("[SFTP_CONFIG_INVALID] {error}"))?;
                let command = quote_posix_path(&path);
                self.start_sftp_attempt(SftpRequest::Exec {
                    path: path.clone(),
                    command,
                })
                .await
                .map(|session| {
                    (
                        session,
                        SftpLaunchInfo {
                            mode: "custom_exec".to_string(),
                            server_path: Some(path),
                            diagnostic: None,
                        },
                    )
                })
                .map_err(|error| error.to_string())
            }
            SftpLaunchMode::Auto => {
                let subsystem_error = match self.start_sftp_attempt(SftpRequest::Subsystem).await {
                    Ok(session) => {
                        return Ok((
                            session,
                            SftpLaunchInfo {
                                mode: "subsystem".to_string(),
                                server_path: None,
                                diagnostic: None,
                            },
                        ));
                    }
                    Err(error) if !error.recoverable => return Err(error.to_string()),
                    Err(error) => error,
                };

                match self.probe_sftp_server().await {
                    SftpProbeResult::Found { path, diagnostic } => {
                        let command = quote_posix_path(&path);
                        match self
                            .start_sftp_attempt(SftpRequest::Exec {
                                path: path.clone(),
                                command,
                            })
                            .await
                        {
                            Ok(session) => {
                                let fallback_diagnostic = format!(
                                    "standard subsystem failed: {subsystem_error}; automatic diagnosis: {diagnostic}"
                                );
                                tracing::warn!(
                                    "SFTP subsystem failed; using direct executable fallback {}: {}",
                                    path,
                                    subsystem_error
                                );
                                Ok((
                                    session,
                                    SftpLaunchInfo {
                                        mode: "fallback_exec".to_string(),
                                        server_path: Some(path),
                                        diagnostic: Some(fallback_diagnostic),
                                    },
                                ))
                            }
                            Err(fallback_error) => Err(format!(
                                "[SFTP_AUTO_FALLBACK_FAILED] Standard subsystem failed: {subsystem_error}; automatic diagnosis: {diagnostic}; direct fallback failed: {fallback_error}. Recommended server fix: set `Subsystem sftp internal-sftp` in sshd_config, validate with `sshd -t`, then reload sshd."
                            )),
                        }
                    }
                    SftpProbeResult::NotFound { diagnostic } => Err(format!(
                        "[SFTP_AUTO_DIAGNOSIS_FAILED] Standard subsystem failed: {subsystem_error}; automatic diagnosis: {diagnostic}. The client cannot provide a missing server-side SFTP implementation. Install OpenSSH sftp-server or set `Subsystem sftp internal-sftp` in sshd_config, validate with `sshd -t`, then reload sshd."
                    )),
                    SftpProbeResult::Failed { diagnostic } => Err(format!(
                        "[SFTP_AUTO_DIAGNOSIS_FAILED] Standard subsystem failed: {subsystem_error}; automatic diagnosis could not complete: {diagnostic}. Select 'Standard subsystem only' to disable fallback, or configure an explicit absolute remote sftp-server path."
                    )),
                }
            }
        }
    }

    pub async fn open_sftp(&mut self) -> Result<russh_sftp::client::SftpSession, String> {
        self.open_sftp_with_info().await.map(|(session, _)| session)
    }

    /// 在缓存的浏览用 SFTP 通道上执行操作。
    ///
    /// 浏览类操作(list/stat/remove/mkdir/rename/read/write)此前每次都重新
    /// channel open + subsystem 协商,代价很高;这里按 SSH session 缓存一条通道复用。
    /// 操作失败(可能是通道已随断线失效)时丢弃缓存,下次调用自动重建。
    pub async fn with_browse_sftp<T, F>(&mut self, f: F) -> Result<T, String>
    where
        F: for<'a> FnOnce(
            &'a mut russh_sftp::client::SftpSession,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
        >,
    {
        if self.browse_sftp.is_none() {
            self.browse_sftp = Some(self.open_sftp().await?);
        }
        let sftp = self.browse_sftp.as_mut().expect("browse sftp just opened");
        let result = f(sftp).await;
        if result.is_err() {
            // 失败原因可能是文件不存在等业务错误,也可能是通道已死;
            // 保守起见直接失效,下一次操作重建通道。
            self.browse_sftp = None;
        }
        result
    }

    pub fn disconnect(&mut self) {
        self.resize_tx = None;
        self.browse_sftp = None;
        // 停止固定节拍心跳
        if let Some(abort) = self.heartbeat_abort.take() {
            abort.abort();
        }
        // 停止 Web 网关
        if let Some(gw) = self.web_gateway.take() {
            gw.abort.abort();
            if let Ok(conns) = gw.connections.lock() {
                for c in conns.iter() {
                    c.abort();
                }
            }
        }
        // 停止所有端口转发任务及其存量连接
        for pf in self.port_forwards.drain(..) {
            pf.abort_all();
        }
        if let Some(handle) = self.handle.take() {
            tokio::spawn(async move {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            });
        }
    }

    /// 添加本地端口转发: 本地 local_port -> 远程 remote_host:remote_port
    pub async fn add_local_port_forward(
        &mut self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, String> {
        let handle = self.handle.as_ref().ok_or("SSH not connected")?.clone();
        let remote_host = remote_host.to_string();

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
            .await
            .map_err(|e| format!("Failed to bind local port {}: {}", local_port, e))?;

        let actual_port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local addr: {}", e))?
            .port();

        let target_host = remote_host.clone();
        let target_port = remote_port;
        let connection_handles: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let connection_handles_for_loop = Arc::clone(&connection_handles);

        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((tcp_stream, addr)) => {
                        let handle = handle.clone();
                        let target_host = target_host.clone();
                        let connection_handles_inner = Arc::clone(&connection_handles_for_loop);
                        let connection_task = tokio::spawn(async move {
                            match handle
                                .channel_open_direct_tcpip(
                                    &target_host,
                                    target_port as u32,
                                    &addr.ip().to_string(),
                                    addr.port() as u32,
                                )
                                .await
                            {
                                Ok(mut channel) => {
                                    let channel_writer = channel.make_writer();
                                    let (mut tcp_reader, mut tcp_writer) =
                                        tokio::io::split(tcp_stream);

                                    // TCP -> SSH channel
                                    let mut writer = channel_writer;
                                    let upload_task = tokio::spawn(async move {
                                        let mut buf = [0u8; 8192];
                                        loop {
                                            match tokio::io::AsyncReadExt::read(
                                                &mut tcp_reader,
                                                &mut buf,
                                            )
                                            .await
                                            {
                                                Ok(0) => break,
                                                Ok(n) => {
                                                    if writer.write_all(&buf[..n]).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Err(_) => break,
                                            }
                                        }
                                    });

                                    // SSH channel -> TCP
                                    let download_task = tokio::spawn(async move {
                                        loop {
                                            match channel.wait().await {
                                                Some(ChannelMsg::Data { data }) => {
                                                    if tcp_writer.write_all(&data).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Some(ChannelMsg::ExtendedData { data, .. }) => {
                                                    if tcp_writer.write_all(&data).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Some(ChannelMsg::Eof)
                                                | Some(ChannelMsg::Close)
                                                | None => break,
                                                _ => {}
                                            }
                                        }
                                    });

                                    // 记录双向拷贝任务的 handle,移除转发时一并终止
                                    if let Ok(mut handles) = connection_handles_inner.lock() {
                                        handles.push(upload_task.abort_handle());
                                        handles.push(download_task.abort_handle());
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Local port forward: failed to open channel: {}",
                                        e
                                    );
                                }
                            }
                        });
                        if let Ok(mut handles) = connection_handles_for_loop.lock() {
                            handles.push(connection_task.abort_handle());
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.port_forwards.push(PortForwardEntry {
            forward_type: "local".to_string(),
            bound_port: actual_port,
            target_host: remote_host,
            target_port: remote_port,
            abort_handle: task.abort_handle(),
            connection_handles,
        });

        Ok(actual_port)
    }

    /// 添加 Web 代理转发: 本地 local_port -> 远程 remote_host:remote_port。
    ///
    /// 与 add_local_port_forward 的区别:客户端 -> 远端方向会先缓冲首包
    /// (直到 \r\n\r\n,上限 32KB,单次读带超时),识别为 HTTP 请求时把 Host 头
    /// 改写为 remote_host:remote_port,修复浏览器经 127.0.0.1 访问虚拟主机 /
    /// Ingress 站点返回 404 的问题;非 HTTP 流量原样透传。
    /// HTTPS(TLS 密文)无法改写,请改用 add_local_port_forward 直连。
    pub async fn add_web_proxy_forward(
        &mut self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, String> {
        let handle = self.handle.as_ref().ok_or("SSH not connected")?.clone();
        let remote_host = remote_host.to_string();

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
            .await
            .map_err(|e| format!("Failed to bind local port {}: {}", local_port, e))?;

        let actual_port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local addr: {}", e))?
            .port();

        let target_host = remote_host.clone();
        let target_port = remote_port;
        let host_header = format!("{}:{}", remote_host, remote_port);
        let connection_handles: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let connection_handles_for_loop = Arc::clone(&connection_handles);

        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((tcp_stream, addr)) => {
                        let handle = handle.clone();
                        let target_host = target_host.clone();
                        let host_header = host_header.clone();
                        let connection_handles_inner = Arc::clone(&connection_handles_for_loop);
                        let connection_task = tokio::spawn(async move {
                            match handle
                                .channel_open_direct_tcpip(
                                    &target_host,
                                    target_port as u32,
                                    &addr.ip().to_string(),
                                    addr.port() as u32,
                                )
                                .await
                            {
                                Ok(mut channel) => {
                                    let channel_writer = channel.make_writer();
                                    let (mut tcp_reader, mut tcp_writer) =
                                        tokio::io::split(tcp_stream);

                                    // TCP -> SSH channel(首包缓冲 + Host 头改写)
                                    let mut writer = channel_writer;
                                    let upload_task = tokio::spawn(async move {
                                        let mut buf = [0u8; 8192];
                                        // 1) 缓冲首包直到头部结束 / 达到上限 / 读超时
                                        let mut head: Vec<u8> = Vec::new();
                                        loop {
                                            if head.len() >= WEB_PROXY_HEAD_MAX
                                                || find_subslice(&head, b"\r\n\r\n").is_some()
                                            {
                                                break;
                                            }
                                            match timeout(
                                                Duration::from_secs(5),
                                                tokio::io::AsyncReadExt::read(
                                                    &mut tcp_reader,
                                                    &mut buf,
                                                ),
                                            )
                                            .await
                                            {
                                                Ok(Ok(0)) => break,
                                                Ok(Ok(n)) => head.extend_from_slice(&buf[..n]),
                                                // 读超时或出错:按已有数据继续,不阻塞转发
                                                _ => break,
                                            }
                                        }
                                        if !head.is_empty() {
                                            let rewritten =
                                                rewrite_host_header(&head, &host_header);
                                            if writer.write_all(&rewritten).await.is_err() {
                                                return;
                                            }
                                        }
                                        // 2) 常规双向 copy
                                        loop {
                                            match tokio::io::AsyncReadExt::read(
                                                &mut tcp_reader,
                                                &mut buf,
                                            )
                                            .await
                                            {
                                                Ok(0) => break,
                                                Ok(n) => {
                                                    if writer.write_all(&buf[..n]).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Err(_) => break,
                                            }
                                        }
                                    });

                                    // SSH channel -> TCP
                                    let download_task = tokio::spawn(async move {
                                        loop {
                                            match channel.wait().await {
                                                Some(ChannelMsg::Data { data }) => {
                                                    if tcp_writer.write_all(&data).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Some(ChannelMsg::ExtendedData { data, .. }) => {
                                                    if tcp_writer.write_all(&data).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Some(ChannelMsg::Eof)
                                                | Some(ChannelMsg::Close)
                                                | None => break,
                                                _ => {}
                                            }
                                        }
                                    });

                                    // 记录双向拷贝任务的 handle,移除转发时一并终止
                                    if let Ok(mut handles) = connection_handles_inner.lock() {
                                        handles.push(upload_task.abort_handle());
                                        handles.push(download_task.abort_handle());
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Web proxy forward: failed to open channel: {}",
                                        e
                                    );
                                }
                            }
                        });
                        if let Ok(mut handles) = connection_handles_for_loop.lock() {
                            handles.push(connection_task.abort_handle());
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.port_forwards.push(PortForwardEntry {
            forward_type: "web".to_string(),
            bound_port: actual_port,
            target_host: remote_host,
            target_port: remote_port,
            abort_handle: task.abort_handle(),
            connection_handles,
        });

        Ok(actual_port)
    }

    /// 添加远程端口转发: 远程 remote_port -> 本地 local_host:local_port
    pub async fn add_remote_port_forward(
        &mut self,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<u16, String> {
        let handle = self.handle.as_ref().ok_or("SSH not connected")?.clone();

        // 请求远程服务器监听端口
        let actual_port = handle
            .tcpip_forward("0.0.0.0", remote_port as u32)
            .await
            .map_err(|e| format!("Failed to request remote port forward: {}", e))?
            as u16;

        // 注册转发映射,供 SshHandler::server_channel_open_forwarded_tcpip 使用
        {
            let mut forwards = self.remote_forwards.lock().await;
            forwards.insert(actual_port, (local_host.to_string(), local_port));
        }

        self.port_forwards.push(PortForwardEntry {
            forward_type: "remote".to_string(),
            bound_port: actual_port,
            target_host: local_host.to_string(),
            target_port: local_port,
            // 远程转发由服务器发起,无需本地 task,用 dummy handle
            abort_handle: tokio::spawn(async {}).abort_handle(),
            connection_handles: Arc::new(std::sync::Mutex::new(Vec::new())),
        });

        Ok(actual_port)
    }

    /// 移除端口转发
    pub async fn remove_port_forward(
        &mut self,
        bound_port: u16,
        is_remote: bool,
    ) -> Result<(), String> {
        let forward_type = if is_remote { "remote" } else { "local" };

        let idx = self
            .port_forwards
            .iter()
            .position(|f| f.bound_port == bound_port && f.forward_type == forward_type)
            .ok_or_else(|| format!("Port forward not found: {} {}", forward_type, bound_port))?;

        let entry = self.port_forwards.remove(idx);
        entry.abort_all();

        if is_remote {
            // 通知服务器取消远程端口监听
            if let Some(handle) = self.handle.as_ref() {
                let _ = handle
                    .cancel_tcpip_forward("0.0.0.0", bound_port as u32)
                    .await;
            }
            // 移除映射后,handler 会拒绝后续连接
            let mut forwards = self.remote_forwards.lock().await;
            forwards.remove(&bound_port);
        }

        Ok(())
    }

    /// 列出所有活跃的端口转发
    pub fn list_port_forwards(&self) -> Vec<super::PortForwardInfo> {
        self.port_forwards
            .iter()
            .map(|f| super::PortForwardInfo {
                forward_type: f.forward_type.clone(),
                bound_port: f.bound_port,
                target_host: f.target_host.clone(),
                target_port: f.target_port,
            })
            .collect()
    }

    /// 启动 Web 网关:本地 HTTP 监听,上游经 SSH direct-tcpip 通道从服务器侧出口。幂等。
    pub async fn start_web_gateway(&mut self) -> Result<u16, String> {
        if let Some(ref gw) = self.web_gateway {
            return Ok(gw.port);
        }
        let handle = self
            .handle
            .as_ref()
            .ok_or("SSH not connected: web gateway requires an active SSH connection")?
            .clone();
        let gw = super::web_gateway::start(0, handle).await?;
        let port = gw.port;
        self.web_gateway = Some(gw);
        Ok(port)
    }

    /// 停止 Web 网关。
    pub fn stop_web_gateway(&mut self) {
        if let Some(gw) = self.web_gateway.take() {
            gw.abort.abort();
            if let Ok(conns) = gw.connections.lock() {
                for c in conns.iter() {
                    c.abort();
                }
            }
        }
    }

    /// 返回当前 Web 网关监听端口(无网关时返回 None)。
    pub fn web_gateway_port(&self) -> Option<u16> {
        self.web_gateway.as_ref().map(|gw| gw.port)
    }
}

/// Web 代理转发缓冲首包的上限(32KB):超过即认为不是常规 HTTP 请求头,原样透传。
const WEB_PROXY_HEAD_MAX: usize = 32 * 1024;

/// 在字节流中查找子串,返回首次出现的下标。
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 判断缓冲的首包是否像 HTTP 请求(请求行以方法名 + 空格开头)。
fn looks_like_http_request(head: &[u8]) -> bool {
    const METHODS: [&[u8]; 9] = [
        b"GET ",
        b"POST ",
        b"PUT ",
        b"DELETE ",
        b"HEAD ",
        b"OPTIONS ",
        b"PATCH ",
        b"TRACE ",
        b"CONNECT ",
    ];
    METHODS.iter().any(|m| head.starts_with(m))
}

/// 把 HTTP 请求头里的 `Host:` 改写为 `host`(没有 Host 头则注入到请求行之后),
/// 头部之后已缓冲的 body 字节原样保留。
///
/// 用途:浏览器经 127.0.0.1:<本地转发端口> 访问远端站点时,Host 头是本地地址,
/// 按虚拟主机 / Ingress 路由的站点会返回 404;改写成远端真实 host:port 后即可命中。
/// 非 HTTP 请求、或头部不完整(没有 \r\n\r\n)时原样返回。
fn rewrite_host_header(head: &[u8], host: &str) -> Vec<u8> {
    if !looks_like_http_request(head) {
        return head.to_vec();
    }
    let Some(head_end) = find_subslice(head, b"\r\n\r\n") else {
        return head.to_vec();
    };
    // 请求行结束:第一个 \r\n(可能恰好就是空头部时的 \r\n\r\n 起点)
    let Some(req_line_end) = find_subslice(head, b"\r\n") else {
        return head.to_vec();
    };
    if req_line_end > head_end {
        return head.to_vec();
    }

    // 扫描请求行之后的 header 行,找 Host:(大小写不敏感)
    let mut host_range: Option<(usize, usize)> = None;
    let mut pos = req_line_end + 2;
    while pos < head_end {
        let line_end = find_subslice(&head[pos..head_end], b"\r\n")
            .map(|i| pos + i)
            .unwrap_or(head_end);
        let line = &head[pos..line_end];
        if line.len() >= 5 && line[..5].eq_ignore_ascii_case(b"host:") {
            host_range = Some((pos, line_end));
            break;
        }
        pos = line_end + 2;
    }

    let mut out = Vec::with_capacity(head.len() + host.len() + 8);
    match host_range {
        Some((start, end)) => {
            out.extend_from_slice(&head[..start]);
            out.extend_from_slice(b"Host: ");
            out.extend_from_slice(host.as_bytes());
            out.extend_from_slice(&head[end..]);
        }
        None => {
            out.extend_from_slice(&head[..req_line_end]);
            out.extend_from_slice(b"\r\nHost: ");
            out.extend_from_slice(host.as_bytes());
            out.extend_from_slice(&head[req_line_end..]);
        }
    }
    out
}

/// 向 buffer 追加数据,总量达到 cap 后丢弃多余部分;返回是否发生了截断。
fn append_capped(buffer: &mut Vec<u8>, data: &[u8], cap: usize) -> bool {
    if buffer.len() >= cap {
        return !data.is_empty();
    }
    let remaining = cap - buffer.len();
    if data.len() <= remaining {
        buffer.extend_from_slice(data);
        false
    } else {
        buffer.extend_from_slice(&data[..remaining]);
        true
    }
}

fn build_sftp_probe_command() -> String {
    let candidates = SFTP_SERVER_CANDIDATES.join(" ");
    format!(
        "for p in {candidates}; do if [ -x \"$p\" ]; then printf '{SFTP_PROBE_MARKER}%s\\n' \"$p\"; exit 0; fi; done; p=$(command -v sftp-server 2>/dev/null || true); case \"$p\" in /*) if [ -x \"$p\" ]; then printf '{SFTP_PROBE_MARKER}%s\\n' \"$p\"; exit 0; fi ;; esac; printf '{SFTP_PROBE_NONE_MARKER}\\n'"
    )
}

fn validate_sftp_server_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("remote sftp-server path is empty".to_string());
    }
    if path.len() > 4096 {
        return Err("remote sftp-server path exceeds 4096 bytes".to_string());
    }
    if !path.starts_with('/') {
        return Err(format!(
            "remote sftp-server path must be an absolute Unix path, got: {path}"
        ));
    }
    if path.chars().any(char::is_control) {
        return Err("remote sftp-server path contains control characters".to_string());
    }
    Ok(path.to_string())
}

fn quote_posix_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\"'\"'"))
}

fn extend_limited(target: &mut Vec<u8>, data: &[u8]) {
    const MAX_PROBE_OUTPUT_BYTES: usize = 64 * 1024;
    let remaining = MAX_PROBE_OUTPUT_BYTES.saturating_sub(target.len());
    target.extend_from_slice(&data[..data.len().min(remaining)]);
}

fn normalize_error_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}

fn format_probe_details(output: &RemoteProbeOutput) -> Option<String> {
    let mut details = Vec::new();
    let stderr = normalize_error_text(&String::from_utf8_lossy(&output.stderr));
    if !stderr.is_empty() {
        details.push(format!("remote stderr: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let relevant_stdout = stdout
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with(SFTP_PROBE_MARKER)
                && *line != SFTP_PROBE_NONE_MARKER
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if !relevant_stdout.is_empty() {
        details.push(format!("remote stdout: {relevant_stdout}"));
    }
    if let Some(exit_status) = output.exit_status {
        details.push(format!("remote exit status: {exit_status}"));
    }
    if let Some(exit_signal) = &output.exit_signal {
        details.push(format!("remote exit signal: {exit_signal}"));
    }

    (!details.is_empty()).then(|| details.join("; "))
}

// ====== Free functions ======

/// 执行主认证: password / key / password+key
/// 返回 Ok(remaining_methods) — 成功时 remaining_methods 为空,失败时包含服务器允许的后续方法
async fn authenticate_primary(
    handle: &mut Handle<super::auth::SshHandler>,
    username: &str,
    auth: &SshAuth,
) -> Result<MethodSet, String> {
    match auth {
        SshAuth::Password(password) => {
            let result = handle
                .authenticate_password(username, password.as_str())
                .await
                .map_err(|e| format!("[AUTH_FAILED] Password auth failed: {}", e))?;
            if result.success() {
                Ok(MethodSet::empty())
            } else {
                let remaining = match &result {
                    client::AuthResult::Failure {
                        remaining_methods, ..
                    } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!("Password auth rejected, remaining methods: {:?}", remaining);
                Ok(remaining)
            }
        }
        SshAuth::PrivateKey { key, passphrase } => {
            let key_pair = decode_private_key(key, passphrase.as_deref())?;
            let key_with_hash =
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key_pair), None);
            let result = handle
                .authenticate_publickey(username, key_with_hash)
                .await
                .map_err(|e| format!("[AUTH_FAILED] Public key auth failed: {}", e))?;
            if result.success() {
                Ok(MethodSet::empty())
            } else {
                let remaining = match &result {
                    client::AuthResult::Failure {
                        remaining_methods, ..
                    } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!(
                    "Public key auth rejected, remaining methods: {:?}",
                    remaining
                );
                Ok(remaining)
            }
        }
        SshAuth::PasswordAndKey {
            password,
            key,
            passphrase,
        } => {
            let key_pair = decode_private_key(key, passphrase.as_deref())?;
            let key_with_hash =
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key_pair), None);
            let pk_result = handle
                .authenticate_publickey(username, key_with_hash)
                .await
                .map_err(|e| format!("[AUTH_FAILED] Public key auth failed: {}", e))?;
            if pk_result.success() {
                // 公钥认证成功,继续密码认证(第二步)
                let result = handle
                    .authenticate_password(username, password.as_str())
                    .await
                    .map_err(|e| format!("[AUTH_FAILED] Password auth failed: {}", e))?;
                if result.success() {
                    Ok(MethodSet::empty())
                } else {
                    let remaining = match &result {
                        client::AuthResult::Failure {
                            remaining_methods, ..
                        } => remaining_methods.clone(),
                        _ => MethodSet::empty(),
                    };
                    debug!(
                        "Password+Key password step rejected, remaining: {:?}",
                        remaining
                    );
                    Ok(remaining)
                }
            } else {
                let remaining = match &pk_result {
                    client::AuthResult::Failure {
                        remaining_methods, ..
                    } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!("Password+Key key step rejected, remaining: {:?}", remaining);
                Ok(remaining)
            }
        }
    }
}

/// 解析用户输入的 SSH 私钥。
///
/// UTF-8 BOM 常见于 Windows 文本编辑器导出的 PEM；去掉 BOM 不会改变密钥正文。
/// OpenSSH 私钥内部的 comment 按 RFC 4251 可以是任意字节，russh 0.61+ 会保留
/// 原始 comment，而不是把它强制解释为 UTF-8。
fn decode_private_key(
    key: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::PrivateKey, String> {
    let normalized = key.trim_start_matches('\u{feff}');
    // Normalize CRLF -> LF (Windows line endings from Notepad etc.)
    let normalized = normalized.replace("\r\n", "\n");
    russh::keys::decode_secret_key(&normalized, passphrase)
        .map_err(|error| format!("[KEY_PARSE] Failed to parse private key: {error}"))
}

/// 执行 keyboard-interactive MFA（驱动 russh 的 start/respond API）
async fn authenticate_keyboard_interactive(
    handle: &mut Handle<super::auth::SshHandler>,
    username: &str,
    kb_config: &Option<super::KeyboardInteractiveConfig>,
    session_id: &str,
    app_handle: Option<&tauri::AppHandle>,
    pending_kb: &super::PendingKeyboardResponses,
) -> Result<(), String> {
    let kb = kb_config.as_ref().ok_or("kb_interactive config missing")?;
    if !kb.enabled {
        return Ok(());
    }

    let kb_password = kb.password.clone();

    // 启动 keyboard-interactive 认证
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None::<String>)
        .await
        .map_err(|e| format!("[MFA_FAILED] Keyboard-interactive start failed: {}", e))?;

    loop {
        match response {
            russh::client::KeyboardInteractiveAuthResponse::Success => break,
            russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("[MFA_FAILED] Keyboard-interactive authentication rejected".to_string());
            }
            russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                name: _name,
                instructions,
                prompts,
            } => {
                // 生成 auto-fill:仅密码类提示预填 MFA 主密码,TOTP 提示留空让
                // 用户手动输入;其余提示(堡垒机「选择机器」菜单、验证码等)也
                // 留空,避免把主密码误填进机器编号等非密码输入框导致后续卡住。
                let auto_fill: Vec<Option<String>> = prompts
                    .iter()
                    .map(|p| {
                        if is_totp_prompt(&p.prompt) {
                            None // TOTP 码由用户手动输入
                        } else if is_password_prompt(&p.prompt) {
                            kb_password.clone()
                        } else {
                            None // 菜单 / 机器选择等:留空由用户填写
                        }
                    })
                    .collect();

                // 创建 oneshot 等待前端响应（必须在 emit 之前，防止前端回调到达时 oneshot 还没就位）
                let (resp_tx, resp_rx) = oneshot::channel();
                pending_kb
                    .lock()
                    .await
                    .insert(session_id.to_string(), resp_tx);

                // 发送 Tauri 事件到前端（始终弹窗,让用户确认/输入 TOTP 码）
                let payload = serde_json::json!({
                    "sessionId": session_id,
                    "instructions": instructions,
                    "prompts": prompts.iter().map(|p| serde_json::json!({"prompt": p.prompt, "echo": p.echo})).collect::<Vec<_>>(),
                    "autoFill": auto_fill,
                });
                if let Some(app) = app_handle {
                    // 精确事件:交互终端 / 测试连接按 sessionId 订阅,各自弹输入框。
                    let _ = app.emit(&format!("ssh:kb-interactive:{}", session_id), payload.clone());
                    // 通用事件:AI 域工具会话(connId `dsh:{assetId}:ssh`)由主壳 MFA
                    // 确认卡订阅(无可预测的固定后缀),应答仍按 payload.sessionId 回传。
                    let _ = app.emit("ssh:kb-interactive", payload);
                }

                // 等待前端 ssh_kb_response（360s 超时）
                let responses = match tokio::time::timeout(Duration::from_secs(360), resp_rx).await
                {
                    Ok(Ok(r)) => r,
                    Ok(Err(_)) => {
                        pending_kb.lock().await.remove(session_id);
                        return Err("[MFA_FAILED] Keyboard-interactive response channel dropped"
                            .to_string());
                    }
                    Err(_) => {
                        pending_kb.lock().await.remove(session_id);
                        return Err(
                            "[MFA_TIMEOUT] Keyboard-interactive response timed out (360s)"
                                .to_string(),
                        );
                    }
                };

                if responses.len() != prompts.len() {
                    return Err(format!(
                        "[MFA_FAILED] Response count mismatch: expected {}, got {}",
                        prompts.len(),
                        responses.len()
                    ));
                }

                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| {
                        format!("[MFA_FAILED] Keyboard-interactive respond failed: {}", e)
                    })?;
            }
        }
    }

    Ok(())
}

/// 判断 prompt 是否匹配 TOTP 关键词
fn is_totp_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains("totp")
        || lower.contains("verification")
        || lower.contains("otp")
        || lower.contains("code")
        || lower.contains("token")
        || lower.contains("one-time")
        || lower.contains("authenticator")
        || lower.contains("2fa")
        || lower.contains("2sv")
        || lower.contains("mfa")
        || lower.contains("passcode")
        || lower.contains("dynamic") // 动态口令 / dynamic token
        || lower.contains("验证")
        || lower.contains("令牌")
        || lower.contains("一次性")
        || lower.contains("动态") // 动态口令 / 动态密码 / 动态令牌
        || lower.contains("短信")
}

/// 判断 prompt 是否为密码类提示(仅此类预填 MFA 主密码)。
/// 注意:先经 is_totp_prompt 判定,「动态口令 / one-time password」等
/// TOTP 类提示不会到达这里。
fn is_password_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("passphrase")
        || lower.contains("密码")
        || lower.contains("口令")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENSSH_ED25519_KEY: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCzPq7zfqLffKoBDe/eo04kH2XxtSmk9D7RQyf1xUqrYgAAAJgAIAxdACAM
XQAAAAtzc2gtZWQyNTUxOQAAACCzPq7zfqLffKoBDe/eo04kH2XxtSmk9D7RQyf1xUqrYg
AAAEC2BsIi0QwW2uFscKTUUXNHLsYX4FxlaSDSblbAj7WR7bM+rvN+ot98qgEN796jTiQf
ZfG1KaT0PtFDJ/XFSqtiAAAAEHVzZXJAZXhhbXBsZS5jb20BAgMEBQ==
-----END OPENSSH PRIVATE KEY-----"#;

    /// 判断是否为「堡垒机 pty exec」场景:启用 keyboard-interactive MFA 即可。
    /// 覆盖「跳板机 + kb」与「直连堡垒机 + kb」两种形态(直连堡垒机如阿里云
    /// BastionHost 公网入口,host 即堡垒机、无 jump_host)。
    #[test]
    fn is_bastion_requires_kb_enabled_only() {
        let plain: SshConfig = serde_json::from_str(
            r#"{"host":"h","port":22,"username":"u","auth":{"Password":"p"}}"#,
        )
        .unwrap();
        assert!(!SshSession::new(plain).is_bastion());

        // 只配跳板机、未启用 kb → 不是堡垒机 pty 场景
        let jump_only: SshConfig = serde_json::from_str(
            r#"{"host":"h","port":22,"username":"u","auth":{"Password":"p"},"jump_host":"b"}"#,
        )
        .unwrap();
        assert!(!SshSession::new(jump_only).is_bastion());

        // 跳板机 + kb 启用(无论有无主密码)→ 是
        let bastion: SshConfig = serde_json::from_str(
            r#"{"host":"h","port":22,"username":"u","auth":{"Password":"p"},"jump_host":"b","kb_interactive":{"enabled":true,"password":"pw"}}"#,
        )
        .unwrap();
        assert!(SshSession::new(bastion).is_bastion());

        // kb 启用但无跳板机 → 是:直连堡垒机(host 即堡垒机)同样需要选机器
        let kb_only: SshConfig = serde_json::from_str(
            r#"{"host":"h","port":22,"username":"u","auth":{"Password":"p"},"kb_interactive":{"enabled":true}}"#,
        )
        .unwrap();
        assert!(SshSession::new(kb_only).is_bastion());
    }

    #[test]
    fn rewrite_host_header_replaces_existing_host() {
        let head =
            b"GET /admin HTTP/1.1\r\nHost: 127.0.0.1:51234\r\nUser-Agent: x\r\n\r\nbody-bytes";
        let out = rewrite_host_header(head, "10.0.0.5:8080");
        assert_eq!(
            out,
            b"GET /admin HTTP/1.1\r\nHost: 10.0.0.5:8080\r\nUser-Agent: x\r\n\r\nbody-bytes"
                .to_vec()
        );
    }

    #[test]
    fn rewrite_host_header_injects_missing_host_after_request_line() {
        let head = b"GET / HTTP/1.0\r\n\r\n";
        let out = rewrite_host_header(head, "example.internal:9000");
        assert_eq!(
            out,
            b"GET / HTTP/1.0\r\nHost: example.internal:9000\r\n\r\n".to_vec()
        );
    }

    #[test]
    fn rewrite_host_header_matches_host_case_insensitively() {
        let head = b"POST /api HTTP/1.1\r\nhost: 127.0.0.1:1\r\nContent-Length: 0\r\n\r\n";
        let out = rewrite_host_header(head, "a.b:80");
        assert_eq!(
            out,
            b"POST /api HTTP/1.1\r\nHost: a.b:80\r\nContent-Length: 0\r\n\r\n".to_vec()
        );
    }

    #[test]
    fn rewrite_host_header_passes_through_non_http() {
        let head = b"\x00\x01binary-garbage\r\n\r\nnot http";
        assert_eq!(rewrite_host_header(head, "a.b:80"), head.to_vec());
    }

    #[test]
    fn rewrite_host_header_passes_through_incomplete_header() {
        // 没有 \r\n\r\n 的不完整头部不改写,避免破坏流式数据
        let head = b"GET / HTTP/1.1\r\nHost: 127";
        assert_eq!(rewrite_host_header(head, "a.b:80"), head.to_vec());
    }

    #[test]
    fn private_key_parser_accepts_binary_openssh_comments() {
        let mut key = decode_private_key(OPENSSH_ED25519_KEY, None).unwrap();
        let binary_comment = vec![0x47, 0x42, 0x4b, 0xff, 0xfe];
        key.set_comment(binary_comment.clone());
        let pem = key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();

        let reparsed = decode_private_key(&pem, None).unwrap();
        assert_eq!(reparsed.comment().as_bytes(), binary_comment);
    }

    #[test]
    fn private_key_parser_ignores_utf8_bom() {
        let key_with_bom = format!("\u{feff}{OPENSSH_ED25519_KEY}");
        assert!(decode_private_key(&key_with_bom, None).is_ok());
    }

    #[test]
    fn private_key_parser_normalizes_crlf() {
        let key_with_crlf = OPENSSH_ED25519_KEY.replace('\n', "\r\n");
        assert!(decode_private_key(&key_with_crlf, None).is_ok());
    }

    #[test]
    fn test_is_totp_prompt_english() {
        assert!(is_totp_prompt("Enter your TOTP code"));
        assert!(is_totp_prompt("Verification code"));
        assert!(is_totp_prompt("OTP token required"));
        assert!(is_totp_prompt("One-time password"));
        assert!(is_totp_prompt("Please enter verification code"));
        assert!(is_totp_prompt("Google Authenticator code"));
        assert!(is_totp_prompt("Enter 2FA passcode"));
        assert!(is_totp_prompt("MFA code from your device"));
        assert!(is_totp_prompt("Dynamic token"));
    }

    #[test]
    fn test_is_totp_prompt_chinese() {
        assert!(is_totp_prompt("请输入验证码"));
        assert!(is_totp_prompt("动态令牌验证"));
        assert!(is_totp_prompt("一次性密码"));
        assert!(is_totp_prompt("请输入动态口令"));
        assert!(is_totp_prompt("短信验证码"));
        assert!(is_totp_prompt("输入动态密码"));
    }

    #[test]
    fn test_is_totp_prompt_negative() {
        assert!(!is_totp_prompt("Enter your password"));
        assert!(!is_totp_prompt("Username"));
        assert!(!is_totp_prompt(""));
    }

    #[test]
    fn test_is_password_prompt_matches_password_like_prompts() {
        assert!(is_password_prompt("Password:"));
        assert!(is_password_prompt("Enter your password"));
        assert!(is_password_prompt("Passphrase"));
        assert!(is_password_prompt("请输入密码"));
        assert!(is_password_prompt("输入口令"));
        // 含「口令」的提示(如“动态口令”)按函数契约也算密码类;autoFill 里
        // is_totp_prompt 先判定,「动态口令」等 TOTP 类提示不会走到预填分支。
        assert!(is_password_prompt("请输入动态口令"));
    }

    #[test]
    fn test_is_password_prompt_ignores_choice_and_menu_prompts() {
        // 堡垒机「选择机器」等菜单提示:必须留空,绝不能预填主密码
        assert!(!is_password_prompt("Please select the target host:"));
        assert!(!is_password_prompt("请选择要连接的机器:"));
        assert!(!is_password_prompt("请输入机器编号"));
        assert!(!is_password_prompt("Verification code"));
        assert!(!is_password_prompt("Username"));
        assert!(!is_password_prompt(""));
    }

    #[test]
    fn sftp_server_path_requires_an_absolute_unix_path() {
        assert_eq!(
            validate_sftp_server_path(" /usr/libexec/openssh/sftp-server ").unwrap(),
            "/usr/libexec/openssh/sftp-server"
        );
        assert!(validate_sftp_server_path("usr/lib/openssh/sftp-server").is_err());
        assert!(validate_sftp_server_path("/usr/lib/openssh/sftp-server\nmalicious").is_err());
    }

    #[test]
    fn sftp_server_path_is_shell_quoted_as_data() {
        assert_eq!(
            quote_posix_path("/opt/vendor's ssh/sftp-server"),
            "'/opt/vendor'\"'\"'s ssh/sftp-server'"
        );
    }

    #[test]
    fn sftp_probe_command_covers_common_server_layouts() {
        let command = build_sftp_probe_command();
        for candidate in SFTP_SERVER_CANDIDATES {
            assert!(command.contains(candidate));
        }
        assert!(command.contains(SFTP_PROBE_MARKER));
        assert!(command.contains(SFTP_PROBE_NONE_MARKER));
        assert!(command.contains("command -v sftp-server"));
    }

    #[test]
    fn sftp_probe_details_preserve_real_remote_errors() {
        let output = RemoteProbeOutput {
            stderr: b"/bin/sh: sftp-server: not found\n".to_vec(),
            exit_status: Some(127),
            ..Default::default()
        };
        assert_eq!(
            format_probe_details(&output).as_deref(),
            Some("remote stderr: /bin/sh: sftp-server: not found; remote exit status: 127")
        );
    }
}
