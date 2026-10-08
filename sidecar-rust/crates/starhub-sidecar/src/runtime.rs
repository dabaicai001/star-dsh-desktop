//! SSH/SFTP 域运行时:sidecar 侧的装配点(M1 第 4/5 步)。
//!
//! 执行体(会话生命周期 / 工具体 / 结果文本)已收敛到
//! [`starhub_domain_ssh::tools`]——Tauri 壳与 sidecar 共用同一份代码,
//! 差别只在注入:
//!
//! | 注入点 | sidecar | Tauri 壳 |
//! |---|---|---|
//! | [`AssetSource`] | `AssetStore`(assets.json + 密钥存储) | SQLite + Keyring |
//! | [`ExecTracker`] | 自有 map(`starhub/exec.abort` 中断) | 桥的 `inflight_tools`(`drain()` 中断) |
//! | [`EventSink`] | JSON-RPC 通知出口 | `tauri::Emitter` |
//!
//! 本模块只做装配 + 会话绑定 / 注册表这两个 sidecar 专属状态。

use std::collections::HashMap;
use std::sync::Arc;

use starhub_domain_ssh::events::{EventSink, KnownHostsStore, StoreFuture};
use starhub_domain_ssh::manager::SshManager;
use starhub_domain_ssh::sftp::transfer::TransferManager;
use starhub_domain_ssh::tools::{AssetSource, ExecTracker};

use crate::assets::AssetStore;
use crate::known_hosts_store::FileKnownHostsStore;

/// sidecar 的资产存储实现 [`AssetSource`](starhub_domain_ssh::tools::AssetSource)。
impl AssetSource for AssetStore {
    fn asset_ssh_config<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> StoreFuture<'a, Result<(String, starhub_domain_ssh::SshConfig), String>> {
        let outcome = self.asset_ssh_config(asset_id);
        Box::pin(async move { outcome })
    }
}

/// sidecar 的域运行时(全部 `ssh_*` / `sftp_*` 方法共享的可变状态)。
pub struct SshRuntime {
    manager: SshManager,
    transfers: TransferManager,
    assets: Arc<AssetStore>,
    sink: Arc<dyn EventSink>,
    bindings: Arc<crate::bindings::SessionBindings>,
    registry: crate::session_registry::SessionRegistry,
    /// 在途 exec 的 exec_id → conn_id(停止生成时按 exec_id 中断)。
    ///
    /// std 锁:register/unregister 在 async 执行体里被调用,持锁期间不 await。
    inflight: std::sync::Mutex<HashMap<String, String>>,
}

