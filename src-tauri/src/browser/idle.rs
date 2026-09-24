//! AI 浏览器空闲自动关闭(webview 引擎的无痕窗口)。
//!
//! AI 用完浏览器后窗口原本会一直挂着,直到用户手动关闭或主窗口退出联动
//! 销毁。本模块的看门狗每隔 [`IDLE_POLL`] 检查一次:窗口存在、没有任何
//! 在途 `browser_*` 调用与在途 eval、且距最后一次调用已空闲
//! [`IDLE_CLOSE_SECS`] 秒时,关闭窗口(Destroyed 事件里在途 eval 会失败
//! 收口;下一次 `browser_open`/`browser_navigate` 会重建窗口,页面状态不保留)。
//!
//! 范围:仅 webview 引擎——`ai-browser` 窗口只由 webview 后端创建;obscura
//! 无头引擎是「进程 + 页面会话 + 直播查看器窗口」另一套生命周期,不在本模块
//! 管辖内。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::{BrowserManager, BROWSER_WINDOW_LABEL};

/// 空闲多久没有新的 browser_* 调用后自动关闭窗口。
pub const IDLE_CLOSE_SECS: u64 = 60;

/// 看门狗轮询间隔。
const IDLE_POLL: Duration = Duration::from_secs(5);

/// 纯判定:此刻是否应该空闲关窗。独立成函数便于单测覆盖边界。
///
/// - `window_open`:ai-browser 窗口存在(obscura 引擎下恒为 false)。
/// - `in_flight` / `pending`:在途 browser_* 调用数 / 在途 eval 请求数,
///   任一非零都说明调用尚未结束,不能关。
/// - `idle`:距最后一次 browser_* 调用的时长(从未调用过为 None → 不关)。
pub fn should_idle_close(
    window_open: bool,
    in_flight: usize,
    pending: usize,
    idle: Option<Duration>,
) -> bool {
    window_open
        && in_flight == 0
        && pending == 0
        && idle.is_some_and(|elapsed| elapsed >= Duration::from_secs(IDLE_CLOSE_SECS))
}

/// 启动空闲看门狗(应用启动时调用一次;内部永循环,不返回)。
pub fn spawn_idle_watchdog(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL).await;
            let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) else {
                continue; // 窗口没开(未用过/已关/obscura 引擎):无事可做
            };
            let manager = app.state::<BrowserManager>();
            if !should_idle_close(
                true,
                manager.in_flight(),
                manager.pending_count(),
                manager.idle_for(),
            ) {
                continue;
            }
            match window.close() {
                Ok(()) => tracing::info!(
                    "AI 浏览器空闲 {IDLE_CLOSE_SECS}s 无新调用,已自动关闭窗口(下一次 browser_open 重建)"
                ),
                Err(e) => tracing::debug!("AI 浏览器空闲自动关闭失败:{e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOSE_AFTER: Duration = Duration::from_secs(IDLE_CLOSE_SECS);

    #[test]
    fn closes_only_when_window_open_idle_long_enough_and_quiet() {
        let idle = Some(CLOSE_AFTER);
        assert!(should_idle_close(true, 0, 0, idle));
        // 差 1ms 不关(阈值含等于)。
        assert!(!should_idle_close(true, 0, 0, Some(CLOSE_AFTER - Duration::from_millis(1))));
        // 窗口没开 → 无从关起。
        assert!(!should_idle_close(false, 0, 0, idle));
        // 在途调用 / 在途 eval → 不动。
        assert!(!should_idle_close(true, 1, 0, idle));
        assert!(!should_idle_close(true, 0, 1, idle));
        assert!(!should_idle_close(true, 2, 3, idle));
        // 从未调用过 → 不关(没有可参照的活动时刻)。
        assert!(!should_idle_close(true, 0, 0, None));
        // 远超阈值 → 关。
        assert!(should_idle_close(true, 0, 0, Some(CLOSE_AFTER * 10)));
    }

    #[tokio::test]
    async fn manager_tracks_activity_and_in_flight_calls() {
        let manager = BrowserManager::new();
        assert_eq!(manager.in_flight(), 0);
        assert!(manager.idle_for().is_none(), "未调用过没有活动时刻");

        {
            let _call = manager.begin_call();
            assert_eq!(manager.in_flight(), 1);
            let _call2 = manager.begin_call();
            assert_eq!(manager.in_flight(), 2);
            assert!(manager.idle_for().is_some(), "调用进入即刷新活动时刻");
        }
        // 两个守卫都 drop 后计数归零(含提前返回/panic 展开路径)。
        assert_eq!(manager.in_flight(), 0);
    }
}
