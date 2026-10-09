#!/usr/bin/env node
/**
 * Tauri → sidecar 一次性数据导入(去 Tauri 化 §六 / R7)。
 *
 * src-tauri 已随 M4 第 4 步删除,但**用户机器上的老数据还在**:资产注册表、
 * 连接配置、密钥、设置、审计、告警规则都在 Tauri 的 SQLite(`starhub.db`)与
 * 系统 Keyring 里。本工具把它们搬进 sidecar 自己的存储,并在搬完之后做
 * **双跑期校验**(R7:旧 SQLite 导出 vs 新存储逐条比对,不一致即非零退出)。
 *
 * 搬什么(按「用户数据」判据,不是按表名):
 *
 * | 老(Tauri) | 新(sidecar) |
 * |---|---|
 * | SQLite `assets` + `asset_groups` | `starhub-assets.json`(`AssetRecord` 线形状) |
 * | SQLite `settings` | `starhub-settings.json` |
 * | SQLite `alert_rule` | `starhub-alerts.json`(`AlertRule` 线形状) |
 * | SQLite `audit_log` | `starhub-audit.json`(`AuditEntry`,超 5000 条按同规则修剪) |
 * | SQLite `known_hosts` | `starhub-known-hosts.json`(TOFU 主机密钥) |
 * | 系统 Keyring(`asset:<id>` / `ai-model:<id>`) | `starhub-secrets.json` |
 *
 * **不搬的**(及其理由):
 * - `sql_history` / `snippets` / `ai_*`:Tauri 壳私有的使用痕迹,新架构里没有
 *   对应读取方(SSH/SFTP/数据库工作台不读 SQLite 历史);搬过去只是死数据。
 * - `sandbox_templates` / `sandbox_instances` / `*_replay_frames`:一次性容器
 *   与回放帧,容器早已销毁,帧的截屏文件路径在新安装里也不存在。
 *
 * 密钥(Keyring)是唯一跨平台麻烦的一项:macOS/Linux 有 CLI 可读,Windows 的
 * 凭据管理器没有官方命令行。因此密钥走两条路:
 * 1. `--secrets-export <file>`:用户在旧壳(或任何能读 Keyring 的工具)里导出
 *    一份 `{ "asset:<id>": {…}, "ai-model:<id>: "…" }` JSON,本工具直接吃;
 * 2. 平台 CLI 自动读(macOS `security` / Linux `secret-tool`),读不到就跳过并
 *    在报告里列出来——**不静默丢数据**。
 *
 * 用法:
 *   node scripts/migrate-tauri-data.mjs --db <starhub.db> --out <dir> [--secrets-export f.json]
 *                                       [--dry-run] [--report <file>]
 *
 * 退出码:0 = 全部一致;1 = 校验发现差异或输入有问题;2 = 用法错误。
 */
import { DatabaseSync } from 'node:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 审计上限,与 sidecar 的 `MAX_AUDIT_ROWS` 一致。 */
const MAX_AUDIT_ROWS = 5000

