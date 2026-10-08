//! Web 网关:本地 HTTP 代理,上游流量经 SSH direct-tcpip 通道从服务器侧出口。
//!
//! 每条上游请求在已认证的 SSH 连接上开一个 direct-tcpip 通道到目标 host:port,
//! 由最终 SSH 服务器(跳板机场景为最内层服务器)的网络视角发出,可访问内网站点
//! 与服务器 localhost 服务。
//!
//! HTTPS:在 direct-tcpip 通道流之上用 tokio-rustls 做客户端 TLS(SNI = 目标 host,
//! webpki 根证书校验真实服务器证书),TLS 在网关端到端终止;前端 webview 全程只见
//! 本地明文 HTTP,无证书问题。不做 MITM、不用自签 CA。
//!
//! HTML 响应做 URL 改写并注入 <base>,让子资源与相对链接也走同一条代理链路;
//! 3xx 重定向不自动跟随,Location 原样改写成 /__proxy__/ 形式交给浏览器处理。

use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{timeout, Duration};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 24 * 1024 * 1024;
const MAX_RESPONSE_HEAD_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 24 * 1024 * 1024;
const UPSTREAM_TIMEOUT_SEC: u64 = 30;

pub const GATEWAY_PATH_PREFIX: &str = "/__proxy__/";

pub struct GatewayHandle {
    pub port: u16,
    pub abort: tokio::task::AbortHandle,
    pub connections: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
}

