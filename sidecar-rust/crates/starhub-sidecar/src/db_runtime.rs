//! DB / Redis / ES / Docker 域运行时:Go sidecar 客户端 + 资产存储 + 主机密钥
//! 存储的装配点(M1 第 5 步)。
//!
//! 与 [`SshRuntime`](crate::runtime::SshRuntime) 平级:SSH 域自己管 russh
//! 会话,DB 域把连接生命周期交给 Go sidecar(子进程)。两者共享同一份资产存储、
//! known_hosts 与会话绑定——同一份资产存档在两个域里的可见性一致。

use std::sync::Arc;

use starhub_domain_ssh::events::KnownHostsStore;

use crate::assets::AssetStore;
use crate::bindings::SessionBindings;
use starhub_domain_db::GoSidecar;

/// DB 域运行时(全部 `db_query` / `redis_exec` / `es_*` / `docker_*` 方法共享)。
pub struct DbRuntime {
    assets: Arc<AssetStore>,
    go_sidecar: Arc<GoSidecar>,
    known_hosts: Arc<dyn KnownHostsStore>,
    bindings: Arc<SessionBindings>,
}

impl DbRuntime {
    pub fn new(
        assets: Arc<AssetStore>,
        go_sidecar: Arc<GoSidecar>,
        known_hosts: Arc<dyn KnownHostsStore>,
        bindings: Arc<SessionBindings>,
    ) -> Self {
        Self {
            assets,
            go_sidecar,
            known_hosts,
            bindings,
        }
    }

    /// 资产存储(资产解析 / 清单 / SSH 资产反查)。
    pub fn assets(&self) -> &Arc<AssetStore> {
        &self.assets
    }

    /// Go sidecar 客户端(惰性启动:第一次 db/redis/es/docker 调用才 spawn)。
    pub fn go_sidecar(&self) -> &Arc<GoSidecar> {
        &self.go_sidecar
    }

    /// TOFU 主机密钥存储(Docker over SSH 复用)。
    pub fn known_hosts(&self) -> Option<&Arc<dyn KnownHostsStore>> {
        Some(&self.known_hosts)
    }

    /// 会话 → 资产绑定表(与 SSH 域共享)。
    pub fn bindings(&self) -> &Arc<SessionBindings> {
        &self.bindings
    }
}
