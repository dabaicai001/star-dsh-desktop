//! dsh(deepseek-harness)runtime 的 stdio JSON-RPC 最小回路(P0-4)。
//!
//! 传输协议(vendor/deepseek-harness Phase 0 POC 实测结论):
//! - NDJSON,一行一个 JSON-RPC 2.0 帧;stdout 只走协议帧,日志在 stderr。
//! - 请求 `{"jsonrpc":"2.0","id":N,"method":M,"params":P}`;
//!   响应仅带 id+result/error;通知仅带 method+params。
//! - 方法:`initialize` / `session/prompt` / `shutdown`;
//!   通知:`session.event`(流式增量)、`session.status`(running/idle,一轮结束的权威信号)。
//! - 已知坑 G-1:跑过 LLM turn 的进程在 shutdown 响应后会以 0xC0000409 退出
//!   (libuv 断言,无害)——以收到 shutdown 响应为完成信号,忽略退出码。
//! - 已知坑 G-3:sessionId 复用已持久化的 id 会 id collision,每个新会话用全新 id。
//!
//! 路径解析:env 覆盖优先(`STARHUB_DSH_NODE` / `STARHUB_DSH_RUNTIME_DIR` /
//! `STARHUB_DSH_CONFIG` / `STARHUB_DSH_SESSION_ROOT`),缺省走 dev 布局
//! (current_exe 向上找 vendor/deepseek-harness)+ 应用数据目录的 dsh-sessions。
//!
//! cancel 语义(方案 D1 / 附录 11.3):SDK 协议无 mid-turn cancel,
//! `HarnessManager::cancel` 直接杀进程并清空单例,下一轮 initialize 时重启 runtime。
//!
//! 双向 request 桥(Phase 2 / 方案 5.2):dsh 侧经 sdk-transport 发回两个方法,
//! 都在 [`HostBridgeState`] 上挂 pending 并 await 前端应答——
//! - `starhub/approval.request`(`{sessionId, toolName, callId?, reason?}`):
//!   emit `dsh://approval` 事件,前端确认卡经 `dsh_approval_reply` 应答,
//!   结果 `{outcome: "allowed-once" | "rejected"}`;超时(300s)或通道关闭按拒绝。
//! - `starhub/tool.execute`(`{sessionId, name, args}`):见 `tools` 模块,
//!   全局工具在 Rust 内执行,域工具 emit `dsh://tool-exec` 转发前端面板。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// P1-4:StarHub 宿主工具执行端(dsh starhub-tools 插件的桥请求在此分发)。
pub mod tools;

/// 方案1:进程内域工具执行器(域工具直接在 Rust 主进程执行,不再依赖前端面板)。
mod domain;

/// 沙箱桌面模块复用域执行器的 sidecar 连接原语。
pub(crate) use domain::{connect_sidecar, load_asset_config, sidecar_call, sidecar_call_with_timeout};

/// StarHub × dsh 联动:领域事件 schema(契约 §1,四方共用)。
pub mod events;

/// 支线 B:dsh 用户插件管理(插件目录、registry、entries yml 生成、
/// peer junction、市场目录、zip 安装、spawn 前包装配置生成)。
pub mod plugins;

/// 主壳融合 P1:dsh web GUI 组合的长驻管理器(spawn bin.js web、
/// 端口递增、就绪探测、随应用退出回收)。
pub mod web;

/// 默认 RPC 超时;initialize 与 prompt 响应都很快,流式输出走通知不占此超时。
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// 单行帧上限,超出即判定 runtime 异常,防止异常输出打爆内存。
const MAX_FRAME_LINE_BYTES: usize = 64 * 1024 * 1024;

/// 审批桥方法名(与 vendor/deepseek-harness/packages/starhub/approval/src/index.ts 对齐)。
pub const APPROVAL_BRIDGE_METHOD: &str = "starhub/approval.request";
/// 审批应答超时:前端确认卡 300s 未应答按拒绝处理(与插件 fail-closed 语义一致)。
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

// ── 联动(docs/联动实施-桥接契约-2026-08-17.md)方法/事件名 ──
// §2.1 Rust → dsh notification(单向无响应,经 JsonRpcLineTransport.notify 出站,
// dsh 侧 sdk-notifications 按方法名分发给订阅插件;无活跃 runtime 静默跳过)。
/// 注册表全量快照(注册表每次变更:attach/detach/断线剔除)。
pub const REGISTRY_SYNC_METHOD: &str = "starhub/registry.sync";
/// 领域事件(事件产生即报,payload 为 events::DomainEvent)。
pub const DOMAIN_EVENT_METHOD: &str = "starhub/domain.event";
// §2.2 dsh → Rust request(在 handle_inbound_request 注册)。
/// 活性快照:`{}` → `{ sessions, transfers, recentExecs }`。
pub const LIVE_SNAPSHOT_METHOD: &str = "starhub/live.snapshot";
/// 打开资产页面(tool 缺省 "auto")。
pub const OPEN_ASSET_METHOD: &str = "starhub/open.asset";
/// 聚焦工具页(tool 必填)。
pub const FOCUS_TOOL_METHOD: &str = "starhub/focus.tool";
/// 仅绑定当前 AI 会话到资产,不触发任何窗口操作。
pub const BIND_ASSET_METHOD: &str = "starhub/bind.asset";
/// 长期记忆卡拉取:`{ scopes, sessionId? }` → `{ cards }`(memory-context 插件
/// pre-step 注入用;sessionId 用于沿 subagent 父链解析资产绑定追加 asset 卡)。
pub const MEMORY_CARDS_METHOD: &str = "starhub/memory.cards";
/// 长期记忆写入(2026-08-22,memory-sink 沉淀路径):`{ scope, content }` → `{ row }`
/// (memory-sink 钩子 agent/turn-stopping 后调一次 LLM 抽取本轮持久事实,
/// 落 ai_memories;UI 不直接走它,UI 仍走 `ai_memory_add` Tauri command 经 approval 门)。
pub const MEMORY_WRITE_METHOD: &str = "starhub/memory.write";
// §3 Tauri 事件(Rust → 前端)。
/// 领域事件广播(全部窗口)。
pub const DOMAIN_EVENT_EVENT: &str = "starhub://domain-event";
/// 开窗/聚焦指令(主壳 emit_to("main"),client-nav 消费)。
pub const OPEN_ASSET_EVENT: &str = "starhub://open-asset";
/// 「问 AI」入口(主壳 emit_to("main"),client-nav prefill composer)。
pub const ASK_AI_EVENT: &str = "starhub://ask-ai";

/// dsh runtime 仓库内相对路径(Phase 0 POC 验证过的启动命令)。
const RUNTIME_BIN_REL: &str = "packages/examples/jsonrpc-demo/lib/bin.js";
/// StarHub 专用组合(P1-3):纯对话内核,无 bash/fs/subagent 工具;
/// 资产工具自 P1-4 起经 starhub-tools 插件接入。
/// pub(crate):支线 B 的包装配置(plugins::prepare_runtime_config)引用它。
pub(crate) const RUNTIME_CONFIG_REL: &str = "examples/starhub-agent/cordis.yml";
/// prod 闭包入口(packaged-bin.js:runJsonrpcAgent(import.meta.url),裸插件从
/// 物化后的 node_modules 闭包解析)。
const RUNTIME_BIN_PACKAGED_REL: &str =
    "node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js";
/// prod 闭包配置(入包脚本把 examples/starhub-agent/cordis.yml 平移到 config/)。
const RUNTIME_CONFIG_PACKAGED_REL: &str = "config/starhub-agent.yml";
/// prod 资源目录名(tauri.conf.json bundle.resources 引用,落到 resource_dir 下)。
const RUNTIME_RESOURCE_DIR: &str = "dsh-runtime";

/// 便携 node 二进制文件名(Windows 为 node.exe,其余平台为 node)。
const NODE_EXE_NAME: &str = if cfg!(target_os = "windows") {
    "node.exe"
} else {
    "node"
};

/// runtime_dir 是否为 prod 闭包布局(以 packaged 入口是否存在判定)。
fn is_packaged_runtime(runtime_dir: &Path) -> bool {
    runtime_dir.join(RUNTIME_BIN_PACKAGED_REL).exists()
}

/// 入口 bin 相对 runtime_dir 的路径(dev/prod 布局不同)。
fn runtime_bin_rel(runtime_dir: &Path) -> &'static str {
    if is_packaged_runtime(runtime_dir) {
        RUNTIME_BIN_PACKAGED_REL
    } else {
        RUNTIME_BIN_REL
    }
}

/// 主组合配置相对 runtime_dir 的路径(dev/prod 布局不同)。
/// pub(crate):plugins::prepare_runtime_config 复用同一份判定。
pub(crate) fn runtime_config_rel(runtime_dir: &Path) -> &'static str {
    if is_packaged_runtime(runtime_dir) {
        RUNTIME_CONFIG_PACKAGED_REL
    } else {
        RUNTIME_CONFIG_REL
    }
}

/// 模型与接入配置,前端从 StarHub AI 设置(多模型列表 / Keyring)解析后经
/// `dsh_initialize` 传入;key/baseUrl 经 env 注入 dsh 子进程,不落配置文件。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DshModelConfig {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub max_tokens: Option<u32>,
    /// Agent 角色提示词,经 DSH_SYSTEM_PROMPT env 注入(agent-spine persona)。
    pub system_prompt: Option<String>,
}

