//! StarHub 宿主工具执行端(内核替换 P1-4,Phase 2 扩展全域工具;方案1 起
//! 域工具改在 Rust 主进程内直接执行)。
//!
//! dsh 侧 `@deepseek-ai/dsh-starhub-tools` 插件把工具调用经 SDK stdio 双向
//! request 桥回本进程:方法 `starhub/tool.execute`,参数 `{ sessionId, name, args }`,
//! result 为模型可读文本字符串;硬错误回 JSON-RPC error(-32603)。
//! 软错误([DUPLICATE]/[FULL]/[NOMATCH]/[AMBIGUOUS]/[Error] …)按旧前端语义
//! 原样作为文本返回,不 throw,由模型自行纠正后重试。
//!
//! 分发:
//! - 全局工具(starhub_list_capabilities / starhub_list_assets)在 Rust 内执行
//!   (tools.rs 本体);
//! - 方案1 域工具(ssh_*/sftp_*/db_query/redis_exec/es_*/docker_*)由
//!   [`domain`](self::domain) 模块在 Rust 主进程内直接执行——连接走
//!   SshManager / SidecarManager,exec 带 exec_id 注册到桥的 inflight,
//!   停止生成时由 `bridge.drain()` 真正中断(不再有「前端执行超时或窗口
//!   已关闭」);
//! - 其余(excel_*)因前端状态依赖,仍 emit `dsh://tool-exec`
//!   转发给拥有该会话的前端面板,经 `dsh_tool_exec_reply` 应答等待结果
//!   (超时 180s)。
//!
//! 工具语义对齐旧前端实现(src/utils/aiTools.ts 与 AiView.vue workspaceTools);
//! 资产查询直读 assets 表(不 hydrate,绝不返回密码/密钥等敏感字段)。

use crate::db;
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::sync::Arc;
use std::time::Duration;

use super::events::{self, RecentExec};
use super::domain;
use super::{HostBridgeState, DOMAIN_EVENT_EVENT, DOMAIN_EVENT_METHOD};

/// 桥方法名(与 vendor/deepseek-harness/packages/starhub/tools/src/index.ts 对齐)。
pub const BRIDGE_METHOD: &str = "starhub/tool.execute";

/// 域工具执行超时(前端面板确认/执行 180s 未应答视为失败)。
const TOOL_EXEC_TIMEOUT: Duration = Duration::from_secs(180);

/// 仍在 Rust 进程内执行的域工具:ssh_*/sftp_*/db_query/redis_exec/es_*/docker_*
/// 已迁移到进程内执行(方案1,见 domain 模块);这里只保留必须由前端面板
/// 执行的工具——工作簿状态在 webview(Univer),无法脱离前端:
/// - Excel:excel_*(当前工作簿在前端 Univer 内存)
/// (与 vendor packages/starhub/tools/src/index.ts 的 BRIDGED_TOOLS 对齐)
const FORWARDED_TOOLS: &[&str] = &[
    // Excel(当前工作簿,前端执行)
    "excel_get_context",
    "excel_write_range",
    "excel_fill_formula",
    "excel_read_range",
    "excel_set_headers",
    "excel_find_replace",
    "excel_add_sheet",
    "excel_remove_sheet",
    "excel_rename_sheet",
    "excel_switch_sheet",
    "excel_style_header",
    "excel_auto_filter",
    "excel_write_cell",
    "excel_insert_rows",
    "excel_delete_rows",
    "excel_insert_cols",
    "excel_delete_cols",
    "excel_sort",
    "excel_filter",
    "excel_clear_filter",
    "excel_freeze",
    "excel_remove_duplicates",
    "excel_dedup_to_sheet",
    "excel_save",
];

/// 方案1:在 Rust 主进程内直接执行的域工具(见 harness/domain.rs)。
/// 这些工具不再 emit `dsh://tool-exec`,因此不受「前端窗口关闭 → 180s 超时」
/// 影响,停止生成也能经 bridge.drain() 真正中断。
/// (与 vendor packages/starhub/tools/src/index.ts 的 BRIDGED_TOOLS 对齐)
const IN_PROCESS_TOOLS: &[&str] = &[
    // SSH(会话绑定 SSH 资产)
    "ssh_exec",
    "ssh_exec_background",
    "ssh_wait_task",
    "ssh_session_status",
    // SFTP(复用会话绑定的 SSH 资产)
    "sftp_list",
    "sftp_stat",
    "sftp_upload",
    "sftp_download",
    // 数据库(会话绑定 DB 资产)
    "db_query",
    // Redis
    "redis_exec",
    // Elasticsearch
    "es_list_indices",
    "es_cluster_health",
    "es_get_mapping",
    "es_search",
    "es_get_document",
    "es_count",
    "es_index_document",
    "es_delete_document",
    "es_delete_index",
    // Docker
    "docker_list_containers",
    "docker_logs",
    "docker_inspect",
    "docker_exec",
];

