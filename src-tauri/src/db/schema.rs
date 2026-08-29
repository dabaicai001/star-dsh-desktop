pub const CREATE_TABLES: &str = "
-- 资产分组
CREATE TABLE IF NOT EXISTS asset_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (parent_id) REFERENCES asset_groups(id) ON DELETE SET NULL
);

-- 资产（连接）
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('ssh', 'db', 'docker', 'excel', 'local')),
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

-- 密钥
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('password', 'private_key')),
  encrypted_data BLOB,
  keyring_ref TEXT,
  fingerprint TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 快捷指令
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id INTEGER,
  command TEXT NOT NULL,
  description TEXT,
  variables TEXT DEFAULT '{}',
  scope TEXT CHECK(scope IN ('ssh', 'db', 'global')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- SQL 历史
CREATE TABLE IF NOT EXISTS sql_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id TEXT,
  sql TEXT NOT NULL,
  executed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  duration_ms INTEGER,
  rows_affected INTEGER,
  success INTEGER DEFAULT 1
);

-- 设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 已知主机密钥 (TOFU)
CREATE TABLE IF NOT EXISTS known_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_key TEXT NOT NULL UNIQUE,
  key_type TEXT NOT NULL,
  sha256_fingerprint TEXT NOT NULL,
  public_key BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  session_id TEXT,
  asset_id TEXT,
  success INTEGER NOT NULL DEFAULT 1
);

-- 告警规则
CREATE TABLE IF NOT EXISTS alert_rule (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,
  threshold REAL NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  cooldown_sec INTEGER NOT NULL DEFAULT 300,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- AI 记忆:会话
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  asset_id TEXT,
  asset_type TEXT,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AI 记忆:消息(FTS 依赖 rowid,不能用 WITHOUT ROWID)
CREATE TABLE IF NOT EXISTS ai_messages (
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls_json TEXT,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- AI 记忆:L1 热记忆条目(scope 三级:user / global / asset:{assetId})
CREATE TABLE IF NOT EXISTS ai_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 沙箱桌面:模板(配方 TOML 原文 + 构建产物镜像 tag)
CREATE TABLE IF NOT EXISTS sandbox_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  recipe TEXT NOT NULL,
  image_tag TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 沙箱桌面:实例(一次性容器;销毁保留行供回放归档)
CREATE TABLE IF NOT EXISTS sandbox_instances (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  container_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'local',
  novnc_port INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  session_id TEXT,
  task TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  destroyed_at INTEGER
);

-- 沙箱桌面:回放帧(每次写操作前的自动截屏留档)
CREATE TABLE IF NOT EXISTS sandbox_replay_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_id TEXT NOT NULL,
  action TEXT NOT NULL,
  shot_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- AI 记忆:消息全文索引(external-content,由触发器同步)
CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(
  content, content='ai_messages', content_rowid='rowid'
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_group_id ON assets(group_id);
CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_sql_history_conn_id ON sql_history(conn_id);
CREATE INDEX IF NOT EXISTS idx_sql_history_executed_at ON sql_history(executed_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category);
CREATE INDEX IF NOT EXISTS idx_audit_log_asset_id ON audit_log(asset_id);
CREATE INDEX IF NOT EXISTS idx_alert_rule_enabled ON alert_rule(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rule_category ON alert_rule(category);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_ai_memories_scope ON ai_memories(scope);
CREATE INDEX IF NOT EXISTS idx_sandbox_replay_sandbox ON sandbox_replay_frames(sandbox_id);

-- AI 记忆:FTS 同步触发器(external-content 标准三触发器)
CREATE TRIGGER IF NOT EXISTS ai_messages_ai AFTER INSERT ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS ai_messages_ad AFTER DELETE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS ai_messages_au AFTER UPDATE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO ai_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
";
