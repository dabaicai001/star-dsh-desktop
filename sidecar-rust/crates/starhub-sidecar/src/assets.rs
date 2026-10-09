//! 资产存储:sidecar 侧的「assets 表 + Keyring」替代品(去 Tauri 化 M1)。
//!
//! 设计 §六数据迁移:Tauri SQLite 的资产注册表 → sidecar 自有存储(本模块的
//! JSON 文件),系统 Keyring → dsh credentials 服务(随 R7 一次性导入落地)。
//! 因此这里把「非敏感配置」与「敏感字段」的读写各自 seam 化:
//!
//! - [`AssetStore`] 读 `assets.json`(部署变化项,路径经 bridge Config 注入,
//!   环境变量 `STARHUB_ASSETS_FILE` 可覆盖);
//! - [`SecretStore`] 是密钥 seam:M1 提供内存实现(测试)与文件实现
//!   (开发/诊断用),原生 Keyring 实现随 §六 credentials 迁移补齐——
//!   双跑期(Tauri 壳仍是生产资产源)刻意不碰系统密钥环。
//!
//! `split_config` / `merge_config` 与 `SECRET_FIELDS` 和
//! `src-tauri/src/keyring/mod.rs` 逐字一致:同一份资产存档在两侧必须解析出
//! 同一份合并配置,否则迁移后模型会拿到缺字段的连接参数。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use starhub_domain_ssh::asset_config::ssh_config_from_asset;

/// 资产配置里的敏感字段(落敏感存储,绝不出现在 assets.json 明文里)。
/// 与 `src-tauri/src/keyring/mod.rs::SECRET_FIELDS` 保持一致。
pub const SECRET_FIELDS: &[&str] = &[
    "password",
    "privateKey",
    "passphrase",
    "jumpPassword",
    "jumpPrivateKey",
    "jumpPassphrase",
    "mfaPassword",
    "apiKey",
];

/// 从配置里拆出敏感字段(与 keyring::split_config 同语义:空值/空串不入密钥存储)。
pub fn split_config(mut config: Value) -> (Value, Value) {
    let mut secrets = serde_json::Map::new();
    if let Some(object) = config.as_object_mut() {
        for field in SECRET_FIELDS {
            if let Some(value) = object.remove(*field) {
                if !value.is_null() && value.as_str().is_none_or(|text| !text.is_empty()) {
                    secrets.insert((*field).to_string(), value);
                }
            }
        }
    }
    (config, Value::Object(secrets))
}

/// 把密钥合并回配置(与 keyring::merge_config 同语义:密钥覆盖配置同名字段)。
pub fn merge_config(mut config: Value, secrets: Value) -> Value {
    if let (Some(config), Some(secrets)) = (config.as_object_mut(), secrets.as_object()) {
        config.extend(secrets.clone());
    }
    config
}

/// 密钥存储 seam(原生 Keyring / 文件 / 内存)。
///
/// 同步 API:sidecar 的 stdio 循环本就在专用线程上 `block_on` 逐个处理请求,
/// 密钥读写(毫秒级)直接执行即可;Tauri 侧的 `spawn_blocking` 包装留在宿主。
pub trait SecretStore: Send + Sync {
    /// 读取密钥;不存在时返回 Err(与 `keyring::load` 的 "no entry found" 一致)。
    fn load(&self, key_id: &str) -> Result<Value, String>;
    /// 写入密钥(insert-or-replace)。
    fn store(&self, key_id: &str, secrets: &Value) -> Result<(), String>;
    /// 删除密钥;不存在时视为成功(幂等)。
    fn delete(&self, key_id: &str) -> Result<(), String>;
}

/// 测试用内存密钥存储。
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<String, Value>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn load(&self, key_id: &str) -> Result<Value, String> {
        self.entries
            .lock()
            .unwrap()
            .get(key_id)
            .cloned()
            .ok_or_else(|| "Failed to load asset credentials: no entry found".to_string())
    }

    fn store(&self, key_id: &str, secrets: &Value) -> Result<(), String> {
        self.entries
            .lock()
            .unwrap()
            .insert(key_id.to_string(), secrets.clone());
        Ok(())
    }

    fn delete(&self, key_id: &str) -> Result<(), String> {
        self.entries.lock().unwrap().remove(key_id);
        Ok(())
    }
}

