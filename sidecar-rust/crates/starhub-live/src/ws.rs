//! 本地 WS server(127.0.0.1 + 一次性 token)——直播/接管帧出口的根。
//!
//! 为什么是 WS 而不是 Tauri 的 custom protocol:
//! - bridge 插件要用 `webServer.registerUpgrade` 把这条通道以带鉴权的 path
//!   暴露给 GUI(§3.1 / 风险 R3),upgrade 的原生对端就是 WS;
//! - 帧是**推送**语义(H.264 12fps / PNG 400ms),HTTP 拉取 + `since` 游标要多
//!   一轮协商;WS 一次握手后双向,人工输入也走同一条连接下行。
//!
//! 鉴权:URL query 带一次性 token(`/live/<channel>?token=<t>`),握手时经
//! `accept_hdr_async` 的回调取出并**立即消费**(R3 记录的备选方案正是
//! 「upgrade 路由带一次性 token,握手后即弃」)。浏览器 `WebSocket` 不能带头,
//! 所以 token 只能走 query;真正的 GUI 鉴权由 bridge 的 upgrade 路由负责——
//! 它持 token,不向下游泄露。

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{
    Callback, ErrorResponse, Request, Response,
};
use tokio_tungstenite::tungstenite::Message;

use crate::hub::{Channel, FrameHub, LiveInput};

/// WS 路径前缀。
pub const LIVE_PATH_PREFIX: &str = "/live/";

/// 绑定中的本地 WS server(尚未 accept)。
pub struct LiveServer {
    listener: TcpListener,
    hub: Arc<FrameHub>,
}

/// 已启动的 server 句柄(端口已定,可 `shutdown`)。
pub struct LiveServerHandle {
    /// 实际监听端口(请求 0 时由内核分配)。
    pub port: u16,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl LiveServerHandle {
    /// 停止 accept(已建立的连接由各自的关闭路径收尾)。
    pub fn shutdown(self) {
        let _ = self.shutdown.send(());
    }
}

impl LiveServer {
    /// 绑定 127.0.0.1:`port`(`port = 0` 让内核分配空闲端口)。
    ///
    /// 只绑 loopback:帧通道绝不对局域网暴露(token 是第二道锁,不是第一道)。
    pub async fn bind(hub: Arc<FrameHub>, port: u16) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("直播帧通道绑定 127.0.0.1:{port} 失败: {e}"))?;
        Ok(Self { listener, hub })
    }

    pub fn local_addr(&self) -> Result<SocketAddr, String> {
        self.listener.local_addr().map_err(|e| e.to_string())
    }

    /// 后台 accept 循环:每个连接一个任务,互不阻塞。
    pub fn spawn(self) -> Result<LiveServerHandle, String> {
        let LiveServer { listener, hub } = self;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, addr)) = accepted else {
                            break;
                        };
                        let hub = hub.clone();
                        tokio::spawn(async move {
                            if let Err(error) = serve_connection(hub, stream, addr).await {
                                eprintln!("[starhub-live] 连接 {addr} 结束: {error}");
                            }
                        });
                    }
                }
            }
        });
        Ok(LiveServerHandle {
            port,
            shutdown: shutdown_tx,
        })
    }

    /// `ws://127.0.0.1:<port>`(bridge 拼 `<channel>?token=` 用)。
    pub fn endpoint(port: u16) -> String {
        format!("ws://127.0.0.1:{port}")
    }
}

/// 从 `/live/<channel>?token=<t>` 解析出通道 id 与令牌。
pub fn parse_live_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix(LIVE_PATH_PREFIX)?;
    let (channel, query) = match rest.split_once('?') {
        Some((channel, query)) => (channel, Some(query)),
        None => (rest, None),
    };
    let channel = channel.trim_end_matches('/').to_string();
    if channel.is_empty() {
        return None;
    }
    let token = query
        .and_then(|query| {
            query.split('&').find_map(|kv| {
                let (key, value) = kv.split_once('=')?;
                (key == "token").then(|| value.to_string())
            })
        })
        .unwrap_or_default();
    if token.is_empty() {
        return None;
    }
    Some((channel, token))
}

/// 握手回调:把请求路径塞进共享格(`accept_hdr_async` 之后读)。
struct PathCapture(Arc<Mutex<Option<String>>>);

impl Callback for PathCapture {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(
                request
                    .uri()
                    .path_and_query()
                    .map(|pq| pq.as_str().to_string())
                    .unwrap_or_else(|| request.uri().path().to_string()),
            );
        }
        Ok(response)
    }
}

