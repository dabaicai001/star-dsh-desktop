//! 桥方法面:去 Tauri 化 M1 里从 `src-tauri/src/harness` 平移过来的「非工具」
//! JSON-RPC 方法(契约 §2.2)与工具成功后的 AI 起源领域事件回写(契约 §1/M4)。
//!
//! 与工具方法(方法名 = 工具名,结果 `{ text }`)不同,这些方法的对端是
//! `starhub-bridge` 插件而不是模型:
//!
//! | 方法 | 用途 |
//! |---|---|
//! | `starhub/open.asset` / `starhub/focus.tool` | 联动 UI 动作:预判 open/focus,经通知出口把意图发给 bridge(工作台面板) |
//! | `starhub/live.snapshot` | `starhub-live-context` 的活性快照(注册表 + 传输 + recentExecs + 任务轨迹) |
//! | `starhub/domain.event`(通知) | 域工具成功后的 AI 起源事件 |
//! | `starhub/registry.sync`(通知) | 注册表变更(剔除断线条目)全量快照 |
//!
//! `starhub/tool.execute` 兼容层本身在 bridge 插件里(TS),到这里已还原成
//! 「方法名 = 工具名」的直调。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use starhub_contract::events::{self, RecentExec};
use starhub_domain_ssh::events::EventSink;
use starhub_domain_ssh::sftp::transfer::TransferManager;

use crate::jsonrpc::RpcError;
use crate::runtime::SshRuntime;

/// 生成 AI 起源领域事件的工具方法前缀(契约 §1/M4:域工具才有 AI 动作语义;
/// 全局工具 list_capabilities / list_assets 与 UI/桥方法不产生事件)。
const TOOL_METHOD_PREFIXES: &[&str] = &[
    "ssh_", "sftp_", "db_", "redis_", "es_", "docker_", "desktop_", "android_", "browser_",
];

/// 是否域工具方法(决定成功后是否回写 AI 起源领域事件)。
pub fn is_tool_method(name: &str) -> bool {
    TOOL_METHOD_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// M6 任务轨迹的每会话资产上限(与 `src-tauri` 的 `record_task_asset` 一致)。
const MAX_TASK_TRAIL_ASSETS: usize = 20;

/// 桥状态:recentExecs 缓存 + M6 任务轨迹(都只服务 `starhub/live.snapshot`)。
#[derive(Default)]
pub struct BridgeState {
    /// 每资产最近一次 AI 工具执行(覆盖式,与 Tauri 桥同语义)。
    recent_execs: Mutex<HashMap<String, RecentExec>>,
    /// 会话 → 访问过的资产 id(去重保序,最多 20 个)。
    task_trails: Mutex<HashMap<String, Vec<String>>>,
}

impl BridgeState {
    /// 记录一个资产最近一次 AI 工具执行(每资产只留 1 条,覆盖式)。
    pub fn record_recent_exec(&self, exec: RecentExec) {
        self.recent_execs
            .lock()
            .unwrap()
            .insert(exec.asset_id.clone(), exec);
    }

    /// recentExecs 缓存快照(`starhub/live.snapshot` 用)。
    pub fn recent_execs(&self) -> Vec<RecentExec> {
        self.recent_execs
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect()
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
        if trail.len() > MAX_TASK_TRAIL_ASSETS {
            let excess = trail.len() - MAX_TASK_TRAIL_ASSETS;
            trail.drain(..excess);
        }
    }

    /// M6 任务轨迹快照(`starhub/live.snapshot` 用)。
    pub fn task_trails(&self) -> Vec<Value> {
        self.task_trails
            .lock()
            .unwrap()
            .iter()
            .map(|(session_id, asset_ids)| {
                json!({
                    "sessionId": session_id,
                    "assetIds": asset_ids,
                })
            })
            .collect()
    }
}

/// 解析本次调用的资产 id:显式 `assetId` 优先,否则沿会话绑定(含 subagent 父链)。
fn bound_asset_id(ssh: &SshRuntime, args: &Value) -> Option<String> {
    if let Some(asset_id) = args
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(asset_id.to_string());
    }
    args.get("sessionId")
        .and_then(Value::as_str)
        .and_then(|session_id| ssh.resolve_bound_asset(session_id))
        .map(|(_asset_type, asset_id)| asset_id)
}