#[derive(Debug, Error)]
pub enum HarnessError {
    #[error("dsh runtime 未初始化,请先调用 dsh_initialize")]
    NotInitialized,
    #[error("启动 dsh runtime 失败: {0}")]
    Spawn(String),
    #[error("dsh runtime 路径解析失败: {0}")]
    PathResolve(String),
    #[error("dsh runtime 连接已断开: {0}")]
    Disconnected(String),
    #[error("dsh RPC 超时({0}s)")]
    Timeout(u64),
    #[error("dsh RPC 错误 {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("内部错误: {0}")]
    Internal(String),
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct JsonRpcError {
    pub(crate) code: i64,
    pub(crate) message: String,
}

/// 入站帧:响应(带 id)或通知(带 method)或入站 request(method+id 同现,
/// P1-4 工具执行回调桥;dsh 侧 request id 是 `req_<uuid>` 字符串,原样回写)。
#[derive(Debug, Deserialize)]
pub(crate) struct IncomingFrame {
    pub(crate) id: Option<serde_json::Value>,
    pub(crate) result: Option<serde_json::Value>,
    pub(crate) error: Option<JsonRpcError>,
    pub(crate) method: Option<String>,
    pub(crate) params: Option<serde_json::Value>,
}

/// 通知回调:(method, params)。生产环境接到 tauri emit,测试接到 mpsc。
type NotificationSink = Arc<dyn Fn(String, serde_json::Value) + Send + Sync>;

/// 桥事件回调:(event, payload)。生产环境 tauri emit 到所有 webview,测试接到 mpsc。
type EventSink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

type ResponseSender = oneshot::Sender<Result<serde_json::Value, HarnessError>>;
type PendingResponses = Arc<tokio::sync::Mutex<HashMap<u64, ResponseSender>>>;

/// dsh web 进程的 notification 出站回调(method, params);由 web.rs 注册。
pub type WebNotifySink = Arc<dyn Fn(String, serde_json::Value) + Send + Sync>;

/// 在途进程内域工具执行的取消句柄:key(request_id) → 中止动作。
/// 停止生成(cancel)时逐个执行,让在 Rust 主进程内跑的命令(SSH exec)
/// 真正被中断,而不是等它们自然结束。
pub enum InflightAbort {
    /// SSH exec:经 `ssh_exec_abort_core` 关掉远端 channel(带 exec_id)。
    SshExec { conn_id: String, exec_id: String },
}

/// 宿主桥共享状态(Phase 2):入站双向 request 的应答 pending 表 + 会话资产绑定。
/// 由 [`HarnessManager`] 持有,spawn 时把 Arc 克隆进 [`HarnessRuntime`]
/// (read_loop 分发入站请求用),Tauri command 层经 `HarnessManager::bridge()`
/// resolve 前端应答;`bindings` / `subagent_parents` 用 std Mutex 以便
/// 同步闭包(emit_notification)直接写入。
pub struct HostBridgeState {
    /// pending 审批应答:requestId(uuid)→ 应答通道(true = allowed-once)。
    pub approvals: tokio::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// pending 域工具执行:requestId(uuid)→ 应答通道(Ok(text) = 成功,Err = 前端报错)。
    pub tool_execs: tokio::sync::Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    /// 在途进程内域工具执行:request_id(uuid)→ 取消句柄(cancel 时逐个 abort)。
    pub inflight_tools: std::sync::Mutex<HashMap<String, InflightAbort>>,
    /// 会话→资产绑定:sessionId → (assetType, assetId),由 `dsh_bind_session` 写入。
    pub bindings: std::sync::Mutex<HashMap<String, (String, String)>>,
    /// subagent 子→父会话映射:childSessionId → parentSessionId,
    /// 由 `subagent.started` / `subagent.finished` 通知记录。
    pub subagent_parents: std::sync::Mutex<HashMap<String, String>>,
    /// 前端事件发射:`dsh://approval` / `dsh://tool-exec` / `starhub://domain-event`;
    /// 生产为 webview emit,测试为 mpsc。initialize 时由 manager 设置。
    emit: tokio::sync::Mutex<EventSink>,
    /// 当前 runtime 的弱引用(联动:Rust → dsh notification 出站)。
    /// spawn 后由 manager 写入;runtime 回收后 upgrade 失败 = 无活跃 runtime,
    /// notify 静默跳过(契约 §8)。Weak 避免与 HarnessRuntime.bridge 形成 Arc 环。
    dsh_runtime: std::sync::Mutex<Weak<HarnessRuntime>>,
    /// dsh web(壳)进程的 notification 出站(2026-08-18):web 组合同样挂
    /// session-registry / domain-events,Rust 的 registry.sync / domain.event
    /// 通知要同时投给嵌入 runtime 与 web 进程;web 关闭时由 manager 清除。
    web_notify: std::sync::Mutex<Option<WebNotifySink>>,
    /// AppHandle(open.asset emit_to("main") / live.snapshot 取 SshManager 等 state 用);
    /// initialize 时写入,测试环境为空(相关 handler 返回降级结果)。
    app: std::sync::Mutex<Option<tauri::AppHandle>>,
    /// AI 工具执行缓存:assetId → 最近一次执行的摘要 + 输出尾部(≤2KB),
    /// 契约 §2.2 live.snapshot 的 recentExecs;内存环形,每资产只留 1 条。
    recent_execs: std::sync::Mutex<HashMap<String, events::RecentExec>>,
    /// M6:每个 dsh session 访问过的资产轨迹,去重保序且有界。
    task_trails: std::sync::Mutex<HashMap<String, Vec<String>>>,
}

impl Default for HostBridgeState {
    /// 空桥:no-op 事件发射器(生产环境在 initialize 时经 [`Self::set_emit`] 覆盖;
    /// 测试可直接用或注入 mpsc)。
    fn default() -> Self {
        Self::new(Arc::new(|_event, _payload| {}))
    }
}

impl HostBridgeState {
    /// 用指定事件发射器构造(测试注入 mpsc;生产用 [`Self::set_emit`])。
    pub fn new(emit: EventSink) -> Self {
        Self {
            approvals: tokio::sync::Mutex::new(HashMap::new()),
            tool_execs: tokio::sync::Mutex::new(HashMap::new()),
            inflight_tools: std::sync::Mutex::new(HashMap::new()),
            bindings: std::sync::Mutex::new(HashMap::new()),
            subagent_parents: std::sync::Mutex::new(HashMap::new()),
            emit: tokio::sync::Mutex::new(emit),
            dsh_runtime: std::sync::Mutex::new(Weak::new()),
            app: std::sync::Mutex::new(None),
            recent_execs: std::sync::Mutex::new(HashMap::new()),
            task_trails: std::sync::Mutex::new(HashMap::new()),
            web_notify: std::sync::Mutex::new(None),
        }
    }

    /// 设置事件发射器(每次 initialize spawn 前调用,覆盖默认 no-op)。
    pub async fn set_emit(&self, emit: EventSink) {
        *self.emit.lock().await = emit;
    }

    /// 发射一条桥事件(approval / tool-exec / domain-event);发射器缺失时静默丢弃。
    pub async fn emit(&self, event: &str, payload: serde_json::Value) {
        let sink = self.emit.lock().await.clone();
        sink(event, payload);
    }

    /// 写入当前 runtime 的弱引用(每次 spawn 后由 manager 调用)。
    pub fn set_runtime(&self, runtime: &Arc<HarnessRuntime>) {
        *self.dsh_runtime.lock().unwrap() = Arc::downgrade(runtime);
    }

    /// Rust → dsh notification(契约 §2.1,单向无响应);
    /// 同时投给嵌入 runtime 与 dsh web(壳)进程;对应进程未运行/已回收时静默跳过。
    pub async fn notify_dsh(&self, method: &str, params: serde_json::Value) {
        let runtime = self.dsh_runtime.lock().unwrap().upgrade();
        if let Some(runtime) = runtime {
            if let Err(error) = runtime.notify(method, params.clone()).await {
                tracing::warn!("dsh 通知 {method} 发送失败: {error}");
            }
        }
        let web = self.web_notify.lock().unwrap().clone();
        if let Some(web) = web {
            web(method.to_string(), params);
        }
    }

    /// 注册 dsh web(壳)进程的 notification 出站(web.rs spawn 后调用);返回一个
    /// 把本字段清空的闭包(web 子进程退出时调用,避免 write 到已关闭的 pipe 报 EPIPE)。
    /// `shared` 是与调用同一 Arc 的桥(测试可直接传临时 Arc)。
    pub fn set_web_notify(&self, shared: Arc<Self>, sink: WebNotifySink) -> impl Fn() + Send + 'static {
        *self.web_notify.lock().unwrap() = Some(sink);
        let weak = Arc::downgrade(&shared);
        move || {
            if let Some(this) = weak.upgrade() {
                *this.web_notify.lock().unwrap() = None;
            }
        }
    }

