//! Tauri 侧的两个 host seam 实现(去 Tauri 化 M1)。
//!
//! - [`TauriEventSink`]:域事件(`ssh:data` / `ssh:bastion-*` /
//!   `sftp://transfer-*` / hostkey-confirm)经 `tauri::Emitter` 送前端,
//!   事件名与载荷与抽取前逐字一致;
//! - [`SqliteKnownHostsStore`]:TOFU 主机密钥策略落 SQLite
//!   `known_hosts` 表(从原 `ssh/known_hosts.rs` 平移,SQL 不变)。

use std::sync::Arc;

use tauri::Emitter;

use starhub_domain_ssh::events::{EventSink, KnownHostsStore, StoreFuture};

/// 域事件 → Tauri 前端事件。
pub struct TauriEventSink(pub tauri::AppHandle);

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// 便于调用方写出 `Arc<dyn EventSink>` 的构造助手。
pub fn tauri_sink(app: tauri::AppHandle) -> Arc<dyn EventSink> {
    Arc::new(TauriEventSink(app))
}

/// `host:port` 存储键(与域 crate 的 helper 同格式)。
fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}

/// known_hosts SQLite 存储。
pub struct SqliteKnownHostsStore;

impl KnownHostsStore for SqliteKnownHostsStore {
    fn is_known<'a>(&self, host: &'a str, port: u16, fingerprint: &'a str) -> StoreFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            let pool = match crate::db::get_pool() {
                Ok(pool) => pool,
                Err(error) => {
                    tracing::warn!("Failed to get DB pool for known_hosts check: {}", error);
                    return Ok(false);
                }
            };
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM known_hosts WHERE host_key = ?1 AND sha256_fingerprint = ?2",
            )
            .bind(host_key(host, port))
            .bind(fingerprint)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
            Ok(count > 0)
        })
    }

    fn add_host<'a>(
        &self,
        host: &'a str,
        port: u16,
        key_type: &'a str,
        fingerprint: &'a str,
        public_key: &'a str,
    ) -> StoreFuture<'a, anyhow::Result<()>> {
        let host = host.to_string();
        let key_type = key_type.to_string();
        let fingerprint = fingerprint.to_string();
        let public_key = public_key.to_string();
        Box::pin(async move {
            let pool = crate::db::get_pool().map_err(|e| anyhow::anyhow!(e))?;
            sqlx::query(
                "INSERT OR REPLACE INTO known_hosts (host_key, key_type, sha256_fingerprint, public_key) \
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .bind(host_key(&host, port))
            .bind(&key_type)
            .bind(&fingerprint)
            .bind(public_key.into_bytes())
            .execute(pool)
            .await
            .map_err(|error| anyhow::anyhow!("Failed to save known host: {}", error))?;
            Ok(())
        })
    }

    fn trusted_public_key<'a>(&self, host: &'a str, port: u16) -> StoreFuture<'a, anyhow::Result<Option<String>>> {
        let host = host.to_string();
        Box::pin(async move {
            let pool = crate::db::get_pool().map_err(|e| anyhow::anyhow!(e))?;
            let key = sqlx::query_scalar::<_, Vec<u8>>(
                "SELECT public_key FROM known_hosts WHERE host_key = ?1 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(host_key(&host, port))
            .fetch_optional(pool)
            .await
            .map_err(|error| anyhow::anyhow!("Failed to read trusted host key: {error}"))?;
            key.map(|bytes| String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("Stored host key is not valid UTF-8")))
                .transpose()
        })
    }
}
