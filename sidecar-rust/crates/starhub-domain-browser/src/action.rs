//! 16 个 `browser_*` 工具的模型参数 → 校验后的动作。
//!
//! 从 `src-tauri/src/browser/mod.rs::parse_action` 平移(零改动)。
//! 参数错误一律软错误文本(模型可纠正重试);`element_id` 沿用 extract 的
//! 纯数字编号语义——页面文本只能影响「选哪个编号」,不能创造新编号。

use serde_json::Value;

use crate::script::{normalize_url, DEFAULT_MAX_CHARS};

/// 本模块处理的 AI 工具清单(harness/tools.rs 分发用)。
pub const BROWSER_TOOLS: &[&str] = &[
    "browser_open",
    "browser_navigate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_state",
    "browser_extract",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_select_option",
    "browser_scroll",
    "browser_screenshot",
    "browser_eval",
    "browser_decide",
    "browser_auto",
];

/// 校验后的浏览器动作(引擎层消费)。
#[derive(Debug, Clone, PartialEq)]
pub enum BrowserAction {
    Open {
        url: Option<String>,
    },
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    State,
    Extract {
        max_chars: usize,
    },
    Click {
        id: String,
    },
    Type {
        id: String,
        text: String,
        clear: bool,
    },
    PressKey {
        key: String,
    },
    SelectOption {
        id: String,
        value: String,
    },
    Scroll {
        direction: String,
        amount: i64,
    },
    Screenshot,
    Eval {
        expression: String,
    },
    Decide {
        goal: String,
        snapshot: Option<String>,
    },
    Auto {
        goal: String,
        max_steps: usize,
        stop_on_lowconf: bool,
        input_text: Option<String>,
        snapshot: Option<String>,
    },
}

pub fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim)
}

pub fn required_str(args: &Value, key: &str) -> Result<String, String> {
    arg_str(args, key)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} 不能为空"))
}

/// 元素 id:extract 输出的编号(字符串数字)。
pub fn element_id(args: &Value) -> Result<String, String> {
    let id = required_str(args, "id")?;
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!(
            "id 必须是 browser_extract 输出里的元素编号(纯数字),收到「{id}」"
        ));
    }
    Ok(id)
}

/// `browser_auto` 的步数上限解析(钳制由设置层的 AUTO_MAX_STEPS_RANGE 负责;
/// 这里只取模型参数)。
pub fn parse_max_steps(args: &Value) -> usize {
    args.get("max_steps")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as usize)
        .unwrap_or(super::script::DEFAULT_AUTO_STEPS)
}