    /// 写入 AppHandle(initialize 时调用;open.asset / live.snapshot 取 state 用)。
    pub fn set_app(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    /// 当前 AppHandle(测试环境为 None,相关 handler 走降级路径)。
    pub fn app(&self) -> Option<tauri::AppHandle> {
        self.app.lock().unwrap().clone()
    }

    /// 记录一个资产最近一次 AI 工具执行(每资产只留 1 条,覆盖式)。
    pub fn record_recent_exec(&self, exec: events::RecentExec) {
        self.recent_execs
            .lock()
            .unwrap()
            .insert(exec.asset_id.clone(), exec);
    }

    /// recentExecs 缓存快照(live.snapshot 用)。
    pub fn recent_execs(&self) -> Vec<events::RecentExec> {
        self.recent_execs.lock().unwrap().values().cloned().collect()
    }

    /// 记录 M6 任务访问资产:去重保序,最多保留最近 20 个资产。
    pub fn record_task_asset(&self, session_id: &str, asset_id: &str) {
        if session_id.trim().is_empty() || asset_id.trim().is_empty() {
            return;
        }
        let mut trails = self.task_trails.lock().unwrap();
        let trail = trails.entry(session_id.to_string()).or_default();
        trail.retain(|id| id != asset_id);
        trail.push(asset_id.to_string());
        if trail.len() > 20 {
            let excess = trail.len() - 20;
            trail.drain(..excess);
        }
    }

    /// M6 任务轨迹快照(live.snapshot 用)。
    pub fn task_trails(&self) -> Vec<serde_json::Value> {
        self.task_trails
            .lock()
            .unwrap()
            .iter()
            .map(|(session_id, asset_ids)| serde_json::json!({
                "sessionId": session_id,
                "assetIds": asset_ids,
            }))
            .collect()
    }

    /// 记录 会话→资产 绑定;asset_id 为空视为解除绑定。
    pub fn bind_session(&self, session_id: &str, asset_type: &str, asset_id: &str) {
        let mut bindings = self.bindings.lock().unwrap();
        if asset_id.trim().is_empty() {
            bindings.remove(session_id);
        } else {
            bindings.insert(
                session_id.to_string(),
                (asset_type.to_string(), asset_id.to_string()),
            );
        }
    }

    /// 记录 subagent 子→父会话映射(子代理会话继承父会话的资产绑定)。
    pub fn record_subagent_parent(&self, child_session_id: &str, parent_session_id: &str) {
        self.subagent_parents
            .lock()
            .unwrap()
            .insert(child_session_id.to_string(), parent_session_id.to_string());
    }

    /// 沿 subagent 父链向上解析会话的资产绑定(子代理继承父会话绑定);
    /// 无绑定返回 None。环引用(异常通知)以 visited 集防御。
    pub fn resolve_asset(&self, session_id: &str) -> Option<(String, String)> {
        let mut current = session_id.to_string();
        let mut visited = std::collections::HashSet::new();
        loop {
            if let Some(binding) = self.bindings.lock().unwrap().get(&current) {
                return Some(binding.clone());
            }
            if !visited.insert(current.clone()) {
                return None;
            }
            let parent = self.subagent_parents.lock().unwrap().get(&current)?.clone();
            current = parent;
        }
    }

    /// 严格按**会话自身**解析资产绑定(不沿 subagent 父链继承)。
    ///
    /// `resolve_asset`(沿父链)供**写路径**用——memory 工具写入 asset 级记忆时
    /// 子代理继承父会话绑定是合理语义;但**读路径**(memory-context 的 pre-step
    /// 注入)若也沿父链,会把旧会话绑定的资产记忆卡带进一个全新会话(无 `@` 也
    /// 出现)。为满足「严格按会话隔离」,注入路径改用本方法:只命中当前会话
    /// **精确**绑定的资产,未绑定则不加 asset 卡。
    ///
    /// @returns 仅当 session_id 本身已绑定资产时返回 (asset_type, asset_id)。
    pub fn resolve_asset_strict(&self, session_id: &str) -> Option<(String, String)> {
        self.bindings
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
    }

    /// resolve 一条审批应答;未知 requestId(已超时/重复应答)记日志并返回 false。
    pub async fn resolve_approval(&self, request_id: &str, approved: bool) -> bool {
        match self.approvals.lock().await.remove(request_id) {
            Some(response_tx) => {
                let _ = response_tx.send(approved);
                true
            }
            None => {
                tracing::warn!("收到未知 requestId 的审批应答: {request_id}");
                false
            }
        }
    }

    /// resolve 一条域工具执行应答;未知 requestId(已超时/重复应答)记日志并返回 false。
    pub async fn resolve_tool_exec(&self, request_id: &str, ok: bool, text: String) -> bool {
        match self.tool_execs.lock().await.remove(request_id) {
            Some(response_tx) => {
                let result = if ok { Ok(text) } else { Err(text) };
                let _ = response_tx.send(result);
                true
            }
            None => {
                tracing::warn!("收到未知 requestId 的工具执行应答: {request_id}");
                false
            }
        }
    }

    /// 清空全部未决桥请求:审批按拒绝、工具执行按失败,避免前端应答悬空
    /// 或等待方长时间挂起(cancel / shutdown / 重启重建时调用)。
    /// 同时中止全部在途进程内域工具(SSH exec abort / 任务 abort),
    /// 让停止生成真正中断正在 Rust 主进程内跑的命令。
    async fn drain(&self) {
        let approvals: Vec<oneshot::Sender<bool>> = {
            let mut map = self.approvals.lock().await;
            map.drain().map(|(_, tx)| tx).collect()
        };
        for response_tx in approvals {
            let _ = response_tx.send(false);
        }
        let tool_execs: Vec<oneshot::Sender<Result<String, String>>> = {
            let mut map = self.tool_execs.lock().await;
            map.drain().map(|(_, tx)| tx).collect()
        };
        for response_tx in tool_execs {
            let _ = response_tx.send(Err("dsh runtime 已关闭,工具未执行".to_string()));
        }
        // 中止在途进程内工具:SSH exec 走 ssh_exec_abort_core。
        let inflight: Vec<(String, InflightAbort)> = {
            let mut map = self.inflight_tools.lock().unwrap();
            map.drain().collect()
        };
        let app = self.app();
        for (_request_id, abort) in inflight {
            match abort {
                InflightAbort::SshExec { conn_id, exec_id } => {
                    if let Some(app) = &app {
                        use tauri::Manager;
                        let manager = app.state::<crate::commands::ssh::SshManager>();
                        if let Err(error) =
                            crate::commands::ssh::ssh_exec_abort_core(&manager, &conn_id, &exec_id)
                                .await
                        {
                            tracing::warn!("中止在途 SSH exec 失败({conn_id}): {error}");
                        }
                    }
                }
            }
        }
    }
}

/// 出站帧:已预序列化;request_id 仅我们发出的请求携带(写失败时定位 pending),
/// 入站 request 的响应帧为 None。
pub(crate) struct OutboundFrame {
    pub(crate) request_id: Option<u64>,
    pub(crate) payload: String,
}

/// 单条 runtime 进程连接:写通道 + pending 请求表 + 子进程句柄。
pub struct HarnessRuntime {
    tx: mpsc::Sender<OutboundFrame>,
    pending: PendingResponses,
    child: Mutex<Child>,
    next_id: AtomicU64,
    /// 宿主桥共享状态(入站 request 分发用;与 manager / command 层同一 Arc)。
    bridge: Arc<HostBridgeState>,
}

impl HarnessRuntime {
    /// spawn 便携 node + jsonrpc-demo bin(cwd = runtime_dir),stderr 转发 tracing。
    ///
    /// `extra_env` 注入模型凭证(DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL)、persona
    /// (DSH_SYSTEM_PROMPT)、DSH_SESSION_ROOT / DSH_CWD / DSH_SETTINGS_PATH 与
    /// 测试 mock LLM 配置;未注入的项靠进程环境自然继承。
    /// `bridge` 为宿主桥共享状态(审批/工具执行应答 + 会话绑定),与 manager 同 Arc。
    pub fn spawn(
        runtime_dir: PathBuf,
        node_path: PathBuf,
        config_path: PathBuf,
        extra_env: Vec<(String, String)>,
        on_notification: NotificationSink,
        bridge: Arc<HostBridgeState>,
    ) -> Result<Arc<Self>, HarnessError> {
        let mut cmd = Command::new(&node_path);
        let bin_rel = runtime_bin_rel(&runtime_dir);
        cmd.arg(bin_rel)
            .arg(&config_path)
            .current_dir(&runtime_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .envs(extra_env);

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            HarnessError::Spawn(format!("{} {}: {e}", node_path.display(), bin_rel))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| HarnessError::Spawn("无法获取 stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HarnessError::Spawn("无法获取 stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| HarnessError::Spawn("无法获取 stderr".into()))?;

        let (tx, rx) = mpsc::channel::<OutboundFrame>(100);
        let pending: PendingResponses = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        tokio::spawn(Self::write_loop(stdin, rx, pending.clone()));
        // read_loop 需要回写通道:入站 request(工具执行回调)的响应帧经它发出
        tokio::spawn(Self::read_loop(
            stdout,
            pending.clone(),
            on_notification,
            tx.clone(),
            bridge.clone(),
        ));
        tokio::spawn(Self::stderr_drain(stderr));

        tracing::info!(
            "dsh runtime spawned: node={} cwd={}",
            node_path.display(),
            runtime_dir.display()
        );
        let runtime = Arc::new(Self {
            tx,
            pending,
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            bridge,
        });
        runtime.bridge.set_runtime(&runtime);
        Ok(runtime)
    }

    async fn write_loop(
        mut stdin: tokio::process::ChildStdin,
        mut rx: mpsc::Receiver<OutboundFrame>,
        pending: PendingResponses,
    ) {
        while let Some(frame) = rx.recv().await {
            let write_result = async {
                stdin.write_all(frame.payload.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await;
            if let Err(error) = write_result {
                if let Some(request_id) = frame.request_id {
                    Self::fail_request(
                        &pending,
                        request_id,
                        HarnessError::Disconnected(format!("写入 stdin 失败: {error}")),
                    )
                    .await;
                }
                Self::fail_all(&pending, "dsh runtime stdin 已关闭").await;
                break;
            }
        }
    }

    async fn read_loop(
        stdout: tokio::process::ChildStdout,
        pending: PendingResponses,
        on_notification: NotificationSink,
        tx: mpsc::Sender<OutboundFrame>,
        bridge: Arc<HostBridgeState>,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut line: Vec<u8> = Vec::new();
        loop {
            let chunk = match reader.fill_buf().await {
                Ok(chunk) => chunk,
                Err(error) => {
                    Self::fail_all(&pending, &format!("读取 dsh runtime 响应失败: {error}")).await;
                    break;
                }
            };
            if chunk.is_empty() {
                Self::fail_all(&pending, "dsh runtime 关闭了 stdout").await;
                break;
            }
            match chunk.iter().position(|byte| *byte == b'\n') {
                Some(pos) => {
                    if line.len() + pos > MAX_FRAME_LINE_BYTES {
                        Self::fail_all(&pending, "dsh runtime 响应行超过 64MB 上限").await;
                        break;
                    }
                    line.extend_from_slice(&chunk[..pos]);
                    let consumed = pos + 1;
                    match serde_json::from_slice::<IncomingFrame>(&line) {
                        Ok(frame) => {
                            Self::dispatch_frame(frame, &pending, &on_notification, &tx, &bridge)
                                .await
                        }
                        Err(error) => {
                            tracing::warn!("dsh runtime 帧解析失败: {error}");
                        }
                    }
                    line.clear();
                    reader.consume(consumed);
                }
                None => {
                    // 增量检查单行上限,避免超长行先把内存打爆才被截断
                    if line.len() + chunk.len() > MAX_FRAME_LINE_BYTES {
                        Self::fail_all(&pending, "dsh runtime 响应行超过 64MB 上限").await;
                        break;
                    }
                    line.extend_from_slice(chunk);
                    let consumed = chunk.len();
                    reader.consume(consumed);
                }
            }
        }
    }

    async fn dispatch_frame(
        frame: IncomingFrame,
        pending: &PendingResponses,
        on_notification: &NotificationSink,
        tx: &mpsc::Sender<OutboundFrame>,
        bridge: &Arc<HostBridgeState>,
    ) {
        // 入站 request(method+id 同现,审批桥 / 工具执行回调):spawn 执行并回写响应帧,
        // 不阻塞 read_loop(工具可能查库/等前端,id 原样回写——dsh 侧是字符串)
        if let (Some(id), Some(method)) = (frame.id.clone(), frame.method.clone()) {
            if frame.result.is_none() && frame.error.is_none() {
                let tx = tx.clone();
                let params = frame.params.unwrap_or(serde_json::Value::Null);
                let bridge = bridge.clone();
                tokio::spawn(async move {
                    let payload = match handle_inbound_request(&method, params, bridge).await {
                        Ok(result) => {
                            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
                        }
                        Err(InboundError::MethodNotFound(message)) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32601, "message": message },
                        }),
                        Err(InboundError::Failed(message)) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32603, "message": message },
                        }),
                    };
                    if tx
                        .send(OutboundFrame {
                            request_id: None,
                            payload: payload.to_string(),
                        })
                        .await
                        .is_err()
                    {
                        tracing::warn!("dsh runtime 写通道已关闭,工具响应无法回写: {method}");
                    }
                });
                return;
            }
        }
        // 响应帧:带 id 且 result/error 至少其一(约定响应不含 method);
        // 我们发出的请求 id 是 u64,按 u64 匹配 pending
        if frame.id.is_some() && (frame.result.is_some() || frame.error.is_some()) {
            let id = frame.id.and_then(|id| id.as_u64());
            let result = match frame.error {
                Some(error) => Err(HarnessError::Rpc {
                    code: error.code,
                    message: error.message,
                }),
                None => Ok(frame.result.unwrap_or(serde_json::Value::Null)),
            };
            match id {
                Some(id) => {
                    if let Some(response_tx) = pending.lock().await.remove(&id) {
                        let _ = response_tx.send(result);
                    } else {
                        tracing::warn!("收到未知请求 id 的 dsh 响应: {id}");
                    }
                }
                None => tracing::warn!("收到非 u64 id 的 dsh 响应,无法匹配 pending"),
            }
            return;
        }
        // 通知帧:仅 method+params
        if let Some(method) = frame.method {
            on_notification(method, frame.params.unwrap_or(serde_json::Value::Null));
        }
    }

    async fn fail_request(pending: &PendingResponses, request_id: u64, error: HarnessError) {
        if let Some(response_tx) = pending.lock().await.remove(&request_id) {
            let _ = response_tx.send(Err(error));
        }
    }

    async fn fail_all(pending: &PendingResponses, message: &str) {
        let senders = {
            let mut pending = pending.lock().await;
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for response_tx in senders {
            let _ = response_tx.send(Err(HarnessError::Disconnected(message.to_string())));
        }
    }

    async fn stderr_drain(stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // dsh runtime 的日志全走 stderr,降级为 info 避免刷屏告警
            tracing::info!("dsh runtime stderr: {}", line.trim());
        }
    }

    /// 发送请求并等待响应。
    pub async fn call(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, HarnessError> {
        self.call_with_timeout(method, params, DEFAULT_RPC_TIMEOUT)
            .await
    }

    /// 发送 notification(单向、无 id、无响应;契约 §2.1:
    /// `starhub/registry.sync` / `starhub/domain.event` 经此出站,
    /// dsh 侧 sdk-notifications 按方法名分发给订阅插件)。
    pub async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), HarnessError> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        .to_string();
        self.tx
            .send(OutboundFrame {
                request_id: None,
                payload,
            })
            .await
            .map_err(|_| HarnessError::Disconnected("dsh runtime 未运行".into()))
    }

    async fn call_with_timeout(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<serde_json::Value, HarnessError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let payload = match serde_json::to_string(&request) {
            Ok(payload) => payload,
            Err(error) => {
                return Err(HarnessError::Internal(format!("序列化请求失败: {error}")));
            }
        };
        let (response_tx, response_rx) = oneshot::channel();
        self.pending.lock().await.insert(id, response_tx);
        if self
            .tx
            .send(OutboundFrame {
                request_id: Some(id),
                payload,
            })
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(HarnessError::Disconnected("dsh runtime 未运行".into()));
        }
        match tokio::time::timeout(timeout, response_rx).await {
            Ok(result) => {
                result.map_err(|_| HarnessError::Disconnected("响应通道已关闭".into()))?
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(HarnessError::Timeout(timeout.as_secs()))
            }
        }
    }

    /// 发送 shutdown 并杀掉子进程。
    ///
    /// 已知坑 G-1:跑过 LLM turn 的进程在 shutdown 响应后会以 0xC0000409 退出
    /// (libuv 断言,无害),以收到响应为完成信号,不等待也不解读退出码。
    pub async fn shutdown(&self) -> Result<(), HarnessError> {
        self.call("shutdown", None).await?;
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
        Ok(())
    }

    /// 立即杀子进程,不等 shutdown 响应(cancel 兜底:SDK 协议无 mid-turn cancel)。
    pub async fn abort(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }
}

