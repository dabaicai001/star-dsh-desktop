//! StarHub Rust sidecar entry: newline-delimited JSON-RPC 2.0 over stdio.
//!
//! One JSON value per `\n`-terminated UTF-8 line, matching the TypeScript
//! peer `JsonRpcLineTransport`. Requests are answered with exactly one
//! response frame; notifications and responses are consumed silently;
//! malformed lines are ignored without killing the process. stdin EOF ends
//! the process with status 0. Diagnostics go to stderr only — stdout is the
//! protocol channel.
//!
//! Domain events (SSH data / MFA prompts / SFTP transfer progress) are
//! forwarded to the peer as `starhub/domain-event` notifications. They are
//! queued while a request is in flight and flushed before that request's
//! response, so the peer observes cause (event) before effect (result).
//!
//! The same notification channel carries the bridge contract notifications
//! (`starhub/domain.event` after a successful domain tool, `starhub/registry.sync`
//! on registry change, `starhub://open-asset` for the workbench UI action);
//! the `starhub-bridge` plugin dispatches them by the `event` member.
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use starhub_domain_ssh::events::{EventSink, KnownHostsStore};
use starhub_sidecar::android_runtime::AndroidRuntime;
use starhub_sidecar::bindings::SessionBindings;
use starhub_sidecar::bridge::{self, BridgeState};
use starhub_sidecar::db_runtime::DbRuntime;
use starhub_sidecar::desktop_runtime::DesktopRuntime;
use starhub_sidecar::jsonrpc::{InboundFrame, OutboundNotification, OutboundResponse};
use starhub_sidecar::known_hosts_store::FileKnownHostsStore;
use starhub_sidecar::methods;
use starhub_sidecar::runtime::SshRuntime;

/// 域事件出口:把 domain crate 的事件流转成 JSON-RPC 通知,排队等主循环刷盘。
struct NotificationSink {
    queue: Mutex<Sender<OutboundNotification>>,
}

impl EventSink for NotificationSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let notification = OutboundNotification::new(
            "starhub/domain-event",
            Some(serde_json::json!({ "event": event, "payload": payload })),
        );
        // 发送失败只可能是接收端已断开(进程退出中):事件丢弃即可,不影响协议
        let _ = self.queue.lock().unwrap().send(notification);
    }
}

/// 一条入站帧的处理上下文(stdio 循环是单线程的,全部借用即可)。
struct FrameContext<'a> {
    registry: &'a starhub_sidecar::registry::MethodRegistry,
    ssh: &'a SshRuntime,
    sink: &'a Arc<dyn EventSink>,
    bridge_state: &'a BridgeState,
    runtime: &'a tokio::runtime::Runtime,
    /// UI 面设置状态(AI 工具审计写入用)。
    ui: &'a starhub_sidecar::ui_runtime::UiRuntime,
}

/// 处理一条入站帧;返回待应答的响应,期间产生的事件通知排队到 `events`。
///
/// 通知(如 bridge 的停止生成信号 `starhub/exec.abort`)在这里直接执行——
/// 它们是协议的一等公民,不是「没有 method 的请求」。其余方法(含
/// `starhub/open.asset` 等桥命令)都走注册表分发。
fn handle_frame(frame: &InboundFrame, ctx: &FrameContext<'_>) -> Option<OutboundResponse> {
    use starhub_sidecar::jsonrpc::FrameKind;
    match frame.kind() {
        FrameKind::Request { id, method, params } => {
            let params = params.unwrap_or(serde_json::Value::Null);
            let started = std::time::Instant::now();
            let outcome = if method == EXEC_ABORT_METHOD {
                // 停止生成:中断在途 exec(以请求形态调用时同样受理,便于对端确认)
                handle_exec_abort(ctx.ssh, ctx.runtime, &params)
            } else {
                // 请求帧必然产生应答:dispatch 对 Request 分支不会返回 None
                let (_, outcome) = ctx
                    .registry
                    .dispatch(frame)
                    .expect("request frame always yields an outcome");
                outcome.and_then(|result| {
                    // 契约 §1/M4:域工具成功后回写 AI 起源领域事件 + recentExecs
                    if bridge::is_tool_method(&method) {
                        if let Some(text) = result.get("text").and_then(serde_json::Value::as_str) {
                            bridge::after_tool_success(
                                ctx.ssh,
                                ctx.sink,
                                ctx.bridge_state,
                                &method,
                                &params,
                                text,
                            );
                        }
                    }
                    Ok(result)
                })
            };
            // 审计(设置 → 审计「AI」类别):域工具调用成功与失败都记,与 Tauri 版
            // harness::tools 同口径;UI 面方法(ui.*)不记——那是用户自己的操作。
            if bridge::is_tool_method(&method) {
                record_tool_audit(ctx, &method, &params, &outcome, started.elapsed());
            }
            Some(match outcome {
                Ok(result) => OutboundResponse::ok(id, result),
                Err(error) => OutboundResponse::fail(id, error),
            })
        }
        FrameKind::Notification { method, params } => {
            let params = params.unwrap_or(serde_json::Value::Null);
            match method.as_str() {
                EXEC_ABORT_METHOD => {
                    if let Err(error) = handle_exec_abort(ctx.ssh, ctx.runtime, &params) {
                        eprintln!(
                            "starhub-sidecar-rust: {EXEC_ABORT_METHOD} 失败: {}",
                            error.message
                        );
                    }
                }
                other => eprintln!("starhub-sidecar-rust: 未订阅的通知(忽略): {other}"),
            }
            None
        }
        FrameKind::Response { .. } | FrameKind::Ignorable => None,
    }
}

