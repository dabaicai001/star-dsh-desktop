pub mod schema;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::str::FromStr;
use tauri::AppHandle;
use tauri::Manager;

static DB_POOL: once_cell::sync::OnceCell<SqlitePool> = once_cell::sync::OnceCell::new();

pub async fn init_database(app_handle: &AppHandle) -> Result<(), String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let db_path = app_dir.join("starhub.db");
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let options = SqliteConnectOptions::from_str(&db_url)
        .map_err(|e| format!("Failed to parse database URL: {}", e))?
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    // 创建表
    sqlx::raw_sql(schema::CREATE_TABLES)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create tables: {}", e))?;

    // 迁移:Excel 能力删除后收窄 assets 表 type CHECK(删历史 excel 资产行)
    migrate_assets_type_check(&pool).await?;
    migrate_asset_credentials(&pool).await?;

    DB_POOL
        .set(pool)
        .map_err(|_| "Database already initialized".to_string())?;

    tracing::info!("Database initialized at {:?}", db_path);
    Ok(())
}

async fn migrate_asset_credentials(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("SELECT id, config_json FROM assets WHERE key_id IS NULL")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to inspect asset credentials: {e}"))?;

    for row in rows {
        let id: String = row.try_get("id").map_err(|e| e.to_string())?;
        let config_json: String = row.try_get("config_json").map_err(|e| e.to_string())?;
        let config = serde_json::from_str(&config_json)
            .map_err(|e| format!("Invalid asset config for {id}: {e}"))?;
        let (config, secrets) = crate::keyring::split_config(config);
        if secrets.as_object().is_none_or(|values| values.is_empty()) {
            continue;
        }

        let key_id = format!("asset:{id}");
        let config_json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        sqlx::query("UPDATE assets SET config_json = ?, key_id = ? WHERE id = ?")
            .bind(config_json)
            .bind(&key_id)
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to migrate asset credentials: {e}"))?;
        crate::keyring::store(key_id, secrets).await?;
    }

    Ok(())
}

pub fn get_pool() -> Result<&'static SqlitePool, String> {
    DB_POOL
        .get()
        .ok_or_else(|| "Database not initialized".to_string())
}

/// 迁移:Excel 能力删除后把 assets 表的 type CHECK 约束收窄为
/// ('ssh', 'db', 'docker', 'local')——SQLite 不支持 ALTER CHECK,只能重建表。
/// 重建前先删掉历史 excel 资产行(工作簿文件不再由 StarHub 管理)。
async fn migrate_assets_type_check(pool: &SqlitePool) -> Result<(), String> {
    // 检测是否还需要迁移:DDL 里已没有 'excel' 即已迁移(或全新安装)
    let check = sqlx::query_scalar::<_, String>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='assets'",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(ddl) = check {
        if !ddl.contains("'excel'") {
            return Ok(()); // 已迁移
        }
    } else {
        return Ok(()); // 表还不存在(全新安装),schema 已不含 excel
    }

    tracing::info!("Migrating assets table to drop the 'excel' asset type...");

    sqlx::raw_sql(
        "BEGIN;
         CREATE TABLE assets_new (
           id TEXT PRIMARY KEY,
           type TEXT NOT NULL CHECK(type IN ('ssh', 'db', 'docker', 'local')),
           name TEXT NOT NULL,
           group_id INTEGER,
           config_json TEXT NOT NULL DEFAULT '{}',
           key_id TEXT,
           tags TEXT DEFAULT '[]',
           favorite INTEGER DEFAULT 0,
           last_used_at INTEGER,
           created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
           updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
           FOREIGN KEY (group_id) REFERENCES asset_groups(id) ON DELETE SET NULL
         );
         INSERT INTO assets_new SELECT * FROM assets WHERE type <> 'excel';
         DROP TABLE assets;
         ALTER TABLE assets_new RENAME TO assets;
         CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
         CREATE INDEX IF NOT EXISTS idx_assets_group_id ON assets(group_id);
         CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
         CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
         COMMIT;",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Migration failed: {}", e))?;

    tracing::info!("Assets table migration complete.");
    Ok(())
}
