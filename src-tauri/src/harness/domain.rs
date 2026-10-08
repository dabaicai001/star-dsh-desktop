//! 进程内域工具执行器(Tauri 侧装配层,去 Tauri 化 M1)。
//!
//! 背景:旧实现(方案0)把域工具(ssh_exec / sftp_* / db_query / redis_exec /
//! es_* / docker_*)经 `dsh://tool-exec` 事件转发给拥有该会话的【前端 webview
//! 面板】执行,再等 `dsh_tool_exec_reply` 应答。两个致命问题:
//! 1. 前端面板窗口关闭 / 审批卡住 → 应答永远不来 → 180s 后报
//!    「前端执行超时或窗口已关闭」(BUG.md #1);
//! 2. 停止生成只杀 dsh 进程,前端面板里正在执行的命令不会被中断。
//!
//! 本模块把全部可进程内执行的域工具改为在 Rust 主进程直接执行。**执行体已全部
//! 平移到 sidecar-rust workspace**(M1):SSH/SFTP 在
//! [`starhub_domain_ssh::tools`],DB/Redis/ES/Docker 在 [`starhub_domain_db`]。
//! 这里只剩 Tauri 专属的装配:
//!
//! - 资产配置:[`load_asset_config`](load_asset_config) 走 SQLite + Keyring
//!   (sidecar 侧是 assets.json + 密钥存储,同一份 [`starhub_domain_ssh::tools::AssetSource`] 契约);
//! - 会话/传输:直接取 app state 里的 [`SshManager`](crate::commands::ssh::SshManager)
//!   与 [`TransferManager`](crate::sftp::transfer::TransferManager)——交互终端与
//!   AI 执行器共用同一张会话表(connId `dsh:{asset_id}:ssh` 与前端同 key);
//! - 在途 exec:登记到桥的 [`InflightAbort`],停止生成时由 `bridge.drain()`
//!   真正中断(sidecar 侧走 `starhub/exec.abort` 通知);
//! - DB / Redis / ES / Docker:经 app state 里的 [`SidecarManager`] 的 stdio
//!   JSON-RPC(connect → 执行 → format → disconnect)。
//!
//! 结果文本格式与前端 `src/services/dshToolExecutor.ts` 对齐(模型可读文本),
//! 行为语义照搬前端实现,便于模型无感迁移——文本是契约,由 crate 侧的测试守住。

use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

use starhub_domain_ssh::events::{EventSink, KnownHostsStore, StoreFuture};
use starhub_domain_ssh::manager::SshManager;
use starhub_domain_ssh::tools::{AssetSource, ExecTracker, ToolContext};

use crate::sftp::transfer::TransferManager as TauriTransferManager;
use crate::sidecar::SidecarManager;
use super::{HostBridgeState, InflightAbort};

// ============================================================
// Tauri 侧的两个注入点
// ============================================================

/// Tauri 的资产配置来源:SQLite `assets` 表 + 系统 Keyring。
struct SqliteAssetSource;

impl AssetSource for SqliteAssetSource {
    fn asset_ssh_config<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> StoreFuture<'a, Result<(String, starhub_domain_ssh::SshConfig), String>> {
        Box::pin(async move { crate::commands::ssh::asset_ssh_config(asset_id).await })
    }
}

/// Tauri 的在途 exec 登记:桥的 `inflight_tools`(停止生成时 `drain()` 中断)。
struct BridgeExecTracker<'a> {
    bridge: &'a HostBridgeState,
}

impl ExecTracker for BridgeExecTracker<'_> {
    fn register(&self, exec_id: &str, conn_id: &str) {
        self.bridge.inflight_tools.lock().unwrap().insert(
            exec_id.to_string(),
            InflightAbort::SshExec {
                conn_id: conn_id.to_string(),
                exec_id: exec_id.to_string(),
            },
        );
    }

    fn unregister(&self, exec_id: &str) {
        self.bridge.inflight_tools.lock().unwrap().remove(exec_id);
    }
}

/// 装配 SSH/SFTP 执行上下文。
///
/// 全部入参都由调用方持有(tauri 的 `State<'_, T>` 守卫是局部值,不能跨函数
/// 返回),因此上下文的生命周期与调用方的作用域绑定——每个执行函数各建一次。
fn ssh_context<'a>(
    manager: &'a SshManager,
    transfers: &'a TauriTransferManager,
    assets: &'a dyn AssetSource,
    sink: &'a Arc<dyn EventSink>,
    tracker: &'a dyn ExecTracker,
) -> ToolContext<'a> {
    ToolContext {
        manager,
        transfers,
        assets,
        sink,
        tracker,
    }
}

