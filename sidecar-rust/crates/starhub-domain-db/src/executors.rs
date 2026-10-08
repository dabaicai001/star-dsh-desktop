//! DB / Redis / ES / Docker 域工具执行器(去 Tauri 化 M1 从
//! `src-tauri/src/harness/domain.rs` 平移,结果文本逐字保持)。
//!
//! 每个执行器的形状一致:按资产配置建连 → 执行 → 格式化 → 断开。
//! 「按资产配置建连」需要资产存储(宿主提供 config),连接本身走
//! [`GoSidecar`] 的 stdio JSON-RPC——这就是 M1 架构里
//! `starhub-sidecar-rust`(父)→ `starhub-sidecar`(Go,子) 的一跳。
//!
//! 结果文本格式与前端 `src/services/dshToolExecutor.ts` 对齐(模型可读文本),
//! 行为语义照搬前端实现,便于模型无感迁移——**文本是契约,不许漂移**。

use serde_json::{json, Value};

use starhub_domain_ssh::events::KnownHostsStore;

use crate::go_sidecar::GoSidecar;
use std::sync::Arc;

fn as_str(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

fn as_u16(value: &Value, default: u16) -> u16 {
    value.as_u64().map(|v| v as u16).unwrap_or(default)
}

fn as_bool(value: &Value, default: bool) -> bool {
    value.as_bool().unwrap_or(default)
}

fn as_number(value: &Value, default: u64) -> u64 {
    value.as_u64().unwrap_or(default)
}

/// 格式化查询结果(与前端 formatQueryResult 对齐)。
pub fn format_query_result(value: &Value) -> String {
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return format!("[Error] {error}");
    }
    let columns: Vec<String> = value
        .get("columns")
        .and_then(Value::as_array)
        .map(|cols| {
            cols.iter()
                .map(|col| as_str(col.get("name").unwrap_or(&Value::Null)))
                .collect()
        })
        .unwrap_or_default();
    let rows = value
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rows_affected = as_number(value.get("rowsAffected").unwrap_or(&Value::Null), 0);
    if rows.is_empty() {
        return if rows_affected > 0 {
            format!("(0 行, {rows_affected} 行受影响)")
        } else {
            "(0 行)".to_string()
        };
    }
    let lines: Vec<String> = rows
        .iter()
        .take(20)
        .map(|row| {
            let cells: Vec<String> = match row {
                Value::Array(items) => items
                    .iter()
                    .enumerate()
                    .map(|(index, cell)| {
                        let fallback = index.to_string();
                        let name = columns.get(index).map(|s| s.as_str()).unwrap_or(&fallback);
                        format!("{name}={}", format_value(cell))
                    })
                    .collect(),
                other => vec![format_value(other)],
            };
            cells.join(" | ")
        })
        .collect();
    let mut text = format!("列: {}\n{}", columns.join(", "), lines.join("\n"));
    if rows.len() > 20 {
        text.push_str(&format!("\n… (共 {} 行)", rows.len()));
    }
    text
}

fn format_value(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        // 与前端 formatValue(String(value)) 对齐:字符串原样输出,不加 JSON 引号
        Value::String(text) => truncate_text(text),
        Value::Object(_) | Value::Array(_) => value.to_string(),
        other => truncate_text(&other.to_string()),
    }
}

