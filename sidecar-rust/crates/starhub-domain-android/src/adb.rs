//! adb 调用层:二进制解析 + 命令执行(从 `src-tauri/src/android/mod.rs` 平移)。
//!
//! [`Adb`] 是注入点(路径由调用方显式传入——与 Tauri 版 `adb_raw(&manager,
//! &ctx.adb, …)` 同姿势):测试替身因此可以完全记录调用而不 spawn 真进程。

use crate::manager::AndroidManager;
use crate::{BoxFuture, SettingsStore};

/// adb 命令执行(注入点)。
pub trait Adb: Send + Sync {
    /// 执行一次 adb 命令,返回 (stdout 字节, stderr 文本, exit code)。
    fn raw<'a>(
        &'a self,
        adb: &'a str,
        serial: Option<&'a str>,
        args: &'a [String],
        timeout_secs: u64,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String, i32), String>>;

    /// adb shell 便利封装:返回 stdout 文本;非零退出带 stderr 报错。
    fn shell<'a>(
        &'a self,
        adb: &'a str,
        serial: &'a str,
        script: &'a str,
        timeout_secs: u64,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let (stdout, stderr, code) = self
                .raw(
                    adb,
                    Some(serial),
                    &["shell".to_string(), script.to_string()],
                    timeout_secs,
                )
                .await?;
            let text = String::from_utf8_lossy(&stdout).to_string();
            if code != 0 {
                return Err(format!("adb shell 失败(exit {code}): {}", stderr.trim()));
            }
            Ok(text)
        })
    }
}

/// 本机 adb 执行器(tokio spawn)。
pub struct LocalAdb;

impl LocalAdb {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalAdb {
    fn default() -> Self {
        Self::new()
    }
}

impl Adb for LocalAdb {
    fn raw<'a>(
        &'a self,
        adb: &'a str,
        serial: Option<&'a str>,
        args: &'a [String],
        timeout_secs: u64,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String, i32), String>> {
        Box::pin(async move {
            let mut cmd = tokio::process::Command::new(adb);
            if let Some(serial) = serial {
                cmd.arg("-s").arg(serial);
            }
            cmd.args(args);
            // tokio Command 自带 creation_flags 方法(无需 CommandExt import)。
            #[cfg(target_os = "windows")]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let result =
                tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output())
                    .await;
            let output = match result {
                Ok(Ok(output)) => output,
                Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(adb_missing_guidance());
                }
                Ok(Err(error)) => return Err(format!("adb 执行失败: {error}")),
                Err(_) => return Err(format!("adb 命令超时({timeout_secs}s)")),
            };
            Ok((
                output.stdout,
                String::from_utf8_lossy(&output.stderr).to_string(),
                output.status.code().unwrap_or(-1),
            ))
        })
    }
}

