/**
 * DB 监控 Dashboard 的服务层(批次 4:DB Dashboard React 化)。
 *
 * 自 `src/utils/dbMetrics.ts` 逐函数迁移纯解析逻辑(逻辑零改动),新增
 * `db_mysql_execute` / `db_redis_info` / `db_redis_db_size` 命令封装与
 * Dashboard 实际要跑的 SQL 语句常量(与 Vue `DbDashboard.vue` 同契约)。全部
 * 来自后端 RPC 真实返回,无 mock。
 *
 * @module DB dashboard service (client)
 */
import { tauriInvoke } from '../tauri.ts'

/** db_mysql_execute 的返回(与 Vue QueryResult 同构:columns 列名 + rows 二维数组)。 */
export interface DbQueryResult {
  columns?: Array<{ name?: string }>
  rows?: unknown[][]
  error?: string
}

/** MySQL 连接 / 会话明细,来自 information_schema.PROCESSLIST。 */
export interface MysqlProcessDetail {
  id: number
  user: string
  host: string
  ip: string
  database: string
  command: string
  timeSeconds: number
  state: string
  sql: string
}

/** MySQL 慢语句明细,优先来自 mysql.slow_log,必要时回退到 digest 汇总。 */
export interface MysqlSlowQueryDetail {
  startedAt: string
  duration: string
  lockTime: string
  rowsExamined: number
  database: string
  userHost: string
  sql: string
  executions?: number | undefined
  source: 'slow_log' | 'performance_schema'
}

/** Redis INFO 解析后的关键指标。 */
export interface RedisMetrics {
  version: string
  uptimeSeconds: number
  uptimePretty: string
  connectedClients: number
  connectedSlaves: number
  usedMemory: number
  usedMemoryPeak: number
  usedMemoryHuman: string
  totalKeys: number
  hitRate: number
  totalCommandsProcessed: number
  instantaneousOpsPerSec: number
  role: string
  maxmemory: number
  raw: string
}

/** MySQL SHOW STATUS / SHOW VARIABLES 解析后的关键指标。 */
export interface MysqlMetrics {
  version: string
  uptimeSeconds: number
  uptimePretty: string
  threadsConnected: number
  threadsRunning: number
  maxConnections: number
  questions: number
  slowQueries: number
  queries: number
  bytesReceived: number
  bytesSent: number
  innodbBufferPoolSize: number
  innodbBufferPoolUsed: number
  bufferPoolHitRate: number
  tableCount: number
  dataSize: number
  indexSize: number
}

/** PostgreSQL 概览指标(由一条汇总 SQL 解析)。 */
export interface PostgresMetrics {
  version: string
  uptimeSeconds: number
  connections: number
  activeConnections: number
  maxConnections: number
  databaseSize: number
  cacheHitRate: number
  tableCount: number
  transactions: number
}

/** 通用明细记录(值只保留可渲染的标量)。 */
export type DetailRecord = Record<string, string | number | null | undefined>

/** MySQL 默认最大连接数(max_connections 取不到时的兜底值)。 */
export const MYSQL_DEFAULT_MAX_CONNECTIONS = 151

/** MySQL 汇总指标 SQL:SHOW GLOBAL STATUS。 */
export const MYSQL_STATUS_SQL = 'SHOW GLOBAL STATUS'
/** MySQL 汇总指标 SQL:SHOW GLOBAL VARIABLES。 */
export const MYSQL_VARIABLES_SQL = 'SHOW GLOBAL VARIABLES'
/** MySQL 表数 SQL(按当前 DATABASE())。 */
export const MYSQL_TABLE_COUNT_SQL = `SELECT COUNT(*) AS table_count FROM information_schema.tables
 WHERE table_schema = DATABASE()`
/** MySQL 容量 SQL(当前库的数据/索引尺寸)。 */
export const MYSQL_SIZE_SQL = `SELECT COALESCE(SUM(data_length), 0) AS data_size,
        COALESCE(SUM(index_length), 0) AS index_size
 FROM information_schema.tables WHERE table_schema = DATABASE()`
