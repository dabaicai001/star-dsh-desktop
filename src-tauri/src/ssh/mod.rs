pub mod auth;
pub mod known_hosts;
pub mod session;
pub mod sftp;
mod sftp_transport;
pub mod web_gateway;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

pub type PendingKeyboardResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Vec<String>>>>>;
pub type PendingHostKeyResponses = Arc<Mutex<HashMap<String, oneshot::Sender<(bool, bool)>>>>;
/// 堡垒机 AI exec 的「选择机器」等待通道:session_id → 用户选择的机器项(字符串)。
/// 方案A(v0.95.6):跳板机 + kb_interactive 的资产,AI exec 改走带 pty 的 shell,
/// 先由用户在命令行卡里选机器,再把选择 + AI 命令写入同一 pty 执行。
pub type PendingBastionResponses = Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>;
pub type SshWriteChannels = Arc<Mutex<HashMap<String, (u64, tokio::sync::mpsc::Sender<Vec<u8>>)>>>;

/// 端口转发信息(返回给前端)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardInfo {
    /// 转发类型: "local" 或 "remote"
    pub forward_type: String,
    /// 监听端口(本地转发: 本地端口; 远程转发: 远程端口)
    pub bound_port: u16,
    /// 目标主机
    pub target_host: String,
    /// 目标端口
    pub target_port: u16,
}

pub const DEFAULT_SFTP_TIMEOUT_SEC: u64 = 30;
pub const MIN_SFTP_TIMEOUT_SEC: u64 = 5;
pub const MAX_SFTP_TIMEOUT_SEC: u64 = 300;
pub const DEFAULT_PTY_COLS: u32 = 80;
pub const DEFAULT_PTY_ROWS: u32 = 24;
const MIN_PTY_DIMENSION: u32 = 2;
const MAX_PTY_DIMENSION: u32 = 10_000;

