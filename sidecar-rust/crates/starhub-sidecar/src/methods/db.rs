//! DB / Redis / ES / Docker 方法面(M1 第 5 步):15 个模型工具一对一落到
//! JSON-RPC 方法,内部经 [`starhub_domain_db`] 的执行器走 Go sidecar。
//!
//! | 工具 | 方法 | 下游(Go sidecar) |
//! |---|---|---|
//! | db_query | `db_query` | db.{mysql,postgres,clickhouse}.execute |
//! | redis_exec | `redis_exec` | db.redis.execute |
//! | es_*(9) | 同名 | db.es.* |
//! | docker_*(4) | 同名 | docker.* |
//!
//! 与 SSH 域同样两条铁律:方法名 = 工具名;结果文本逐字保持(契约)。
//! 资产类型 → 工具族校验(`check_tool_asset_type`)在派发前统一执行,
//! 不匹配返回软错误引导(Ok 文本),不抛硬错误。

use serde_json::{json, Value};

use crate::db_runtime::DbRuntime;
use crate::jsonrpc::RpcError;
use crate::runtime::resolve_asset_id;

use super::ssh::{domain_error, tool_args};

/// 资产解析结果:三岔口(就绪 / 软错误 / 硬错误)。
///
/// 软错误 = 原样作文本回给模型(工具族不匹配的引导),硬错误 = RPC 错误。
/// 与 Tauri 版 `execute_domain_tool` 的语义一致。
enum AssetResolution {
    Ready {
        asset_type: String,
        kind: String,
        config: Value,
    },
    Soft(String),
    Hard(RpcError),
}

/// 解析目标资产 + 合并密钥后的配置,并做工具族校验。
fn resolve_asset(runtime: &DbRuntime, name: &str, params: &Value) -> AssetResolution {
    let assets = runtime.assets();
    let asset_id = match resolve_asset_id(runtime.bindings(), params) {
        Ok(asset_id) => asset_id,
        Err(message) => return AssetResolution::Soft(message),
    };
    // 资产存在性校验(不存在即硬错误,文案与资产存储一致)
    if let Err(message) = assets.get(&asset_id) {
        return AssetResolution::Hard(domain_error(message));
    }
    let (asset_type, config) = match assets.load_asset_config(&asset_id) {
        Ok(loaded) => loaded,
        Err(message) => return AssetResolution::Hard(domain_error(message)),
    };
    let kind = if asset_type == "db" {
        config
            .get("dbType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        asset_type.clone()
    };
    match starhub_domain_db::check_tool_asset_type(&asset_type, &kind, name) {
        Ok(()) => AssetResolution::Ready {
            asset_type,
            kind,
            config,
        },
        Err(hint) => AssetResolution::Soft(hint),
    }
}

/// Docker 的 SSH 传输:解析 `dockerSshAssetId` 指向的 SSH 资产配置。
fn resolve_docker_ssh(runtime: &DbRuntime, config: &Value) -> Result<Option<Value>, String> {
    let asset_id = config
        .get("dockerSshAssetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(asset_id) = asset_id else {
        return Ok(None);
    };
    let (_asset_type, ssh_config) = runtime.assets().load_asset_config(asset_id)?;
    Ok(Some(ssh_config))
}

pub async fn db_query_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    let (asset_type, _kind, config) = match resolve_asset(runtime, "db_query", params) {
        AssetResolution::Ready {
            asset_type,
            kind,
            config,
        } => (asset_type, kind, config),
        AssetResolution::Soft(text) => return Ok(json!({ "text": text })),
        AssetResolution::Hard(error) => return Err(error),
    };
    let args = tool_args(params);
    let text =
        starhub_domain_db::execute_db_query(runtime.go_sidecar(), &asset_type, &config, &args)
            .await
            .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn redis_exec_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    let (_asset_type, _kind, config) = match resolve_asset(runtime, "redis_exec", params) {
        AssetResolution::Ready {
            asset_type,
            kind,
            config,
        } => (asset_type, kind, config),
        AssetResolution::Soft(text) => return Ok(json!({ "text": text })),
        AssetResolution::Hard(error) => return Err(error),
    };
    let args = tool_args(params);
    let text = starhub_domain_db::execute_redis(runtime.go_sidecar(), &config, &args)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

/// `es_*` 9 个工具的公共入口。
async fn es(runtime: &DbRuntime, name: &str, params: &Value) -> Result<Value, RpcError> {
    let (_asset_type, _kind, config) = match resolve_asset(runtime, name, params) {
        AssetResolution::Ready {
            asset_type,
            kind,
            config,
        } => (asset_type, kind, config),
        AssetResolution::Soft(text) => return Ok(json!({ "text": text })),
        AssetResolution::Hard(error) => return Err(error),
    };
    let args = tool_args(params);
    let text = starhub_domain_db::execute_es(runtime.go_sidecar(), &config, name, &args)
        .await
        .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn es_list_indices_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    es(runtime, "es_list_indices", params).await
}

pub async fn es_cluster_health_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    es(runtime, "es_cluster_health", params).await
}

