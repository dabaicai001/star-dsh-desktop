use crate::db;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

/// 审计日志记录
#[derive(Debug, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: i64,
    pub timestamp: i64,
    pub category: String,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<Value>,
    pub session_id: Option<String>,
    pub asset_id: Option<String>,
    pub success: bool,
}

/// 审计统计项
#[derive(Debug, Serialize, Deserialize)]
pub struct AuditStatItem {
    pub category: String,
    pub date: String,
    pub total: i64,
    pub success: i64,
    pub failed: i64,
}

fn row_to_audit_log(row: &sqlx::sqlite::SqliteRow) -> Result<AuditLogEntry, sqlx::Error> {
    let detail_json: Option<String> = row.try_get("detail")?;
    let detail = detail_json.and_then(|s| serde_json::from_str(&s).ok());
    let success: i32 = row.try_get("success")?;

    Ok(AuditLogEntry {
        id: row.try_get("id")?,
        timestamp: row.try_get("timestamp")?,
        category: row.try_get("category")?,
        action: row.try_get("action")?,
        target: row.try_get("target")?,
        detail,
        session_id: row.try_get("session_id")?,
        asset_id: row.try_get("asset_id")?,
        success: success != 0,
    })
}

/// 审计日志条数上限:超出后自动删除最早的记录,只保留最新的这么多条
const MAX_AUDIT_ROWS: i64 = 5000;

/// 修剪审计日志表,只保留最新的 MAX_AUDIT_ROWS 条(按 timestamp、id 倒序)
async fn trim_audit_log(pool: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT ?)",
    )
    .bind(MAX_AUDIT_ROWS)
    .execute(pool)
    .await?;
    Ok(())
}