/** MySQL 会话明细 SQL(information_schema.PROCESSLIST,排除当前连接)。 */
export const MYSQL_PROCESSLIST_SQL = `SELECT ID AS id, USER AS user, HOST AS host, DB AS db,
        COMMAND AS command, TIME AS time, STATE AS state,
        LEFT(INFO, 2000) AS info
 FROM information_schema.PROCESSLIST
 WHERE ID <> CONNECTION_ID()
 ORDER BY (COMMAND = 'Sleep') ASC, TIME DESC
 LIMIT 100`
/** MySQL 慢日志 SQL(mysql.slow_log)。 */
export const MYSQL_SLOW_LOG_SQL = `SELECT DATE_FORMAT(start_time, '%Y-%m-%d %H:%i:%s') AS started_at,
        CAST(query_time AS CHAR) AS duration,
        CAST(lock_time AS CHAR) AS lock_time,
        rows_examined, db, user_host, LEFT(sql_text, 4000) AS sql_text
 FROM mysql.slow_log
 ORDER BY start_time DESC
 LIMIT 50`
/** MySQL performance_schema digest 回退 SQL。 */
export const MYSQL_DIGEST_SQL = `SELECT DATE_FORMAT(FIRST_SEEN, '%Y-%m-%d %H:%i:%s') AS first_seen,
        CONCAT(ROUND(SUM_TIMER_WAIT / 1000000000000, 3), ' s') AS total_latency,
        COUNT_STAR AS executions,
        SUM_ROWS_EXAMINED AS rows_examined,
        SCHEMA_NAME AS db,
        LEFT(DIGEST_TEXT, 4000) AS digest_text
 FROM performance_schema.events_statements_summary_by_digest
 WHERE DIGEST_TEXT IS NOT NULL
 ORDER BY SUM_TIMER_WAIT DESC
 LIMIT 50`
/** PostgreSQL 概览汇总 SQL。 */
export const PG_SUMMARY_SQL = `SELECT current_setting('server_version') AS version,
        EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint AS uptime_seconds,
        (SELECT count(*) FROM pg_stat_activity) AS connections,
        (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active_connections,
        current_setting('max_connections')::int AS max_connections,
        pg_database_size(current_database()) AS database_size,
        COALESCE((SELECT round(100 * sum(blks_hit)::numeric /
          NULLIF(sum(blks_hit + blks_read), 0), 2) FROM pg_stat_database), 0) AS cache_hit_rate,
        (SELECT count(*) FROM pg_stat_user_tables
          WHERE schemaname = current_schema()) AS table_count,
        COALESCE((SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database), 0) AS transactions`
/** PostgreSQL 会话明细 SQL(pg_stat_activity,排除当前连接)。 */
export const PG_SESSIONS_SQL = `SELECT COALESCE(client_addr::text, 'local') AS ip,
        COALESCE(usename, '--') AS "user",
        COALESCE(datname, '--') AS database,
        COALESCE(application_name, '--') AS application,
        COALESCE(state, '--') AS state,
        round(EXTRACT(EPOCH FROM (clock_timestamp() -
          COALESCE(query_start, backend_start)))::numeric, 2) AS duration,
        COALESCE(wait_event_type || ':' || wait_event, '--') AS wait,
        COALESCE(LEFT(query, 4000), '(空闲连接)') AS sql
 FROM pg_stat_activity
 WHERE pid <> pg_backend_pid()
 ORDER BY (state = 'active') DESC, query_start NULLS LAST
 LIMIT 100`
/** PostgreSQL 慢语句聚合 SQL(pg_stat_statements)。 */
export const PG_STATEMENTS_SQL = `SELECT round(total_exec_time::numeric / 1000, 3) || ' s' AS duration,
        calls, rows, '--' AS "user", current_database() AS database,
        '历史聚合' AS ip, LEFT(query, 4000) AS sql
 FROM pg_stat_statements
 WHERE query IS NOT NULL
 ORDER BY total_exec_time DESC
 LIMIT 50`

/**
 * 执行一条 SQL(db_mysql_execute;RPC 按 connId 内嵌类型分派,PG/MySQL 通用)。
 * @param connId - 连接 id。
 * @param sql - 要执行的 SQL 语句。
 * @param database - 可选的目标数据库名(为空时用连接默认库)。
 * @returns 查询结果(columns 列名 + rows 二维数组)。
 */
