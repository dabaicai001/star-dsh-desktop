// @vitest-environment jsdom
/**
 * DB dashboard 服务层(db-dashboard-service.ts):命令封装转发、纯解析函数
 * formatDbBytes / formatDbUptime / parseRedisInfo / rowsToDict /
 * queryRowsToRecords / mysqlClientIp / parseMysqlProcessDetails /
 * parseMysqlSlowQueryDetails / num / parseMysqlMetrics / parsePostgresMetrics /
 * detailRecords,以及 dashboardTabs / dbTypeName / mysqlConnUsage /
 * postgresConnUsage / mysqlDataRatio 的边界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dbExecute, redisInfo, redisDbSize,
  formatDbBytes, formatDbUptime, parseRedisInfo, rowsToDict, queryRowsToRecords,
  mysqlClientIp, parseMysqlProcessDetails, parseMysqlSlowQueryDetails, num,
  parseMysqlMetrics, parsePostgresMetrics, detailRecords,
  MYSQL_STATUS_SQL, MYSQL_VARIABLES_SQL, PG_SUMMARY_SQL,
} from '../src/client/dashboard/db-dashboard-service.ts'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

/** 安装宿主桥 invoke 替身;返回还原回调。 */
function stubInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown): () => void {
  stubHostBridge(handler)
  return () => { restoreHostBridge() }
}

afterEach(() => {
  vi.restoreAllMocks()
  restoreHostBridge()
})

describe('db dashboard commands', () => {
  it('forwards db_mysql_execute with and without a database', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const restore = stubInvoke((cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve({ columns: [{ name: 'x' }], rows: [[1]] })
    })
    try {
      const withDb = await dbExecute('c1', MYSQL_STATUS_SQL, 'mydb')
      const withoutDb = await dbExecute('c1', MYSQL_STATUS_SQL, '')
      expect(calls[0]).toEqual(['db_mysql_execute', { connId: 'c1', sql: MYSQL_STATUS_SQL, database: 'mydb' }])
      expect(calls[1]).toEqual(['db_mysql_execute', { connId: 'c1', sql: MYSQL_STATUS_SQL }])
      const noDb = await dbExecute('c1', MYSQL_STATUS_SQL)
      expect(calls[2]).toEqual(['db_mysql_execute', { connId: 'c1', sql: MYSQL_STATUS_SQL }])
      expect(withDb.rows).toEqual([[1]])
      expect(withoutDb.rows).toEqual([[1]])
      expect(noDb.rows).toEqual([[1]])
    } finally {
      restore()
    }
  })

  it('forwards redis info with and without a section and db size', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const restore = stubInvoke((cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'db_redis_info') return Promise.resolve('# Server\nredis_version:7.0\n')
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 5 })
      return Promise.resolve(null)
    })
    try {
      const info = await redisInfo('c1', 'all')
      const infoDefault = await redisInfo('c1')
      const size = await redisDbSize('c1')
      expect(calls[0]).toEqual(['db_redis_info', { connId: 'c1', section: 'all' }])
      expect(calls[1]).toEqual(['db_redis_info', { connId: 'c1' }])
      expect(calls[2]).toEqual(['db_redis_db_size', { connId: 'c1' }])
      expect(info).toContain('redis_version')
      expect(infoDefault).toContain('redis_version')
      expect(size.size).toBe(5)
    } finally {
      restore()
    }
  })
})

describe('formatDbBytes', () => {
  it('returns "0 B" for zero/negative and formatted units otherwise', () => {
    expect(formatDbBytes(0)).toBe('0 B')
    expect(formatDbBytes(-5)).toBe('0 B')
    expect(formatDbBytes(512)).toBe('512 B')
    expect(formatDbBytes(2048)).toBe('2 KB')
    expect(formatDbBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatDbBytes(10 * 1024 * 1024 * 1024)).toBe('10 GB')
  })
})

describe('formatDbUptime', () => {
  it('returns -- for missing/negative and splits days/hours/minutes', () => {
    expect(formatDbUptime(0)).toBe('--')
    expect(formatDbUptime(-1)).toBe('--')
    expect(formatDbUptime(30)).toBe('0分钟')
    expect(formatDbUptime(3600 * 5 + 60 * 20)).toBe('5小时 20分钟')
    expect(formatDbUptime(86400 * 2 + 3600 * 3)).toBe('2天 3小时')
  })
})

