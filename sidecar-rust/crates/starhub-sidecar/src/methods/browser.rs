//! `browser_*` 方法面(M1 第 6 步第三域):16 个工具的方法名登记与**参数契约校验**。
//!
//! **引擎不落地**(去 Tauri 化 M3 定稿):browser 的直播/操作面板去掉,上游 dsh
//! 原生提供 browser-use 及其可见面,StarHub 的 `browser_*` 工具面与之重复。因此
//! 本模块只保留方法名与参数契约(软错误文案由 crate 的 `parse_action` 产出,与
//! Tauri 版逐字一致),执行体答一条确定性的「请用 dsh 原生 browser 能力」提示——
//! 模型看到稳定的三段式(方法存在 / 参数已校验 / 引擎归上游),而不是 `-32601`。
//!
//! 方法面暂不删除:它写在模型面的能力文本契约里(`starhub_list_capabilities`),
//! 删方法名是一次面向模型的破坏性变更,要连带改契约文本与快照,单独一个提交做。

use serde_json::{json, Value};

use starhub_domain_browser::parse_action;

use crate::jsonrpc::RpcError;

/// 引擎归上游的提示(M3 定稿后 AI 浏览器工具的统一应答)。
const ENGINE_PENDING: &str = "AI 浏览器已不由 StarHub 提供:上游 dsh 原生提供 browser-use 
       及其可见面(去 Tauri 化 M3 定稿),请改用 dsh 的浏览器能力。
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