/// 把资产 id 解析为完整连接配置(含 Keyring 合并的敏感字段)。
/// 返回 (asset_type, config);资产不存在时报错。
///
/// DB / Redis / ES / Docker 的资产连接参数也走这里(与
/// [`crate::commands::ssh::asset_ssh_config`] 同源,绝不含明文密钥泄漏)。
pub(crate) async fn load_asset_config(asset_id: &str) -> Result<(String, Value), String> {
    let pool = crate::db::get_pool()?;
    let row = sqlx::query("SELECT type, config_json, key_id FROM assets WHERE id = ?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取资产失败: {e}"))?
        .ok_or_else(|| format!("资产不存在: {asset_id}"))?;
    use sqlx::Row;
    let asset_type: String = row.try_get("type").map_err(|e| e.to_string())?;
    let config_json: String = row.try_get("config_json").map_err(|e| e.to_string())?;
    let key_id: Option<String> = row.try_get("key_id").map_err(|e| e.to_string())?;
    let mut config: Value = serde_json::from_str(&config_json)
        .unwrap_or_else(|_| Value::Object(Default::default()));
    if let Some(key_id) = key_id {
        let secrets = crate::keyring::load(key_id).await?;
        config = crate::keyring::merge_config(config, secrets);
    }
    Ok((asset_type, config))
}

// ============================================================
// SSH / SFTP 域(执行体在 starhub_domain_ssh::tools)
// ============================================================

/// 执行 ssh_exec / ssh_exec_background / ssh_wait_task。
async fn execute_ssh(
    bridge: &HostBridgeState,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 SSH 工具".to_string())?;
    let asset_id = args.get("assetId").and_then(Value::as_str).unwrap_or("");
    let manager = app.state::<SshManager>();
    let transfers = app.state::<TauriTransferManager>();
    let sink = crate::ssh::adapters::tauri_sink(app.clone());
    let assets = SqliteAssetSource;
    let tracker = BridgeExecTracker { bridge };
    let context = ssh_context(&manager, &transfers, &assets, &sink, &tracker);
    starhub_domain_ssh::tools::execute_ssh(&context, name, asset_id, args).await
}

/// 查询当前绑定资产 SSH 会话状态(不触发连接)。
async fn execute_ssh_status(
    bridge: &HostBridgeState,
    asset_id: &str,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法查询 SSH 会话状态".to_string())?;
    let manager = app.state::<SshManager>();
    let transfers = app.state::<TauriTransferManager>();
    let sink = crate::ssh::adapters::tauri_sink(app.clone());
    let assets = SqliteAssetSource;
    let tracker = BridgeExecTracker { bridge };
    let context = ssh_context(&manager, &transfers, &assets, &sink, &tracker);
    starhub_domain_ssh::tools::execute_ssh_status(&context, asset_id).await
}

/// 执行 sftp_list / sftp_stat / sftp_upload / sftp_download。
async fn execute_sftp(
    bridge: &HostBridgeState,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 SFTP 工具".to_string())?;
    let asset_id = args.get("assetId").and_then(Value::as_str).unwrap_or("");
    let manager = app.state::<SshManager>();
    let transfers = app.state::<TauriTransferManager>();
    let sink = crate::ssh::adapters::tauri_sink(app.clone());
    let assets = SqliteAssetSource;
    let tracker = BridgeExecTracker { bridge };
    let context = ssh_context(&manager, &transfers, &assets, &sink, &tracker);
    starhub_domain_ssh::tools::execute_sftp(&context, name, asset_id, args).await
}

// ============================================================
// DB / Redis / ES / Docker 域(执行体在 starhub_domain_db)
//
// 下面四个薄封装只补 Tauri 专属的注入:app state 里的 Go sidecar 客户端与
// SQLite known_hosts(Docker over SSH 的主机密钥策略)。
// ============================================================

/// `db_query`:关系库 / ClickHouse。
async fn execute_db_query(
    bridge: &HostBridgeState,
    asset_type: &str,
    config: &Value,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行数据库工具".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    starhub_domain_db::execute_db_query(&sidecar, asset_type, config, args).await
}

/// `redis_exec`。
async fn execute_redis(
    bridge: &HostBridgeState,
    config: &Value,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 Redis 工具".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    starhub_domain_db::execute_redis(&sidecar, config, args).await
}

/// `es_*`(9 个)。
async fn execute_es(
    bridge: &HostBridgeState,
    config: &Value,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 Elasticsearch 工具".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    starhub_domain_db::execute_es(&sidecar, config, name, args).await
}

/// `docker_*`(4 个);SSH 传输需先解析 dockerSshAssetId 指向的 SSH 资产。
async fn execute_docker(
    bridge: &HostBridgeState,
    config: &Value,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法执行 Docker 工具".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    let known_hosts: Arc<dyn KnownHostsStore> =
        Arc::new(crate::ssh::adapters::SqliteKnownHostsStore);
    let docker_ssh = match config
        .get("dockerSshAssetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(asset_id) => Some(load_asset_config(asset_id).await?.1),
        None => None,
    };
    starhub_domain_db::execute_docker(
        &sidecar,
        config,
        name,
        args,
        docker_ssh.as_ref(),
        Some(&known_hosts),
    )
    .await
}

// ============================================================
// sidecar 调用原语(沙箱桌面模块复用)
//
// 执行体在 crate;这里只做 app state 取用与 Tauri 专属注入。
// ============================================================

/// Go sidecar 调用(默认 120s 超时)。
pub(crate) async fn sidecar_call(
    bridge: &HostBridgeState,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法调用 sidecar".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    sidecar.call(method, params).await
}