pub async fn es_get_mapping_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    es(runtime, "es_get_mapping", params).await
}

pub async fn es_search_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    es(runtime, "es_search", params).await
}

pub async fn es_get_document_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    es(runtime, "es_get_document", params).await
}

pub async fn es_count_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    es(runtime, "es_count", params).await
}

pub async fn es_index_document_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    es(runtime, "es_index_document", params).await
}

pub async fn es_delete_document_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    es(runtime, "es_delete_document", params).await
}

pub async fn es_delete_index_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    es(runtime, "es_delete_index", params).await
}

/// `docker_*` 4 个工具的公共入口。
async fn docker(runtime: &DbRuntime, name: &str, params: &Value) -> Result<Value, RpcError> {
    let (_asset_type, _kind, config) = match resolve_asset(runtime, name, params) {
        AssetResolution::Ready {
            asset_type,
            kind,
            config,
        } => (asset_type, kind, config),
        AssetResolution::Soft(text) => return Ok(json!({ "text": text })),
        AssetResolution::Hard(error) => return Err(error),
    };
    let args = tool_args(params);
    let docker_ssh = resolve_docker_ssh(runtime, &config).map_err(domain_error)?;
    let text = starhub_domain_db::execute_docker(
        runtime.go_sidecar(),
        &config,
        name,
        &args,
        docker_ssh.as_ref(),
        runtime.known_hosts(),
    )
    .await
    .map_err(domain_error)?;
    Ok(json!({ "text": text }))
}

pub async fn docker_list_containers_method(
    runtime: &DbRuntime,
    params: &Value,
) -> Result<Value, RpcError> {
    docker(runtime, "docker_list_containers", params).await
}

pub async fn docker_logs_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    docker(runtime, "docker_logs", params).await
}

pub async fn docker_inspect_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    docker(runtime, "docker_inspect", params).await
}

