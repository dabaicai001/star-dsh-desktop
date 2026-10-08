//! 箱内操作的纯函数半场:键名映射 / 鼠标键 / 坐标 / shell 转义 / X11 前缀。
//!
//! 从 `src-tauri/src/desktop/mod.rs` 平移(零改动,单测随行)。这些函数是
//! xdotool/scrot 命令拼装的前半段——**注入防护的关键**:AI 传来的键名与
//! 文本必须先过白名单/转义才进 shell。

/// shell 单引号转义。
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// X11 环境前缀(Xvfb 固定在 :0)。
pub fn x11(script: &str) -> String {
    format!("export DISPLAY=:0; {script}")
}

/// 键名白名单映射:AI 友好名 → xdotool keysym;组合键按 + 拆分逐个校验。
pub fn map_key(key: &str) -> Result<String, String> {
    let parts: Vec<String> = key
        .split('+')
        .map(|part| {
            let lower = part.trim().to_ascii_lowercase();
            match lower.as_str() {
                "ctrl" | "control" => Ok("ctrl".to_string()),
                "shift" => Ok("shift".to_string()),
                "alt" => Ok("alt".to_string()),
                "super" | "win" | "meta" => Ok("super".to_string()),
                "enter" | "return" => Ok("Return".to_string()),
                "tab" => Ok("Tab".to_string()),
                "esc" | "escape" => Ok("Escape".to_string()),
                "space" | "空格" => Ok("space".to_string()),
                "backspace" => Ok("BackSpace".to_string()),
                "delete" => Ok("Delete".to_string()),
                "home" => Ok("Home".to_string()),
                "end" => Ok("End".to_string()),
                "pageup" => Ok("Page_Up".to_string()),
                "pagedown" => Ok("Page_Down".to_string()),
                "up" | "arrowup" => Ok("Up".to_string()),
                "down" | "arrowdown" => Ok("Down".to_string()),
                "left" | "arrowleft" => Ok("Left".to_string()),
                "right" | "arrowright" => Ok("Right".to_string()),
                other
                    if other.len() == 1
                        && other
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_alphanumeric()) =>
                {
                    Ok(other.to_string())
                }
                other
                    if other.starts_with('f')
                        && other[1..].chars().all(|c| c.is_ascii_digit())
                        && (1..=24).contains(&other[1..].parse::<u32>().unwrap_or(0)) =>
                {
                    Ok(other.to_uppercase())
                }
                other => Err(format!("不支持的键名: {other:?}")),
            }
        })
        .collect::<Result<_, _>>()?;
    Ok(parts.join("+"))
}

pub fn mouse_button(button: &str) -> Result<&'static str, String> {
    match button {
        "" | "left" => Ok("1"),
        "middle" => Ok("2"),
        "right" => Ok("3"),
        other => Err(format!("不支持的鼠标键: {other:?}(left/middle/right)")),
    }
}

pub fn coord(args: &serde_json::Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| format!("缺少坐标参数 {key}"))
}

pub fn arg_str<'a>(args: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("hello"), "'hello'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn map_key_accepts_common_and_combos() {
        assert_eq!(map_key("Enter").unwrap(), "Return");
        assert_eq!(map_key("ctrl+s").unwrap(), "ctrl+s");
        assert_eq!(map_key("Ctrl+Shift+S").unwrap(), "ctrl+shift+s");
        assert_eq!(map_key("ArrowUp").unwrap(), "Up");
        assert_eq!(map_key("F5").unwrap(), "F5");
        assert!(map_key("a;rm -rf /").is_err());
        assert!(map_key("$(reboot)").is_err());
    }

    #[test]
    fn mouse_button_mapping() {
        assert_eq!(mouse_button("").unwrap(), "1");
        assert_eq!(mouse_button("right").unwrap(), "3");
        assert!(mouse_button("x1").is_err());
    }

    #[test]
    fn coord_requires_numbers() {
        assert_eq!(coord(&json!({"x": 42}), "x").unwrap(), 42);
        assert!(coord(&json!({}), "x").is_err());
    }

    #[test]
    fn x11_prefixes_the_display() {
        assert_eq!(x11("wmctrl -l"), "export DISPLAY=:0; wmctrl -l");
    }
}
