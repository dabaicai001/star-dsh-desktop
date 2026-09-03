//! Obscura 引擎的 CDP WebSocket 客户端。
//!
//! 连接 `ws://127.0.0.1:{port}/devtools/browser`,经 Target.createTarget +
//! Target.attachToTarget(flatten) 建立页面会话。会话命令带 `sessionId` 字段,
//! 事件按 method 分发。核心事件为 `Page.screencastFrame`(存最新帧 + 回 ACK)。
//!
//! 说明:只连本地 loopback 的 `ws://`,无 TLS,因此 tokio-tungstenite 关闭默认
//! TLS feature,避免引入 native-tls/rustls 依赖。

use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio::sync::{mpsc, oneshot};

/// 单次 CDP 调用等待应答的超时(页面脚本可能很慢,尤其 Runtime.evaluate)。
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// screencast 帧落点:由 ObscuraInner 提供;协议处理器(sync 上下文)只读帧存储。
pub trait FrameSink: Send + Sync + 'static {
    /// 收到一帧画布更新(JPEG base64)。
    fn on_screencast_frame(&self, session_id: &str, seq: u64, data_base64: String);
}

/// 客户端内部可变状态,Arc 共享以同时在 connect 派生的读写任务与 call 方法中访问。
struct Inner {
    tx: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
}

/// 组织好的 CDP 客户端:发送 channel + 按 id 分发的应答表。
///
/// `connect` 派生的读循环自持写循环,因此 screencast ACK 能直接写回,不必曲折取发送端。
#[derive(Clone)]
pub struct CdpClient {
    inner: Arc<Inner>,
    frame_sink: Arc<dyn FrameSink>,
}

impl CdpClient {
    pub fn new(frame_sink: Arc<dyn FrameSink>) -> Self {
        Self {
            inner: Arc::new(Inner {
                tx: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
            frame_sink,
        }
    }

    /// 连接浏览器级 CDP 端点并启动读写任务。
    pub async fn connect(&self, url: &str) -> Result<(), String> {
        use tokio_tungstenite::tungstenite::Message;
        let (ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| format!("连接 Obscura CDP 失败:{e}"))?;
        let (mut writer, mut reader) = ws.split();

        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        *self.inner.tx.lock().expect("cdp tx") = Some(tx.clone());

        // 写循环:发送 JSON 文本。
        let write_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let text = msg.to_string();
                if let Err(e) = writer.send(Message::Text(text.into())).await {
                    tracing::debug!("Obscura CDP 发送失败:{e}");
                    break;
                }
            }
        });

        // 读循环:按 id 应答;Page.screencastFrame 存帧 + ACK。
        let inner = self.inner.clone();
        let frame_sink = self.frame_sink.clone();
        let read_task = tokio::spawn(async move {
            while let Some(msg) = reader.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::debug!("Obscura CDP 读失败:{e}");
                        break;
                    }
                };
                let text = match msg {
                    Message::Text(t) => t.as_str().to_string(),
                    Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let value: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::debug!("Obscura CDP 非 JSON 帧:{e}");
                        continue;
                    }
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = inner.pending.lock().expect("cdp pending").remove(&id) {
                        let outcome = if value.get("error").is_some() {
                            let err = value
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("CDP 调用失败");
                            Err(err.to_string())
                        } else {
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(outcome);
                    }
                    continue;
                }
                let method = value.get("method").and_then(Value::as_str).unwrap_or("");
                if method == "Page.screencastFrame" {
                    let params = value.get("params").cloned().unwrap_or(Value::Null);
                    let session_id = value
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !session_id.is_empty() {
                        let data = params
                            .get("data")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let seq = params
                            .pointer("/metadata/seq")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        frame_sink.on_screencast_frame(session_id, seq, data);
                        // 立即 ACK,否则帧不断堆积。
                        let ack = serde_json::json!({
                            "method": "Page.screencastFrameAck",
                            "sessionId": session_id,
                            "params": {},
                        });
                        let _ = tx.send(ack);
                    }
                    continue;
                }
                // 其余事件(setting 的 Page.loadEventFired 等)忽略;等待逻辑用轮询。
            }
        });

        let _ = (write_task, read_task);
        Ok(())
    }

    /// 发送一条浏览器级命令(无 sessionId),等待应答。
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_session(None, method, params).await
    }

    /// 发送一条页面会话命令(带 sessionId),等待应答。
    pub async fn call_session(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let sender = self
            .inner
            .tx
            .lock()
            .expect("cdp tx")
            .clone()
            .ok_or_else(|| "Obscura CDP 未连接".to_string())?;
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Value, String>>();
        self.inner
            .pending
            .lock()
            .expect("cdp pending")
            .insert(id, resp_tx);
        let mut msg = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Some(sid) = session_id {
            msg["sessionId"] = Value::from(sid.to_string());
        }
        sender
            .send(msg)
            .map_err(|_| "Obscura CDP 发送通道已关闭".to_string())?;
        match tokio::time::timeout(CALL_TIMEOUT, resp_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("CDP {method} 应答通道已关闭")),
            Err(_) => {
                self.inner
                    .pending
                    .lock()
                    .expect("cdp pending")
                    .remove(&id);
                Err(format!("CDP {method} 超时({}s)", CALL_TIMEOUT.as_secs()))
            }
        }
    }
}