/// 文件密钥存储(开发/诊断):一个 JSON 对象文件 `{ "<keyId>": {…secrets} }`。
///
/// **不是安全边界**:明文落盘,仅用于无系统 Keyring 的环境(CI / 容器)与
/// 人工核对;生产路径随 §六 credentials 迁移换成 dsh credentials 服务。
pub struct FileSecretStore {
    path: PathBuf,
}

impl FileSecretStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn read_all(&self) -> Result<HashMap<String, Value>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("密钥文件解析失败({}): {e}", self.path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(error) => Err(format!(
                "密钥文件读取失败({}): {error}",
                self.path.display()
            )),
        }
    }

    fn write_all(&self, entries: &HashMap<String, Value>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("密钥目录创建失败({}): {e}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(entries)
            .map_err(|e| format!("密钥文件序列化失败: {e}"))?;
        std::fs::write(&self.path, text)
            .map_err(|e| format!("密钥文件写入失败({}): {e}", self.path.display()))
    }
}

impl SecretStore for FileSecretStore {
    fn load(&self, key_id: &str) -> Result<Value, String> {
        self.read_all()?
            .remove(key_id)
            .ok_or_else(|| "Failed to load asset credentials: no entry found".to_string())
    }

    fn store(&self, key_id: &str, secrets: &Value) -> Result<(), String> {
        let mut entries = self.read_all()?;
        entries.insert(key_id.to_string(), secrets.clone());
        self.write_all(&entries)
    }

    fn delete(&self, key_id: &str) -> Result<(), String> {
        let mut entries = self.read_all()?;
        entries.remove(key_id);
        self.write_all(&entries)
    }
}

/// 从 JSON 值里取字符串数组(非数组/非字符串元素忽略)。
fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 秒级 unix 时间戳(写入侧时间戳用)。
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// assets.json 的一行(字段名与 Tauri `assets` 表对齐)。
///
/// M2 起补上 UI 面(`ui.get_assets` 等)需要的元数据:分组、标签、收藏、时间戳。
/// 读取时全部可选(缺省即零值),因此 M1 种下的 `{id,type,name,config}` 精简格式
/// 与带元数据的完整格式共存于同一份文件。
#[derive(Debug, Clone)]
pub struct AssetRecord {
    pub id: String,
    pub asset_type: String,
    pub name: String,
    /// 非敏感配置(敏感字段已在写入时拆到密钥存储)。
    pub config: Value,
    /// 密钥存储引用;`None` = 无敏感字段。
    pub key_id: Option<String>,
    /// 所属分组 id(Tauri `asset_groups.id`)。
    pub group_id: Option<i64>,
    /// 标签清单。
    pub tags: Vec<String>,
    /// 是否收藏。
    pub favorite: bool,
    /// 最近使用时间(秒级 unix;从未使用为 `None`)。
    pub last_used_at: Option<i64>,
    /// 创建时间(秒级 unix;缺省 0)。
    pub created_at: i64,
    /// 更新时间(秒级 unix;缺省 0)。
    pub updated_at: i64,
}

impl AssetRecord {
    /// 序列化为 assets.json 的一行(camelCase,与 M1 的文件格式一致)。
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "type": self.asset_type,
            "name": self.name,
            "config": self.config,
            "keyId": self.key_id,
            "groupId": self.group_id,
            "tags": self.tags,
            "favorite": self.favorite,
            "lastUsedAt": self.last_used_at,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }

    /// 序列化为 UI 面(`ui.get_assets`)的一行(snake_case,与工作台
    /// `RustAsset` 接口逐字对齐——工作台调用点因此零改动)。
    pub fn to_ui_json(&self) -> Value {
        json!({
            "id": self.id,
            "type": self.asset_type,
            "name": self.name,
            "group_id": self.group_id,
            "config": self.config,
            "key_id": self.key_id,
            "tags": self.tags,
            "favorite": self.favorite,
            "last_used_at": self.last_used_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        })
    }
}

/// 资产存储:assets.json + 密钥 seam。
pub struct AssetStore {
    path: PathBuf,
    secrets: Box<dyn SecretStore>,
}