/// 入站 request 错误:未知方法走 JSON-RPC method-not-found(-32601),
/// 执行失败走 internal error(-32603)。
#[derive(Debug, Error)]
pub enum InboundError {
    #[error("unknown StarHub bridge method: {0}")]
    MethodNotFound(String),
    #[error("{0}")]
    Failed(String),
}

impl From<String> for InboundError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

/// 入站双向 request 分发:审批桥(`starhub/approval.request`)、工具执行桥
/// (`starhub/tool.execute`,见 tools 模块)与联动四个方法
/// (`starhub/live.snapshot` / `starhub/bind.asset` / `starhub/open.asset` /
/// `starhub/focus.tool`,契约 §2.2);其余方法报 JSON-RPC method-not-found(-32601)。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_inbound_request(
    method: &str,
    params: serde_json::Value,
    bridge: Arc<HostBridgeState>,
) -> Result<serde_json::Value, InboundError> {
    match method {
        APPROVAL_BRIDGE_METHOD => handle_approval_request(params, bridge)
            .await
            .map_err(InboundError::Failed),
        tools::BRIDGE_METHOD => tools::execute_bridge_request(method, params, bridge)
            .await
            .map_err(InboundError::Failed),
        LIVE_SNAPSHOT_METHOD => handle_live_snapshot(bridge).await,
        MEMORY_CARDS_METHOD => handle_memory_cards(params, bridge).await,
        MEMORY_WRITE_METHOD => handle_memory_write(params, bridge).await,
        BIND_ASSET_METHOD => handle_bind_asset(params, bridge).await,
        OPEN_ASSET_METHOD => handle_open_asset(params, bridge, false).await,
        FOCUS_TOOL_METHOD => handle_open_asset(params, bridge, true).await,
        other => Err(InboundError::MethodNotFound(format!(
            "unknown StarHub bridge method: {other}"
        ))),
    }
}

/// `starhub/live.snapshot`(契约 §2.2):注册表快照 + 传输任务 + recentExecs。
/// sessions 来源是 SessionRegistry(附着语义层)按 SshManager 存活表剔除断线条目;
/// transfers 来自 TransferManager 全量任务(assetId 经注册表按 sessionId 反查,
/// 查不到即省略);recentExecs 来自桥上的每资产最近一条 AI 执行缓存。
/// 快照时若剔除断线条目(注册表变更),顺带补发一次 registry.sync。
async fn handle_live_snapshot(
    bridge: Arc<HostBridgeState>,
) -> Result<serde_json::Value, InboundError> {
    let mut sessions = Vec::new();
    let mut transfers = Vec::new();
    if let Some(app) = bridge.app() {
        use tauri::Manager;
        let registry = app.state::<crate::registry::SessionRegistry>();
        let live_ids: std::collections::HashSet<String> = {
            // guard 绑定为局部变量,在块尾先于 state 绑定释放(避免 E0597)
            let ssh = app.state::<crate::commands::ssh::SshManager>();
            let guard = ssh.sessions.lock().await;
            guard.keys().cloned().collect()
        };
        let (snapshot, pruned) = registry.snapshot(&live_ids);
        sessions = snapshot;
        if pruned {
            // 剔除断线条目属于注册表变更:向 dsh 补发全量快照(无 runtime 静默跳过)
            let params = serde_json::json!({ "sessions": sessions });
            bridge.notify_dsh(REGISTRY_SYNC_METHOD, params).await;
        }
        let transfer_manager = app.state::<crate::sftp::transfer::TransferManager>();
        for task in transfer_manager.list_all_tasks().await {
            let mut item = serde_json::json!({
                "id": task.id,
                "direction": task.direction,
                "bytes": task.transferred_bytes,
                "totalBytes": task.total_bytes,
                "state": task.status,
            });
            if let Some(asset_id) = registry.asset_for_session(&task.session_id) {
                item["assetId"] = serde_json::Value::String(asset_id);
            }
            transfers.push(item);
        }
    }
    let recent_execs = bridge.recent_execs();
    Ok(serde_json::json!({
        "sessions": sessions,
        "transfers": transfers,
        "recentExecs": recent_execs,
        "taskTrails": bridge.task_trails(),
    }))
}

/// `starhub/memory.cards`:按 scopes 拉取长期记忆卡(dsh memory-context 插件
/// pre-step 注入用)。传了 sessionId 时沿 subagent 父链解析会话资产绑定,
/// 追加 `asset:{id}` 卡;数据库不可用或查询失败按 Failed 上报(调用方降级为不注入)。
async fn handle_memory_cards(
    params: serde_json::Value,
    bridge: Arc<HostBridgeState>,
) -> Result<serde_json::Value, InboundError> {
    let mut scopes: Vec<String> = params
        .get("scopes")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if scopes.is_empty() {
        return Err(InboundError::Failed(format!(
            "{MEMORY_CARDS_METHOD} 缺少 scopes"
        )));
    }
    if let Some(session_id) = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        // 严格按会话自身解析资产绑定:注入路径不沿 subagent 父链继承,避免
        // 把旧会话绑定的资产记忆卡带进全新会话(无 `@` 也出现)。memory 工具
        // 的写入路径沿用 resolve_asset(保留父链继承),两者语义不同。
        if let Some((_asset_type, asset_id)) = bridge.resolve_asset_strict(session_id) {
            scopes.push(format!("asset:{asset_id}"));
        }
    }
    let pool = crate::db::get_pool().map_err(InboundError::Failed)?;
    let cards = crate::commands::ai_memory::build_memory_cards(pool, &scopes)
        .await
        .map_err(|error| InboundError::Failed(format!("读取记忆卡失败: {error}")))?;
    Ok(serde_json::json!({ "cards": cards }))
}

/// `starhub/memory.write`(2026-08-22,memory-sink 自动沉淀路径):
/// `memory-sink` 钩子在 `agent/turn-stopping` 后调 LLM 抽本轮持久事实,
/// 再调本方法落 ai_memories。`scope` 取 `user` / `global` / `folder:<path>` /
/// `asset:<id>`,空内容或超长直接报 Failed(由 memory-sink 自行回退)。
/// 不写 audit(避免后台高频沉淀污染审计面板);`memory_add` 命令(UI 直调)
/// 路径仍走 approval-bridge 与 audit,与本路径解耦。
async fn handle_memory_write(
    params: serde_json::Value,
    _bridge: Arc<HostBridgeState>,
) -> Result<serde_json::Value, InboundError> {
    let scope = params
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InboundError::Failed(format!("{MEMORY_WRITE_METHOD} 缺少 scope")))?;
    let content = params
        .get("content")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InboundError::Failed(format!("{MEMORY_WRITE_METHOD} 缺少 content")))?;
    let pool = crate::db::get_pool().map_err(InboundError::Failed)?;
    let row = crate::commands::ai_memory::add_memory(pool, scope, content)
        .await
        .map_err(|error| {
            // Rust 侧 add_memory 失败原因含 [FULL] / [DUPLICATE] / [AMBIGUOUS] /
            // [NOMATCH] / 容量上限 / DB 错;原样上抛,前端(memory-sink)解析后
            // 当轮合并重试或忽略。
            InboundError::Failed(error)
        })?;
    Ok(serde_json::json!({ "row": row }))
}

