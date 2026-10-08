//! Go sidecar 客户端(Tauri 侧适配层,去 Tauri 化 M1)。
//!
//! 客户端逻辑已平移到 `starhub-domain-db::go_sidecar`(唯一事实源);本模块
//! 只做两件 Tauri 专属的事:
//! 1. 以 `SidecarManager` 之名再导出 crate 的 `GoSidecar`,`app.state::<SidecarManager>()`
//!    与既有调用路径零改动;
//! 2. 启动入口不再需要 `tauri::AppHandle`(进程生命周期由 manager 自负)。
//!
//! M1 架构里 Rust sidecar 才是 Go sidecar 的父进程;Tauri 壳这条路径在 M4
//! 退役 src-tauri 时一并消失。

pub use starhub_domain_db::go_sidecar::GoSidecar as SidecarManager;