impl SshRuntime {
    /// 装配运行时;`sink` 接收域事件(JSON-RPC 通知出口)。
    ///
    /// `bindings` 与 DB 域运行时共享:同一份「会话 → 资产」绑定对两个域可见。
    pub fn new(
        assets: Arc<AssetStore>,
        sink: Arc<dyn EventSink>,
        known_hosts: Arc<dyn KnownHostsStore>,
        bindings: Arc<crate::bindings::SessionBindings>,
    ) -> Self {
        Self {
            manager: SshManager::new(known_hosts),
            transfers: TransferManager::new(Arc::clone(&sink)),
            assets,
            sink,
            bindings,
            registry: crate::session_registry::SessionRegistry::new(),
            inflight: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 用默认文件存储装配(资产/密钥/known_hosts 路径均走环境变量)。
    pub fn from_env(
        sink: Arc<dyn EventSink>,
        bindings: Arc<crate::bindings::SessionBindings>,
    ) -> anyhow::Result<Self> {
        let assets = Arc::new(AssetStore::from_env().map_err(|error| anyhow::anyhow!(error))?);
        let known_hosts: Arc<dyn KnownHostsStore> = Arc::new(FileKnownHostsStore::from_env());
        Ok(Self::new(assets, sink, known_hosts, bindings))
    }

    /// 资产存储(全局方法 `starhub_list_assets` 用)。
    pub fn assets(&self) -> &Arc<AssetStore> {
        &self.assets
    }

    /// 记录 会话→资产 绑定(`bind_asset_context`)。
    pub fn bind_session(&self, session_id: &str, asset_type: &str, asset_id: &str) {
        self.bindings.bind(session_id, asset_type, asset_id);
    }

    /// 记录 subagent 子→父会话映射(子代理继承父会话绑定)。
    pub fn record_subagent_parent(&self, child_session_id: &str, parent_session_id: &str) {
        self.bindings
            .record_subagent_parent(child_session_id, parent_session_id);
    }

    /// 沿父链解析会话绑定(方法面在参数缺 assetId 时用)。
    pub fn resolve_bound_asset(&self, session_id: &str) -> Option<(String, String)> {
        self.bindings.resolve(session_id)
    }

    /// 会话 → 资产绑定表(与 DB 域运行时共享)。
    pub fn bindings(&self) -> &Arc<crate::bindings::SessionBindings> {
        &self.bindings
    }

    /// 会话注册表(`starhub/registry.sync` 快照源)。
    pub fn registry(&self) -> &crate::session_registry::SessionRegistry {
        &self.registry
    }

    /// 存活的 SSH 会话 id 集合(注册表快照的剔除依据)。
    pub async fn live_session_ids(&self) -> std::collections::HashSet<String> {
        self.manager.sessions.lock().await.keys().cloned().collect()
    }

    /// 装配执行上下文(资产 / 事件 / 在途登记三个注入点)。
    fn context(&self) -> starhub_domain_ssh::tools::ToolContext<'_> {
        starhub_domain_ssh::tools::ToolContext {
            manager: &self.manager,
            transfers: &self.transfers,
            assets: self.assets.as_ref(),
            sink: &self.sink,
            tracker: self,
        }
    }

    /// 确保 AI exec SSH 会话存在(connId 与前端一致,复用已建会话)。
    pub async fn ensure_ssh_session(&self, asset_id: &str) -> Result<String, String> {
        starhub_domain_ssh::tools::ensure_ssh_session(&self.context(), asset_id).await
    }

    /// 丢弃一个(死)SSH 会话(map 条目 + 代次 + pending 通道一并清理)。
    pub async fn drop_ssh_session(&self, conn_id: &str) {
        starhub_domain_ssh::tools::drop_ssh_session(&self.context(), conn_id).await;
    }

    /// 执行 ssh_exec / ssh_exec_background / ssh_wait_task。
    pub async fn execute_ssh(
        &self,
        name: &str,
        asset_id: &str,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        starhub_domain_ssh::tools::execute_ssh(&self.context(), name, asset_id, args).await
    }

    /// 查询当前绑定资产 SSH 会话状态(不触发连接)。
    pub async fn execute_ssh_status(&self, asset_id: &str) -> Result<String, String> {
        starhub_domain_ssh::tools::execute_ssh_status(&self.context(), asset_id).await
    }

    /// 执行 sftp_list / sftp_stat / sftp_upload / sftp_download。
    pub async fn execute_sftp(
        &self,
        name: &str,
        asset_id: &str,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        starhub_domain_ssh::tools::execute_sftp(&self.context(), name, asset_id, args).await
    }

    /// 中断一条在途 exec(停止生成);exec_id 未知(已结束)按未中断返回。
    pub async fn abort_exec(&self, exec_id: &str) -> Result<bool, String> {
        let conn_id = self
            .inflight
            .lock()
            .unwrap()
            .get(exec_id)
            .cloned()
            .ok_or_else(|| format!("未知或已结束的 exec_id: {exec_id}"))?;
        self.inflight.lock().unwrap().remove(exec_id);
        starhub_domain_ssh::manager::ssh_exec_abort_core(&self.manager, &conn_id, exec_id).await
    }
}

/// sidecar 的在途 exec 登记:exec_id → conn_id(`starhub/exec.abort` 据此中断)。
///
/// 用 `std::sync::Mutex` 而非 tokio 的:register/unregister 在 async 执行体里
/// 被调用且操作瞬时完成,持锁期间不 await——std 锁既不会阻塞运行时,也不会
/// 像 `blocking_lock` 那样在 tokio 上下文里直接 panic。
impl ExecTracker for SshRuntime {
    fn register(&self, exec_id: &str, conn_id: &str) {
        self.inflight
            .lock()
            .unwrap()
            .insert(exec_id.to_string(), conn_id.to_string());
    }

