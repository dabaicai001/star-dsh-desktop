//! 解析与白名单(纯函数,单测覆盖)——从 `src-tauri/src/android/mod.rs` 平移。
//!
//! 这一层是**注入防护的关键**:AI 传来的 serial / 包名 / 路径 / 键名 / 文本
//! 必须先过白名单或转义,才能进入 adb 命令行或设备 shell。

use serde_json::Value;

/// `adb devices -l` 的一台设备。
#[derive(Debug, Clone, PartialEq)]
pub struct AdbDevice {
    pub serial: String,
    /// device / unauthorized / offline 等。
    pub state: String,
    /// -l 附加信息里的 model(可能为空)。
    pub model: String,
}

/// 解析 `adb devices -l` 输出(跳过表头与空行)。
pub fn parse_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
                return None;
            }
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let model = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("model:").map(str::to_string))
                .unwrap_or_default();
            Some(AdbDevice {
                serial,
                state,
                model,
            })
        })
        .collect()
}

/// serial 白名单(防参数注入 adb 命令行)。
pub fn valid_serial(serial: &str) -> bool {
    !serial.is_empty()
        && serial.len() <= 64
        && serial
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

/// 包名白名单(com.example.app 形态)。
pub fn valid_package(pkg: &str) -> bool {
    !pkg.is_empty()
        && pkg.len() <= 128
        && pkg.contains('.')
        && pkg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

/// 主机名/IP 白名单(android_wireless)。
pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 128
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
}

/// 设备端可写目录白名单(android_push 落地根)。
pub fn valid_push_dir(dir: &str) -> bool {
    (dir.starts_with("/sdcard/")
        || dir == "/sdcard"
        || dir.starts_with("/storage/emulated/0")
        || dir.starts_with("/data/local/tmp"))
        && !dir.contains("..")
        && dir.len() <= 256
}

/// `wm size` 输出解析(有 Override 行时优先——它才是当前真实分辨率)。
pub fn parse_wm_size(output: &str) -> Option<(i64, i64)> {
    let mut physical: Option<(i64, i64)> = None;
    for line in output.lines() {
        let Some((_, size)) = line.split_once(':') else {
            continue;
        };
        let size = size.trim();
        let Some((w, h)) = size.split_once('x') else {
            continue;
        };
        let Ok(w) = w.parse::<i64>() else { continue };
        let Ok(h) = h.parse::<i64>() else { continue };
        if line.contains("Override") {
            return Some((w, h));
        }
        physical = physical.or(Some((w, h)));
    }
    physical
}

/// shell 单引号转义(与 desktop 模块同规则)。
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `input text` 转义:% 是 input 的格式符(%% 字面量、%s 空格),
/// 先转 input 层再 sh_quote 防 toybox sh 展开。
pub fn escape_input_text(text: &str) -> String {
    text.replace('%', "%%").replace(' ', "%s")
}

/// 是否纯 ASCII 可打印(input text 只认 ASCII;非 ASCII 走 ADBKeyBoard)。
pub fn is_ascii_input(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| (0x20..=0x7e).contains(&(c as u32)))
}

/// 键名白名单:AI 友好名 → KEYCODE_*;单字母/数字直映射;拒绝组合键。
pub fn map_keycode(key: &str) -> Result<String, String> {
    let lower = key.trim().to_ascii_lowercase();
    if lower.contains('+') {
        return Err(format!(
            "Android 不支持组合键: {key:?}(请拆成多次 android_press_key)"
        ));
    }
    let code = match lower.as_str() {
        "enter" | "return" => "KEYCODE_ENTER",
        "back" | "esc" | "escape" => "KEYCODE_BACK",
        "home" => "KEYCODE_HOME",
        "recents" | "recent" | "overview" | "app_switch" => "KEYCODE_APP_SWITCH",
        "backspace" | "delete" => "KEYCODE_DEL",
        "forwarddelete" | "forward_del" => "KEYCODE_FORWARD_DEL",
        "tab" => "KEYCODE_TAB",
        "space" | "空格" => "KEYCODE_SPACE",
        "up" | "arrowup" => "KEYCODE_DPAD_UP",
        "down" | "arrowdown" => "KEYCODE_DPAD_DOWN",
        "left" | "arrowleft" => "KEYCODE_DPAD_LEFT",
        "right" | "arrowright" => "KEYCODE_DPAD_RIGHT",
        "center" | "ok" => "KEYCODE_DPAD_CENTER",
        "pageup" => "KEYCODE_PAGE_UP",
        "pagedown" => "KEYCODE_PAGE_DOWN",
        "movehome" => "KEYCODE_MOVE_HOME",
        "moveend" => "KEYCODE_MOVE_END",
        "volumeup" => "KEYCODE_VOLUME_UP",
        "volumedown" => "KEYCODE_VOLUME_DOWN",
        "volumemute" | "mute" => "KEYCODE_VOLUME_MUTE",
        "power" => "KEYCODE_POWER",
        "wake" | "wakeup" => "KEYCODE_WAKEUP",
        "sleep" => "KEYCODE_SLEEP",
        "search" => "KEYCODE_SEARCH",
        "menu" => "KEYCODE_MENU",
        "camera" => "KEYCODE_CAMERA",
        other if other.len() == 1 && other.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) => {
            return Ok(format!("KEYCODE_{}", other.to_ascii_uppercase()));
        }
        other if other.len() == 1 && other.chars().next().is_some_and(|c| c.is_ascii_digit()) => {
            return Ok(format!("KEYCODE_{other}"));
        }
        other => {
            return Err(format!(
                "不支持的键名: {other:?}(back/home/recents/enter/tab/space/delete/方向键/音量/power 等)"
            ))
        }
    };
    Ok(code.to_string())
}

