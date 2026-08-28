//! dsh 用户插件管理命令(支线 B):列表 / 本地导入 / URL 安装 / 启停 / 卸载 / 市场目录。
//!
//! 启停与卸载只改 plugins/cordis.yml 与 registry,运行中的 runtime 不热生效;
//! 前端在每次变更后调 `dsh_shutdown`,下一轮对话 initialize 时自动带新配置重启。

use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::harness::plugins::{self, PluginPaths};
use crate::harness::HarnessPaths;

fn plugin_paths(app: &AppHandle) -> Result<PluginPaths, String> {
    PluginPaths::resolve(app).map_err(|e| e.to_string())
}

/// 安装/启停/卸载需要 runtime 根建立 peer junction 与解析依赖。用
/// `resolve_for_app`(打包布局感知):dev 为 vendor 仓库根,prod 为
/// resource_dir()/dsh-runtime 闭包;plugins.rs 内部按布局分别定位
/// peer/依赖包(vendor/<pkg> 或 node_modules/@deepseek-ai/<pkg>)。
fn vendor_root(app: &AppHandle) -> Result<PathBuf, String> {
    HarnessPaths::resolve_for_app(app)
        .map(|paths| paths.runtime_dir)
        .map_err(|e| format!("无法定位 dsh runtime 目录: {e}"))
}

/// 已安装插件列表(registry 事实源,附 missing 标记表示目录已被外部删除;
/// 首次调用会幂等注册内置插件 client-nav/host-static/tool-context/tools)。
#[tauri::command]
pub async fn dsh_plugin_list(app: AppHandle) -> Result<Value, String> {
    let paths = plugin_paths(&app)?;
    let vendor = vendor_root(&app)?;
    plugins::ensure_builtin_plugins(&paths, &vendor).map_err(|e| e.to_string())?;
    plugins::list_plugins(&paths).map_err(|e| e.to_string())
}

/// 本地导入:path 可以是插件目录或 .zip 文件。
#[tauri::command]
pub async fn dsh_plugin_install_local(app: AppHandle, path: String) -> Result<Value, String> {
    let paths = plugin_paths(&app)?;
    let vendor = vendor_root(&app)?;
    let src = PathBuf::from(&path);
    let record = if src.is_dir() {
        plugins::install_local_dir(&paths, &src, &vendor)
    } else {
        plugins::install_local_zip(&paths, &src, &vendor)
    }
    .map_err(|e| e.to_string())?;
    serde_json::to_value(record).map_err(|e| e.to_string())
}

/// URL 安装:GitHub 仓库地址(可带 /tree/<branch>)或 zip 直链。
#[tauri::command]
pub async fn dsh_plugin_install_url(app: AppHandle, url: String) -> Result<Value, String> {
    let paths = plugin_paths(&app)?;
    let vendor = vendor_root(&app)?;
    let record = plugins::install_from_url(&paths, &url, &vendor)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(record).map_err(|e| e.to_string())
}

/// 逐项启停(重写 plugins/cordis.yml;需重启 runtime 生效)。
#[tauri::command]
pub async fn dsh_plugin_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    plugins::set_enabled(&plugin_paths(&app)?, &id, enabled).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/// 卸载(移除目录与 registry 记录;需重启 runtime 生效)。
#[tauri::command]
pub async fn dsh_plugin_uninstall(app: AppHandle, id: String) -> Result<Value, String> {
    plugins::uninstall(&plugin_paths(&app)?, &id).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/// 插件市场目录:force_refresh=true 强制重抓;抓取失败降级为缓存(标 stale)
/// 或空目录,不报错。
#[tauri::command]
pub async fn dsh_plugin_market_fetch(app: AppHandle, force_refresh: bool) -> Result<Value, String> {
    let catalog = plugins::fetch_market(&plugin_paths(&app)?, force_refresh).await;
    serde_json::to_value(catalog).map_err(|e| e.to_string())
}