/// 从 SQLite 资产表解析真实资产类型。UI 工具名不能作为域工具路由类型。
async fn resolve_asset_type(asset_id: &str) -> Result<String, InboundError> {
    use sqlx::Row;

    let pool = crate::db::get_pool().map_err(InboundError::Failed)?;
    let row = sqlx::query("SELECT type FROM assets WHERE id = ?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| InboundError::Failed(format!("读取资产 {asset_id} 失败: {error}")))?
        .ok_or_else(|| InboundError::Failed(format!("资产不存在: {asset_id}")))?;
    row.try_get("type")
        .map_err(|error| InboundError::Failed(format!("读取资产 {asset_id} 类型失败: {error}")))
}

/// `starhub/bind.asset`:仅记录会话→资产绑定与任务轨迹,不发出窗口事件。
/// 该路径供自动巡检等后台域工具调用,必须保持无 UI 副作用。
async fn handle_bind_asset(
    params: serde_json::Value,
    bridge: Arc<HostBridgeState>,
) -> Result<serde_json::Value, InboundError> {
    let asset_id = params
        .get("assetId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| InboundError::Failed(format!("{BIND_ASSET_METHOD} 缺少 assetId")))?;
    let session_id = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| InboundError::Failed(format!("{BIND_ASSET_METHOD} 缺少 sessionId")))?;
    let asset_type = resolve_asset_type(asset_id).await?;

    bridge.bind_session(session_id, &asset_type, asset_id);
    bridge.record_task_asset(session_id, asset_id);
    Ok(serde_json::json!({ "ok": true, "action": "bound" }))
}

/// `starhub/open.asset` / `starhub/focus.tool`(契约 §2.2/M5):
/// emit `starhub://open-asset` 到主壳(emit_to("main")),由 client-nav 真正
/// 开窗/聚焦;fire-and-forget,立即返回 `{ ok: true, action }`。
/// action 由注册表的开窗记录预判(已有该资产窗口 = focused,否则 opened);
/// `require_tool` 区分 focus.tool(tool 必填)与 open.asset(tool 缺省 "auto")。
async fn handle_open_asset(
    params: serde_json::Value,
    bridge: Arc<HostBridgeState>,
    require_tool: bool,
) -> Result<serde_json::Value, InboundError> {
    let method = if require_tool {
        FOCUS_TOOL_METHOD
    } else {
        OPEN_ASSET_METHOD
    };
    let asset_id = params
        .get("assetId")
        .and_then(serde_json::Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| InboundError::Failed(format!("{method} 缺少 assetId")))?;
    let tool = match params
        .get("tool")
        .and_then(serde_json::Value::as_str)
        .filter(|v| !v.trim().is_empty())
    {
        Some(tool) => tool.to_string(),
        None if require_tool => {
            return Err(InboundError::Failed(format!("{method} 缺少 tool")));
        }
        None => "auto".to_string(),
    };
    let asset_type = resolve_asset_type(asset_id).await?;
    if let Some(session_id) = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|v| !v.trim().is_empty())
    {
        bridge.bind_session(session_id, &asset_type, asset_id);
        bridge.record_task_asset(session_id, asset_id);
    }

    let Some(app) = bridge.app() else {
        // 测试/未初始化环境:无窗口可开,按 opened 立即返回(契约 fire-and-forget)
        return Ok(serde_json::json!({ "ok": true, "action": "opened" }));
    };
    use tauri::{Emitter, Manager};
    let registry = app.state::<crate::registry::SessionRegistry>();
    let action = registry.open_or_focus(asset_id, &tool);
    if let Err(error) = app.emit_to(
        "main",
        OPEN_ASSET_EVENT,
        serde_json::json!({
            "assetId": asset_id,
            "tool": tool,
            "action": action,
        }),
    ) {
        // Tauri emit 失败记日志不 panic(契约 §8)
        tracing::warn!("事件 {OPEN_ASSET_EVENT} 发送失败: {error}");
    }
    let result_action = if action == "open" { "opened" } else { "focused" };
    Ok(serde_json::json!({ "ok": true, "action": result_action }))
}

/// `starhub/approval.request`:生成 requestId(uuid),emit `dsh://approval`
/// `{requestId, sessionId, toolName, callId?, reason?}` 到所有 webview,把 pending
/// 存入 map 后 await 前端应答;`dsh_approval_reply` 应答后返回
/// `{outcome: "allowed-once" | "rejected"}`;超时(300s)或应答通道关闭一律按拒绝。
async fn handle_approval_request(
    params: serde_json::Value,
    bridge: Arc<HostBridgeState>,
) -> Result<serde_json::Value, String> {
    handle_approval_request_with_timeout(params, bridge, APPROVAL_TIMEOUT).await
}

/// 带超时的审批桥实现(测试注入短超时;生产走 [`handle_approval_request`])。
async fn handle_approval_request_with_timeout(
    params: serde_json::Value,
    bridge: Arc<HostBridgeState>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let session_id = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "starhub/approval.request 缺少 sessionId".to_string())?;
    let tool_name = params
        .get("toolName")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "starhub/approval.request 缺少 toolName".to_string())?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let mut payload = serde_json::json!({
        "requestId": request_id,
        "sessionId": session_id,
        "toolName": tool_name,
    });
    if let Some(call_id) = params.get("callId").and_then(serde_json::Value::as_str) {
        payload["callId"] = serde_json::Value::String(call_id.to_string());
    }
    if let Some(reason) = params.get("reason").and_then(serde_json::Value::as_str) {
        payload["reason"] = serde_json::Value::String(reason.to_string());
    }
    bridge.emit("dsh://approval", payload).await;

    let (response_tx, response_rx) = oneshot::channel();
    bridge
        .approvals
        .lock()
        .await
        .insert(request_id.clone(), response_tx);
    let approved = match tokio::time::timeout(timeout, response_rx).await {
        Ok(Ok(approved)) => approved,
        Ok(Err(_)) => {
            tracing::warn!("审批应答通道已关闭,按拒绝处理: {tool_name}");
            false
        }
        Err(_) => {
            bridge.approvals.lock().await.remove(&request_id);
            tracing::warn!("审批超时({}s),按拒绝处理: {tool_name}", timeout.as_secs());
            false
        }
    };
    let outcome = if approved { "allowed-once" } else { "rejected" };
    Ok(serde_json::json!({ "outcome": outcome }))
}

/// dsh runtime 路径配置(env 覆盖优先,见模块注释)。
pub struct HarnessPaths {
    pub node_path: PathBuf,
    pub runtime_dir: PathBuf,
    pub config_path: PathBuf,
    /// 是否为 prod 打包布局(resource_dir()/dsh-runtime),web.rs 据此切换 dist 来源。
    pub is_packaged: bool,
}

impl HarnessPaths {
    /// dev-only 解析:env 覆盖优先,否则从 current_exe 向上找 vendor/deepseek-harness。
    /// prod 打包布局请用 [`Self::resolve_for_app`]。
    pub fn resolve() -> Result<Self, HarnessError> {
        let runtime_dir = match std::env::var("STARHUB_DSH_RUNTIME_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => Self::find_runtime_dir()?,
        };
        Self::from_runtime_dir(runtime_dir)
    }

    /// prod 优先解析:env 覆盖优先 → resource_dir()/dsh-runtime → dev 布局。
    pub fn resolve_for_app(app: &tauri::AppHandle) -> Result<Self, HarnessError> {
        if let Ok(dir) = std::env::var("STARHUB_DSH_RUNTIME_DIR") {
            return Self::from_runtime_dir(PathBuf::from(dir));
        }
        if let Some(dir) = Self::find_packaged_runtime_dir(app) {
            return Self::from_runtime_dir(dir);
        }
        Self::resolve()
    }

    /// 用已确定的 runtime_dir 组装 node/config(env 覆盖优先,相对路径按布局切换)。
    fn from_runtime_dir(runtime_dir: PathBuf) -> Result<Self, HarnessError> {
        let is_packaged = is_packaged_runtime(&runtime_dir);
        let node_path = match std::env::var("STARHUB_DSH_NODE") {
            Ok(node) => PathBuf::from(node),
            Err(_) => Self::default_node(&runtime_dir),
        };
        let config_path = match std::env::var("STARHUB_DSH_CONFIG") {
            Ok(config) => PathBuf::from(config),
            Err(_) => runtime_dir.join(runtime_config_rel(&runtime_dir)),
        };
        Ok(Self {
            node_path,
            runtime_dir,
            config_path,
            is_packaged,
        })
    }

    /// prod 资源目录(resource_dir()/dsh-runtime),入口不存在则视为非打包布局。
    fn find_packaged_runtime_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().ok()?;
        let dir = resource_dir.join(RUNTIME_RESOURCE_DIR);
        dir.join(RUNTIME_BIN_PACKAGED_REL).exists().then_some(dir)
    }

    /// 从 current_exe 向上找包含 vendor/deepseek-harness 的目录(dev 布局)。
    fn find_runtime_dir() -> Result<PathBuf, HarnessError> {
        let marker = PathBuf::from("vendor")
            .join("deepseek-harness")
            .join(RUNTIME_BIN_REL);
        let exe_dir = std::env::current_exe()
            .map_err(|e| HarnessError::PathResolve(format!("current_exe 失败: {e}")))?;
        for ancestor in exe_dir.ancestors() {
            let candidate = ancestor.join(&marker);
            if candidate.exists() {
                return Ok(ancestor.join("vendor").join("deepseek-harness"));
            }
        }
        Err(HarnessError::PathResolve(format!(
            "未找到 {},可用 STARHUB_DSH_RUNTIME_DIR 指定",
            marker.display()
        )))
    }

    /// 便携 Node:prod 在 <runtime_dir>/<NODE_EXE_NAME>,dev 在 <repo>/tmp/node24/<NODE_EXE_NAME>;
    /// 不存在时回退 PATH 上的 node。
    fn default_node(runtime_dir: &Path) -> PathBuf {
        let portable = if is_packaged_runtime(runtime_dir) {
            runtime_dir.join(NODE_EXE_NAME)
        } else {
            runtime_dir
                .join("..")
                .join("..")
                .join("tmp")
                .join("node24")
                .join(NODE_EXE_NAME)
        };
        if portable.exists() {
            return portable;
        }
        PathBuf::from("node")
    }
}

/// 挂在 tauri State 上的 runtime 单例管理器(对齐 SidecarManager 模式)。
pub struct HarnessManager {
    runtime: tokio::sync::Mutex<Option<Arc<HarnessRuntime>>>,
    /// 串行化 initialize,消除并发 spawn 的 TOCTOU
    start_lock: tokio::sync::Mutex<()>,
    /// 上次 spawn 的环境指纹(api_key/base_url/persona/session_root/cwd/settings);
    /// 这些只能经 env 在进程启动时注入,变化即重启 runtime。
    spawn_fingerprint: tokio::sync::Mutex<Option<String>>,
    /// 宿主桥共享状态(审批/工具执行应答 + 会话资产绑定 + subagent 父链);
    /// command 层(dsh_approval_reply 等)经 [`Self::bridge`] 访问。
    bridge: Arc<HostBridgeState>,
}

impl HarnessManager {
    pub fn new() -> Self {
        Self {
            runtime: tokio::sync::Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            spawn_fingerprint: tokio::sync::Mutex::new(None),
            bridge: Arc::new(HostBridgeState::default()),
        }
    }

    /// 宿主桥共享状态(审批/工具执行应答、会话绑定);Tauri command 层用它 resolve。
    pub fn bridge(&self) -> Arc<HostBridgeState> {
        self.bridge.clone()
    }