export async function dbExecute(connId: string, sql: string, database?: string): Promise<DbQueryResult> {
  const args: Record<string, unknown> = { connId, sql }
  if (database !== undefined && database !== '') args.database = database
  return tauriInvoke<DbQueryResult>('db_mysql_execute', args)
}

/**
 * 取 Redis INFO 文本。
 * @param connId - 连接 id。
 * @param section - 可选的 INFO section(如 memory / clients)。
 * @returns Redis INFO 原始文本。
 */
export function redisInfo(connId: string, section?: string): Promise<string> {
  const args: Record<string, unknown> = { connId }
  if (section !== undefined) args.section = section
  return tauriInvoke<string>('db_redis_info', args)
}

/**
 * 取 Redis 当前 DB 键总数。
 * @param connId - 连接 id。
 * @returns 当前 DB 的键数量(size 缺失时为空对象)。
 */
export function redisDbSize(connId: string): Promise<{ size?: number }> {
  return tauriInvoke<{ size?: number }>('db_redis_db_size', { connId })
}

// ─── 纯解析函数(自 Vue src/utils/dbMetrics.ts 迁移,逻辑零改动) ───

/**
 * 字节 → 可读。
 * @param bytes - 字节数。
 * @returns 格式化后的可读大小(如 '1.5 MB');非正数返回 '0 B'。
 */
export function formatDbBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i] ?? ''}`
}

/**
 * 秒 → "X天 Y小时 Z分钟"。
 * @param seconds - 秒数。
 * @returns 格式化后的运行时长;非法值返回 '--'。
 */
export function formatDbUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${mins}分钟`
  return `${mins}分钟`
}

/**
 * 解析 Redis INFO 文本(支持 `info all` / `info default` / `info memory` 任意 section)。
 * @param text - Redis INFO 原始文本。
 * @param dbSize - 可选的当前 DB 键总数(写入 totalKeys)。
 * @returns 解析后的关键指标。
 */
export function parseRedisInfo(text: string, dbSize?: number): RedisMetrics {
  const get = (key: string): string => {
    const re = new RegExp(`^${key}:(.*)$`, 'm')
    const m = text.match(re)
    // `(.*)` always captures a (possibly empty) group, so m[1] is never nullish here.
    /* v8 ignore next -- (.*) guarantees a defined capture group */
    return m ? (m[1]?.trim() ?? '') : ''
  }
  const uptimeSeconds = parseInt(get('uptime_in_seconds'), 10) || 0
  const usedMemory = parseInt(get('used_memory'), 10) || 0
  const hits = parseInt(get('keyspace_hits'), 10) || 0
  const misses = parseInt(get('keyspace_misses'), 10) || 0
  return {
    version: get('redis_version') || '--',
    uptimeSeconds,
    uptimePretty: formatDbUptime(uptimeSeconds),
    connectedClients: parseInt(get('connected_clients'), 10) || 0,
    connectedSlaves: parseInt(get('connected_slaves'), 10) || 0,
    usedMemory,
    usedMemoryPeak: parseInt(get('used_memory_peak'), 10) || 0,
    usedMemoryHuman: get('used_memory_human') || '0B',
    totalKeys: dbSize ?? 0,
    hitRate: hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0,
    totalCommandsProcessed: parseInt(get('total_commands_processed'), 10) || 0,
    instantaneousOpsPerSec: parseInt(get('instantaneous_ops_per_sec'), 10) || 0,
    role: get('role') || '--',
    maxmemory: parseInt(get('maxmemory'), 10) || 0,
    raw: text,
  }
}

/**
 * 把 SHOW GLOBAL STATUS / SHOW GLOBAL VARIABLES / SELECT 结果(两列 name, value)
 * 转成 dict,方便按 key 查值。
 * @param result - 两列(name, value)的查询结果。
 * @returns 按 key 索引的值字典。
 */
