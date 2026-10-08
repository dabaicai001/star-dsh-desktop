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

use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use starhub_domain_ssh::events::EventSink;
use starhub_sidecar::jsonrpc::{InboundFrame, OutboundNotification, OutboundResponse};
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

/// 处理一条入站帧;返回待应答的响应,期间产生的事件通知排队到 `events`。
///
/// 通知(如 bridge 的停止生成信号 `starhub/exec.abort`)在这里直接执行——
/// 它们是协议的一等公民,不是「没有 method 的请求」。
/// 处理一条入站帧;返回待应答的响应,期间产生的事件通知排队到 `events`。
///
/// 通知(如 bridge 的停止生成信号 `starhub/exec.abort`)在这里直接执行——
/// 它们是协议的一等公民,不是「没有 id 的请求」。
fn handle_frame(
    frame: &InboundFrame,
    registry: &starhub_sidecar::registry::MethodRegistry,
    ssh: &SshRuntime,
    runtime: &tokio::runtime::Runtime,
) -> Option<OutboundResponse> {
    use starhub_sidecar::jsonrpc::FrameKind;
    match frame.kind() {
        FrameKind::Request { id, method, params } => {
            let params = params.unwrap_or(serde_json::Value::Null);
            let outcome = if method == EXEC_ABORT_METHOD {
                // 停止生成:中断在途 exec(以请求形态调用时同样受理,便于对端确认)
                handle_exec_abort(ssh, runtime, &params)
            } else {
                // 请求帧必然产生应答:dispatch 对 Request 分支不会返回 None
                let (_, outcome) = registry
                    .dispatch(frame)
                    .expect("request frame always yields an outcome");
                outcome
            };
            Some(match outcome {
                Ok(result) => OutboundResponse::ok(id, result),
                Err(error) => OutboundResponse::fail(id, error),
            })
        }
        FrameKind::Notification { method, params } => {
            let params = params.unwrap_or(serde_json::Value::Null);
            match method.as_str() {
                EXEC_ABORT_METHOD => {
                    if let Err(error) = handle_exec_abort(ssh, runtime, &params) {
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
const EXEC_ABORT_METHOD: &str = "starhub/exec.abort";

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
    let ssh = match SshRuntime::from_env(sink) {
        Ok(ssh) => Arc::new(ssh),
        Err(error) => {
            eprintln!("starhub-sidecar-rust: 资产存储初始化失败: {error}");
            std::process::exit(1);
        }
    };
    let registry = methods::registry_with_domains(Arc::clone(&runtime), Arc::clone(&ssh));

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
        // 先刷掉上一条请求期间累积的事件,再写本条响应:因果顺序对端可依赖
        flush_events(&mut out, &rx);
        let Some(response) = handle_frame(&frame, &registry, &ssh, &runtime) else {
            continue; // notification or response: nothing to answer
        };
        if writeln!(out, "{}", response.to_line()).is_err() {
            break; // stdout closed: peer is gone
        }
        if out.flush().is_err() {
            break;
        }
    }
}
