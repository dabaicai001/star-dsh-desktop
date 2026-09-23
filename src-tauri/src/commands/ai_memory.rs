use crate::db;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

/// AI 会话列表项(带消息数)
#[derive(Debug, Serialize, Deserialize)]
pub struct AiConversationRow {
    pub id: String,
    pub asset_id: Option<String>,
    pub asset_type: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

/// AI 消息行
#[derive(Debug, Serialize, Deserialize)]
pub struct AiMessageRow {
    pub rowid: i64,
    pub role: String,
    pub content: Option<String>,
    pub tool_calls_json: Option<String>,
    pub seq: i64,
    pub created_at: i64,
}

/// 消息同步输入(全量快照)
#[derive(Debug, Serialize, Deserialize)]
pub struct AiMessageInput {
    pub role: String,
    pub content: Option<String>,
    pub tool_calls_json: Option<String>,
    pub created_at: i64,
}

/// 全文检索命中项
#[derive(Debug, Serialize, Deserialize)]
pub struct AiSearchHit {
    pub conversation_id: String,
    pub conversation_title: String,
    pub rowid: i64,
    pub role: String,
    pub snippet: String,
    pub created_at: i64,
}

fn row_to_conversation(row: &sqlx::sqlite::SqliteRow) -> Result<AiConversationRow, sqlx::Error> {
    Ok(AiConversationRow {
        id: row.try_get("id")?,
        asset_id: row.try_get("asset_id")?,
        asset_type: row.try_get("asset_type")?,
        title: row.try_get("title")?,
        summary: row.try_get("summary")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        message_count: row.try_get("message_count")?,
    })
}

fn row_to_message(row: &sqlx::sqlite::SqliteRow) -> Result<AiMessageRow, sqlx::Error> {
    Ok(AiMessageRow {
        rowid: row.try_get("rowid")?,
        role: row.try_get("role")?,
        content: row.try_get("content")?,
        tool_calls_json: row.try_get("tool_calls_json")?,
        seq: row.try_get("seq")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn upsert_conversation(
    pool: &SqlitePool,
    id: &str,
    asset_id: Option<&str>,
    asset_type: Option<&str>,
    title: &str,
    summary: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO ai_conversations (id, asset_id, asset_type, title, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE ai_conversations.title END,
           asset_id = excluded.asset_id,
           asset_type = excluded.asset_type,
           summary = COALESCE(excluded.summary, ai_conversations.summary),
           updated_at = excluded.updated_at",
    )
    .bind(id)
    .bind(asset_id)
    .bind(asset_type)
    .bind(title)
    .bind(summary)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

async fn list_conversations(
    pool: &SqlitePool,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<AiConversationRow>, sqlx::Error> {
    let limit = limit.unwrap_or(100).min(1000);
    let offset = offset.unwrap_or(0);
    let rows = sqlx::query(
        "SELECT c.id, c.asset_id, c.asset_type, c.title, c.summary, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM ai_conversations c
         WHERE (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) > 0
         ORDER BY c.updated_at DESC
         LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_conversation).collect()
}

async fn get_conversation(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<AiConversationRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT c.id, c.asset_id, c.asset_type, c.title, c.summary, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM ai_conversations c
         WHERE c.id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.map(|r| row_to_conversation(&r)).transpose()
}

/// (pub(crate):dsh 工具桥 harness::tools 的 session_search 浏览/翻页复用)
pub(crate) async fn list_messages(
    pool: &SqlitePool,
    id: &str,
    before_rowid: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<AiMessageRow>, sqlx::Error> {
    let messages: Vec<AiMessageRow> = if let Some(before) = before_rowid {
        let limit = limit.unwrap_or(50).min(1000);
        let rows = sqlx::query(
            "SELECT rowid, role, content, tool_calls_json, seq, created_at
             FROM ai_messages
             WHERE conversation_id = ? AND rowid < ?
             ORDER BY seq DESC
             LIMIT ?",
        )
        .bind(id)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        let mut msgs: Vec<AiMessageRow> = rows
            .iter()
            .map(row_to_message)
            .collect::<Result<Vec<_>, _>>()?;
        msgs.reverse();
        msgs
    } else {
        let rows = sqlx::query(
            "SELECT rowid, role, content, tool_calls_json, seq, created_at
             FROM ai_messages
             WHERE conversation_id = ?
             ORDER BY seq ASC",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        rows.iter()
            .map(row_to_message)
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(messages)
}

async fn rename_conversation(pool: &SqlitePool, id: &str, title: &str) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?")
        .bind(title)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn delete_conversation(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 全量快照替换:删光该会话消息后按顺序重写(seq 从 0 递增),空 Vec 即清空
async fn sync_messages(
    pool: &SqlitePool,
    conversation_id: &str,
    messages: &[AiMessageInput],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM ai_messages WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    for (seq, msg) in messages.iter().enumerate() {
        sqlx::query(
            "INSERT INTO ai_messages (conversation_id, role, content, tool_calls_json, seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(conversation_id)
        .bind(&msg.role)
        .bind(&msg.content)
        .bind(&msg.tool_calls_json)
        .bind(seq as i64)
        .bind(msg.created_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn search_messages(
    pool: &SqlitePool,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<AiSearchHit>, sqlx::Error> {
    let limit = limit.unwrap_or(20).min(200);
    let rows = sqlx::query(
        "SELECT m.conversation_id, c.title AS conversation_title, m.rowid, m.role,
                snippet(ai_messages_fts, 0, '<mark>', '</mark>', '…', 32) AS snippet,
                m.created_at
         FROM ai_messages_fts
         JOIN ai_messages m ON m.rowid = ai_messages_fts.rowid
         JOIN ai_conversations c ON c.id = m.conversation_id
         WHERE ai_messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?",
    )
    .bind(query)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(AiSearchHit {
                conversation_id: row.try_get("conversation_id")?,
                conversation_title: row.try_get("conversation_title")?,
                rowid: row.try_get("rowid")?,
                role: row.try_get("role")?,
                snippet: row.try_get("snippet")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

/// 创建/更新会话(upsert;title 为空字符串时保留旧标题,summary 传 NULL 时保留旧值)
#[tauri::command]
pub async fn ai_conv_upsert(
    id: String,
    asset_id: Option<String>,
    asset_type: Option<String>,
    title: String,
    summary: Option<String>,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    upsert_conversation(
        pool,
        &id,
        asset_id.as_deref(),
        asset_type.as_deref(),
        &title,
        summary.as_deref(),
    )
    .await
    .map_err(|e| format!("Failed to upsert conversation: {}", e))
}

/// 会话列表(按更新时间倒序,只返回有消息的会话)
#[tauri::command]
pub async fn ai_conv_list(
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<AiConversationRow>, String> {
    let pool = db::get_pool()?;
    list_conversations(pool, limit, offset)
        .await
        .map_err(|e| format!("Failed to list conversations: {}", e))
}

/// 获取单个会话
#[tauri::command]
pub async fn ai_conv_get(id: String) -> Result<Option<AiConversationRow>, String> {
    let pool = db::get_pool()?;
    get_conversation(pool, &id)
        .await
        .map_err(|e| format!("Failed to get conversation: {}", e))
}

/// 会话消息:默认全部按 seq 升序;传 before_rowid 时取它之前最近的 limit 条(仍按 seq 升序返回)
#[tauri::command]
pub async fn ai_conv_messages(
    id: String,
    before_rowid: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<AiMessageRow>, String> {
    let pool = db::get_pool()?;
    list_messages(pool, &id, before_rowid, limit)
        .await
        .map_err(|e| format!("Failed to list messages: {}", e))
}

/// 重命名会话
#[tauri::command]
pub async fn ai_conv_rename(id: String, title: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    rename_conversation(pool, &id, &title)
        .await
        .map_err(|e| format!("Failed to rename conversation: {}", e))
}

/// 删除会话(级联删消息,FTS 由触发器同步)
#[tauri::command]
pub async fn ai_conv_delete(id: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    delete_conversation(pool, &id)
        .await
        .map_err(|e| format!("Failed to delete conversation: {}", e))
}

/// 全量快照同步消息(前端防抖后调用)
#[tauri::command]
pub async fn ai_msg_sync(
    conversation_id: String,
    messages: Vec<AiMessageInput>,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    sync_messages(pool, &conversation_id, &messages)
        .await
        .map_err(|e| format!("Failed to sync messages: {}", e))
}

/// 全文检索容错包装:非法 FTS 语法(fts5 解析错误)返回空列表而非报错
async fn search_messages_tolerant(
    pool: &SqlitePool,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<AiSearchHit>, String> {
    match search_messages(pool, query, limit).await {
        Ok(hits) => Ok(hits),
        // MATCH 表达式由前端原样传入,语法错误统一表现为 Database 错误,容错为空列表
        Err(sqlx::Error::Database(_)) => Ok(vec![]),
        Err(e) => Err(format!("Failed to search messages: {}", e)),
    }
}

/// 消息全文检索(非法 FTS 语法返回空列表,不报错)
#[tauri::command]
pub async fn ai_msg_search(query: String, limit: Option<i64>) -> Result<Vec<AiSearchHit>, String> {
    let pool = db::get_pool()?;
    search_messages_tolerant(pool, &query, limit).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// 建立 in-memory SQLite 池并执行完整 CREATE_TABLES(单连接,保证同一份内存库)
    async fn setup_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");
        sqlx::raw_sql(crate::db::schema::CREATE_TABLES)
            .execute(&pool)
            .await
            .expect("create tables");
        pool
    }

    fn msg(role: &str, content: Option<&str>, created_at: i64) -> AiMessageInput {
        AiMessageInput {
            role: role.to_string(),
            content: content.map(|s| s.to_string()),
            tool_calls_json: None,
            created_at,
        }
    }

    #[tokio::test]
    async fn upsert_creates_and_updates() {
        let pool = setup_pool().await;

        upsert_conversation(&pool, "c1", Some("a1"), Some("ssh"), "初始标题", None)
            .await
            .expect("insert");
        let conv = get_conversation(&pool, "c1")
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(conv.title, "初始标题");
        assert_eq!(conv.asset_id.as_deref(), Some("a1"));
        assert!(conv.summary.is_none());
        let created_at = conv.created_at;

        // 更新:title 非空覆盖,summary 补入
        upsert_conversation(&pool, "c1", Some("a2"), Some("db"), "新标题", Some("摘要"))
            .await
            .expect("update");
        let conv = get_conversation(&pool, "c1")
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(conv.title, "新标题");
        assert_eq!(conv.asset_id.as_deref(), Some("a2"));
        assert_eq!(conv.summary.as_deref(), Some("摘要"));
        assert_eq!(conv.created_at, created_at, "created_at 不应被更新覆盖");

        // title 传空串保留旧标题,summary 传 None 保留旧值
        upsert_conversation(&pool, "c1", None, None, "", None)
            .await
            .expect("update keep");
        let conv = get_conversation(&pool, "c1")
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(conv.title, "新标题", "空 title 不应覆盖旧标题");
        assert_eq!(conv.summary.as_deref(), Some("摘要"), "None 不应覆盖旧摘要");
        assert!(conv.asset_id.is_none(), "asset_id 应被新值(NULL)覆盖");
    }

    #[tokio::test]
    async fn msg_sync_replaces_snapshot() {
        let pool = setup_pool().await;
        upsert_conversation(&pool, "c1", None, None, "t", None)
            .await
            .expect("upsert");

        sync_messages(
            &pool,
            "c1",
            &[
                msg("user", Some("第一条"), 100),
                msg("assistant", Some("回复一"), 101),
            ],
        )
        .await
        .expect("sync 1");
        let msgs = list_messages(&pool, "c1", None, None).await.expect("list");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].seq, 0);
        assert_eq!(msgs[1].seq, 1);

        // 全量替换:旧消息应被删光
        sync_messages(&pool, "c1", &[msg("user", Some("全新内容"), 200)])
            .await
            .expect("sync 2");
        let msgs = list_messages(&pool, "c1", None, None).await.expect("list");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content.as_deref(), Some("全新内容"));
        assert_eq!(msgs[0].seq, 0);

        // 空 Vec 即清空
        sync_messages(&pool, "c1", &[]).await.expect("sync empty");
        let msgs = list_messages(&pool, "c1", None, None).await.expect("list");
        assert!(msgs.is_empty());
    }

    #[tokio::test]
    async fn search_hits_chinese_content() {
        let pool = setup_pool().await;
        upsert_conversation(&pool, "c1", None, None, "数据库会话", None)
            .await
            .expect("upsert");
        sync_messages(
            &pool,
            "c1",
            &[
                msg("user", Some("帮我查一下慢查询日志怎么开"), 100),
                msg(
                    "assistant",
                    Some("可以在 my.cnf 里设置 slow_query_log"),
                    101,
                ),
                msg("user", Some("另外备份策略怎么做"), 102),
            ],
        )
        .await
        .expect("sync");

        let hits = search_messages(&pool, "slow_query_log", None)
            .await
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, "c1");
        assert_eq!(hits[0].conversation_title, "数据库会话");
        assert_eq!(hits[0].role, "assistant");
        assert!(hits[0].snippet.contains("<mark>"), "片段应带高亮标记");
    }

    #[tokio::test]
    async fn delete_cascades_messages_and_fts() {
        let pool = setup_pool().await;
        upsert_conversation(&pool, "c1", None, None, "t", None)
            .await
            .expect("upsert");
        sync_messages(&pool, "c1", &[msg("user", Some("级联删除测试"), 100)])
            .await
            .expect("sync");

        delete_conversation(&pool, "c1").await.expect("delete");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_messages")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(count, 0, "删除会话应级联删除消息");

        // FTS 里也应搜不到(delete 触发器已同步)
        let hits = search_messages(&pool, "级联", None).await.expect("search");
        assert!(hits.is_empty(), "删除后 FTS 不应再命中");
    }

    #[tokio::test]
    async fn search_invalid_syntax_returns_empty() {
        let pool = setup_pool().await;
        upsert_conversation(&pool, "c1", None, None, "t", None)
            .await
            .expect("upsert");
        sync_messages(&pool, "c1", &[msg("user", Some("随便什么内容"), 100)])
            .await
            .expect("sync");

        // 非法 FTS 语法(未闭合引号):底层报错,command 层容错为空列表
        let result = search_messages(&pool, "\"未闭合", None).await;
        assert!(result.is_err(), "非法语法底层应报错");
        let hits = search_messages_tolerant(&pool, "\"未闭合", None)
            .await
            .expect("tolerant search");
        assert!(hits.is_empty(), "非法语法应容错返回空列表");
    }
}