/// 启动 Web 网关:本地 HTTP 监听,上游经 SSH direct-tcpip 通道转发。
/// 泛型化 handler 以便测试用 trust-all handler 直连本地 SSH 测试服务器。
pub async fn start<H>(
    local_port: u16,
    ssh: Arc<russh::client::Handle<H>>,
) -> Result<GatewayHandle, String>
where
    H: russh::client::Handler + Send + Sync + 'static,
    H::Error: Into<anyhow::Error> + Send,
{
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("web gateway bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("web gateway local addr failed: {e}"))?
        .port();
    tracing::info!("web gateway listening on 127.0.0.1:{port}");
    let connections: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let connections_loop = Arc::clone(&connections);
    // 最近一次成功代理 HTML 文档的上游(scheme, hostport):JS 根相对导航
    // 丢掉 /__proxy__/ 前缀且 Referer 缺失(如 sandbox iframe)时的兜底。
    let last_upstream: Arc<std::sync::Mutex<Option<(String, String)>>> =
        Arc::new(std::sync::Mutex::new(None));
    let task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let ssh = Arc::clone(&ssh);
                    let last_upstream = Arc::clone(&last_upstream);
                    let conn = tokio::spawn(async move {
                        if let Err(e) = handle_conn(stream, ssh, last_upstream).await {
                            tracing::debug!("web gateway conn closed: {e}");
                        }
                    });
                    if let Ok(mut v) = connections_loop.lock() {
                        v.push(conn.abort_handle());
                    }
                }
                Err(e) => {
                    // 瞬时 accept 失败(如 fd 耗尽)不能退出循环:一旦 break,监听器
                    // 永久死亡但网关句柄还在,前端会一直拿到「127.0.0.1 拒绝连接」。
                    tracing::warn!("web gateway accept failed, retrying: {e}");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        }
    });
    Ok(GatewayHandle {
        port,
        abort: task.abort_handle(),
        connections,
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn read_request_head(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            return Ok((buf[..pos + 4].to_vec(), buf[pos + 4..].to_vec()));
        }
        if buf.len() >= MAX_REQUEST_HEAD_BYTES {
            return Err("request head too large".to_string());
        }
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request failed: {e}"))?;
        if n == 0 {
            return Err("connection closed before request head".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn parse_request_headers(head: &str) -> Result<Vec<(String, String)>, String> {
    head.split("\r\n")
        .skip(1)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line
                .split_once(':')
                .ok_or_else(|| "invalid request header".to_string())?;
            Ok((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn request_content_length(headers: &[(String, String)]) -> Result<usize, String> {
    let Some(value) = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value)
    else {
        return Ok(0);
    };
    let length = value
        .parse::<usize>()
        .map_err(|_| "invalid content-length".to_string())?;
    if length > MAX_REQUEST_BODY_BYTES {
        return Err("request body too large".to_string());
    }
    Ok(length)
}

async fn read_request_body(
    stream: &mut TcpStream,
    mut body: Vec<u8>,
    content_length: usize,
) -> Result<Vec<u8>, String> {
    if body.len() > content_length {
        body.truncate(content_length);
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let mut chunk = vec![0u8; remaining.min(8192)];
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request body failed: {e}"))?;
        if n == 0 {
            return Err("connection closed before request body".to_string());
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(body)
}

fn should_forward_request_header(name: &str) -> bool {
    ![
        "accept-encoding",
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]
    .iter()
    .any(|skip| name.eq_ignore_ascii_case(skip))
}

/// RFC 7230 校验:头名必须是 token,头值只允许可见 ASCII + Tab。
/// 浏览器经网关转发的头值若带非 ASCII 原始字节(如个别站点种的 GBK cookie,
/// 经 from_utf8_lossy 已损坏),IIS/Http.sys 会直接 400「invalid header name」,
/// 这类头必须丢弃而不是原样转发。
fn is_valid_header(name: &str, value: &str) -> bool {
    fn is_token_char(c: u8) -> bool {
        c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c)
    }
    !name.is_empty()
        && name.bytes().all(is_token_char)
        && value
            .bytes()
            .all(|c| c == b'\t' || (0x20..=0x7e).contains(&c))
}

/// Referer 回写:浏览器送来的 Referer 是网关 URL
/// (http://127.0.0.1:<port>/__proxy__/<scheme>/<host>/<path>),原样转发会让上游
/// 看到莫名其妙的 127.0.0.1 引用页,且带防盗链的站点(图片/视频)会拒绝;
/// 能解析出代理前缀就回写成原始站形式,否则原样保留。
fn rewrite_referer(value: &str) -> String {
    let Some(idx) = value.find(GATEWAY_PATH_PREFIX) else {
        return value.to_string();
    };
    let rest = &value[idx + GATEWAY_PATH_PREFIX.len()..];
    let mut seg = rest.splitn(2, '/');
    let scheme = seg.next().unwrap_or_default();
    let tail = seg.next().unwrap_or_default();
    if (scheme != "http" && scheme != "https") || tail.is_empty() {
        return value.to_string();
    }
    format!("{scheme}://{tail}")
}

async fn respond_text(stream: &mut TcpStream, status: &str, message: &str) {
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

/// 友好的 HTML 错误页:说明问题并给出「返回上一页」链接。
fn error_page_html(title: &str, message: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
body {{ font-family: system-ui, sans-serif; background: #f6f7f9; color: #333; display: flex; justify-content: center; padding-top: 12vh; }}
.card {{ max-width: 560px; background: #fff; border: 1px solid #e2e4e9; border-radius: 8px; padding: 28px 32px; }}
h1 {{ font-size: 17px; margin: 0 0 12px; }}
p {{ font-size: 13px; line-height: 1.7; margin: 0 0 16px; word-break: break-all; }}
a {{ color: #2563eb; text-decoration: none; font-size: 13px; }}
a:hover {{ text-decoration: underline; }}
</style></head>
<body><div class="card"><h1>{title}</h1><p>{message}</p>
<p><a href="javascript:history.back()">&larr; Back to previous page</a></p>
</div></body></html>"#
    )
}

async fn respond_html(stream: &mut TcpStream, status: &str, html: &str) {
    let body = html.as_bytes();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

/// 307 重定向(保持请求方法与请求体)。
async fn respond_redirect(stream: &mut TcpStream, location: &str) {
    let head = format!(
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(head.as_bytes()).await;
}

/// 为丢失 /__proxy__/ 前缀的根相对请求(多半是页面 JS 的 location 跳转或
/// 未改写到的根相对 URL)从 Referer 恢复代理目标。Referer 仍是代理 URL,
/// 可解析出上游 scheme/host;恢复不了则返回 None,由调用方回错误页。
fn recover_proxy_redirect(raw_path: &str, headers: &[(String, String)]) -> Option<String> {
    if !raw_path.starts_with('/') || raw_path.starts_with("//") {
        return None;
    }
    let referer = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("referer"))?
        .1
        .as_str();
    let idx = referer.find(GATEWAY_PATH_PREFIX)? + GATEWAY_PATH_PREFIX.len();
    let rest = &referer[idx..];
    let mut seg = rest.splitn(3, '/');
    let scheme = seg.next().unwrap_or_default();
    let hostport = seg.next().unwrap_or_default();
    if (scheme != "http" && scheme != "https") || hostport.is_empty() {
        return None;
    }
    Some(format!(
        "{GATEWAY_PATH_PREFIX}{scheme}/{hostport}{raw_path}"
    ))
}

/// Referer 恢复失败时的兜底:用本网关最近一次成功代理 HTML 文档的上游。
/// 单站点浏览场景下可靠;多标签同时浏览不同站点时 Referer 路径优先,兜底
/// 可能指错站点,但严格好于直接回错误页。
fn fallback_proxy_redirect(
    raw_path: &str,
    last_upstream: &Arc<std::sync::Mutex<Option<(String, String)>>>,
) -> Option<String> {
    if !raw_path.starts_with('/') || raw_path.starts_with("//") {
        return None;
    }
    let (scheme, hostport) = last_upstream.lock().ok()?.clone()?;
    Some(format!(
        "{GATEWAY_PATH_PREFIX}{scheme}/{hostport}{raw_path}"
    ))
}

/// 上游字节流:direct-tcpip 通道流,或在其上完成 TLS 握手的加密流。
trait UpstreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> UpstreamIo for T {}

/// 共享的 TLS connector(webpki 根证书,只构建一次)。
fn tls_connector() -> tokio_rustls::TlsConnector {
    static CONNECTOR: once_cell::sync::OnceCell<tokio_rustls::TlsConnector> =
        once_cell::sync::OnceCell::new();
    CONNECTOR
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            // 必须显式指定 CryptoProvider:reqwest(rustls-tls → ring)与
            // tokio-rustls(默认 → aws-lc-rs)在同一 rustls 构建里启用了两个 provider,
            // ClientConfig::builder() 无法自动抉择会直接 panic;panic 发生在连接 task
            // 内,TCP 流被静默断开,浏览器表现为「127.0.0.1 未发送任何数据」。
            let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
            let config = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("ring provider supports the default TLS protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            tokio_rustls::TlsConnector::from(Arc::new(config))
        })
        .clone()
}

/// 经 SSH direct-tcpip 通道连到目标 host:port;https 时在通道流上做端到端 TLS。
async fn open_upstream<H>(
    ssh: &Arc<russh::client::Handle<H>>,
    scheme: &str,
    host: &str,
    port: u16,
) -> Result<Box<dyn UpstreamIo>, String>
where
    H: russh::client::Handler,
    H::Error: Into<anyhow::Error> + Send,
{
    let channel = ssh
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("open direct-tcpip channel to {host}:{port} failed: {e}"))?;
    let stream = channel.into_stream();
    if scheme == "https" {
        let server_name = match host.parse::<std::net::IpAddr>() {
            Ok(ip) => ServerName::from(ip),
            Err(_) => ServerName::try_from(host.to_string())
                .map_err(|e| format!("invalid TLS server name {host}: {e}"))?,
        };
        let tls = tls_connector()
            .connect(server_name, stream)
            .await
            .map_err(|e| format!("TLS handshake with {host}:{port} failed: {e}"))?;
        Ok(Box::new(tls))
    } else {
        Ok(Box::new(stream))
    }
}

/// 从上游流读响应头(到 \r\n\r\n),返回头部文本与已读出的 body 前缀。
async fn read_response_head(
    stream: &mut (impl AsyncRead + Unpin),
) -> Result<(String, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
            return Ok((head, buf[pos + 4..].to_vec()));
        }
        if buf.len() >= MAX_RESPONSE_HEAD_BYTES {
            return Err("response head too large".to_string());
        }
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read upstream response failed: {e}"))?;
        if n == 0 {
            return Err("upstream closed before response head".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// 读定长 body,总量封顶 MAX_RESPONSE_BYTES。
async fn read_body_fixed(
    stream: &mut (impl AsyncRead + Unpin),
    mut body: Vec<u8>,
    content_length: usize,
) -> Result<Vec<u8>, String> {
    let wanted = content_length.min(MAX_RESPONSE_BYTES);
    if body.len() > wanted {
        body.truncate(wanted);
    }
    while body.len() < wanted {
        let remaining = wanted - body.len();
        let mut chunk = vec![0u8; remaining.min(16384)];
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read upstream body failed: {e}"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(body)
}

/// 解码 chunked body,总量封顶 MAX_RESPONSE_BYTES。
async fn read_body_chunked(
    stream: &mut (impl AsyncRead + Unpin),
    mut pending: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut chunk_buf = [0u8; 16384];
    // 确保 pending 至少 n 字节,不够则从流里补读
    async fn fill(
        stream: &mut (impl AsyncRead + Unpin),
        pending: &mut Vec<u8>,
        n: usize,
    ) -> Result<(), String> {
        while pending.len() < n {
            let mut tmp = [0u8; 8192];
            let r = stream
                .read(&mut tmp)
                .await
                .map_err(|e| format!("read upstream body failed: {e}"))?;
            if r == 0 {
                return Err("upstream closed in chunked body".to_string());
            }
            pending.extend_from_slice(&tmp[..r]);
        }
        Ok(())
    }
    loop {
        // 读 chunk size 行
        loop {
            if let Some(pos) = find_subslice(&pending, b"\r\n") {
                let size_line = String::from_utf8_lossy(&pending[..pos]).to_string();
                let size_str = size_line.split(';').next().unwrap_or("").trim();
                let size = usize::from_str_radix(size_str, 16)
                    .map_err(|_| "invalid chunk size".to_string())?;
                pending.drain(..pos + 2);
                if size == 0 {
                    // 末尾 trailer 一并丢弃(读到空行为止,尽力而为)
                    return Ok(body);
                }
                fill(stream, &mut pending, size + 2).await?;
                body.extend_from_slice(&pending[..size]);
                pending.drain(..size + 2); // 含结尾 \r\n
                break;
            }
            if pending.len() > 8192 {
                return Err("chunk size line too long".to_string());
            }
            let n = stream
                .read(&mut chunk_buf)
                .await
                .map_err(|e| format!("read upstream body failed: {e}"))?;
            if n == 0 {
                return Err("upstream closed in chunked body".to_string());
            }
            pending.extend_from_slice(&chunk_buf[..n]);
        }
        if body.len() >= MAX_RESPONSE_BYTES {
            body.truncate(MAX_RESPONSE_BYTES);
            return Ok(body);
        }
    }
}

/// 读到 EOF(Connection: close 场景),总量封顶 MAX_RESPONSE_BYTES。
async fn read_body_to_eof(
    stream: &mut (impl AsyncRead + Unpin),
    mut body: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let mut chunk = [0u8; 16384];
    while body.len() < MAX_RESPONSE_BYTES {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read upstream body failed: {e}"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    if body.len() > MAX_RESPONSE_BYTES {
        body.truncate(MAX_RESPONSE_BYTES);
    }
    Ok(body)
}

struct UpstreamResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// 回写响应时要剥离的上游头(入参须已转小写)。
///
/// 除 hop-by-hop 与长度类头外,x-frame-options / CSP 必须剥离:上游站点(如百度)
/// 用 frame-ancestors / X-Frame-Options 禁止被 iframe 嵌入,webview 会直接渲染
/// 错误页「127.0.0.1 拒绝连接」(ERR_BLOCKED_BY_RESPONSE)——不是 TCP 层的连接
/// 拒绝,极易误判为网关没监听。整个 CSP 一并剥离:改写后的页面经 127.0.0.1 源
/// 加载,上游 CSP 的 script-src / img-src / frame-ancestors 等指令都会拦截
/// 改写产物与代理子资源。
fn should_skip_response_header(lower_name: &str) -> bool {
    const SKIP_HEADERS: &[&str] = &[
        "content-length",
        "transfer-encoding",
        "content-encoding",
        "connection",
        "keep-alive",
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "x-frame-options",
        "content-security-policy",
        "content-security-policy-report-only",
    ];
    SKIP_HEADERS.contains(&lower_name)
}

/// 解析 hostport 为 (host, port);无端口时按 scheme 默认 80/443。
fn split_host_port(hostport: &str, scheme: &str) -> Result<(String, u16), String> {
    let default_port = if scheme == "https" { 443 } else { 80 };
    if let Some(rest) = hostport.strip_prefix('[') {
        // IPv6: [::1] 或 [::1]:8080
        let end = rest
            .find(']')
            .ok_or_else(|| "invalid IPv6 host".to_string())?;
        let host = &rest[..end];
        let port = match rest[end + 1..].strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| "invalid port".to_string())?,
            None => default_port,
        };
        return Ok((host.to_string(), port));
    }
    if let Some((host, port)) = hostport.rsplit_once(':') {
        if !host.contains(':') {
            let port = port
                .parse::<u16>()
                .map_err(|_| "invalid port".to_string())?;
            return Ok((host.to_string(), port));
        }
    }
    Ok((hostport.to_string(), default_port))
}

/// 经 SSH 隧道执行一次上游 HTTP 请求并收集完整响应。
async fn fetch_upstream<H>(
    ssh: &Arc<russh::client::Handle<H>>,
    scheme: &str,
    hostport: &str,
    path_query: &str,
    method: &str,
    request_headers: &[(String, String)],
    request_body: &[u8],
) -> Result<UpstreamResponse, String>
where
    H: russh::client::Handler,
    H::Error: Into<anyhow::Error> + Send,
{
    let (host, port) = split_host_port(hostport, scheme)?;
    let mut stream = open_upstream(ssh, scheme, &host, port).await?;

    // 写 HTTP/1.1 请求:Accept-Encoding 固定 identity(不做解压),Connection: close
    // 让无 Content-Length 的响应可以读到 EOF 为止。User-Agent 优先透传浏览器的,
    // 浏览器没送才用网关默认 UA(避免重复 UA 头)。
    let mut req = format!(
        "{method} {path_query} HTTP/1.1\r\nHost: {hostport}\r\nAccept-Encoding: identity\r\nConnection: close\r\n"
    );
    let mut has_user_agent = false;
    for (name, value) in request_headers {
        if !should_forward_request_header(name) {
            continue;
        }
        if !is_valid_header(name, value) {
            // 非法头(非 ASCII 值等)原样转发会被严格的上游(IIS/Http.sys)
            // 整单 400 拒掉,丢弃比失败好;留 warn 日志便于排查
            tracing::warn!("web gateway dropping invalid header {name} for {hostport}{path_query}");
            continue;
        }
        if name.eq_ignore_ascii_case("user-agent") {
            has_user_agent = true;
        }
        if name.eq_ignore_ascii_case("referer") {
            req.push_str(&format!("Referer: {}\r\n", rewrite_referer(value)));
            continue;
        }
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has_user_agent {
        req.push_str("User-Agent: Mozilla/5.0 (StarHub Web Gateway)\r\n");
    }
    if !request_body.is_empty() {
        req.push_str(&format!("Content-Length: {}\r\n", request_body.len()));
    }
    req.push_str("\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write upstream request failed: {e}"))?;
    if !request_body.is_empty() {
        stream
            .write_all(request_body)
            .await
            .map_err(|e| format!("write upstream body failed: {e}"))?;
    }

    let (head, leftover) = read_response_head(&mut stream).await?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut status_parts = status_line.splitn(3, ' ');
    let _http_version = status_parts.next();
    let status: u16 = status_parts
        .next()
        .unwrap_or("502")
        .parse()
        .map_err(|_| "invalid upstream status line".to_string())?;
    let status_text = status_parts.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            line.split_once(':')
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        })
        .collect();

    let is_chunked = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    });
    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok());

    // HEAD / 204 / 304 无 body
    let no_body =
        method == "HEAD" || status == 204 || status == 304 || (100..200).contains(&status);
    let body = if no_body {
        Vec::new()
    } else if is_chunked {
        read_body_chunked(&mut stream, leftover).await?
    } else if let Some(length) = content_length {
        read_body_fixed(&mut stream, leftover, length).await?
    } else {
        read_body_to_eof(&mut stream, leftover).await?
    };

    Ok(UpstreamResponse {
        status,
        status_text,
        headers,
        body,
    })
}

async fn handle_conn<H>(
    mut stream: TcpStream,
    ssh: Arc<russh::client::Handle<H>>,
    last_upstream: Arc<std::sync::Mutex<Option<(String, String)>>>,
) -> Result<(), String>
where
    H: russh::client::Handler,
    H::Error: Into<anyhow::Error> + Send,
{
    let (head_bytes, leftover) = read_request_head(&mut stream).await?;
    let head_text = String::from_utf8_lossy(&head_bytes).to_string();
    let mut lines = head_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_ascii_uppercase();
    let raw_path = parts.next().unwrap_or_default().to_string();
    let request_headers = parse_request_headers(&head_text)?;
    if request_headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding") && !value.eq_ignore_ascii_case("identity")
    }) {
        respond_text(
            &mut stream,
            "501 Not Implemented",
            "web gateway: chunked requests are not supported",
        )
        .await;
        return Ok(());
    }
    let content_length = match request_content_length(&request_headers) {
        Ok(length) => length,
        Err(error) => {
            respond_text(
                &mut stream,
                "413 Payload Too Large",
                &format!("web gateway: {error}"),
            )
            .await;
            return Ok(());
        }
    };
    let request_body = read_request_body(&mut stream, leftover, content_length).await?;

    // 解析 /__proxy__/<scheme>/<hostport>/<path>?<query>
    let Some(rest) = raw_path.strip_prefix(GATEWAY_PATH_PREFIX) else {
        // JS 驱动的根相对导航(如百度搜索回车后 location.href="/s?wd=...")会把
        // 网关联源根路径直接打过来,丢掉 /__proxy__/ 前缀;HTML 改写覆盖不到 JS。
        // 优先用 Referer(仍为代理 URL)找回上游 scheme/host;Referer 缺失
        // (sandbox iframe / referrer 策略等)时兜底用最近成功代理 HTML 的上游。
        // 307 保持方法与请求体,导航与 XHR 都适用。
        if let Some(target) = recover_proxy_redirect(&raw_path, &request_headers)
            .or_else(|| fallback_proxy_redirect(&raw_path, &last_upstream))
        {
            respond_redirect(&mut stream, &target).await;
            return Ok(());
        }
        respond_html(
            &mut stream,
            "404 Not Found",
            &error_page_html(
                "StarHub Web Gateway — link cannot be proxied",
                "This link does not point to a proxied page, so it cannot be opened through the SSH web gateway. Go back and reload the page to continue browsing via the proxy.",
            ),
        )
        .await;
        return Ok(());
    };
    let mut seg = rest.splitn(3, '/');
    let scheme = seg.next().unwrap_or_default().to_string();
    let hostport = seg.next().unwrap_or_default().to_string();
    let tail = seg.next().unwrap_or_default();
    let path_query = if tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{tail}")
    };
    if (scheme != "http" && scheme != "https") || hostport.is_empty() {
        respond_html(
            &mut stream,
            "400 Bad Request",
            &error_page_html(
                "StarHub Web Gateway — bad proxy URL",
                "The proxy URL is malformed (expect /__proxy__/<http|https>/<host>/<path>). Go back and reload the page.",
            ),
        )
        .await;
        return Ok(());
    }

    tracing::debug!("web gateway request: {method} {scheme}://{hostport}{path_query}");

    // 经 SSH 隧道向上游发请求;通道打不开/超时/目标不可达时给友好错误页
    let upstream_result = timeout(
        Duration::from_secs(UPSTREAM_TIMEOUT_SEC),
        fetch_upstream(
            &ssh,
            &scheme,
            &hostport,
            &path_query,
            &method,
            &request_headers,
            &request_body,
        ),
    )
    .await;
    let resp = match upstream_result {
        Ok(Ok(resp)) => resp,
        Ok(Err(error)) => {
            tracing::warn!(
                "web gateway upstream error for {scheme}://{hostport}{path_query}: {error}"
            );
            respond_html(
                &mut stream,
                "502 Bad Gateway",
                &error_page_html(
                    "StarHub Web Gateway — cannot reach target via SSH tunnel",
                    &format!(
                        "Failed to reach {scheme}://{hostport} through the SSH tunnel (the request would exit from the SSH server side). The server may have TCP forwarding disabled (AllowTcpForwarding), or the target is unreachable from the server.<br><br><code>{error}</code>",
                    ),
                ),
            )
            .await;
            return Ok(());
        }
        Err(_) => {
            tracing::warn!(
                "web gateway upstream timeout for {scheme}://{hostport}{path_query} after {UPSTREAM_TIMEOUT_SEC}s"
            );
            respond_html(
                &mut stream,
                "504 Gateway Timeout",
                &error_page_html(
                    "StarHub Web Gateway — upstream timed out",
                    &format!(
                        "The request to {scheme}://{hostport} via the SSH tunnel timed out after {UPSTREAM_TIMEOUT_SEC}s.",
                    ),
                ),
            )
            .await;
            return Ok(());
        }
    };

    let status = resp.status;
    let status_text = if resp.status_text.is_empty() {
        "OK"
    } else {
        resp.status_text.as_str()
    };
    let content_type = resp
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();

    let mut body = resp.body;
    // HTML 改写(注入 <base> + URL 改写)
    if content_type.contains("text/html") {
        // 记录最近成功代理 HTML 的上游,供无前缀请求的 Referer 兜底失效时使用
        if let Ok(mut slot) = last_upstream.lock() {
            *slot = Some((scheme.clone(), hostport.clone()));
        }
        let html = String::from_utf8_lossy(&body);
        body = rewrite_html(&html, &scheme, &hostport).into_bytes();
    }
    tracing::debug!(
        "web gateway response: {status} for {scheme}://{hostport}{path_query} ({} bytes)",
        body.len()
    );

    // 回写响应:3xx 原样返回(不跟随),Location/Refresh 改写成代理形式
    let mut out = format!("HTTP/1.1 {status} {status_text}\r\n");
    for (k, v) in &resp.headers {
        let lower = k.to_ascii_lowercase();
        if should_skip_response_header(&lower) {
            continue;
        }
        if lower == "location" {
            out.push_str(&format!(
                "Location: {}\r\n",
                rewrite_location(v, &scheme, &hostport, &path_query)
            ));
            continue;
        }
        if lower == "refresh" {
            out.push_str(&format!(
                "Refresh: {}\r\n",
                rewrite_refresh_header(v, &scheme, &hostport, &path_query)
            ));
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    stream
        .write_all(out.as_bytes())
        .await
        .map_err(|e| format!("write response failed: {e}"))?;
    stream
        .write_all(&body)
        .await
        .map_err(|e| format!("write body failed: {e}"))?;
    Ok(())
}

fn replace_root_relative(
    input: &str,
    needle: &str,
    page_prefix: &str,
    scheme_prefix: &str,
) -> String {
    let mut out = String::with_capacity(input.len() + input.len() / 4);
    let mut rest = input;
    while let Some(idx) = rest.find(needle) {
        let after = idx + needle.len();
        out.push_str(&rest[..after]);
        rest = &rest[after..];
        if rest.starts_with("/__proxy__/") {
            continue;
        }
        if rest.starts_with("//") {
            out.push_str(scheme_prefix);
            rest = &rest[2..];
        } else if rest.starts_with('/') {
            out.push_str(page_prefix);
        }
    }
    out.push_str(rest);
    out
}

/// 注入 <base href="/__proxy__/{scheme}/{hostport}/">:紧跟 <head...> 之后;
/// 无 head 则插到文档最前;已有 <base> 则不重复注入。
fn inject_base(html: &str, scheme: &str, hostport: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if lower.contains("<base") {
        return html.to_string();
    }
    let base = format!("<base href=\"{GATEWAY_PATH_PREFIX}{scheme}/{hostport}/\">");
    if let Some(head_idx) = lower.find("<head") {
        if let Some(gt) = html[head_idx..].find('>') {
            let at = head_idx + gt + 1;
            return format!("{}{}{}", &html[..at], base, &html[at..]);
        }
    }
    format!("{base}{html}")
}

/// 改写单个 URL(用于 meta refresh / srcset 候选):绝对、协议相对、根相对
/// 都改写成代理形式;裸相对路径交给注入的 <base> 解析,保持不变。
fn rewrite_url_token(url: &str, scheme: &str, hostport: &str) -> String {
    if url.starts_with("/__proxy__/") {
        return url.to_string();
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return format!("{GATEWAY_PATH_PREFIX}https/{rest}");
    }
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("{GATEWAY_PATH_PREFIX}http/{rest}");
    }
    if let Some(rest) = url.strip_prefix("//") {
        return format!("{GATEWAY_PATH_PREFIX}{scheme}/{rest}");
    }
    if url.starts_with('/') {
        return format!("{GATEWAY_PATH_PREFIX}{scheme}/{hostport}{url}");
    }
    url.to_string()
}

/// 改写 srcset 值:逗号分隔的候选,每个候选为「URL + 可选描述符」。
fn rewrite_srcset_value(value: &str, scheme: &str, hostport: &str) -> String {
    value
        .split(',')
        .map(|candidate| {
            let trimmed = candidate.trim_start();
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let url = parts.next().unwrap_or_default();
            let descriptor = parts.next().unwrap_or_default();
            if url.is_empty() {
                return candidate.to_string();
            }
            let rewritten = rewrite_url_token(url, scheme, hostport);
            if descriptor.is_empty() {
                rewritten
            } else {
                format!("{rewritten} {}", descriptor.trim_end())
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// 改写属性值形式的 srcset(srcset="..."),保持引号不变。
fn rewrite_srcset_attrs(html: &str, scheme: &str, hostport: &str) -> String {
    let mut out = String::with_capacity(html.len() + html.len() / 8);
    let mut rest = html;
    while let Some(idx) = rest.find("srcset=") {
        out.push_str(&rest[..idx + "srcset=".len()]);
        rest = &rest[idx + "srcset=".len()..];
        let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        out.push(q);
        rest = &rest[q.len_utf8()..];
        let end = rest.find(q).unwrap_or(rest.len());
        out.push_str(&rewrite_srcset_value(&rest[..end], scheme, hostport));
        if end < rest.len() {
            out.push(q);
            rest = &rest[end + q.len_utf8()..];
        } else {
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

/// 改写 <meta http-equiv="refresh" content="N;url=..."> 里的 url。
/// 识别依据:content 属性值中出现「;url=」或「; url=」(大小写不敏感)。
fn rewrite_meta_refresh(html: &str, scheme: &str, hostport: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() + html.len() / 8);
    let mut cursor = 0;
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("url=") {
        let idx = search_from + rel;
        // 仅当同一标签内前方有 refresh 字样时认为是 meta refresh
        let window_start = lower[..idx].rfind('<').unwrap_or(0);
        let tag_so_far = &lower[window_start..idx];
        let is_refresh = tag_so_far.contains("refresh") && !tag_so_far.contains('>');
        if !is_refresh {
            search_from = idx + 4;
            continue;
        }
        out.push_str(&html[cursor..idx + 4]);
        let after = idx + 4;
        let rest = &html[after..];
        // url 值:可能带引号,也可能到空白/引号/>为止
        if let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
            let inner = &rest[q.len_utf8()..];
            let end = inner.find(q).unwrap_or(inner.len());
            out.push(q);
            out.push_str(&rewrite_url_token(&inner[..end], scheme, hostport));
            if end < inner.len() {
                out.push(q);
            }
            cursor = after + q.len_utf8() + end + if end < inner.len() { q.len_utf8() } else { 0 };
        } else {
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '>')
                .unwrap_or(rest.len());
            out.push_str(&rewrite_url_token(&rest[..end], scheme, hostport));
            cursor = after + end;
        }
        search_from = cursor;
    }
    out.push_str(&html[cursor..]);
    out
}

fn rewrite_html(html: &str, scheme: &str, hostport: &str) -> String {
    let page_prefix = format!("{GATEWAY_PATH_PREFIX}{scheme}/{hostport}");
    let scheme_prefix = format!("{GATEWAY_PATH_PREFIX}{scheme}/");
    let mut s = html.to_string();
    for q in ['"', '\''] {
        s = s.replace(
            &format!("{q}https://"),
            &format!("{q}{GATEWAY_PATH_PREFIX}https/"),
        );
        s = s.replace(
            &format!("{q}http://"),
            &format!("{q}{GATEWAY_PATH_PREFIX}http/"),
        );
    }
    s = s.replace(
        &format!("(https://"),
        &format!("({GATEWAY_PATH_PREFIX}https/"),
    );
    s = s.replace(
        &format!("(http://"),
        &format!("({GATEWAY_PATH_PREFIX}http/"),
    );
    for q in ['"', '\''] {
        s = s.replace(&format!("{q}//"), &format!("{q}{scheme_prefix}"));
    }
    s = s.replace("(//", &format!("({scheme_prefix}"));
    for attr in [
        "href",
        "src",
        "action",
        "poster",
        "formaction",
        "data-src",
        "data-href",
    ] {
        for q in ['"', '\''] {
            s = replace_root_relative(&s, &format!("{attr}={q}"), &page_prefix, &scheme_prefix);
        }
    }
    for needle in ["url(", "url(\"", "url('"] {
        s = replace_root_relative(&s, needle, &page_prefix, &scheme_prefix);
    }
    s = rewrite_srcset_attrs(&s, scheme, hostport);
    s = rewrite_meta_refresh(&s, scheme, hostport);
    inject_bridge(&inject_base(&s, scheme, hostport))
}

/// 桥接脚本:注入到每个代理 HTML 页面,在页面内部完成外层(跨源)做不到的事——
/// _blank/中键/Ctrl 点击拦截、右键菜单、导航上报,统一 postMessage 给外层
/// WebBrowserView;同时接收外层的 back/forward/reload 命令。
/// 桌面应用源(tauri.localhost)与网关源(127.0.0.1:port)跨源,外层碰不到
/// iframe 的 document,只能靠注入脚本 + postMessage 通信。
const BRIDGE_SCRIPT: &str = r#"<script>(function(){
if(window.__starhubBridge)return;window.__starhubBridge=true;
function send(m){try{parent.postMessage(Object.assign({__starhub:1},m),'*')}catch(e){}}
document.addEventListener('click',onClick,true);
document.addEventListener('auxclick',onClick,true);
function onClick(e){
var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
if(!a)return;
var href='';try{href=new URL(a.getAttribute('href'),location.href).href}catch(x){}
if(!href)return;
var bt='';var b=document.querySelector('base[target]');
if(b)bt=(b.getAttribute('target')||'').toLowerCase();
var t=(a.target||bt).toLowerCase();
if(!(t==='_blank'||e.button===1||e.ctrlKey||e.metaKey))return;
e.preventDefault();e.stopPropagation();
send({type:'open-in-new-tab',url:href});
}
document.addEventListener('contextmenu',function(e){
e.preventDefault();
var l='';try{var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(a)l=new URL(a.getAttribute('href'),location.href).href;}catch(x){}
send({type:'contextmenu',x:e.clientX,y:e.clientY,link:l});
},true);
window.addEventListener('message',function(e){
var d=e.data;if(!d||d.__starhub!==1)return;
if(d.type==='cmd-back')history.back();
else if(d.type==='cmd-forward')history.forward();
else if(d.type==='cmd-reload')location.reload();
});
function nav(){send({type:'navigated',href:location.href,title:document.title||''});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',nav);
nav();
})();</script>"#;

/// 在注入的 <base> 之后(或文档最前)插入桥接脚本,尽早执行以挂捕获监听。
fn inject_bridge(html: &str) -> String {
    let marker = "<base href=\"";
    if let Some(idx) = html.find(marker) {
        if let Some(gt) = html[idx..].find('>') {
            let at = idx + gt + 1;
            return format!("{}{}{}", &html[..at], BRIDGE_SCRIPT, &html[at..]);
        }
    }
    format!("{BRIDGE_SCRIPT}{html}")
}

/// 把相对 Location 基于当前页面 path_query 解析为绝对路径(RFC 3986 简版)。
fn resolve_relative_path(current_path_query: &str, rel: &str) -> String {
    // 纯查询串/锚点:基于当前路径替换
    if rel.starts_with('?') || rel.starts_with('#') {
        let base_path = current_path_query.split(['?', '#']).next().unwrap_or("/");
        return format!("{base_path}{rel}");
    }
    let base_dir = {
        let p = current_path_query.split(['?', '#']).next().unwrap_or("/");
        match p.rfind('/') {
            Some(i) => &p[..=i],
            None => "/",
        }
    };
    let suffix_start = rel.find(['?', '#']).unwrap_or(rel.len());
    let (rel_path, suffix) = rel.split_at(suffix_start);
    let joined = format!("{base_dir}{rel_path}");
    let mut segments: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    format!("/{}{suffix}", segments.join("/"))
}

/// 改写 3xx 的 Location 头:绝对/协议相对/根相对直接改写;
/// 裸相对路径先基于当前页面解析成绝对路径再改写。
fn rewrite_location(value: &str, scheme: &str, hostport: &str, current_path_query: &str) -> String {
    if let Some(rest) = value.strip_prefix("https://") {
        return format!("{GATEWAY_PATH_PREFIX}https/{rest}");
    }
    if let Some(rest) = value.strip_prefix("http://") {
        return format!("{GATEWAY_PATH_PREFIX}http/{rest}");
    }
    if let Some(rest) = value.strip_prefix("//") {
        return format!("{GATEWAY_PATH_PREFIX}{scheme}/{rest}");
    }
    if value.starts_with('/') {
        return format!("{GATEWAY_PATH_PREFIX}{scheme}/{hostport}{value}");
    }
    let resolved = resolve_relative_path(current_path_query, value);
    format!("{GATEWAY_PATH_PREFIX}{scheme}/{hostport}{resolved}")
}

/// 改写 Refresh 响应头(格式:`N; url=...`)。
fn rewrite_refresh_header(
    value: &str,
    scheme: &str,
    hostport: &str,
    current_path_query: &str,
) -> String {
    let Some(semi) = value.find(';') else {
        return value.to_string();
    };
    let (delay, rest) = value.split_at(semi);
    let rest = &rest[1..];
    let trimmed = rest.trim_start();
    if trimmed.len() < 4 || !trimmed[..4].eq_ignore_ascii_case("url=") {
        return value.to_string();
    }
    let url = trimmed[4..].trim_matches(|c| c == '"' || c == '\'');
    let rewritten = rewrite_location(url, scheme, hostport, current_path_query);
    format!("{delay}; url={rewritten}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_absolute_protocol_relative_and_root_urls() {
        let html = r#"<html><head><link href="/assets/a.css"></head><body>
<img src="https://cdn.example.com/i.png"><a href="//m.example.com/x">x</a>
<form action='/login'></form><script>var u = "https://api.example.com/v1";</script>
<style>.b{background:url(/img/b.png)}</style></body></html>"#;
        let out = rewrite_html(html, "https", "www.example.com");
        assert!(out.contains(r#"href="/__proxy__/https/www.example.com/assets/a.css""#));
        assert!(out.contains(r#"src="/__proxy__/https/cdn.example.com/i.png""#));
        assert!(out.contains(r#"href="/__proxy__/https/m.example.com/x""#));
        assert!(out.contains(r#"action='/__proxy__/https/www.example.com/login'"#));
        assert!(out.contains(r#""/__proxy__/https/api.example.com/v1""#));
        assert!(out.contains("url(/__proxy__/https/www.example.com/img/b.png)"));
    }

    #[test]
    fn injects_base_after_head() {
        let out = rewrite_html(
            r#"<html><head lang="en"><title>t</title></head><body></body></html>"#,
            "https",
            "a.com",
        );
        let head_end = out.find("<head lang=\"en\">").unwrap() + "<head lang=\"en\">".len();
        assert!(out[head_end..].starts_with(r#"<base href="/__proxy__/https/a.com/">"#));
    }

    #[test]
    fn injects_base_at_front_without_head() {
        let out = rewrite_html(r#"<div>hi</div>"#, "http", "a.com:8080");
        assert!(out.starts_with(r#"<base href="/__proxy__/http/a.com:8080/">"#));
    }

    #[test]
    fn does_not_duplicate_existing_base() {
        let out = rewrite_html(
            r#"<html><head><base href="https://a.com/x/"></head></html>"#,
            "https",
            "a.com",
        );
        assert_eq!(out.matches("<base").count(), 1);
    }

    #[test]
    fn rewrites_meta_refresh_url() {
        let html = r#"<html><head><meta http-equiv="refresh" content="5;url=/login"><meta http-equiv="refresh" content="0; URL=https://other.com/x"></head></html>"#;
        let out = rewrite_html(html, "https", "a.com");
        assert!(out.contains("url=/__proxy__/https/a.com/login"));
        assert!(out.contains("URL=/__proxy__/https/other.com/x"));
    }

    #[test]
    fn leaves_non_refresh_url_equals_alone() {
        // script 里的 url= 不是 meta refresh,不应改写
        let html =
            r#"<html><head></head><body><script>var x = "a?url=/keep";</script></body></html>"#;
        let out = rewrite_html(html, "https", "a.com");
        assert!(out.contains("url=/keep"));
    }

    #[test]
    fn rewrites_srcset_candidates() {
        let html = r#"<img srcset="/a.png 1x, https://cdn.com/b.png 2x, //m.com/c.png 3x, relative.png 4x">"#;
        let out = rewrite_html(html, "https", "a.com");
        assert!(out.contains(r#"srcset="/__proxy__/https/a.com/a.png 1x, /__proxy__/https/cdn.com/b.png 2x, /__proxy__/https/m.com/c.png 3x, relative.png 4x""#));
    }

    #[test]
    fn rewrites_data_src_and_data_href() {
        let html = r#"<img data-src="/lazy/a.png"><a data-href='/go'>x</a>"#;
        let out = rewrite_html(html, "http", "a.com");
        assert!(out.contains(r#"data-src="/__proxy__/http/a.com/lazy/a.png""#));
        assert!(out.contains(r#"data-href='/__proxy__/http/a.com/go'"#));
    }

    #[test]
    fn validates_header_names_and_values() {
        // 常规头放行
        assert!(is_valid_header("sec-ch-ua", "\"Chromium\";v=\"126\""));
        assert!(is_valid_header("Cookie", "a=b; c=d"));
        // 头名非法(空格 / 非 token 字符 / 空名)
        assert!(!is_valid_header("bad name", "v"));
        assert!(!is_valid_header("", "v"));
        // 头值带非 ASCII(GBK cookie 等场景,IIS/Http.sys 会整单 400)
        assert!(!is_valid_header("Cookie", "last=中文"));
        assert!(!is_valid_header("Referer", "https://a.com/中文"));
        // 控制字符同样拒绝,Tab 例外(RFC 允许)
        assert!(!is_valid_header("X-Test", "a\u{7}b"));
        assert!(is_valid_header("X-Test", "a\tb"));
    }

    #[test]
    fn rewrites_proxied_referer_back_to_origin() {
        assert_eq!(
            rewrite_referer("http://127.0.0.1:9123/__proxy__/https/www.baidu.com/s?wd=IP"),
            "https://www.baidu.com/s?wd=IP"
        );
        assert_eq!(
            rewrite_referer("http://127.0.0.1:9123/__proxy__/http/192.168.1.10:8080/admin"),
            "http://192.168.1.10:8080/admin"
        );
        // 非代理 Referer 原样保留
        assert_eq!(
            rewrite_referer("https://other.com/x"),
            "https://other.com/x"
        );
    }

    #[test]
    fn injects_bridge_script_into_html() {
        // 桥接脚本必须随改写产物注入:外层(跨源)碰不到 iframe document,
        // _blank 拦截 / 右键菜单 / 导航上报全靠它
        let out = rewrite_html(
            r#"<html><head><title>t</title></head><body></body></html>"#,
            "https",
            "a.com",
        );
        assert!(out.contains("__starhubBridge"));
        assert!(out.contains("open-in-new-tab"));
        assert!(out.contains("navigated"));
        // 右键上报必须带 link 字段:壳页右键菜单据此提供「复制链接地址 / 在外部浏览器打开」
        assert!(out.contains("type:'contextmenu'"));
        assert!(out.contains("link:l"));
        // 外层壳页经 cmd-* 命令驱动 in-page history(跨源下壳页碰不到 iframe 的 history)
        assert!(out.contains("cmd-back"));
        assert!(out.contains("cmd-forward"));
        assert!(out.contains("cmd-reload"));
        // 无 head 的文档也能注入(插到最前)
        let out = rewrite_html(r#"<div>hi</div>"#, "http", "a.com:8080");
        assert!(out.contains("__starhubBridge"));
    }

    #[test]
    fn rewrites_redirect_locations() {
        assert_eq!(
            rewrite_location("https://a.com/login", "http", "b.com", "/"),
            "/__proxy__/https/a.com/login"
        );
        assert_eq!(
            rewrite_location("//cdn.com/x", "https", "b.com", "/"),
            "/__proxy__/https/cdn.com/x"
        );
        assert_eq!(
            rewrite_location("/top", "https", "b.com", "/a/b"),
            "/__proxy__/https/b.com/top"
        );
    }

    #[test]
    fn resolves_relative_locations_against_current_page() {
        assert_eq!(
            rewrite_location("login", "https", "a.com", "/dir/page"),
            "/__proxy__/https/a.com/dir/login"
        );
        assert_eq!(
            rewrite_location("../x", "https", "a.com", "/dir/sub/page?q=1"),
            "/__proxy__/https/a.com/dir/x"
        );
        assert_eq!(
            rewrite_location("./y?z=2", "https", "a.com", "/dir/"),
            "/__proxy__/https/a.com/dir/y?z=2"
        );
        assert_eq!(
            rewrite_location("?page=2", "https", "a.com", "/list?old=1"),
            "/__proxy__/https/a.com/list?page=2"
        );
    }

    #[test]
    fn rewrites_refresh_header() {
        assert_eq!(
            rewrite_refresh_header("5; url=/login", "https", "a.com", "/"),
            "5; url=/__proxy__/https/a.com/login"
        );
        assert_eq!(
            rewrite_refresh_header("0;URL=https://other.com/x", "http", "a.com", "/"),
            "0; url=/__proxy__/https/other.com/x"
        );
        // 无 url 部分时原样返回
        assert_eq!(rewrite_refresh_header("5", "https", "a.com", "/"), "5");
    }

    #[test]
    fn splits_host_port_with_defaults() {
        assert_eq!(
            split_host_port("a.com", "https").unwrap(),
            ("a.com".to_string(), 443)
        );
        assert_eq!(
            split_host_port("a.com", "http").unwrap(),
            ("a.com".to_string(), 80)
        );
        assert_eq!(
            split_host_port("a.com:8080", "http").unwrap(),
            ("a.com".to_string(), 8080)
        );
        assert_eq!(
            split_host_port("[::1]:9000", "http").unwrap(),
            ("::1".to_string(), 9000)
        );
        assert_eq!(
            split_host_port("[::1]", "https").unwrap(),
            ("::1".to_string(), 443)
        );
    }

    #[test]
    fn preserves_end_to_end_request_headers_and_body_length() {
        let headers = parse_request_headers(
            "POST /__proxy__/https/example.com/login HTTP/1.1\r\nHost: localhost\r\nCookie: sid=abc\r\nAuthorization: Bearer token\r\nContent-Length: 12\r\nConnection: keep-alive\r\n\r\n",
        )
        .expect("headers should parse");
        assert_eq!(
            request_content_length(&headers).expect("length should parse"),
            12
        );
        assert!(should_forward_request_header("Cookie"));
        assert!(should_forward_request_header("Authorization"));
        assert!(!should_forward_request_header("Host"));
        assert!(!should_forward_request_header("Connection"));
        assert!(!should_forward_request_header("Content-Length"));
        assert!(!should_forward_request_header("Accept-Encoding"));
    }

    #[test]
    fn rejects_oversized_request_bodies() {
        let headers = vec![(
            "Content-Length".to_string(),
            (MAX_REQUEST_BODY_BYTES + 1).to_string(),
        )];
        assert_eq!(
            request_content_length(&headers),
            Err("request body too large".to_string())
        );
    }

    #[test]
    fn strips_frame_embedding_blockers_from_response_headers() {
        // x-frame-options / CSP(frame-ancestors) 会让 webview 拒绝渲染 iframe,
        // 报「127.0.0.1 拒绝连接」(ERR_BLOCKED_BY_RESPONSE),必须剥离
        assert!(should_skip_response_header("x-frame-options"));
        assert!(should_skip_response_header("content-security-policy"));
        assert!(should_skip_response_header(
            "content-security-policy-report-only"
        ));
        assert!(should_skip_response_header("content-length"));
        assert!(should_skip_response_header("transfer-encoding"));
        assert!(should_skip_response_header("content-encoding"));
        assert!(should_skip_response_header("connection"));
        // 其余业务头正常透传
        assert!(!should_skip_response_header("content-type"));
        assert!(!should_skip_response_header("set-cookie"));
        assert!(!should_skip_response_header("cache-control"));
    }

    #[test]
    fn recovers_proxy_redirect_from_referer() {
        // JS 根相对导航(如百度搜索回车)丢掉 /__proxy__/ 前缀时,
        // 用 Referer 中的代理 URL 找回上游 scheme/host
        let headers = vec![(
            "Referer".to_string(),
            "http://127.0.0.1:9123/__proxy__/https/www.baidu.com/".to_string(),
        )];
        assert_eq!(
            recover_proxy_redirect("/s?wd=IP", &headers),
            Some("/__proxy__/https/www.baidu.com/s?wd=IP".to_string())
        );
        // 带端口的上游
        let headers = vec![(
            "referer".to_string(),
            "http://127.0.0.1:9123/__proxy__/http/192.168.1.10:8080/admin/index".to_string(),
        )];
        assert_eq!(
            recover_proxy_redirect("/api/list?page=1", &headers),
            Some("/__proxy__/http/192.168.1.10:8080/api/list?page=1".to_string())
        );
        // 无 Referer / Referer 不是代理 URL / 路径非法时不恢复
        assert_eq!(recover_proxy_redirect("/s?wd=IP", &[]), None);
        let headers = vec![("Referer".to_string(), "https://www.baidu.com/".to_string())];
        assert_eq!(recover_proxy_redirect("/s?wd=IP", &headers), None);
        let headers = vec![(
            "Referer".to_string(),
            "http://127.0.0.1:9123/__proxy__/https/www.baidu.com/".to_string(),
        )];
        assert_eq!(recover_proxy_redirect("//evil.com/x", &headers), None);
        assert_eq!(recover_proxy_redirect("not-a-path", &headers), None);
    }

    #[test]
    fn falls_back_to_last_upstream_when_referer_missing() {
        // Referer 缺失(sandbox iframe 等)时,用最近成功代理 HTML 的上游兜底
        let last: Arc<std::sync::Mutex<Option<(String, String)>>> = Arc::new(
            std::sync::Mutex::new(Some(("https".to_string(), "www.baidu.com".to_string()))),
        );
        assert_eq!(
            fallback_proxy_redirect("/s?wd=IP", &last),
            Some("/__proxy__/https/www.baidu.com/s?wd=IP".to_string())
        );
        // 尚未代理过任何 HTML 文档时无兜底
        let empty: Arc<std::sync::Mutex<Option<(String, String)>>> =
            Arc::new(std::sync::Mutex::new(None));
        assert_eq!(fallback_proxy_redirect("/s?wd=IP", &empty), None);
        // 路径非法时同样不恢复
        assert_eq!(fallback_proxy_redirect("//evil.com/x", &last), None);
        assert_eq!(fallback_proxy_redirect("not-a-path", &last), None);
    }

    // ── 端到端:经本地 SSH 测试服务器(test-sftp/direct_tcpip_server.py,127.0.0.1:2223)
    // 的 direct-tcpip 通道访问真实站点,验证网关全链路(通道 + TLS + 改写)。 ──

    struct TrustAllHandler;

    impl russh::client::Handler for TrustAllHandler {
        type Error = anyhow::Error;

        async fn check_server_key(
            &mut self,
            _server_public_key: &russh::keys::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn connect_test_server() -> Option<Arc<russh::client::Handle<TrustAllHandler>>> {
        let config = Arc::new(russh::client::Config::default());
        let connect = russh::client::connect(config, ("127.0.0.1", 2223), TrustAllHandler);
        let mut handle = timeout(Duration::from_secs(5), connect).await.ok()?.ok()?;
        let authed = timeout(
            Duration::from_secs(5),
            handle.authenticate_password("testuser", "testpass"),
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .map(|r| r.success())
        .unwrap_or(false);
        authed.then(|| Arc::new(handle))
    }

    /// 向网关发一个原始 GET,读取完整响应文本。
    async fn gateway_get(port: u16, path: &str) -> String {
        let mut stream = timeout(
            Duration::from_secs(5),
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .expect("gateway port should accept connections")
        .expect("connect to gateway");
        let req =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        stream
            .write_all(req.as_bytes())
            .await
            .expect("write request");
        let mut buf = Vec::new();
        timeout(Duration::from_secs(40), stream.read_to_end(&mut buf))
            .await
            .expect("gateway should respond within timeout")
            .expect("read response");
        String::from_utf8_lossy(&buf).to_string()
    }

    /// 运行前需先启动:python test-sftp/direct_tcpip_server.py
    #[tokio::test]
    #[ignore = "requires test-sftp/direct_tcpip_server.py on 127.0.0.1:2223"]
    async fn gateway_fetches_baidu_over_direct_tcpip() {
        let Some(ssh) = connect_test_server().await else {
            eprintln!("skip: direct-tcpip test server not reachable on 127.0.0.1:2223");
            return;
        };
        let gw = start(0, ssh).await.expect("gateway should start");

        // 尚未代理过任何页面:非 /__proxy__/ 路径返回友好错误页而非裸 404
        let resp = gateway_get(gw.port, "/favicon.ico").await;
        assert!(
            resp.starts_with("HTTP/1.1 404"),
            "unexpected status: {}",
            resp.lines().next().unwrap_or_default()
        );
        assert!(
            resp.contains("StarHub Web Gateway"),
            "expected friendly error page"
        );

        // HTTPS 站点:通道 + TLS + HTML 改写全链路
        let resp = gateway_get(gw.port, "/__proxy__/https/www.baidu.com/").await;
        let status_line = resp.lines().next().unwrap_or_default().to_string();
        assert!(
            status_line.contains("200"),
            "expected 200 from baidu via tunnel, got: {status_line}\n{}",
            &resp[..resp.len().min(600)]
        );
        assert!(
            resp.contains("<base href=\"/__proxy__/https/www.baidu.com/\""),
            "rewritten HTML should inject proxy <base>"
        );
        // 上游的 frame-ancestors / X-Frame-Options 必须剥离,否则 webview 拒绝
        // 把页面渲染进 iframe,报「127.0.0.1 拒绝连接」(ERR_BLOCKED_BY_RESPONSE)
        let head = resp
            .split("\r\n\r\n")
            .next()
            .unwrap_or_default()
            .to_lowercase();
        assert!(
            !head.contains("frame-ancestors") && !head.contains("x-frame-options"),
            "frame-embedding blockers should be stripped, got head:\n{head}"
        );

        // 模拟百度搜索回车:JS 根相对导航丢掉 /__proxy__/ 前缀(且无 Referer,
        // 对应 sandbox iframe 场景),应 307 回代理形式而非错误页
        let resp = gateway_get(gw.port, "/s?wd=IP").await;
        let status_line = resp.lines().next().unwrap_or_default().to_string();
        assert!(
            status_line.contains("307"),
            "expected 307 recovery redirect, got: {status_line}"
        );
        let location = resp
            .lines()
            .find(|l| l.to_lowercase().starts_with("location:"))
            .unwrap_or_default()
            .to_string();
        assert_eq!(
            location.trim_end_matches('\r'),
            "Location: /__proxy__/https/www.baidu.com/s?wd=IP",
            "unexpected recovery location:\n{}",
            resp.split("\r\n\r\n").next().unwrap_or_default()
        );
        // 子资源(如 favicon)同样受益于兜底
        let resp = gateway_get(gw.port, "/favicon.ico").await;
        assert!(
            resp.lines().next().unwrap_or_default().contains("307"),
            "expected 307 for favicon fallback, got: {}",
            resp.lines().next().unwrap_or_default()
        );

        gw.abort.abort();
    }
}
