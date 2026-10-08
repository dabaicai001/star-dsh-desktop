//! Seams that decouple the SSH/SFTP domain from any particular host.
//!
//! The domain logic (russh sessions, host-key policy, SFTP transfers) is
//! host-agnostic; two host capabilities are injected instead of imported:
//!
//! - [`EventSink`] receives the domain's event stream (`ssh:data`,
//!   `ssh:bastion-*`, `sftp://transfer-*`, …). The Tauri shell implements it
//! over `tauri::Emitter`; the sidecar implements it as JSON-RPC
//!   notifications.
//! - [`KnownHostsStore`] persists the TOFU host-key policy. The Tauri shell
//!   implements it over the SQLite `known_hosts` table; the sidecar
//!   implements it over its own durable store.
//!
//! Both traits are object-safe on purpose: the session layer holds
//! `Arc<dyn …>` for the whole connection lifetime.

use std::future::Future;
use std::pin::Pin;

/// Boxed future alias for the object-safe async store methods.
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Event sink for the domain's event stream.
///
/// Payloads are JSON values; serialization of richer domain structs happens
/// at the call site through [`EventSinkExt::emit_ser`].
pub trait EventSink: Send + Sync {
    /// Emit one event with an already-serialized payload.
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// Ergonomic generic emit for `Serialize` payloads.
///
/// Keeps the domain call sites one word away from the old `tauri::Emitter`
/// shape (`app.emit(name, value)` → `app.emit_ser(name, value)`); a
/// serialization failure degrades to `null` rather than losing the event.
pub trait EventSinkExt {
    /// Serialize `payload` and emit it.
    fn emit_ser<S: serde::Serialize>(&self, event: &str, payload: S);
}

impl<T: EventSink + ?Sized> EventSinkExt for T {
    fn emit_ser<S: serde::Serialize>(&self, event: &str, payload: S) {
        let value = serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null);
        self.emit(event, value)
    }
}

/// Persistence for the TOFU host-key policy.
pub trait KnownHostsStore: Send + Sync {
    /// Whether `fingerprint` is already trusted for `host:port`.
    fn is_known(&self, host: &str, port: u16, fingerprint: &str) -> StoreFuture<'_, anyhow::Result<bool>>;

    /// Persist a confirmed host key (insert-or-replace semantics).
    fn add_host(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        fingerprint: &str,
        public_key: &str,
    ) -> StoreFuture<'_, anyhow::Result<()>>;

    /// The most recently confirmed OpenSSH public key for `host:port`.
    fn trusted_public_key(&self, host: &str, port: u16) -> StoreFuture<'_, anyhow::Result<Option<String>>>;
}

/// Test double: an in-memory known-hosts policy.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryKnownHostsStore {
    entries: std::sync::Mutex<Vec<(String, u16, String, String)>>,
}

#[cfg(test)]
impl KnownHostsStore for MemoryKnownHostsStore {
    fn is_known(&self, host: &str, port: u16, fingerprint: &str) -> StoreFuture<'_, anyhow::Result<bool>> {
        let entries = self.entries.lock().unwrap();
        let found = entries.iter().any(|(h, p, fp, _)| h == host && *p == port && fp == fingerprint);
        Box::pin(async move { Ok(found) })
    }

    fn add_host(
        &self,
        host: &str,
        port: u16,
        _key_type: &str,
        fingerprint: &str,
        public_key: &str,
    ) -> StoreFuture<'_, anyhow::Result<()>> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|(h, p, fp, _)| !(h == host && *p == port && fp == fingerprint));
        entries.push((host.to_string(), port, fingerprint.to_string(), public_key.to_string()));
        Box::pin(async move { Ok(()) })
    }

    fn trusted_public_key(&self, host: &str, port: u16) -> StoreFuture<'_, anyhow::Result<Option<String>>> {
        let entries = self.entries.lock().unwrap();
        let key = entries
            .iter()
            .filter(|(h, p, _, _)| h == host && *p == port)
            .next_back()
            .map(|(_, _, _, key)| key.clone());
        Box::pin(async move { Ok(key) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Collector(std::sync::Mutex<Vec<(String, serde_json::Value)>>);

    impl EventSink for Collector {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    #[test]
    fn emit_ser_serializes_and_degrades() {
        let collector = Collector(Default::default());
        collector.emit_ser("ssh:data:x", vec![1u8, 2, 3]);
        collector.emit_ser("ssh:bastion-done:x", ());
        let events = collector.0.lock().unwrap();
        assert_eq!(events[0].0, "ssh:data:x");
        assert_eq!(events[0].1, serde_json::json!([1, 2, 3]));
        assert_eq!(events[1].1, serde_json::Value::Null);
    }

    #[tokio::test]
    async fn memory_known_hosts_store_roundtrips() {
        let store = MemoryKnownHostsStore::default();
        assert!(!store.is_known("h", 22, "fp").await.unwrap());
        store.add_host("h", 22, "ssh-ed25519", "fp", "KEY").await.unwrap();
        assert!(store.is_known("h", 22, "fp").await.unwrap());
        assert!(!store.is_known("h", 22, "other").await.unwrap());
        assert_eq!(store.trusted_public_key("h", 22).await.unwrap().as_deref(), Some("KEY"));
        // insert-or-replace: same (host, port, fingerprint) keeps one entry
        store.add_host("h", 22, "ssh-ed25519", "fp", "KEY2").await.unwrap();
        assert_eq!(store.trusted_public_key("h", 22).await.unwrap().as_deref(), Some("KEY2"));
    }
}