use tokio::sync::oneshot;

/// 入站桥请求入口(read_loop spawn):校验方法与参数形状后分发执行。
/// 全局工具在 Rust 内执行;域工具转发前端面板并等待应答。
///
/// AI 工具调用审计(v0.103.0):每次执行无论成败都在收口处落一条
/// audit_log(category="ai",action=工具名,含白名单命令文本与耗时),
/// 数据库不可用(测试/未初始化)时静默跳过,绝不影响工具结果。
pub async fn execute_bridge_request(
    method: &str,
    params: Value,
    bridge: Arc<HostBridgeState>,
) -> Result<Value, String> {
    if method != BRIDGE_METHOD {
        return Err(format!("unknown StarHub bridge method: {method}"));
    }
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "starhub/tool.execute 缺少 sessionId".to_string())?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "starhub/tool.execute 缺少 name".to_string())?;
    let args = params.get("args").cloned().unwrap_or(Value::Null);

    let started = std::time::Instant::now();
    let result = dispatch_tool(&bridge, session_id, name, &args).await;
    if let Ok(pool) = db::get_pool() {
        audit_ai_tool(
            pool,
            &bridge,
            session_id,
            name,
            &args,
            started.elapsed(),
            &result,
        )
        .await;
    }
    result.map(Value::String)
}

/// 工具分发:域工具(前端转发 / 进程内执行)与全局工具,返回模型可读文本。
/// `Ok` 为工具结果文本(含软错误),`Err` 为硬错误(回 JSON-RPC error)。
async fn dispatch_tool(
    bridge: &Arc<HostBridgeState>,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    // 域工具不在 Rust 内执行:emit dsh://tool-exec 转发前端面板,await 应答
    if FORWARDED_TOOLS.contains(&name) {
        let text = forward_to_frontend(bridge, session_id, name, args).await?;
        // 联动 M4(契约 §1/§4):域工具成功后自动生成 origin=ai 领域事件,
        // notify dsh + 广播 starhub://domain-event + 写 recentExecs 缓存。
        // 失败路径不产生事件(用户拒绝/超时不代表 AI 动作完成)。
        on_ai_tool_success(bridge, session_id, name, args, &text).await;
        return Ok(text);
    }

    // 方案1:可在 Rust 主进程内直接执行的域工具(ssh_*/sftp_*/db_query/
    // redis_exec/es_*/docker_*)——进程内执行,不依赖前端面板窗口存活,
    // 停止生成经 bridge.drain() 真正中断在途命令。excel_*
    // 因工作簿状态在前端,仍走 FORWARDED_TOOLS。
    if IN_PROCESS_TOOLS.contains(&name) {
        let text = domain::execute_domain_tool(bridge, session_id, name, args).await?;
        on_ai_tool_success(bridge, session_id, name, args, &text).await;
        return Ok(text);
    }

    // AI 浏览器(browser_*):Rust 主进程持有无痕窗口与 eval 通道,进程内执行;
    // 窗口被用户关闭时在途 eval 立即失败收口(BrowserManager.fail_all_pending)。
    if crate::browser::BROWSER_TOOLS.contains(&name) {
        let text = crate::browser::execute_from_bridge(bridge, session_id, name, args).await?;
        on_ai_tool_success(bridge, session_id, name, args, &text).await;
        return Ok(text);
    }

    // 沙箱桌面(desktop_*):Ubuntu 容器沙箱平台,进程内经 sidecar Docker
    // 适配器编排;任务级授权与接管互斥在 desktop 模块执行点强制(设计 §5)。
    if crate::desktop::DESKTOP_TOOLS.contains(&name) {
        let text = crate::desktop::execute_from_bridge(bridge, session_id, name, args).await?;
        on_ai_tool_success(bridge, session_id, name, args, &text).await;
        return Ok(text);
    }

    // Android 实体机(android_*):adb 直连真实设备;任务级授权与接管互斥在
    // android 模块执行点强制(docs/superpowers/specs/2026-08-30-android-device-design.md)。
    if crate::android::ANDROID_TOOLS.contains(&name) {
        let text = crate::android::execute_from_bridge(bridge, session_id, name, args).await?;
        on_ai_tool_success(bridge, session_id, name, args, &text).await;
        return Ok(text);
    }

    // 全局工具在 Rust 内执行;list_capabilities 是静态内容,不需要数据库
    // (测试环境可能没有初始化全局 pool)
    if name == "starhub_list_capabilities" {
        return Ok(list_capabilities());
    }
    let pool = db::get_pool()?;
    execute_tool(pool, name, args).await
}