/// 域工具成功后的 AI 动作回写(契约 §1/M4):
/// 1. 按工具名映射 kind,summary 单行 ≤200 字符且只取白名单参数;
/// 2. 经通知出口发 `starhub/domain.event`(bridge 转给 dsh 的 domain-events);
/// 3. 写 recentExecs 缓存(每资产最近一次,输出尾部 ≤2KB;无资产绑定时跳过)。
///
/// 失败路径不产生事件(用户拒绝/超时不代表 AI 动作完成)。
pub fn after_tool_success(
    ssh: &SshRuntime,
    sink: &Arc<dyn EventSink>,
    state: &BridgeState,
    name: &str,
    args: &Value,
    output: &str,
) {
    let asset_id = bound_asset_id(ssh, args);
    let event = events::ai_tool_event(name, args, asset_id.clone());
    let payload = serde_json::to_value(&event).unwrap_or_else(
        |_| json!({ "kind": events::kind_for_tool(name), "ts": events::unix_now() }),
    );
    sink.emit(DOMAIN_EVENT_METHOD, payload);
    if let Some(asset_id) = asset_id {
        state.record_recent_exec(RecentExec {
            asset_id,
            tool_name: name.to_string(),
            summary: event.summary.clone(),
            tail: events::tail_of(output),
            ts: event.ts,
        });
    }
}

/// AI 起源领域事件的通知方法名(契约 §1;dsh 侧 `starhub-domain-events` 订阅)。
pub const DOMAIN_EVENT_METHOD: &str = "starhub/domain.event";

/// 注册表全量快照的通知方法名(契约 §2.1;dsh 侧 `starhub-session-registry` 订阅)。
pub const REGISTRY_SYNC_METHOD: &str = "starhub/registry.sync";

/// 直播/UI 动作意图的通知方法名(新架构里由 bridge 转给工作台面板)。
pub const OPEN_ASSET_EVENT: &str = "starhub://open-asset";

/// `starhub/open.asset` 请求方法(契约 §2.2/M5;tool 缺省 "auto")。
pub const OPEN_ASSET_METHOD: &str = "starhub/open.asset";

/// `starhub/focus.tool` 请求方法(契约 §2.2/M5;tool 必填)。
pub const FOCUS_TOOL_METHOD: &str = "starhub/focus.tool";

/// `starhub/live.snapshot` 请求方法(契约 §2.2)。
pub const LIVE_SNAPSHOT_METHOD: &str = "starhub/live.snapshot";

/// `starhub/live.snapshot`(契约 §2.2):注册表快照 + 传输任务 + recentExecs +
/// 任务轨迹。快照时若剔除断线条目(注册表变更),顺带补发一次 registry.sync。
pub async fn live_snapshot(
    ssh: &SshRuntime,
    sink: &Arc<dyn EventSink>,
    state: &BridgeState,
    transfers: &TransferManager,
) -> Value {
    let live_ids = ssh.live_session_ids().await;
    let (sessions, pruned) = ssh.registry().snapshot(&live_ids);
    if pruned {
        // 剔除断线条目属于注册表变更:补发全量快照
        sink.emit(REGISTRY_SYNC_METHOD, json!({ "sessions": sessions }));
    }
    let mut transfer_items = Vec::new();
    for task in transfers.list_all_tasks().await {
        let mut item = json!({
            "id": task.id,
            "direction": task.direction,
            "bytes": task.transferred_bytes,
            "totalBytes": task.total_bytes,
            "state": task.status,
        });
        if let Some(asset_id) = ssh.registry().asset_for_session(&task.session_id) {
            item["assetId"] = Value::String(asset_id);
        }
        transfer_items.push(item);
    }
    json!({
        "sessions": sessions,
        "transfers": transfer_items,
        "recentExecs": state.recent_execs(),
        "taskTrails": state.task_trails(),
    })
}

