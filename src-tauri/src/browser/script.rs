//! AI 浏览器页面侧注入脚本(M1 兜底通道 / M3 感知增强)。
//!
//! 两个出口:
//! - [`HELPERS_JS`]:幂等定义 `window.__shb`(DOM 序列化 + 交互原语,含 Shadow
//!   DOM / 同源 iframe 递归)与 `window.__shbEval`(结果经 `browser_internal_result`
//!   命令回传 Rust 的 oneshot 桥);
//! - [`wrap_eval`]:把一次求值包装成「注入助手 + 执行 + 回传」的完整脚本,
//!   供 `webview.eval()` 使用(wry 的 eval 无返回值,结果只能走 IPC)。
//!
//! 页面 CSP 不影响本通道:`webview.eval()` 走的是引擎自身的脚本执行接口
//! (WebView2 ExecuteScript / WKWebView evaluateJavaScript / WebKitGTK
//! evaluate_javascript),不是往页面里插 <script> 标签。

/// extract 默认正文文本上限(字符)。
pub const DEFAULT_MAX_CHARS: usize = 6000;

/// 页面助手脚本(幂等:重复注入直接返回)。只做定义,不执行任何动作。
pub const HELPERS_JS: &str = r##"
;(function () {
  if (!window.__shbReport) {
    window.__shbReport = function (id, ok, payload) {
      try {
        var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
        if (inv) inv('browser_internal_result', { id: String(id), ok: !!ok, payload: payload == null ? null : String(payload) });
      } catch (e) { /* 导航后旧上下文 IPC 已失效,静默丢弃迟到的应答 */ }
    };
    window.__shbEval = function (id, fn) {
      var ok = function (v) {
        var s;
        try { s = JSON.stringify(v === undefined ? null : v); } catch (e) { s = '"[unserializable]"'; }
        window.__shbReport(id, true, s);
      };
      var bad = function (e) { window.__shbReport(id, false, String((e && e.stack) || e)); };
      try {
        var r = fn();
        if (r && typeof r.then === 'function') { r.then(ok, bad); } else { ok(r); }
      } catch (e) { bad(e); }
    };
  }
  if (window.__shb) return;
  var ATTR = 'data-sh-bid';
  var els = {};
  var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,'
    + '[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],'
    + '[role=menuitem],[role=switch],[role=textbox],[role=combobox],[role=option],'
    + '[contenteditable=true],[contenteditable=""],[onclick],[tabindex]:not([tabindex="-1"])';
  var KEYCODES = {
    Enter: { code: 'Enter', keyCode: 13 }, Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 }, Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 }, ' ': { code: 'Space', keyCode: 32 }
  };
  function trim(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  function visible(el, win) {
    if (!el || el.nodeType !== 1) return false;
    var style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    var rects = el.getClientRects();
    if (rects.length === 0) return false;
    var r = rects[0];
    return r.width > 0 && r.height > 0;
  }
  function labelOf(el) {
    var tag = el.tagName.toLowerCase();
    var text = el.getAttribute('aria-label') || (el.innerText || el.textContent || '') || el.getAttribute('title') || '';
    if (tag === 'input' || tag === 'textarea') {
      text = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.value || text;
    }
    if (tag === 'img') text = el.getAttribute('alt') || text;
    return trim(text, 80);
  }
  function describe(el, id, frame) {
    var tag = el.tagName.toLowerCase();
    var parts = [(frame || '') + '[' + id + '] <' + tag + '>'];
    var label = labelOf(el);
    if (label) parts.push('"' + label + '"');
    var type = el.getAttribute('type'); if (type) parts.push('type=' + type);
    var name = el.getAttribute('name'); if (name) parts.push('name=' + trim(name, 40));
    var href = el.getAttribute('href'); if (href) parts.push('href=' + trim(href, 120));
    var role = el.getAttribute('role'); if (role) parts.push('role=' + role);
    var ph = el.getAttribute('placeholder'); if (ph && tag !== 'input' && tag !== 'textarea') parts.push('placeholder=' + trim(ph, 40));
    if (el.disabled) parts.push('disabled');
    if (el.getAttribute('aria-checked')) parts.push('checked=' + el.getAttribute('aria-checked'));
    return parts.join(' ');
  }
  // 递归收集:主文档 + open Shadow Root + 同源 iframe(深度 ≤3,跨域记一行标记)。
  function collect(doc, win, frame, depth, out) {
    if (out.length >= 300) return;
    var nodes = doc.querySelectorAll(SEL);
    for (var i = 0; i < nodes.length && out.length < 300; i++) {
      var el = nodes[i];
      if (!visible(el, win)) continue;
      var id = String(out.length + 1);
      el.setAttribute(ATTR, id);
      els[id] = el;
      out.push(describe(el, id, frame));
    }
    if (depth < 3) {
      var all = doc.querySelectorAll('*');
      for (var j = 0; j < all.length && j < 5000 && out.length < 300; j++) {
        var host = all[j];
        if (host.shadowRoot) {
          var shadowNodes = host.shadowRoot.querySelectorAll(SEL);
          for (var k = 0; k < shadowNodes.length && out.length < 300; k++) {
            var sel = shadowNodes[k];
            if (!visible(sel, win)) continue;
            var sid = String(out.length + 1);
            sel.setAttribute(ATTR, sid);
            els[sid] = sel;
            out.push(describe(sel, sid, frame + '[shadow] '));
          }
        }
      }
      var frames = doc.querySelectorAll('iframe,frame');
      for (var f = 0; f < frames.length && out.length < 300; f++) {
        try {
          var fdoc = frames[f].contentDocument;
          if (fdoc) collect(fdoc, frames[f].contentWindow, frame + '[frame' + f + '] ', depth + 1, out);
          else out.push(frame + '[frame' + f + '] (跨域 iframe,内容不可访问)');
        } catch (e) {
          out.push(frame + '[frame' + f + '] (跨域 iframe,内容不可访问)');
        }
      }
    }
  }
  function byId(id) {
    var el = els[String(id)];
    if (el && el.isConnected) return el;
    // 兜底:extract 之后页面局部重渲染可能换了节点,按属性再查一遍
    var again = document.querySelector('[' + ATTR + '="' + String(id) + '"]');
    if (again && again.isConnected) { els[String(id)] = again; return again; }
    return null;
  }
  function fireKey(target, type, key) {
    var k = KEYCODES[key] || { code: key.length === 1 ? 'Key' + key.toUpperCase() : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    target.dispatchEvent(new KeyboardEvent(type, {
      key: key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
      bubbles: true, cancelable: true
    }));
  }
  window.__shb = {
    state: function () {
      return JSON.stringify({ url: location.href, title: document.title, readyState: document.readyState, scrollY: Math.round(window.scrollY) });
    },
    extract: function (maxChars) {
      els = {};
      var old = document.querySelectorAll('[' + ATTR + ']');
      for (var t = 0; t < old.length; t++) old[t].removeAttribute(ATTR);
      var out = [];
      collect(document, window, '', 0, out);
      var cap = (typeof maxChars === 'number' && maxChars > 0) ? Math.min(maxChars, 20000) : 6000;
      var body = document.body ? trim(document.body.innerText || '', cap) : '';
      var header = 'url: ' + location.href + '\ntitle: ' + document.title + '\n'
        + '可交互元素 ' + out.length + ' 个(编号即 click/type 的 id;页面变化后需重新 extract):\n';
      return header + out.join('\n') + '\n--- 页面正文(截取 ' + body.length + '/' + cap + ' 字符)---\n' + body;
    },
    rectOf: function (id) {
      var el = byId(id);
      if (!el) return '';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
    },
    click: function (id) {
      var el = byId(id);
      if (!el) return '[Error] 元素 ' + id + ' 不存在或已失效,请重新 browser_extract';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus(); } catch (e) {}
      ['pointerover', 'mouseover', 'mousedown', 'mouseup'].forEach(function (type) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      el.click();
      return '[ok] 已点击 ' + describe(el, id, '');
    },
    typeText: function (id, text, clear) {
      var el = byId(id);
      if (!el) return '[Error] 元素 ' + id + ' 不存在或已失效,请重新 browser_extract';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      text = String(text == null ? '' : text);
      if (el.isContentEditable) {
        if (clear) el.innerText = '';
        el.innerText = (clear ? '' : el.innerText) + text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return '[ok] 已向 ' + describe(el, id, '') + ' 输入 ' + text.length + ' 字符(contenteditable)';
      }
      var tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return '[Error] 元素 ' + id + ' 不是输入框(tag=' + tag + ')';
      var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      var next = (clear ? '' : el.value) + text;
      setter.call(el, next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return '[ok] 已向 ' + describe(el, id, '') + ' 输入 ' + text.length + ' 字符';
    },
    focusEl: function (id, clear) {
      var el = byId(id);
      if (!el) return '[Error] 元素 ' + id + ' 不存在或已失效,请重新 browser_extract';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (clear && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (clear && el.isContentEditable) el.innerText = '';
      return '[ok] 已聚焦 ' + describe(el, id, '');
    },
    selectOption: function (id, value) {
      var el = byId(id);
      if (!el) return '[Error] 元素 ' + id + ' 不存在或已失效,请重新 browser_extract';
      if (el.tagName.toLowerCase() !== 'select') return '[Error] 元素 ' + id + ' 不是 <select>';
      var target = String(value);
      var hit = null;
      for (var i = 0; i < el.options.length; i++) {
        var opt = el.options[i];
        if (opt.value === target || trim(opt.text, 200) === target) { hit = opt; break; }
      }
      if (!hit) {
        var vals = [];
        for (var j = 0; j < el.options.length && j < 20; j++) vals.push(el.options[j].value || trim(el.options[j].text, 40));
        return '[Error] 没有匹配「' + target + '」的选项;可选值:' + vals.join(', ');
      }
      el.value = hit.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return '[ok] 已选择 ' + hit.value + ' (' + trim(hit.text, 60) + ')';
    },
    scrollPage: function (direction, amount) {
      var px = (typeof amount === 'number' && amount > 0) ? amount : 600;
      var d = String(direction || 'down').toLowerCase();
      if (d === 'up') window.scrollBy(0, -px);
      else if (d === 'down') window.scrollBy(0, px);
      else if (d === 'top') window.scrollTo(0, 0);
      else if (d === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else return '[Error] 未知方向「' + direction + '」,只支持 up/down/top/bottom';
      return '[ok] scrollY=' + Math.round(window.scrollY) + ' / ' + document.documentElement.scrollHeight;
    },
    pressKey: function (key) {
      key = String(key || '');
      if (!key) return '[Error] key 不能为空';
      var target = document.activeElement || document.body;
      fireKey(target, 'keydown', key);
      fireKey(target, 'keypress', key);
      fireKey(target, 'keyup', key);
      return '[ok] 已按键 ' + key + '(目标:<' + (target.tagName || '?').toLowerCase() + '>)';
    }
  };
})();
"##;

/// 把一段 JS 函数体包装成完整注入脚本:先幂等注入助手,再经 `__shbEval`
/// 执行并用 `browser_internal_result` 回传 JSON 结果。
///
/// `body` 是函数体文本:内部调用一律带 `return …`;`browser_eval` 工具的
/// 用户脚本同样按函数体处理(文档约定末尾 `return` 取结果)。
pub fn wrap_eval(id: &str, body: &str) -> String {
    let id_json = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_string());
    format!("{HELPERS_JS}\nwindow.__shbEval({id_json}, function() {{\n{body}\n}});")
}

/// URL 规范化与校验:只允许 http/https/about:blank;裸主机名补 https://。
/// 拒绝 javascript:/file:/data: 等伪协议——AI 浏览器绝不执行导航型脚本注入。
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("url 不能为空".to_string());
    }
    let candidate = if trimmed.contains("://") || trimmed.starts_with("about:") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed =
        tauri::Url::parse(&candidate).map_err(|e| format!("url 无法解析「{trimmed}」:{e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        "about" if parsed.path() == "blank" => Ok("about:blank".to_string()),
        scheme => Err(format!(
            "不允许的 URL 协议「{scheme}」,AI 浏览器只支持 http/https"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_eval_embeds_id_helpers_and_body() {
        let script = wrap_eval("req-1", "return window.__shb.state();");
        assert!(script.contains(HELPERS_JS), "必须先注入助手");
        assert!(script.contains("window.__shbEval(\"req-1\", function()"));
        assert!(script.contains("return window.__shb.state();"));
        assert!(script.contains("browser_internal_result"), "助手里必须含回传命令名");
    }

    #[test]
    fn helpers_are_idempotent_and_cover_shadow_dom_and_iframes() {
        assert!(HELPERS_JS.contains("if (window.__shb) return;"), "幂等守卫");
        assert!(HELPERS_JS.contains("shadowRoot"), "Shadow DOM 递归");
        assert!(HELPERS_JS.contains("contentDocument"), "同源 iframe 递归");
        assert!(HELPERS_JS.contains("data-sh-bid"), "元素编号属性");
        assert!(HELPERS_JS.contains("跨域 iframe"), "跨域降级标记");
    }

    #[test]
    fn normalize_url_accepts_http_https_and_bare_hosts() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com/");
        assert_eq!(
            normalize_url("http://127.0.0.1:8080/__proxy__/x").unwrap(),
            "http://127.0.0.1:8080/__proxy__/x"
        );
        assert_eq!(normalize_url(" about:blank ").unwrap(), "about:blank");
    }

    #[test]
    fn normalize_url_rejects_script_and_local_schemes() {
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "",
            "   ",
        ] {
            assert!(normalize_url(bad).is_err(), "应拒绝:{bad}");
        }
    }
}
