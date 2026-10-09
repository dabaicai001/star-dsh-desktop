//! UI 方法面 C 组(去 Tauri 化 M2):数据面连接(db / redis / es / docker / broker)。
//!
//! 工作台持有 connId,而**连接生命周期本来就在 Go sidecar 的连接池里**(connId
//! 就是跨进程概念),因此本组是**纯转发**:Tauri 版的
//! `src-tauri/src/commands/{db,docker,broker}.rs` 本身就是 `sidecar.call(rpc, params)`
//! 的薄封装,M2 把这层薄封装搬进 sidecar,反而少一次进程间往返。
//!
//! 两种参数形态(由 Tauri command 的签名决定,逐字保持):
//! - [`Shape::Wrapped`]:connect / test 类命令形如 `fn(params: Value)`,工作台把
//!   配置包在 `params` 键里下发 → 拆封后转发;
//! - [`Shape::Flat`]:连接面命令形如 `fn(conn_id: String, …)`,工作台平铺下发 →
//!   原样转发。
//!
//! `required` 是参数白名单(对应 Tauri 的非 Option 参数):缺失即 -32602,文案与
//! A/B 组一致("缺少 {key}");可选键一律**不下发默认值**,由 Go sidecar 自己兜
//! (同一份 Go 代码,默认值语义与 Tauri 版完全一致)。

use serde_json::Value;

use crate::db_runtime::DbRuntime;
use crate::jsonrpc::RpcError;

/// 参数形态:工作台下发的 JSON 与 Go RPC 参数的关系。
#[derive(Clone, Copy)]
enum Shape {
    /// 配置包在 `params` 键里(connect / test)。
    Wrapped,
    /// 平铺下发(连接面命令)。
    Flat,
}