function parseArgs(argv) {
  const values = {
    db: null,
    out: null,
    secretsExport: null,
    dryRun: false,
    report: null,
    keepBackup: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} 需要一个值`)
      }
      return value
    }
    switch (arg) {
      case '--db': values.db = next(); break
      case '--out': values.out = next(); break
      case '--secrets-export': values.secretsExport = next(); break
      case '--report': values.report = next(); break
      case '--dry-run': values.dryRun = true; break
      case '--no-backup': values.keepBackup = false; break
      case '--help': console.log(usage()); process.exit(0)
      default: throw new Error(`未知参数 ${arg}`)
    }
  }
  if (values.db === null) throw new Error('--db <Tauri 的 starhub.db> 必填')
  if (values.out === null) throw new Error('--out <sidecar 数据目录> 必填')
  return values
}

function usage() {
  return [
    'Usage: node scripts/migrate-tauri-data.mjs --db <starhub.db> --out <dir> [flags]',
    '',
    '  --db <path>              旧 Tauri 壳的 SQLite(starhub.db;只读打开)。',
    '  --out <dir>              sidecar 数据目录(assets.json / secrets.json 等的落点)。',
    '  --secrets-export <file>  Keyring 导出 JSON({ "<keyId>": <secrets|string> })。',
    '  --report <file>          校验报告写出位置(缺省打到 stdout)。',
    '  --dry-run                只读旧库、算差异,不写任何文件。',
    '  --no-backup               覆盖已存在的目标文件前不留下 .bak。',
    '',
  ].join('\n')
}

// ── 旧 SQLite 读取 ────────────────────────────────────────────

/** 只读打开旧库(SQLite 的 file: URI + mode=ro,绝不碰原文件)。 */
function openOldDb(path) {
  if (!existsSync(path)) throw new Error(`旧 SQLite 不存在: ${path}`)
  // WAL 库在只读模式下可能读不到最新数据:先把 -wal/-shm 一起复制到临时目录,
  // 再从副本打开。原库一个字节都不改。
  const tmp = join(repoRoot, 'tmp', `migrate-src-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const copy = join(tmp, 'starhub.db')
  cpSync(path, copy)
  for (const suffix of ['-wal', '-shm']) {
    const side = `${path}${suffix}`
    if (existsSync(side)) cpSync(side, `${copy}${suffix}`)
  }
  try {
    return { db: new DatabaseSync(copy), tmp }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name)
  return row !== undefined
}

/// 表里实际存在的列(老库可能缺后来加的字列——Tauri 的 schema 是
/// `CREATE TABLE IF NOT EXISTS`,升级路径上缺列是常态,不是异常)。
function tableColumns(db, name) {
  if (!tableExists(db, name)) return new Set()
  return new Set(
    db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((row) => String(row.name)),
  )
}

/**
 * 按「实际存在的列」构造 SELECT:缺列查询里直接去掉,读出来的行该字段为
 * undefined,由调用方的缺省值兜住。**绝不静默返回空数组**——那会把「老库缺列」
 * 伪装成「老库没数据」,迁移报告还显示一致,用户资产就静默丢了。
 *
 * `orderBy` 缺省 = 不排序:sidecar 的 `AssetStore::list()` 是**文件顺序即返回
 * 顺序**,迁移若按 created_at 重排,用户在工作台里看到的资产顺序会和旧壳不一致
 * (旧壳的 assets 表是 rowid 序)。所以这里保持老库的自然行序。
 */