/// `starhub/open.asset` / `starhub/focus.tool`(契约 §2.2/M5):
/// 由开窗注册表预判 action(已有该资产页面 = focus,否则 open),经通知出口把
/// 意图发给 bridge(工作台面板真正开/聚焦);fire-and-forget,立即返回
/// `{ ok: true, action }`。
///
/// `require_tool` 区分 focus.tool(tool 必填)与 open.asset(tool 缺省 "auto")。
pub fn open_or_focus(
    ssh: &SshRuntime,
    sink: &Arc<dyn EventSink>,
    method: &str,
    params: &Value,
    require_tool: bool,
) -> Result<Value, RpcError> {
    let asset_id = params
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{method} 缺少 assetId")))?
        .to_string();
    let tool = params
        .get("tool")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let tool = match (require_tool, tool) {
        (true, None) => {
            return Err(RpcError::invalid_params(format!("{method} 缺少 tool")));
        }
        (_, Some(tool)) => tool.to_string(),
        (false, None) => "auto".to_string(),
    };
    let action = ssh.registry().open_or_focus(&asset_id, &tool);
    let action = if action == "open" {
        "opened"
    } else {
        "focused"
    };
    sink.emit(
        OPEN_ASSET_EVENT,
        json!({ "assetId": asset_id, "tool": tool, "action": action }),
    );
    Ok(json!({ "ok": true, "action": action }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use starhub_domain_ssh::events::{EventSink, MemoryKnownHostsStore};
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Collector {
        events: StdMutex<Vec<(String, Value)>>,
    }

    impl EventSink for Collector {
        fn emit(&self, event: &str, payload: Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
        }
    }

    fn runtime_with(sink: Arc<dyn EventSink>) -> SshRuntime {
        let dir = std::env::temp_dir().join(format!("starhub-bridge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = Arc::new(crate::assets::AssetStore::new(
            dir.join("assets.json"),
            Box::new(crate::assets::MemorySecretStore::new()),
        ));
        SshRuntime::new(
            assets,
            sink,
            Arc::new(MemoryKnownHostsStore::default()),
            Arc::new(crate::bindings::SessionBindings::new()),
        )
    }

    #[test]
    fn tool_methods_are_the_domain_prefixes() {
        assert!(is_tool_method("ssh_exec"));
        assert!(is_tool_method("sftp_upload"));
        assert!(is_tool_method("db_query"));
        assert!(is_tool_method("redis_exec"));
        assert!(is_tool_method("es_search"));
        assert!(is_tool_method("docker_logs"));
        assert!(is_tool_method("desktop_exec"));
        assert!(is_tool_method("android_tap"));
        assert!(is_tool_method("browser_open"));
        // 全局 / UI / 桥方法不产生 AI 起源事件
        assert!(!is_tool_method("ping"));
        assert!(!is_tool_method("starhub_list_capabilities"));
        assert!(!is_tool_method("starhub_list_assets"));
        assert!(!is_tool_method("bind_asset_context"));
        assert!(!is_tool_method("starhub/live.snapshot"));
        assert!(!is_tool_method("starhub/exec.abort"));
    }

    #[test]
    fn after_tool_success_emits_contract_event_and_recents() {
        let collector = Arc::new(Collector::default());
        let sink: Arc<dyn EventSink> = Arc::clone(&collector) as Arc<dyn EventSink>;
        let ssh = runtime_with(Arc::clone(&sink));
        let state = BridgeState::default();
        ssh.bind_session("s1", "ssh", "a1");
        let args = json!({ "sessionId": "s1", "command": "systemctl status nginx" });
        after_tool_success(&ssh, &sink, &state, "ssh_exec", &args, "active (running)");

        let events = collector.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        let (method, payload) = &events[0];
        assert_eq!(method, DOMAIN_EVENT_METHOD);
        assert_eq!(payload["kind"], "ssh.exec_completed");
        assert_eq!(payload["assetId"], "a1");
        assert_eq!(payload["origin"], "ai");
        assert_eq!(payload["summary"], "ssh_exec: systemctl status nginx");
        assert_eq!(payload["data"]["tool"], "ssh_exec");
        drop(events);

        let recents = state.recent_execs();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].asset_id, "a1");
        assert_eq!(recents[0].tool_name, "ssh_exec");
        assert_eq!(recents[0].tail, "active (running)");
    }

    #[test]
    fn after_tool_success_without_binding_skips_recents() {
        let collector = Arc::new(Collector::default());
        let sink: Arc<dyn EventSink> = Arc::clone(&collector) as Arc<dyn EventSink>;
        let ssh = runtime_with(Arc::clone(&sink));
        let state = BridgeState::default();
        after_tool_success(
            &ssh,
            &sink,
            &state,
            "db_query",
            &json!({ "sql": "SELECT 1" }),
            "1",
        );
        let events = collector.events.lock().unwrap();
        assert_eq!(events.len(), 1, "无绑定时事件照发(assetId 省略)");
        assert!(events[0].1.get("assetId").is_none());
        drop(events);
        assert!(
            state.recent_execs().is_empty(),
            "无资产上下文不写 recentExecs"
        );
    }

    #[test]
    fn open_or_focus_predicts_action_and_notifies() {
        let collector = Arc::new(Collector::default());
        let sink: Arc<dyn EventSink> = Arc::clone(&collector) as Arc<dyn EventSink>;
        let ssh = runtime_with(Arc::clone(&sink));
        let first = open_or_focus(
            &ssh,
            &sink,
            "starhub/open.asset",
            &json!({ "assetId": "a1", "tool": "terminal" }),
            false,
        )
        .expect("open.asset");
        assert_eq!(first["ok"], true);
        assert_eq!(first["action"], "opened");
        let second = open_or_focus(
            &ssh,
            &sink,
            "starhub/focus.tool",
            &json!({ "assetId": "a1", "tool": "terminal" }),
            true,
        )
        .expect("focus.tool");
        assert_eq!(second["action"], "focused");

        let events = collector.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, OPEN_ASSET_EVENT);
        assert_eq!(events[0].1["action"], "opened");
        assert_eq!(events[0].1["tool"], "terminal");
        assert_eq!(events[1].1["action"], "focused");
    }

    #[test]
    fn open_or_focus_validates_parameters() {
        let collector = Arc::new(Collector::default());
        let sink: Arc<dyn EventSink> = Arc::clone(&collector) as Arc<dyn EventSink>;
        let ssh = runtime_with(Arc::clone(&sink));
        let error = open_or_focus(&ssh, &sink, "starhub/open.asset", &json!({}), false)
            .expect_err("缺 assetId 应报错");
        assert!(error.message.contains("缺少 assetId"), "{}", error.message);
        let error = open_or_focus(
            &ssh,
            &sink,
            "starhub/focus.tool",
            &json!({ "assetId": "a1" }),
            true,
        )
        .expect_err("focus.tool 缺 tool 应报错");
        assert!(error.message.contains("缺少 tool"), "{}", error.message);
    }

    #[test]
    fn task_trails_are_deduped_and_bounded() {
        let state = BridgeState::default();
        for index in 0..(MAX_TASK_TRAIL_ASSETS + 5) {
            state.record_task_asset("s1", &format!("a{index}"));
        }
        state.record_task_asset("s1", "a0");
        let trails = state.task_trails();
        assert_eq!(trails.len(), 1);
        let asset_ids = trails[0]["assetIds"].as_array().expect("array");
        assert_eq!(asset_ids.len(), MAX_TASK_TRAIL_ASSETS);
        assert_eq!(asset_ids.last().expect("last"), "a0", "重复访问移到队尾");
        // 空参数不记
        state.record_task_asset("", "a1");
        state.record_task_asset("s2", "  ");
        assert_eq!(state.task_trails().len(), 1);
    }
}
