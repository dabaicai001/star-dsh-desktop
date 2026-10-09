//! Jev 决策配置(设置 → AI 浏览器「Jev 决策」区;从 `src-tauri/src/browser/decide.rs`
//! 平移,去 Tauri 化 M2)。
//!
//! 只搬**非密配置部分**:结构体、缺省值、校验与 settings 键名。API key 单独走
//! 密钥存储(`set_ai_model_api_key({id:"jev"})`),Jev 决策的 HTTP 调用是引擎层,
//! 随 M3 面板化一起搬。
//!
//! 键名与缺省值与 Tauri 版**逐字一致**:同一份 `starhub-settings.json` 在两侧
//! 读到同一种配置;设置页的保存/回显语义因此不变。

use serde::{Deserialize, Serialize};

/// settings 键:Jev 决策启用开关。
pub const CONFIG_ENABLED: &str = "ai.jev.enabled";
/// settings 键:Jev 端点。
pub const CONFIG_BASE_URL: &str = "ai.jev.base_url";
/// settings 键:Jev 模型名。
pub const CONFIG_MODEL: &str = "ai.jev.model";
/// settings 键:置信度阈值。
pub const CONFIG_THRESHOLD: &str = "ai.jev.threshold";
/// settings 键:单次请求超时(毫秒)。
pub const CONFIG_TIMEOUT_MS: &str = "ai.jev.timeout_ms";
/// settings 键:`browser_auto` 单次循环步数上限。
pub const CONFIG_AUTO_MAX_STEPS: &str = "ai.jev.auto_max_steps";

/// Jev API key 在密钥存储里的 id(工作台 `set_ai_model_api_key({id:"jev"})`)。
pub const API_KEY_ID: &str = "jev";

/// 官方端点(缺省值:设置页加载即回显,用户启用后直接可用)。
pub const DEFAULT_BASE_URL: &str = "https://api.typesafe.ai";
/// 缺省模型名。
pub const DEFAULT_MODEL: &str = "jev-latest";
/// 缺省置信度阈值。
pub const DEFAULT_THRESHOLD: f64 = 0.60;
/// 缺省单次请求超时(毫秒)。
pub const DEFAULT_TIMEOUT_MS: u64 = 8_000;
/// 缺省自动执行步数上限。
pub const DEFAULT_AUTO_MAX_STEPS: u64 = 50;
/// 自动执行步数上限的合法区间。
pub const AUTO_MAX_STEPS_RANGE: std::ops::RangeInclusive<u64> = 1..=500;

/// 超时的合法区间(毫秒)。
pub const TIMEOUT_MS_RANGE: std::ops::RangeInclusive<u64> = 500..=60_000;

/// Jev 决策配置(非密部分;线形状 camelCase,与工作台 `JevConfig` 接口一致)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JevConfig {
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    /// 0.00–1.00;低于它的决策返回 `[LOWCONF]`。
    pub threshold: f64,
    /// 单次请求超时(毫秒)。
    pub timeout_ms: u64,
    /// `browser_auto` 单次循环步数上限(1–500;模型参数 `max_steps` 钳制到它)。
    pub auto_max_steps: u64,
}

impl Default for JevConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            threshold: DEFAULT_THRESHOLD,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            auto_max_steps: DEFAULT_AUTO_MAX_STEPS,
        }
    }
}