/// scroll 方向+像素量 → swipe 起止(以 (x,y) 为中心;方向指内容滚动方向,
/// 手指反向滑动)。端点裁剪进屏幕边界。
pub fn scroll_swipe(
    x: i64,
    y: i64,
    direction: &str,
    amount: i64,
    resolution: (i64, i64),
) -> Result<(i64, i64, i64, i64), String> {
    let half = (amount.max(60)) / 2;
    let (w, h) = resolution;
    let clamp = |v: i64, max: i64| v.clamp(0, (max - 1).max(0));
    let (dx, dy) = match direction {
        // 内容向下滚(看下方内容)= 手指上滑
        "down" => (0, -half),
        "up" => (0, half),
        "left" => (half, 0),
        "right" => (-half, 0),
        other => return Err(format!("不支持的滚动方向: {other:?}(up/down/left/right)")),
    };
    Ok((
        clamp(x - dx, w),
        clamp(y - dy, h),
        clamp(x + dx, w),
        clamp(y + dy, h),
    ))
}

/// uiautomator dump 的一个界面节点(坐标为设备物理像素,与 input tap 同坐标系)。
#[derive(Debug, Clone, PartialEq)]
pub struct UiNode {
    pub text: String,
    pub desc: String,
    pub resource_id: String,
    /// 短类名(android.widget.TextView → TextView)。
    pub class: String,
    pub clickable: bool,
    /// (left, top, right, bottom)。
    pub bounds: (i64, i64, i64, i64),
}

impl UiNode {
    /// 可点中心点(android_tap 直接可用的物理像素坐标)。
    pub fn center(&self) -> (i64, i64) {
        (
            (self.bounds.0 + self.bounds.2) / 2,
            (self.bounds.1 + self.bounds.3) / 2,
        )
    }
}

/// bounds="[l,t][r,b]" 解析。
pub fn parse_bounds(s: &str) -> Option<(i64, i64, i64, i64)> {
    // 形如 "[0,66][1200,220]"
    let (lt, rb) = s.strip_prefix('[')?.split_once("][")?;
    let (l, t) = lt.split_once(',')?;
    let (r, b) = rb.strip_suffix(']')?.split_once(',')?;
    Some((
        l.parse().ok()?,
        t.parse().ok()?,
        r.parse().ok()?,
        b.parse().ok()?,
    ))
}

/// XML 实体反转义(uiautomator 属性值里的 &amp;/&lt;/&gt;/&quot;/&#39; 等)。
pub fn xml_unescape(s: &str) -> String {
    let mut out = s.replace("&lt;", "<").replace("&gt;", ">");
    out = out.replace("&quot;", "\"").replace("&#39;", "'");
    // &amp; 必须最后处理(否则 &amp;lt; 会被二次反转义)
    out.replace("&amp;", "&")
}

/// 取 tag 片段里的属性值。属性值内的 `"`/`>` 已被 XML 转义,按引号配对取是安全的。
pub fn node_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let start = tag.find(&pat)? + pat.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

