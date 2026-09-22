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

// ---------- L1 热记忆(三级记忆卡) ----------

/// user / asset:{id} 卡的字符上限
pub const MEMORY_LIMIT_USER: i64 = 1375;
/// asset:{id} 卡上限与 user 相同,单独命名便于前端按 scope 类型取用
pub const MEMORY_LIMIT_ASSET: i64 = 1375;
/// global 卡的字符上限
pub const MEMORY_LIMIT_GLOBAL: i64 = 2200;
/// folder:<工作区路径> 卡的字符上限(工作区文件夹独立记忆)
pub const MEMORY_LIMIT_FOLDER: i64 = 2200;

/// 条目间分隔符("\n§\n",3 字符)
const MEMORY_SEPARATOR: &str = "\n§\n";

/// 记忆条目
#[derive(Debug, Serialize, Deserialize)]
pub struct AiMemoryRow {
    pub id: String,
    pub scope: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 记忆卡:某 scope 全部条目按 updated_at 升序拼接,供 system prompt 注入
#[derive(Debug, Serialize, Deserialize)]
pub struct AiMemoryCard {
    pub scope: String,
    pub content: String,
    pub char_count: i64,
    pub char_limit: i64,
    pub entry_count: i64,
}

fn row_to_memory(row: &sqlx::sqlite::SqliteRow) -> Result<AiMemoryRow, sqlx::Error> {
    Ok(AiMemoryRow {
        id: row.try_get("id")?,
        scope: row.try_get("scope")?,
        content: row.try_get("content")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// scope 对应字符上限:global 与 folder:* 2200,user 与 asset:* 1375
fn memory_scope_limit(scope: &str) -> i64 {
    if scope == "global" {
        MEMORY_LIMIT_GLOBAL
    } else if scope.starts_with("folder:") {
        MEMORY_LIMIT_FOLDER
    } else if scope.starts_with("asset:") {
        MEMORY_LIMIT_ASSET
    } else {
        MEMORY_LIMIT_USER
    }
}

/// 拼接后总字符数:各条目字符数和 + 分隔符 3 字符 × (n-1)
fn memory_joined_chars(contents: &[String]) -> i64 {
    let sum: i64 = contents.iter().map(|c| c.chars().count() as i64).sum();
    let seps = if contents.len() > 1 {
        3 * (contents.len() as i64 - 1)
    } else {
        0
    };
    sum + seps
}

/// 容量超限错误文案(原样回给 LLM,附全部条目供其合并重试)
fn memory_full_err(used: i64, limit: i64, contents: &[String]) -> String {
    let json = serde_json::to_string(contents).unwrap_or_else(|_| "[]".to_string());
    format!(
        "[FULL] {}/{} chars. 请先合并或删除条目再重试。当前条目: {}",
        used, limit, json
    )
}

/// 拉取某 scope 全部条目(按 updated_at 升序)
async fn memory_scope_entries(
    pool: &SqlitePool,
    scope: &str,
) -> Result<Vec<AiMemoryRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, scope, content, created_at, updated_at
         FROM ai_memories WHERE scope = ? ORDER BY updated_at ASC",
    )
    .bind(scope)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_memory).collect()
}

async fn list_memories(
    pool: &SqlitePool,
    scope: Option<&str>,
) -> Result<Vec<AiMemoryRow>, sqlx::Error> {
    let rows = if let Some(scope) = scope {
        sqlx::query(
            "SELECT id, scope, content, created_at, updated_at
             FROM ai_memories WHERE scope = ? ORDER BY scope, updated_at",
        )
        .bind(scope)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT id, scope, content, created_at, updated_at
             FROM ai_memories ORDER BY scope, updated_at",
        )
        .fetch_all(pool)
        .await?
    };
    rows.iter().map(row_to_memory).collect()
}

