//! `browser_*` 方法面(M1 第 6 步第三域):16 个工具的方法名登记与**参数契约校验**。
//!
//! 引擎层(webview 窗口 / obscura CDP 无头引擎 / 截图 / Jev 决策 / auto 循环)
//! 是窗口面与宿主面,**M3 直播/操作面板化**时随帧出口一起落地(届时本模块
//! 增加 `BrowserEngine` seam,与 desktop/android 同姿势)。
//!
//! M1 先落地方法面本身:参数校验(软错误文案由 crate 的 `parse_action` 产出,
//! 与 Tauri 版逐字一致)+ 引擎未就绪的确定性提示。模型因此看到稳定的
//! 「方法存在、参数已校验、引擎待面板化」三段式,而不是 `-32601`。

use serde_json::{json, Value};

use starhub_domain_browser::parse_action;

use crate::jsonrpc::RpcError;

/// 引擎未就绪的提示(M3 落地前 AI 浏览器工具的统一应答)。
const ENGINE_PENDING: &str = "AI 浏览器引擎正在面板化迁移中(M3):方法面与参数校验已就绪,\
      引擎(无头 CDP / 截图 / 直播帧)将在直播与操作面板化 milestone 落地。\
      当前可用的等效能力:desktop_* 沙箱桌面(容器内浏览器)、android_* 真机浏览器。";

/// 16 个工具的公共入口:先过参数契约(软错误原样回给模型),再答引擎提示。
async fn browser_tool(name: &str, params: &Value) -> Result<Value, RpcError> {
    let args = params
        .get("args")
        .cloned()
        .unwrap_or_else(|| params.clone());
    // 参数校验失败 = 软错误:原样作文本返回(与 Tauri 版一致,模型可纠正重试)
    if let Err(message) = parse_action(name, &args) {
        return Ok(json!({ "text": message }));
    }
    Ok(json!({ "text": ENGINE_PENDING }))
}

pub async fn open_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_open", params).await
}
pub async fn navigate_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_navigate", params).await
}
pub async fn back_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_back", params).await
}
pub async fn forward_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_forward", params).await
}
pub async fn reload_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_reload", params).await
}
pub async fn state_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_state", params).await
}
pub async fn extract_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_extract", params).await
}
pub async fn click_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_click", params).await
}
pub async fn type_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_type", params).await
}
pub async fn press_key_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_press_key", params).await
}
pub async fn select_option_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_select_option", params).await
}
pub async fn scroll_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_scroll", params).await
}
pub async fn screenshot_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_screenshot", params).await
}
pub async fn eval_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_eval", params).await
}
pub async fn decide_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_decide", params).await
}
pub async fn auto_method(_runtime: &(), params: &Value) -> Result<Value, RpcError> {
    browser_tool("browser_auto", params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn valid_parameters_reach_the_engine_pending_notice() {
        let result = open_method(&(), &json!({ "url": "example.com" }))
            .await
            .unwrap();
        assert_eq!(result["text"], ENGINE_PENDING);
    }

    #[tokio::test]
    async fn invalid_parameters_come_back_as_soft_errors() {
        // 元素编号必须是纯数字
        let result = click_method(&(), &json!({ "id": "12a" })).await.unwrap();
        assert!(
            result["text"].as_str().unwrap().contains("纯数字"),
            "{result}"
        );
        // 必填参数缺失
        let result = navigate_method(&(), &json!({})).await.unwrap();
        assert!(
            result["text"].as_str().unwrap().contains("url 不能为空"),
            "{result}"
        );
        // 未知滚动方向
        let result = scroll_method(&(), &json!({ "direction": "sideways" }))
            .await
            .unwrap();
        assert!(
            result["text"].as_str().unwrap().contains("未知滚动方向"),
            "{result}"
        );
    }

    #[test]
    fn tool_inventory_matches_the_bridged_table() {
        assert_eq!(starhub_domain_browser::BROWSER_TOOLS.len(), 16);
    }
}