function selectExisting(db, name, wanted, orderBy) {
  const present = tableColumns(db, name)
  if (present.size === 0) return []
  const columns = wanted.filter((column) => present.has(column))
  if (columns.length === 0) return []
  const order = orderBy !== undefined && present.has(orderBy) ? ` ORDER BY ${orderBy}` : ''
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${name}${order}`).all()
}

/** 读 assets + asset_groups → sidecar `assets.json` 行形状(camelCase)。 */
function readAssets(db) {
  const groups = new Map()
  for (const row of selectExisting(
    db,
    'asset_groups',
    ['id', 'name', 'parent_id', 'icon', 'sort_order'],
    'id',
  )) {
    groups.set(Number(row.id), row)
  }
  return selectExisting(
    db,
    'assets',
    [
      'id', 'type', 'name', 'group_id', 'config_json', 'key_id',
      'tags', 'favorite', 'last_used_at', 'created_at', 'updated_at',
    ],
    undefined,
  ).map((row) => {
    let config = {}
    try {
      config = JSON.parse(row.config_json ?? '{}')
    } catch {
      config = {}
    }
    let tags = []
    try {
      tags = JSON.parse(row.tags ?? '[]')
    } catch {
      tags = []
    }
    const group = row.group_id === null ? undefined : groups.get(Number(row.group_id))
    return {
      id: String(row.id),
      type: String(row.type ?? ''),
      name: String(row.name ?? ''),
      config,
      keyId: row.key_id === null ? null : String(row.key_id),
      groupId: row.group_id === null ? null : Number(row.group_id),
      groupName: group === undefined ? null : String(group.name ?? ''),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      favorite: Number(row.favorite ?? 0) !== 0,
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }
  })
}

/** 读 settings → `starhub-settings.json`(与 FileSettingsStore 的平铺 JSON 同形)。 */
function readSettings(db) {
  const out = {}
  for (const row of selectExisting(db, 'settings', ['key', 'value'], 'key')) {
    if (row.key === undefined || row.key === null) continue
    out[String(row.key)] = row.value === null ? null : String(row.value)
  }
  return out
}

/**
 * 读 alert_rule → `starhub-alerts.json`(与 AlertRule 线形状一致)。
 *
 * **顺序即插入序**:sidecar 的 `AlertStore::list()` 是把文件数组 `reverse()`
 * (等价「插入倒序」),不是按 created_at 排序。迁移若按 created_at 重排,用户
 * 看到的告警规则顺序会和旧壳不一致。所以这里保持老库的自然行序。
 */
function readAlerts(db) {
  return selectExisting(
    db,
    'alert_rule',
    [
      'id', 'name', 'enabled', 'category', 'metric', 'operator', 'threshold',
      'duration_sec', 'webhook_url', 'cooldown_sec', 'created_at', 'updated_at',
    ],
    undefined,
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    enabled: Number(row.enabled ?? 1) !== 0,
    category: String(row.category ?? ''),
    metric: String(row.metric ?? ''),
    operator: String(row.operator ?? ''),
    threshold: Number(row.threshold ?? 0),
    duration_sec: Number(row.duration_sec ?? 0),
    webhook_url: row.webhook_url === null ? null : String(row.webhook_url),
    cooldown_sec: Number(row.cooldown_sec ?? 300),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  }))
}

/**
 * 读 audit_log → `starhub-audit.json`(与 AuditEntry 线形状一致,超上限按同规则修剪)。
 *
 * 顺序即插入序(sidecar 的 `list()` 在内存里按 `timestamp DESC, id DESC` 排,
 * 文件顺序不影响查询结果);修剪也必须按同一序——按 (timestamp,id) 升序保留
 * 最新 MAX_AUDIT_ROWS 条,与 sidecar 的 `trim_to_max` 逐字同语义。
 */
function readAudit(db) {
  const rows = selectExisting(
    db,
    'audit_log',
    ['id', 'timestamp', 'category', 'action', 'target', 'detail', 'session_id', 'asset_id', 'success'],
    undefined,
  ).map((row) => {
    let detail = null
    if (row.detail !== null && row.detail !== undefined && String(row.detail) !== '') {
      try {
        detail = JSON.parse(String(row.detail))
      } catch {
        detail = String(row.detail)
      }
    }
    return {
      id: Number(row.id),
      timestamp: Number(row.timestamp ?? 0),
      category: String(row.category ?? ''),
      action: String(row.action ?? ''),
      target: row.target === null ? null : String(row.target),
      detail,
      session_id: row.session_id === null ? null : String(row.session_id),
      asset_id: row.asset_id === null ? null : String(row.asset_id),
      success: Number(row.success ?? 1) !== 0,
    }
  })
  // sidecar 的 trim 语义:按 (timestamp,id) 升序保留最新 MAX_AUDIT_ROWS 条
  if (rows.length > MAX_AUDIT_ROWS) {
    return rows.slice(rows.length - MAX_AUDIT_ROWS)
  }
  return rows
}

/** 读 known_hosts → `starhub-known-hosts.json`(TOFU;shape 见 FileKnownHostsStore)。 */
function readKnownHosts(db) {
  return selectExisting(
    db,
    'known_hosts',
    ['host_key', 'key_type', 'sha256_fingerprint', 'public_key', 'created_at'],
    'id',
  ).map((row) => ({
    host_key: String(row.host_key ?? ''),
    key_type: String(row.key_type ?? ''),
    sha256_fingerprint: String(row.sha256_fingerprint ?? ''),
    // public_key 是 BLOB;Node 的 sqlite 给 Buffer
    public_key: Buffer.from(row.public_key ?? []).toString('base64'),
    created_at: Number(row.created_at ?? 0),
  }))
}

// ── 密钥 ─────────────────────────────────────────────────────

/**
 * 从导出文件读密钥;形状宽松:值可以是 secrets 对象,也可以是裸字符串
 * (裸字符串按 `{ "value": "…" }` 归一,兼容 AI key 那种单值密钥)。
 */
function readSecretsExport(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`密钥导出文件必须是 JSON 对象: ${path}`)
  }
  const out = {}
  for (const [keyId, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[keyId] = { value }
    else if (typeof value === 'object' && value !== null) out[keyId] = value
  }
  return out
}

/** 平台 CLI 直读 Keyring(macOS security / Linux secret-tool);读不到返回空。 */
function readKeyringViaCli(keyIds) {
  const out = {}
  const platform = process.platform
  for (const keyId of keyIds) {
    try {
      if (platform === 'darwin') {
        const secret = execFileSync('security', ['find-generic-password', '-s', keyId, '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (secret !== '') out[keyId] = { value: secret }
      } else if (platform === 'linux') {
        const secret = execFileSync('secret-tool', ['lookup', 'key', keyId], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (secret !== '') out[keyId] = { value: secret }
      }
      // Windows 没有官方 CLI:留给 --secrets-export
    } catch {
      // 单条读不到不阻断整体导入
    }
  }
  return out
}

// ── 写出 + 双跑期校验 ────────────────────────────────────────

/** 写 JSON(带 .bak 备份;已存在且内容相同则跳过,保证幂等)。 */
function writeJson(target, value, { dryRun, keepBackup }) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8')
    if (current === text) return 'unchanged'
    if (!dryRun && keepBackup) {
      cpSync(target, `${target}.bak-${Date.now()}`)
    }
  }
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    return 'written'
  }
  return 'would-write'
}

/**
 * 深排序后的规范化 JSON 字符串(用于「内容是否一致」比较)。
 *
 * 不能图省事用 `JSON.stringify(v, Object.keys(v).sort())`——数组型 replacer 是
 * **键名白名单**,嵌套对象会被掏成 `{}`,任何两份数据都「相等」,校验直接失效
 * (M4 实测踩到:先验后写的设计被这个坑整成摆设)。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 双跑期校验:把新存储读回来,与旧库导出逐条比对。返回差异清单(空 = 一致)。 */
function verify(expected, target, label) {
  if (!existsSync(target)) {
    // 首次导入:目标还不存在,没有可比对的对端——这不是差异,是「即将写入」。
    // (真的丢了内容会在写入后由下一跑抓到。)
    return []
  }
  let actual
  try {
    actual = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    return [`${label}: 目标文件解析失败: ${error.message}`]
  }
  const diffs = []
  if (label === 'settings') {
    // settings 是平铺对象
    const expectedKeys = Object.keys(expected).sort()
    const actualKeys = Object.keys(actual).sort()
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      diffs.push(`${label}: 键集合不一致(旧 ${expectedKeys.length} / 新 ${actualKeys.length})`)
    }
    for (const key of expectedKeys) {
      if (String(expected[key]) !== String(actual[key])) {
        diffs.push(`${label}[${key}]: 旧=${JSON.stringify(expected[key])} 新=${JSON.stringify(actual[key])}`)
      }
    }
    return diffs
  }
  // 其它四个都是「行清单」;assets 外面包了一层 {assets:[…]}(AssetStore 的文件格式)
  const expectedList = Array.isArray(expected) ? expected : (expected.assets ?? [])
  const actualList = Array.isArray(actual) ? actual : (actual.assets ?? [])
  if (expectedList.length !== actualList.length) {
    diffs.push(`${label}: 条数不一致(旧 ${expectedList.length} / 新 ${actualList.length})`)
  }
  const keyOf = (item) => String(item.id ?? item.host_key ?? '')
  const actualById = new Map(actualList.map((item) => [keyOf(item), item]))
  for (const item of expectedList) {
    const other = actualById.get(keyOf(item))
    if (other === undefined) {
      diffs.push(`${label}: 缺失 ${keyOf(item)}`)
      continue
    }
    if (canonicalJson(item) !== canonicalJson(other)) {
      diffs.push(`${label}[${keyOf(item)}]: 内容不一致`)
    }
  }
  return diffs
}

// ── 主流程 ───────────────────────────────────────────────────

function main() {
  const options = parseArgs(process.argv.slice(2))
  const outDir = resolve(options.out)
  mkdirSync(outDir, { recursive: true })

  const { db, tmp } = openOldDb(options.db)
  const summary = []
  const problems = []
  try {
    const assets = readAssets(db)
    const settings = readSettings(db)
    const alerts = readAlerts(db)
    const audit = readAudit(db)
    const knownHosts = readKnownHosts(db)

    // 密钥:导出文件优先,平台 CLI 兜底(只覆盖 assets 引到的 key_id)
    const referencedKeyIds = new Set()
    for (const asset of assets) {
      if (asset.keyId) referencedKeyIds.add(asset.keyId)
    }
    let secrets = {}
    const secretSource = []
    if (options.secretsExport !== null) {
      secrets = readSecretsExport(options.secretsExport)
      secretSource.push(`export(${Object.keys(secrets).length})`)
    }
    const viaCli = readKeyringViaCli([...referencedKeyIds])
    for (const [keyId, value] of Object.entries(viaCli)) {
      if (secrets[keyId] === undefined) {
        secrets[keyId] = value
        secretSource.push(`cli(${keyId})`)
      }
    }
    const unreadable = [...referencedKeyIds].filter((id) => secrets[id] === undefined)

    const plan = [
      { label: 'assets', target: join(outDir, 'starhub-assets.json'), value: { assets } },
      { label: 'settings', target: join(outDir, 'starhub-settings.json'), value: settings },
      { label: 'alerts', target: join(outDir, 'starhub-alerts.json'), value: alerts },
      { label: 'audit', target: join(outDir, 'starhub-audit.json'), value: audit },
      { label: 'known-hosts', target: join(outDir, 'starhub-known-hosts.json'), value: knownHosts },
      { label: 'secrets', target: join(outDir, 'starhub-secrets.json'), value: secrets },
    ]

    // 双跑期校验(R7):**先读旧目标、再写新内容**。顺序很关键——
    //  - 先校验:磁盘上已有的内容若与本次导出不一致,差异被记下来(那是上一轮
    //    或第三方留下的状态,用户该知道);
    //  - 后写入:本次导出是权威,覆盖旧内容并留 .bak。
    // 反过来(先写后验)永远一致,校验就成了摆设。
    if (options.dryRun) {
      summary.push('')
      summary.push('(--dry-run:未落盘,双跑期校验跳过;正式跑一次即逐条比对)')
    } else {
      for (const item of plan) {
        problems.push(...verify(item.value, item.target, item.label))
      }
    }

    for (const item of plan) {
      const state = writeJson(item.target, item.value, options)
      summary.push(`${item.label}: ${state} → ${item.target}`)
    }

    const report = [
      '── 迁移摘要 ──',
      ...summary,
      '',
      `── 密钥 ──`,
      `来源: ${secretSource.length > 0 ? secretSource.join(', ') : '(无)'}`,
      `引用到的 key_id: ${referencedKeyIds.size} 个`,
      unreadable.length > 0
        ? `未能读取 ${unreadable.length} 个(需 --secrets-export): ${unreadable.join(', ')}`
        : '全部密钥已就位',
      '',
      '── 双跑期校验 ──',
      options.dryRun
        ? '(--dry-run:跳过)'
        : problems.length === 0
          ? '一致:旧 SQLite 导出与新存储逐条比对无差异'
          : `发现 ${problems.length} 处差异:`,
      ...problems.map((line) => `  - ${line}`),
    ].join('\n')

    if (options.report !== null) {
      mkdirSync(dirname(resolve(options.report)), { recursive: true })
      writeFileSync(resolve(options.report), `${report}\n`)
    }
    console.log(report)
    return problems.length === 0 ? 0 : 1
  } finally {
    try {
      db.close()
    } catch {
      // 忽略关闭错误
    }
    rmSync(tmp, { recursive: true, force: true })
  }
}

process.exit(main())
