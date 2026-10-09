//! StarHub AI-browser domain (contract layer), extracted from the retired
//! Tauri shell.
//!
//! M1 只搬**模型面契约层**:
//! - [`action`]:16 个 `browser_*` 工具的模型参数 → 校验后的动作
//!   (参数错误是软错误文本,模型可纠正重试——这是契约,不许漂移);
//! - [`script`]:页面注入脚本与 URL 归一化(纯字符串构建)。
//!
//! **引擎层不搬**(去 Tauri 化 M3 定稿):browser 的直播/操作面板去掉,上游 dsh
//! 原生提供 browser-use 及其可见面。本 crate 因此停留在契约层——方法名与参数
//! 校验是模型面契约的一部分(见 `starhub_list_capabilities`),执行体由 sidecar
//! 的 `methods::browser` 答「归上游」提示。
//!
//! M2 追加 [`jev`]:Jev 决策的**非密配置**(结构体 / 缺省 / 校验 / settings 键)——
//! 设置页的读写是 UI 面,不依赖引擎层,先搬过来避免两侧各存一份键名。

pub mod action;
pub mod jev;
pub mod script;

pub use action::{parse_action, BrowserAction, BROWSER_TOOLS};