    /// 组装 dsh 子进程 env:模型凭证(DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL)、
    /// persona(DSH_SYSTEM_PROMPT)、会话持久化根(DSH_SESSION_ROOT,默认应用数据目录,
    /// 缺省会落到 runtime 目录 ./.sessions 污染 vendor)、工作目录(DSH_CWD)与
    /// 共享设置文件(DSH_SETTINGS_PATH = <dsh-web-home>/settings.yaml,与 web GUI 同一份)。
    fn build_spawn_env(
        app: &tauri::AppHandle,
        cwd: &Option<String>,
        config: &DshModelConfig,
    ) -> Result<Vec<(String, String)>, HarnessError> {
        use tauri::Manager;
        let mut env: Vec<(String, String)> = Vec::new();
        if let Some(key) = config.api_key.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DEEPSEEK_API_KEY".into(), key.into()));
        }
        if let Some(url) = config.base_url.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DEEPSEEK_BASE_URL".into(), url.into()));
        }
        if let Some(prompt) = config.system_prompt.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DSH_SYSTEM_PROMPT".into(), prompt.into()));
        }
        if let Some(dir) = cwd.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DSH_CWD".into(), dir.into()));
        }
        let session_root = match std::env::var("STARHUB_DSH_SESSION_ROOT") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|e| HarnessError::PathResolve(format!("app_data_dir 失败: {e}")))?
                    .join("dsh-sessions");
                std::fs::create_dir_all(&dir).map_err(|e| {
                    HarnessError::PathResolve(format!("创建会话目录 {} 失败: {e}", dir.display()))
                })?;
                dir
            }
        };
        env.push((
            "DSH_SESSION_ROOT".into(),
            session_root.to_string_lossy().into_owned(),
        ));
        // 与 dsh web GUI 共享同一份 settings.yaml(权限 preset):
        // 路径解析复用 harness::web::dsh_home_dir(STARHUB_DSH_WEB_HOME 覆盖同源)。
        let settings_path = crate::harness::web::dsh_home_dir(app)
            .map_err(|e| HarnessError::PathResolve(format!("DSH_HOME 解析失败: {e}")))?
            .join("settings.yaml");
        env.push((
            "DSH_SETTINGS_PATH".into(),
            settings_path.to_string_lossy().into_owned(),
        ));
        Ok(env)
    }

    /// spawn(如未运行或 env 指纹已变)并发送 initialize。
    /// 返回 `{ serverInfo, restarted }`:restarted=true 表示 runtime 进程是本次新起的
    /// (此前会话的 dsh 侧上下文已随旧进程丢失,前端应换全新 sessionId,见 G-3)。
    pub async fn initialize(
        &self,
        app: &tauri::AppHandle,
        cwd: Option<String>,
        config: DshModelConfig,
    ) -> Result<serde_json::Value, HarnessError> {
        let _start_guard = self.start_lock.lock().await;
        let env = Self::build_spawn_env(app, &cwd, &config)?;
        let fingerprint = env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("\n");
        let needs_spawn = self.runtime.lock().await.is_none()
            || self.spawn_fingerprint.lock().await.as_deref() != Some(fingerprint.as_str());
        let mut restarted = false;
        if needs_spawn {
            if let Some(old) = self.runtime.lock().await.take() {
                // 配置变更重建:旧进程优雅关停失败也继续(G-1 退出码本就不可信)
                let _ = old.shutdown().await;
            }
            let paths = HarnessPaths::resolve_for_app(app)?;
            // 支线 B:无 STARHUB_DSH_CONFIG 覆盖时,spawn 前生成包装配置
            // (主组合 + 用户插件两条 cordis:include entry),让用户插件经
            // plugins/cordis.yml 子树挂进 runtime;include 是 tree carrier,
            // path 不支持 !!js,故路径由 Rust 侧直接写入生成文件。
            let config_path = if std::env::var("STARHUB_DSH_CONFIG").is_ok() {
                paths.config_path.clone()
            } else {
                plugins::prepare_runtime_config(app, &paths.runtime_dir)
                    .map_err(|e| HarnessError::PathResolve(e.to_string()))?
            };
            let app_handle = app.clone();
            let bridge = self.bridge.clone();
            let on_notification: NotificationSink = Arc::new(move |method, params| {
                emit_notification(&app_handle, &bridge, &method, params);
            });
            // 桥事件发射器指向 webview(approval 确认卡 / 域工具执行面板)
            let emit_app = app.clone();
            self.bridge
                .set_emit(Arc::new(move |event, payload| {
                    use tauri::Emitter;
                    if let Err(error) = emit_app.emit(event, payload) {
                        tracing::warn!("dsh 事件 {event} 发送失败: {error}");
                    }
                }))
                .await;
            let runtime = HarnessRuntime::spawn(
                paths.runtime_dir,
                paths.node_path,
                config_path,
                env,
                on_notification,
                self.bridge.clone(),
            )?;
            // 联动:桥上挂 runtime 弱引用(出站 notify)与 AppHandle(open.asset / live.snapshot)
            self.bridge.set_runtime(&runtime);
            self.bridge.set_app(app.clone());
            *self.runtime.lock().await = Some(runtime);
            *self.spawn_fingerprint.lock().await = Some(fingerprint);
            restarted = true;
        }
        let runtime = self
            .runtime
            .lock()
            .await
            .clone()
            .ok_or(HarnessError::NotInitialized)?;
        let cwd = cwd.unwrap_or_else(|| ".".to_string());
        let mut params = serde_json::json!({
            "cwd": cwd,
            "provider": "deepseek-official",
            "model": config.model.as_deref().filter(|v| !v.is_empty()).unwrap_or("deepseek-v4-flash"),
        });
        if let Some(max_tokens) = config.max_tokens {
            params["maxTokens"] = serde_json::json!(max_tokens);
        }
        let server_info = runtime.call("initialize", Some(params)).await?;
        Ok(serde_json::json!({ "serverInfo": server_info, "restarted": restarted }))
    }

    /// 发送 session/prompt,返回 messageId;流式输出走通知事件。
    pub async fn prompt(
        &self,
        session_id: String,
        text: String,
    ) -> Result<serde_json::Value, HarnessError> {
        let runtime = self
            .runtime
            .lock()
            .await
            .clone()
            .ok_or(HarnessError::NotInitialized)?;
        runtime
            .call(
                "session/prompt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "contentBlocks": [{ "type": "text", "text": text }],
                })),
            )
            .await
    }

    /// 中断所有进行中的回合:直接杀进程并清空单例与指纹,
    /// 下一轮 initialize 重启 runtime(D1:SDK 无 cancel,杀进程兜底)。
    pub async fn cancel(&self) {
        let runtime = self.runtime.lock().await.take();
        *self.spawn_fingerprint.lock().await = None;
        // 未决桥请求一并清空:审批按拒绝、工具执行按失败,避免前端应答悬空
        self.bridge.drain().await;
        if let Some(runtime) = runtime {
            runtime.abort().await;
        }
    }

    /// 发送 shutdown 并清理单例;未初始化时幂等成功。
    pub async fn shutdown(&self) -> Result<(), HarnessError> {
        let runtime = self.runtime.lock().await.take();
        *self.spawn_fingerprint.lock().await = None;
        self.bridge.drain().await;
        match runtime {
            Some(runtime) => runtime.shutdown().await,
            None => Ok(()),
        }
    }

    /// Rust → dsh notification(command 层入口,契约 §2.1);
    /// 无活跃 runtime 或写入失败时静默跳过(记日志),不报错。
    pub async fn notify(&self, method: &str, params: serde_json::Value) {
        let runtime = self.runtime.lock().await.clone();
        if let Some(runtime) = runtime {
            if let Err(error) = runtime.notify(method, params).await {
                tracing::warn!("dsh 通知 {method} 发送失败: {error}");
            }
        }
    }
}

