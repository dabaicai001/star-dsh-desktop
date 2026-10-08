#![allow(clippy::too_many_arguments)]

use std::collections::HashMap;

use crate::sidecar::SidecarManager;
use serde_json::Value;
use tauri::State;

// ─── MySQL Commands ───

#[tauri::command]
pub async fn db_mysql_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.mysql.connect", params).await
}

#[tauri::command]
pub async fn db_mysql_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.mysql.test", params).await
}

#[tauri::command]
pub async fn db_mysql_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.mysql.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

// ─── PostgreSQL Commands ───

#[tauri::command]
pub async fn db_postgres_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.postgres.connect", params).await
}

#[tauri::command]
pub async fn db_postgres_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.postgres.test", params).await
}

#[tauri::command]
pub async fn db_postgres_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.postgres.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_mysql_list_databases(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.mysql.listDatabases",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_mysql_list_tables(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.listTables", params).await
}

#[tauri::command]
pub async fn db_mysql_list_columns(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.listColumns", params).await
}

#[tauri::command]
pub async fn db_mysql_list_indexes(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.listIndexes", params).await
}

#[tauri::command]
pub async fn db_mysql_create_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    columns: Vec<String>,
    unique: bool,
    index_type: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
        "columns": columns,
        "unique": unique,
        "indexType": index_type,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.createIndex", params).await
}

#[tauri::command]
pub async fn db_mysql_drop_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.dropIndex", params).await
}

#[tauri::command]
pub async fn db_mysql_execute(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "sql": sql });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.execute", params).await
}

#[tauri::command]
pub async fn db_mysql_explain(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "sql": sql });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.explain", params).await
}

#[tauri::command]
pub async fn db_mysql_get_table_ddl(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.getTableDDL", params).await
}

#[tauri::command]
pub async fn db_mysql_get_table_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    limit: Option<i64>,
    offset: Option<i64>,
    order_by: Option<String>,
    order_dir: Option<String>,
    database: Option<String>,
    filter: Option<String>,
    column_filters: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(l) = limit {
        params["limit"] = serde_json::json!(l);
    }
    if let Some(o) = offset {
        params["offset"] = serde_json::json!(o);
    }
    if let Some(ob) = order_by {
        params["orderBy"] = serde_json::json!(ob);
    }
    if let Some(od) = order_dir {
        params["orderDir"] = serde_json::json!(od);
    }
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    if let Some(f) = &filter {
        params["filter"] = serde_json::json!(f);
    }
    if let Some(cf) = &column_filters {
        params["columnFilters"] = serde_json::json!(cf);
    }
    tracing::debug!("db_mysql_get_table_data");
    sidecar.call("db.mysql.getTableData", params).await
}

#[tauri::command]
pub async fn db_mysql_drop_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    if_exists: Option<bool>,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "ifExists": if_exists.unwrap_or(false)
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.dropTable", params).await
}

#[tauri::command]
pub async fn db_mysql_truncate_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.truncateTable", params).await
}

#[tauri::command]
pub async fn db_mysql_rename_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    old_name: String,
    new_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "oldName": old_name,
        "newName": new_name
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.renameTable", params).await
}

#[tauri::command]
pub async fn db_mysql_insert_row(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    values: Value,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "values": values
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.insertRow", params).await
}

#[tauri::command]
pub async fn db_mysql_update_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    sets: Value,
    where_clause: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "sets": sets,
        "where": where_clause
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.updateRows", params).await
}

#[tauri::command]
pub async fn db_mysql_delete_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    where_clause: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "where": where_clause
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.deleteRows", params).await
}

#[tauri::command]
pub async fn db_mysql_export_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    format: String,
    limit: Option<i64>,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table, "format": format });
    if let Some(l) = limit {
        params["limit"] = serde_json::json!(l);
    }
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.exportData", params).await
}

#[tauri::command]
pub async fn db_mysql_get_row_count(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.mysql.getRowCount", params).await
}