export function rowsToDict(result: DbQueryResult | undefined): Record<string, string> {
  if (!result?.rows?.length) return {}
  const colNames = (result.columns || []).map(c => c.name?.toLowerCase() ?? '')
  let nameIdx = colNames.findIndex(n => /name|variable/i.test(n))
  let valueIdx = colNames.findIndex(n => /value/i.test(n))
  if (nameIdx < 0) nameIdx = 0
  if (valueIdx < 0) valueIdx = 1
  const dict: Record<string, string> = {}
  for (const row of result.rows) {
    const k = text(row[nameIdx])
    const v = text(row[valueIdx])
    if (k) dict[k] = v
  }
  return dict
}

/**
 * 把 DbQueryResult 转为以小写列名索引的对象数组(兼容驱动返回的列名大小写)。
 * @param result - 查询结果。
 * @returns 以小写列名为键的对象数组;无结果时为空数组。
 */
export function queryRowsToRecords(result?: DbQueryResult): Array<Record<string, unknown>> {
  if (!result?.rows?.length) return []
  const columns = (result.columns || []).map(c => c.name?.toLowerCase() ?? '')
  return result.rows.map(row => Object.fromEntries(
    columns.map((column, index) => [column, row[index]]),
  ))
}

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  const primitive = value as string | number | boolean | bigint | symbol
  return String(primitive)
}

