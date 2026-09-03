//! Obscura 引擎进程编排:定位二进制、spawn。

use std::path::PathBuf;
use tauri::Manager;

/// 定位 obscura 可执行文件。镜像 starhub-sidecar 的解析逻辑(生产/开发双路径,
/// 见 sidecar/mod.rs),结果稳定可复现。
pub fn binary_path(app: &tauri::AppHandle) -> PathBuf {
    let obscura_name = if cfg!(windows) { "obscura.exe" } else { "obscura" };
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .or_else(|| app.path().resource_dir().ok());

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = &exe_dir {
        // 打包路径:exe 旁、exe/sidecar 下(externalBin 常见落点)。
        candidates.push(dir.join(&obscura_name));
        candidates.push(dir.join("sidecar").join(&obscura_name));
        // 开发路径:上溯 sidecar/bin、vendor 目标目录。
        if let Some(d) = dir.parent() {
            candidates.push(d.join("sidecar").join("bin").join(&obscura_name));
            candidates.push(d.join("vendor").join("obscura").join("target").join("release").join(&obscura_name));
        }
        if let Some(d) = dir.parent().and_then(|p| p.parent()) {
            candidates.push(d.join("sidecar").join("bin").join(&obscura_name));
        }
        if let Some(d) = dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            candidates.push(d.join("sidecar").join("bin").join(&obscura_name));
        }
    }
    // 用户级 target(build-obscura.bat 固定到 USERPROFILE 盘,绕开 symlink 权限)。
    if let Ok(home) = std::env::var("USERPROFILE") {
        candidates.push(
            PathBuf::from(&home)
                .join(".starhub")
                .join("obscura-target")
                .join("release")
                .join(&obscura_name),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| {
            tracing::warn!("obscura 可执行文件未找到:{obscura_name}");
            PathBuf::from(obscura_name)
        })
}

/// spawn `obscura serve`。`--allow-private-network` 必须:本工具浏览内网/localhost
/// (SSH 网关、本地开发服务器),obscura 默认拦私网(SSRF 防护)。
/// 返回 child 供管理器持有。
pub fn spawn_engine(binary: &PathBuf, port: u16) -> Result<tokio::process::Child, String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--allow-private-network")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("启动 obscura 进程失败({}):{e}", binary.display()))
}