/// 服务一条 WS 连接:握手(取路径兑令牌)→ 订阅帧 → 双向转发。
async fn serve_connection(
    hub: Arc<FrameHub>,
    stream: TcpStream,
    addr: SocketAddr,
) -> Result<(), String> {
    let captured = Arc::new(Mutex::new(None));
    let mut ws = tokio_tungstenite::accept_hdr_async(stream, PathCapture(captured.clone()))
        .await
        .map_err(|e| format!("WS 握手失败: {e}"))?;

    let path = captured
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_default();
    let Some((channel_id, token)) = parse_live_path(&path) else {
        let _ = send_json(&mut ws, &json!({"t":"error","error":"bad live path"})).await;
        let _ = ws.close(None).await;
        return Ok(());
    };
    let Some(channel) = hub.redeem(&token) else {
        let _ = send_json(
            &mut ws,
            &json!({"t":"error","error":"invalid or used token"}),
        )
        .await;
        let _ = ws.close(None).await;
        return Ok(());
    };
    if channel.id() != channel_id {
        // 令牌与路径声明的通道不符:拒绝(防拿 A 通道令牌订阅 B 通道)
        let _ = send_json(&mut ws, &json!({"t":"error","error":"channel mismatch"})).await;
        let _ = ws.close(None).await;
        return Ok(());
    }

    let (replay, mut frames_rx) = channel.subscribe();
    let mut meta_rx = channel.meta_rx();
    // 首屏:元数据 + 重放帧(迟到者从最近关键帧补齐)
    if send_json(&mut ws, &meta_message(&channel)).await.is_err() {
        channel.unsubscribe();
        return Ok(());
    }
    for frame in replay {
        if ws.send(Message::Binary(frame.into())).await.is_err() {
            channel.unsubscribe();
            return Ok(());
        }
    }

    loop {
        tokio::select! {
            changed = meta_rx.changed() => {
                if changed.is_err() {
                    break; // 通道关闭(源退出)
                }
                if send_json(&mut ws, &meta_message(&channel)).await.is_err() {
                    break;
                }
            }
            frame = frames_rx.recv() => {
                match frame {
                    Ok(frame) => {
                        if ws.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break, // 通道关闭
                }
            }
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if handle_client_message(&mut ws, &channel, text.as_str()).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        // 客户端不应推二进制;忽略(协议只允许服务端下发帧)
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Frame(_))) => {}
                }
            }
        }
    }

    // 退订;最后一个订阅者离开即关闭通道(等价 Tauri 关窗口)
    if channel.unsubscribe() == 0 {
        hub.close(channel.id());
    }
    let _ = addr;
    Ok(())
}

fn meta_message(channel: &Channel) -> Value {
    let meta = channel.meta();
    json!({
        "t": "meta",
        "mode": meta.mode,
        "width": meta.width,
        "height": meta.height,
        "vw": meta.vw,
        "vh": meta.vh,
        "error": meta.error,
        "takeover": channel.takeover(),
    })
}

async fn send_json(
    ws: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    value: &Value,
) -> Result<(), String> {
    ws.send(Message::text(value.to_string()))
        .await
        .map_err(|e| e.to_string())
}

