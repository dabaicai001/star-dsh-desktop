//! `obscura-live://localhost/<page_key>/<resource>` custom protocol 处理器。
//!
//! 在 webview 线程同步执行,只读写共享状态(帧由 pump 预捕获,输入经 mpsc 转交
//! pump)。查看器页面轮询 `meta` 拿 seq/viewport,`seq` 变化再拉 `frame.jpg`。

use std::borrow::Cow;
use tauri::{AppHandle, Manager};

use super::{LiveCmd, ObscuraManager};

/// 构造 HTTP 响应。
fn http_response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Cow::Owned(body))
        .expect("构建直播响应失败")
}

fn json_response(status: u16, body: String) -> tauri::http::Response<Cow<'static, [u8]>> {
    http_response(status, "application/json", body.into_bytes())
}

/// 校验 page_key(只允许小写字母/数字/冒号/连字符,防路径穿越)。
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-')
}

/// `obscura-live://localhost/<page_key>/<resource>` 处理器。
pub fn live_protocol_handler(
    app: &AppHandle,
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
    let inner = app.state::<ObscuraManager>().inner.clone();
    match (request.method().as_str(), resource) {
        ("GET", "index.html") | ("GET", "") => {
            let page = live_page(key);
            http_response(200, "text/html; charset=utf-8", page.into_bytes())
        }
        ("GET", "meta") => {
            let pages = inner.pages.lock().expect("pages");
            let state = match pages.get(key) {
                Some(s) => s,
                None => return json_response(404, "{\"error\":\"no page\"}".to_string()),
            };
            let (w, h) = *state.viewport.lock().expect("viewport");
            let body = serde_json::json!({
                "url": state.url,
                "title": state.title,
                "seq": state.seq,
                "width": w,
                "height": h,
            });
            json_response(200, body.to_string())
        }
        ("GET", "frame.jpg") => {
            let pages = inner.pages.lock().expect("pages");
            match pages.get(key) {
                Some(state) => {
                    let frame = state.frame.lock().expect("frame");
                    if frame.is_empty() {
                        http_response(204, "image/jpeg", Vec::new())
                    } else {
                        http_response(200, "image/jpeg", frame.clone())
                    }
                }
                None => http_response(204, "image/jpeg", Vec::new()),
            }
        }
        ("POST", "input") => {
            let cmd = parse_input(key, request.body());
            match cmd {
                Some(cmd) => {
                    let ok = inner
                        .cmds
                        .lock()
                        .expect("cmds")
                        .as_ref()
                        .map(|tx| tx.send(cmd).is_ok())
                        .unwrap_or(false);
                    json_response(if ok { 202 } else { 409 }, format!("{{\"ok\":{ok}}}"))
                }
                None => json_response(400, "{\"ok\":false}".to_string()),
            }
        }
        _ => http_response(404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}

/// 解析查看器 POST 的输入事件 → LiveCmd。
fn parse_input(key: &str, body: &[u8]) -> Option<LiveCmd> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let num = |k: &str| v.get(k).and_then(serde_json::Value::as_f64);
    match v.get("type").and_then(serde_json::Value::as_str) {
        Some("navigate") => v
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(|u| LiveCmd::Navigate { key: key.to_string(), url: u.to_string() }),
        Some("back") => Some(LiveCmd::Back { key: key.to_string() }),
        Some("forward") => Some(LiveCmd::Forward { key: key.to_string() }),
        Some("reload") => Some(LiveCmd::Reload { key: key.to_string() }),
        Some("click") => Some(LiveCmd::Click { key: key.to_string(), x: num("x")?, y: num("y")? }),
        Some("dblclick") => Some(LiveCmd::DblClick { key: key.to_string(), x: num("x")?, y: num("y")? }),
        Some("key") => Some(LiveCmd::Key {
            key: key.to_string(),
            kbd: v.get("key").and_then(serde_json::Value::as_str)?.to_string(),
            text: v.get("text").and_then(serde_json::Value::as_str).map(|s| s.to_string()),
        }),
        Some("scroll") => Some(LiveCmd::Scroll {
            key: key.to_string(),
            direction: v.get("direction").and_then(serde_json::Value::as_str).unwrap_or("down").to_string(),
            amount: v.get("amount").and_then(serde_json::Value::as_i64).unwrap_or(600),
        }),
        _ => None,
    }
}

/// 生成查看器页面(把 key 占位符替换成实际 page_key)。
fn live_page(key: &str) -> String {
    LIVE_PAGE.replace("__PAGE_KEY__", key)
}

/// 查看器页面(内联 HTML/JS,无外部资源)。
const LIVE_PAGE: &str = r##"
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 *{box-sizing:border-box}
 html,body{height:100%;margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#1e1f24;color:#e6e6e6}
 #bar{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid #333;background:#24262b}
 #bar button{height:28px;min-width:28px;border:1px solid #4a4d55;background:#33363c;color:#e6e6e6;border-radius:5px;cursor:pointer;font-size:14px}
 #bar button:hover{background:#40434b}
 #addr{flex:1;height:28px;padding:0 10px;border:1px solid #4a4d55;border-radius:5px;background:#1a1b1f;color:#e6e6e6;outline:none}
 #stage{position:relative;height:calc(100% - 45px);overflow:hidden;background:#111}
 #stage canvas{display:block;width:100%;height:100%;object-fit:contain}
 #status{position:absolute;left:8px;top:8px;padding:3px 8px;background:rgba(0,0,0,.55);border-radius:4px;font-size:12px;color:#9fb;pointer-events:none}
</style></head>
<body>
<div id="bar">
  <button id="back" title="后退">←</button>
  <button id="fwd" title="前进">→</button>
  <button id="reload" title="刷新">⟳</button>
  <input id="addr" placeholder="输入完整网址后按 Enter 访问" aria-label="地址栏">
</div>
<div id="stage"><canvas id="cv"></canvas><div id="status">连接 Obscura…</div></div>
<script>
var key='__PAGE_KEY__';
var stage=document.getElementById('stage'),cv=document.getElementById('cv'),ctx=cv.getContext('2d');
var bar=document.getElementById('bar'),addr=document.getElementById('addr'),statusEl=document.getElementById('status');
var lastSeq=0,intW=1280,intH=800;
function base(){return 'obscura-live://localhost/'+key;}
async function post(obj){try{await fetch(base()+'/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)});}catch(e){}}
function draw(dataUrl){
  var img=new Image();
  img.onload=function(){
    cv.width=img.naturalWidth;cv.height=img.naturalHeight;
    ctx.drawImage(img,0,0);
    intW=img.naturalWidth;intH=img.naturalHeight;
  };
  img.src=dataUrl;
}
// 计算图片在 canvas 内 object-fit:contain 后实际渲染的窗口矩形(相对 stage 的 CSS 像素),
// 由此把屏幕坐标映射回页面坐标(避免信箱效应错位)。
function contentRect(){
  var r=cv.getBoundingClientRect();
  var a=intW/intH, b=r.width/r.height, w,h;
  if(a>b){w=r.width;h=r.width/a;} else {h=r.height;w=r.height*a;}
  return {left:r.left+(r.width-w)/2, top:r.top+(r.height-h)/2, w:w, h:h};
}
function posOf(e){
  var c=contentRect();
  return {x:(e.clientX-c.left)*(intW/c.w), y:(e.clientY-c.top)*(intH/c.h)};
}
async function poll(){
  try{
    var m=await (await fetch(base()+'/meta')).json();
    if(m.width&&m.height){intW=m.width;intH=m.height;}
    if(m.seq!==lastSeq){
      lastSeq=m.seq;
      var f=await fetch(base()+'/frame.jpg?seq='+m.seq);
      if(f.ok){var blob=await f.blob();var url=URL.createObjectURL(blob);draw(url);setTimeout(function(){URL.revokeObjectURL(url);},200);}
    }
    statusEl.textContent=(m.title||'')+' · '+m.url;
  }catch(e){setTimeout(poll,800);return;}
  setTimeout(poll,220);
}
poll();
addr.addEventListener('keydown',function(e){if(e.key==='Enter'&&addr.value.trim()){post({type:'navigate',url:addr.value.trim()});}});
document.getElementById('back').onclick=function(){post({type:'back'});};
document.getElementById('fwd').onclick=function(){post({type:'forward'});};
document.getElementById('reload').onclick=function(){post({type:'reload'});};
cv.addEventListener('click',function(e){var p=posOf(e);post({type:'click',x:p.x,y:p.y});});
cv.addEventListener('dblclick',function(e){var p=posOf(e);post({type:'dblclick',x:p.x,y:p.y});});
window.addEventListener('keydown',function(e){
  var map={Enter:'Enter',Tab:'Tab',Escape:'Escape',Backspace:'Backspace',Delete:'Delete',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Home:'Home',End:'End',PageUp:'PageUp',PageDown:'PageDown',' ':' '};
  var k=map[e.key]||e.key;
  if(addr===document.activeElement) return;
  if(e.key.length===1){post({type:'key',key:k,text:e.key});}
  else{post({type:'key',key:k});}
});
cv.addEventListener('wheel',function(e){e.preventDefault();post({type:'scroll',direction:e.deltaY>0?'down':'up',amount:Math.round(Math.abs(e.deltaY)*3)});},{passive:false});
</script>
</body></html>
"##;
