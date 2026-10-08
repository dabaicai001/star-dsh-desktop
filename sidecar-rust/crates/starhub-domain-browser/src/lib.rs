//! StarHub AI-browser domain (contract layer), extracted from the retired
//! Tauri shell.
//!
//! M1 只搬**模型面契约层**:
//! - [`action`]:16 个 `browser_*` 工具的模型参数 → 校验后的动作
//!   (参数错误是软错误文本,模型可纠正重试——这是契约,不许漂移);
//! - [`script`]:页面注入脚本与 URL 归一化(纯字符串构建)。
//!
//! 引擎层(webview 窗口 / obscura CDP 无头引擎 / 截图 / Jev 决策 / auto 循环)
//! 仍是**窗口面与宿主面**:M3 直播/操作面板化时随帧出口一起搬,届时本 crate
//! 增加 `BrowserEngine` seam(与 desktop/android 同姿势)。

pub mod action;
pub mod script;

pub use action::{parse_action, BrowserAction, BROWSER_TOOLS};
