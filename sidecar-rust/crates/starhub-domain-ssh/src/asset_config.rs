//! 资产存档 JSON → [`SshConfig`] 的纯映射(去 Tauri 化 M1 从
//! `src-tauri/src/commands/ssh.rs::asset_ssh_config` 平移)。
//!
//! 只保留与存储无关的部分:行读取(SQLite / sidecar 的 assets.json)与
//! Keyring 密钥合并留在各自宿主,映射语义两侧必须逐字一致——
//! 同一份资产存档在 Tauri 壳与 sidecar 下必须解析出同一条连接配置。

use serde_json::Value;

use crate::{
    KeyboardInteractiveConfig, SftpLaunchMode, SshAuth, SshConfig, DEFAULT_SFTP_TIMEOUT_SEC,
};

/// 把资产 `config_json`(已合并 Keyring 密钥)解析为 SSH 连接配置。
///
/// `asset_name` 只用于错误文案(与旧实现一致)。语义与前端
/// `src/services/ssh.ts assetConfigToSshConfig` 对齐;密码/私钥等敏感字段
/// 由调用方在合并阶段注入,本函数绝不读写任何持久化。
pub fn ssh_config_from_asset(asset_name: &str, config: &Value) -> Result<SshConfig, String> {
    let get = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
    let get_bool =
        |key: &str, default: bool| config.get(key).and_then(Value::as_bool).unwrap_or(default);
    let port = config
        .get("port")
        .and_then(Value::as_u64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let username = get("username");
    if get("host").is_empty() || username.is_empty() {
        return Err(format!(
            "SSH 资产「{asset_name}」配置不完整(缺 host 或 username)"
        ));
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

    // 堡垒机模式显式声明:None = 旧行为(MFA 资产一律按堡垒机,存量零回归);
    // Some(false) = 普通 MFA 服务器(2FA 后是普通 shell),AI exec 不弹「选机器」。
    let bastion_mode = config.get("bastionMode").and_then(Value::as_bool);

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

    Ok(SshConfig {
        host: get("host").to_string(),
        port,
        username: username.to_string(),
        auth,
        pty_cols: None,
        pty_rows: None,
        sftp_timeout_sec: config
            .get("sftpTimeoutSec")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_SFTP_TIMEOUT_SEC),
        sftp_launch_mode,
        sftp_server_path: {
            let value = get("sftpServerPath");
            (!value.is_empty()).then(|| value.to_string())
        },
        kb_interactive,
        bastion_mode,
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_minimal_asset_to_password_auth() {
        let config = ssh_config_from_asset(
            "prod-1",
            &json!({ "host": "10.0.0.7", "port": 2222, "username": "root", "password": "pw" }),
        )
        .expect("maps");
        assert_eq!(config.host, "10.0.0.7");
        assert_eq!(config.port, 2222);
        assert_eq!(config.username, "root");
        assert!(matches!(config.auth, SshAuth::Password(ref p) if p == "pw"));
        assert_eq!(config.sftp_timeout_sec, DEFAULT_SFTP_TIMEOUT_SEC);
        assert!(config.jump_host.is_none());
        // 端口缺省 22
        let default_port = ssh_config_from_asset("x", &json!({"host":"h","username":"u"})).unwrap();
        assert_eq!(default_port.port, 22);
        assert!(matches!(default_port.auth, SshAuth::Password(ref p) if p.is_empty()));
    }

    #[test]
    fn rejects_asset_missing_host_or_username() {
        let err = ssh_config_from_asset("prod-1", &json!({ "username": "root" })).unwrap_err();
        assert!(err.contains("配置不完整"), "{err}");
        assert!(err.contains("prod-1"), "错误文案带资产名: {err}");
    }

    #[test]
    fn password_and_key_auth_requires_both_present() {
        let both = ssh_config_from_asset(
            "a",
            &json!({
                "host": "h", "username": "u", "password": "p",
                "privateKey": "KEY", "usePasswordAuth": true, "useKeyAuth": true,
            }),
        )
        .unwrap();
        assert!(matches!(both.auth, SshAuth::PasswordAndKey { .. }));

        // useKeyAuth 关掉:只剩密码
        let password_only = ssh_config_from_asset(
            "a",
            &json!({ "host": "h", "username": "u", "password": "p", "privateKey": "KEY" }),
        )
        .unwrap();
        assert!(matches!(password_only.auth, SshAuth::Password(ref p) if p == "p"));
    }

    #[test]
    fn mfa_enables_keyboard_interactive_and_bastion_default() {
        let config = ssh_config_from_asset(
            "bastion",
            &json!({
                "host": "h", "username": "u", "password": "p",
                "mfaEnabled": true, "mfaPassword": "123456",
            }),
        )
        .unwrap();
        let kb = config.kb_interactive.expect("kb_interactive enabled");
        assert!(kb.enabled);
        assert_eq!(kb.password.as_deref(), Some("123456"));
        // bastionMode 缺省 None = 旧行为(MFA 资产一律按堡垒机)
        assert_eq!(config.bastion_mode, None);

        let plain = ssh_config_from_asset(
            "plain-mfa",
            &json!({ "host": "h", "username": "u", "password": "p", "mfaEnabled": true, "bastionMode": false }),
        )
        .unwrap();
        assert_eq!(plain.bastion_mode, Some(false));
    }

    #[test]
    fn jump_host_defaults_username_and_auth() {
        let config = ssh_config_from_asset(
            "jumpy",
            &json!({
                "host": "target", "username": "u", "password": "p",
                "jumpHost": "bastion", "jumpPort": 2200,
            }),
        )
        .unwrap();
        assert_eq!(config.jump_host.as_deref(), Some("bastion"));
        assert_eq!(config.jump_port, Some(2200));
        assert_eq!(config.jump_username.as_deref(), Some("u"));
        // 未配跳板机密钥/密码时沿用主认证
        assert!(matches!(config.jump_auth, Some(SshAuth::Password(ref p)) if p == "p"));

        let no_jump = ssh_config_from_asset("x", &json!({"host":"h","username":"u"})).unwrap();
        assert!(no_jump.jump_auth.is_none());
    }

    #[test]
    fn sftp_launch_mode_maps_from_asset_strings() {
        for (raw, expected) in [
            ("subsystem", SftpLaunchMode::Subsystem),
            ("custom", SftpLaunchMode::Custom),
            ("auto", SftpLaunchMode::Auto),
            ("", SftpLaunchMode::Auto),
        ] {
            let config = ssh_config_from_asset(
                "x",
                &json!({ "host": "h", "username": "u", "sftpLaunchMode": raw }),
            )
            .unwrap();
            assert_eq!(
                config.sftp_launch_mode, expected,
                "sftpLaunchMode = {raw:?}"
            );
        }
        let custom = ssh_config_from_asset(
            "x",
            &json!({
                "host": "h", "username": "u",
                "sftpLaunchMode": "custom", "sftpServerPath": "/usr/libexec/sftp-server",
                "sftpTimeoutSec": 120,
            }),
        )
        .unwrap();
        assert_eq!(
            custom.sftp_server_path.as_deref(),
            Some("/usr/libexec/sftp-server")
        );
        assert_eq!(custom.sftp_timeout_sec, 120);
    }
}