/// 工具名 + 模型参数 → 校验后的动作;Err 为软错误文本(模型可纠正重试)。
pub fn parse_action(name: &str, args: &Value) -> Result<BrowserAction, String> {
    match name {
        "browser_open" => {
            let url = arg_str(args, "url")
                .filter(|s| !s.is_empty())
                .map(normalize_url)
                .transpose()?;
            Ok(BrowserAction::Open { url })
        }
        "browser_navigate" => Ok(BrowserAction::Navigate {
            url: normalize_url(&required_str(args, "url")?)?,
        }),
        "browser_back" => Ok(BrowserAction::Back),
        "browser_forward" => Ok(BrowserAction::Forward),
        "browser_reload" => Ok(BrowserAction::Reload),
        "browser_state" => Ok(BrowserAction::State),
        "browser_extract" => {
            let max_chars = args
                .get("max_chars")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|n| n.floor() as usize)
                .unwrap_or(DEFAULT_MAX_CHARS);
            Ok(BrowserAction::Extract { max_chars })
        }
        "browser_click" => Ok(BrowserAction::Click {
            id: element_id(args)?,
        }),
        "browser_type" => Ok(BrowserAction::Type {
            id: element_id(args)?,
            text: required_str(args, "text")?,
            clear: args.get("clear").and_then(Value::as_bool).unwrap_or(false),
        }),
        "browser_press_key" => Ok(BrowserAction::PressKey {
            key: required_str(args, "key")?,
        }),
        "browser_select_option" => Ok(BrowserAction::SelectOption {
            id: element_id(args)?,
            value: required_str(args, "value")?,
        }),
        "browser_scroll" => {
            let direction = arg_str(args, "direction").unwrap_or("down").to_lowercase();
            if !["up", "down", "top", "bottom"].contains(&direction.as_str()) {
                return Err(format!(
                    "未知滚动方向「{direction}」,只支持 up/down/top/bottom"
                ));
            }
            let amount = args
                .get("amount")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|n| n.floor() as i64)
                .unwrap_or(600);
            Ok(BrowserAction::Scroll { direction, amount })
        }
        "browser_screenshot" => Ok(BrowserAction::Screenshot),
        "browser_eval" => Ok(BrowserAction::Eval {
            expression: required_str(args, "expression")?,
        }),
        "browser_decide" => {
            let goal = required_str(args, "goal")?;
            // snapshot 可缺省(Rust 内部补一次 Extract);显式传空串等同缺省。
            let snapshot = arg_str(args, "snapshot")
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty());
            Ok(BrowserAction::Decide { goal, snapshot })
        }
        "browser_auto" => {
            let goal = required_str(args, "goal")?;
            Ok(BrowserAction::Auto {
                goal,
                max_steps: parse_max_steps(args),
                stop_on_lowconf: args
                    .get("stop_on_lowconf")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                // input_text 可缺省(遇到 type 时交接回主模型);空串等同缺省。
                input_text: arg_str(args, "input_text")
                    .map(str::to_string)
                    .filter(|s| !s.is_empty()),
                snapshot: arg_str(args, "snapshot")
                    .map(str::to_string)
                    .filter(|s| !s.trim().is_empty()),
            })
        }
        other => Err(format!("unsupported browser tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_inventory_has_sixteen_entries() {
        assert_eq!(BROWSER_TOOLS.len(), 16);
        assert!(BROWSER_TOOLS.contains(&"browser_open"));
        assert!(BROWSER_TOOLS.contains(&"browser_auto"));
    }

    #[test]
    fn open_normalizes_and_allows_missing_url() {
        let bare = parse_action("browser_open", &json!({ "url": "example.com" })).unwrap();
        assert_eq!(
            bare,
            BrowserAction::Open {
                url: Some("https://example.com/".into())
            }
        );
        let none = parse_action("browser_open", &json!({})).unwrap();
        assert_eq!(none, BrowserAction::Open { url: None });
        let empty = parse_action("browser_open", &json!({ "url": "  " })).unwrap();
        assert_eq!(empty, BrowserAction::Open { url: None });
        let err = parse_action("browser_open", &json!({ "url": "not a url" })).unwrap_err();
        assert!(err.contains("URL"), "{err}");
    }

    #[test]
    fn navigate_requires_a_url() {
        let action =
            parse_action("browser_navigate", &json!({ "url": "example.com/docs" })).unwrap();
        assert_eq!(
            action,
            BrowserAction::Navigate {
                url: "https://example.com/docs".into()
            }
        );
        assert!(parse_action("browser_navigate", &json!({})).is_err());
    }

    #[test]
    fn simple_actions_need_no_arguments() {
        for name in [
            "browser_back",
            "browser_forward",
            "browser_reload",
            "browser_state",
            "browser_screenshot",
        ] {
            assert!(parse_action(name, &json!({})).is_ok(), "{name}");
        }
    }

    #[test]
    fn extract_defaults_and_overrides_max_chars() {
        let default = parse_action("browser_extract", &json!({})).unwrap();
        assert_eq!(
            default,
            BrowserAction::Extract {
                max_chars: DEFAULT_MAX_CHARS
            }
        );
        let custom = parse_action("browser_extract", &json!({ "max_chars": 12000 })).unwrap();
        assert_eq!(custom, BrowserAction::Extract { max_chars: 12000 });
        // 非法值回退默认(不报错)
        let bad = parse_action("browser_extract", &json!({ "max_chars": -5 })).unwrap();
        assert_eq!(
            bad,
            BrowserAction::Extract {
                max_chars: DEFAULT_MAX_CHARS
            }
        );
    }

    #[test]
    fn element_id_must_be_numeric() {
        let click = parse_action("browser_click", &json!({ "id": "12" })).unwrap();
        assert_eq!(click, BrowserAction::Click { id: "12".into() });
        let err = parse_action("browser_click", &json!({ "id": "12a" })).unwrap_err();
        assert!(err.contains("纯数字"), "{err}");
        assert!(parse_action("browser_click", &json!({})).is_err());
    }

    #[test]
    fn type_carries_the_clear_flag() {
        let action = parse_action(
            "browser_type",
            &json!({ "id": "3", "text": "hi", "clear": true }),
        )
        .unwrap();
        assert_eq!(
            action,
            BrowserAction::Type {
                id: "3".into(),
                text: "hi".into(),
                clear: true
            }
        );
        let no_clear = parse_action("browser_type", &json!({ "id": "3", "text": "hi" })).unwrap();
        assert!(!matches!(no_clear, BrowserAction::Type { clear: true, .. }));
    }

    #[test]
    fn scroll_validates_direction_and_amount() {
        let down = parse_action(
            "browser_scroll",
            &json!({ "direction": "down", "amount": 300 }),
        )
        .unwrap();
        assert_eq!(
            down,
            BrowserAction::Scroll {
                direction: "down".into(),
                amount: 300
            }
        );
        // 缺省 down / 600
        let default = parse_action("browser_scroll", &json!({})).unwrap();
        assert_eq!(
            default,
            BrowserAction::Scroll {
                direction: "down".into(),
                amount: 600
            }
        );
        // 大小写不敏感
        let upper = parse_action("browser_scroll", &json!({ "direction": "TOP" })).unwrap();
        assert_eq!(
            upper,
            BrowserAction::Scroll {
                direction: "top".into(),
                amount: 600
            }
        );
        let err = parse_action("browser_scroll", &json!({ "direction": "sideways" })).unwrap_err();
        assert!(err.contains("未知滚动方向"), "{err}");
    }

    #[test]
    fn eval_requires_an_expression() {
        let action = parse_action("browser_eval", &json!({ "expression": "1+1" })).unwrap();
        assert_eq!(
            action,
            BrowserAction::Eval {
                expression: "1+1".into()
            }
        );
        assert!(parse_action("browser_eval", &json!({})).is_err());
    }

    #[test]
    fn decide_and_auto_take_a_goal() {
        let decide = parse_action("browser_decide", &json!({ "goal": "登录" })).unwrap();
        assert_eq!(
            decide,
            BrowserAction::Decide {
                goal: "登录".into(),
                snapshot: None
            }
        );
        let with_snap = parse_action(
            "browser_decide",
            &json!({ "goal": "登录", "snapshot": "  " }),
        )
        .unwrap();
        assert_eq!(
            with_snap,
            BrowserAction::Decide {
                goal: "登录".into(),
                snapshot: None
            }
        );

        let auto = parse_action(
            "browser_auto",
            &json!({ "goal": "下单", "max_steps": 12, "stop_on_lowconf": false, "input_text": "" }),
        )
        .unwrap();
        match auto {
            BrowserAction::Auto {
                goal,
                max_steps,
                stop_on_lowconf,
                input_text,
                snapshot,
            } => {
                assert_eq!(goal, "下单");
                assert_eq!(max_steps, 12);
                assert!(!stop_on_lowconf);
                assert_eq!(input_text, None, "空串等同缺省");
                assert_eq!(snapshot, None);
            }
            other => panic!("expected Auto, got {other:?}"),
        }
        // 缺省步数
        let default_steps = parse_action("browser_auto", &json!({ "goal": "x" })).unwrap();
        assert!(matches!(default_steps, BrowserAction::Auto { max_steps, .. } if max_steps > 0));
        assert!(parse_action("browser_auto", &json!({})).is_err());
    }

    #[test]
    fn unknown_tool_is_a_soft_error() {
        let err = parse_action("browser_teleport", &json!({})).unwrap_err();
        assert_eq!(err, "unsupported browser tool: browser_teleport");
    }
}