/// (pub(crate):dsh 桥 harness::mod 的 memory.cards 方法复用)
pub(crate) async fn build_memory_cards(
    pool: &SqlitePool,
    scopes: &[String],
) -> Result<Vec<AiMemoryCard>, sqlx::Error> {
    let mut cards = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let entries = memory_scope_entries(pool, scope).await?;
        let contents: Vec<String> = entries.iter().map(|e| e.content.clone()).collect();
        let content = contents.join(MEMORY_SEPARATOR);
        cards.push(AiMemoryCard {
            scope: scope.clone(),
            char_count: content.chars().count() as i64,
            char_limit: memory_scope_limit(scope),
            entry_count: entries.len() as i64,
            content,
        });
    }
    Ok(cards)
}

/// 子串匹配该 scope 内条目:0 / 1 / N 三种结果分别报错或返回唯一目标
fn memory_match_unique(entries: Vec<AiMemoryRow>, old_text: &str) -> Result<AiMemoryRow, String> {
    let matches: Vec<AiMemoryRow> = entries
        .into_iter()
        .filter(|e| e.content.contains(old_text))
        .collect();
    match matches.len() {
        0 => Err(format!(
            "[NOMATCH] 未找到包含该 old_text 的条目: {}",
            old_text
        )),
        1 => Ok(matches.into_iter().next().expect("len checked")),
        n => {
            let contents: Vec<&str> = matches.iter().map(|e| e.content.as_str()).collect();
            let json = serde_json::to_string(&contents).unwrap_or_else(|_| "[]".to_string());
            Err(format!(
                "[AMBIGUOUS] 匹配到 {} 条,请提供更精确的 old_text。匹配条目: {}",
                n, json
            ))
        }
    }
}

/// (pub(crate):dsh 工具桥 harness::tools 的 memory 工具复用写路径)
pub(crate) async fn add_memory(
    pool: &SqlitePool,
    scope: &str,
    content: &str,
) -> Result<AiMemoryRow, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }
    let entries = memory_scope_entries(pool, scope)
        .await
        .map_err(|e| format!("Failed to load memories: {}", e))?;
    if entries.iter().any(|e| e.content == content) {
        return Err("[DUPLICATE] 已存在完全相同条目,未重复添加。".to_string());
    }
    let limit = memory_scope_limit(scope);
    let used = memory_joined_chars(
        &entries
            .iter()
            .map(|e| e.content.clone())
            .chain(std::iter::once(content.to_string()))
            .collect::<Vec<_>>(),
    );
    if used > limit {
        let contents: Vec<String> = entries.iter().map(|e| e.content.clone()).collect();
        return Err(memory_full_err(used, limit, &contents));
    }
    let now = chrono::Utc::now().timestamp();
    let row = AiMemoryRow {
        id: uuid::Uuid::new_v4().to_string(),
        scope: scope.to_string(),
        content: content.to_string(),
        created_at: now,
        updated_at: now,
    };
    sqlx::query(
        "INSERT INTO ai_memories (id, scope, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.scope)
    .bind(&row.content)
    .bind(row.created_at)
    .bind(row.updated_at)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to add memory: {}", e))?;
    Ok(row)
}

pub(crate) async fn replace_memory(
    pool: &SqlitePool,
    scope: &str,
    old_text: &str,
    content: &str,
) -> Result<AiMemoryRow, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }
    let entries = memory_scope_entries(pool, scope)
        .await
        .map_err(|e| format!("Failed to load memories: {}", e))?;
    // 替换不改变条目数,容量按 旧总长 - 旧条目 + 新内容 计算
    let old_total = memory_joined_chars(
        &entries
            .iter()
            .map(|e| e.content.clone())
            .collect::<Vec<_>>(),
    );
    let contents: Vec<String> = entries.iter().map(|e| e.content.clone()).collect();
    let target = memory_match_unique(entries, old_text)?;
    let used = old_total - target.content.chars().count() as i64 + content.chars().count() as i64;
    let limit = memory_scope_limit(scope);
    if used > limit {
        return Err(memory_full_err(used, limit, &contents));
    }
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE ai_memories SET content = ?, updated_at = ? WHERE id = ?")
        .bind(content)
        .bind(now)
        .bind(&target.id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to replace memory: {}", e))?;
    Ok(AiMemoryRow {
        id: target.id,
        scope: target.scope,
        content: content.to_string(),
        created_at: target.created_at,
        updated_at: now,
    })
}