#[tauri::command]
pub async fn db_mysql_get_table_meta(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.getTableMeta", params).await
}

// ─── Redis Commands ───

#[tauri::command]
pub async fn db_redis_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.redis.connect", params).await
}

#[tauri::command]
pub async fn db_redis_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.redis.test", params).await
}

#[tauri::command]
pub async fn db_redis_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_select(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    db: i64,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.select",
            serde_json::json!({ "connId": conn_id, "db": db }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_scan(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    cursor: Option<u64>,
    match_pattern: Option<String>,
    count: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "cursor": cursor.unwrap_or(0) });
    if let Some(m) = match_pattern {
        params["match"] = serde_json::json!(m);
    }
    if let Some(c) = count {
        params["count"] = serde_json::json!(c);
    }
    sidecar.call("db.redis.scan", params).await
}

#[tauri::command]
pub async fn db_redis_get_value(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    key: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.getValue",
            serde_json::json!({ "connId": conn_id, "key": key }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_del(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.del",
            serde_json::json!({ "connId": conn_id, "keys": keys }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_rename(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    old_key: String,
    new_key: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.rename",
            serde_json::json!({
                "connId": conn_id,
                "oldKey": old_key,
                "newKey": new_key
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_set(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    key: String,
    value: String,
    expiration: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "key": key, "value": value });
    if let Some(e) = expiration {
        params["expiration"] = serde_json::json!(e);
    }
    sidecar.call("db.redis.set", params).await
}

#[tauri::command]
pub async fn db_redis_execute(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    command: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.execute",
            serde_json::json!({ "connId": conn_id, "command": command }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_info(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    section: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(s) = section {
        params["section"] = serde_json::json!(s);
    }
    sidecar.call("db.redis.info", params).await
}

#[tauri::command]
pub async fn db_redis_db_size(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call("db.redis.dbSize", serde_json::json!({ "connId": conn_id }))
        .await
}

#[tauri::command]
pub async fn db_redis_slowlog_get(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    count: i64,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.slowlogGet",
            serde_json::json!({ "connId": conn_id, "count": count }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_slowlog_reset(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.slowlogReset",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_scan_all(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    match_pattern: Option<String>,
    count: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(m) = match_pattern {
        params["match"] = serde_json::json!(m);
    }
    if let Some(c) = count {
        params["count"] = serde_json::json!(c);
    }
    sidecar.call("db.redis.scanAll", params).await
}

#[tauri::command]
pub async fn db_redis_bigkey_scan(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    match_pattern: Option<String>,
    string_threshold: Option<i64>,
    member_threshold: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(m) = match_pattern {
        params["match"] = serde_json::json!(m);
    }
    if let Some(s) = string_threshold {
        params["stringThreshold"] = serde_json::json!(s);
    }
    if let Some(c) = member_threshold {
        params["memberThreshold"] = serde_json::json!(c);
    }
    sidecar.call("db.redis.bigkeyScan", params).await
}

#[tauri::command]
pub async fn db_redis_memory_analysis(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    match_pattern: Option<String>,
    sample_size: Option<i32>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(m) = match_pattern {
        params["match"] = serde_json::json!(m);
    }
    if let Some(s) = sample_size {
        params["sampleSize"] = serde_json::json!(s);
    }
    sidecar.call("db.redis.memoryAnalysis", params).await
}

#[tauri::command]
pub async fn db_redis_flush_db(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call("db.redis.flushDb", serde_json::json!({ "connId": conn_id }))
        .await
}

// ─── Elasticsearch Commands ───

#[tauri::command]
pub async fn db_es_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.connect", params).await
}

#[tauri::command]
pub async fn db_es_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.test", params).await
}

#[tauri::command]
pub async fn db_es_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call("db.es.disconnect", serde_json::json!({ "connId": conn_id }))
        .await
}

#[tauri::command]
pub async fn db_es_cluster_health(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.clusterHealth",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_cluster_stats(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.clusterStats",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_list_indices(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.listIndices",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_get_index_mapping(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.getIndexMapping",
            serde_json::json!({ "connId": conn_id, "index": index }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_get_index_settings(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.getIndexSettings",
            serde_json::json!({ "connId": conn_id, "index": index }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_create_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    mappings: Option<Value>,
    settings: Option<Value>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index });
    if let Some(m) = mappings {
        params["mappings"] = m;
    }
    if let Some(s) = settings {
        params["settings"] = s;
    }
    sidecar.call("db.es.createIndex", params).await
}

#[tauri::command]
pub async fn db_es_delete_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.deleteIndex",
            serde_json::json!({ "connId": conn_id, "index": index }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_search(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Value,
    from: Option<usize>,
    size: Option<usize>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
    if let Some(f) = from {
        params["from"] = serde_json::json!(f);
    }
    if let Some(s) = size {
        params["size"] = serde_json::json!(s);
    }
    sidecar.call("db.es.search", params).await
}

#[tauri::command]
pub async fn db_es_count(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index });
    if let Some(b) = body {
        params["body"] = b;
    }
    sidecar.call("db.es.count", params).await
}

#[tauri::command]
pub async fn db_es_get_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.getDocument",
            serde_json::json!({ "connId": conn_id, "index": index, "id": id }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_index_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: Option<String>,
    body: Value,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
    if let Some(doc_id) = id {
        params["id"] = serde_json::json!(doc_id);
    }
    sidecar.call("db.es.indexDocument", params).await
}

#[tauri::command]
pub async fn db_es_update_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: String,
    body: Value,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.updateDocument",
            serde_json::json!({
                "connId": conn_id, "index": index, "id": id, "body": body
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_delete_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.deleteDocument",
            serde_json::json!({
                "connId": conn_id, "index": index, "id": id
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_bulk_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    documents: Value,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.es.bulkIndex",
            serde_json::json!({
                "connId": conn_id, "index": index, "documents": documents
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_es_export_json(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Option<Value>,
    size: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index });
    if let Some(b) = body {
        params["body"] = b;
    }
    if let Some(s) = size {
        params["size"] = serde_json::json!(s);
    }
    sidecar.call("db.es.exportJSON", params).await
}

#[tauri::command]
pub async fn db_es_scroll_search(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Value,
    size: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
    if let Some(s) = size {
        params["size"] = serde_json::json!(s);
    }
    sidecar.call("db.es.scrollSearch", params).await
}

// ─── ClickHouse Commands ───

#[tauri::command]
pub async fn db_clickhouse_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.clickhouse.connect", params).await
}

#[tauri::command]
pub async fn db_clickhouse_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.clickhouse.test", params).await
}

#[tauri::command]
pub async fn db_clickhouse_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.clickhouse.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_clickhouse_list_databases(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.clickhouse.listDatabases",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn db_clickhouse_list_tables(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.listTables", params).await
}

#[tauri::command]
pub async fn db_clickhouse_list_columns(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.listColumns", params).await
}

#[tauri::command]
pub async fn db_clickhouse_list_indexes(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.listIndexes", params).await
}

#[tauri::command]
pub async fn db_clickhouse_create_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    columns: Vec<String>,
    unique: bool,
    index_type: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
        "columns": columns,
        "unique": unique,
        "indexType": index_type,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.createIndex", params).await
}

#[tauri::command]
pub async fn db_clickhouse_drop_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.dropIndex", params).await
}

#[tauri::command]
pub async fn db_clickhouse_execute(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "sql": sql });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.execute", params).await
}

#[tauri::command]
pub async fn db_clickhouse_explain(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "sql": sql });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.explain", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_ddl(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.getTableDDL", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    limit: Option<i64>,
    offset: Option<i64>,
    order_by: Option<String>,
    order_dir: Option<String>,
    database: Option<String>,
    filter: Option<String>,
    column_filters: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(l) = limit {
        params["limit"] = serde_json::json!(l);
    }
    if let Some(o) = offset {
        params["offset"] = serde_json::json!(o);
    }
    if let Some(ob) = order_by {
        params["orderBy"] = serde_json::json!(ob);
    }
    if let Some(od) = order_dir {
        params["orderDir"] = serde_json::json!(od);
    }
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    if let Some(f) = &filter {
        params["filter"] = serde_json::json!(f);
    }
    if let Some(cf) = &column_filters {
        params["columnFilters"] = serde_json::json!(cf);
    }
    sidecar.call("db.clickhouse.getTableData", params).await
}

#[tauri::command]
pub async fn db_clickhouse_drop_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    if_exists: Option<bool>,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "ifExists": if_exists.unwrap_or(false)
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.dropTable", params).await
}

#[tauri::command]
pub async fn db_clickhouse_truncate_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.truncateTable", params).await
}