/// 解析 uiautomator dump XML,提取「可点击或有文字/desc」的节点(按文档序)。
pub fn parse_ui_nodes(xml: &str) -> Vec<UiNode> {
    let mut nodes = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<node ") {
        let after = &rest[start..];
        let Some(end) = after.find('>') else { break };
        let tag = &after[..end];
        let bounds = node_attr(tag, "bounds").and_then(parse_bounds);
        if let Some(bounds) = bounds {
            let text = node_attr(tag, "text").map(xml_unescape).unwrap_or_default();
            let desc = node_attr(tag, "content-desc")
                .map(xml_unescape)
                .unwrap_or_default();
            let clickable = node_attr(tag, "clickable") == Some("true");
            let zero_area = bounds.0 == bounds.2 || bounds.1 == bounds.3;
            if (clickable || !text.is_empty() || !desc.is_empty()) && !zero_area {
                let class = node_attr(tag, "class")
                    .map(|c| c.rsplit('.').next().unwrap_or(c).to_string())
                    .unwrap_or_default();
                nodes.push(UiNode {
                    text,
                    desc,
                    resource_id: node_attr(tag, "resource-id").unwrap_or("").to_string(),
                    class,
                    clickable,
                    bounds,
                });
            }
        }
        rest = &after[end + 1..];
    }
    nodes
}

/// PNG 完整性保障:旧版 adb(<1.0.41)Windows 上 exec-out 把每个 \n 改写为
/// \r\n(原有 \r\n 变 \r\r\n),PNG 流损坏。先验 8 字节完整 magic(自身即含
/// \r\n\x1a\n,恰好是探针),损坏则按「k 个 \r + \n → k-1 个 \r + \n」修复
/// (逆向 \n→\r\n 变换)重验;仍失败报升级指引(踩坑记录)。
pub fn ensure_png(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(MAGIC) {
        return Ok(bytes);
    }
    let mut repaired = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            let mut j = i;
            while j < bytes.len() && bytes[j] == b'\r' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\n' {
                // k 个 \r 后跟 \n:原始流是 k-1 个 \r + \n(mangling 把每个 \n
                // 变成 \r\n,原本 k-1 个 \r 原样保留)
                for _ in 0..(j - i - 1) {
                    repaired.push(b'\r');
                }
                repaired.push(b'\n');
                i = j + 1;
                continue;
            }
        }
        repaired.push(bytes[i]);
        i += 1;
    }
    if repaired.starts_with(MAGIC) {
        Ok(repaired)
    } else {
        Err(
            "截图数据损坏(当前 adb 版本 exec-out 二进制不安全),请升级 platform-tools 后重试"
                .to_string(),
        )
    }
}

/// PNG IHDR 解析宽高(8 字节签名 + 4 长度 + "IHDR" 后两个 BE u32)。
/// 截图真实像素 = 坐标契约的事实来源:不同机型/分辨率/横竖屏都以它为准,
/// 不信任 connect 时缓存的分辨率(wm size 可能被改、设备可能旋转)。
pub fn png_dimensions(bytes: &[u8]) -> Option<(i64, i64)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w as i64, h as i64))
}

pub fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