const fn default_sftp_timeout_sec() -> u64 {
    DEFAULT_SFTP_TIMEOUT_SEC
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpLaunchMode {
    #[default]
    Auto,
    Subsystem,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub pty_cols: Option<u32>,
    #[serde(default)]
    pub pty_rows: Option<u32>,
    #[serde(default = "default_sftp_timeout_sec")]
    pub sftp_timeout_sec: u64,
    #[serde(default)]
    pub sftp_launch_mode: SftpLaunchMode,
    #[serde(default)]
    pub sftp_server_path: Option<String>,
    #[serde(default)]
    pub kb_interactive: Option<KeyboardInteractiveConfig>,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_username: Option<String>,
    #[serde(default)]
    pub jump_auth: Option<SshAuth>,
}

impl SshConfig {
    pub fn effective_pty_size(&self) -> (u32, u32) {
        (
            self.pty_cols
                .unwrap_or(DEFAULT_PTY_COLS)
                .clamp(MIN_PTY_DIMENSION, MAX_PTY_DIMENSION),
            self.pty_rows
                .unwrap_or(DEFAULT_PTY_ROWS)
                .clamp(MIN_PTY_DIMENSION, MAX_PTY_DIMENSION),
        )
    }

    pub fn effective_sftp_timeout_sec(&self) -> u64 {
        self.sftp_timeout_sec
            .clamp(MIN_SFTP_TIMEOUT_SEC, MAX_SFTP_TIMEOUT_SEC)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshAuth {
    Password(String),
    PrivateKey {
        key: String,
        passphrase: Option<String>,
    },
    PasswordAndKey {
        password: String,
        key: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyboardInteractiveConfig {
    pub enabled: bool,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SshSessionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_auth_password_serde() {
        let json = r#"{"Password":"mypassword"}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(matches!(auth, SshAuth::Password(ref p) if p == "mypassword"));
        let back = serde_json::to_string(&auth).unwrap();
        assert_eq!(back, json);
    }

    #[test]
    fn test_ssh_auth_private_key_serde() {
        let json = r#"{"PrivateKey":{"key":"-----BEGIN RSA PRIVATE KEY-----\n...","passphrase":"mysecret"}}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(
            matches!(auth, SshAuth::PrivateKey { ref key, ref passphrase }
            if key == "-----BEGIN RSA PRIVATE KEY-----\n..." && passphrase.as_deref() == Some("mysecret"))
        );
    }

    #[test]
    fn test_ssh_auth_private_key_no_passphrase() {
        let json = r#"{"PrivateKey":{"key":"keydata","passphrase":null}}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(matches!(auth, SshAuth::PrivateKey { ref passphrase, .. }
            if passphrase.is_none()));
    }

    #[test]
    fn test_ssh_auth_password_and_key() {
        let json = r#"{"PasswordAndKey":{"password":"pwd","key":"keydata","passphrase":null}}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(matches!(auth, SshAuth::PasswordAndKey { .. }));
    }

    #[test]
    fn test_kb_interactive_config_defaults() {
        let json = r#"{"enabled":true}"#;
        let config: KeyboardInteractiveConfig = serde_json::from_str(json).unwrap();
        assert!(config.enabled);
        assert!(config.password.is_none());
    }

    #[test]
    fn test_ssh_config_minimal_serde() {
        let json = r#"{"host":"localhost","port":22,"username":"root","auth":{"Password":""}}"#;
        let config: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 22);
        assert!(config.jump_host.is_none());
        assert_eq!(config.sftp_timeout_sec, DEFAULT_SFTP_TIMEOUT_SEC);
        assert_eq!(config.sftp_launch_mode, SftpLaunchMode::Auto);
        assert!(config.sftp_server_path.is_none());
        assert_eq!(
            config.effective_pty_size(),
            (DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS)
        );
    }

    #[test]
    fn test_ssh_config_with_jump_host() {
        let json = r#"{"host":"target","port":22,"username":"user","auth":{"Password":"pass"},"jump_host":"bastion","jump_port":2222,"jump_username":"jumpuser","jump_auth":{"Password":"jumppass"}}"#;
        let config: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.jump_host.as_deref(), Some("bastion"));
        assert_eq!(config.jump_port, Some(2222));
        assert_eq!(config.jump_username.as_deref(), Some("jumpuser"));
        assert!(config.jump_auth.is_some());
    }

    #[test]
    fn test_sftp_timeout_is_clamped_to_supported_range() {
        let mut config: SshConfig = serde_json::from_str(
            r#"{"host":"localhost","port":22,"username":"root","auth":{"Password":""},"sftp_timeout_sec":1}"#,
        )
        .unwrap();
        assert_eq!(config.effective_sftp_timeout_sec(), MIN_SFTP_TIMEOUT_SEC);

        config.sftp_timeout_sec = 600;
        assert_eq!(config.effective_sftp_timeout_sec(), MAX_SFTP_TIMEOUT_SEC);
    }

    #[test]
    fn test_pty_size_serde_and_clamping() {
        let mut config: SshConfig = serde_json::from_str(
            r#"{"host":"localhost","port":22,"username":"root","auth":{"Password":""},"pty_cols":180,"pty_rows":52}"#,
        )
        .unwrap();
        assert_eq!(config.effective_pty_size(), (180, 52));

        config.pty_cols = Some(0);
        config.pty_rows = Some(20_000);
        assert_eq!(
            config.effective_pty_size(),
            (MIN_PTY_DIMENSION, MAX_PTY_DIMENSION)
        );
    }

    #[test]
    fn test_sftp_launch_mode_serde() {
        let config: SshConfig = serde_json::from_str(
            r#"{"host":"localhost","port":22,"username":"root","auth":{"Password":""},"sftp_launch_mode":"custom","sftp_server_path":"/usr/libexec/openssh/sftp-server"}"#,
        )
        .unwrap();

        assert_eq!(config.sftp_launch_mode, SftpLaunchMode::Custom);
        assert_eq!(
            config.sftp_server_path.as_deref(),
            Some("/usr/libexec/openssh/sftp-server")
        );
    }
}