pub(crate) async fn remove_memory(
    pool: &SqlitePool,
    scope: &str,
    old_text: &str,
) -> Result<String, String> {
    let entries = memory_scope_entries(pool, scope)
        .await
        .map_err(|e| format!("Failed to load memories: {}", e))?;
    let target = memory_match_unique(entries, old_text)?;
    sqlx::query("DELETE FROM ai_memories WHERE id = ?")
        .bind(&target.id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to remove memory: {}", e))?;
    Ok(target.id)
}

async fn delete_memory(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_memories WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn update_memory(pool: &SqlitePool, id: &str, content: &str) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }
    let row = sqlx::query(
        "SELECT id, scope, content, created_at, updated_at FROM ai_memories WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to load memory: {}", e))?;
    let target = match row {
        Some(r) => row_to_memory(&r).map_err(|e| format!("Failed to load memory: {}", e))?,
        None => return Err(format!("[NOMATCH] 未找到 id 为 {} 的条目", id)),
    };
    let scope_entries = memory_scope_entries(pool, &target.scope)
        .await
        .map_err(|e| format!("Failed to load memories: {}", e))?;
    let old_total = memory_joined_chars(
        &scope_entries
            .iter()
            .map(|e| e.content.clone())
            .collect::<Vec<_>>(),
    );
    let used = old_total - target.content.chars().count() as i64 + content.chars().count() as i64;
    let limit = memory_scope_limit(&target.scope);
    if used > limit {
        let contents: Vec<String> = scope_entries.iter().map(|e| e.content.clone()).collect();
        return Err(memory_full_err(used, limit, &contents));
    }
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE ai_memories SET content = ?, updated_at = ? WHERE id = ?")
        .bind(content)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update memory: {}", e))?;
    Ok(())
}

/// 列出记忆条目:不传 scope 返回全部(按 scope, updated_at 排序),传了按 scope 精确过滤
#[tauri::command]
pub async fn ai_memory_list(scope: Option<String>) -> Result<Vec<AiMemoryRow>, String> {
    let pool = db::get_pool()?;
    list_memories(pool, scope.as_deref())
        .await
        .map_err(|e| format!("Failed to list memories: {}", e))
}

/// 批量取记忆卡(system prompt 注入用)
#[tauri::command]
pub async fn ai_memory_cards(scopes: Vec<String>) -> Result<Vec<AiMemoryCard>, String> {
    let pool = db::get_pool()?;
    build_memory_cards(pool, &scopes)
        .await
        .map_err(|e| format!("Failed to build memory cards: {}", e))
}

/// 新增记忆条目(trim、精确去重、容量检查)
#[tauri::command]
pub async fn ai_memory_add(scope: String, content: String) -> Result<AiMemoryRow, String> {
    let pool = db::get_pool()?;
    add_memory(pool, &scope, &content).await
}

/// 按唯一子串定位并替换条目内容(容量检查同 add)
#[tauri::command]
pub async fn ai_memory_replace(
    scope: String,
    old_text: String,
    content: String,
) -> Result<AiMemoryRow, String> {
    let pool = db::get_pool()?;
    replace_memory(pool, &scope, &old_text, &content).await
}

/// 按唯一子串定位并删除条目,返回被删条目 id
#[tauri::command]
pub async fn ai_memory_remove(scope: String, old_text: String) -> Result<String, String> {
    let pool = db::get_pool()?;
    remove_memory(pool, &scope, &old_text).await
}

/// 按 id 直删(Settings 管理 UI 用)
#[tauri::command]
pub async fn ai_memory_delete(id: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    delete_memory(pool, &id)
        .await
        .map_err(|e| format!("Failed to delete memory: {}", e))
}