    fn unregister(&self, exec_id: &str) {
        self.inflight.lock().unwrap().remove(exec_id);
    }
}

/// 解析目标资产:显式 `assetId` 优先,否则用会话绑定(沿 subagent 父链)。
///
/// SSH 与 DB 两个域的方法面共用(bridge 的 `starhub/tool.execute` 兼容层
/// 最终也走到这里);无绑定时的引导文案与 Tauri 版 `execute_domain_tool` 一致。
pub fn resolve_asset_id(
    bindings: &crate::bindings::SessionBindings,
    params: &serde_json::Value,
) -> Result<String, String> {
    if let Some(asset_id) = params
        .get("assetId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(asset_id.to_string());
    }
    if let Some(session_id) = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some((_asset_type, asset_id)) = bindings.resolve(session_id) {
            return Ok(asset_id);
        }
    }
    Err(
        "缺少 assetId,且当前会话未绑定资产:请先调用 starhub_list_assets 查看可用资产,\
         再调用 bind_asset_context 绑定目标资产(不打开窗口),或调用 open_connection / \
         focus_terminal 打开目标资产后重试"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use starhub_domain_ssh::events::{EventSink, MemoryKnownHostsStore};

    struct NoopSink;

    impl EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}
    }

    /// 空资产库 + 内存密钥的运行时(不触网)。
    fn runtime_in_temp(label: &str) -> (Arc<SshRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-runtime-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(crate::assets::MemorySecretStore::new()),
        ));
        let runtime = Arc::new(SshRuntime::new(
            Arc::clone(&assets),
            Arc::new(NoopSink),
            Arc::new(MemoryKnownHostsStore::default()),
            Arc::new(crate::bindings::SessionBindings::new()),
        ));
        (runtime, dir)
    }

    // ---------- 运行时:空资产库上的软错误(不触网) ----------

    #[tokio::test]
    async fn ssh_tools_report_missing_asset_without_touching_the_network() {
        let (runtime, dir) = runtime_in_temp("empty");
        // 未知资产:ensure_ssh_session 在解析资产配置处失败,文案与 Tauri 版一致
        let err = runtime
            .execute_ssh("ssh_exec", "ghost", &serde_json::json!({ "command": "ls" }))
            .await
            .unwrap_err();
        assert_eq!(err, "资产不存在: ghost");

        // 状态查询不触发连接:无会话 → 引导文案
        let status = runtime.execute_ssh_status("ghost").await.unwrap();
        assert!(status.contains("SSH 会话未建立(资产 ghost)"), "{status}");

        // 空资产库的清单
        assert_eq!(runtime.assets().list_assets_text(None).unwrap(), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- 资产解析:显式 assetId / 会话绑定 / 父链 ----------

    #[tokio::test]
    async fn resolve_asset_id_prefers_the_explicit_parameter() {
        let bindings = crate::bindings::SessionBindings::new();
        bindings.bind("session-1", "ssh", "from-binding");
        let params = serde_json::json!({ "assetId": "explicit", "sessionId": "session-1" });
        assert_eq!(resolve_asset_id(&bindings, &params).unwrap(), "explicit");
    }

    #[tokio::test]
    async fn resolve_asset_id_falls_back_to_the_session_binding() {
        let bindings = crate::bindings::SessionBindings::new();
        bindings.bind("root", "ssh", "root-asset");
        bindings.record_subagent_parent("child", "root");
        let params = serde_json::json!({ "sessionId": "child" });
        assert_eq!(resolve_asset_id(&bindings, &params).unwrap(), "root-asset");
    }

    #[test]
    fn resolve_asset_id_without_any_source_guides_the_model() {
        let bindings = crate::bindings::SessionBindings::new();
        let error = resolve_asset_id(&bindings, &serde_json::json!({})).unwrap_err();
        assert!(error.contains("bind_asset_context"), "{error}");
        assert!(error.contains("starhub_list_assets"), "{error}");
    }

    // ---------- 在途 exec 登记(ExecTracker seam) ----------

    #[tokio::test]
    async fn exec_tracker_registers_and_aborts_by_exec_id() {
        let (runtime, dir) = runtime_in_temp("tracker");
        // ExecTracker seam:登记 → abort 能定位到 conn_id(会话不存在 → 硬错误,
        // 但登记已清掉;再 abort 即「未知 exec_id」)
        <SshRuntime as ExecTracker>::register(&runtime, "exec-1", "dsh:asset-1:ssh");
        let err = runtime.abort_exec("exec-1").await.unwrap_err();
        assert!(err.contains("SSH session"), "{err}");
        let err = runtime.abort_exec("exec-1").await.unwrap_err();
        assert!(err.contains("未知或已结束"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