pub fn arg_num(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("缺少坐标参数 {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_devices_handles_models_and_states() {
        let out = "List of devices attached\n\
                   emulator-5554\tdevice product:sdk model:Pixel_7 device:panther\n\
                   9b241faz\tunauthorized\n\
                   \n\
                   * daemon started successfully\n";
        let devices = parse_devices(out);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "emulator-5554");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model, "Pixel_7");
        assert_eq!(devices[1].state, "unauthorized");
        assert_eq!(devices[1].model, "");
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn whitelists() {
        assert!(valid_serial("emulator-5554"));
        assert!(valid_serial("192.168.1.5:43217"));
        assert!(!valid_serial(""));
        assert!(!valid_serial("a b"));
        assert!(!valid_serial("$(reboot)"));
        assert!(valid_package("com.tencent.mm"));
        assert!(!valid_package("noDot"));
        assert!(!valid_package("com.evil;rm"));
        assert!(valid_host("192.168.1.5"));
        assert!(!valid_host("$(x)"));
        assert!(valid_push_dir("/sdcard/Download"));
        assert!(valid_push_dir("/data/local/tmp"));
        assert!(!valid_push_dir("/data/data/com.tencent.mm"));
        assert!(!valid_push_dir("/sdcard/../system"));
    }

    #[test]
    fn wm_size_prefers_override() {
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400"),
            Some((1080, 2400))
        );
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\nOverride size: 900x2000"),
            Some((900, 2000))
        );
        assert_eq!(parse_wm_size("garbage"), None);
    }

    #[test]
    fn input_text_escaping() {
        assert_eq!(escape_input_text("hello world"), "hello%sworld");
        assert_eq!(escape_input_text("100%"), "100%%");
        assert!(is_ascii_input("plain ASCII 123!"));
        assert!(!is_ascii_input("中文"));
        assert!(!is_ascii_input(""));
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn keycode_mapping() {
        assert_eq!(map_keycode("back").unwrap(), "KEYCODE_BACK");
        assert_eq!(map_keycode("Enter").unwrap(), "KEYCODE_ENTER");
        assert_eq!(map_keycode("ArrowUp").unwrap(), "KEYCODE_DPAD_UP");
        assert_eq!(map_keycode("a").unwrap(), "KEYCODE_A");
        assert_eq!(map_keycode("5").unwrap(), "KEYCODE_5");
        assert_eq!(map_keycode("recents").unwrap(), "KEYCODE_APP_SWITCH");
        assert!(map_keycode("ctrl+s").is_err());
        assert!(map_keycode("$(reboot)").is_err());
        assert!(map_keycode("F5").is_err());
    }

    #[test]
    fn scroll_maps_to_swipe_and_clamps() {
        // down(看下方内容)= 手指上滑:起点在下,终点在上
        let (x1, y1, x2, y2) = scroll_swipe(500, 1000, "down", 600, (1080, 2400)).unwrap();
        assert_eq!((x1, y1, x2, y2), (500, 1300, 500, 700));
        let (x1, y1, x2, y2) = scroll_swipe(500, 1000, "up", 600, (1080, 2400)).unwrap();
        assert_eq!((x1, y1, x2, y2), (500, 700, 500, 1300));
        // 边界裁剪:贴左缘左滚不出屏
        let (x1, _, x2, _) = scroll_swipe(10, 1000, "left", 600, (1080, 2400)).unwrap();
        assert!(x1 >= 0 && x2 < 1080);
        assert!(scroll_swipe(0, 0, "diagonal", 100, (1080, 2400)).is_err());
    }

    #[test]
    fn png_dimensions_reads_ihdr() {
        // 1200x2670(小米一类 20:9 机型)与 1080x2400 都必须直读 IHDR
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes()); // IHDR 数据长度
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&1200u32.to_be_bytes());
        png.extend_from_slice(&2670u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((1200, 2670)));
        png.truncate(16);
        png.extend_from_slice(&1080u32.to_be_bytes());
        png.extend_from_slice(&2400u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((1080, 2400)));
    }

    #[test]
    fn ui_tree_parses_nodes_and_filters_empty() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" bounds="[0,0][1080,2400]">
    <node index="1" text="登录" resource-id="com.tencent.mm:id/title" class="android.widget.TextView" content-desc="" clickable="false" bounds="[100,200][400,260]">
    </node>
    <node index="2" text="" resource-id="" class="android.widget.ImageView" content-desc="头像" clickable="true" bounds="[500,300][600,400]">
    </node>
    <node index="3" text="" resource-id="" class="android.widget.View" content-desc="" clickable="false" bounds="[0,0][0,0]">
    </node>
  </node>
</hierarchy>"#;
        let nodes = parse_ui_nodes(xml);
        assert_eq!(nodes.len(), 2, "零面积节点被过滤");
        assert_eq!(nodes[0].text, "登录");
        assert_eq!(nodes[0].center(), (250, 230));
        assert_eq!(nodes[0].resource_id, "com.tencent.mm:id/title");
        assert_eq!(nodes[1].desc, "头像");
        assert!(nodes[1].clickable);
        assert_eq!(nodes[1].class, "ImageView");
    }

    #[test]
    fn ui_tree_unescapes_entities() {
        let xml = r#"<node text="a &amp; b &lt;c&gt;" content-desc="" clickable="true" bounds="[0,0][10,10]"/>"#;
        let nodes = parse_ui_nodes(xml);
        assert_eq!(nodes[0].text, "a & b <c>");
    }

    #[test]
    fn arg_helpers_require_present_values() {
        assert_eq!(arg_str(&json!({ "serial": "s1" }), "serial").unwrap(), "s1");
        assert!(arg_str(&json!({ "serial": "" }), "serial").is_err());
        assert!(arg_str(&json!({}), "serial").is_err());
        assert_eq!(arg_num(&json!({ "x": 42 }), "x").unwrap(), 42);
        assert!(
            arg_num(&json!({ "x": "42" }), "x").is_err(),
            "字符串坐标不收"
        );
    }
}