impl JevConfig {
    /// 设置页保存前的校验(软错误文本,前端原样展示;文案与 Tauri 版逐字一致)。
    pub fn validate(&self) -> Result<(), String> {
        if !(0.0..=1.0).contains(&self.threshold) {
            return Err(format!("阈值必须在 0.00–1.00 之间,收到 {}", self.threshold));
        }
        if !TIMEOUT_MS_RANGE.contains(&self.timeout_ms) {
            return Err(format!(
                "超时必须在 500–60000 毫秒之间,收到 {}",
                self.timeout_ms
            ));
        }
        if !AUTO_MAX_STEPS_RANGE.contains(&self.auto_max_steps) {
            return Err(format!(
                "单次自动执行步数上限必须在 1–500 之间,收到 {}",
                self.auto_max_steps
            ));
        }
        let url = self.base_url.trim();
        if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(format!("base_url 必须以 http:// 或 https:// 开头:{url}"));
        }
        if self.model.trim().is_empty() {
            return Err("模型名不能为空".to_string());
        }
        Ok(())
    }

    /// 从扁平 settings 读出配置(读不到的键用缺省值;数值越界时钳制,
    /// 与 Tauri 版 `jev_config` 同语义)。
    pub fn from_settings(settings: &serde_json::Map<String, serde_json::Value>) -> Self {
        let mut config = Self::default();
        let read = |key: &str| {
            settings
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        if let Some(value) = read(CONFIG_ENABLED) {
            config.enabled = value == "1";
        }
        if let Some(value) = read(CONFIG_BASE_URL) {
            config.base_url = value;
        }
        if let Some(value) = read(CONFIG_MODEL) {
            config.model = value;
        }
        if let Some(value) = read(CONFIG_THRESHOLD) {
            if let Ok(threshold) = value.parse::<f64>() {
                config.threshold = threshold.clamp(0.0, 1.0);
            }
        }
        if let Some(value) = read(CONFIG_TIMEOUT_MS) {
            if let Ok(ms) = value.parse::<u64>() {
                config.timeout_ms = ms.clamp(*TIMEOUT_MS_RANGE.start(), *TIMEOUT_MS_RANGE.end());
            }
        }
        if let Some(value) = read(CONFIG_AUTO_MAX_STEPS) {
            if let Ok(steps) = value.parse::<u64>() {
                config.auto_max_steps =
                    steps.clamp(*AUTO_MAX_STEPS_RANGE.start(), *AUTO_MAX_STEPS_RANGE.end());
            }
        }
        config
    }

    /// 写回扁平 settings(6 个键;调用方先过 [`Self::validate`])。
    pub fn to_settings(&self) -> Vec<(&'static str, String)> {
        vec![
            (
                CONFIG_ENABLED,
                if self.enabled { "1" } else { "0" }.to_string(),
            ),
            (CONFIG_BASE_URL, self.base_url.trim().to_string()),
            (CONFIG_MODEL, self.model.trim().to_string()),
            (CONFIG_THRESHOLD, self.threshold.to_string()),
            (CONFIG_TIMEOUT_MS, self.timeout_ms.to_string()),
            (CONFIG_AUTO_MAX_STEPS, self.auto_max_steps.to_string()),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_tauri_values() {
        let config = JevConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.base_url, DEFAULT_BASE_URL);
        assert_eq!(config.model, DEFAULT_MODEL);
        assert_eq!(config.threshold, DEFAULT_THRESHOLD);
        assert_eq!(config.timeout_ms, DEFAULT_TIMEOUT_MS);
        assert_eq!(config.auto_max_steps, DEFAULT_AUTO_MAX_STEPS);
    }

    #[test]
    fn wire_shape_is_camel_case() {
        let value = serde_json::to_value(JevConfig::default()).expect("serialize");
        for key in [
            "enabled",
            "baseUrl",
            "model",
            "threshold",
            "timeoutMs",
            "autoMaxSteps",
        ] {
            assert!(value.get(key).is_some(), "缺 {key}: {value}");
        }
    }

    #[test]
    fn validate_rejects_out_of_range_values_with_the_tauri_wording() {
        let over = |change: fn(&mut JevConfig)| {
            let mut config = JevConfig::default();
            change(&mut config);
            config.validate().unwrap_err()
        };
        assert_eq!(
            over(|config| config.threshold = 1.5),
            "阈值必须在 0.00–1.00 之间,收到 1.5"
        );
        assert_eq!(
            over(|config| config.timeout_ms = 100),
            "超时必须在 500–60000 毫秒之间,收到 100"
        );
        assert_eq!(
            over(|config| config.auto_max_steps = 0),
            "单次自动执行步数上限必须在 1–500 之间,收到 0"
        );
        assert_eq!(
            over(|config| config.base_url = "ftp://x".to_string()),
            "base_url 必须以 http:// 或 https:// 开头:ftp://x"
        );
        assert_eq!(
            over(|config| config.model = "  ".to_string()),
            "模型名不能为空"
        );
        // 合法值(含显式置空 base_url)
        let emptied = JevConfig {
            base_url: String::new(),
            ..JevConfig::default()
        };
        emptied.validate().expect("空 base_url 合法");
    }

    #[test]
    fn settings_roundtrip_and_clamping() {
        let config = JevConfig {
            enabled: true,
            base_url: "https://jev.internal".to_string(),
            model: "jev-2".to_string(),
            threshold: 0.75,
            timeout_ms: 9_000,
            auto_max_steps: 120,
        };
        let mut settings = serde_json::Map::new();
        for (key, value) in config.to_settings() {
            settings.insert(key.to_string(), serde_json::Value::String(value));
        }
        let read_back = JevConfig::from_settings(&settings);
        assert_eq!(read_back, config);

        // 写回时去首尾空白(与 Tauri 版 save_jev_config 的 trim 一致)
        let padded = JevConfig {
            base_url: "  https://jev.internal  ".to_string(),
            ..config.clone()
        };
        let written: std::collections::HashMap<&str, String> =
            padded.to_settings().into_iter().collect();
        assert_eq!(
            written.get(CONFIG_BASE_URL).map(String::as_str),
            Some("https://jev.internal")
        );

        // 越界数值读回时钳制(与 Tauri 版同语义)
        settings.insert(
            CONFIG_THRESHOLD.to_string(),
            serde_json::Value::String("9".to_string()),
        );
        settings.insert(
            CONFIG_AUTO_MAX_STEPS.to_string(),
            serde_json::Value::String("9999".to_string()),
        );
        let clamped = JevConfig::from_settings(&settings);
        assert_eq!(clamped.threshold, 1.0);
        assert_eq!(clamped.auto_max_steps, 500);
        // 空设置 = 全缺省
        assert_eq!(
            JevConfig::from_settings(&serde_json::Map::new()),
            JevConfig::default()
        );
    }
}