/// 平台常见 adb 安装位置。
pub fn common_adb_locations() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(
                std::path::Path::new(&local)
                    .join("Android")
                    .join("Sdk")
                    .join("platform-tools")
                    .join("adb.exe"),
            );
        }
        out.push(std::path::PathBuf::from(r"C:\platform-tools\adb.exe"));
        if !home.is_empty() {
            out.push(
                std::path::Path::new(&home)
                    .join("platform-tools")
                    .join("adb.exe"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    if !home.is_empty() {
        out.push(
            std::path::Path::new(&home)
                .join("Library")
                .join("Android")
                .join("sdk")
                .join("platform-tools")
                .join("adb"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if !home.is_empty() {
            out.push(
                std::path::Path::new(&home)
                    .join("Android")
                    .join("Sdk")
                    .join("platform-tools")
                    .join("adb"),
            );
        }
        out.push(std::path::PathBuf::from("/usr/bin/adb"));
    }
    out
}

/// PATH 查找(Windows `where`,Unix `which`);命中第一条。
pub async fn find_in_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    let (prog, args) = ("where", ["adb"].as_slice());
    #[cfg(not(target_os = "windows"))]
    let (prog, args) = ("which", ["adb"].as_slice());
    let output = tokio::process::Command::new(prog)
        .args(args)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// 「找不到 adb」的引导文案(三平台安装命令 + AI 代装提示)。
pub fn adb_missing_guidance() -> String {
    "未找到 adb 二进制。可按以下任一方式安装 Android platform-tools 后重试:\n\
     - Windows(管理员 PowerShell):winget install --id Google.PlatformTools -e\n\
     - macOS:brew install android-platform-tools\n\
     - Linux:sudo apt install adb(或发行版对应包名)\n\
     也可以让 AI 用本机工具(pwsh/bash)代为执行上述安装;已装在非标准位置时,\n\
     在 设置 → Android 设备 填写 adb 完整路径(或设置环境变量 STARHUB_ADB_PATH)。"
        .to_string()
}

/// 解析 adb 路径(带缓存;显式配置与常见位置做 exists 校验)。
///
/// 顺序(§3):设置 `android.adb_path` → `STARHUB_ADB_PATH` → PATH → 常见位置。
/// `settings` 由宿主注入(Tauri = settings 表,sidecar = 文件设置)。
pub async fn resolve_adb(
    manager: &AndroidManager,
    settings: &dyn SettingsStore,
) -> Result<String, String> {
    if let Some(cached) = manager.adb_path_cache().await {
        return Ok(cached);
    }
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(Some(value)) = settings.get(crate::manager::ADB_PATH_SETTING_KEY).await {
        if !value.trim().is_empty() {
            candidates.push(value.trim().to_string());
        }
    }
    if let Ok(env_path) = std::env::var(crate::manager::ADB_PATH_ENV_KEY) {
        if !env_path.trim().is_empty() {
            candidates.push(env_path.trim().to_string());
        }
    }
    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            manager.set_adb_path(candidate).await;
            return Ok(candidate.clone());
        }
    }
    if let Some(found) = find_in_path().await {
        manager.set_adb_path(&found).await;
        return Ok(found);
    }
    for location in common_adb_locations() {
        if location.exists() {
            let path = location.display().to_string();
            manager.set_adb_path(&path).await;
            return Ok(path);
        }
    }
    Err(adb_missing_guidance())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;

    struct NoSettings;

    impl SettingsStore for NoSettings {
        fn get<'a>(
            &'a self,
            _key: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Option<String>, String>> + Send + 'a>> {
            Box::pin(async move { Ok(None) })
        }
    }

    /// 记录调用的假 adb(不 spawn 真进程)。
    struct FakeAdb {
        calls: Mutex<Vec<(Option<String>, Vec<String>)>>,
        reply: (Vec<u8>, String, i32),
    }

    impl FakeAdb {
        fn new(reply: (Vec<u8>, String, i32)) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                reply,
            }
        }

        fn calls(&self) -> Vec<(Option<String>, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Adb for FakeAdb {
        fn raw<'a>(
            &'a self,
            _adb: &'a str,
            serial: Option<&'a str>,
            args: &'a [String],
            _timeout_secs: u64,
        ) -> BoxFuture<'a, Result<(Vec<u8>, String, i32), String>> {
            self.calls
                .lock()
                .unwrap()
                .push((serial.map(str::to_string), args.to_vec()));
            let reply = self.reply.clone();
            Box::pin(async move { Ok(reply) })
        }
    }

    #[tokio::test]
    async fn resolve_adb_caches_the_resolved_path() {
        let manager = AndroidManager::new();
        // 本机不一定有 adb;只验证「解析过一次即走缓存」的语义
        if let Ok(path) = resolve_adb(&manager, &NoSettings).await {
            assert_eq!(
                manager.adb_path_cache().await.as_deref(),
                Some(path.as_str())
            );
        }
    }

    #[tokio::test]
    async fn shell_wrapper_formats_the_command_and_errors() {
        let adb = FakeAdb::new((b"ok".to_vec(), String::new(), 0));
        let text = adb
            .shell("/usr/bin/adb", "serial-1", "wm size", 15)
            .await
            .expect("shell ok");
        assert_eq!(text, "ok");
        assert_eq!(
            adb.calls(),
            vec![(
                Some("serial-1".to_string()),
                vec!["shell".to_string(), "wm size".to_string()]
            )]
        );

        let failing = FakeAdb::new((Vec::new(), "device offline".to_string(), 1));
        let error = failing
            .shell("/usr/bin/adb", "serial-1", "wm size", 15)
            .await
            .expect_err("非零退出");
        assert!(error.contains("exit 1"), "{error}");
        assert!(error.contains("device offline"), "{error}");
    }

    #[test]
    fn missing_guidance_mentions_all_platforms() {
        let guidance = adb_missing_guidance();
        assert!(guidance.contains("winget"), "{guidance}");
        assert!(guidance.contains("brew"), "{guidance}");
        assert!(guidance.contains("apt"), "{guidance}");
        assert!(guidance.contains("STARHUB_ADB_PATH"), "{guidance}");
    }
}
