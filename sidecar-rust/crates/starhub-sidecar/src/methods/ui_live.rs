//! UI 方法面 M3:直播/接管面板的通道管理(`ui.live_*`)+ 桥命令 `starhub/live.endpoint`。
//!
//! 分工:**帧与输入走 WS**(见 [`starhub_live::ws`] 的线上协议),这里只负责
//! 通道的开关与凭据:
//!
//! | 方法 | 用途 |
//! |---|---|
//! | `ui.live_open` | 开通道(Android:注册 + 起泵 + 尝试 scrcpy),返回端点 + 首个一次性令牌 |
//! | `ui.live_token` | 补发一次性令牌(bridge 每次代理新连接前调;面板重连/刷新用) |
//! | `ui.live_status` | 通道元数据 + 订阅者数 + 接管标志 |
//! | `ui.live_close` | 关通道(源回收:杀 scrcpy 子进程 + 解除 adb forward) |
//! | `ui.live_list` | 全部通道(诊断) |
//! | `starhub/live.endpoint` | 桥命令:WS 端点(端口),供 `registerUpgrade` 用 |
//!
//! 输入与接管**不**占方法面:它们在 WS 上,且必须经过「接管中」校验
//! (未接管时服务端直接回 `not in takeover`,与 Tauri 直播页的 423 同文案)。
//! 把它们也开成 `ui.*` 会多一条绕过面板的路径,没有收益。

use serde_json::{json, Value};
use starhub_live::hub::{ChannelInfo, ChannelMeta, KIND_ANDROID};

use crate::jsonrpc::RpcError;
use crate::live_runtime::LiveRuntime;

/// 取必填字符串参数(与 D 组其它方法同文案)。
fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("缺少 {key}")))
}

/// 通道摘要的线形状(camelCase,与工作台其它 UI 命令一致)。
fn channel_info_json(info: &ChannelInfo) -> Value {
    let meta: &ChannelMeta = &info.meta;
    json!({
        "channel": info.id,
        "kind": info.kind,
        "mode": meta.mode,
        "width": meta.width,
        "height": meta.height,
        "vw": meta.vw,
        "vh": meta.vh,
        "error": meta.error,
        "subscribers": info.subscribers,
        "takeover": info.takeover,
        "ringBytes": info.ring_bytes,
    })
}

/// `ui.live_open`:打开一台设备的直播通道。
///
/// M3 定稿只有 Android 一个帧源:browser 与沙箱桌面的直播/接管线**不做**——
/// 上游 dsh 原生提供 browser-use / computer-use 及其可见面,StarHub 重复造一份
/// 只会双轨维护。因此这里只接受 `kind: "android"`(缺省亦然),其它 kind 是明确
/// 的参数错误而不是静默降级。
pub async fn live_open(live: &LiveRuntime, params: &Value) -> Result<Value, RpcError> {
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or(KIND_ANDROID);
    if kind != KIND_ANDROID {
        return Err(RpcError::invalid_params(format!(
            "不支持的直播通道类型: {kind}(M3 定稿仅 android;browser 与沙箱桌面的直播/接管由 dsh 原生能力承接)"
        )));
    }
    let serial = required_str(params, "serial")?;
    let endpoint = live.endpoint().ok_or_else(|| {
        RpcError::internal("直播帧通道未启动(STARHUB_LIVE_DISABLED=1 或绑定失败)")
    })?;
    let channel = live
        .android()
        .open(&serial, (0, 0))
        .await
        .map_err(RpcError::internal)?;
    let token = live
        .hub()
        .issue_token(channel.id())
        .map_err(RpcError::internal)?;
    let info = live
        .hub()
        .list()
        .into_iter()
        .find(|info| info.id == channel.id())
        .ok_or_else(|| RpcError::internal("直播通道注册后未找到(帧枢纽状态异常)"))?;
    Ok(json!({
        "endpoint": endpoint,
        "token": token,
        "channel": channel_info_json(&info),
    }))
}

/// `ui.live_token`:补发一次性令牌(通道必须已打开)。
pub fn live_token(live: &LiveRuntime, params: &Value) -> Result<Value, RpcError> {
    let channel = required_str(params, "channel")?;
    if !starhub_live::hub::valid_channel_id(&channel) {
        return Err(RpcError::invalid_params(format!(
            "直播通道 id 非法: {channel:?}"
        )));
    }
    let token = live
        .hub()
        .issue_token(&channel)
        .map_err(RpcError::internal)?;
    let endpoint = live
        .endpoint()
        .ok_or_else(|| RpcError::internal("直播帧通道未启动"))?;
    Ok(json!({ "endpoint": endpoint, "token": token }))
}

/// `ui.live_status`:通道元数据 + 订阅者数 + 接管标志。
pub fn live_status(live: &LiveRuntime, params: &Value) -> Result<Value, RpcError> {
    let channel = required_str(params, "channel")?;
    let info = live
        .hub()
        .list()
        .into_iter()
        .find(|info| info.id == channel)
        .ok_or_else(|| RpcError::internal(format!("直播通道未打开: {channel}")))?;
    Ok(channel_info_json(&info))
}