/// 通知事件转发到前端:`session.event` → `dsh://session-event`,
/// `session.status` → `dsh://session-status`,subagent 生命周期 → `dsh://subagent`
/// (顺带记录 childSessionId → parentSessionId 映射,tools.rs 资产绑定沿父链继承),
/// 其余仅记日志。
fn emit_notification(
    app: &tauri::AppHandle,
    bridge: &Arc<HostBridgeState>,
    method: &str,
    params: serde_json::Value,
) {
    use tauri::Emitter;
    let event = match method {
        "session.event" => "dsh://session-event",
        "session.status" => "dsh://session-status",
        "subagent.started" | "subagent.finished" => {
            // 记录子→父映射:子代理会话继承父会话的资产绑定(dsh_bind_session)
            if let (Some(child), Some(parent)) = (
                params
                    .get("childSessionId")
                    .and_then(serde_json::Value::as_str),
                params
                    .get("parentSessionId")
                    .and_then(serde_json::Value::as_str),
            ) {
                bridge.record_subagent_parent(child, parent);
            }
            // 注入 kind 区分 started/finished,前端按 parentSessionId 路由
            let payload = match params {
                serde_json::Value::Object(mut map) => {
                    map.insert(
                        "kind".into(),
                        serde_json::Value::String(
                            if method == "subagent.started" {
                                "started"
                            } else {
                                "finished"
                            }
                            .into(),
                        ),
                    );
                    serde_json::Value::Object(map)
                }
                other => other,
            };
            if let Err(error) = app.emit("dsh://subagent", payload) {
                tracing::warn!("dsh 事件 dsh://subagent 发送失败: {error}");
            }
            return;
        }
        other => {
            tracing::debug!("dsh 通知(未转发): {other}");
            return;
        }
    };
    if let Err(error) = app.emit(event, params) {
        tracing::warn!("dsh 事件 {event} 发送失败: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    /// 测试环境定位:优先 env,否则相对 CARGO_MANIFEST_DIR(src-tauri/)。
    /// Node 解析与生产路径一致:STARHUB_DSH_NODE > 便携 tmp/node24 > PATH 上的 node。
    fn test_paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime_dir = std::env::var("STARHUB_DSH_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| manifest.join("../vendor/deepseek-harness"));
        let node_path = std::env::var("STARHUB_DSH_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let portable = manifest.join("../tmp/node24").join(NODE_EXE_NAME);
                if portable.exists() {
                    portable
                } else {
                    PathBuf::from("node")
                }
            });
        let config_path = runtime_dir.join(RUNTIME_CONFIG_REL);
        // bare "node" 走 PATH 解析,exists() 不适用,只校验 runtime 构建产物
        let node_ok = node_path == PathBuf::from("node") || node_path.exists();
        if node_ok && runtime_dir.join(RUNTIME_BIN_REL).exists() {
            Some((node_path, runtime_dir, config_path))
        } else {
            None
        }
    }

    /// 启动 mock LLM(vendor 的 pnpm run mock:llm 等价物),解析 ready 行的 baseURL。
    /// `mock_args` 为行为脚本与行为参数(如 --sequence/--tool-name);
    /// 每个 behavior 对应一次 LLM 请求,success 是快速流(8 chunks)。
    async fn start_mock_llm_with(
        node: &PathBuf,
        runtime_dir: &PathBuf,
        mock_args: &[&str],
    ) -> Option<(Child, String)> {
        let mut child = Command::new(node)
            .args([
                "--import",
                "tsx",
                "packages/test-support/llm-mock-server/src/bin.ts",
            ])
            .args(mock_args)
            // 随机端口,避免与并发的其他测试/残留实例冲突(默认 8000 易撞)
            .args(["--port", "0"])
            .current_dir(runtime_dir)
            .stdout(Stdio::piped())
            // stderr 继承,启动失败时能在测试输出里看到原因
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
            .await
            .ok()?
            .ok()??;
        let value: serde_json::Value = serde_json::from_str(&ready).ok()?;
        if value.get("type")?.as_str()? != "ready" {
            return None;
        }
        let base_url = value.get("baseURL")?.as_str()?.to_string();
        // ready 之后继续排空 stdout(mock 的 onEvent 日志),避免测试结束 kill 时
        // mock 往已关闭的 stdout 写日志触发 EPIPE 噪音
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Some((child, base_url))
    }

    /// 默认行为脚本:全 success,多给几个以容纳 initialize 探测与多轮 prompt。
    async fn start_mock_llm(node: &PathBuf, runtime_dir: &PathBuf) -> Option<(Child, String)> {
        start_mock_llm_with(
            node,
            runtime_dir,
            &[
                "--sequence",
                "success,success,success,success,success,success",
                "--repeat-last",
            ],
        )
        .await
    }

    /// P0-4 端到端:initialize → prompt("say hi")→ 收齐 text-delta → idle → shutdown。
    /// 依赖 vendor 构建产物与便携 Node,缺失时跳过(返回 Ok)。
    #[tokio::test]
    async fn dsh_stdio_roundtrip_with_mock_llm() {
        let Some((node_path, runtime_dir, config_path)) = test_paths() else {
            eprintln!("skip: dsh runtime 或便携 Node 不存在");
            return;
        };
        // runtime 已就位时 mock 必须起得来,失败即测试失败(不允许静默跳过)
        let (_mock, base_url) = start_mock_llm(&node_path, &runtime_dir)
            .await
            .expect("mock LLM 启动失败");
        eprintln!("mock LLM ready: {base_url}");

        let temp_root =
            std::env::temp_dir().join(format!("starhub-dsh-test-{}", std::process::id()));
        std::fs::create_dir_all(&temp_root).unwrap();
        let session_root = temp_root.join("sessions");
        let workdir = temp_root.join("work");
        std::fs::create_dir_all(&session_root).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();

        let (notify_tx, mut notify_rx) = mpsc::channel::<(String, serde_json::Value)>(500);
        let sink: NotificationSink = Arc::new(move |method, params| {
            let _ = notify_tx.try_send((method, params));
        });
        let runtime = HarnessRuntime::spawn(
            runtime_dir,
            node_path,
            config_path,
            vec![
                ("DEEPSEEK_BASE_URL".into(), base_url),
                ("DEEPSEEK_API_KEY".into(), "mock-key".into()),
                (
                    "DSH_SESSION_ROOT".into(),
                    session_root.to_string_lossy().into_owned(),
                ),
                ("DSH_CWD".into(), workdir.to_string_lossy().into_owned()),
            ],
            sink,
            Arc::new(HostBridgeState::default()),
        )
        .expect("spawn dsh runtime");

        let server_info = runtime
            .call(
                "initialize",
                Some(serde_json::json!({
                    "cwd": workdir.to_string_lossy(),
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                })),
            )
            .await
            .expect("initialize");
        assert!(
            server_info.get("serverInfo").is_some(),
            "initialize: {server_info}"
        );
        eprintln!("initialize ok: {server_info}");

        // G-3:每轮用全新 sessionId
        let session_id = format!("rust-p0-4-{}", uuid::Uuid::new_v4());
        let prompt_result = runtime
            .call(
                "session/prompt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "contentBlocks": [{ "type": "text", "text": "say hi" }],
                })),
            )
            .await
            .expect("session/prompt");
        assert!(
            prompt_result.get("messageId").is_some(),
            "prompt: {prompt_result}"
        );

        // 收通知:拼 text-delta,直到 session.status idle(一轮结束的权威信号)
        let mut text = String::new();
        let idle = tokio::time::timeout(Duration::from_secs(60), async {
            while let Some((method, params)) = notify_rx.recv().await {
                match method.as_str() {
                    "session.event" => {
                        let event = &params["event"];
                        if event["type"] == "assistant/chunk"
                            && event["data"]["chunk"]["type"] == "text-delta"
                        {
                            if let Some(delta) = event["data"]["chunk"]["text"].as_str() {
                                text.push_str(delta);
                            }
                        }
                    }
                    "session.status" => {
                        if params["sessionId"] == session_id && params["status"] == "idle" {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        })
        .await;
        assert!(idle.is_ok(), "等待 idle 超时,已收文本: {text:?}");
        assert!(!text.is_empty(), "text-delta 为空");
        eprintln!("streamed text: {text:?}");

        // G-1:以收到 shutdown 响应为完成信号,忽略退出码
        runtime.shutdown().await.expect("shutdown");
        eprintln!("shutdown ok");
    }

    /// P1-4 端到端:mock LLM 第一轮返回 starhub_list_capabilities 工具调用,
    /// dsh starhub-tools 插件经 SDK 双向 request 桥回本进程执行(静态能力清单,
    /// 不依赖数据库),第二轮 success 流式收尾。断言事件流里出现该工具的
    /// tool 事件且最终收到文本。
    #[tokio::test]
    async fn dsh_tool_call_bridges_to_host() {
        let Some((node_path, runtime_dir, config_path)) = test_paths() else {
            eprintln!("skip: dsh runtime 或便携 Node 不存在");
            return;
        };
        let (_mock, base_url) = start_mock_llm_with(
            &node_path,
            &runtime_dir,
            &[
                "--sequence",
                "tool_call_success,success,success,success",
                "--repeat-last",
                "--tool-name",
                "starhub_list_capabilities",
                "--tool-arguments",
                "{}",
            ],
        )
        .await
        .expect("mock LLM 启动失败");
        eprintln!("mock LLM ready: {base_url}");

        let temp_root =
            std::env::temp_dir().join(format!("starhub-dsh-tool-test-{}", std::process::id()));
        let session_root = temp_root.join("sessions");
        let workdir = temp_root.join("work");
        std::fs::create_dir_all(&session_root).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();

        let (notify_tx, mut notify_rx) = mpsc::channel::<(String, serde_json::Value)>(500);
        let sink: NotificationSink = Arc::new(move |method, params| {
            let _ = notify_tx.try_send((method, params));
        });
        let runtime = HarnessRuntime::spawn(
            runtime_dir,
            node_path,
            config_path,
            vec![
                ("DEEPSEEK_BASE_URL".into(), base_url),
                ("DEEPSEEK_API_KEY".into(), "mock-key".into()),
                (
                    "DSH_SESSION_ROOT".into(),
                    session_root.to_string_lossy().into_owned(),
                ),
                ("DSH_CWD".into(), workdir.to_string_lossy().into_owned()),
            ],
            sink,
            Arc::new(HostBridgeState::default()),
        )
        .expect("spawn dsh runtime");

        runtime
            .call(
                "initialize",
                Some(serde_json::json!({
                    "cwd": workdir.to_string_lossy(),
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                })),
            )
            .await
            .expect("initialize");

        let session_id = format!("rust-p1-4-{}", uuid::Uuid::new_v4());
        runtime
            .call(
                "session/prompt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "contentBlocks": [{ "type": "text", "text": "list capabilities" }],
                })),
            )
            .await
            .expect("session/prompt");

        let mut text = String::new();
        let mut tool_event_seen = false;
        let mut tool_result_seen = false;
        let idle = tokio::time::timeout(Duration::from_secs(60), async {
            while let Some((method, params)) = notify_rx.recv().await {
                match method.as_str() {
                    "session.event" => {
                        let event = &params["event"];
                        if event["type"] == "assistant/chunk"
                            && event["data"]["chunk"]["type"] == "text-delta"
                        {
                            if let Some(delta) = event["data"]["chunk"]["text"].as_str() {
                                text.push_str(delta);
                            }
                        }
                        // tool/call 事件应出现工具名;tool/result 事件不带名(只有 callId),
                        // 直接校验其内容含宿主返回的能力清单特征词且非错误,
                        // 以此证明桥执行成功而非仅有 tool/call
                        let raw = event.to_string();
                        if raw.contains("starhub_list_capabilities") {
                            tool_event_seen = true;
                        }
                        if event["type"] == "tool/result"
                            && raw.contains("Kafka")
                            && raw.contains("\"isError\":false")
                        {
                            tool_result_seen = true;
                        }
                    }
                    "session.status"
                        if params["sessionId"] == session_id && params["status"] == "idle" =>
                    {
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await;
        assert!(idle.is_ok(), "等待 idle 超时,已收文本: {text:?}");
        assert!(
            tool_event_seen,
            "事件流中应出现 starhub_list_capabilities 的工具事件"
        );
        assert!(
            tool_result_seen,
            "工具结果事件应包含宿主返回的能力清单内容(证明桥执行成功)"
        );
        assert!(!text.is_empty(), "工具调用后的第二轮应有文本输出");
        eprintln!("tool bridge ok, streamed text: {text:?}");

        runtime.shutdown().await.expect("shutdown");
    }

    /// 支线 B 端到端:用 plugins::render_wrapper_yml 生成的包装配置启动
    /// runtime(主组合 + 空用户插件清单两条 cordis:include entry),
    /// initialize 成功即证明 include 链路与 assertEntriesActivated 全过。
    #[tokio::test]
    async fn dsh_boots_with_generated_wrapper_config() {
        let Some((node_path, runtime_dir, _config_path)) = test_paths() else {
            eprintln!("skip: dsh runtime 或便携 Node 不存在");
            return;
        };
        let (_mock, base_url) = start_mock_llm(&node_path, &runtime_dir)
            .await
            .expect("mock LLM 启动失败");

        let temp_root =
            std::env::temp_dir().join(format!("starhub-dsh-wrapper-test-{}", std::process::id()));
        let plugins_dir = temp_root.join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();
        let entries_file = plugins_dir.join("cordis.yml");
        std::fs::write(&entries_file, "[]\n").unwrap();
        let wrapper = temp_root.join("dsh-cordis.generated.yml");
        std::fs::write(
            &wrapper,
            plugins::render_wrapper_yml(&runtime_dir.join(RUNTIME_CONFIG_REL), &entries_file),
        )
        .unwrap();
        let session_root = temp_root.join("sessions");
        std::fs::create_dir_all(&session_root).unwrap();

        let sink: NotificationSink = Arc::new(|_method, _params| {});
        let runtime = HarnessRuntime::spawn(
            runtime_dir,
            node_path,
            wrapper,
            vec![
                ("DEEPSEEK_BASE_URL".into(), base_url),
                ("DEEPSEEK_API_KEY".into(), "mock-key".into()),
                (
                    "DSH_SESSION_ROOT".into(),
                    session_root.to_string_lossy().into_owned(),
                ),
            ],
            sink,
            Arc::new(HostBridgeState::default()),
        )
        .expect("spawn dsh runtime(包装配置)");

        let server_info = runtime
            .call(
                "initialize",
                Some(serde_json::json!({
                    "cwd": temp_root.to_string_lossy(),
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                })),
            )
            .await
            .expect("initialize(包装配置 + 空用户插件清单)");
        assert!(
            server_info.get("serverInfo").is_some(),
            "initialize: {server_info}"
        );
        eprintln!("wrapper config boot ok: {server_info}");
        runtime.shutdown().await.expect("shutdown");
    }

    // ---------- 审批桥(starhub/approval.request) ----------

    /// 审批桥端到端:模拟 dsh 侧 server→client request → emit `dsh://approval`
    /// 事件 → 前端经 resolve_approval 应答 → 桥返回 allowed-once / rejected。
    #[tokio::test]
    async fn approval_bridge_emits_event_and_resolves_outcome() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));

        // 允许路径:带 callId / reason
        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                handle_approval_request(
                    serde_json::json!({
                        "sessionId": "sess-1",
                        "toolName": "db_query",
                        "callId": "call-1",
                        "reason": "写 SQL,需要确认",
                    }),
                    bridge,
                )
                .await
            }
        });
        let (event, payload) = emit_rx.recv().await.expect("应收到 dsh://approval 事件");
        assert_eq!(event, "dsh://approval");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        assert_eq!(payload["sessionId"], "sess-1");
        assert_eq!(payload["toolName"], "db_query");
        assert_eq!(payload["callId"], "call-1");
        assert_eq!(payload["reason"], "写 SQL,需要确认");
        // 应答前应处于 pending
        assert!(bridge.approvals.lock().await.contains_key(&request_id));

        bridge.resolve_approval(&request_id, true).await;
        let result = handle
            .await
            .expect("审批处理完成")
            .expect("应答后应返回结果");
        assert_eq!(result, serde_json::json!({ "outcome": "allowed-once" }));
        assert!(!bridge.approvals.lock().await.contains_key(&request_id));

        // 拒绝路径:无 callId/reason(事件 payload 应省略这两键)
        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                handle_approval_request(
                    serde_json::json!({ "sessionId": "sess-1", "toolName": "ssh_exec" }),
                    bridge,
                )
                .await
            }
        });
        let (_event, payload) = emit_rx.recv().await.expect("第二个审批事件");
        assert!(
            payload.get("callId").is_none(),
            "缺 callId 不应出现在 payload"
        );
        assert!(
            payload.get("reason").is_none(),
            "缺 reason 不应出现在 payload"
        );
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        bridge.resolve_approval(&request_id, false).await;
        let result = handle
            .await
            .expect("审批处理完成")
            .expect("应答后应返回结果");
        assert_eq!(result, serde_json::json!({ "outcome": "rejected" }));
    }

    /// 审批超时:300s 生产常量不可等,走带超时的内部实现验证超时按拒绝处理。
    #[tokio::test]
    async fn approval_timeout_rejects() {
        let bridge = Arc::new(HostBridgeState::default());
        let result = handle_approval_request_with_timeout(
            serde_json::json!({ "sessionId": "sess-1", "toolName": "db_query" }),
            bridge.clone(),
            Duration::from_millis(50),
        )
        .await
        .expect("超时应返回结果而非错误");
        assert_eq!(result, serde_json::json!({ "outcome": "rejected" }));
        assert!(
            bridge.approvals.lock().await.is_empty(),
            "超时后 pending 应被清理"
        );
    }

    /// 审批请求缺参:桥应报硬错误(插件侧 catch 后 fail closed)。
    #[tokio::test]
    async fn approval_request_requires_params() {
        let bridge = Arc::new(HostBridgeState::default());
        let err = handle_approval_request(serde_json::json!({}), bridge)
            .await
            .expect_err("缺 sessionId 应报错");
        assert!(err.contains("sessionId"), "{err}");
    }

    /// 未知 requestId 的应答:幂等成功(已超时/重复应答不报错)。
    #[tokio::test]
    async fn approval_reply_unknown_request_id_is_noop() {
        let bridge = HostBridgeState::default();
        assert!(!bridge.resolve_approval("missing", true).await);
    }

    /// cancel/shutdown 路径:未决审批 drain 后按拒绝处理,等待方立即返回。
    #[tokio::test]
    async fn drain_rejects_pending_approval() {
        let (emit_tx, mut emit_rx) = mpsc::channel::<(String, serde_json::Value)>(10);
        let bridge = Arc::new(HostBridgeState::new(Arc::new(move |event, payload| {
            let _ = emit_tx.try_send((event.to_string(), payload));
        })));
        let handle = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                handle_approval_request(
                    serde_json::json!({ "sessionId": "sess-1", "toolName": "db_query" }),
                    bridge,
                )
                .await
            }
        });
        let (_event, payload) = emit_rx.recv().await.expect("审批事件");
        let request_id = payload["requestId"].as_str().expect("requestId");
        assert!(bridge.approvals.lock().await.contains_key(request_id));
        bridge.drain().await;
        let result = handle
            .await
            .expect("审批处理完成")
            .expect("drain 后应返回 rejected 结果");
        assert_eq!(result, serde_json::json!({ "outcome": "rejected" }));
        assert!(!bridge.approvals.lock().await.contains_key(request_id));
    }

    // ---------- 会话绑定与 subagent 父链 ----------

    /// 资产绑定解析:直绑 + 沿 subagent 父链向上继承,未绑定返回 None。
    #[test]
    fn subagent_parent_chain_resolves_binding() {
        let bridge = HostBridgeState::default();
        assert_eq!(bridge.resolve_asset("unknown"), None, "未绑定返回 None");

        bridge.bind_session("root", "db", "a1");
        bridge.record_subagent_parent("child-1", "root");
        bridge.record_subagent_parent("child-2", "child-1");
        assert_eq!(
            bridge.resolve_asset("root"),
            Some(("db".into(), "a1".into()))
        );
        assert_eq!(
            bridge.resolve_asset("child-1"),
            Some(("db".into(), "a1".into()))
        );
        assert_eq!(
            bridge.resolve_asset("child-2"),
            Some(("db".into(), "a1".into()))
        );

        // 子会话可覆盖父会话绑定
        bridge.bind_session("child-1", "ssh", "a2");
        assert_eq!(
            bridge.resolve_asset("child-2"),
            Some(("ssh".into(), "a2".into()))
        );

        // 空 asset_id 解除绑定
        bridge.bind_session("root", "db", "");
        assert_eq!(bridge.resolve_asset("root"), None);
        assert_eq!(
            bridge.resolve_asset("child-1"),
            Some(("ssh".into(), "a2".into()))
        );
    }

    /// 严格解析(注入路径):只命中当前会话自身的绑定,**不**沿 subagent 父链继承。
    /// 全新会话(无 @)即使父会话绑定了资产,也不会解析出 asset 卡。
    #[test]
    fn resolve_asset_strict_does_not_inherit_parent_binding() {
        let bridge = HostBridgeState::default();
        bridge.bind_session("root", "db", "a1");
        bridge.record_subagent_parent("child-1", "root");

        // 自身已绑定:精确命中。
        assert_eq!(
            bridge.resolve_asset_strict("root"),
            Some(("db".into(), "a1".into()))
        );
        // 子会话未绑定:即使父会话(root)有绑定,严格解析也应返回 None。
        assert_eq!(bridge.resolve_asset_strict("child-1"), None);
        // 未绑定会话:None。
        assert_eq!(bridge.resolve_asset_strict("unknown"), None);
    }

    // ---------- 联动:live.snapshot / open.asset / focus.tool(契约 §2.2) ----------

    /// live.snapshot 在无 AppHandle(测试环境)时:sessions/transfers 为空数组,
    /// recentExecs 返回桥上缓存的每资产最近一次 AI 执行。
    #[tokio::test]
    async fn live_snapshot_without_app_returns_empty_views_and_recent_execs() {
        let bridge = Arc::new(HostBridgeState::default());
        bridge.record_recent_exec(events::RecentExec {
            asset_id: "a1".into(),
            tool_name: "ssh_exec".into(),
            summary: "ssh_exec: ls -la".into(),
            tail: "file1\nfile2".into(),
            ts: 1724000000,
        });
        let snapshot = handle_live_snapshot(bridge).await.expect("live.snapshot");
        assert_eq!(snapshot["sessions"], serde_json::json!([]));
        assert_eq!(snapshot["transfers"], serde_json::json!([]));
        let recents = snapshot["recentExecs"].as_array().expect("数组");
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0]["assetId"], "a1");
        assert_eq!(recents[0]["toolName"], "ssh_exec");
        assert_eq!(recents[0]["tail"], "file1\nfile2");
    }

    /// memory.cards 缺 scopes:硬错误(参数校验在读取数据库之前)。
    #[tokio::test]
    async fn memory_cards_requires_scopes() {
        let bridge = Arc::new(HostBridgeState::default());
        let err = handle_memory_cards(serde_json::json!({}), bridge)
            .await
            .expect_err("缺 scopes 应报错");
        assert!(err.to_string().contains("scopes"), "{err}");
    }

    /// memory.cards 在数据库未初始化(测试环境)时:Failed 而非 panic,
    /// 调用方(dsh memory-context 插件)据此降级为不注入。
    #[tokio::test]
    async fn memory_cards_without_db_fails_soft() {
        let bridge = Arc::new(HostBridgeState::default());
        let err = handle_memory_cards(
            serde_json::json!({ "scopes": ["user", "global"] }),
            bridge,
        )
        .await
        .expect_err("未初始化数据库应报 Failed");
        assert!(!err.to_string().is_empty());
    }

    /// open.asset 缺 assetId:硬错误(契约 §2.2 参数校验)。
    #[tokio::test]
    async fn open_asset_requires_asset_id() {
        let bridge = Arc::new(HostBridgeState::default());
        let err = handle_open_asset(serde_json::json!({}), bridge, false)
            .await
            .expect_err("缺 assetId 应报错");
        assert!(err.to_string().contains("assetId"), "{err}");
    }

    /// focus.tool 缺 tool:硬错误(契约 §2.2 tool 必填)。
    #[tokio::test]
    async fn focus_tool_requires_tool() {
        let bridge = Arc::new(HostBridgeState::default());
        let err = handle_open_asset(
            serde_json::json!({ "assetId": "a1" }),
            bridge,
            true,
        )
        .await
        .expect_err("focus.tool 缺 tool 应报错");
        assert!(err.to_string().contains("tool"), "{err}");
    }


    /// 未注册的入站方法:JSON-RPC method-not-found(-32601,由 dispatch_frame 映射)。
    #[tokio::test]
    async fn inbound_unknown_method_is_method_not_found() {
        let bridge = Arc::new(HostBridgeState::default());
        match handle_inbound_request("starhub/no.such", serde_json::json!({}), bridge).await {
            Err(InboundError::MethodNotFound(message)) => {
                assert!(message.contains("no.such"), "{message}");
            }
            other => panic!("预期 MethodNotFound,实际 {other:?}"),
        }
    }

    /// notify_dsh 在无活跃 runtime(runtime 未初始化/已回收)时静默跳过,不报错。
    #[tokio::test]
    async fn notify_dsh_silently_skips_without_runtime() {
        let bridge = Arc::new(HostBridgeState::default());
        bridge
            .notify_dsh(REGISTRY_SYNC_METHOD, serde_json::json!({ "sessions": [] }))
            .await;
    }

    /// notify_dsh 在有 web 出站 sink 时投给 web;清理闭包执行后不再投递。
    #[tokio::test]
    async fn notify_dsh_delivers_to_web_sink_and_cleanup_stops_it() {
        let bridge = Arc::new(HostBridgeState::default());
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received_closure = received.clone();
        let sink: WebNotifySink = Arc::new(move |method, params| {
            received_closure
                .lock()
                .unwrap()
                .push((method, params.to_string()));
        });
        let clear = bridge.set_web_notify(bridge.clone(), sink);
        bridge
            .notify_dsh(DOMAIN_EVENT_METHOD, serde_json::json!({ "kind": "ssh.exec_completed" }))
            .await;
        assert_eq!(received.lock().unwrap().len(), 1);
        assert_eq!(received.lock().unwrap()[0].0, DOMAIN_EVENT_METHOD);
        clear();
        bridge
            .notify_dsh(DOMAIN_EVENT_METHOD, serde_json::json!({ "kind": "db.query_executed" }))
            .await;
        assert_eq!(received.lock().unwrap().len(), 1, "清理后不应再投递");
    }
}