/// 写入一条审计日志并自动修剪(内部共用实现)。
///
/// 两个调用方:Tauri 命令 [`audit_log`](前端 UI / 设置页操作审计)与
/// `harness::tools` 的 AI 工具调用审计(category="ai")。写入成功后修剪
/// 失败只告警不阻断。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_audit_log(
    pool: &sqlx::SqlitePool,
    category: &str,
    action: &str,
    target: Option<&str>,
    detail: Option<Value>,
    session_id: Option<&str>,
    asset_id: Option<&str>,
    success: bool,
) -> Result<i64, String> {
    let now = chrono::Utc::now().timestamp();
    let detail_str = match &detail {
        Some(v) => Some(serde_json::to_string(v).map_err(|e| e.to_string())?),
        None => None,
    };

    let result = sqlx::query(
        "INSERT INTO audit_log (timestamp, category, action, target, detail, session_id, asset_id, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(now)
    .bind(category)
    .bind(action)
    .bind(target)
    .bind(&detail_str)
    .bind(session_id)
    .bind(asset_id)
    .bind(success as i32)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert audit log: {}", e))?;

    // 写入成功后自动修剪,超出上限只删最早记录;修剪失败只告警不阻断
    if let Err(e) = trim_audit_log(pool).await {
        tracing::warn!("Failed to trim audit log: {}", e);
    }

    Ok(result.last_insert_rowid())
}

/// 记录一条审计日志
#[tauri::command]
pub async fn audit_log(
    category: String,
    action: String,
    target: Option<String>,
    detail: Option<Value>,
    session_id: Option<String>,
    asset_id: Option<String>,
    success: Option<bool>,
) -> Result<i64, String> {
    let pool = db::get_pool()?;
    insert_audit_log(
        pool,
        &category,
        &action,
        target.as_deref(),
        detail,
        session_id.as_deref(),
        asset_id.as_deref(),
        success.unwrap_or(true),
    )
    .await
}

/// 查询审计日志(分页 + 类别筛选)
#[tauri::command]
pub async fn audit_list(
    limit: Option<i64>,
    offset: Option<i64>,
    category_filter: Option<String>,
) -> Result<Vec<AuditLogEntry>, String> {
    let pool = db::get_pool()?;
    let limit = limit.unwrap_or(200).min(1000);
    let offset = offset.unwrap_or(0);

    let rows = if let Some(cat) = category_filter {
        sqlx::query(
            "SELECT * FROM audit_log WHERE category = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        )
        .bind(&cat)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to query audit logs: {}", e))?
    } else {
        sqlx::query("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?")
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("Failed to query audit logs: {}", e))?
    };

    rows.iter()
        .map(row_to_audit_log)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse audit log: {e}"))
}

/// 清理指定时间戳之前的审计日志;不传则清理全部
#[tauri::command]
pub async fn audit_clear(before_timestamp: Option<i64>) -> Result<i64, String> {
    let pool = db::get_pool()?;

    let result = if let Some(before) = before_timestamp {
        sqlx::query("DELETE FROM audit_log WHERE timestamp < ?")
            .bind(before)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to clear audit logs: {}", e))?
    } else {
        sqlx::query("DELETE FROM audit_log")
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to clear audit logs: {}", e))?
    };

    Ok(result.rows_affected() as i64)
}

/// 审计统计(按类别 + 日期分组)
#[tauri::command]
pub async fn audit_stats() -> Result<Vec<AuditStatItem>, String> {
    let pool = db::get_pool()?;

    let rows = sqlx::query(
        "SELECT category,
                date(timestamp, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
         FROM audit_log
         GROUP BY category, day
         ORDER BY day DESC, category ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to query audit stats: {}", e))?;

    rows.iter()
        .map(|row| {
            Ok(AuditStatItem {
                category: row.try_get("category").map_err(|e| e.to_string())?,
                date: row.try_get("day").map_err(|e| e.to_string())?,
                total: row.try_get("total").map_err(|e| e.to_string())?,
                success: row.try_get("success").map_err(|e| e.to_string())?,
                failed: row
                    .try_get::<Option<i64>, _>("failed")
                    .map_err(|e| e.to_string())?
                    .unwrap_or(0),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建立 in-memory SQLite 池并创建 audit_log 表(与 db/schema.rs 结构一致)
    async fn setup_pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::query(
            "CREATE TABLE audit_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp INTEGER NOT NULL,
              category TEXT NOT NULL,
              action TEXT NOT NULL,
              target TEXT,
              detail TEXT,
              session_id TEXT,
              asset_id TEXT,
              success INTEGER NOT NULL DEFAULT 1
            )",
        )
        .execute(&pool)
        .await
        .expect("create audit_log table");
        pool
    }

    #[tokio::test]
    async fn trims_to_max_rows_keeping_newest() {
        let pool = setup_pool().await;
        let base = 1_000_000_i64;
        // 插入超过上限的 5050 条,timestamp 递增(越新越大)
        for i in 0..(MAX_AUDIT_ROWS + 50) {
            sqlx::query(
                "INSERT INTO audit_log (timestamp, category, action, success) VALUES (?, 'db', 'test', 1)",
            )
            .bind(base + i)
            .execute(&pool)
            .await
            .expect("insert audit log");
        }

        trim_audit_log(&pool).await.expect("trim audit log");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&pool)
            .await
            .expect("count rows");
        assert_eq!(count, MAX_AUDIT_ROWS, "修剪后应只剩上限条数");

        let min_ts: i64 = sqlx::query_scalar("SELECT MIN(timestamp) FROM audit_log")
            .fetch_one(&pool)
            .await
            .expect("min timestamp");
        assert_eq!(min_ts, base + 50, "最早 50 条应被删除,保留最新的");

        let max_ts: i64 = sqlx::query_scalar("SELECT MAX(timestamp) FROM audit_log")
            .fetch_one(&pool)
            .await
            .expect("max timestamp");
        assert_eq!(max_ts, base + MAX_AUDIT_ROWS + 49, "最新一条必须保留");
    }
}
