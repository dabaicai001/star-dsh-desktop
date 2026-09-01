use russh::client;
use russh::keys::HashAlg;
use russh::keys::PublicKey;
use russh::{ChannelMsg, ChannelOpenFailure};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex};

/// 远程端口转发映射表: remote_port -> (local_host, local_port)
pub type RemoteForwards = Arc<Mutex<HashMap<u16, (String, u16)>>>;

/// connId 以 `dsh:` 开头的是 AI 域工具会话(见 harness/domain.rs 的
/// `ai_ssh_conn_id`,形如 `dsh:{assetId}:ssh`)。
fn is_ai_session(session_id: &str) -> bool {
    session_id.starts_with("dsh:")
}

pub struct SshHandler {
    pub session_id: String,
    pub app_handle: Option<tauri::AppHandle>,
    pub pending_hostkey: super::PendingHostKeyResponses,
    pub host: String,
    pub port: u16,
    pub remote_forwards: RemoteForwards,
}

impl SshHandler {
    pub fn new(
        session_id: String,
        app_handle: Option<tauri::AppHandle>,
        pending_hostkey: super::PendingHostKeyResponses,
        host: String,
        port: u16,
        remote_forwards: RemoteForwards,
    ) -> Self {
        Self {
            session_id,
            app_handle,
            pending_hostkey,
            host,
            port,
            remote_forwards,
        }
    }
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        if super::known_hosts::is_known(&self.host, self.port, server_public_key).await {
            return Ok(true);
        }

        // AI 域工具会话(dsh: 前缀)不弹交互确认:无人值守执行场景无法答题,
        // 此前会发出无人订阅的 hostkey-confirm 事件,静默等满 60s 才以
        // [HOSTKEY_TIMEOUT] 失败,用户完全不知道要先信任主机。与 Docker over
        // SSH 的既有约定一致:未知主机密钥需先在 SSH 终端连接一次,
        // 选择「信任并保存」写入 known_hosts,之后 AI 会话即可复用。
        if is_ai_session(&self.session_id) {
            return Err(anyhow::anyhow!(
                "[HOSTKEY_UNKNOWN] 主机 {}:{} 尚未确认主机密钥,请先在 SSH 终端连接一次并选择「信任并保存」",
                self.host,
                self.port
            ));
        }

        let app_handle = match &self.app_handle {
            Some(h) => h,
            None => {
                return Err(anyhow::anyhow!(
                    "[HOSTKEY_REJECTED] No UI available to confirm host key for {}:{}",
                    self.host,
                    self.port
                ));
            }
        };

        let sha256 = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = server_public_key
            .to_string()
            .split_whitespace()
            .next()
            .unwrap_or("unknown")
            .to_string();

        let (tx, rx) = oneshot::channel::<(bool, bool)>();
        {
            let mut pending = self.pending_hostkey.lock().await;
            pending.insert(self.session_id.clone(), tx);
        }

        let payload = serde_json::json!({
            "hostname": self.host,
            "port": self.port,
            "remote": format!("{}:{}", self.host, self.port),
            "keyType": key_type,
            "sha256": sha256,
        });
        let _ = app_handle.emit(&format!("ssh:hostkey-confirm:{}", self.session_id), payload);

        let (allowed, persist) =
            match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
                Ok(Ok(v)) => v,
                Ok(Err(_)) => {
                    // 通道被丢弃(disconnect 清理或新 connect 顶掉本条):不能盲目
                    // remove(session_id),否则会误删仍在等待的新 sender。让清理交给
                    // disconnect / 超时 / 新 connect 的 insert 覆盖。
                    return Err(anyhow::anyhow!(
                        "[HOSTKEY_REJECTED] Host key prompt channel dropped"
                    ));
                }
                Err(_) => {
                    let mut pending = self.pending_hostkey.lock().await;
                    pending.remove(&self.session_id);
                    return Err(anyhow::anyhow!(
                        "[HOSTKEY_TIMEOUT] Host key verification timed out for {}:{}",
                        self.host,
                        self.port
                    ));
                }
            };

        if allowed {
            if persist {
                let _ =
                    super::known_hosts::add_host(&self.host, self.port, server_public_key).await;
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        mut channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = {
            let forwards = self.remote_forwards.lock().await;
            forwards.get(&(connected_port as u16)).cloned()
        };

        let Some((local_host, local_port)) = target else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };

        let stream = match tokio::net::TcpStream::connect((local_host.as_str(), local_port)).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    session_id = %self.session_id,
                    local_host = %local_host,
                    local_port,
                    error = %e,
                    "Remote port forward: failed to connect to local target"
                );
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
                return Ok(());
            }
        };

        reply.accept().await;

        let mut channel_writer = channel.make_writer();
        let (mut tcp_reader, mut tcp_writer) = tokio::io::split(stream);

        // TCP -> SSH channel
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            loop {
                match tokio::io::AsyncReadExt::read(&mut tcp_reader, &mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if channel_writer.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // SSH channel -> TCP
        tokio::spawn(async move {
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
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_ai_session() {
        // AI 域工具会话(harness/domain.rs ai_ssh_conn_id)
        assert!(is_ai_session("dsh:asset-1:ssh"));
        // 交互终端(资产 id)与测试连接(test-*)不走 AI 分支
        assert!(!is_ai_session("asset-1"));
        assert!(!is_ai_session("test-1712345678901"));
        assert!(!is_ai_session(""));
    }
}