/// AI 工具审计 detail 里允许携带的参数白名单(与 events::tool_summary 同口径:
/// 只取命令文本 / SQL / 索引 / 容器 / 路径等定位信息,绝不取凭据字段)。
const AUDIT_ARG_WHITELIST: &[&str] = &[
    "command",
    "sql",
    "index",
    "container",
    "target",
    "path",
    "query",
    "server",
    "tool",
    "task_id",
    "url",
    "id",
    "key",
    // AI 浏览器 Jev 决策:当前子目标(定位信息,便于回放「为什么点它」)
    "goal",
    // Android 实体机:无线调试主机 / 文件传输路径(定位信息,非凭据)
    "host",
    "remotePath",
    "localDir",
    "remoteDir",
    "serial",
];

/// AI 工具调用审计(v0.103.0,设置 → 审计「AI」类别):
/// - action = 工具名;target = 会话绑定资产的名称(资产已删回退 id,无绑定为空);
/// - detail 携带 tool、白名单参数文本(单项 ≤500 字符)、durationMs,失败追加 error;
/// - asset_id / session_id 落列,便于按资产 / 会话过滤;subagent 会话沿父链继承绑定。
/// 写入失败只记日志,不影响工具结果。
async fn audit_ai_tool(
    pool: &SqlitePool,
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
    elapsed: Duration,
    result: &Result<String, String>,
) {
    let asset_id = bridge.resolve_asset(session_id).map(|(_asset_type, id)| id);
    let target = match &asset_id {
        Some(id) => sqlx::query_scalar::<_, String>("SELECT name FROM assets WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .or_else(|| Some(id.clone())),
        None => None,
    };
    let mut detail = serde_json::Map::new();
    detail.insert("tool".to_string(), Value::String(name.to_string()));
    for key in AUDIT_ARG_WHITELIST {
        if let Some(value) = args.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) {
            detail.insert((*key).to_string(), Value::String(truncate_chars(value, 500)));
        }
    }
    detail.insert(
        "durationMs".to_string(),
        Value::from(elapsed.as_millis() as u64),
    );
    if let Err(error) = result {
        detail.insert("error".to_string(), Value::String(truncate_chars(error, 500)));
    }
    if let Err(error) = crate::commands::audit::insert_audit_log(
        pool,
        "ai",
        name,
        target.as_deref(),
        Some(Value::Object(detail)),
        Some(session_id),
        asset_id.as_deref(),
        result.is_ok(),
    )
    .await
    {
        tracing::warn!("AI 工具审计写入失败({name}): {error}");
    }
}

/// 域工具转发:emit `dsh://tool-exec` `{requestId, sessionId, name, args}`,
/// 把 pending 存入 map 后 await `dsh_tool_exec_reply`;
/// ok=true 返回 text 作为桥结果,ok=false 把 text 作为工具失败抛回桥;
/// 超时(180s)或应答通道关闭返回固定错误文本。
async fn forward_to_frontend(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    forward_to_frontend_with_timeout(bridge, session_id, name, args, TOOL_EXEC_TIMEOUT).await
}

/// 带超时的域工具转发(测试注入短超时;生产走 [`forward_to_frontend`])。
async fn forward_to_frontend_with_timeout(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
    timeout: Duration,
) -> Result<String, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    bridge
        .emit(
            "dsh://tool-exec",
            serde_json::json!({
                "requestId": request_id,
                "sessionId": session_id,
                "name": name,
                "args": args,
            }),
        )
        .await;
    let (response_tx, response_rx) = oneshot::channel();
    bridge
        .tool_execs
        .lock()
        .await
        .insert(request_id.clone(), response_tx);
    match tokio::time::timeout(timeout, response_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            tracing::warn!("工具执行应答通道已关闭: {name}");
            Err("前端执行通道已关闭".to_string())
        }
        Err(_) => {
            bridge.tool_execs.lock().await.remove(&request_id);
            tracing::warn!("工具执行超时({}s): {name}", timeout.as_secs());
            Err("前端执行超时或窗口已关闭".to_string())
        }
    }
}