/// 按 id 直改内容(Settings 管理 UI 用,做容量检查)
#[tauri::command]
pub async fn ai_memory_update(id: String, content: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    update_memory(pool, &id, &content).await
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

    // ---------- L1 热记忆 ----------

    #[tokio::test]
    async fn memory_add_rejects_empty_and_duplicate() {
        let pool = setup_pool().await;

        let err = add_memory(&pool, "user", "   ")
            .await
            .expect_err("空内容应报错");
        assert!(!err.starts_with('['), "空内容是普通错误,不带前缀");

        let row = add_memory(&pool, "user", "生产库 DDL 前先备份")
            .await
            .expect("add");
        assert_eq!(row.scope, "user");
        assert!(!row.id.is_empty(), "id 应为 uuid");

        // 完全相同内容(含 trim 后相同)→ [DUPLICATE],不写入
        let err = add_memory(&pool, "user", " 生产库 DDL 前先备份 ")
            .await
            .expect_err("重复应报错");
        assert!(err.starts_with("[DUPLICATE]"), "应为去重错误: {}", err);
        // 不同 scope 的相同内容不算重复
        add_memory(&pool, "global", "生产库 DDL 前先备份")
            .await
            .expect("不同 scope 可重复内容");
        let all = list_memories(&pool, None).await.expect("list");
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn memory_add_rejects_over_limit() {
        let pool = setup_pool().await;
        // user 上限 1375:先加一条 1370 字符,再加一条会超(1370 + 3 + 10 > 1375)
        let long = "长".repeat(1370);
        add_memory(&pool, "user", &long).await.expect("add long");
        let err = add_memory(&pool, "user", "再来十个字符凑凑数")
            .await
            .expect_err("超限应报错");
        assert!(err.starts_with("[FULL]"), "应为容量错误: {}", err);
        assert!(err.contains(&long), "错误应附当前全部条目");
        assert!(err.contains("/1375 chars"), "应带用量/上限: {}", err);
        // 未写入
        let all = list_memories(&pool, Some("user")).await.expect("list");
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn memory_replace_match_semantics() {
        let pool = setup_pool().await;
        add_memory(&pool, "user", "staging SSH 端口 2222")
            .await
            .expect("add 1");
        add_memory(&pool, "user", "prod SSH 端口 22")
            .await
            .expect("add 2");

        // 0 条匹配
        let err = replace_memory(&pool, "user", "不存在的文本", "x")
            .await
            .expect_err("无匹配应报错");
        assert!(err.starts_with("[NOMATCH]"), "应为 NOMATCH: {}", err);

        // 多条匹配("端口" 两条都含)
        let err = replace_memory(&pool, "user", "端口", "x")
            .await
            .expect_err("多匹配应报错");
        assert!(err.starts_with("[AMBIGUOUS]"), "应为 AMBIGUOUS: {}", err);
        assert!(err.contains("匹配到 2 条"), "应带条数: {}", err);
        assert!(err.contains("2222"), "应附匹配条目: {}", err);

        // 恰好 1 条:替换成功,updated_at 变化
        let row = replace_memory(&pool, "user", "2222", "staging SSH 端口 2223")
            .await
            .expect("replace");
        assert_eq!(row.content, "staging SSH 端口 2223");
        let entries = list_memories(&pool, Some("user")).await.expect("list");
        assert_eq!(entries.len(), 2, "替换不应改变条目数");
        let hit = entries.iter().find(|e| e.content.contains("2223"));
        assert!(hit.is_some(), "新内容应落库");
    }

    #[tokio::test]
    async fn memory_replace_respects_limit() {
        let pool = setup_pool().await;
        add_memory(&pool, "user", "短条目").await.expect("add");
        let big = "大".repeat(2000);
        let err = replace_memory(&pool, "user", "短条目", &big)
            .await
            .expect_err("替换后超限应报错");
        assert!(err.starts_with("[FULL]"), "应为容量错误: {}", err);
        // 原内容未被改动
        let entries = list_memories(&pool, Some("user")).await.expect("list");
        assert_eq!(entries[0].content, "短条目");
    }

    #[tokio::test]
    async fn memory_remove_match_semantics() {
        let pool = setup_pool().await;
        let a = add_memory(&pool, "global", "统一 Debian 12")
            .await
            .expect("add 1");
        add_memory(&pool, "global", "sudo 免密已配置")
            .await
            .expect("add 2");

        let err = remove_memory(&pool, "global", "不存在")
            .await
            .expect_err("无匹配应报错");
        assert!(err.starts_with("[NOMATCH]"), "应为 NOMATCH: {}", err);

        let removed_id = remove_memory(&pool, "global", "Debian")
            .await
            .expect("remove");
        assert_eq!(removed_id, a.id, "应返回被删条目 id");
        let entries = list_memories(&pool, Some("global")).await.expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].content, "sudo 免密已配置");
    }

    #[tokio::test]
    async fn memory_cards_join_with_separator() {
        let pool = setup_pool().await;
        add_memory(&pool, "user", "条目甲").await.expect("add 1");
        add_memory(&pool, "user", "条目乙").await.expect("add 2");
        add_memory(&pool, "asset:a1", "资产记忆")
            .await
            .expect("add 3");

        let cards = build_memory_cards(
            &pool,
            &[
                "user".to_string(),
                "asset:a1".to_string(),
                "global".to_string(),
            ],
        )
        .await
        .expect("cards");
        assert_eq!(cards.len(), 3);

        let user = &cards[0];
        assert_eq!(user.content, "条目甲\n§\n条目乙");
        assert_eq!(user.entry_count, 2);
        // 3 + 3 + 3(分隔符)= 9
        assert_eq!(user.char_count, 9);
        assert_eq!(user.char_limit, MEMORY_LIMIT_USER);

        let asset = &cards[1];
        assert_eq!(asset.char_limit, MEMORY_LIMIT_ASSET);
        assert_eq!(asset.entry_count, 1);

        // 空 scope:空卡,上限 2200
        let global = &cards[2];
        assert_eq!(global.content, "");
        assert_eq!(global.char_count, 0);
        assert_eq!(global.char_limit, MEMORY_LIMIT_GLOBAL);
    }

    #[tokio::test]
    async fn memory_delete_and_update_by_id() {
        let pool = setup_pool().await;
        let a = add_memory(&pool, "user", "待更新条目")
            .await
            .expect("add 1");
        let b = add_memory(&pool, "user", "待删除条目")
            .await
            .expect("add 2");

        // update:内容直改,容量检查
        update_memory(&pool, &a.id, "已更新的内容")
            .await
            .expect("update");
        let entries = list_memories(&pool, Some("user")).await.expect("list");
        let updated = entries.iter().find(|e| e.id == a.id).expect("exists");
        assert_eq!(updated.content, "已更新的内容");

        let err = update_memory(&pool, &a.id, &"超".repeat(2000))
            .await
            .expect_err("update 超限应报错");
        assert!(err.starts_with("[FULL]"), "应为容量错误: {}", err);

        let err = update_memory(&pool, "no-such-id", "x")
            .await
            .expect_err("不存在 id 应报错");
        assert!(err.starts_with("[NOMATCH]"), "应为 NOMATCH: {}", err);

        // delete:按 id 直删
        delete_memory(&pool, &b.id).await.expect("delete");
        let entries = list_memories(&pool, Some("user")).await.expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, a.id);
    }

    #[tokio::test]
    async fn memory_list_filtering() {
        let pool = setup_pool().await;
        add_memory(&pool, "user", "u1").await.expect("add");
        add_memory(&pool, "global", "g1").await.expect("add");
        add_memory(&pool, "asset:x", "a1").await.expect("add");

        let all = list_memories(&pool, None).await.expect("list all");
        assert_eq!(all.len(), 3);
        // 按 scope 字典序:asset:x < global < user
        assert_eq!(all[0].scope, "asset:x");
        assert_eq!(all[1].scope, "global");
        assert_eq!(all[2].scope, "user");

        let only = list_memories(&pool, Some("asset:x"))
            .await
            .expect("list scope");
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].content, "a1");
    }
}