/// 自定义超时的 Go sidecar 调用(镜像构建等长耗时操作)。
pub(crate) async fn sidecar_call_with_timeout(
    bridge: &HostBridgeState,
    method: &str,
    params: Value,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法调用 sidecar".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    sidecar.call_with_timeout(method, params, timeout).await
}

/// 按资产配置建立连接,返回 connId(沙箱桌面连接用)。
pub(crate) async fn connect_sidecar(
    bridge: &HostBridgeState,
    asset_type: &str,
    config: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "无 AppHandle,无法连接 sidecar".to_string())?;
    let sidecar = app.state::<SidecarManager>();
    let known_hosts: Arc<dyn KnownHostsStore> =
        Arc::new(crate::ssh::adapters::SqliteKnownHostsStore);
    let docker_ssh = match config
        .get("dockerSshAssetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(asset_id) => Some(load_asset_config(asset_id).await?.1),
        None => None,
    };
    starhub_domain_db::connect_sidecar(
        &sidecar,
        asset_type,
        config,
        docker_ssh.as_ref(),
        Some(&known_hosts),
    )
    .await
}

// ============================================================
// 入口
// ============================================================

/// 会话资产绑定解析:bridge.resolve_asset 沿 subagent 父链解析。
/// 返回 (asset_type, asset_id)。
fn resolve_asset(bridge: &HostBridgeState, session_id: &str) -> Option<(String, String)> {
    bridge.resolve_asset(session_id)
}

/// 进程内执行一个域工具(方案1)。返回模型可读文本;Err 为硬错误。
/// 调用方(tools.rs)负责成功事件的 on_ai_tool_success 回写。
pub(crate) async fn execute_domain_tool(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let (asset_type, asset_id) = resolve_asset(bridge, session_id)
        .ok_or_else(|| "当前会话未绑定资产,无法执行域工具:请先调用 starhub_list_assets 查看可用资产,再调用 bind_asset_context 绑定目标资产(不打开窗口),或调用 open_connection / focus_terminal 打开目标资产后重试".to_string())?;

    // 全局工具名内嵌资产 id 参数(桥接层在 starhub-tools 里已按会话填充)。
    // 为避免改 dsh 侧插件,域执行统一以 assetId 参数 + 会话绑定双重来源:
    // 这里把解析到的 asset_id 补进 args,供 SSH/SFTP 执行器取用。
    let mut merged_args = args.clone();
    if !merged_args.is_object() {
        merged_args = serde_json::json!({});
    }
    if merged_args.get("assetId").and_then(Value::as_str).unwrap_or("").is_empty() {
        if let Value::Object(map) = &mut merged_args {
            map.insert("assetId".to_string(), Value::String(asset_id.clone()));
        }
    }

    // 域名判定与执行
    if name == "ssh_session_status" {
        // 状态查询不触发连接,单独处理(不调 execute_ssh 的 ensure_ssh_session)。
        return execute_ssh_status(bridge, &asset_id).await;
    }

    // DB / Redis / ES / Docker 需要资产连接配置(先加载,供工具族校验与执行)。
    let (_asset_type, config) = load_asset_config(&asset_id).await?;
    let kind = if asset_type == "db" {
        config
            .get("dbType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        asset_type.clone()
    };

    // 资产类型 → 工具族校验:防止「@ 数据库资产却调 ssh_exec」这类误路由。
    // 不匹配返回软错误(原样作文本回给模型),引导改用正确的工具族。
    // 校验函数在 starhub-domain-db(ssh/sftp 与 db/es/docker 各族共用)。
    if let Err(hint) = starhub_domain_db::check_tool_asset_type(&asset_type, &kind, name) {
        return Ok(hint);
    }

    if name.starts_with("ssh_") {
        return execute_ssh(bridge, name, &merged_args).await;
    }
    if name.starts_with("sftp_") {
        return execute_sftp(bridge, name, &merged_args).await;
    }

    if name == "db_query" {
        return execute_db_query(bridge, &kind, &config, &merged_args).await;
    }
    if name == "redis_exec" {
        return execute_redis(bridge, &config, &merged_args).await;
    }
    if name.starts_with("es_") {
        return execute_es(bridge, &config, name, &merged_args).await;
    }
    if name.starts_with("docker_") {
        return execute_docker(bridge, &config, name, &merged_args).await;
    }

    Err(format!("unsupported in-process StarHub tool: {name}"))
}

// 说明:原 domain.rs 的纯函数测试(base64 / 后台任务命令 / sleep 检测 / task_id /
// clamp / 连接级失败 / redis db 参数 / SELECT 拦截 / format_query_result /
// check_tool_asset_type)已随执行体平移到 crate 侧:
// - SSH 族 → starhub-domain-ssh::tools(9 例)
// - DB 族  → starhub-domain-db::executors(11 例)
// 本文件只剩装配逻辑(依赖 tauri::AppHandle),无独立单测;装配正确性由
// sidecar 的端到端验证(test-sftp/verify_sidecar_ssh.py)与 crate 测试共同保证。