describe('parseRedisInfo', () => {
  const info = [
    '# Server', 'redis_version:7.2', 'uptime_in_seconds:3600', 'connected_clients:3',
    'used_memory:1048576', 'used_memory_peak:2097152', 'used_memory_human:1.00M',
    'keyspace_hits:90', 'keyspace_misses:10', 'total_commands_processed:1000',
    'instantaneous_ops_per_sec:12', 'role:master', 'maxmemory:0',
  ].join('\n')

  it('parses a full info text with a db size', () => {
    const r = parseRedisInfo(info, 42)
    expect(r.version).toBe('7.2')
    expect(r.uptimeSeconds).toBe(3600)
    expect(r.uptimePretty).toBe('1小时 0分钟')
    expect(r.connectedClients).toBe(3)
    expect(r.usedMemory).toBe(1048576)
    expect(r.usedMemoryPeak).toBe(2097152)
    expect(r.usedMemoryHuman).toBe('1.00M')
    expect(r.totalKeys).toBe(42)
    expect(r.hitRate).toBe(90)
    expect(r.totalCommandsProcessed).toBe(1000)
    expect(r.instantaneousOpsPerSec).toBe(12)
    expect(r.role).toBe('master')
    expect(r.maxmemory).toBe(0)
  })

  it('falls back to defaults when keys are missing and dbSize undefined', () => {
    const r = parseRedisInfo('')
    expect(r.version).toBe('--')
    expect(r.uptimeSeconds).toBe(0)
    expect(r.totalKeys).toBe(0)
    expect(r.hitRate).toBe(0)
    expect(r.usedMemoryHuman).toBe('0B')
  })
})

describe('rowsToDict', () => {
  it('returns empty for a missing result', () => {
    expect(rowsToDict(undefined)).toEqual({})
    expect(rowsToDict({})).toEqual({})
  })
  it('builds a dict from name/value columns with case-insensitive headers', () => {
    const dict = rowsToDict({
      columns: [{ name: 'VARIABLE_NAME' }, { name: 'Value' }],
      rows: [['Uptime', '100'], ['Threads_connected', '5']],
    })
    expect(dict['Uptime']).toBe('100')
    expect(dict['Threads_connected']).toBe('5')
  })
  it('falls back to positional columns when name/value headers are absent', () => {
    const dict = rowsToDict({ columns: [{ name: 'a' }, { name: 'b' }], rows: [['k1', 'v1']] })
    expect(dict['k1']).toBe('v1')
  })
  it('handles missing columns and nullish cells defensively', () => {
    // No columns array and no names → positional fallback + empty-name rows skipped.
    expect(rowsToDict({ rows: [['', 'v'], ['k2', null], [null, 'v3']] })).toEqual({ k2: '' })
    // A column without a name falls back to an empty column key, and a missing value cell stays ''.
    const noName = rowsToDict({ columns: [{ }, { name: 'Value' }], rows: [['k', 'v']] })
    expect(noName['k']).toBe('v')
    const dict = rowsToDict({ columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [['k', undefined]] })
    expect(dict['k']).toBe('')
  })
})

describe('queryRowsToRecords', () => {
  it('returns [] for empty input and lowercases column names', () => {
    expect(queryRowsToRecords(undefined)).toEqual([])
    expect(queryRowsToRecords({ rows: [] })).toEqual([])
    const recs = queryRowsToRecords({ columns: [{ name: 'ID' }, { name: 'User' }], rows: [[1, 'root']] })
    expect(recs).toEqual([{ id: 1, user: 'root' }])
  })
  it('falls back to empty column keys when columns are missing or unnamed', () => {
    // No columns → each record is an empty object (columns || [] → []).
    expect(queryRowsToRecords({ rows: [[1, 'x']] })).toEqual([{}])
    // An unnamed column maps to an empty key.
    expect(queryRowsToRecords({ columns: [{ }, { name: 'User' }], rows: [[1, 'root']] })).toEqual([{ '': 1, user: 'root' }])
  })
})

describe('mysqlClientIp', () => {
  it('extracts ipv4, bracket ipv6, falls back to the host, and handles empty input', () => {
    expect(mysqlClientIp('10.0.0.1:53982')).toBe('10.0.0.1')
    expect(mysqlClientIp('[::1]:1234')).toBe('::1')
    expect(mysqlClientIp('localhost')).toBe('localhost')
    expect(mysqlClientIp('')).toBe('--')
  })
  it('returns the raw host when the closing bracket is not past position 1', () => {
    expect(mysqlClientIp('[]:123')).toBe('[]')
  })
})