/// 处理客户端文本消息;返回 Err 表示连接该结束了。
async fn handle_client_message(
    ws: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    channel: &Arc<Channel>,
    text: &str,
) -> Result<(), String> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        let _ = send_json(ws, &json!({"t":"error","error":"bad json"})).await;
        return Ok(());
    };
    match value.get("t").and_then(Value::as_str) {
        Some("ping") => {
            send_json(ws, &json!({"t":"pong"})).await?;
        }
        Some("takeover") => {
            let active = value.get("active").and_then(Value::as_bool) == Some(true);
            channel.set_takeover(active);
            send_json(ws, &json!({"t":"ack","takeover":active})).await?;
        }
        Some("input") => {
            if !channel.takeover() {
                // 423 语义逐字保持(Tauri 直播页同文案)
                send_json(ws, &json!({"t":"error","error":"not in takeover"})).await?;
                return Ok(());
            }
            let Some(action) = value.get("action") else {
                send_json(ws, &json!({"t":"error","error":"missing action"})).await?;
                return Ok(());
            };
            let input = match crate::hub::Gesture::parse(action) {
                Some(gesture) => LiveInput::Gesture(gesture),
                None => LiveInput::Raw(action.clone()),
            };
            channel
                .input_tx()
                .send(input)
                .map_err(|_| "直播通道已停止(源退出)".to_string())?;
            send_json(ws, &json!({"t":"ack","input":true})).await?;
        }
        Some("close") => return Err("client closed".to_string()),
        _ => {
            send_json(ws, &json!({"t":"error","error":"unknown message"})).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{decode_frame, MSG_PNG};
    use crate::hub::{ChannelMeta, Gesture, LiveInput, KIND_ANDROID};

    #[test]
    fn live_path_parsing() {
        assert_eq!(
            parse_live_path("/live/android:emulator-5554?token=abc123"),
            Some(("android:emulator-5554".to_string(), "abc123".to_string()))
        );
        assert_eq!(
            parse_live_path("/live/desktop:inst-1/?token=t&x=1"),
            Some(("desktop:inst-1".to_string(), "t".to_string()))
        );
        assert_eq!(parse_live_path("/live/android:a"), None, "缺 token");
        assert_eq!(parse_live_path("/live/?token=t"), None, "缺通道");
        assert_eq!(parse_live_path("/other/x?token=t"), None, "前缀不符");
    }

    #[tokio::test]
    async fn end_to_end_over_a_real_socket() {
        let hub = Arc::new(FrameHub::new());
        let channel = hub
            .open("android:serial-a", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        channel.patch_meta(|meta| {
            meta.mode = "scrcpy".to_string();
            meta.width = 1080;
            meta.height = 2400;
        });
        let token = hub.issue_token("android:serial-a").unwrap();

        let server = LiveServer::bind(hub.clone(), 0).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = server.spawn().unwrap();
        assert_eq!(LiveServer::endpoint(port), format!("ws://127.0.0.1:{port}"));

        let url = format!("ws://127.0.0.1:{port}/live/android:serial-a?token={token}");
        let (mut socket, _response) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("WS 握手");

        // 首条:meta(带 patch 后的字段)
        let meta_text = socket.next().await.unwrap().unwrap();
        let Message::Text(meta_text) = meta_text else {
            panic!("expected text meta");
        };
        let meta: Value = serde_json::from_str(meta_text.as_str()).unwrap();
        assert_eq!(meta["t"], "meta");
        assert_eq!(meta["mode"], "scrcpy");
        assert_eq!(meta["width"], 1080);

        // 推一帧 PNG → 收到二进制
        channel.push_png(b"png-bytes");
        let frame = socket.next().await.unwrap().unwrap();
        let Message::Binary(frame) = frame else {
            panic!("expected binary frame");
        };
        let (kind, _flags, payload) = decode_frame(&frame).unwrap();
        assert_eq!(kind, MSG_PNG);
        assert_eq!(payload, b"png-bytes");

        // 接管 + 输入下行
        socket
            .send(Message::text(
                json!({"t":"takeover","active":true}).to_string(),
            ))
            .await
            .unwrap();
        let ack = socket.next().await.unwrap().unwrap();
        let Message::Text(ack) = ack else {
            panic!("expected text ack");
        };
        assert_eq!(
            serde_json::from_str::<Value>(ack.as_str()).unwrap()["t"],
            "ack"
        );
        assert!(channel.takeover());

        let mut input_rx = channel.take_input_rx().unwrap();
        socket
            .send(Message::text(
                json!({"t":"input","action":{"type":"tap","x":5,"y":6}}).to_string(),
            ))
            .await
            .unwrap();
        let ack = socket.next().await.unwrap().unwrap();
        assert!(matches!(ack, Message::Text(_)));
        assert!(matches!(
            input_rx.try_recv().unwrap(),
            LiveInput::Gesture(Gesture::Tap { x: 5, y: 6 })
        ));

        // 关连接 → 最后一个订阅者离开 → 通道关闭
        let _ = socket.close(None).await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while hub.get("android:serial-a").is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("通道应在最后一个订阅者离开后关闭");
        handle.shutdown();
    }

    #[tokio::test]
    async fn input_without_takeover_is_rejected() {
        let hub = Arc::new(FrameHub::new());
        let channel = hub
            .open("android:serial-a", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        let token = hub.issue_token("android:serial-a").unwrap();
        let server = LiveServer::bind(hub.clone(), 0).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = server.spawn().unwrap();

        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "ws://127.0.0.1:{port}/live/android:serial-a?token={token}"
        ))
        .await
        .unwrap();
        let _meta = socket.next().await.unwrap().unwrap();
        socket
            .send(Message::text(
                json!({"t":"input","action":{"type":"tap","x":1,"y":2}}).to_string(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap();
        let Message::Text(reply) = reply else {
            panic!("expected text error");
        };
        let reply: Value = serde_json::from_str(reply.as_str()).unwrap();
        assert_eq!(reply["error"], "not in takeover", "未接管不下发输入");
        let _ = socket.close(None).await;
        let _ = channel;
        handle.shutdown();
    }

    #[tokio::test]
    async fn bad_token_is_rejected_and_channel_survives() {
        let hub = Arc::new(FrameHub::new());
        hub.open("android:serial-a", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        let server = LiveServer::bind(hub.clone(), 0).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = server.spawn().unwrap();

        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "ws://127.0.0.1:{port}/live/android:serial-a?token=forged"
        ))
        .await
        .unwrap();
        let reply = socket.next().await.unwrap().unwrap();
        let Message::Text(reply) = reply else {
            panic!("expected text error");
        };
        let reply: Value = serde_json::from_str(reply.as_str()).unwrap();
        assert_eq!(reply["t"], "error");
        assert_eq!(reply["error"], "invalid or used token");
        assert!(
            hub.get("android:serial-a").is_some(),
            "通道不被伪造令牌影响"
        );
        handle.shutdown();
    }
}