impl AssetStore {
    /// 用显式路径建存储(测试 / bridge Config 注入)。
    pub fn new(path: impl Into<PathBuf>, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            path: path.into(),
            secrets,
        }
    }

    /// 按环境变量解析存储位置:
    /// - `STARHUB_ASSETS_FILE`:资产文件(缺省 `<cwd>/starhub-assets.json`);
    /// - `STARHUB_SECRETS_FILE`:文件密钥存储路径(缺省 `<资产文件>.secrets.json`);
    ///   设成空串 = 用内存密钥存储(只读会话,不落任何密钥)。
    pub fn from_env() -> Result<Self, String> {
        let assets_path = std::env::var("STARHUB_ASSETS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-assets.json"));
        let secrets_path = match std::env::var("STARHUB_SECRETS_FILE") {
            Ok(path) if path.trim().is_empty() => None,
            Ok(path) => Some(PathBuf::from(path)),
            Err(_) => Some(default_secrets_path(&assets_path)),
        };
        let secrets: Box<dyn SecretStore> = match secrets_path {
            Some(path) => Box::new(FileSecretStore::new(path)),
            None => Box::new(MemorySecretStore::new()),
        };
        Ok(Self::new(assets_path, secrets))
    }

    /// 资产文件路径(诊断信息用)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    // ---------- 非资产密钥(AI 模型 API key 等;UI 面 set/get/delete_ai_model_api_key) ──

    /// AI 模型密钥的 key_id 前缀(资产密钥用 `asset:<id>`,AI key 用 `ai-model:<id>`)。
    pub const AI_MODEL_KEY_PREFIX: &str = "ai-model:";

    /// 存一个字符串密钥(insert-or-replace)。
    pub fn set_secret(&self, key_id: &str, value: &str) -> Result<(), String> {
        self.secrets
            .store(key_id, &Value::String(value.to_string()))
    }

    /// 读一个字符串密钥;不存在返回 None(与 keyring 的 "no entry found" 对应)。
    pub fn get_secret(&self, key_id: &str) -> Option<String> {
        self.secrets
            .load(key_id)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
    }

    /// 删一个字符串密钥(不存在即幂等成功)。
    pub fn delete_secret(&self, key_id: &str) -> Result<(), String> {
        self.secrets.delete(key_id)
    }

    fn read_records(&self) -> Result<Vec<AssetRecord>, String> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(format!(
                    "资产文件读取失败({}): {error}",
                    self.path.display()
                ))
            }
        };
        let document: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("资产文件解析失败({}): {e}", self.path.display()))?;
        let items = document
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut records = Vec::with_capacity(items.len());
        for item in items {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").trim();
            if id.is_empty() {
                continue; // 无 id 的行不是资产
            }
            records.push(AssetRecord {
                id: id.to_string(),
                asset_type: item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                config: item.get("config").cloned().unwrap_or(Value::Null),
                key_id: item
                    .get("keyId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                group_id: item.get("groupId").and_then(Value::as_i64),
                tags: string_array(item.get("tags")),
                favorite: item
                    .get("favorite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                last_used_at: item.get("lastUsedAt").and_then(Value::as_i64),
                created_at: item.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
                updated_at: item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
            });
        }
        Ok(records)
    }

    /// 全量写回(先写临时文件再 rename,避免半截文件;目录不存在时创建)。
    fn write_records(&self, records: &[AssetRecord]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("资产目录创建失败({}): {e}", parent.display()))?;
            }
        }
        let document =
            json!({ "assets": records.iter().map(AssetRecord::to_json).collect::<Vec<_>>() });
        let text = serde_json::to_string_pretty(&document)
            .map_err(|e| format!("资产文件序列化失败: {e}"))?;
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, format!("{text}\n"))
            .map_err(|e| format!("资产文件写入失败({}): {e}", temporary.display()))?;
        std::fs::rename(&temporary, &self.path)
            .map_err(|e| format!("资产文件替换失败({}): {e}", self.path.display()))
    }

    /// 新建或更新一个资产(敏感字段拆到密钥存储;`key_id` 缺省时按 `asset:<id>` 生成)。
    ///
    /// 与 `keyring::split_config` / `store` 同语义:空值/空串的敏感字段不落密钥。
    pub fn upsert(
        &self,
        id: &str,
        asset_type: &str,
        name: &str,
        config: Value,
        group_id: Option<i64>,
        tags: Vec<String>,
        favorite: bool,
    ) -> Result<AssetRecord, String> {
        let id = id.trim();
        if id.is_empty() {
            return Err("资产 id 不能为空".to_string());
        }
        let mut records = self.read_records()?;
        let existing = records.iter().find(|record| record.id == id).cloned();
        let (config, secrets) = split_config(config);
        let has_secrets = secrets.as_object().is_some_and(|values| !values.is_empty());
        let key_id = if has_secrets {
            let key_id = format!("asset:{id}");
            self.secrets.store(&key_id, &secrets)?;
            Some(key_id)
        } else {
            existing.as_ref().and_then(|record| record.key_id.clone())
        };
        let now = unix_now();
        let record = AssetRecord {
            id: id.to_string(),
            asset_type: asset_type.to_string(),
            name: name.to_string(),
            config,
            key_id,
            group_id,
            tags,
            favorite,
            last_used_at: existing.as_ref().and_then(|record| record.last_used_at),
            created_at: existing.as_ref().map_or(now, |record| record.created_at),
            updated_at: now,
        };
        match records.iter_mut().find(|record| record.id == id) {
            Some(slot) => *slot = record.clone(),
            None => records.push(record.clone()),
        }
        self.write_records(&records)?;
        Ok(record)
    }

    /// 删除资产及其密钥(不存在时报错,与 `get` 的错误文案一致)。
    pub fn remove(&self, asset_id: &str) -> Result<(), String> {
        let mut records = self.read_records()?;
        let position = records
            .iter()
            .position(|record| record.id == asset_id)
            .ok_or_else(|| format!("资产不存在: {asset_id}"))?;
        let removed = records.remove(position);
        if let Some(key_id) = &removed.key_id {
            self.secrets.delete(key_id)?;
        }
        self.write_records(&records)
    }

    /// 全量资产(文件顺序即返回顺序;排序由写入方负责)。
    pub fn list(&self) -> Result<Vec<AssetRecord>, String> {
        self.read_records()
    }

    /// 按 id 取资产;不存在时报错(与 `load_asset_config` 的旧错误文案一致)。
    pub fn get(&self, asset_id: &str) -> Result<AssetRecord, String> {
        self.read_records()?
            .into_iter()
            .find(|record| record.id == asset_id)
            .ok_or_else(|| format!("资产不存在: {asset_id}"))
    }

    /// 读资产并合并密钥,返回 `(资产类型, 合并后配置)`。
    ///
    /// 与 `src-tauri/src/harness/domain.rs::load_asset_config` 同语义:
    /// config_json 解析失败按空对象处理(旧行为),key_id 存在则合并密钥。
    pub fn load_asset_config(&self, asset_id: &str) -> Result<(String, Value), String> {
        let record = self.get(asset_id)?;
        let mut config = match &record.config {
            Value::Null => Value::Object(Default::default()),
            other => other.clone(),
        };
        if let Some(key_id) = &record.key_id {
            let secrets = self.secrets.load(key_id)?;
            config = merge_config(config, secrets);
        }
        Ok((record.asset_type, config))
    }

    /// 读 SSH 资产并组装连接配置,返回 `(资产名, SshConfig)`。
    ///
    /// 与 `src-tauri/src/commands/ssh.rs::asset_ssh_config` 的错误文案逐字一致
    /// (类型不符 / 配置不完整),模型侧软错误引导不漂移。
    pub fn asset_ssh_config(
        &self,
        asset_id: &str,
    ) -> Result<(String, starhub_domain_ssh::SshConfig), String> {
        let record = self.get(asset_id)?;
        if record.asset_type != "ssh" {
            return Err(format!(
                "资产 {asset_id} 类型不是 ssh(实际是 {}):SSH 域工具(ssh_exec 等)需要绑定 SSH 资产。\
                 当前会话绑定的不是 SSH 资产,请重新 @ 绑定 SSH 资产,或调用 bind_asset_context 切换后重试",
                record.asset_type
            ));
        }
        let (_asset_type, config) = self.load_asset_config(asset_id)?;
        let config = ssh_config_from_asset(&record.name, &config)?;
        Ok((record.name, config))
    }

    /// 模型可读的资产摘要(与 `src/utils/aiMention.ts assetSummary` / Tauri
    /// `harness/tools.rs::asset_summary` 同语义,只取非敏感字段)。
    pub fn asset_summary(asset_type: &str, name: &str, config: &Value) -> String {
        let get = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
        match asset_type {
            "ssh" => {
                let host = get("host");
                let host = if host.is_empty() { "-" } else { host };
                let port = config.get("port").and_then(Value::as_i64).unwrap_or(22);
                format!("{host}:{port}")
            }
            "db" => {
                let db_type = get("dbType");
                let db_type = if db_type.is_empty() { "mysql" } else { db_type };
                let address = get("address");
                let host = get("host");
                let target = if !address.is_empty() {
                    address
                } else if !host.is_empty() {
                    host
                } else {
                    "-"
                };
                format!("{db_type} · {target}")
            }
            "docker" => {
                let transport = get("dockerTransport");
                let remote = get("remoteHost");
                if !transport.is_empty() {
                    transport.to_string()
                } else if !remote.is_empty() {
                    remote.to_string()
                } else {
                    "local".to_string()
                }
            }
            "local" => {
                let root = get("rootPath");
                if !root.is_empty() {
                    root.to_string()
                } else if !name.is_empty() {
                    name.to_string()
                } else {
                    "-".to_string()
                }
            }
            _ => {
                let format = get("format");
                if format.is_empty() {
                    "xlsx".to_string()
                } else {
                    format.to_string()
                }
            }
        }
    }

    /// `starhub_list_assets` 的结果文本(JSON 数组字符串,契约不变)。
    pub fn list_assets_text(&self, type_filter: Option<&str>) -> Result<String, String> {
        let filter = type_filter.map(str::to_lowercase);
        let mut result = Vec::new();
        for record in self.list()? {
            if let Some(filter) = &filter {
                if !filter.is_empty() && &record.asset_type != filter {
                    continue;
                }
            }
            result.push(json!({
                "id": record.id,
                "name": record.name,
                "type": record.asset_type,
                "context": Self::asset_summary(&record.asset_type, &record.name, &record.config),
            }));
        }
        serde_json::to_string(&result).map_err(|e| e.to_string())
    }
}

