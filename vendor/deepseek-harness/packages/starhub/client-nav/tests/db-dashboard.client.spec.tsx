// @vitest-environment jsdom
/**
 * DbDashboard.tsx 组件测试:MySQL / PostgreSQL / Redis 的加载、tab 切换、
 * 刷新、错误态、未连接/不支持类型的空态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  DbDashboard, dashboardTabs, dbTypeName,
  mysqlConnUsage, postgresConnUsage, mysqlDataRatio,
} from '../src/client/dashboard/DbDashboard.tsx'
import type { MysqlMetrics, PostgresMetrics } from '../src/client/dashboard/db-dashboard-service.ts'

function stubInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke: handler }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** 从 db_mysql_execute 参数取 SQL 文本(与 RPC 契约一致,缺失回退空串)。 */
function sqlOf(args?: Record<string, unknown>): string {
  const raw = args?.sql as string | number | boolean | bigint | symbol | null | undefined
  return String(raw ?? '')
}

/** MySQL-shaped execute dispatcher keyed on the SQL text. */
function mysqlInvoke(overrides: {
  slowFail?: boolean
  bothSlowFail?: boolean
  processFail?: boolean
  variablesFail?: boolean
  tableStatsFail?: boolean
  sizeStatsFail?: boolean
  slowQueries?: string
} = {}) {
  const calls: string[] = []
  const invoke = (cmd: string, args?: Record<string, unknown>): unknown => {
    if (cmd !== 'db_mysql_execute') return Promise.resolve(null)
    const sql = sqlOf(args)
    calls.push(sql)
    if (sql.includes('SHOW GLOBAL STATUS')) {
      const slowQueries = overrides.slowQueries ?? '3'
      return Promise.resolve({
        columns: [{ name: 'Variable_name' }, { name: 'Value' }],
        rows: [['Uptime', '100'], ['Threads_connected', '10'], ['Threads_running', '2'], ['Questions', '500'], ['Slow_queries', slowQueries], ['Queries', '1000'], ['Bytes_received', '1024'], ['Bytes_sent', '2048'], ['Innodb_buffer_pool_pages_total', '100'], ['Innodb_buffer_pool_pages_free', '20'], ['Innodb_buffer_pool_read_requests', '10000'], ['Innodb_buffer_pool_reads', '100']],
      })
    }
    if (sql.includes('SHOW GLOBAL VARIABLES')) {
      if (overrides.variablesFail) return Promise.reject(new Error('variables down'))
      return Promise.resolve({ columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [['version', '8.0'], ['max_connections', '200'], ['innodb_buffer_pool_size', '1048576'], ['innodb_page_size', '16384']] })
    }
    if (sql.includes('table_count')) {
      if (overrides.tableStatsFail) return Promise.reject(new Error('table stats down'))
      return Promise.resolve({ columns: [{ name: 'table_count' }], rows: [[3]] })
    }
    if (sql.includes('data_size')) {
      if (overrides.sizeStatsFail) return Promise.reject(new Error('size stats down'))
      return Promise.resolve({ columns: [{ name: 'data_size' }, { name: 'index_size' }], rows: [[1000, 200]] })
    }
    if (sql.includes('PROCESSLIST')) {
      if (overrides.processFail) return Promise.reject(new Error('process down'))
      return Promise.resolve({
        columns: [{ name: 'id' }, { name: 'user' }, { name: 'host' }, { name: 'db' }, { name: 'command' }, { name: 'time' }, { name: 'state' }, { name: 'info' }],
        rows: [[1, 'root', '10.0.0.1:123', 'db1', 'Query', 5, 'active', 'SELECT 1']],
      })
    }
    if (sql.includes('mysql.slow_log')) {
      if (overrides.slowFail || overrides.bothSlowFail) return Promise.reject(new Error('slow down'))
      return Promise.resolve({
        columns: [{ name: 'started_at' }, { name: 'duration' }, { name: 'rows_examined' }, { name: 'db' }, { name: 'user_host' }, { name: 'sql_text' }],
        rows: [['2026-01-01', '1.2', 100, 'db', 'u@ip', 'SELECT 1']],
      })
    }
    if (sql.includes('performance_schema')) {
      if (overrides.bothSlowFail) return Promise.reject(new Error('perf down'))
      return Promise.resolve({
        columns: [{ name: 'first_seen' }, { name: 'total_latency' }, { name: 'rows_examined' }, { name: 'db' }, { name: 'digest_text' }],
        rows: [['2026-01-01', '5 s', 200, 'db', 'SELECT 2']],
      })
    }
    return Promise.resolve({ columns: [], rows: [] })
  }
  return { invoke, calls }
}