/// 停止生成信号(bridge 在用户点「停止生成」时下行):中断在途 SSH exec。
///
/// 既是请求也是通知(停止信号不等应答);不占注册表——它是信号,不是方法。
const EXEC_ABORT_METHOD: &str = "starhub/exec.abort";

/// 域工具调用的审计回写(设置 → 审计「AI」类别)。
///
/// target = 会话绑定资产的名称(资产已删回退 id,无绑定为空);detail 只取白名单
/// 参数,失败时附错误原文。解析不出资产上下文时 asset_id/target 为空——
/// 与 Tauri 版一致(审计不因缺少绑定而丢失)。
fn record_tool_audit(
    ctx: &FrameContext<'_>,
    method: &str,
    params: &serde_json::Value,
    outcome: &Result<serde_json::Value, starhub_sidecar::jsonrpc::RpcError>,
    elapsed: std::time::Duration,
) {
    let (asset_type, asset_id) = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .and_then(|session_id| ctx.ssh.resolve_bound_asset(session_id))
        .unzip();
    let _ = asset_type;
    let asset_name = asset_id
        .as_deref()
        .and_then(|asset_id| ctx.ssh.assets().get(asset_id).ok())
        .map(|record| record.name);
    let error = match outcome {
        Ok(_) => None,
        Err(error) => Some(error.message.as_str()),
    };
    let success = outcome.is_ok();
    starhub_sidecar::audit_store::record_tool_call(
        ctx.ui.audit(),
        &starhub_sidecar::audit_store::ToolCallRecord {
            name: method,
            args: params,
            asset_name: asset_name.as_deref().or(asset_id.as_deref()),
            session_id: params.get("sessionId").and_then(serde_json::Value::as_str),
            asset_id: asset_id.as_deref(),
            success,
            duration_ms: elapsed.as_millis(),
            error,
        },
    );
}

/// 停止生成:按 exec_id 中断在途 SSH exec。exec_id 未知(已结束)按未中断返回。
fn handle_exec_abort(
    ssh: &SshRuntime,
    runtime: &tokio::runtime::Runtime,
    params: &serde_json::Value,
) -> Result<serde_json::Value, starhub_sidecar::jsonrpc::RpcError> {
    let exec_id = params
        .get("execId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            starhub_sidecar::jsonrpc::RpcError::invalid_params(format!(
                "{EXEC_ABORT_METHOD} 缺少 execId"
            ))
        })?
        .to_string();
    let aborted = runtime.block_on(ssh.abort_exec(&exec_id)).unwrap_or(false);
    Ok(serde_json::json!({ "aborted": aborted }))
}

/// 把排队的事件通知全部刷到 stdout(在对应请求的响应之前)。
fn flush_events(out: &mut impl Write, events: &Receiver<OutboundNotification>) {
    while let Ok(notification) = events.try_recv() {
        if writeln!(out, "{}", notification.to_line()).is_err() {
            return; // stdout closed: peer is gone
        }
    }
    let _ = out.flush();
}

