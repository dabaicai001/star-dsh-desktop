//! 文件设置存储(`starhub-settings.json`,一个扁平的 key→value 对象)。
//!
//! 设置文件与域无关,是宿主的共享存储——Android 域(adb 路径)、UI 面(浏览器
//! 引擎 / Jev 配置)与直播泵读写的都是同一份。实现无内存缓存(每次读全部 /
//! 写穿透),多实例共存安全。

use std::path::PathBuf;

/// 文件设置存储(`STARHUB_SETTINGS_FILE`,缺省 `<cwd>/starhub-settings.json`)。
pub struct FileSettingsStore {
    path: PathBuf,
}

impl FileSettingsStore {
    /// 按环境变量解析路径:`STARHUB_SETTINGS_FILE`,缺省 `<cwd>/starhub-settings.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_SETTINGS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-settings.json"));
        Self { path }
    }

    /// 用指定路径构造(测试 / 装配点用)。
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 读全部设置(扁平 key→value 对象;文件不存在 = 空)。
    pub fn read_all(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|e| format!("设置文件解析失败({}): {e}", self.path.display()))
                .map(|value| value.as_object().cloned().unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(error) => Err(format!(
                "设置文件读取失败({}): {error}",
                self.path.display()
            )),
        }
    }

    /// 写一个设置(UI 面:adb 路径 / 浏览器引擎 / Jev 配置等)。
    ///
    /// 域工具只需要读,写穿透只由 UI 面使用,因此不在任何域 trait 上。
    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut settings = self.read_all()?;
        settings.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
        self.persist(&settings)
    }

    /// 删一个设置(空值即清除,回落默认行为)。
    pub fn remove(&self, key: &str) -> Result<(), String> {
        let mut settings = self.read_all()?;
        settings.remove(key);
        self.persist(&settings)
    }

    /// 整体落盘(内部用)。
    fn persist(&self, settings: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("设置目录创建失败({}): {error}", parent.display()))?;
            }
        }
        let text = serde_json::to_string_pretty(settings)
            .map_err(|error| format!("设置文件序列化失败: {error}"))?;
        std::fs::write(&self.path, text)
            .map_err(|error| format!("设置文件写入失败({}): {error}", self.path.display()))
    }
}