/** PostgreSQL execute dispatcher. */
function pgInvoke() {
  const calls: string[] = []
  const invoke = (cmd: string, args?: Record<string, unknown>): unknown => {
    if (cmd !== 'db_mysql_execute') return Promise.resolve(null)
    const sql = sqlOf(args)
    calls.push(sql)
    if (sql.includes('pg_stat_activity') && !sql.includes('history')) {
      if (sql.includes('current_setting')) {
        return Promise.resolve({
          columns: [{ name: 'version' }, { name: 'uptime_seconds' }, { name: 'connections' }, { name: 'active_connections' }, { name: 'max_connections' }, { name: 'database_size' }, { name: 'cache_hit_rate' }, { name: 'table_count' }, { name: 'transactions' }],
          rows: [['16', '100', '5', '1', '100', '1024', '99.5', '3', '10']],
        })
      }
      return Promise.resolve({
        columns: [{ name: 'ip' }, { name: 'user' }, { name: 'database' }, { name: 'application' }, { name: 'state' }, { name: 'duration' }, { name: 'wait' }, { name: 'sql' }],
        rows: [['10.0.0.1', 'u', 'db', 'psql', 'active', 2, 'lock:wait', 'SELECT 1']],
      })
    }
    if (sql.includes('pg_stat_statements')) {
      return Promise.resolve({
        columns: [{ name: 'duration' }, { name: 'calls' }, { name: 'rows' }, { name: 'user' }, { name: 'database' }, { name: 'ip' }, { name: 'sql' }],
        rows: [['1.5 s', 10, 3, '--', 'db', '历史聚合', 'SELECT 2']],
      })
    }
    return Promise.resolve({ columns: [], rows: [] })
  }
  return { invoke, calls }
}