function integer(value: unknown): number {
  const parsed = Number.parseInt(text(value, '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 从 PROCESSLIST 的 host:port 中拆出可直接识别的客户端 IP/主机名。
 * @param host - PROCESSLIST 的 HOST 字段(可能带端口或 IPv6 方括号)。
 * @returns 客户端 IP/主机名;无法识别时返回 '--'。
 */
export function mysqlClientIp(host: string): string {
  const trimmed = host.trim()
  if (!trimmed) return '--'
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']')
    if (closing > 1) return trimmed.slice(1, closing)
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator > 0 && /^\d+$/.test(trimmed.slice(separator + 1))) {
    return trimmed.slice(0, separator)
  }
  return trimmed
}

/**
 * 解析 PROCESSLIST 会话明细。
 * @param result - PROCESSLIST 查询结果。
 * @returns 会话明细数组。
 */
export function parseMysqlProcessDetails(result?: DbQueryResult): MysqlProcessDetail[] {
  return queryRowsToRecords(result).map((row) => {
    const host = text(row.host, '--')
    return {
      id: integer(row.id),
      user: text(row.user, '--'),
      host,
      ip: mysqlClientIp(host),
      database: text(row.db, '--'),
      command: text(row.command, '--'),
      timeSeconds: integer(row.time),
      state: text(row.state, '--'),
      sql: text(row.info, '').trim() || '(空闲连接)',
    }
  })
}

/**
 * 解析 MySQL 慢语句明细(slow_log 或 performance_schema 摘要)。
 * @param result - 慢日志查询结果。
 * @param source - 数据来源(slow_log 或 performance_schema)。
 * @returns 慢语句明细数组。
 */
export function parseMysqlSlowQueryDetails(
  result: DbQueryResult | undefined,
  source: MysqlSlowQueryDetail['source'],
): MysqlSlowQueryDetail[] {
  return queryRowsToRecords(result).map(row => ({
    startedAt: text(row.started_at ?? row.first_seen, '--'),
    duration: text(row.duration ?? row.total_latency, '--'),
    lockTime: text(row.lock_time, '--'),
    rowsExamined: integer(row.rows_examined),
    database: text(row.db, '--'),
    userHost: text(row.user_host, source === 'performance_schema' ? '聚合语句' : '--'),
    sql: text(row.sql_text ?? row.digest_text, '--'),
    executions: row.executions === undefined ? undefined : integer(row.executions),
    source,
  }))
}

/**
 * 从 dict 取数字,缺失返回 fallback。
 * @param dict - 键值字典。
 * @param key - 要读取的键。
 * @param fallback - 缺失或非法值时的回退值,默认 0。
 * @returns 解析后的数字。
 */
export function num(dict: Record<string, string>, key: string, fallback = 0): number {
  const v = dict[key]
  if (v === undefined || v === '') return fallback
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 解析 MySQL 状态:status(SHOW GLOBAL STATUS)+ variables(SHOW GLOBAL VARIABLES)
 * + 可选 tableStats/sizeStats。
 * @param opts - status / variables 查询结果,及可选的 tableStats / sizeStats。
 * @returns 解析后的 MySQL 关键指标。
 */
export function parseMysqlMetrics(opts: {
  status: DbQueryResult | undefined
  variables: DbQueryResult | undefined
  tableStats?: DbQueryResult | undefined
  sizeStats?: DbQueryResult | undefined
}): MysqlMetrics {
  const status = rowsToDict(opts.status)
  const variables = rowsToDict(opts.variables)
  const threadsConnected = num(status, 'Threads_connected')
  const threadsRunning = num(status, 'Threads_running')
  const maxConnections = num(variables, 'max_connections', MYSQL_DEFAULT_MAX_CONNECTIONS)
  const uptime = num(status, 'Uptime')
  const questions = num(status, 'Questions')
  const slowQueries = num(status, 'Slow_queries')
  const queries = num(status, 'Queries')
  const bytesReceived = num(status, 'Bytes_received')
  const bytesSent = num(status, 'Bytes_sent')
  const innodbBP = num(status, 'Innodb_buffer_pool_pages_total')
  const innodbBPFree = num(status, 'Innodb_buffer_pool_pages_free')
  const innodbBPSize = num(variables, 'innodb_buffer_pool_size')
  const innodbPageSize = num(variables, 'innodb_page_size', 16 * 1024)
  const innodbReadReq = num(status, 'Innodb_buffer_pool_read_requests')
  const innodbReads = num(status, 'Innodb_buffer_pool_reads')
  const hitRate = innodbReadReq > 0
    ? Math.max(0, (1 - innodbReads / innodbReadReq) * 100)
    : 0
  const bufferPoolUsed = Math.max(0, (innodbBP - innodbBPFree) * innodbPageSize)
  let tableCount = 0
  let dataSize = 0
  let indexSize = 0
  if (opts.tableStats?.rows?.length) {
    // 运行时可能返回 null 行(测试与坏数据源都喂过);经 unknown 读取让守卫真实。
    const last: unknown = opts.tableStats.rows[0]
    if (last !== undefined && last !== null) {
      const row = last as ReadonlyArray<unknown>
      tableCount = parseInt(text(row[row.length - 1], '0'), 10) || 0
    }
  }
  if (opts.sizeStats?.rows?.length) {
    const r: unknown = opts.sizeStats.rows[0]
    if (r !== undefined && r !== null) {
      const row = r as ReadonlyArray<unknown>
      dataSize = parseInt(text(row[0], '0'), 10) || 0
      indexSize = parseInt(text(row[1], '0'), 10) || 0
    }
  }
  return {
    version: variables['version'] || variables['version_comment'] || '--',
    uptimeSeconds: uptime,
    uptimePretty: formatDbUptime(uptime),
    threadsConnected,
    threadsRunning,
    maxConnections,
    questions,
    slowQueries,
    queries,
    bytesReceived,
    bytesSent,
    innodbBufferPoolSize: innodbBPSize,
    innodbBufferPoolUsed: bufferPoolUsed,
    bufferPoolHitRate: hitRate,
    tableCount,
    dataSize,
    indexSize,
  }
}

/**
 * 把 PostgreSQL 概览汇总行解析成 PostgresMetrics(缺失字段回退 0/--)。
 * @param row - PG_SUMMARY_SQL 返回的一行记录。
 * @returns 解析后的 PostgreSQL 概览指标。
 */
export function parsePostgresMetrics(row: Record<string, unknown>): PostgresMetrics {
  const number = (value: unknown): number => {
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return {
    version: text(row.version, '--'),
    uptimeSeconds: number(row.uptime_seconds),
    connections: number(row.connections),
    activeConnections: number(row.active_connections),
    maxConnections: number(row.max_connections),
    databaseSize: number(row.database_size),
    cacheHitRate: number(row.cache_hit_rate),
    tableCount: number(row.table_count),
    transactions: number(row.transactions),
  }
}

/**
 * 把任意行对象转成可渲染的明细记录(对象值序列化)。
 * @param rows - 行对象数组。
 * @returns 只保留可渲染标量值的明细记录数组。
 */
export function detailRecords(rows: Array<Record<string, unknown>>): DetailRecord[] {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null || value === undefined || typeof value === 'string' || typeof value === 'number'
        ? value
        : text(value),
    ]),
  ))
}