#[tauri::command]
pub async fn db_clickhouse_rename_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    old_name: String,
    new_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "oldName": old_name,
        "newName": new_name
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.renameTable", params).await
}

#[tauri::command]
pub async fn db_clickhouse_insert_row(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    values: Value,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "values": values
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.insertRow", params).await
}

#[tauri::command]
pub async fn db_clickhouse_update_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    sets: Value,
    where_clause: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "sets": sets,
        "where": where_clause
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.updateRows", params).await
}

#[tauri::command]
pub async fn db_clickhouse_delete_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    where_clause: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "where": where_clause
    });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.deleteRows", params).await
}

#[tauri::command]
pub async fn db_clickhouse_export_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    format: String,
    limit: Option<i64>,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table, "format": format });
    if let Some(l) = limit {
        params["limit"] = serde_json::json!(l);
    }
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.exportData", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_row_count(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.getRowCount", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_meta(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.getTableMeta", params).await
}

// ClickHouse 特有
#[tauri::command]
pub async fn db_clickhouse_get_partitions(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.getPartitions", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_merge_tree_info(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.getMergeTreeInfo", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_stats(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::json!(db);
    }
    sidecar.call("db.clickhouse.getTableStats", params).await
}

// ─── SQLite Commands ───

#[tauri::command]
pub async fn db_sqlite_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.sqlite.connect", params).await
}