/// Go RPC 目标:固定方法名,或 broker 的 `broker.{kind}.{verb}`。
enum Target {
    Fixed(&'static str),
    /// kind 白名单 kafka/nsq(文案与 Tauri 版 `unsupported broker: {kind}` 逐字一致)。
    Broker(&'static str),
}

impl Target {
    /// 解析出本次调用的 Go RPC 方法名。
    fn rpc(&self, params: &Value) -> Result<String, RpcError> {
        match self {
            Target::Fixed(rpc) => Ok((*rpc).to_string()),
            Target::Broker(verb) => {
                let kind = params
                    .get("kind")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                match kind {
                    "kafka" | "nsq" => Ok(format!("broker.{kind}.{verb}")),
                    _ => Err(RpcError::internal(format!("unsupported broker: {kind}"))),
                }
            }
        }
    }
}

/// 一条 C 组命令的转发契约。
pub struct Spec {
    /// 工作台命令名(bridge 的 invoke 端点已加 `ui.` 前缀,这里写全名)。
    pub command: &'static str,
    target: Target,
    shape: Shape,
    /// 必填参数(非 Option 参数);缺失即 -32602。
    required: &'static [&'static str],
}

/// C 组命令表(86 条):工作台 113 个命令里的数据面部分。
///
/// mysql 与 clickhouse 两个族保持**完全对称**(前端 `cmdPrefix` 在两者间切换,
/// 任何给一端加的命令另一端必须同时存在);postgres/sqlite/mssql 只有
/// connect/test/disconnect(前端只调这三个)。
pub const COMMANDS: &[Spec] = &[
    // ── MySQL(15) ──
    Spec {
        command: "ui.db_mysql_connect",
        target: Target::Fixed("db.mysql.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_mysql_test",
        target: Target::Fixed("db.mysql.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_mysql_disconnect",
        target: Target::Fixed("db.mysql.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_mysql_list_databases",
        target: Target::Fixed("db.mysql.listDatabases"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_mysql_list_tables",
        target: Target::Fixed("db.mysql.listTables"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_mysql_list_columns",
        target: Target::Fixed("db.mysql.listColumns"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_list_indexes",
        target: Target::Fixed("db.mysql.listIndexes"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_execute",
        target: Target::Fixed("db.mysql.execute"),
        shape: Shape::Flat,
        required: &["connId", "sql"],
    },
    Spec {
        command: "ui.db_mysql_explain",
        target: Target::Fixed("db.mysql.explain"),
        shape: Shape::Flat,
        required: &["connId", "sql"],
    },
    Spec {
        command: "ui.db_mysql_get_table_ddl",
        target: Target::Fixed("db.mysql.getTableDDL"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_drop_table",
        target: Target::Fixed("db.mysql.dropTable"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_truncate_table",
        target: Target::Fixed("db.mysql.truncateTable"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_get_table_data",
        target: Target::Fixed("db.mysql.getTableData"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_get_row_count",
        target: Target::Fixed("db.mysql.getRowCount"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_mysql_update_rows",
        target: Target::Fixed("db.mysql.updateRows"),
        shape: Shape::Flat,
        required: &["connId", "table", "sets", "where"],
    },
    // ── ClickHouse(15,与 MySQL 对称) ──
    Spec {
        command: "ui.db_clickhouse_connect",
        target: Target::Fixed("db.clickhouse.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_clickhouse_test",
        target: Target::Fixed("db.clickhouse.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_clickhouse_disconnect",
        target: Target::Fixed("db.clickhouse.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_clickhouse_list_databases",
        target: Target::Fixed("db.clickhouse.listDatabases"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_clickhouse_list_tables",
        target: Target::Fixed("db.clickhouse.listTables"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_clickhouse_list_columns",
        target: Target::Fixed("db.clickhouse.listColumns"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_list_indexes",
        target: Target::Fixed("db.clickhouse.listIndexes"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_execute",
        target: Target::Fixed("db.clickhouse.execute"),
        shape: Shape::Flat,
        required: &["connId", "sql"],
    },
    Spec {
        command: "ui.db_clickhouse_explain",
        target: Target::Fixed("db.clickhouse.explain"),
        shape: Shape::Flat,
        required: &["connId", "sql"],
    },
    Spec {
        command: "ui.db_clickhouse_get_table_ddl",
        target: Target::Fixed("db.clickhouse.getTableDDL"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_drop_table",
        target: Target::Fixed("db.clickhouse.dropTable"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_truncate_table",
        target: Target::Fixed("db.clickhouse.truncateTable"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_get_table_data",
        target: Target::Fixed("db.clickhouse.getTableData"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_get_row_count",
        target: Target::Fixed("db.clickhouse.getRowCount"),
        shape: Shape::Flat,
        required: &["connId", "table"],
    },
    Spec {
        command: "ui.db_clickhouse_update_rows",
        target: Target::Fixed("db.clickhouse.updateRows"),
        shape: Shape::Flat,
        required: &["connId", "table", "sets", "where"],
    },
    // ── PostgreSQL / SQLite / MSSQL(各 3:前端只调 connect / test / disconnect) ──
    Spec {
        command: "ui.db_postgres_connect",
        target: Target::Fixed("db.postgres.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_postgres_test",
        target: Target::Fixed("db.postgres.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_postgres_disconnect",
        target: Target::Fixed("db.postgres.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_sqlite_connect",
        target: Target::Fixed("db.sqlite.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_sqlite_test",
        target: Target::Fixed("db.sqlite.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_sqlite_disconnect",
        target: Target::Fixed("db.sqlite.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_mssql_connect",
        target: Target::Fixed("db.mssql.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_mssql_test",
        target: Target::Fixed("db.mssql.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_mssql_disconnect",
        target: Target::Fixed("db.mssql.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    // ── Redis(13) ──
    Spec {
        command: "ui.db_redis_connect",
        target: Target::Fixed("db.redis.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_redis_test",
        target: Target::Fixed("db.redis.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_redis_disconnect",
        target: Target::Fixed("db.redis.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_redis_select",
        target: Target::Fixed("db.redis.select"),
        shape: Shape::Flat,
        required: &["connId", "db"],
    },
    Spec {
        command: "ui.db_redis_db_size",
        target: Target::Fixed("db.redis.dbSize"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_redis_scan",
        target: Target::Fixed("db.redis.scan"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_redis_get_value",
        target: Target::Fixed("db.redis.getValue"),
        shape: Shape::Flat,
        required: &["connId", "key"],
    },
    Spec {
        command: "ui.db_redis_del",
        target: Target::Fixed("db.redis.del"),
        shape: Shape::Flat,
        required: &["connId", "keys"],
    },
    Spec {
        command: "ui.db_redis_rename",
        target: Target::Fixed("db.redis.rename"),
        shape: Shape::Flat,
        required: &["connId", "oldKey", "newKey"],
    },
    Spec {
        command: "ui.db_redis_set",
        target: Target::Fixed("db.redis.set"),
        shape: Shape::Flat,
        required: &["connId", "key", "value"],
    },
    Spec {
        command: "ui.db_redis_execute",
        target: Target::Fixed("db.redis.execute"),
        shape: Shape::Flat,
        required: &["connId", "command"],
    },
    Spec {
        command: "ui.db_redis_flush_db",
        target: Target::Fixed("db.redis.flushDb"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_redis_info",
        target: Target::Fixed("db.redis.info"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    // ── Elasticsearch(11) ──
    Spec {
        command: "ui.db_es_connect",
        target: Target::Fixed("db.es.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_es_test",
        target: Target::Fixed("db.es.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.db_es_disconnect",
        target: Target::Fixed("db.es.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_es_cluster_health",
        target: Target::Fixed("db.es.clusterHealth"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_es_list_indices",
        target: Target::Fixed("db.es.listIndices"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.db_es_get_index_mapping",
        target: Target::Fixed("db.es.getIndexMapping"),
        shape: Shape::Flat,
        required: &["connId", "index"],
    },
    Spec {
        command: "ui.db_es_get_index_settings",
        target: Target::Fixed("db.es.getIndexSettings"),
        shape: Shape::Flat,
        required: &["connId", "index"],
    },
    Spec {
        command: "ui.db_es_create_index",
        target: Target::Fixed("db.es.createIndex"),
        shape: Shape::Flat,
        required: &["connId", "index"],
    },
    Spec {
        command: "ui.db_es_delete_index",
        target: Target::Fixed("db.es.deleteIndex"),
        shape: Shape::Flat,
        required: &["connId", "index"],
    },
    Spec {
        command: "ui.db_es_search",
        target: Target::Fixed("db.es.search"),
        shape: Shape::Flat,
        required: &["connId", "index", "body"],
    },
    Spec {
        command: "ui.db_es_count",
        target: Target::Fixed("db.es.count"),
        shape: Shape::Flat,
        required: &["connId", "index"],
    },
    // ── Docker(21) ──
    Spec {
        command: "ui.docker_connect",
        target: Target::Fixed("docker.connect"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.docker_test",
        target: Target::Fixed("docker.test"),
        shape: Shape::Wrapped,
        required: &[],
    },
    Spec {
        command: "ui.docker_disconnect",
        target: Target::Fixed("docker.disconnect"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.docker_list_containers",
        target: Target::Fixed("docker.listContainers"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.docker_inspect_container",
        target: Target::Fixed("docker.inspectContainer"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_start_container",
        target: Target::Fixed("docker.startContainer"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_stop_container",
        target: Target::Fixed("docker.stopContainer"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_restart_container",
        target: Target::Fixed("docker.restartContainer"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_remove_container",
        target: Target::Fixed("docker.removeContainer"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_container_logs",
        target: Target::Fixed("docker.containerLogs"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_container_stats",
        target: Target::Fixed("docker.containerStats"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_list_images",
        target: Target::Fixed("docker.listImages"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.docker_pull_image",
        target: Target::Fixed("docker.pullImage"),
        shape: Shape::Flat,
        required: &["connId", "imageName"],
    },
    Spec {
        command: "ui.docker_remove_image",
        target: Target::Fixed("docker.removeImage"),
        shape: Shape::Flat,
        required: &["connId", "imageId"],
    },
    Spec {
        command: "ui.docker_prune_images",
        target: Target::Fixed("docker.pruneImages"),
        shape: Shape::Flat,
        required: &["connId"],
    },
    Spec {
        command: "ui.docker_exec",
        target: Target::Fixed("docker.exec"),
        shape: Shape::Flat,
        required: &["connId", "containerId", "command"],
    },
    Spec {
        command: "ui.docker_exec_session_start",
        target: Target::Fixed("docker.execSessionStart"),
        shape: Shape::Flat,
        required: &["connId", "containerId"],
    },
    Spec {
        command: "ui.docker_exec_session_read",
        target: Target::Fixed("docker.execSessionRead"),
        shape: Shape::Flat,
        required: &["connId", "sessionId"],
    },
    Spec {
        command: "ui.docker_exec_session_write",
        target: Target::Fixed("docker.execSessionWrite"),
        shape: Shape::Flat,
        required: &["connId", "sessionId", "data"],
    },
    Spec {
        command: "ui.docker_exec_session_resize",
        target: Target::Fixed("docker.execSessionResize"),
        shape: Shape::Flat,
        required: &["connId", "sessionId", "cols", "rows"],
    },
    Spec {
        command: "ui.docker_exec_session_close",
        target: Target::Fixed("docker.execSessionClose"),
        shape: Shape::Flat,
        required: &["connId", "sessionId"],
    },
    // ── Broker(2;kind 白名单在 Target::Broker 里) ──
    Spec {
        command: "ui.broker_test",
        target: Target::Broker("test"),
        shape: Shape::Flat,
        required: &["kind"],
    },
    Spec {
        command: "ui.broker_overview",
        target: Target::Broker("overview"),
        shape: Shape::Flat,
        required: &["kind"],
    },
];

/// 转发一条 C 组命令:参数白名单 → 拆封/平铺 → Go sidecar RPC。
///
/// Go 侧错误原文透传(`RPC error {code}: {message}` 或适配器错误),与 Tauri 版
/// `sidecar.call` 的用户可读文本一致。
pub async fn forward(db: &DbRuntime, spec: &Spec, params: &Value) -> Result<Value, RpcError> {
    for key in spec.required {
        let present = params.get(*key).is_some_and(|value| !value.is_null());
        if !present {
            return Err(RpcError::invalid_params(format!("缺少 {key}")));
        }
    }
    let rpc = spec.target.rpc(params)?;
    let payload = match spec.shape {
        Shape::Wrapped => params
            .get("params")
            .filter(|value| !value.is_null())
            .cloned()
            .ok_or_else(|| RpcError::invalid_params("缺少 params"))?,
        Shape::Flat => params.clone(),
    };
    db.go_sidecar()
        .call(&rpc, payload)
        .await
        .map_err(RpcError::internal)
}

/// 表内条目数(方法面计数断言用)。
pub const fn command_count() -> usize {
    COMMANDS.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetStore, MemorySecretStore};
    use crate::bindings::SessionBindings;
    use serde_json::json;
    use starhub_domain_ssh::events::MemoryKnownHostsStore;
    use std::sync::Arc;

    /// 资产库 + 假 Go sidecar(python fixture)的 DB 域运行时。
    fn runtime_in_temp(label: &str) -> (Arc<DbRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-ui-db-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("assets.json"), br#"{"assets":[]}"#).unwrap();
        let assets = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(MemorySecretStore::new()),
        ));
        let (python, args) =
            starhub_domain_db::fake_go_sidecar_command().expect("fake Go sidecar fixture present");
        let go = starhub_domain_db::GoSidecar::with_command(python, args);
        let known_hosts: Arc<dyn starhub_domain_ssh::events::KnownHostsStore> =
            Arc::new(MemoryKnownHostsStore::default());
        let runtime = Arc::new(DbRuntime::new(
            assets,
            Arc::new(go),
            known_hosts,
            Arc::new(SessionBindings::new()),
        ));
        (runtime, dir)
    }

    fn spec_of(command: &str) -> &'static Spec {
        COMMANDS
            .iter()
            .find(|spec| spec.command == command)
            .unwrap_or_else(|| panic!("表里没有 {command}"))
    }

    #[test]
    fn the_table_is_well_formed() {
        let mut names: Vec<&str> = COMMANDS.iter().map(|spec| spec.command).collect();
        let total = names.len();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "命令名重复:{names:?}");
        assert_eq!(
            total, 86,
            "C 组命令数(15+15+9+13+11+21+2),与 command_count() 一致"
        );
        assert_eq!(total, command_count());
        for spec in COMMANDS {
            assert!(
                spec.command.starts_with("ui."),
                "命令名必须带 ui. 前缀: {}",
                spec.command
            );
            assert!(
                spec.required.iter().all(|key| !key.is_empty()),
                "必填键不能是空串: {}",
                spec.command
            );
            match spec.target {
                Target::Fixed(rpc) => {
                    assert!(
                        rpc.starts_with("db.") || rpc.starts_with("docker."),
                        "{} 的 RPC 名异常: {rpc}",
                        spec.command
                    );
                }
                Target::Broker(verb) => {
                    assert!(
                        verb == "test" || verb == "overview",
                        "broker 动词只有 test/overview: {verb}"
                    );
                    assert_eq!(spec.required.len(), 1, "broker 命令只要求 kind");
                    assert_eq!(spec.required[0], "kind");
                }
            }
        }
        // mysql 与 clickhouse 两个族完全对称(前端 cmdPrefix 在两者间切换)
        let mysql_count = COMMANDS
            .iter()
            .filter(|spec| spec.command.starts_with("ui.db_mysql_"))
            .count();
        let clickhouse_count = COMMANDS
            .iter()
            .filter(|spec| spec.command.starts_with("ui.db_clickhouse_"))
            .count();
        assert_eq!(mysql_count, 15);
        assert_eq!(clickhouse_count, 15, "clickhouse 族与 mysql 族对称");
    }

    #[tokio::test]
    async fn wrapped_connect_unwraps_the_params_envelope() {
        let (db, dir) = runtime_in_temp("connect");
        let result = forward(
            &db,
            spec_of("ui.db_mysql_connect"),
            &json!({ "params": { "host": "db.internal", "port": 3306, "username": "root" } }),
        )
        .await
        .expect("connect roundtrip");
        // 假 Go sidecar 的 db.mysql.connect 回 connId;能拿到即证明拆封正确
        assert!(
            result["connId"]
                .as_str()
                .is_some_and(|id| id.starts_with("mysql-conn-")),
            "{result}"
        );
        // 缺 params 信封:参数错误(与 Tauri serde 边界同样拒绝)
        let error = forward(&db, spec_of("ui.db_mysql_connect"), &json!({}))
            .await
            .expect_err("缺 params");
        assert!(error.message.contains("缺少 params"), "{}", error.message);
        assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn flat_commands_forward_verbatim() {
        let (db, dir) = runtime_in_temp("flat");
        let result = forward(
            &db,
            spec_of("ui.db_mysql_disconnect"),
            &json!({ "connId": "mysql-conn-1" }),
        )
        .await
        .expect("disconnect roundtrip");
        assert_eq!(result, json!({ "ok": true }));
        // docker.listContainers 的罐头答案(证明平铺参数原样到达)
        let result = forward(
            &db,
            spec_of("ui.docker_list_containers"),
            &json!({ "connId": "docker-conn-1", "all": false }),
        )
        .await
        .expect("listContainers roundtrip");
        let items = result.as_array().expect("array");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["name"], "web");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_required_keys_are_invalid_params() {
        let (db, dir) = runtime_in_temp("required");
        for (command, params, missing) in [
            ("ui.db_mysql_disconnect", json!({}), "connId"),
            ("ui.db_mysql_execute", json!({ "connId": "c1" }), "sql"),
            (
                "ui.db_mysql_update_rows",
                json!({ "connId": "c1", "table": "t", "sets": {} }),
                "where",
            ),
            (
                "ui.docker_exec_session_write",
                json!({ "connId": "c1", "sessionId": "s1" }),
                "data",
            ),
            ("ui.broker_test", json!({ "params": {} }), "kind"),
        ] {
            let error = forward(&db, spec_of(command), &params)
                .await
                .expect_err("缺必填参数");
            assert_eq!(error.code, crate::jsonrpc::error_codes::INVALID_PARAMS);
            assert!(
                error.message.contains(&format!("缺少 {missing}")),
                "{command}: {}",
                error.message
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn broker_kind_is_allowlisted_with_the_tauri_wording() {
        let (db, dir) = runtime_in_temp("broker");
        for kind in ["kafka", "nsq"] {
            // 白名单内的 kind:走到 Go sidecar(假 sidecar 不认识 broker.*,回 method
            // not found —— 这证明 RPC 名确实是 broker.{kind}.test)
            let error = forward(
                &db,
                spec_of("ui.broker_test"),
                &json!({ "kind": kind, "params": { "host": "b.internal" } }),
            )
            .await
            .expect_err("假 sidecar 不实现 broker.*");
            assert!(
                error.message.contains(&format!("broker.{kind}.test")),
                "{kind}: {}",
                error.message
            );
        }
        for kind in ["rabbit", ""] {
            let error = forward(
                &db,
                spec_of("ui.broker_test"),
                &json!({ "kind": kind, "params": {} }),
            )
            .await
            .expect_err("白名单外 kind");
            assert_eq!(error.message, format!("unsupported broker: {kind}"));
            assert_eq!(error.code, crate::jsonrpc::error_codes::INTERNAL_ERROR);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