/// 与前端 formatValue 截断语义一致:超过 120 字符截断并追加省略号。
/// 按字符截断(非字节),避免切在 UTF-8 多字节边界上 panic。
fn truncate_text(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

pub fn format_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// 按资产配置建立连接,返回 connId。
///
/// Docker 的 SSH 传输需要额外解析 `dockerSshAssetId` 指向的 SSH 资产
/// (密钥 + 已知主机密钥),该解析在方法面完成(它有资产存储),解析结果经
/// `docker_ssh` 传入;其他资产类型传 `None`。
pub async fn connect_sidecar(
    sidecar: &GoSidecar,
    asset_type: &str,
    config: &Value,
    docker_ssh: Option<&Value>,
    known_hosts: Option<&Arc<dyn KnownHostsStore>>,
) -> Result<String, String> {
    let (method, params) = match asset_type {
        "mysql" | "db" => {
            let db_type = as_str(config.get("dbType").unwrap_or(&Value::Null));
            if db_type == "redis" {
                (
                    "db.redis.connect",
                    json!({
                        "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                        "port": as_u16(config.get("port").unwrap_or(&Value::Null), 6379),
                        "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                        "db": as_number(config.get("redisDb").unwrap_or(&Value::Null), 0),
                        "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                    }),
                )
            } else if db_type == "clickhouse" {
                (
                    "db.clickhouse.connect",
                    json!({
                        "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                        "port": as_u16(config.get("port").unwrap_or(&Value::Null), 9000),
                        "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                        "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                        "database": as_str(config.get("database").unwrap_or(&Value::Null)),
                        "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                    }),
                )
            } else if db_type == "postgresql" {
                (
                    "db.postgres.connect",
                    json!({
                        "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                        "port": as_u16(config.get("port").unwrap_or(&Value::Null), 5432),
                        "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                        "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                        "database": as_str(config.get("database").unwrap_or(&Value::Null)),
                        "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                    }),
                )
            } else {
                (
                    "db.mysql.connect",
                    json!({
                        "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                        "port": as_u16(config.get("port").unwrap_or(&Value::Null), 3306),
                        "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                        "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                        "database": as_str(config.get("database").unwrap_or(&Value::Null)),
                        "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
                    }),
                )
            }
        }
        "redis" => (
            "db.redis.connect",
            json!({
                "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                "port": as_u16(config.get("port").unwrap_or(&Value::Null), 6379),
                "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                "db": as_number(config.get("redisDb").unwrap_or(&Value::Null), 0),
                "ssl": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
            }),
        ),
        "elasticsearch" => (
            "db.es.connect",
            json!({
                "addresses": config.get("addresses").cloned().unwrap_or(Value::Null),
                "address": as_str(config.get("address").unwrap_or(&Value::Null)),
                "host": as_str(config.get("host").unwrap_or(&Value::Null)),
                "port": as_u16(config.get("port").unwrap_or(&Value::Null), 9200),
                "username": as_str(config.get("username").unwrap_or(&Value::Null)),
                "password": as_str(config.get("password").unwrap_or(&Value::Null)),
                "useSSL": as_bool(config.get("ssl").unwrap_or(&Value::Null), false),
            }),
        ),
        "docker" => (
            "docker.connect",
            docker_params(config, docker_ssh, known_hosts).await?,
        ),
        other => return Err(format!("不支持直接连接的资产类型: {other}")),
    };
    let result = sidecar.call(method, params).await?;
    result
        .get("connId")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{method} 未返回 connId: {result}"))
}

/// 构建 Docker 连接参数(与前端 dshToolExecutor.dockerParams 语义对齐)。
/// SSH 传输:使用 `docker_ssh`(方法面已解析的 SSH 资产配置,含密钥)与
/// `known_hosts`(宿主的 TOFU 存储)拼出与 sidecar DockerSSHConfig 契约一致的
/// ssh 子对象。
pub async fn docker_params(
    config: &Value,
    docker_ssh: Option<&Value>,
    known_hosts: Option<&Arc<dyn KnownHostsStore>>,
) -> Result<Value, String> {
    let transport = as_str(config.get("dockerTransport").unwrap_or(&Value::Null));
    let transport = if transport.is_empty() {
        if as_str(config.get("remoteHost").unwrap_or(&Value::Null)).is_empty() {
            "socket".to_string()
        } else {
            "tcp".to_string()
        }
    } else {
        transport
    };
    match transport.as_str() {
        "tcp" => Ok(json!({
            "transport": "tcp",
            "host": as_str(config.get("remoteHost").unwrap_or(&Value::Null)),
        })),
        "socket" => {
            let socket_path = as_str(config.get("socketPath").unwrap_or(&Value::Null));
            let socket_path = if socket_path.is_empty() {
                "/var/run/docker.sock".to_string()
            } else {
                socket_path
            };
            Ok(json!({
                "transport": "socket",
                "host": if socket_path.contains("://") { socket_path } else { format!("unix://{socket_path}") },
            }))
        }
        "ssh" => {
            // SSH 传输:SSH 资产配置由方法面解析后经 docker_ssh 传入
            // (它持有资产存储;本 crate 只消费解析结果)。
            let ssh_config = docker_ssh.ok_or_else(|| {
                "Docker SSH 传输需要先解析 SSH 资产(dockerSshAssetId 指向的资产)".to_string()
            })?;
            let host = as_str(ssh_config.get("host").unwrap_or(&Value::Null));
            let username = as_str(ssh_config.get("username").unwrap_or(&Value::Null));
            if host.is_empty() || username.is_empty() {
                return Err("Docker SSH 资产配置不完整(缺 host 或 username)".to_string());
            }
            let port = as_u16(ssh_config.get("port").unwrap_or(&Value::Null), 22);
            let known_host_key = match known_hosts {
                Some(store) => store
                    .trusted_public_key(&host, port)
                    .await
                    .map_err(|e| e.to_string())?,
                None => None,
            };
            if known_host_key.is_none() {
                return Err(format!(
                    "Docker SSH 主机 {host} 尚未确认主机密钥,请先在 SSH 终端连接一次"
                ));
            }
            let use_password = as_bool(
                ssh_config.get("usePasswordAuth").unwrap_or(&Value::Null),
                true,
            );
            let use_key = as_bool(ssh_config.get("useKeyAuth").unwrap_or(&Value::Null), false);
            let password = as_str(ssh_config.get("password").unwrap_or(&Value::Null));
            let private_key = as_str(ssh_config.get("privateKey").unwrap_or(&Value::Null));
            let passphrase = {
                let value = as_str(ssh_config.get("passphrase").unwrap_or(&Value::Null));
                (!value.is_empty()).then(|| value)
            };
            let _auth = if use_password
                && use_key
                && !password.is_empty()
                && !private_key.is_empty()
            {
                json!({ "PasswordAndKey": { "password": password, "key": private_key, "passphrase": passphrase } })
            } else if use_password && !password.is_empty() {
                json!({ "Password": password })
            } else if use_key && !private_key.is_empty() {
                json!({ "PrivateKey": { "key": private_key, "passphrase": passphrase } })
            } else {
                json!({ "Password": "" })
            };
            // 认证字段随 ssh 子对象传递(与前端一致)
            let jump_host = as_str(ssh_config.get("jumpHost").unwrap_or(&Value::Null));
            let mut ssh = json!({
                "host": host,
                "port": port,
                "username": username,
                "password": password,
                "privateKey": private_key,
                "passphrase": passphrase,
                "knownHostKey": known_host_key,
            });
            if !jump_host.is_empty() {
                ssh["jumpHost"] = Value::String(jump_host.clone());
                ssh["jumpPort"] = json!(as_u16(
                    ssh_config.get("jumpPort").unwrap_or(&Value::Null),
                    22
                ));
                ssh["jumpUsername"] = Value::String(as_str(
                    ssh_config.get("jumpUsername").unwrap_or(&Value::Null),
                ));
                ssh["jumpPassword"] = Value::String(as_str(
                    ssh_config.get("jumpPassword").unwrap_or(&Value::Null),
                ));
                ssh["jumpPrivateKey"] = Value::String(as_str(
                    ssh_config.get("jumpPrivateKey").unwrap_or(&Value::Null),
                ));
                ssh["jumpPassphrase"] = Value::String(as_str(
                    ssh_config.get("jumpPassphrase").unwrap_or(&Value::Null),
                ));
                if let Some(store) = known_hosts {
                    if let Ok(Some(jump_key)) = store
                        .trusted_public_key(
                            &jump_host,
                            as_u16(ssh_config.get("jumpPort").unwrap_or(&Value::Null), 22),
                        )
                        .await
                    {
                        ssh["jumpKnownHostKey"] = Value::String(jump_key);
                    }
                }
            }
            Ok(json!({
                "transport": "ssh",
                "host": as_str(config.get("remoteHost").unwrap_or(&Value::Null)),
                "socketPath": as_str(config.get("socketPath").unwrap_or(&Value::Null)),
                "ssh": ssh,
            }))
        }
        other => Err(format!("不支持的 dockerTransport: {other}")),
    }
}

/// `db_query`:关系库 / ClickHouse 执行一条 SQL。
pub async fn execute_db_query(
    sidecar: &GoSidecar,
    asset_type: &str,
    config: &Value,
    args: &Value,
) -> Result<String, String> {
    let sql = as_str(args.get("sql").unwrap_or(&Value::Null))
        .trim()
        .to_string();
    if sql.is_empty() {
        return Ok("[Error] Empty SQL".to_string());
    }
    let database = as_str(config.get("database").unwrap_or(&Value::Null));
    let conn_id = connect_sidecar(sidecar, asset_type, config, None, None).await?;
    let method = if asset_type == "clickhouse" {
        "db.clickhouse.execute"
    } else {
        "db.mysql.execute"
    };
    let result = sidecar
        .call(
            method,
            json!({
                "connId": conn_id,
                "sql": sql,
                "database": database,
            }),
        )
        .await?;
    let _ = sidecar
        .call(
            &format!(
                "{}.disconnect",
                method
                    .rsplit_once('.')
                    .map(|(p, _)| p)
                    .unwrap_or("db.mysql")
            ),
            json!({ "connId": conn_id }),
        )
        .await;
    Ok(format_query_result(&result))
}

/// 解析 redis_exec 的可选 `db` 参数(数字或数字字符串)。`None` = 未传,
/// 沿用资产配置库;`Err` = 传了但不是非负整数(软错误,原样回给模型)。
pub fn redis_db_override(args: &Value) -> Result<Option<u64>, String> {
    let Some(raw) = args.get("db") else {
        return Ok(None);
    };
    let parsed = match raw {
        Value::Null => return Ok(None),
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    };
    parsed
        .map(Some)
        .ok_or_else(|| "db 参数必须是非负整数,例如 {\"db\":15}".to_string())
}

/// 判断命令是否为 SELECT 切库命令(只看首 token;组合命令如
/// "SELECT 15\nRPUSH ..." 也命中,统一走软引导,不让 sidecar 报
/// 「invalid db number: 15\nRPUSH」这类难懂错误)。
pub fn is_redis_select_command(command: &str) -> bool {
    command
        .split_whitespace()
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case("SELECT"))
}

/// `redis_exec`:每次调用独立连接(执行后即断开),SELECT 切库不跨调用保留。
pub async fn execute_redis(
    sidecar: &GoSidecar,
    config: &Value,
    args: &Value,
) -> Result<String, String> {
    let command = as_str(args.get("command").unwrap_or(&Value::Null))
        .trim()
        .to_string();
    if command.is_empty() {
        return Ok("[Error] Empty command".to_string());
    }
    // SELECT 拦截:本工具每次调用都按资产配置库新建连接、执行后立即断开,
    // SELECT 切出的库随连接销毁,下一条命令仍回到配置库——曾因此发生过
    // 「想写 db15 的数据误落 db0」。改为软引导模型改用 db 参数。
    if is_redis_select_command(&command) {
        return Ok(
            "redis_exec 每次调用都是独立连接,SELECT 切库不会保留到下一次调用,后续命令仍会落到资产配置的库(数据会写错库)。请改用 db 参数在同一次调用里指定目标库,例如 {\"command\":\"GET key\",\"db\":15};本次 SELECT 未执行。"
                .to_string(),
        );
    }
    // db 参数覆盖配置库:连接本就按调用新建,直接以目标库建连,无跨调用状态。
    let conn_config = match redis_db_override(args)? {
        Some(db) => {
            let mut cfg = config.clone();
            if let Value::Object(map) = &mut cfg {
                map.insert("redisDb".to_string(), json!(db));
            }
            cfg
        }
        None => config.clone(),
    };
    let conn_id = connect_sidecar(sidecar, "redis", &conn_config, None, None).await?;
    let result = sidecar
        .call(
            "db.redis.execute",
            json!({
                "connId": conn_id,
                "command": command,
            }),
        )
        .await?;
    let _ = sidecar
        .call("db.redis.disconnect", json!({ "connId": conn_id }))
        .await;
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return Ok(format!("[Error] {error}"));
    }
    let value = result.get("result").cloned().unwrap_or(Value::Null);
    Ok(match value {
        Value::Null => "(无输出)".to_string(),
        Value::String(s) => s,
        other => format_json(&other),
    })
}

/// `es_*`:9 个 Elasticsearch 工具共用一个连接生命周期。
pub async fn execute_es(
    sidecar: &GoSidecar,
    config: &Value,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let conn_id = connect_sidecar(sidecar, "elasticsearch", config, None, None).await?;
    let result = match name {
        "es_list_indices" => {
            let r = sidecar
                .call("db.es.listIndices", json!({ "connId": conn_id }))
                .await?;
            let indices = r.as_array().cloned().unwrap_or_default();
            Ok(indices
                .iter()
                .map(|i| {
                    format!(
                        "{} | {} | {} | {}",
                        as_str(i.get("name").unwrap_or(&Value::Null)),
                        as_number(i.get("docsCount").unwrap_or(&Value::Null), 0),
                        as_str(i.get("storeSize").unwrap_or(&Value::Null)),
                        as_str(i.get("health").unwrap_or(&Value::Null)),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "es_cluster_health" => sidecar
            .call("db.es.clusterHealth", json!({ "connId": conn_id }))
            .await
            .map(|r| format_json(&r)),
        "es_get_mapping" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            sidecar
                .call(
                    "db.es.getMapping",
                    json!({ "connId": conn_id, "index": index }),
                )
                .await
                .map(|r| format_json(&r))
        }
        "es_search" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let query: Value =
                serde_json::from_str(&as_str(args.get("query").unwrap_or(&Value::Null)))
                    .map_err(|_| "Invalid JSON in query DSL".to_string())?;
            let from = args.get("from").and_then(Value::as_u64).unwrap_or(0);
            let size = args.get("size").and_then(Value::as_u64).unwrap_or(20);
            let r = sidecar.call("db.es.search", json!({
                "connId": conn_id, "index": index, "body": query, "from": from, "size": size,
            })).await?;
            Ok(format_json(&r))
        }
        "es_get_document" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let id = as_str(args.get("id").unwrap_or(&Value::Null));
            sidecar
                .call(
                    "db.es.getDocument",
                    json!({ "connId": conn_id, "index": index, "id": id }),
                )
                .await
                .map(|r| format_json(&r))
        }
        "es_count" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let body = args.get("query").cloned();
            let mut params = json!({ "connId": conn_id, "index": index });
            if let Some(b) = body {
                params["body"] = b;
            }
            sidecar
                .call("db.es.count", params)
                .await
                .map(|r| format_json(&r))
        }
        "es_index_document" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let body: Value =
                serde_json::from_str(&as_str(args.get("body").unwrap_or(&Value::Null)))
                    .map_err(|_| "Invalid JSON in body".to_string())?;
            let id = as_str(args.get("id").unwrap_or(&Value::Null));
            let mut params = json!({ "connId": conn_id, "index": index, "body": body });
            if !id.is_empty() {
                params["id"] = Value::String(id);
            }
            sidecar
                .call("db.es.indexDocument", params)
                .await
                .map(|r| format_json(&r))
        }
        "es_delete_document" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            let id = as_str(args.get("id").unwrap_or(&Value::Null));
            sidecar
                .call(
                    "db.es.deleteDocument",
                    json!({ "connId": conn_id, "index": index, "id": id }),
                )
                .await
                .map(|r| format_json(&r))
        }
        "es_delete_index" => {
            let index = as_str(args.get("index").unwrap_or(&Value::Null));
            sidecar
                .call(
                    "db.es.deleteIndex",
                    json!({ "connId": conn_id, "index": index }),
                )
                .await
                .map(|r| format_json(&r))
        }
        other => Err(format!("Unknown Elasticsearch tool: {other}")),
    };
    let _ = sidecar
        .call("db.es.disconnect", json!({ "connId": conn_id }))
        .await;
    result
}

/// `docker_*`:4 个 Docker 工具共用一个连接生命周期。
///
/// `docker_ssh` 是方法面预解析的 SSH 资产配置(仅 SSH 传输需要);
/// `known_hosts` 是宿主的 TOFU 主机密钥存储(Docker over SSH 复用)。
pub async fn execute_docker(
    sidecar: &GoSidecar,
    config: &Value,
    name: &str,
    args: &Value,
    docker_ssh: Option<&Value>,
    known_hosts: Option<&Arc<dyn KnownHostsStore>>,
) -> Result<String, String> {
    let conn_id = connect_sidecar(sidecar, "docker", config, docker_ssh, known_hosts).await?;
    let result = match name {
        "docker_list_containers" => {
            let all = args
                .get("all")
                .map(|v| v.as_str().unwrap_or("") != "false")
                .unwrap_or(true);
            let r = sidecar
                .call(
                    "docker.listContainers",
                    json!({ "connId": conn_id, "all": all }),
                )
                .await?;
            let containers = r.as_array().cloned().unwrap_or_default();
            Ok(containers
                .iter()
                .take(50)
                .map(|c| {
                    format!(
                        "{} | {} | {} | {} | {}",
                        as_str(c.get("id").unwrap_or(&Value::Null))
                            .chars()
                            .take(12)
                            .collect::<String>(),
                        as_str(c.get("name").unwrap_or(&Value::Null)),
                        as_str(c.get("image").unwrap_or(&Value::Null)),
                        as_str(c.get("state").unwrap_or(&Value::Null)),
                        as_str(c.get("status").unwrap_or(&Value::Null)),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "docker_logs" => {
            let container = as_str(args.get("container").unwrap_or(&Value::Null));
            let tail = as_str(args.get("tail").unwrap_or(&Value::Null));
            let tail = if tail.is_empty() {
                "200".to_string()
            } else {
                tail
            };
            let r = sidecar
                .call(
                    "docker.containerLogs",
                    json!({ "connId": conn_id, "containerId": container, "tail": tail }),
                )
                .await?;
            let logs = r.as_array().cloned().unwrap_or_default();
            Ok(logs
                .iter()
                .map(|l| {
                    format!(
                        "[{}] {}",
                        as_str(l.get("stream").unwrap_or(&Value::Null)),
                        as_str(l.get("message").unwrap_or(&Value::Null))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "docker_inspect" => {
            let target = as_str(args.get("target").unwrap_or(&Value::Null));
            sidecar
                .call(
                    "docker.inspectContainer",
                    json!({ "connId": conn_id, "containerId": target }),
                )
                .await
                .map(|r| format_json(&r))
        }
        "docker_exec" => {
            let container = as_str(args.get("container").unwrap_or(&Value::Null));
            let command = as_str(args.get("command").unwrap_or(&Value::Null));
            let r = sidecar
                .call(
                    "docker.exec",
                    json!({
                        "connId": conn_id,
                        "containerId": container,
                        "command": ["sh", "-c", command],
                        "timeoutSec": 30,
                    }),
                )
                .await?;
            let stdout = as_str(r.get("stdout").unwrap_or(&Value::Null));
            let stderr = as_str(r.get("stderr").unwrap_or(&Value::Null));
            let exit_code = as_number(r.get("exitCode").unwrap_or(&Value::Null), 0);
            Ok([
                stdout,
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("[stderr]\n{stderr}")
                },
                if exit_code > 0 {
                    format!("[exit {exit_code}]")
                } else {
                    String::new()
                },
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
        }
        other => Err(format!("Unknown Docker tool: {other}")),
    };
    let _ = sidecar
        .call("docker.disconnect", json!({ "connId": conn_id }))
        .await;
    result
}

/// 工具族 → 允许的资产类型(按工具名前缀/名称判定)。返回 None 表示该工具
/// 与资产类型匹配,或该工具不需要资产类型约束(如 ssh_session_status)。
/// 不匹配返回一段软错误引导(原样作文本回给模型,不 throw)。
///
/// 从 `src-tauri/src/harness/domain.rs` 平移;覆盖 ssh_/sftp_(SSH 域)与
/// db_query/redis_exec/es_*/docker_(本 crate),由方法面在派发前统一调用。
pub fn check_tool_asset_type(asset_type: &str, db_type: &str, name: &str) -> Result<(), String> {
    // SSH / SFTP 工具族:只允许 ssh 资产。
    if name.starts_with("ssh_") || name.starts_with("sftp_") {
        if asset_type == "ssh" {
            return Ok(());
        }
        return Err(format!(
            "绑定资产是 {asset_type}({db_type}),不是 SSH 资产,不能执行 {name}。请改用该资产对应的工具(db_query / redis_exec / es_* / docker_*),或先绑定一个 SSH 资产。"
        ));
    }
    // DB / Redis / ES 工具族:只允许 db 资产,且子类型与工具匹配。
    if name == "db_query" || name == "redis_exec" || name.starts_with("es_") {
        if asset_type != "db" {
            return Err(format!(
                "绑定资产是 {asset_type}({db_type}),不是数据库资产,不能执行 {name}。请改用该资产对应的工具,或先绑定一个数据库资产。"
            ));
        }
        let subtype_ok = match name {
            "db_query" => matches!(
                db_type,
                "mysql" | "postgresql" | "clickhouse" | "sqlite" | "mssql" | ""
            ),
            "redis_exec" => db_type == "redis",
            _ => name.starts_with("es_") && db_type == "elasticsearch",
        };
        if !subtype_ok {
            return Err(format!(
                "绑定资产是数据库({db_type}),不能执行 {name}(请改用与该资产类型匹配的工具,如 db_query 用于关系库 / redis_exec 用于 Redis / es_* 用于 Elasticsearch)。"
            ));
        }
        return Ok(());
    }
    // Docker 工具族:只允许 docker 资产。
    if name.starts_with("docker_") {
        if asset_type == "docker" {
            return Ok(());
        }
        return Err(format!(
            "绑定资产是 {asset_type}({db_type}),不是 Docker 资产,不能执行 {name}。请改用该资产对应的工具,或先绑定一个 Docker 资产。"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- 纯函数:资产类型 → 工具族校验 ----------

    #[test]
    fn check_tool_asset_type_rejects_db_to_ssh() {
        // @ 数据库资产却调 ssh_exec:必须拦下并给软错误引导。
        let err = check_tool_asset_type("db", "mysql", "ssh_exec").unwrap_err();
        assert!(err.contains("不是 SSH 资产"), "{err}");
        assert!(err.contains("db_query"), "{err}");
    }

    #[test]
    fn check_tool_asset_type_allows_matching_family() {
        assert!(check_tool_asset_type("ssh", "ssh", "ssh_exec").is_ok());
        assert!(check_tool_asset_type("db", "mysql", "db_query").is_ok());
        assert!(check_tool_asset_type("db", "redis", "redis_exec").is_ok());
        assert!(check_tool_asset_type("db", "elasticsearch", "es_search").is_ok());
        assert!(check_tool_asset_type("docker", "docker", "docker_exec").is_ok());
    }

    #[test]
    fn check_tool_asset_type_rejects_mismatched_db_type() {
        // redis 资产上执行 es_*:资产类型同为 db 但子类型不符,仍应拦下。
        let err = check_tool_asset_type("db", "redis", "es_search").unwrap_err();
        assert!(err.contains("Redis") || err.contains("es_"), "{err}");
        // mysql 资产上执行 redis_exec:同样拦下。
        let err2 = check_tool_asset_type("db", "mysql", "redis_exec").unwrap_err();
        assert!(
            err2.contains("db_query") || err2.contains("Redis"),
            "{err2}"
        );
    }

    // ---------- 纯函数:redis_exec db 参数与 SELECT 拦截 ----------

    #[test]
    fn redis_db_override_parses_number_and_numeric_string() {
        assert_eq!(redis_db_override(&json!({})).unwrap(), None);
        assert_eq!(redis_db_override(&json!({"db": null})).unwrap(), None);
        assert_eq!(redis_db_override(&json!({"db": 15})).unwrap(), Some(15));
        assert_eq!(redis_db_override(&json!({"db": 0})).unwrap(), Some(0));
        assert_eq!(redis_db_override(&json!({"db": "15"})).unwrap(), Some(15));
        assert_eq!(redis_db_override(&json!({"db": " 15 "})).unwrap(), Some(15));
        assert!(redis_db_override(&json!({"db": "abc"})).is_err());
        assert!(redis_db_override(&json!({"db": -1})).is_err());
        assert!(redis_db_override(&json!({"db": true})).is_err());
    }

    #[test]
    fn redis_select_command_detection() {
        assert!(is_redis_select_command("SELECT 15"));
        assert!(is_redis_select_command("select 15"));
        // 组合命令(多语句尝试)也要拦下,给统一软引导
        assert!(is_redis_select_command("SELECT 15\nRPUSH k v"));
        assert!(is_redis_select_command("SELECT"));
        assert!(!is_redis_select_command("GET key"));
        assert!(!is_redis_select_command(""));
        // select 出现在参数位置不是切库命令
        assert!(!is_redis_select_command("SET select 1"));
    }

    // ---------- 结果格式化 ----------

    #[test]
    fn format_query_result_basic() {
        let value = json!({
            "columns": [{ "name": "id" }, { "name": "name" }],
            "rows": [[1, "alice"], [2, "bob"]],
            "rowsAffected": 0,
        });
        let text = format_query_result(&value);
        assert!(text.contains("列: id, name"), "{text}");
        assert!(text.contains("id=1 | name=alice"), "{text}");
        assert!(text.contains("id=2 | name=bob"), "{text}");
    }

    #[test]
    fn format_query_result_error_and_empty() {
        let err = format_query_result(&json!({ "error": "syntax error" }));
        assert!(err.contains("[Error] syntax error"), "{err}");
        let empty = format_query_result(&json!({ "columns": [], "rows": [], "rowsAffected": 3 }));
        assert!(empty.contains("3 行受影响"), "{empty}");
    }

    #[test]
    fn format_query_result_truncates_long_values() {
        let long = "x".repeat(300);
        let value = json!({
            "columns": [{ "name": "v" }],
            "rows": [[long]],
        });
        let text = format_query_result(&value);
        assert!(text.contains("…"), "{text}");
    }

    #[test]
    fn format_query_result_caps_at_twenty_rows() {
        let rows: Vec<Value> = (0..25).map(|i| json!([i])).collect();
        let text = format_query_result(&json!({ "columns": [{ "name": "i" }], "rows": rows }));
        assert!(text.contains("… (共 25 行)"), "{text}");
        assert_eq!(text.lines().count(), 22, "列头 + 20 行 + 省略行");
    }

    // ---------- Docker 连接参数(纯函数部分:不触网) ----------

    #[tokio::test]
    async fn docker_params_socket_defaults_to_the_system_socket() {
        let params = docker_params(&json!({}), None, None).await.unwrap();
        assert_eq!(params["transport"], "socket");
        assert_eq!(params["host"], "unix:///var/run/docker.sock");
    }

    #[tokio::test]
    async fn docker_params_tcp_uses_remote_host() {
        let params = docker_params(&json!({ "remoteHost": "docker.internal:2375" }), None, None)
            .await
            .unwrap();
        assert_eq!(params["transport"], "tcp");
        assert_eq!(params["host"], "docker.internal:2375");
    }

    #[tokio::test]
    async fn docker_params_ssh_requires_the_resolved_ssh_asset() {
        // 未解析 SSH 资产:Docker SSH 传输必须响亮失败,而不是静默退化
        let err = docker_params(&json!({ "dockerTransport": "ssh" }), None, None)
            .await
            .unwrap_err();
        assert!(err.contains("Docker SSH 传输"), "{err}");
    }

    #[tokio::test]
    async fn docker_params_ssh_rejects_unconfirmed_host_keys() {
        // 解析了 SSH 资产但 known_hosts 里没有该主机:与旧实现一致的软错误
        let ssh = json!({ "host": "10.0.0.7", "port": 22, "username": "root", "password": "pw" });
        let err = docker_params(&json!({ "dockerTransport": "ssh" }), Some(&ssh), None)
            .await
            .unwrap_err();
        assert!(err.contains("尚未确认主机密钥"), "{err}");
    }
}