/// `ui.live_close`:关通道(幂等;未知通道按已关返回)。
pub fn live_close(live: &LiveRuntime, params: &Value) -> Result<Value, RpcError> {
    let channel = required_str(params, "channel")?;
    let existed = live.hub().get(&channel).is_some();
    live.hub().close(&channel);
    Ok(json!({ "closed": true, "existed": existed }))
}

/// `ui.live_list`:全部通道(诊断 / 面板「正在直播」角标)。
pub fn live_list(live: &LiveRuntime, _params: &Value) -> Result<Value, RpcError> {
    let channels: Vec<Value> = live.hub().list().iter().map(channel_info_json).collect();
    Ok(json!({ "channels": channels, "endpoint": live.endpoint() }))
}

/// 桥命令 `starhub/live.endpoint`:WS 端点(bridge 的 `registerUpgrade` 用)。
///
/// 不是 UI 面方法:调用方是 bridge 插件自身,不是工作台。
pub fn live_endpoint(live: &LiveRuntime, _params: &Value) -> Result<Value, RpcError> {
    Ok(json!({
        "endpoint": live.endpoint(),
        "port": live.port(),
        "pathPrefix": starhub_live::ws::LIVE_PATH_PREFIX,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use starhub_live::FrameHub;
    use std::sync::Arc;

    /// 测试用运行时:不起 WS server,只验方法面的参数校验与状态转换。
    fn test_runtime() -> LiveRuntime {
        LiveRuntime::without_server(
            Arc::new(crate::desktop_runtime::FileSettingsStore::new(
                std::env::temp_dir().join(format!("starhub-ui-live-{}", std::process::id())),
            )),
            Arc::new(starhub_domain_android::AndroidManager::new()),
        )
    }

    #[test]
    fn live_token_and_status_require_a_channel() {
        let live = test_runtime();
        let err = live_token(&live, &json!({})).unwrap_err();
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("缺少 channel"), "{}", err.message);

        let err = live_token(&live, &json!({"channel":"evil"})).unwrap_err();
        assert!(err.message.contains("非法"), "{}", err.message);

        let err = live_status(&live, &json!({"channel":"android:missing"})).unwrap_err();
        assert!(err.message.contains("未打开"), "{}", err.message);
    }

    #[test]
    fn live_list_and_close_are_idempotent() {
        let live = test_runtime();
        let empty = live_list(&live, &Value::Null).unwrap();
        assert_eq!(empty["channels"], serde_json::json!([]));

        // 手工开一个通道再关(不经 Android 帧源,免 adb 依赖)
        let channel = live
            .hub()
            .open("android:serial-a", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        channel.set_takeover(true);
        let listed = live_list(&live, &Value::Null).unwrap();
        assert_eq!(listed["channels"][0]["takeover"], true);
        assert_eq!(listed["channels"][0]["mode"], "frames");

        let closed = live_close(&live, &json!({"channel":"android:serial-a"})).unwrap();
        assert_eq!(closed["existed"], true);
        let again = live_close(&live, &json!({"channel":"android:serial-a"})).unwrap();
        assert_eq!(again["existed"], false, "重复关幂等");
    }

    #[tokio::test]
    async fn live_open_rejects_unknown_kinds() {
        let live = test_runtime();
        // browser / desktop 帧源已去掉(dsh 原生承接):明确参数错误,不静默降级
        for kind in ["browser", "desktop"] {
            let err = live_open(&live, &json!({ "kind": kind, "serial": "x" }))
                .await
                .unwrap_err();
            assert!(
                err.message.contains("M3 定稿仅 android")
                    && err.message.contains("dsh 原生能力承接"),
                "{kind}: {}",
                err.message
            );
        }
        let err = live_open(&live, &json!({ "kind": "android" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, -32602, "android 需要 serial");
    }

    #[test]
    fn live_endpoint_reports_the_path_prefix() {
        let live = test_runtime();
        let endpoint = live_endpoint(&live, &Value::Null).unwrap();
        assert_eq!(endpoint["pathPrefix"], "/live/");
        assert_eq!(endpoint["port"], 0, "WS 关闭时端口为 0");
        assert_eq!(endpoint["endpoint"], Value::Null);
    }

    #[test]
    fn hub_is_shared_between_runtime_and_takeover_seam() {
        let live = test_runtime();
        live.hub()
            .open("android:serial-b", KIND_ANDROID, ChannelMeta::default())
            .unwrap();
        let takeover = live.takeover();
        assert!(!starhub_domain_android::TakeoverState::is_takeover(
            takeover.as_ref(),
            "serial-b"
        ));
        live.hub().set_takeover("android:serial-b", true);
        assert!(
            starhub_domain_android::TakeoverState::is_takeover(takeover.as_ref(), "serial-b"),
            "域名工具的 TakeoverState 读同一个帧枢纽"
        );
        let _ = FrameHub::new();
    }
}
