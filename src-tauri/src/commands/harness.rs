use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::harness::events::DomainEvent;
use crate::harness::{
    DshModelConfig, HarnessManager, ASK_AI_EVENT, DOMAIN_EVENT_EVENT, DOMAIN_EVENT_METHOD,
};

/// 初始化 dsh runtime(未运行或 env 指纹已变则先 spawn/重启),返回
/// `{ serverInfo, restarted }`;restarted=true 时前端必须用全新 sessionId(G-3)。
///
/// 模型配置来自 StarHub AI 设置(前端解析多模型列表 + Keyring 后传入):
/// api_key/base_url/system_prompt 经 env 注入 dsh 子进程,model 走 initialize 参数。
#[tauri::command]
pub async fn dsh_initialize(
    app: AppHandle,
    manager: State<'_, HarnessManager>,
    cwd: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    max_tokens: Option<u32>,
    system_prompt: Option<String>,
) -> Result<Value, String> {
    manager
        .initialize(
            &app,
            cwd,
            DshModelConfig {
                model,
                base_url,
                api_key,
                max_tokens,
                system_prompt,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

/// 发送一轮对话;流式输出通过 `dsh://session-event` / `dsh://session-status` 事件推送。
/// 注意 G-3:session_id 每个会话必须用全新 id,复用已持久化的 id 会 id collision。
#[tauri::command]
pub async fn dsh_prompt(
    manager: State<'_, HarnessManager>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    manager
        .prompt(session_id, text)
        .await
        .map_err(|e| e.to_string())
}

/// 中断所有进行中的回合:杀进程兜底(SDK 协议无 mid-turn cancel,方案 D1),
/// 下一轮 dsh_initialize 会重启 runtime。
#[tauri::command]
pub async fn dsh_cancel(manager: State<'_, HarnessManager>) -> Result<Value, String> {
    manager.cancel().await;
    Ok(Value::Null)
}

/// 关闭 dsh runtime;以收到 shutdown 响应为完成信号(G-1,忽略进程退出码)。
#[tauri::command]
pub async fn dsh_shutdown(manager: State<'_, HarnessManager>) -> Result<Value, String> {
    manager.shutdown().await.map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/// dsh web GUI 的实际 URL(主壳融合;端口被占时会递增,不能假设 3085)。
/// 未运行(含上次启动失败)时**先幂等拉起再返回**——shell-placeholder 跳板页
/// 据此轮询:新机首启冷启动慢、setup 里首次 ensure_started 就绪超时被杀后,
/// 跳板页下一次轮询会自动重启 web 自愈,不再卡死在「dsh web 未运行」需要
/// 手动重开应用(v0.95.5 修复)。ensure_started 幂等且被 start_lock 串行化,
/// 与 setup 后台任务的并发调用只会等到同一份结果。
#[tauri::command]
pub async fn dsh_web_url(
    app: AppHandle,
    manager: State<'_, crate::harness::web::DshWebManager>,
) -> Result<String, String> {
    let bridge = app.state::<HarnessManager>().bridge();
    manager
        .ensure_started(&app, bridge)
        .await
        .map_err(|e| e.to_string())
}

/// 返回 dsh 设置文件(settings.yaml)的绝对路径,供壳内「打开配置文件」在
/// 浏览器内读改(而不是调原生打开器)。路径解析复用 dsh_home_dir,与 web GUI
/// 的 DSH_SETTINGS_PATH 同源(见 build_spawn_env)。请求只携带返回一个只读
/// 路径,浏览器拿到后经 local_read_text_file / local_write_text_file 读写,
/// 不会让浏览器载荷选择任意文件系统目标。
#[tauri::command]
pub async fn dsh_settings_path(app: AppHandle) -> Result<String, String> {
    crate::harness::web::dsh_home_dir(&app)
        .map(|dir| dir.join("settings.yaml").to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// 应答一条 `dsh://approval` 事件对应的审批请求(requestId 来自事件 payload)。
/// approved=true → 桥返回 `{outcome: "allowed-once"}`,false → `"rejected"`;
/// 已超时/未知 requestId 时幂等成功(前端可能重复应答或应答晚到)。
#[tauri::command]
pub async fn dsh_approval_reply(
    manager: State<'_, HarnessManager>,
    request_id: String,
    approved: bool,
) -> Result<Value, String> {
    manager
        .bridge()
        .resolve_approval(&request_id, approved)
        .await;
    Ok(Value::Null)
}

/// 应答一条 `dsh://tool-exec` 事件对应的域工具执行(requestId 来自事件 payload)。
/// ok=true 时 text 作为工具结果返回给 dsh;ok=false 时 text 作为工具失败信息。
#[tauri::command]
pub async fn dsh_tool_exec_reply(
    manager: State<'_, HarnessManager>,
    request_id: String,
    ok: bool,
    text: String,
) -> Result<Value, String> {
    manager
        .bridge()
        .resolve_tool_exec(&request_id, ok, text)
        .await;
    Ok(Value::Null)
}

/// 记录 会话→资产 绑定(sessionId 关联到 assetId;asset_id 传空串解除绑定)。
/// tools.rs 的 memory 工具 asset scope 用 sessionId 沿 subagent 父链解析该绑定
/// (子代理会话继承父会话绑定);assetType 仅作调试信息。
#[tauri::command]
pub async fn dsh_bind_session(
    manager: State<'_, HarnessManager>,
    session_id: String,
    asset_type: String,
    asset_id: String,
) -> Result<Value, String> {
    manager
        .bridge()
        .bind_session(&session_id, &asset_type, &asset_id);
    Ok(Value::Null)
}

/// 用户起源领域事件上报(契约 §1/§4):前端面板在用户操作(SSH 命令提交、DB 查询
/// 完成、表打开等)时调用。Rust 侧强制 origin=user、summary 单行 ≤200 字符截断、
/// ts 补当前时间,然后:1) notify dsh(`starhub/domain.event`,无 runtime 静默跳过);
/// 2) 广播 `starhub://domain-event` 给全部窗口(其他窗口按 assetId 过滤投影刷新)。
/// 敏感值由前端上报前脱敏(summary 不含密码/密钥,契约 §8)。
#[tauri::command]
pub async fn dsh_report_domain_event(
    manager: State<'_, HarnessManager>,
    event: DomainEvent,
) -> Result<Value, String> {
    let event = DomainEvent::now(event.kind, event.asset_id, &event.summary, event.data, Some("user"));
    let payload = serde_json::to_value(&event).map_err(|e| format!("序列化领域事件失败: {e}"))?;
    manager.notify(DOMAIN_EVENT_METHOD, payload.clone()).await;
    manager.bridge().emit(DOMAIN_EVENT_EVENT, payload).await;
    Ok(Value::Null)
}

/// 面板「问 AI」入口(契约 §3/§7):把当前选中行 / 屏幕片段 / 报错文本发到壳内
/// AI。Rust emit `starhub://ask-ai` 到主壳(client-nav prefill composer 并聚焦);
/// 主壳窗口不存在时记日志,不 panic,command 仍成功返回。
#[tauri::command]
pub async fn starhub_ask_ai(
    app: AppHandle,
    text: String,
    asset_id: Option<String>,
    asset_name: Option<String>,
) -> Result<Value, String> {
    let mut payload = serde_json::Map::new();
    payload.insert("text".into(), Value::String(text));
    if let Some(asset_id) = asset_id {
        payload.insert("assetId".into(), Value::String(asset_id));
    }
    if let Some(asset_name) = asset_name {
        payload.insert("assetName".into(), Value::String(asset_name));
    }
    if let Err(error) = app.emit_to("main", ASK_AI_EVENT, Value::Object(payload)) {
        tracing::warn!("事件 {ASK_AI_EVENT} 发送失败: {error}");
    }
    Ok(Value::Null)
}