fn main() {
    let runtime = match methods::build_runtime() {
        Ok(runtime) => Arc::new(runtime),
        Err(error) => {
            eprintln!("starhub-sidecar-rust: {error}");
            std::process::exit(1);
        }
    };
    let (tx, rx): (Sender<OutboundNotification>, Receiver<OutboundNotification>) = mpsc::channel();
    let sink: Arc<dyn EventSink> = Arc::new(NotificationSink {
        queue: Mutex::new(tx),
    });
    // 资产存储 / known_hosts / 会话绑定在 SSH 与 DB 两个域之间共享:
    // 同一份资产存档、同一份 TOFU 策略、同一份「会话 → 资产」绑定。
    let bindings = Arc::new(SessionBindings::new());
    let ssh = match SshRuntime::from_env(Arc::clone(&sink), Arc::clone(&bindings)) {
        Ok(ssh) => Arc::new(ssh),
        Err(error) => {
            eprintln!("starhub-sidecar-rust: 资产存储初始化失败: {error}");
            std::process::exit(1);
        }
    };
    let known_hosts: Arc<dyn KnownHostsStore> = Arc::new(FileKnownHostsStore::from_env());
    let db = Arc::new(DbRuntime::new(
        Arc::clone(&ssh.assets()),
        Arc::new(starhub_domain_db::GoSidecar::new()),
        Arc::clone(&known_hosts),
        Arc::clone(&bindings),
    ));
    // Desktop 域:六个 seam 全部接 sidecar 自己的实现(JSON 存储 / 文件设置 /
    // 环境缓存目录 / 事件通知出口),资产与 known_hosts 与另外两个域共用。
    let desktop = Arc::new(DesktopRuntime::new(
        Arc::clone(&db),
        Arc::clone(&ssh.assets()),
        FileKnownHostsStore::from_env(),
        Arc::clone(&sink),
    ));
    // 直播/接管帧出口(M3):帧枢纽先建,Android 域与它共享同一处授权/接管/通道。
    // 直播不再是窗口面——scrcpy H.264 / 截图轮询经本地 WS 推给壳内面板。
    let live_hub = Arc::new(starhub_live::FrameHub::new());
    // adb 路径解析与 Android 域共用同一份文件设置 + 同一个管理器(缓存不分裂)
    let android_settings: Arc<dyn starhub_domain_android::SettingsStore> =
        Arc::new(starhub_sidecar::desktop_runtime::FileSettingsStore::from_env());
    let android_manager = Arc::new(starhub_domain_android::AndroidManager::new());
    let live = Arc::new(
        match starhub_sidecar::live_runtime::LiveRuntime::with_hub(
            Arc::clone(&live_hub),
            Arc::clone(&android_settings),
            Arc::clone(&android_manager),
            &runtime,
        ) {
            Ok(live) => live,
            Err(error) => {
                eprintln!("starhub-sidecar-rust: 直播帧通道启动失败: {error}");
                std::process::exit(1);
            }
        },
    );
    let android = Arc::new(AndroidRuntime::with_live(
        Arc::clone(&ssh.assets()),
        Arc::clone(&bindings),
        Arc::clone(&sink),
        Arc::clone(&live_hub),
        live.android().clone(),
    ));
    let bridge_state = Arc::new(BridgeState::default());
    let ui_state = Arc::new(starhub_sidecar::ui_runtime::UiRuntime::from_env());
    let registry = methods::registry_with_domains(
        Arc::clone(&runtime),
        Arc::clone(&ssh),
        Arc::clone(&db),
        Arc::clone(&desktop),
        Arc::clone(&android),
        Arc::new(()),
        Arc::clone(&sink),
        Arc::clone(&bridge_state),
        Arc::clone(&ui_state),
        Arc::clone(&live),
    );

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("starhub-sidecar-rust: stdin read error: {error}");
                break;
            }
        };
        let Some(frame) = InboundFrame::parse(&line) else {
            continue; // malformed line: ignored per protocol contract
        };
        let context = FrameContext {
            registry: &registry,
            ssh: &ssh,
            sink: &sink,
            bridge_state: &bridge_state,
            runtime: &runtime,
            ui: &ui_state,
        };
        let Some(response) = handle_frame(&frame, &context) else {
            // 通知/响应帧:它自己可能也产生了事件(如停止生成的中断确认),
            // 这里刷掉,不等下一条入站帧。
            flush_events(&mut out, &rx);
            continue;
        };
        // 因果顺序:先刷掉本条请求期间产生的事件,再写它的响应——
        // 对端因此永远先看到「因」(事件)再看到「果」(结果)。
        flush_events(&mut out, &rx);
        if writeln!(out, "{}", response.to_line()).is_err() {
            break; // stdout closed: peer is gone
        }
        if out.flush().is_err() {
            break;
        }
    }
}
