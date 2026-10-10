//! StarHub Rust sidecar entry: newline-delimited JSON-RPC 2.0 over stdio.
//!
//! One JSON value per `\n`-terminated UTF-8 line, matching the TypeScript
//! peer `JsonRpcLineTransport`. Every inbound frame is handled on its own
//! worker thread: domain handlers block on the tokio runtime for the whole
//! call (an SSH connect can legitimately wait minutes), and the reader must
//! keep consuming stdin while that runs. Requests are answered with exactly
//! one response frame; notifications and responses are consumed silently;
//! malformed lines are ignored without killing the process. stdin EOF ends
//! the process with status 0. Diagnostics go to stderr only — stdout is the
//! protocol channel.
//!
//! Domain events (SSH data / MFA prompts / SFTP transfer progress) are
//! forwarded to the peer as `starhub/domain-event` notifications **the moment
//! the domain emits them**. That immediacy is what makes interactive prompts
//! work at all: the host key / keyboard-interactive / bastion prompts are
//! delivered while the connect request that waits for the answer is still in
//! flight, and the answer rides back on the same stdin the reader thread is
//! still consuming. Queuing them behind a request (the pre-2026-10-10
//! behaviour) deadlocked every first connection to an unknown host: the peer
//! could not answer a prompt it only saw after the answer deadline
//! (see docs/踩坑记录.md).
//!
//! The same notification channel carries the bridge contract notifications
//! (`starhub/domain.event` after a successful domain tool, `starhub/registry.sync`
//! on registry change, `starhub://open-asset` for the workbench UI action);
//! the `starhub-bridge` plugin dispatches them by the `event` member.
use std::io::{BufRead, Write};
use std::sync::Arc;

use starhub_domain_ssh::events::{EventSink, KnownHostsStore};
use starhub_sidecar::android_runtime::AndroidRuntime;
use starhub_sidecar::bindings::SessionBindings;
use starhub_sidecar::bridge::{self, BridgeState};
use starhub_sidecar::db_runtime::DbRuntime;
use starhub_sidecar::jsonrpc::{InboundFrame, OutboundNotification, OutboundResponse};
use starhub_sidecar::known_hosts_store::FileKnownHostsStore;
use starhub_sidecar::methods;
use starhub_sidecar::registry::MethodRegistry;
use starhub_sidecar::runtime::SshRuntime;
use starhub_sidecar::ui_runtime::UiRuntime;

/// 域事件出口:事件**当场**写成 `starhub/domain-event` 帧。
///
/// 不再排队等主循环刷盘:交互式 SSH 提示(主机密钥确认 / MFA 验证码 / 堡垒机
/// 选机器)必须在等待它的那个请求还挂着的时候就到达对端,否则对端只能在超时
/// 之后才看到提示——那等于没有提示。
struct NotificationSink;

impl EventSink for NotificationSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let notification = OutboundNotification::new(
            "starhub/domain-event",
            Some(serde_json::json!({ "event": event, "payload": payload })),
        );
        write_line(&notification.to_line());
    }
}

/// 写一行协议帧到 stdout。
///
/// stdout 的内部锁保证整行原子(帧不会被另一条线程截断),行尾换行即刷。
/// 写失败只可能是对端已退出(管道关闭):丢弃该帧,不让任意一条线程崩。
fn write_line(line: &str) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// 一条入站帧的处理上下文。
///
/// 每条帧在自己的工作线程上处理,因此按 `Arc` 持有全部共享状态(`Clone` 只复制
/// 引用计数);handler 内部的 `block_on` 因此不会连带阻塞 stdio 读取线程或其它在途请求。
#[derive(Clone)]
struct FrameContext {
    registry: Arc<MethodRegistry>,
    ssh: Arc<SshRuntime>,
    sink: Arc<dyn EventSink>,
    bridge_state: Arc<BridgeState>,
    runtime: Arc<tokio::runtime::Runtime>,
    /// UI 面设置状态(AI 工具审计写入用)。
    ui: Arc<UiRuntime>,
}

/// 处理一条入站帧;返回待应答的响应(事件通知已在产生处即时写出)。
///
/// 通知(如 bridge 的停止生成信号 `starhub/exec.abort`)在这里直接执行——
/// 它们是协议的一等公民,不是「没有 method 的请求」。其余方法(含
/// `starhub/open.asset` 等桥命令)都走注册表分发。
fn handle_frame(frame: &InboundFrame, ctx: &FrameContext) -> Option<OutboundResponse> {
    use starhub_sidecar::jsonrpc::FrameKind;
    match frame.kind() {
        FrameKind::Request { id, method, params } => {
            let params = params.unwrap_or(serde_json::Value::Null);
            let started = std::time::Instant::now();
            let outcome = if method == EXEC_ABORT_METHOD {
                // 停止生成:中断在途 exec(以请求形态调用时同样受理,便于对端确认)
                handle_exec_abort(&ctx.ssh, &ctx.runtime, &params)
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
                                &ctx.ssh,
                                &ctx.sink,
                                &ctx.bridge_state,
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
                    if let Err(error) = handle_exec_abort(&ctx.ssh, &ctx.runtime, &params) {
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
    ctx: &FrameContext,
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

fn main() {
    let runtime = match methods::build_runtime() {
        Ok(runtime) => Arc::new(runtime),
        Err(error) => {
            eprintln!("starhub-sidecar-rust: {error}");
            std::process::exit(1);
        }
    };
    let sink: Arc<dyn EventSink> = Arc::new(NotificationSink);
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
    // 直播/接管帧出口(M3):帧枢纽先建,Android 域与它共享同一处授权/接管/通道。
    // 直播不再是窗口面——scrcpy H.264 / 截图轮询经本地 WS 推给壳内面板。
    let live_hub = Arc::new(starhub_live::FrameHub::new());
    // adb 路径解析与 Android 域共用同一份文件设置 + 同一个管理器(缓存不分裂)
    let android_settings: Arc<dyn starhub_domain_android::SettingsStore> =
        Arc::new(starhub_sidecar::settings_store::FileSettingsStore::from_env());
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
    let ui_state = Arc::new(UiRuntime::from_env());
    let registry = methods::registry_with_domains(
        Arc::clone(&runtime),
        Arc::clone(&ssh),
        Arc::clone(&db),
        Arc::clone(&android),
        Arc::clone(&sink),
        Arc::clone(&bridge_state),
        Arc::clone(&ui_state),
        Arc::clone(&live),
    );
    let context = FrameContext {
        registry,
        ssh,
        sink,
        bridge_state,
        runtime,
        ui: ui_state,
    };

    let stdin = std::io::stdin();
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
        // 每条帧一个工作线程:域 handler 在内部 block_on 到完成(SSH 连接最长可等
        // 370s 的认证窗口),读取线程绝不替它等——否则对端为了回答这个请求而发的
        // 下一帧(主机密钥/MFA/堡垒机的应答)会排在管道里读不进来,形成自锁。
        let worker = context.clone();
        std::thread::spawn(move || {
            if let Some(response) = handle_frame(&frame, &worker) {
                write_line(&response.to_line());
            }
        });
    }
}
