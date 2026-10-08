//! sidecar 的 TOFU 主机密钥存储(设计 §六:SQLite known_hosts → sidecar 自有存储)。
//!
//! 形状与 Tauri 侧 `known_hosts` 表逐列对应,§六/R7 的一次性导入就是
//! `SELECT * FROM known_hosts` → 本 JSON 的直排:
//!
//! ```json
//! { "hosts": [{ "host": "10.0.0.7", "port": 22, "keyType": "ssh-ed25519",
//!              "fingerprint": "SHA256:…", "publicKey": "ssh-ed25519 AAAA…" }] }
//! ```
//!
//! AI 会话(`dsh:` 前缀 connId)对未知主机密钥不弹交互确认——域逻辑直接返回
//! `[HOSTKEY_UNKNOWN]`,要求先在 SSH 终端连接一次并「信任并保存」。因此本存储
//! 的关键属性是**持久化**:信任一次,后续 AI 会话复用。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use starhub_domain_ssh::events::{KnownHostsStore, StoreFuture};

/// 一条已确认的主机密钥(列名与 SQLite 表对齐;JSON 侧用 camelCase,
/// 与资产/密钥存储的字段风格一致,§六 的 SQLite 导入直接对得上)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

/// 文件承载的 known_hosts 文档。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KnownHostsDocument {
    #[serde(default)]
    pub hosts: Vec<KnownHost>,
}

/// 文件版主机密钥存储。
pub struct FileKnownHostsStore {
    path: PathBuf,
    /// 进程内缓存:避免每条 SSH 连接都读盘;写穿透保持文件与缓存一致。
    cache: Mutex<Option<KnownHostsDocument>>,
}

impl FileKnownHostsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cache: Mutex::new(None),
        }
    }

    /// 按环境变量解析路径:`STARHUB_KNOWN_HOSTS_FILE`,缺省 `<cwd>/starhub-known-hosts.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_KNOWN_HOSTS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-known-hosts.json"));
        Self::new(path)
    }

    /// 存储文件路径(诊断信息用)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load_document(&self) -> anyhow::Result<KnownHostsDocument> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(document) = cache.as_ref() {
            return Ok(document.clone());
        }
        let document = match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                anyhow::anyhow!("known_hosts 文件解析失败({}): {error}", self.path.display())
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                KnownHostsDocument::default()
            }
            Err(error) => {
                return Err(anyhow::anyhow!(
                    "known_hosts 文件读取失败({}): {error}",
                    self.path.display()
                ))
            }
        };
        *cache = Some(document.clone());
        Ok(document)
    }

    fn persist(&self, document: &KnownHostsDocument) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    anyhow::anyhow!("known_hosts 目录创建失败({}): {error}", parent.display())
                })?;
            }
        }
        let text = serde_json::to_string_pretty(document)
            .map_err(|error| anyhow::anyhow!("known_hosts 序列化失败: {error}"))?;
        std::fs::write(&self.path, text).map_err(|error| {
            anyhow::anyhow!("known_hosts 文件写入失败({}): {error}", self.path.display())
        })?;
        *self.cache.lock().unwrap() = Some(document.clone());
        Ok(())
    }
}

impl KnownHostsStore for FileKnownHostsStore {
    fn is_known<'a>(
        &self,
        host: &'a str,
        port: u16,
        fingerprint: &'a str,
    ) -> StoreFuture<'a, anyhow::Result<bool>> {
        let found = self
            .load_document()
            .map(|document| {
                document.hosts.iter().any(|entry| {
                    entry.host == host && entry.port == port && entry.fingerprint == fingerprint
                })
            })
            .unwrap_or(false);
        Box::pin(async move { Ok(found) })
    }

    fn add_host<'a>(
        &self,
        host: &'a str,
        port: u16,
        key_type: &'a str,
        fingerprint: &'a str,
        public_key: &'a str,
    ) -> StoreFuture<'a, anyhow::Result<()>> {
        let outcome = (|| {
            let mut document = self.load_document()?;
            // insert-or-replace:同一 (host, port, fingerprint) 只留一条(与 SQLite 版一致)
            document.hosts.retain(|entry| {
                !(entry.host == host && entry.port == port && entry.fingerprint == fingerprint)
            });
            document.hosts.push(KnownHost {
                host: host.to_string(),
                port,
                key_type: key_type.to_string(),
                fingerprint: fingerprint.to_string(),
                public_key: public_key.to_string(),
            });
            self.persist(&document)
        })();
        Box::pin(async move { outcome })
    }

    fn trusted_public_key<'a>(
        &self,
        host: &'a str,
        port: u16,
    ) -> StoreFuture<'a, anyhow::Result<Option<String>>> {
        let key = self.load_document().ok().and_then(|document| {
            document
                .hosts
                .iter()
                .filter(|entry| entry.host == host && entry.port == port)
                .next_back()
                .map(|entry| entry.public_key.clone())
        });
        Box::pin(async move { Ok(key) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in_temp(label: &str) -> (FileKnownHostsStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "starhub-known-hosts-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known-hosts.json");
        (FileKnownHostsStore::new(&path), dir)
    }

    #[tokio::test]
    async fn roundtrips_trust_and_reports_unknown() {
        let (store, dir) = store_in_temp("roundtrip");
        assert!(!store.is_known("10.0.0.7", 22, "SHA256:fp").await.unwrap());
        assert_eq!(
            store.trusted_public_key("10.0.0.7", 22).await.unwrap(),
            None
        );

        store
            .add_host(
                "10.0.0.7",
                22,
                "ssh-ed25519",
                "SHA256:fp",
                "ssh-ed25519 AAAA",
            )
            .await
            .unwrap();
        assert!(store.is_known("10.0.0.7", 22, "SHA256:fp").await.unwrap());
        assert!(!store
            .is_known("10.0.0.7", 22, "SHA256:other")
            .await
            .unwrap());
        assert!(!store.is_known("10.0.0.8", 22, "SHA256:fp").await.unwrap());
        assert_eq!(
            store
                .trusted_public_key("10.0.0.7", 22)
                .await
                .unwrap()
                .as_deref(),
            Some("ssh-ed25519 AAAA")
        );

        // 落盘后可被新实例读回(持久化 = AI 会话复用的前提)
        let reopened = FileKnownHostsStore::new(store.path());
        assert!(reopened
            .is_known("10.0.0.7", 22, "SHA256:fp")
            .await
            .unwrap());

        // insert-or-replace:同一 (host, port, fingerprint) 只留一条
        store
            .add_host(
                "10.0.0.7",
                22,
                "ssh-ed25519",
                "SHA256:fp",
                "ssh-ed25519 BBBB",
            )
            .await
            .unwrap();
        let document: KnownHostsDocument =
            serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(document.hosts.len(), 1);
        assert_eq!(document.hosts[0].public_key, "ssh-ed25519 BBBB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn corrupt_file_surfaces_as_error_not_silent_trust() {
        let (store, dir) = store_in_temp("corrupt");
        std::fs::write(store.path(), "{ not json").unwrap();
        // 读失败 → 视为未知(不盲目信任),且写路径报错而不是静默丢钥
        assert!(!store.is_known("h", 22, "fp").await.unwrap());
        assert!(store.add_host("h", 22, "t", "fp", "key").await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