fn default_secrets_path(assets_path: &Path) -> PathBuf {
    let mut name = assets_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "starhub-assets.json".to_string());
    name.push_str(".secrets.json");
    match assets_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store_in_temp(dir: &Path) -> AssetStore {
        AssetStore::new(dir.join("assets.json"), Box::new(MemorySecretStore::new()))
    }

    fn write_assets(dir: &Path, value: Value) {
        std::fs::write(
            dir.join("assets.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn split_and_merge_roundtrip_matches_keyring_semantics() {
        let original = json!({
            "host": "db.internal",
            "password": "secret",
            "privateKey": "pem",
            "port": 5432,
        });
        let (config, secrets) = split_config(original.clone());
        assert_eq!(config, json!({ "host": "db.internal", "port": 5432 }));
        assert_eq!(
            secrets,
            json!({ "password": "secret", "privateKey": "pem" })
        );
        assert_eq!(merge_config(config, secrets), original);

        // 空值/空串不进密钥存储(与 keyring::split_config 一致)
        let (config, secrets) =
            split_config(json!({ "host": "h", "password": "", "passphrase": null }));
        assert_eq!(config, json!({ "host": "h" }));
        assert_eq!(secrets, json!({}));
    }

    #[test]
    fn reads_records_and_reports_missing_asset() {
        let dir = std::env::temp_dir().join(format!("starhub-assets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_assets(
            &dir,
            json!({ "assets": [
                { "id": "a1", "type": "ssh", "name": "prod", "config": { "host": "10.0.0.7", "username": "root" } },
                { "id": "", "type": "ssh", "name": "ignored", "config": {} },
            ]}),
        );
        let store = store_in_temp(&dir);
        let records = store.list().unwrap();
        assert_eq!(records.len(), 1, "无 id 的行被跳过");
        assert_eq!(records[0].id, "a1");
        assert_eq!(store.get("a1").unwrap().name, "prod");
        let err = store.get("nope").unwrap_err();
        assert_eq!(err, "资产不存在: nope");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_assets_file_is_an_empty_store() {
        let dir = std::env::temp_dir().join(format!("starhub-assets-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = store_in_temp(&dir);
        assert!(store.list().unwrap().is_empty());
        assert_eq!(store.list_assets_text(None).unwrap(), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merges_secrets_from_the_secret_store() {
        let dir =
            std::env::temp_dir().join(format!("starhub-assets-secret-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_assets(
            &dir,
            json!({ "assets": [
                { "id": "a1", "type": "ssh", "name": "prod", "keyId": "k1",
                  "config": { "host": "10.0.0.7", "username": "root", "port": 2222 } },
            ]}),
        );
        let secrets = MemorySecretStore::new();
        secrets.store("k1", &json!({ "password": "pw" })).unwrap();
        let store = AssetStore::new(dir.join("assets.json"), Box::new(secrets));
        let (asset_type, config) = store.load_asset_config("a1").unwrap();
        assert_eq!(asset_type, "ssh");
        assert_eq!(config["password"], "pw");
        assert_eq!(config["port"], 2222);

        let (name, ssh) = store.asset_ssh_config("a1").unwrap();
        assert_eq!(name, "prod");
        assert_eq!(ssh.host, "10.0.0.7");
        assert_eq!(ssh.port, 2222);
        assert!(matches!(ssh.auth, starhub_domain_ssh::SshAuth::Password(ref p) if p == "pw"));

        // 缺密钥条目:错误文案与 keyring::load 一致
        let store = store_in_temp(&dir);
        let err = store.load_asset_config("a1").unwrap_err();
        assert!(err.contains("no entry found"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_ssh_config_rejects_non_ssh_assets_with_the_same_message() {
        let dir = std::env::temp_dir().join(format!("starhub-assets-type-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_assets(
            &dir,
            json!({ "assets": [
                { "id": "db1", "type": "db", "name": "mysql", "config": { "dbType": "mysql" } },
            ]}),
        );
        let store = store_in_temp(&dir);
        let err = store.asset_ssh_config("db1").unwrap_err();
        assert!(err.contains("类型不是 ssh"), "{err}");
        assert!(err.contains("实际是 db"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_assets_text_filters_by_type_and_hides_secrets() {
        let dir = std::env::temp_dir().join(format!("starhub-assets-list-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_assets(
            &dir,
            json!({ "assets": [
                { "id": "a1", "type": "ssh", "name": "prod", "config": { "host": "10.0.0.7", "port": 22 } },
                { "id": "d1", "type": "db", "name": "mysql", "config": { "dbType": "mysql", "host": "db.internal" } },
            ]}),
        );
        let store = store_in_temp(&dir);
        let all: Value = serde_json::from_str(&store.list_assets_text(None).unwrap()).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 2);
        assert_eq!(all[0]["context"], "10.0.0.7:22");
        assert_eq!(all[1]["context"], "mysql · db.internal");
        // 只返回 id/name/type/context 四个字段
        assert_eq!(all[0].as_object().unwrap().len(), 4);

        let ssh_only: Value =
            serde_json::from_str(&store.list_assets_text(Some("ssh")).unwrap()).unwrap();
        assert_eq!(ssh_only.as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_secret_store_roundtrips_and_is_idempotent_on_delete() {
        let dir = std::env::temp_dir().join(format!("starhub-file-secrets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.json");
        let store = FileSecretStore::new(&path);
        assert!(store.load("k1").is_err(), "文件不存在 = 无条目");
        store.store("k1", &json!({ "password": "pw" })).unwrap();
        store.store("k2", &json!({ "privateKey": "pem" })).unwrap();
        assert_eq!(store.load("k1").unwrap(), json!({ "password": "pw" }));
        // 覆盖写
        store.store("k1", &json!({ "password": "pw2" })).unwrap();
        assert_eq!(store.load("k1").unwrap()["password"], "pw2");
        store.delete("k1").unwrap();
        assert!(store.load("k1").is_err());
        assert_eq!(store.load("k2").unwrap()["privateKey"], "pem");
        // 删除不存在条目:幂等
        store.delete("absent").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