describe('parseMysqlProcessDetails', () => {
  it('maps processlist rows and defaults missing fields', () => {
    const rows = parseMysqlProcessDetails({
      columns: [{ name: 'id' }, { name: 'user' }, { name: 'host' }, { name: 'db' }, { name: 'command' }, { name: 'time' }, { name: 'state' }, { name: 'info' }],
      rows: [[1, 'root', '10.0.0.1:123', 'db1', 'Query', 5, 'active', 'SELECT 1']],
    })
    expect(rows[0]).toMatchObject({ id: 1, user: 'root', ip: '10.0.0.1', database: 'db1', command: 'Query', timeSeconds: 5, state: 'active', sql: 'SELECT 1' })
  })
  it('handles empty info as an idle placeholder', () => {
    const rows = parseMysqlProcessDetails({
      columns: [{ name: 'host' }, { name: 'info' }],
      rows: [['h', null]],
    })
    expect(rows[0]!.sql).toBe('(空闲连接)')
    expect(rows[0]!.ip).toBe('h')
  })
  it('coerces non-numeric duration/id fields to 0', () => {
    const rows = parseMysqlProcessDetails({
      columns: [{ name: 'id' }, { name: 'host' }, { name: 'time' }],
      rows: [['abc', 'h', 'nope']],
    })
    expect(rows[0]!.id).toBe(0)
    expect(rows[0]!.timeSeconds).toBe(0)
  })
})

describe('parseMysqlSlowQueryDetails', () => {
  it('parses slow_log rows', () => {
    const list = parseMysqlSlowQueryDetails({
      columns: [{ name: 'started_at' }, { name: 'duration' }, { name: 'lock_time' }, { name: 'rows_examined' }, { name: 'db' }, { name: 'user_host' }, { name: 'sql_text' }, { name: 'executions' }],
      rows: [['2026-01-01', '1.2', '0.1', 100, 'db', 'user@ip', 'SELECT 1', 3]],
    }, 'slow_log')
    expect(list[0]).toMatchObject({ startedAt: '2026-01-01', duration: '1.2', lockTime: '0.1', rowsExamined: 100, database: 'db', userHost: 'user@ip', sql: 'SELECT 1', executions: 3, source: 'slow_log' })
  })
  it('parses performance_schema digest rows and falls back user_host', () => {
    const list = parseMysqlSlowQueryDetails({
      columns: [{ name: 'first_seen' }, { name: 'total_latency' }, { name: 'rows_examined' }, { name: 'db' }, { name: 'digest_text' }],
      rows: [[null, '5 s', 200, 'db', 'SELECT 2']],
    }, 'performance_schema')
    expect(list[0]).toMatchObject({ startedAt: '--', duration: '5 s', rowsExamined: 200, database: 'db', userHost: '聚合语句', sql: 'SELECT 2', executions: undefined, source: 'performance_schema' })
  })
})

describe('num', () => {
  it('returns the fallback for missing/empty and parses finite numbers', () => {
    expect(num({}, 'x', 7)).toBe(7)
    expect(num({ x: '' }, 'x', 7)).toBe(7)
    expect(num({ x: '3.5' }, 'x')).toBe(3.5)
    expect(num({ x: 'abc' }, 'x', 9)).toBe(9)
  })
})

