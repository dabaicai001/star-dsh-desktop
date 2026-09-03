//! CDP 按键表(Windows WebView2 与 Obscura 两引擎共用)。
//!
//! 常见按键 → `(windowsVirtualKeyCode, code)` 映射。CDP `Input.dispatchKeyEvent`
//! 在 Windows WebView2 与 Obscura 都要求这两个字段来产生可信按键;未知按键返回
//! None,由调用方回退 JS 注入路径(webview 后端)或 dispatchKeyEvent 原始 key
//! 直传(obscura 后端)。

/// 常见按键 → (虚拟键码, code)。
pub fn virtual_key(key: &str) -> Option<(i64, &'static str)> {
    let pair = match key {
        "Enter" => (13, "Enter"),
        "Tab" => (9, "Tab"),
        "Escape" => (27, "Escape"),
        "Backspace" => (8, "Backspace"),
        "Delete" => (46, "Delete"),
        "ArrowUp" => (38, "ArrowUp"),
        "ArrowDown" => (40, "ArrowDown"),
        "ArrowLeft" => (37, "ArrowLeft"),
        "ArrowRight" => (39, "ArrowRight"),
        "Home" => (36, "Home"),
        "End" => (35, "End"),
        "PageUp" => (33, "PageUp"),
        "PageDown" => (34, "PageDown"),
        " " => (32, "Space"),
        _ => return None,
    };
    Some(pair)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_common_keys() {
        for (key, vk) in [
            ("Enter", 13),
            ("Tab", 9),
            ("Escape", 27),
            ("Backspace", 8),
            ("ArrowDown", 40),
            (" ", 32),
        ] {
            let (code, _) = virtual_key(key).unwrap_or_else(|| panic!("缺按键 {key}"));
            assert_eq!(code, vk);
        }
        assert!(virtual_key("F12").is_none(), "未映射键走回退");
    }
}