pub async fn docker_exec_method(runtime: &DbRuntime, params: &Value) -> Result<Value, RpcError> {
    docker(runtime, "docker_exec", params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetStore, MemorySecretStore};
    use crate::bindings::SessionBindings;
    use crate::runtime::SshRuntime;
    use starhub_domain_ssh::events::{EventSink, MemoryKnownHostsStore};
    use std::sync::Arc;

    struct NoopSink;

    impl EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    /// 资产库 + 假 Go sidecar(python fixture)的运行时。
    fn runtime_in_temp(label: &str) -> (Arc<DbRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-db-methods-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("assets.json"),
            serde_json::to_vec_pretty(&json!({
                "assets": [
                    { "id": "mysql-1", "type": "db", "name": "mysql",
                      "config": { "dbType": "mysql", "host": "db.internal", "port": 3306,
                                  "username": "root", "password": "pw", "database": "app" } },
                    { "id": "redis-1", "type": "db", "name": "redis",
                      "config": { "dbType": "redis", "host": "r.internal", "port": 6379,
                                  "redisDb": 3, "password": "pw" } },
                    { "id": "es-1", "type": "db", "name": "es",
                      "config": { "dbType": "elasticsearch", "host": "es.internal", "port": 9200 } },
                    { "id": "docker-1", "type": "docker", "name": "docker",
                      "config": { "dockerTransport": "socket" } },
                    { "id": "ssh-1", "type": "ssh", "name": "ssh",
                      "config": { "host": "10.0.0.7", "username": "root" } },
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let assets = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(MemorySecretStore::new()),
        ));
        let (python, args) =
            starhub_domain_db::fake_go_sidecar_command().expect("fake Go sidecar fixture present");
        let go = starhub_domain_db::GoSidecar::with_command(python, args);
        let known_hosts: Arc<dyn starhub_domain_ssh::events::KnownHostsStore> =
            Arc::new(MemoryKnownHostsStore::default());
        let bindings = Arc::new(SessionBindings::new());
        let runtime = Arc::new(DbRuntime::new(
            Arc::clone(&assets),
            Arc::new(go),
            Arc::clone(&known_hosts),
            Arc::clone(&bindings),
        ));
        (runtime, dir)
    }

    /// 工具族不匹配 → 软错误(Ok 文本,不是 RpcError)。
    #[tokio::test]
    async fn db_query_on_an_ssh_asset_is_a_soft_error() {
        let (runtime, dir) = runtime_in_temp("mismatch");
        let result = db_query_method(&runtime, &json!({ "assetId": "ssh-1", "sql": "SELECT 1" }))
            .await
            .expect("软错误以 Ok 返回");
        let text = result["text"].as_str().unwrap();
        assert!(text.contains("不是数据库资产"), "{text}");
        assert!(text.contains("绑定资产是 ssh"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// redis_exec 在 mysql 资产上:子类型不符,同样软错误。
    #[tokio::test]
    async fn redis_exec_on_a_mysql_asset_is_a_soft_error() {
        let (runtime, dir) = runtime_in_temp("subtype");
        let result = redis_exec_method(
            &runtime,
            &json!({ "assetId": "mysql-1", "command": "GET k" }),
        )
        .await
        .expect("软错误");
        assert!(
            result["text"].as_str().unwrap().contains("db_query"),
            "{result}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空 SQL:软错误(与 Tauri 版一致,不触网)。
    #[tokio::test]
    async fn db_query_with_empty_sql_is_a_soft_error() {
        let (runtime, dir) = runtime_in_temp("emptysql");
        let result = db_query_method(&runtime, &json!({ "assetId": "mysql-1", "sql": "  " }))
            .await
            .expect("软错误");
        assert_eq!(result["text"], "[Error] Empty SQL");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// SELECT 拦截:软引导改用 db 参数(不触网)。
    #[tokio::test]
    async fn redis_exec_select_is_intercepted_with_guidance() {
        let (runtime, dir) = runtime_in_temp("select");
        let result = redis_exec_method(
            &runtime,
            &json!({ "assetId": "redis-1", "command": "SELECT 15" }),
        )
        .await
        .expect("软错误");
        let text = result["text"].as_str().unwrap();
        assert!(text.contains("SELECT 切库不会保留"), "{text}");
        assert!(text.contains("db 参数"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真链路(假 Go sidecar):db_query 的结果文本契约。
    #[tokio::test]
    async fn db_query_roundtrip_against_the_fake_go_sidecar() {
        let (runtime, dir) = runtime_in_temp("dbquery");
        let result = db_query_method(
            &runtime,
            &json!({ "assetId": "mysql-1", "sql": "SELECT * FROM users" }),
        )
        .await
        .expect("roundtrip");
        let text = result["text"].as_str().unwrap();
        assert_eq!(text, "列: id, name\nid=1 | name=alice\nid=2 | name=bob");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// redis_exec:GET 的文本 + db 参数透传到连接。
    #[tokio::test]
    async fn redis_exec_roundtrip_passes_the_db_override() {
        let (runtime, dir) = runtime_in_temp("redis");
        let result = redis_exec_method(
            &runtime,
            &json!({ "assetId": "redis-1", "command": "GET key", "db": 15 }),
        )
        .await
        .expect("roundtrip");
        assert_eq!(result["text"], "cached-value");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// es_list_indices:管道分隔的清单格式。
    #[tokio::test]
    async fn es_list_indices_roundtrip_format() {
        let (runtime, dir) = runtime_in_temp("es");
        let result = es_list_indices_method(&runtime, &json!({ "assetId": "es-1" }))
            .await
            .expect("roundtrip");
        assert_eq!(
            result["text"],
            "logs-2026 | 12 | 48kb | green\nmetrics | 3 | 12kb | yellow"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// docker_list_containers:容器 id 截断到 12 字符。
    #[tokio::test]
    async fn docker_list_containers_roundtrip_format() {
        let (runtime, dir) = runtime_in_temp("docker");
        let result = docker_list_containers_method(&runtime, &json!({ "assetId": "docker-1" }))
            .await
            .expect("roundtrip");
        assert_eq!(
            result["text"],
            "abc123def456 | web | nginx:latest | running | Up 2 hours"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// docker 资产上调 ssh_exec:软错误(工具族校验在 SSH 方法面同样生效)。
    #[tokio::test]
    async fn docker_asset_rejects_ssh_tools() {
        let (runtime, dir) = runtime_in_temp("cross");
        // SSH 域与 DB 域共享 bindings/资产语义:docker 资产 → 类型不符软错误
        let ssh_runtime = SshRuntime::new(
            Arc::clone(runtime.assets()),
            Arc::new(NoopSink),
            Arc::new(MemoryKnownHostsStore::default()),
            Arc::clone(runtime.bindings()),
        );
        let result = crate::methods::ssh::ssh_exec_method(
            &ssh_runtime,
            &json!({ "assetId": "docker-1", "command": "ls" }),
        )
        .await
        .expect("软错误");
        let text = result["text"].as_str().unwrap();
        assert!(text.contains("不是 SSH 资产"), "{text}");
        assert!(text.contains("docker_*"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
