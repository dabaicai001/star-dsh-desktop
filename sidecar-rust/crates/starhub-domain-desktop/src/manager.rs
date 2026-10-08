//! 沙箱桌面状态机:平台连接缓存 / 任务级授权 / 用户接管 / 人工介入等待。
//!
//! 从 `src-tauri/src/desktop/mod.rs::DesktopManager` 平移(零改动,只去掉
//! tauri 依赖)。授权存在性/过期/实例匹配在执行点强制;审批层只决定
//! create/exec 是否弹卡。

use std::collections::{HashMap, HashSet};

/// 任务授权时长(秒),超时后写操作重新要求创建沙箱。
pub const AUTHZ_TTL_SECS: i64 = 60 * 60;

/// 授权条目:create_sandbox 建立,到期/销毁/撤销即失效。
#[derive(Debug, Clone)]
struct Authz {
    sandbox_id: String,
    expires_at: i64,
}

#[derive(Default)]
struct DesktopState {
    /// 平台连接缓存:platform key(资产 id 或 "local")→ sidecar connId。
    conn_cache: HashMap<String, String>,
    /// session_id → 任务级授权。
    authz: HashMap<String, Authz>,
    /// 用户接管中的容器 id 集合(写操作互斥)。
    takeovers: HashSet<String>,
    /// requestId → 「请求用户人工介入」等待应答通道。
    user_actions: HashMap<String, tokio::sync::oneshot::Sender<bool>>,
}

/// 沙箱桌面管理器(两个宿主各持一份;桥路径经状态访问)。
pub struct DesktopManager {
    state: tokio::sync::Mutex<DesktopState>,
}

impl Default for DesktopManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopManager {
    pub fn new() -> Self {
        Self {
            state: tokio::sync::Mutex::new(DesktopState::default()),
        }
    }

    /// 前端接管开关:active=true 进入接管。
    pub async fn set_takeover(&self, container_id: &str, active: bool) {
        let mut state = self.state.lock().await;
        if active {
            state.takeovers.insert(container_id.to_string());
        } else {
            state.takeovers.remove(container_id);
        }
    }

    /// 「请求用户人工介入」应答:返回 false 表示 requestId 未知/已过期。
    pub async fn resolve_user_action(&self, request_id: &str, done: bool) -> bool {
        if let Some(sender) = self.state.lock().await.user_actions.remove(request_id) {
            let _ = sender.send(done);
            true
        } else {
            false
        }
    }

    pub async fn is_takeover(&self, container_id: &str) -> bool {
        self.state.lock().await.takeovers.contains(container_id)
    }

    pub async fn grant(&self, session_id: &str, sandbox_id: &str) {
        let expires_at = chrono::Utc::now().timestamp() + AUTHZ_TTL_SECS;
        self.state.lock().await.authz.insert(
            session_id.to_string(),
            Authz {
                sandbox_id: sandbox_id.to_string(),
                expires_at,
            },
        );
    }

    pub async fn revoke_sandbox(&self, sandbox_id: &str) {
        self.state
            .lock()
            .await
            .authz
            .retain(|_, a| a.sandbox_id != sandbox_id);
    }

    /// 校验会话对目标沙箱的写授权;返回 sandbox_id。
    pub async fn require_authz(
        &self,
        session_id: &str,
        sandbox_arg: Option<&str>,
    ) -> Result<String, String> {
        let state = self.state.lock().await;
        let authz = state.authz.get(session_id).ok_or_else(|| {
            "当前会话没有沙箱授权:请先调用 desktop_create_sandbox 创建沙箱(会请求用户确认)"
                .to_string()
        })?;
        let now = chrono::Utc::now().timestamp();
        if authz.expires_at < now {
            return Err("沙箱授权已过期(60 分钟),请重新 desktop_create_sandbox".to_string());
        }
        if let Some(want) = sandbox_arg {
            if !want.is_empty() && want != authz.sandbox_id {
                return Err(format!(
                    "授权仅覆盖沙箱 {},不能操作 {want}",
                    authz.sandbox_id
                ));
            }
        }
        Ok(authz.sandbox_id.clone())
    }

    pub async fn cached_conn(&self, key: &str) -> Option<String> {
        self.state.lock().await.conn_cache.get(key).cloned()
    }

    pub async fn cache_conn(&self, key: &str, conn_id: &str) {
        self.state
            .lock()
            .await
            .conn_cache
            .insert(key.to_string(), conn_id.to_string());
    }

    pub async fn evict_conn(&self, key: &str) {
        self.state.lock().await.conn_cache.remove(key);
    }

    /// 注册一条「请求用户人工介入」等待;返回接收端(调用方持之等待)。
    pub async fn register_user_action(
        &self,
        request_id: &str,
    ) -> tokio::sync::oneshot::Receiver<bool> {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        self.state
            .lock()
            .await
            .user_actions
            .insert(request_id.to_string(), tx);
        rx
    }

    /// 解除注册(超时/已应答都必须清,避免 map 泄漏)。
    pub async fn unregister_user_action(&self, request_id: &str) {
        self.state.lock().await.user_actions.remove(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn authz_grants_expires_and_scopes_to_one_sandbox() {
        let manager = DesktopManager::new();
        // 未授权:硬错误
        let err = manager.require_authz("s1", None).await.unwrap_err();
        assert!(err.contains("没有沙箱授权"), "{err}");

        manager.grant("s1", "box-a").await;
        assert_eq!(manager.require_authz("s1", None).await.unwrap(), "box-a");
        // 显式指定同一沙箱:放行
        assert_eq!(
            manager.require_authz("s1", Some("box-a")).await.unwrap(),
            "box-a"
        );
        // 指定别的沙箱:拒绝
        let err = manager
            .require_authz("s1", Some("box-b"))
            .await
            .unwrap_err();
        assert!(err.contains("授权仅覆盖沙箱 box-a"), "{err}");

        // 撤销该沙箱后全部失效
        manager.revoke_sandbox("box-a").await;
        assert!(manager.require_authz("s1", None).await.is_err());
    }

    #[tokio::test]
    async fn takeover_is_per_container_and_reversible() {
        let manager = DesktopManager::new();
        assert!(!manager.is_takeover("c1").await);
        manager.set_takeover("c1", true).await;
        assert!(manager.is_takeover("c1").await);
        assert!(!manager.is_takeover("c2").await);
        manager.set_takeover("c1", false).await;
        assert!(!manager.is_takeover("c1").await);
    }

    #[tokio::test]
    async fn user_action_channel_roundtrips_and_unregisters() {
        let manager = DesktopManager::new();
        let rx = manager.register_user_action("req-1").await;
        assert!(manager.resolve_user_action("req-1", true).await);
        assert!(rx.await.expect("channel open"));
        // 幂等:第二次解析返回 false
        assert!(!manager.resolve_user_action("req-1", false).await);
        manager.unregister_user_action("req-1").await;
    }
}
