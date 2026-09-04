//! SSH「网页访问」的原生 webview 壳(固定走 wry 真实内核,不再走 Obscura)。
//!
//! 经 `starhub-web://localhost/<sessionId>/index.html?port=<网关端口>` 打开一个
//! 自包含窗口:顶部地址栏 + 全视口 iframe 加载
//! `http://127.0.0.1:<port>/__proxy__/<scheme>/<hostport><path>`。地址栏输入原始
//! URL 即重写为网关代理 URL(与前端 web-browser-utils 同形态),页面内根相对跳转
//! 由网关 `<base>`/改写处理。仅做壳页直出,不依赖 Obscura 引擎/直播帧。

use std::borrow::Cow;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 校验 sessionId(允许小写字母/数字/冒号/连字符,防路径穿越)。
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-')
}

/// `starhub-web://localhost/<sessionId>/<resource>` 协议处理器:只直出壳页。
pub fn web_shell_protocol_handler(
    _app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path().to_string();
    let segments: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() != 2 || !valid_key(segments[0]) {
        return http_response(404, "text/plain; charset=utf-8", b"bad request".to_vec());
    }
    let (key, resource) = (segments[0], segments[1]);
    if matches!(resource, "index.html") || resource.is_empty() {
        let page = shell_page(key);
        http_response(200, "text/html; charset=utf-8", page.into_bytes())
    } else {
        http_response(404, "text/plain; charset=utf-8", b"not found".to_vec())
    }
}

fn http_response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Cow::Owned(body))
        .expect("构建 web-shell 响应失败")
}

/// 生成壳页(把 `__SESSION_KEY__` 替换为实际 sessionId)。
fn shell_page(session_id: &str) -> String {
    SHELL_PAGE.replace("__SESSION_KEY__", session_id)
}

/// 壳页:地址栏 + 全视口 iframe,原始 URL ↔ 网关代理 URL 双向改写。
/// 与前端 `web-browser-utils.ts` 的代理形态一致:
/// `http://127.0.0.1:{port}/__proxy__/{scheme}/{hostport}{pathQuery}`。
const SHELL_PAGE: &str = r##"
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 *{box-sizing:border-box}
 html,body{height:100%;margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#1e1f24;color:#e6e6e6}
 #bar{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid #333;background:#24262b}
 #bar button{height:28px;min-width:28px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border:1px solid #4a4d55;background:#33363c;color:#e6e6e6;border-radius:5px;cursor:pointer;font-size:14px}
 #bar button:hover{background:#40434b}
 #b{content:""}
 #addr{flex:1;height:28px;padding:0 10px;border:1px solid #4a4d55;border-radius:5px;background:#1a1b1f;color:#e6e6e6;outline:none}
 #frame{width:100%;height:calc(100% - 45px);border:0;background:#111}
</style></head>
<body>
<div id="bar">
  <button id="back" title="后退" aria-label="后退">&#8592;</button>
  <button id="fwd" title="前进" aria-label="前进">&#8594;</button>
  <button id="reload" title="刷新" aria-label="刷新">&#10227;</button>
  <input id="addr" placeholder="输入完整网址后按 Enter 访问" aria-label="地址栏">
</div>
<iframe id="frame" title="网页访问"></iframe>
<script>
var key='__SESSION_KEY__';
var port=parseInt(new URLSearchParams(location.search).get('port')||'0',10)||0;
var addr=document.getElementById('addr'),frame=document.getElementById('frame');
function normalize(raw){
  raw=(raw||'').trim();
  if(!raw) return null;
  var candidate=/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)?raw:('https://'+raw);
  var u; try{u=new URL(candidate);}catch(e){return null;}
  if(!u.hostname) return null;
  var scheme=u.protocol.replace(':','');
  var hs=u.hostname; var p=parseInt(u.port,10)||(scheme==='https'?443:80);
  if(p!==(scheme==='https'?443:80)) hs+=':'+p;
  var pq=u.pathname+(u.search||'')+(u.hash||'');
  if(pq==='') pq='/';
  return {scheme:scheme,hostport:hs,pathQuery:pq,href:u.href};
}
function proxyUrl(raw){
  var n=normalize(raw);
  if(!n||!port) return null;
  return 'http://127.0.0.1:'+port+'/__proxy__/'+n.scheme+'/'+n.hostport+n.pathQuery;
}
function originalOf(proxy){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/__proxy__\//.test(proxy||'')) return null;
  var rest=proxy.slice(proxy.indexOf('/__proxy__/')+'/__proxy__/'.length);
  var parts=rest.split('/');
  if(parts.length<2) return null;
  return parts[0]+'://'+parts[1]+'/'+parts.slice(2).join('/');
}
function setAddr(url){
  var o=originalOf(url);
  addr.value=o||url||'';
}
addr.addEventListener('keydown',function(e){
  if(e.key!=='Enter') return;
  var raw=addr.value.trim();
  if(!raw) return;
  var p=proxyUrl(raw);
  if(p){frame.src=p; setAddr(p);} else {addr.value='';}
});
document.getElementById('back').onclick=function(){if(frame.contentWindow)try{frame.contentWindow.history.back();}catch(e){}};
document.getElementById('fwd').onclick=function(){if(frame.contentWindow)try{frame.contentWindow.history.forward();}catch(e){}};
document.getElementById('reload').onclick=function(){var s=frame.src;if(s){frame.src=s;}};
frame.addEventListener('load',function(){try{setAddr(frame.contentWindow.location.href);}catch(e){}});
if(port>0){ addr.placeholder='输入内网网址后按 Enter 访问(如 http://a.internal:8080)'; }
else { addr.placeholder='Web 网关未启动,请先连接 SSH'; }
</script>
</body></html>
"##;

/// 打开 SSH 网页访问的 webview 壳窗口(固定 webview,不用 Obscura)。
/// `session_id` 用于窗口 label 去重与壳页 key;`gateway_port` 为 SSH web 网关端口。
pub async fn open_web_shell_window(
    app: &AppHandle,
    session_id: &str,
    asset_name: &str,
    gateway_port: u16,
) -> Result<(), String> {
    let label = format!("web-shell-{session_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| format!("聚焦网页访问窗口失败:{e}"))?;
        return Ok(());
    }
    let url = format!(
        "starhub-web://localhost/{session_id}/index.html?port={gateway_port}"
    );
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("网页访问 URL 非法:{e}"))?;
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(format!("{asset_name} · 网页访问"))
        .inner_size(1200.0, 820.0)
        .build()
        .map_err(|e| format!("创建网页访问窗口失败:{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_key;

    #[test]
    fn valid_key_rejects_path_traversal_and_accepts_safe() {
        assert!(valid_key("abc-123"));
        assert!(valid_key("a:b"));
        assert!(!valid_key(".."));
        assert!(!valid_key("a/b"));
        assert!(!valid_key("a%2fb"));
        assert!(!valid_key(""));
        assert!(!valid_key("A")); // 大小写混合拒绝
    }
}