#[tauri::command]
pub async fn db_sqlite_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.sqlite.test", params).await
}

#[tauri::command]
pub async fn db_sqlite_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.sqlite.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

// ─── MSSQL Commands ───

#[tauri::command]
pub async fn db_mssql_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.mssql.connect", params).await
}

#[tauri::command]
pub async fn db_mssql_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.mssql.test", params).await
}

#[tauri::command]
pub async fn db_mssql_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.mssql.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

// ─── Redis PubSub Commands ───

#[tauri::command]
pub async fn db_redis_subscribe(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.subscribe",
            serde_json::json!({
                "connId": conn_id,
                "channels": channels,
                "patterns": patterns
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_redis_unsubscribe(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    channels: Vec<String>,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.redis.unsubscribe",
            serde_json::json!({ "connId": conn_id, "channels": channels }),
        )
        .await
}

// ─── Backup / Restore Commands ───

#[tauri::command]
pub async fn db_backup(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    format: String,
    output_path: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.backup",
            serde_json::json!({
                "connId": conn_id,
                "format": format,
                "outputPath": output_path
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_restore(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    input_path: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.restore",
            serde_json::json!({
                "connId": conn_id,
                "inputPath": input_path
            }),
        )
        .await
}

#[tauri::command]
pub async fn db_list_backups(
    sidecar: State<'_, SidecarManager>,
    backup_dir: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "db.listBackups",
            serde_json::json!({ "backupDir": backup_dir }),
        )
        .await
}