/// 域工具成功后的 AI 动作回写(契约 §1/M4):
/// 1. 按工具名映射 kind,summary 单行 ≤200 字符且只取白名单参数(events::ai_tool_event);
/// 2. notify dsh(`starhub/domain.event`,无活跃 runtime 静默跳过);
/// 3. 广播 `starhub://domain-event`(emit 失败只记日志不 panic);
/// 4. 写 recentExecs 缓存(每资产最近一次,输出尾部 ≤2KB;无资产绑定时跳过缓存)。
async fn on_ai_tool_success(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
    output: &str,
) {
    let asset_id = bridge.resolve_asset(session_id).map(|(_asset_type, id)| id);
    let event = events::ai_tool_event(name, args, asset_id.clone());
    let payload = serde_json::to_value(&event).unwrap_or_else(|_| {
        serde_json::json!({ "kind": events::kind_for_tool(name), "ts": events::unix_now() })
    });
    bridge.notify_dsh(DOMAIN_EVENT_METHOD, payload.clone()).await;
    bridge.emit(DOMAIN_EVENT_EVENT, payload).await;
    if let Some(asset_id) = asset_id {
        bridge.record_recent_exec(RecentExec {
            asset_id,
            tool_name: name.to_string(),
            summary: event.summary.clone(),
            tail: events::tail_of(output),
            ts: event.ts,
        });
    }
}

/// 工具分发核心(可注入 pool,便于单测)。返回模型可读文本;Err 为硬错误。
pub(crate) async fn execute_tool(
    pool: &SqlitePool,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    match name {
        "starhub_list_capabilities" => Ok(list_capabilities()),
        "starhub_list_assets" => list_assets(pool, args).await,
        other => Err(format!("unsupported StarHub tool: {other}")),
    }
}

// ============================================================
// starhub_list_capabilities:静态能力清单(内容照抄旧前端 executeWorkspaceTool)
// ============================================================

fn list_capabilities() -> String {
    serde_json::json!({
        "ssh": ["终端", "主机仪表盘", "SFTP", "快速命令", "广播命令", "AI 运维工具"],
        "db": ["MySQL/PostgreSQL/ClickHouse/Redis/Elasticsearch", "SQL 查询", "数据编辑", "结构与监控"],
        "broker": ["Kafka", "NSQ", "Topic/Channel 状态"],
        "docker": ["容器", "镜像", "日志", "Inspect", "SSH/TCP/Socket 连接"],
        "excel": ["工作簿", "CSV", "编辑", "筛选", "排序", "公式", "导入导出"],
        "local": ["Windows PowerShell", "macOS/Linux /bin/sh", "目录与路径元数据", "文本文件读写", "复制/移动/删除"],
        "android": ["Android 实体机(adb)", "截屏回灌", "触控/滑动/按键/输入", "App 启动", "直播围观/接管", "文件传输", "无线调试配对"],
        "application": ["资产与标签导航", "新建连接", "设置", "AI Agents", "Skills"],
    })
    .to_string()
}

// ============================================================
// starhub_list_assets:资产清单(只暴露 id/name/type/context 摘要,不含敏感字段)
// ============================================================

/// 资产连接摘要(src/utils/aiMention.ts assetSummary 的 Rust 移植,只取非敏感字段)
fn asset_summary(asset_type: &str, name: &str, config: &Value) -> String {
    let get = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
    match asset_type {
        "ssh" => format!(
            "{}:{}",
            if get("host").is_empty() {
                "-"
            } else {
                get("host")
            },
            {
                let port = config.get("port").and_then(Value::as_i64).unwrap_or(22);
                port
            }
        ),
        "db" => format!(
            "{} · {}",
            if get("dbType").is_empty() {
                "mysql"
            } else {
                get("dbType")
            },
            {
                let address = get("address");
                let host = get("host");
                if !address.is_empty() {
                    address
                } else if !host.is_empty() {
                    host
                } else {
                    "-"
                }
            }
        ),
        "docker" => {
            let transport = get("dockerTransport");
            let remote = get("remoteHost");
            if !transport.is_empty() {
                transport.to_string()
            } else if !remote.is_empty() {
                remote.to_string()
            } else {
                "local".to_string()
            }
        }
        "local" => {
            let root = get("rootPath");
            if !root.is_empty() {
                root.to_string()
            } else if !name.is_empty() {
                name.to_string()
            } else {
                "-".to_string()
            }
        }
        _ => {
            let format = get("format");
            if format.is_empty() {
                "xlsx".to_string()
            } else {
                format.to_string()
            }
        }
    }
}