beforeEach(cleanup)
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('MySQL dashboard', () => {
  it('loads overview metrics and switches tabs', async () => {
    const { invoke } = mysqlInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected database="app" />)
      expect(await screen.findByText(/8\.0/)).toBeTruthy()
      expect(screen.getByText('app')).toBeTruthy()
      // Overview cards present.
      expect(screen.getAllByText('运行时间').length).toBeGreaterThan(0)
      // Switch to performance.
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      expect(screen.getAllByText('慢查询').length).toBeGreaterThan(0)
      // Switch to network.
      fireEvent.click(screen.getByRole('button', { name: '网络' }))
      expect(screen.getAllByText('网络接收').length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('opens the connection detail table from the 连接数 card', async () => {
    const { invoke } = mysqlInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected />)
      await screen.findByText(/8\.0/)
      // Click the 连接数 card to open its detail modal.
      fireEvent.click(screen.getByText('连接数'))
      expect(await screen.findByText(/10\.0\.0\.1/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('falls back to performance_schema when slow log rejects', async () => {
    const { invoke } = mysqlInvoke({ slowFail: true })
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected />)
      await screen.findByText(/8\.0/)
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      fireEvent.click(screen.getByText('慢查询'))
      expect(await screen.findByText('SELECT 2')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('clears the slow-query table when both slow log and performance_schema reject', async () => {
    const { invoke } = mysqlInvoke({ bothSlowFail: true })
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected />)
      await screen.findByText(/8\.0/)
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      fireEvent.click(screen.getByText('慢查询'))
      expect(await screen.findByText(/无法读取慢日志与 performance_schema/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('can still render when the variables query rejects', async () => {
    const { invoke } = mysqlInvoke({ variablesFail: true })
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected />)
      expect(await screen.findByText(/variables down/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('renders when table stats, size stats or processlist reject individually', async () => {
    for (const opts of [{ tableStatsFail: true }, { sizeStatsFail: true }, { processFail: true }]) {
      cleanup()
      const { invoke } = mysqlInvoke(opts)
      const restore = stubInvoke(invoke)
      try {
        render(<DbDashboard connId="c1" dbType="mysql" connected />)
        expect(await screen.findByText(/8\.0/)).toBeTruthy()
      } finally {
        restore()
      }
    }
  })

  it('renders yellow/red slow-query colors for threshold crossings', async () => {
    for (const slowQueries of ['50', '200']) {
      cleanup()
      const { invoke } = mysqlInvoke({ slowQueries })
      const restore = stubInvoke(invoke)
      try {
        render(<DbDashboard connId="c1" dbType="mysql" connected />)
        await screen.findByText(/8\.0/)
        fireEvent.click(screen.getByRole('button', { name: '性能' }))
        expect(screen.getAllByText('慢查询').length).toBeGreaterThan(0)
      } finally {
        restore()
      }
    }
  })

  it('surfaces an execute rejection as an error banner', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_mysql_execute') return Promise.reject(new Error('status down'))
      return Promise.resolve(null)
    })
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected />)
      expect(await screen.findByText(/status down/)).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('PostgreSQL dashboard', () => {
  it('loads overview + performance and opens the slow statements table', async () => {
    const { invoke } = pgInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="postgresql" connected />)
      expect(await screen.findByText(/16/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      fireEvent.click(screen.getByText('慢语句'))
      expect(await screen.findByText('SELECT 2')).toBeTruthy()
      // Overview connection detail table.
      fireEvent.click(screen.getByRole('button', { name: '概览' }))
      fireEvent.click(screen.getByText('连接数'))
      expect(await screen.findByText(/10\.0\.0\.1/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('falls back to active sessions when pg_stat_statements rejects', async () => {
    const restore = stubInvoke((cmd, args) => {
      if (cmd !== 'db_mysql_execute') return Promise.resolve(null)
      const sql = sqlOf(args)
      if (sql.includes('current_setting')) {
        return Promise.resolve({ columns: [{ name: 'version' }, { name: 'uptime_seconds' }, { name: 'connections' }, { name: 'active_connections' }, { name: 'max_connections' }, { name: 'database_size' }, { name: 'cache_hit_rate' }, { name: 'table_count' }, { name: 'transactions' }], rows: [['15', '50', '2', '1', '100', '0', '90', '1', '5']] })
      }
      if (sql.includes('pg_stat_activity')) {
        return Promise.resolve({ columns: [{ name: 'state' }, { name: 'duration' }, { name: 'sql' }], rows: [['active', 5, 'RUNNING SLOW Q']] })
      }
      if (sql.includes('pg_stat_statements')) return Promise.reject(new Error('no statements'))
      return Promise.resolve({ columns: [], rows: [] })
    })
    try {
      render(<DbDashboard connId="c1" dbType="postgresql" connected />)
      await screen.findByText(/15/)
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      fireEvent.click(screen.getByText('慢语句'))
      // Fallback row mirrors the active session (its SQL text).
      expect(await screen.findByText('RUNNING SLOW Q')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('tolerates an empty summary row and an inactive session in the fallback', async () => {
    const restore = stubInvoke((cmd, args) => {
      if (cmd !== 'db_mysql_execute') return Promise.resolve(null)
      const sql = sqlOf(args)
      if (sql.includes('current_setting')) {
        // Empty summary → falls back to the {} default metrics.
        return Promise.resolve({ columns: [{ name: 'version' }, { name: 'uptime_seconds' }], rows: [] })
      }
      if (sql.includes('pg_stat_activity')) {
        // A mix of active and idle sessions, plus a null duration, exercises the filter short-circuit and ?? fallback.
        return Promise.resolve({ columns: [{ name: 'state' }, { name: 'duration' }, { name: 'sql' }], rows: [['idle', 0, 'IDLE SQL'], ['active', null, 'NULL DUR SQL'], ['active', 3, 'ACTIVE SQL']] })
      }
      if (sql.includes('pg_stat_statements')) return Promise.reject(new Error('no statements'))
      return Promise.resolve({ columns: [], rows: [] })
    })
    try {
      render(<DbDashboard connId="c1" dbType="postgresql" connected />)
      await screen.findByText(/v--/)
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      fireEvent.click(screen.getByText('慢语句'))
      expect(await screen.findByText('ACTIVE SQL')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('Redis dashboard', () => {
  const redisInvoke = (opts: { infoFail?: boolean; sizeFail?: boolean; maxmemory?: number; usedMemory?: number } = {}) => {
    const usedMemory = opts.usedMemory ?? 1048576
    const maxmemory = opts.maxmemory ?? 0
    const invoke = (cmd: string): unknown => {
      if (cmd === 'db_redis_info') {
        if (opts.infoFail) return Promise.reject(new Error('info down'))
        return Promise.resolve(['# Server', 'redis_version:7.2', 'uptime_in_seconds:3600', 'connected_clients:3', `used_memory:${usedMemory}`, 'used_memory_peak:2097152', 'used_memory_human:1.00M', 'keyspace_hits:90', 'keyspace_misses:10', 'total_commands_processed:1000', 'instantaneous_ops_per_sec:12', 'role:master', `maxmemory:${maxmemory}`].join('\n'))
      }
      if (cmd === 'db_redis_db_size') {
        if (opts.sizeFail) return Promise.reject(new Error('size down'))
        return Promise.resolve({ size: 42 })
      }
      return Promise.resolve(null)
    }
    return invoke
  }

  it('loads redis overview and performance tabs', async () => {
    const restore = stubInvoke(redisInvoke())
    try {
      render(<DbDashboard connId="c1" dbType="redis" connected />)
      expect(await screen.findByText(/7\.2/)).toBeTruthy()
      expect(screen.getAllByText('总键数').length).toBeGreaterThan(0)
      fireEvent.click(screen.getByRole('button', { name: '性能' }))
      expect(screen.getAllByText('命中率').length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('surfaces a redis info rejection as an error banner', async () => {
    const restore = stubInvoke(redisInvoke({ infoFail: true }))
    try {
      render(<DbDashboard connId="c1" dbType="redis" connected />)
      expect(await screen.findByText(/info down/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows a size limit and over-80% red memory when maxmemory is configured', async () => {
    const restore = stubInvoke(redisInvoke({ maxmemory: 128 * 1024 * 1024, usedMemory: 120 * 1024 * 1024 }))
    try {
      render(<DbDashboard connId="c1" dbType="redis" connected />)
      expect(await screen.findByText(/上限 128 MB/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('tolerates a db_size rejection (info still renders)', async () => {
    const restore = stubInvoke(redisInvoke({ sizeFail: true }))
    try {
      render(<DbDashboard connId="c1" dbType="redis" connected />)
      expect(await screen.findByText(/7\.2/)).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('DbDashboard states', () => {
  it('renders an unsupported message for other db types', async () => {
    const restore = stubInvoke(() => Promise.resolve(null))
    try {
      render(<DbDashboard connId="c1" dbType="sqlite" connected />)
      expect(await screen.findByText(/请先用 SQL 编辑器查询/)).toBeTruthy()
      // The dbType label also renders the uppercase type name.
      expect(screen.getAllByText(/SQLite/).length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('shows a hint when not connected and stops loading', async () => {
    const restore = stubInvoke(() => Promise.resolve(null))
    try {
      const { rerender } = render(<DbDashboard connId="c1" dbType="mysql" connected={false} />)
      expect(await screen.findByText(/未连接/)).toBeTruthy()
      // With no connId it also stops loading quietly.
      rerender(<DbDashboard connId="" dbType="mysql" connected />)
      expect(screen.queryByText('刷新')).not.toBeNull()
    } finally {
      restore()
    }
  })

  it('refreshes metrics when the refresh button is clicked', async () => {
    let statusCount = 0
    const invoke = (cmd: string, args?: Record<string, unknown>): unknown => {
      if (cmd !== 'db_mysql_execute') return Promise.resolve(null)
      const sql = sqlOf(args)
      if (sql.includes('SHOW GLOBAL STATUS')) {
        statusCount += 1
        return Promise.resolve({ columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [['Uptime', String(statusCount * 100)], ['Threads_connected', '1'], ['Threads_running', '0'], ['Questions', '0'], ['Slow_queries', '0'], ['Queries', '0'], ['Bytes_received', '0'], ['Bytes_sent', '0'], ['Innodb_buffer_pool_read_requests', '0'], ['Innodb_buffer_pool_reads', '0']] })
      }
      if (sql.includes('SHOW GLOBAL VARIABLES')) return Promise.resolve({ columns: [{ name: 'Variable_name' }, { name: 'Value' }], rows: [['version', '8.0'], ['max_connections', '100']] })
      if (sql.includes('table_count')) return Promise.resolve({ columns: [{ name: 'table_count' }], rows: [[1]] })
      if (sql.includes('data_size')) return Promise.resolve({ columns: [{ name: 'data_size' }, { name: 'index_size' }], rows: [[0, 0]] })
      if (sql.includes('PROCESSLIST')) return Promise.resolve({ columns: [], rows: [] })
      if (sql.includes('mysql.slow_log')) return Promise.resolve({ columns: [], rows: [] })
      return Promise.resolve({ columns: [], rows: [] })
    }
    const restore = stubInvoke(invoke)
    try {
      render(<DbDashboard connId="c1" dbType="mysql" connected />)
      await screen.findByText(/8\.0/)
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      await waitFor(() =>{  expect(statusCount).toBeGreaterThanOrEqual(2) })
    } finally {
      restore()
    }
  })

  it('renders a dashboard tab group and name helpers', () => {
    expect(dashboardTabs('mysql').length).toBe(3)
    expect(dashboardTabs('postgresql').length).toBe(2)
    expect(dashboardTabs('redis').length).toBe(2)
    expect(dashboardTabs('sqlite').length).toBe(1)
    expect(dbTypeName('mysql')).toBe('MySQL')
    expect(dbTypeName('postgresql')).toBe('PostgreSQL')
    expect(dbTypeName('redis')).toBe('Redis')
    expect(dbTypeName('sqlite')).toBe('SQLite')
    // Unmapped type hits the switch default → uppercase.
    expect(dbTypeName('sqlserver')).toBe('SQLSERVER')
  })

  it('computes connection/data-ratio helpers with edge divisions', () => {
    expect(mysqlConnUsage({ maxConnections: 0, threadsConnected: 9 } as unknown as MysqlMetrics)).toBe(0)
    expect(mysqlConnUsage({ maxConnections: 100, threadsConnected: 50 } as unknown as MysqlMetrics)).toBe(50)
    expect(postgresConnUsage({ maxConnections: 0, connections: 5 } as unknown as PostgresMetrics)).toBe(0)
    expect(postgresConnUsage({ maxConnections: 100, connections: 25 } as unknown as PostgresMetrics)).toBe(25)
    expect(mysqlDataRatio({ dataSize: 0, indexSize: 0 } as unknown as MysqlMetrics)).toBe(0)
    expect(mysqlDataRatio({ dataSize: 75, indexSize: 25 } as unknown as MysqlMetrics)).toBe(75)
  })
})
