//! Host-key policy helpers. Persistence moved to the
//! [`events::KnownHostsStore`] seam: the Tauri shell implements it over the
//! SQLite `known_hosts` table, the sidecar over its own durable store.

use russh::keys::HashAlg;
use russh::keys::PublicKey;

/// `host:port` storage key.
pub fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}

/// SHA-256 fingerprint of a server public key (the trust anchor).
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// OpenSSH key type token (`ssh-ed25519`, `rsa-sha2-256`, …).
pub fn key_type(key: &PublicKey) -> String {
    key.to_string()
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .to_string()
}

/// Full OpenSSH public-key line (persisted for Docker-over-SSH reuse).
pub fn public_key(key: &PublicKey) -> String {
    key.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_key_format() {
        assert_eq!(host_key("example.com", 22), "example.com:22");
        assert_eq!(host_key("192.168.1.1", 2222), "192.168.1.1:2222");
        assert_eq!(host_key("test", 0), "test:0");
    }
}
