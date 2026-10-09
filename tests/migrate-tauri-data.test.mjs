/**
 * Tauri → sidecar 一次性数据导入(去 Tauri 化 §六 / R7)。
 *
 * 关键断言分两类:
 * 1. **形状**:旧 SQLite 的行 → sidecar 各 JSON 文件的线形状(资产 camelCase、
 *    告警/审计 snake_case、设置平铺),逐字段钉死——形状漂了,sidecar 读回来
 *    就是另一份数据;
 * 2. **双跑期校验**:导入后把新存储读回来与旧库导出逐条比对,一致才退 0;
 *    故意篡改一个字段,校验必须抓到并非零退出(R7 的核心承诺);
 * 3. **不搬的表**:sql_history / snippets / ai_* / sandbox_* / *_replay_frames
 *    不出现在任何目标文件里;
 * 4. **幂等**:重跑一次全部 unchanged,且不产生第二份 .bak;
 * 5. **审计修剪**:超过 5000 条只保留最新 5000(与 sidecar trim 同序)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repoRoot, 'scripts', 'migrate-tauri-data.mjs')

/** 按旧 Tauri schema 造一个带各类数据的 SQLite(形状照抄退役前的 schema.rs)。 */
function buildOldDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE asset_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER, icon TEXT, sort_order INTEGER DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE assets (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, group_id INTEGER, config_json TEXT NOT NULL DEFAULT '{}', key_id TEXT, tags TEXT DEFAULT '[]', favorite INTEGER DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE alert_rule (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, category TEXT NOT NULL, metric TEXT NOT NULL, operator TEXT NOT NULL, threshold REAL NOT NULL, duration_sec INTEGER NOT NULL DEFAULT 0, webhook_url TEXT, cooldown_sec INTEGER NOT NULL DEFAULT 300, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, session_id TEXT, asset_id TEXT, success INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE known_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, host_key TEXT NOT NULL UNIQUE, key_type TEXT NOT NULL, sha256_fingerprint TEXT NOT NULL, public_key BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sql_history (id INTEGER PRIMARY KEY AUTOINCREMENT, conn_id TEXT, sql TEXT NOT NULL, executed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE snippets (id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL);
    CREATE TABLE ai_conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sandbox_instances (id TEXT PRIMARY KEY, container_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sandbox_replay_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, sandbox_id TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
  `)
  db.prepare('INSERT INTO asset_groups (id, name) VALUES (?, ?)').run(7, '生产环境')
  db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'a1', 'ssh', '跳板机', 7,
    JSON.stringify({ host: '10.0.0.5', port: 22, username: 'root', password: 's3cret' }),
    'asset:a1', JSON.stringify(['prod', 'ssh']), 1, 1700000000, 1699999999, 1700000001,
  )
  db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'a2', 'db', 'MySQL 主库', null,
    JSON.stringify({ dbType: 'mysql', host: 'db.internal', port: 3306 }),
    null, JSON.stringify([]), 0, null, 1699990000, 1699990000,
  )
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('android.adb_path', 'D:/platform-tools/adb.exe', 1)
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('browser.engine', 'webview', 1)
  db.prepare('INSERT INTO alert_rule VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'r1', 'CPU 高', 1, 'ai', 'cpu', '>', 90.5, 60, 'https://hooks.example/x', 300, 1699990000, 1699990000,
  )
  db.prepare('INSERT INTO alert_rule VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'r2', '磁盘低', 0, 'db', 'disk', '<', 10, 0, null, 600, 1699990001, 1699990001,
  )
  db.prepare('INSERT INTO audit_log (timestamp, category, action, target, detail, session_id, asset_id, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1700000100, 'ai', 'ssh_exec', 'a1', JSON.stringify({ command: 'ls' }), 's1', 'a1', 1)
  db.prepare('INSERT INTO audit_log (timestamp, category, action, target, detail, session_id, asset_id, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1700000200, 'db', 'db_query', 'a2', null, 's1', 'a2', 0)
  db.prepare('INSERT INTO known_hosts (host_key, key_type, sha256_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('10.0.0.5', 'ssh-ed25519', 'SHA256:abc', Buffer.from([1, 2, 3, 4]), 1699990000)
  // 不该被搬的表
  db.prepare('INSERT INTO sql_history (conn_id, sql) VALUES (?, ?)').run('c1', 'SELECT 1')
  db.prepare('INSERT INTO snippets VALUES (?, ?, ?)').run('p1', '重启', 'systemctl restart nginx')
  db.prepare('INSERT INTO ai_conversations VALUES (?, ?, ?)').run('conv1', '旧对话', 1)
  db.prepare('INSERT INTO sandbox_instances VALUES (?, ?, ?)').run('box1', 'container1', 1)
  db.prepare('INSERT INTO sandbox_replay_frames (sandbox_id, action) VALUES (?, ?)').run('box1', 'tap(1,2)')
  db.close()
}

function tmpDir(label) {
  const dir = join(tmpdir(), `starhub-migrate-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function run(dbPath, outDir, extra = []) {
  return spawnSync(process.execPath, [script, '--db', dbPath, '--out', outDir, ...extra], {
    encoding: 'utf8',
  })
}

test('imports assets in the sidecar camelCase shape and skips non-user tables', (t) => {
  const root = tmpDir('assets')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')

  const result = run(dbPath, out)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

  const doc = JSON.parse(readFileSync(join(out, 'starhub-assets.json'), 'utf8'))
  // 顺序 = 老库自然行序(sidecar 的 AssetStore::list() 是文件顺序即返回顺序;
  // 迁移不重排,否则用户在工作台看到的资产顺序和旧壳不一致)
  assert.deepEqual(doc.assets.map(a => a.id), ['a1', 'a2'], '保持老库插入序')
  const a1 = doc.assets[0]
  // camelCase 线形状(AssetRecord::to_json)
  assert.equal(a1.type, 'ssh')
  assert.equal(a1.keyId, 'asset:a1')
  assert.equal(a1.groupId, 7)
  assert.deepEqual(a1.tags, ['prod', 'ssh'])
  assert.equal(a1.favorite, true)
  assert.equal(a1.lastUsedAt, 1700000000)
  assert.equal(a1.createdAt, 1699999999)
  assert.equal(a1.updatedAt, 1700000001)
  // config 原样(含敏感字段:敏感字段的剥离发生在 sidecar 读取时,不发生在导入时)
  assert.equal(a1.config.password, 's3cret')
  const a2 = doc.assets[1]
  assert.equal(a2.groupId, null, '无分组')
  assert.equal(a2.keyId, null)

  // 不搬的表不出现在任何目标文件里
  for (const name of readdirSync(out)) {
    const text = readFileSync(join(out, name), 'utf8')
    for (const forbidden of ['sql_history', 'snippet', 'ai_conversation', 'sandbox', 'replay']) {
      assert.ok(!text.includes(forbidden), `${name} 不该含 ${forbidden}`)
    }
  }
  assert.ok(!existsSync(join(out, 'starhub-sql-history.json')))
})

test('imports settings / alerts / audit / known_hosts in their sidecar shapes', (t) => {
  const root = tmpDir('shapes')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')
  assert.equal(run(dbPath, out).status, 0)

  // settings:平铺对象(FileSettingsStore 的 read_all 形状)
  const settings = JSON.parse(readFileSync(join(out, 'starhub-settings.json'), 'utf8'))
  assert.deepEqual(settings, {
    'android.adb_path': 'D:/platform-tools/adb.exe',
    'browser.engine': 'webview',
  })

  // alerts:snake_case + SQL 同款缺省。顺序 = 插入序(sidecar 的 list() 是
  // 文件数组 reverse(),迁移重排会让用户看到的顺序和旧壳不一致)
  const alerts = JSON.parse(readFileSync(join(out, 'starhub-alerts.json'), 'utf8'))
  assert.equal(alerts.length, 2)
  assert.equal(alerts[0].id, 'r1', '保持老库插入序')
  assert.equal(alerts[0].enabled, true)
  assert.equal(alerts[0].threshold, 90.5)
  assert.equal(alerts[0].webhook_url, 'https://hooks.example/x')
  assert.equal(alerts[1].enabled, false)
  assert.equal(alerts[1].webhook_url, null)

  // audit:snake_case + detail 解析 + success 布尔化
  const audit = JSON.parse(readFileSync(join(out, 'starhub-audit.json'), 'utf8'))
  assert.equal(audit.length, 2)
  assert.equal(audit[0].category, 'ai')
  assert.deepEqual(audit[0].detail, { command: 'ls' })
  assert.equal(audit[0].success, true)
  assert.equal(audit[1].success, false)
  assert.equal(audit[1].detail, null)

  // known_hosts:public_key 走 base64(BLOB)
  const hosts = JSON.parse(readFileSync(join(out, 'starhub-known-hosts.json'), 'utf8'))
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].host_key, '10.0.0.5')
  assert.equal(hosts[0].public_key, Buffer.from([1, 2, 3, 4]).toString('base64'))
})

test('secrets come from the export file; unreadable keyring ids are reported, not dropped', (t) => {
  const root = tmpDir('secrets')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')
  const exportPath = join(root, 'keyring.json')
  writeFileSync(exportPath, JSON.stringify({
    'asset:a1': { password: 's3cret', privateKey: null },
    'ai-model:jev': 'sk-test',
  }))

  const result = run(dbPath, out, ['--secrets-export', exportPath])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const secrets = JSON.parse(readFileSync(join(out, 'starhub-secrets.json'), 'utf8'))
  assert.deepEqual(secrets['asset:a1'], { password: 's3cret', privateKey: null })
  assert.deepEqual(secrets['ai-model:jev'], { value: 'sk-test' }, '裸字符串归一为 {value}')
  // a1 引用到的 asset:a1 已读到;没有引用到的 id 不该出现在报告里
  assert.match(result.stdout, /全部密钥已就位/)
})

test('verification catches a pre-existing target that differs from the export', (t) => {
  const root = tmpDir('verify')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')
  assert.equal(run(dbPath, out).status, 0)

  // 源库加一条资产(导出会多一条),目标文件还是上一轮的旧内容 →
  // 先验后写:校验必须抓到「条数不一致」,然后才覆盖。
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    'a3', 'db', 'PostgreSQL', null, '{}', null, '[]', 0, null, 1699995000, 1699995000)
  db.close()

  const result = run(dbPath, out)
  assert.notEqual(result.status, 0, '校验必须抓到差异')
  assert.match(result.stdout, /条数不一致/)
  assert.match(result.stdout, /发现 \d+ 处差异/)
  // 覆盖仍然发生(导出是权威),且留下 .bak
  const after = JSON.parse(readFileSync(join(out, 'starhub-assets.json'), 'utf8'))
  assert.equal(after.assets.length, 3, '新导出已覆盖')
  assert.ok(readdirSync(out).some(name => name.startsWith('starhub-assets.json.bak')))
})

test('a hand-edited target is overwritten by the fresh export (and reported)', (t) => {
  const root = tmpDir('handedit')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')
  assert.equal(run(dbPath, out).status, 0)

  // 人工改坏目标文件(不改源库):先验后写 → 校验抓到「内容不一致」,
  // 然后用源库导出覆盖坏内容,并留下 .bak。
  const target = join(out, 'starhub-assets.json')
  const doc = JSON.parse(readFileSync(target, 'utf8'))
  doc.assets[0].config.host = '10.9.9.9'
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`)
  const before = readdirSync(out).filter(name => name.startsWith('starhub-assets.json.bak'))

  const result = run(dbPath, out)
  assert.notEqual(result.status, 0, '手工篡改被校验抓到')
  assert.match(result.stdout, /内容不一致/)
  const after = JSON.parse(readFileSync(target, 'utf8'))
  assert.notEqual(after.assets[0].config.host, '10.9.9.9', '坏内容被覆盖')
  const backups = readdirSync(out).filter(name => name.startsWith('starhub-assets.json.bak'))
  assert.equal(backups.length, before.length + 1, '覆盖前留 .bak')
})

test('re-running is idempotent: unchanged and no second backup', (t) => {
  const root = tmpDir('idempotent')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')
  assert.equal(run(dbPath, out).status, 0)
  const before = readdirSync(out).sort()

  const second = run(dbPath, out)
  assert.equal(second.status, 0, second.stdout)
  assert.match(second.stdout, /unchanged/)
  assert.deepEqual(readdirSync(out).sort(), before, '不产生第二份 .bak')
})

test('dry-run writes nothing but still reports the plan', (t) => {
  const root = tmpDir('dryrun')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  buildOldDb(dbPath)
  const out = join(root, 'out')
  const result = run(dbPath, out, ['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /would-write/)
  assert.deepEqual(readdirSync(out), [], 'dry-run 不落盘')
})

test('audit import trims to the sidecar MAX_AUDIT_ROWS, keeping the newest', (t) => {
  const root = tmpDir('trim')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'starhub.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, session_id TEXT, asset_id TEXT, success INTEGER NOT NULL DEFAULT 1);
  `)
  const insert = db.prepare('INSERT INTO audit_log (timestamp, category, action) VALUES (?, ?, ?)')
  for (let index = 0; index < 5100; index += 1) {
    insert.run(1_000_000 + index, 'ai', `act-${index}`)
  }
  db.close()
  const out = join(root, 'out')
  assert.equal(run(dbPath, out).status, 0)
  const audit = JSON.parse(readFileSync(join(out, 'starhub-audit.json'), 'utf8'))
  assert.equal(audit.length, 5000, '修剪到上限')
  assert.equal(audit[audit.length - 1].action, 'act-5099', '保留最新')
  assert.equal(audit[0].action, 'act-100', '最早 100 条被删(act-0..act-99)')
})

test('a missing db fails loud', (t) => {
  const root = tmpDir('missing')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = run(join(root, 'nope.db'), join(root, 'out'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /旧 SQLite 不存在/)
})