async fn list_assets(pool: &SqlitePool, args: &Value) -> Result<String, String> {
    let type_filter = args
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    // 只取摘要所需列;config_json 里绝不含密码/密钥(落库前已 split 到 Keyring)
    let rows = sqlx::query(
        "SELECT id, type, name, config_json FROM assets ORDER BY favorite DESC, updated_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch assets: {e}"))?;
    let mut result = Vec::new();
    for row in &rows {
        let asset_type: String = row.try_get("type").map_err(|e| e.to_string())?;
        if let Some(filter) = &type_filter {
            if !filter.is_empty() && &asset_type != filter {
                continue;
            }
        }
        let id: String = row.try_get("id").map_err(|e| e.to_string())?;
        let name: String = row.try_get("name").map_err(|e| e.to_string())?;
        let config_json: String = row.try_get("config_json").map_err(|e| e.to_string())?;
        let config: Value = serde_json::from_str(&config_json).unwrap_or(Value::Null);
        result.push(serde_json::json!({
            "id": id,
            "name": name,
            "type": asset_type,
            "context": asset_summary(&asset_type, &name, &config),
        }));
    }
    serde_json::to_string(&result).map_err(|e| e.to_string())
}
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let kept: String = text.chars().take(max).collect();
        format!("{kept}\u{2026}")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::sync::mpsc;

    /// 无绑定/无父链的空桥(测试默认);全局工具不需要绑定解析。
    fn empty_bridge() -> HostBridgeState {
        HostBridgeState::default()
    }

    /// 建立 in-memory SQLite 池并执行完整 CREATE_TABLES(单连接,保证同一份内存库)
    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");
        sqlx::raw_sql(crate::db::schema::CREATE_TABLES)
            .execute(&pool)
            .await
            .expect("create tables");
        pool
    }

    // ---------- starhub_list_capabilities ----------

    #[tokio::test]
    async fn list_capabilities_is_static_json() {
        let pool = setup_pool().await;
        let text = execute_tool(
            &pool,
            "starhub_list_capabilities",
            &Value::Null,
        )
        .await
        .expect("list_capabilities");
        let parsed: Value = serde_json::from_str(&text).expect("合法 JSON");
        for key in [
            "ssh",
            "db",
            "broker",
            "docker",
            "excel",
            "local",
            "application",
        ] {
            assert!(parsed.get(key).is_some(), "缺 {key} 域");
        }
        assert!(parsed["ssh"]
            .as_array()
            .expect("数组")
            .contains(&Value::String("终端".into())));
    }

    // ---------- starhub_list_assets ----------

    #[tokio::test]
    async fn list_assets_filters_and_hides_secrets() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO assets (id, type, name, config_json, tags, created_at, updated_at)
             VALUES ('a1', 'ssh', '测试服务器', '{\"host\":\"10.0.0.1\",\"port\":2222}', '[]', 1, 1),
                    ('a2', 'db', '生产库', '{\"dbType\":\"mysql\",\"address\":\"db.internal:3306\"}', '[]', 2, 2)",
        )
        .execute(&pool)
        .await
        .expect("insert assets");

        let all = execute_tool(
            &pool,
            "starhub_list_assets",
            &serde_json::json!({}),
        )
        .await
        .expect("list all");
        let parsed: Value = serde_json::from_str(&all).expect("合法 JSON");
        assert_eq!(parsed.as_array().expect("数组").len(), 2);

        let filtered = execute_tool(
            &pool,
            "starhub_list_assets",
            &serde_json::json!({"type": "ssh"}),
        )
        .await
        .expect("list ssh");
        let parsed: Value = serde_json::from_str(&filtered).expect("合法 JSON");
        let items = parsed.as_array().expect("数组");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "a1");
        assert_eq!(items[0]["context"], "10.0.0.1:2222");
        // 不返回 config / 任何敏感字段
        assert!(items[0].get("config").is_none());
        assert!(!filtered.contains("password"), "不应包含敏感字段");
    }

    #[tokio::test]
    async fn execute_tool_rejects_unknown() {
        let pool = setup_pool().await;
        let err = execute_tool(
            &pool,
            "no_such_tool",
            &Value::Null,
        )
        .await
        .expect_err("未知工具应报硬错误");
        assert!(err.contains("unsupported StarHub tool"), "{err}");
    }

    // ---------- 域工具转发(dsh://tool-exec → dsh_tool_exec_reply) ----------

    /// 域工具桥(方案1 后仍转发前端的工具):emit `dsh://tool-exec` 事件
    /// (requestId/sessionId/name/args),应答(ok=true)后文本作为桥结果返回。
    /// 用 excel_get_context(前端工作簿域)验证转发路径;ssh_*/db_query 等已
    /// 迁到进程内执行(见 domain 模块),不再走此路径。
    #[tokio::test]
    async fn domain_tool_forwards_to_frontend_and_returns_text() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        let params = serde_json::json!({
            "sessionId": "sess-1",
            "name": "excel_get_context",
            "args": {},
        });
        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move { execute_bridge_request("starhub/tool.execute", params, bridge).await }
        });

        let (event, payload) = emit_rx.recv().await.expect("应收到 dsh://tool-exec 事件");
        assert_eq!(event, "dsh://tool-exec");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        assert_eq!(payload["sessionId"], "sess-1");
        assert_eq!(payload["name"], "excel_get_context");
        assert!(bridge.tool_execs.lock().await.contains_key(&request_id));

        bridge
            .resolve_tool_exec(
                &request_id,
                true,
                "total 0\n-rw-r--r-- 1 u u 0 f".to_string(),
            )
            .await;
        let result = handle
            .await
            .expect("桥执行完成")
            .expect("应答 ok=true 应返回文本");
        assert_eq!(result, "total 0\n-rw-r--r-- 1 u u 0 f");
        assert!(!bridge.tool_execs.lock().await.contains_key(&request_id));
    }

    /// 域工具桥:ok=false 时 text 作为工具失败抛回桥(Err)。
    /// 用 excel_get_context(仍转发前端)验证;db_query 已迁到进程内执行。
    #[tokio::test]
    async fn domain_tool_reply_error_propagates_as_failure() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                execute_bridge_request(
                    "starhub/tool.execute",
                    serde_json::json!({
                        "sessionId": "sess-1",
                        "name": "excel_get_context",
                        "args": {},
                    }),
                    bridge,
                )
                .await
            }
        });
        let (_event, payload) = emit_rx.recv().await.expect("应收到事件");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        bridge
            .resolve_tool_exec(&request_id, false, "用户拒绝:高风险 SQL".to_string())
            .await;
        let err = handle
            .await
            .expect("桥执行完成")
            .expect_err("ok=false 应把 text 作为错误抛给桥");
        assert_eq!(err, "用户拒绝:高风险 SQL");
    }

    /// 域工具桥:180s 生产常量不可等,走带超时的内部实现验证超时错误文本。
    #[tokio::test]
    async fn domain_tool_timeout_returns_error_text() {
        let bridge = empty_bridge();
        let err = forward_to_frontend_with_timeout(
            &bridge,
            "sess-1",
            "ssh_exec",
            &serde_json::json!({ "command": "sleep 1" }),
            Duration::from_millis(50),
        )
        .await
        .expect_err("超时应失败");
        assert_eq!(err, "前端执行超时或窗口已关闭");
        assert!(
            bridge.tool_execs.lock().await.is_empty(),
            "超时后 pending 应清理"
        );
    }

    /// 未知 requestId 的工具执行应答:幂等成功。
    #[tokio::test]
    async fn tool_exec_reply_unknown_request_id_is_noop() {
        let bridge = empty_bridge();
        assert!(
            !bridge
                .resolve_tool_exec("missing", true, "x".to_string())
                .await
        );
    }

    /// 缺 sessionId 的桥请求:硬错误(与插件失败语义一致)。
    #[tokio::test]
    async fn execute_bridge_request_requires_session_id() {
        let bridge = Arc::new(empty_bridge());
        let err = execute_bridge_request(
            "starhub/tool.execute",
            serde_json::json!({ "name": "ssh_exec", "args": {} }),
            bridge,
        )
        .await
        .expect_err("缺 sessionId 应报错");
        assert!(err.contains("sessionId"), "{err}");
    }

    // ---------- 联动 M4:AI 动作回写(origin=ai 领域事件 + recentExecs) ----------

    /// 前端桥接工具成功后:广播 `starhub://domain-event`(origin=ai,assetId 来自会话绑定),
    /// recentExecs 缓存写入(输出尾部 ≤2KB);notify dsh 无 runtime 时静默跳过。
    ///
    /// ssh_exec 已迁移到 Rust 进程内执行,在无 Tauri AppHandle 的单测中不能等待
    /// 旧的 `dsh://tool-exec` 回调。excel_get_context 仍走前端桥接,可稳定覆盖成功回写路径。
    #[tokio::test]
    async fn forwarded_tool_success_generates_ai_domain_event_and_recent_exec() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        bridge.bind_session("sess-1", "ssh", "a1");

        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                execute_bridge_request(
                    "starhub/tool.execute",
                    serde_json::json!({
                        "sessionId": "sess-1",
                        "name": "excel_get_context",
                        "args": {},
                    }),
                    bridge,
                )
                .await
            }
        });
        let (_event, payload) = emit_rx.recv().await.expect("应收到 dsh://tool-exec 事件");
        assert_eq!(payload["name"], "excel_get_context");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        bridge
            .resolve_tool_exec(&request_id, true, "当前工作簿已就绪".to_string())
            .await;
        let result = handle
            .await
            .expect("桥执行完成")
            .expect("应答 ok=true 应返回文本");
        assert_eq!(result, "当前工作簿已就绪");

        // 随后应收到 starhub://domain-event 广播
        let (event, payload) = emit_rx.recv().await.expect("应收到 domain-event 广播");
        assert_eq!(event, "starhub://domain-event");
        assert_eq!(payload["origin"], "ai");
        assert_eq!(payload["assetId"], "a1");
        assert_eq!(payload["kind"], "tool.executed");
        assert!(payload["summary"]
            .as_str()
            .expect("summary")
            .starts_with("excel_get_context"));
        assert!(payload["ts"].as_i64().expect("ts") > 0);

        // recentExecs 已缓存(每资产一条,tail 为输出尾部)
        let recents = bridge.recent_execs();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].asset_id, "a1");
        assert_eq!(recents[0].tool_name, "excel_get_context");
        assert_eq!(recents[0].tail, "当前工作簿已就绪");
        assert!(recents[0].ts > 0);
    }

    /// 域工具失败(用户拒绝/超时):不产生 AI 事件、不写 recentExecs。
    #[tokio::test]
    async fn domain_tool_failure_does_not_generate_ai_event() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        bridge.bind_session("sess-1", "ssh", "a1");

        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                execute_bridge_request(
                    "starhub/tool.execute",
                    serde_json::json!({
                        "sessionId": "sess-1",
                        "name": "excel_get_context",
                        "args": {},
                    }),
                    bridge,
                )
                .await
            }
        });
        let (_event, payload) = emit_rx.recv().await.expect("应收到 tool-exec 事件");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        bridge
            .resolve_tool_exec(&request_id, false, "用户拒绝:高风险 SQL".to_string())
            .await;
        let err = handle
            .await
            .expect("桥执行完成")
            .expect_err("ok=false 应把 text 作为错误抛给桥");
        assert_eq!(err, "用户拒绝:高风险 SQL");
        // 不应有 domain-event 广播,recentExecs 为空
        assert!(emit_rx.try_recv().is_err(), "失败路径不应产生领域事件");
        assert!(bridge.recent_execs().is_empty(), "失败路径不应写 recentExecs");
    }

    /// 未绑定资产的会话执行域工具:事件 assetId 省略,recentExecs 不缓存(无 key)。
    #[tokio::test]
    async fn ai_event_without_asset_binding_omits_asset_id() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                execute_bridge_request(
                    "starhub/tool.execute",
                    serde_json::json!({
                        "sessionId": "sess-nobody",
                        "name": "excel_get_context",
                        "args": {},
                    }),
                    bridge,
                )
                .await
            }
        });
        let (_event, payload) = emit_rx.recv().await.expect("应收到 tool-exec 事件");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        bridge
            .resolve_tool_exec(&request_id, true, "root".to_string())
            .await;
        handle.await.expect("桥执行完成").expect("成功");
        let (event, payload) = emit_rx.recv().await.expect("应收到 domain-event 广播");
        assert_eq!(event, "starhub://domain-event");
        assert_eq!(payload["origin"], "ai");
        assert!(payload.get("assetId").is_none(), "无资产上下文应省略 assetId");
        assert!(bridge.recent_execs().is_empty(), "无 assetId 不应缓存");
    }

    /// 长输出写入 recentExecs 时 tail 被截断到 ≤2KB(char 边界安全)。
    #[tokio::test]
    async fn ai_recent_exec_tail_is_capped_at_2kb() {
        let (emit_tx, _emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        bridge.bind_session("sess-1", "ssh", "a1");
        let long_output = "汉".repeat(3000);
        on_ai_tool_success(&bridge, "sess-1", "ssh_exec", &serde_json::json!({ "command": "x" }), &long_output)
            .await;
        let recents = bridge.recent_execs();
        assert_eq!(recents.len(), 1);
        assert!(
            recents[0].tail.len() <= events::MAX_EXEC_TAIL_BYTES,
            "tail 应 ≤2KB,实际 {} 字节",
            recents[0].tail.len()
        );
        assert!(long_output.ends_with(&recents[0].tail), "tail 应为输出尾部");
    }

    // ---------- AI 工具调用审计(v0.103.0,设置 → 审计「AI」类别) ----------

    /// 审计写入:成功/失败都落 category=ai 行;绑定资产时 target 解析为资产名,
    /// detail 只含白名单参数(command/sql/index …)+ durationMs,失败追加 error。
    #[tokio::test]
    async fn audit_ai_tool_writes_success_and_failure_rows() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO assets (id, type, name, config_json, tags, created_at, updated_at)
             VALUES ('a1', 'ssh', '生产机', '{}', '[]', 1, 1)",
        )
        .execute(&pool)
        .await
        .expect("insert asset");
        let bridge = empty_bridge();
        bridge.bind_session("sess-1", "ssh", "a1");

        audit_ai_tool(
            &pool,
            &bridge,
            "sess-1",
            "ssh_exec",
            &serde_json::json!({ "command": "systemctl restart nginx", "password": "不应入审计" }),
            Duration::from_millis(12),
            &Ok("ok".to_string()),
        )
        .await;
        audit_ai_tool(
            &pool,
            &bridge,
            "sess-1",
            "db_query",
            &serde_json::json!({ "sql": "select 1" }),
            Duration::from_millis(3),
            &Err("用户拒绝:高风险 SQL".to_string()),
        )
        .await;
        // 无绑定会话:target / asset_id 为空
        audit_ai_tool(
            &pool,
            &bridge,
            "sess-nobody",
            "es_search",
            &serde_json::json!({ "index": "logs-*" }),
            Duration::ZERO,
            &Ok("[]".to_string()),
        )
        .await;

        let rows = sqlx::query(
            "SELECT category, action, target, detail, session_id, asset_id, success FROM audit_log ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("query audit_log");
        assert_eq!(rows.len(), 3);

        let first = &rows[0];
        assert_eq!(first.get::<String, _>("category"), "ai");
        assert_eq!(first.get::<String, _>("action"), "ssh_exec");
        assert_eq!(first.get::<String, _>("target"), "生产机");
        assert_eq!(first.get::<String, _>("session_id"), "sess-1");
        assert_eq!(first.get::<String, _>("asset_id"), "a1");
        assert_eq!(first.get::<i32, _>("success"), 1);
        let detail: Value = serde_json::from_str(&first.get::<String, _>("detail")).expect("detail JSON");
        assert_eq!(detail["command"], "systemctl restart nginx");
        assert_eq!(detail["tool"], "ssh_exec");
        assert!(detail["durationMs"].as_u64().is_some(), "应带 durationMs");
        assert!(detail.get("password").is_none(), "非白名单字段不应入审计");
        assert!(detail.get("error").is_none(), "成功行不应带 error");

        let second = &rows[1];
        assert_eq!(second.get::<i32, _>("success"), 0);
        let detail: Value = serde_json::from_str(&second.get::<String, _>("detail")).expect("detail JSON");
        assert_eq!(detail["sql"], "select 1");
        assert_eq!(detail["error"], "用户拒绝:高风险 SQL");

        let third = &rows[2];
        assert!(third.get::<Option<String>, _>("target").is_none());
        assert!(third.get::<Option<String>, _>("asset_id").is_none());
        let detail: Value = serde_json::from_str(&third.get::<String, _>("detail")).expect("detail JSON");
        assert_eq!(detail["index"], "logs-*");
    }
}