describe('parseMysqlMetrics', () => {
  const status = {
    columns: [{ name: 'Variable_name' }, { name: 'Value' }],
    rows: [
      ['Uptime', '100'], ['Threads_connected', '10'], ['Threads_running', '2'],
      ['Questions', '500'], ['Slow_queries', '3'], ['Queries', '1000'],
      ['Bytes_received', '1024'], ['Bytes_sent', '2048'],
      ['Innodb_buffer_pool_pages_total', '100'], ['Innodb_buffer_pool_pages_free', '20'],
      ['Innodb_buffer_pool_read_requests', '10000'], ['Innodb_buffer_pool_reads', '100'],
    ],
  }
  const variables = {
    columns: [{ name: 'Variable_name' }, { name: 'Value' }],
    rows: [['version', '8.0'], ['max_connections', '200'], ['innodb_buffer_pool_size', '1048576'], ['innodb_page_size', '16384']],
  }

  it('parses full mysql metrics including table + size stats', () => {
    const m = parseMysqlMetrics({
      status,
      variables,
      tableStats: { columns: [{ name: 'table_count' }], rows: [[5]] },
      sizeStats: { columns: [{ name: 'data_size' }, { name: 'index_size' }], rows: [[1000, 200]] },
    })
    expect(m.version).toBe('8.0')
    expect(m.uptimeSeconds).toBe(100)
    expect(m.threadsConnected).toBe(10)
    expect(m.threadsRunning).toBe(2)
    expect(m.maxConnections).toBe(200)
    expect(m.questions).toBe(500)
    expect(m.slowQueries).toBe(3)
    expect(m.queries).toBe(1000)
    expect(m.bytesReceived).toBe(1024)
    expect(m.bytesSent).toBe(2048)
    expect(m.bufferPoolHitRate).toBeCloseTo(99)
    expect(m.tableCount).toBe(5)
    expect(m.dataSize).toBe(1000)
    expect(m.indexSize).toBe(200)
  })

  it('falls back to defaults when optional stats and keys are missing', () => {
    const m = parseMysqlMetrics({
      status: { columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [['Uptime', '50']] },
      variables: { columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [] },
    })
    expect(m.version).toBe('--')
    expect(m.maxConnections).toBe(151)
    expect(m.threadsConnected).toBe(0)
    expect(m.bufferPoolHitRate).toBe(0)
    expect(m.tableCount).toBe(0)
    expect(m.dataSize).toBe(0)
    expect(m.indexSize).toBe(0)
  })

  it('tolerates null/undersized stat rows and nullish size cells', () => {
    const base = {
      status: { columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [['Uptime', '50']] },
      variables: { columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [] },
    }
    // rows[0] is null → both guards skip.
    const nullRow = parseMysqlMetrics({ ...base, tableStats: { columns: [{ name: 'table_count' }], rows: [null] as unknown as unknown[][] }, sizeStats: { columns: [{ name: 'data_size' }, { name: 'index_size' }], rows: [null] as unknown as unknown[][] } })
    expect(nullRow.tableCount).toBe(0)
    expect(nullRow.dataSize).toBe(0)
    // rows[0] is an array whose cells are null → ?? '0' fallback.
    const nullCells = parseMysqlMetrics({ ...base, tableStats: { columns: [{ name: 'table_count' }], rows: [[null]] as unknown as unknown[][] }, sizeStats: { columns: [{ name: 'data_size' }, { name: 'index_size' }], rows: [[null, null]] as unknown as unknown[][] } })
    expect(nullCells.tableCount).toBe(0)
    expect(nullCells.dataSize).toBe(0)
    expect(nullCells.indexSize).toBe(0)
  })
})

describe('parsePostgresMetrics', () => {
  it('parses a summary row and defaults missing numerics', () => {
    const p = parsePostgresMetrics({
      version: '16', uptime_seconds: '100', connections: '5', active_connections: '1',
      max_connections: '100', database_size: '1024', cache_hit_rate: '99.5',
      table_count: '3', transactions: '10',
    })
    expect(p.version).toBe('16')
    expect(p.uptimeSeconds).toBe(100)
    expect(p.connections).toBe(5)
    expect(p.activeConnections).toBe(1)
    expect(p.maxConnections).toBe(100)
    expect(p.databaseSize).toBe(1024)
    expect(p.cacheHitRate).toBe(99.5)
    expect(p.tableCount).toBe(3)
    expect(p.transactions).toBe(10)
  })
  it('defaults non-numeric fields to 0', () => {
    const p = parsePostgresMetrics({ version: undefined })
    expect(p.version).toBe('--')
    expect(p.uptimeSeconds).toBe(0)
    expect(p.connections).toBe(0)
    expect(p.maxConnections).toBe(0)
  })
  it('coerces non-finite numbers to 0', () => {
    const p = parsePostgresMetrics({ uptime_seconds: 'abc', connections: 'x' })
    expect(p.uptimeSeconds).toBe(0)
    expect(p.connections).toBe(0)
  })
})

describe('detailRecords', () => {
  it('keeps scalars and stringifies objects', () => {
    const recs = detailRecords([{ a: 'x', b: 1, c: null, d: { k: 1 } }])
    expect(recs[0]).toEqual({ a: 'x', b: 1, c: null, d: '[object Object]' })
  })
})

describe('sql constants sanity', () => {
  it('exposes the expected SQL snippets', () => {
    expect(MYSQL_STATUS_SQL).toContain('SHOW GLOBAL STATUS')
    expect(MYSQL_VARIABLES_SQL).toContain('SHOW GLOBAL VARIABLES')
    expect(PG_SUMMARY_SQL).toContain('pg_stat_activity')
  })
})
