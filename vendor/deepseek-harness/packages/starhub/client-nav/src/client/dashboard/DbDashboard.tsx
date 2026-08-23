/**
 * StarHub 原生 DB 监控 Dashboard(批次 4:DB Dashboard React 化)。
 *
 * 自 `src/components/dashboard/DbDashboard.vue` 迁移:右栏 tab(概览/性能/网络)
 * + 指标卡(复用 broker/DashboardCard) + 明细表(连接会话 / 慢语句)。数据面
 * 全部走真实 RPC:`db_mysql_execute`(MySQL/PG 原生 SQL)与 `db_redis_info` /
 * `db_redis_db_size`(Redis INFO)。无任何 mock。
 *
 * @module StarHub DB dashboard (client)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DashboardCard, type DashboardDetailTable } from '../broker/DashboardCard.tsx'
import { MetricIcon } from './metric-icons.tsx'
import {
  dbExecute, redisInfo, redisDbSize,
  parseRedisInfo, parseMysqlMetrics, parseMysqlProcessDetails, parseMysqlSlowQueryDetails,
  parsePostgresMetrics, queryRowsToRecords, detailRecords, formatDbBytes, formatDbUptime,
  MYSQL_STATUS_SQL, MYSQL_VARIABLES_SQL, MYSQL_TABLE_COUNT_SQL, MYSQL_SIZE_SQL,
  MYSQL_PROCESSLIST_SQL, MYSQL_SLOW_LOG_SQL, MYSQL_DIGEST_SQL,
  PG_SUMMARY_SQL, PG_SESSIONS_SQL, PG_STATEMENTS_SQL,
  type RedisMetrics, type MysqlMetrics, type PostgresMetrics,
  type MysqlProcessDetail, type MysqlSlowQueryDetail, type DetailRecord,
} from './db-dashboard-service.ts'
import css from './DbDashboard.module.css'

/** Dashboard 右栏 tab 分组。 */
type DashTab = 'overview' | 'performance' | 'network'

export interface DbDashboardProps {
  connId: string
  dbType: string
  connected: boolean
  database?: string | undefined
}

const DEFAULT_REDIS: RedisMetrics = {
  version: '--', uptimeSeconds: 0, uptimePretty: '--', connectedClients: 0, connectedSlaves: 0,
  usedMemory: 0, usedMemoryPeak: 0, usedMemoryHuman: '0B', totalKeys: 0, hitRate: 0,
  totalCommandsProcessed: 0, instantaneousOpsPerSec: 0, role: '--', maxmemory: 0, raw: '',
}

const DEFAULT_MYSQL: MysqlMetrics = {
  version: '--', uptimeSeconds: 0, uptimePretty: '--', threadsConnected: 0, threadsRunning: 0,
  maxConnections: 151, questions: 0, slowQueries: 0, queries: 0, bytesReceived: 0, bytesSent: 0,
  innodbBufferPoolSize: 0, innodbBufferPoolUsed: 0, bufferPoolHitRate: 0, tableCount: 0,
  dataSize: 0, indexSize: 0,
}

const DEFAULT_POSTGRES: PostgresMetrics = {
  version: '--', uptimeSeconds: 0, connections: 0, activeConnections: 0, maxConnections: 100,
  databaseSize: 0, cacheHitRate: 0, tableCount: 0, transactions: 0,
}

/** 可用的 tab 集合(依 dbType 而定)。 */
export function dashboardTabs(dbType: string): DashTab[] {
  if (dbType === 'mysql') return ['overview', 'performance', 'network']
  if (dbType === 'postgresql' || dbType === 'redis') return ['overview', 'performance']
  return ['overview']
}

/** dbType → 展示名。 */
export function dbTypeName(dbType: string): string {
  switch (dbType) {
    case 'mysql': return 'MySQL'
    case 'postgresql': return 'PostgreSQL'
    case 'redis': return 'Redis'
    case 'sqlite': return 'SQLite'
    default: return dbType.toUpperCase()
  }
}

/** MySQL 连接使用率(0-100,maxConnections 为 0 时不显示)。 */
export function mysqlConnUsage(metrics: MysqlMetrics): number {
  if (metrics.maxConnections === 0) return 0
  return (metrics.threadsConnected / metrics.maxConnections) * 100
}

/** PostgreSQL 连接使用率(0-100)。 */
export function postgresConnUsage(metrics: PostgresMetrics): number {
  if (metrics.maxConnections <= 0) return 0
  return (metrics.connections / metrics.maxConnections) * 100
}

/** MySQL 数据大小占比(0-100)。 */
export function mysqlDataRatio(metrics: MysqlMetrics): number {
  const total = metrics.dataSize + metrics.indexSize
  return total > 0 ? (metrics.dataSize / total) * 100 : 0
}

/**
 * Render the native DB monitoring dashboard.
 * @param props - conn id、db type、connected 与 database。
 * @returns the dashboard.
 */
export function DbDashboard({ connId, dbType, connected, database }: DbDashboardProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<DashTab>('overview')

  const [redis, setRedis] = useState<RedisMetrics>(DEFAULT_REDIS)
  const [mysql, setMysql] = useState<MysqlMetrics>(DEFAULT_MYSQL)
  const [postgres, setPostgres] = useState<PostgresMetrics>(DEFAULT_POSTGRES)

  const [mysqlProcesses, setMysqlProcesses] = useState<MysqlProcessDetail[]>([])
  const [mysqlSlowQueries, setMysqlSlowQueries] = useState<MysqlSlowQueryDetail[]>([])
  const mysqlSlowHint = useRef('慢日志未开启、暂无记录,或当前账号无权读取 mysql.slow_log。')

  const [postgresSessions, setPostgresSessions] = useState<DetailRecord[]>([])
  const [postgresSlowStatements, setPostgresSlowStatements] = useState<DetailRecord[]>([])

  const sampleKey = useRef(0)

  const fail = useCallback((e: unknown) => {
    // Error reasons are always Error objects / strings from db_* RPC rejections;
    // the nullish fallback only guards an impossible undefined throw.
    const reason = e as string | number | boolean | bigint | symbol | null | undefined
    /* v8 ignore next -- nullish e is unreachable (RPC rejections are Error/string) */
    setError(String(reason ?? '').slice(0, 200))
  }, [])

  const loadRedis = useCallback(async () => {
    const infoP = redisInfo(connId, 'all')
    const sizeP = redisDbSize(connId)
    const [info, sizeRes] = await Promise.allSettled([
      infoP,
      sizeP,
    ])
    if (info.status !== 'fulfilled') throw info.reason
    const dbSize = sizeRes.status === 'fulfilled' ? sizeRes.value.size : undefined
    setRedis(parseRedisInfo(info.value, dbSize))
  }, [connId])

  // MySQL 慢日志:优先读 TABLE 慢日志,失败回退 performance_schema digest。
  const loadMysqlSlowQueries = useCallback(async () => {
    try {
      const slowLog = await dbExecute(connId, MYSQL_SLOW_LOG_SQL, database)
      setMysqlSlowQueries(parseMysqlSlowQueryDetails(slowLog, 'slow_log'))
      mysqlSlowHint.current = 'mysql.slow_log 当前没有记录;请确认 slow_query_log=ON 且 log_output 包含 TABLE。'
    } catch {
      try {
        const digest = await dbExecute(connId, MYSQL_DIGEST_SQL, database)
        setMysqlSlowQueries(parseMysqlSlowQueryDetails(digest, 'performance_schema'))
        mysqlSlowHint.current = 'performance_schema 当前没有语句摘要;请确认已启用 statements digest consumer。'
      } catch {
        setMysqlSlowQueries([])
        mysqlSlowHint.current = '无法读取慢日志与 performance_schema;请开启慢日志或授予对应只读权限。'
      }
    }
  }, [connId, database])

  const loadMysql = useCallback(async () => {
    const [status, variables, tableStats, sizeStats, processList] = await Promise.allSettled([
      dbExecute(connId, MYSQL_STATUS_SQL, database),
      dbExecute(connId, MYSQL_VARIABLES_SQL, database),
      dbExecute(connId, MYSQL_TABLE_COUNT_SQL, database),
      dbExecute(connId, MYSQL_SIZE_SQL, database),
      dbExecute(connId, MYSQL_PROCESSLIST_SQL, database),
    ])
    if (status.status !== 'fulfilled') throw status.reason
    if (variables.status !== 'fulfilled') throw variables.reason
    setMysql(parseMysqlMetrics({
      status: status.value,
      variables: variables.value,
      tableStats: tableStats.status === 'fulfilled' ? tableStats.value : undefined,
      sizeStats: sizeStats.status === 'fulfilled' ? sizeStats.value : undefined,
    }))
    setMysqlProcesses(processList.status === 'fulfilled'
      ? parseMysqlProcessDetails(processList.value)
      : [])
    await loadMysqlSlowQueries()
  }, [connId, database, loadMysqlSlowQueries])

  const loadPostgres = useCallback(async () => {
    const [summary, sessions] = await Promise.all([
      dbExecute(connId, PG_SUMMARY_SQL, database),
      dbExecute(connId, PG_SESSIONS_SQL, database),
    ])
    const row = queryRowsToRecords(summary)[0] ?? {}
    const sessionRows = detailRecords(queryRowsToRecords(sessions))
    setPostgres(parsePostgresMetrics(row))
    setPostgresSessions(sessionRows)
    try {
      const history = await dbExecute(connId, PG_STATEMENTS_SQL, database)
      setPostgresSlowStatements(detailRecords(queryRowsToRecords(history)))
    } catch {
      setPostgresSlowStatements(sessionRows
        .filter(s => s.state === 'active' && Number(s.duration ?? 0) >= 1)
        .map(s => ({ ...s, calls: 1, rows: '--' })))
    }
  }, [connId, database])

  const loadAll = useCallback(async () => {
    if (!connId) {
      setLoading(false)
      return
    }
    if (!connected) {
      setLoading(false)
      return
    }
    try {
      if (dbType === 'redis') {
        await loadRedis()
      } else if (dbType === 'mysql') {
        await loadMysql()
      } else if (dbType === 'postgresql') {
        await loadPostgres()
      } else {
        setLoading(false)
        return
      }
      setError(null)
      sampleKey.current += 1
    } catch (e) {
      fail(e)
    } finally {
      setLoading(false)
    }
  }, [connId, connected, dbType, loadRedis, loadMysql, loadPostgres, fail])

  const refresh = useCallback(() => {
    setLoading(true)
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    void loadAll()
    // 连接切换时重置指标 tab。
    setTab('overview')
  }, [connId, dbType])

  const tabs = dashboardTabs(dbType)

  const dbTypeLabel = dbTypeName(dbType)

  // ─── 明细表 ───
  const mysqlConnectionTable = useMemo<DashboardDetailTable>(() => ({
    columns: [
      { key: 'ip', label: '客户端 IP' },
      { key: 'user', label: '用户' },
      { key: 'database', label: '数据库' },
      { key: 'command', label: '命令' },
      { key: 'time', label: '持续(s)', align: 'right' },
      { key: 'state', label: '状态' },
      { key: 'sql', label: '当前 SQL', wide: true },
    ],
    rows: mysqlProcesses.map(p => ({
      ip: p.ip, user: p.user, database: p.database, command: p.command,
      time: p.timeSeconds, state: p.state, sql: p.sql,
    })),
    emptyText: '当前没有其他连接;无 PROCESS 权限时 MySQL 只返回本账号会话。',
  }), [mysqlProcesses])

  const mysqlSlowQueryTable = useMemo<DashboardDetailTable>(() => ({
    columns: [
      { key: 'startedAt', label: '发生时间' },
      { key: 'duration', label: '耗时' },
      { key: 'database', label: '数据库' },
      { key: 'userHost', label: '用户 / IP' },
      { key: 'rowsExamined', label: '扫描行', align: 'right' },
      { key: 'executions', label: '次数', align: 'right' },
      { key: 'sql', label: '慢 SQL 语句', wide: true },
    ],
    rows: mysqlSlowQueries.map(q => ({
      startedAt: q.startedAt, duration: q.duration, database: q.database,
      userHost: q.userHost, rowsExamined: q.rowsExamined, executions: q.executions ?? 1, sql: q.sql,
    })),
    emptyText: mysqlSlowHint.current,
  }), [mysqlSlowQueries, mysqlSlowHint])

  const postgresConnectionTable = useMemo<DashboardDetailTable>(() => ({
    columns: [
      { key: 'ip', label: '客户端 IP' },
      { key: 'user', label: '用户' },
      { key: 'database', label: '数据库' },
      { key: 'application', label: '应用' },
      { key: 'state', label: '状态' },
      { key: 'duration', label: '持续(s)', align: 'right' },
      { key: 'wait', label: '等待事件' },
      { key: 'sql', label: '当前 SQL', wide: true },
    ],
    rows: postgresSessions,
    emptyText: '当前没有其他 PostgreSQL 会话,或当前账号无权读取 pg_stat_activity。',
  }), [postgresSessions])

  const postgresSlowQueryTable = useMemo<DashboardDetailTable>(() => ({
    columns: [
      { key: 'duration', label: '累计/当前耗时' },
      { key: 'calls', label: '次数', align: 'right' },
      { key: 'rows', label: '返回行', align: 'right' },
      { key: 'user', label: '用户' },
      { key: 'database', label: '数据库' },
      { key: 'ip', label: '客户端 IP' },
      { key: 'sql', label: 'SQL 语句', wide: true },
    ],
    rows: postgresSlowStatements,
    emptyText: '暂无慢语句;安装 pg_stat_statements 可查看历史聚合,否则仅展示当前运行超过 1 秒的语句。',
  }), [postgresSlowStatements])

  const version = dbType === 'redis' ? redis.version : dbType === 'postgresql' ? postgres.version : mysql.version

  return (
    <div className={css.dashboard}>
      <div className={css.header}>
        <span className={css.dbType}>{dbTypeLabel}</span>
        <span className={css.version}>v{version}</span>
        {database !== undefined && database !== '' && <span className={css.version}>{database}</span>}
        <span className={css.spacer} />
        <button type="button" className={css.refreshBtn} disabled={loading} onClick={refresh}>刷新</button>
      </div>

      {error !== null && <div className={css.error}>{error}</div>}
      {!connected && <div className={css.hint}>数据库未连接,等待连接后自动采集</div>}

      {tabs.length > 1 && (
        <div className={css.tabs}>
          {tabs.map(t => (
            <button
              key={t}
              type="button"
              className={tab === t ? css.tabActive : css.tab}
              onClick={() =>{  setTab(t) }}
            >
              {t === 'overview' ? '概览' : t === 'performance' ? '性能' : '网络'}
            </button>
          ))}
        </div>
      )}

      {dbType === 'redis' && (
        <>
          <div className={css.grid} style={tab === 'overview' ? undefined : { display: 'none' }}>
            <DashboardCard title="运行时间" icon={<MetricIcon name="clock" />} value={redis.uptimePretty}
              subtitle={`${redis.uptimeSeconds} 秒`} color="cyan" loading={loading}
              chartValue={redis.uptimeSeconds} sampleKey={sampleKey.current}
              description="Redis 服务自启动以来的持续运行时间。" />
            <DashboardCard title="已用内存" icon={<MetricIcon name="memory" />} value={redis.usedMemoryHuman}
              subtitle={redis.maxmemory > 0 ? `上限 ${formatDbBytes(redis.maxmemory)}` : '未设置上限'}
              progress={redis.maxmemory > 0 ? (redis.usedMemory / redis.maxmemory) * 100 : 0}
              color={redis.maxmemory > 0 && redis.usedMemory / redis.maxmemory > 0.8 ? 'red' : 'cyan'}
              loading={loading} chartValue={redis.usedMemory} sampleKey={sampleKey.current}
              description="Redis 当前内存占用;配置 maxmemory 后显示使用比例。" />
            <DashboardCard title="总键数" icon={<MetricIcon name="key" />} value={redis.totalKeys} color="cyan"
              loading={loading} chartValue={redis.totalKeys} sampleKey={sampleKey.current} />
            <DashboardCard title="客户端连接" icon={<MetricIcon name="link" />} value={redis.connectedClients}
              subtitle={`${redis.connectedSlaves} 从节点`} color="purple" loading={loading}
              chartValue={redis.connectedClients} sampleKey={sampleKey.current} />
          </div>
          <div className={css.grid} style={tab === 'performance' ? undefined : { display: 'none' }}>
            <DashboardCard title="命中率" icon={<MetricIcon name="target" />} value={`${redis.hitRate.toFixed(2)}%`}
              subtitle="keyspace_hits/(hits+misses)" progress={redis.hitRate} color="cyan" loading={loading}
              chartValue={redis.hitRate} sampleKey={sampleKey.current} />
            <DashboardCard title="峰值内存" icon={<MetricIcon name="chart" />} value={formatDbBytes(redis.usedMemoryPeak)}
              color="yellow" loading={loading} chartValue={redis.usedMemoryPeak} sampleKey={sampleKey.current} />
            <DashboardCard title="累计命令数" icon={<MetricIcon name="terminal" />}
              value={redis.totalCommandsProcessed.toLocaleString()} color="cyan" loading={loading}
              chartValue={redis.totalCommandsProcessed} sampleKey={sampleKey.current} />
            <DashboardCard title="每秒操作数" icon={<MetricIcon name="bolt" />} value={redis.instantaneousOpsPerSec}
              subtitle="instantaneous_ops_per_sec" color="green" loading={loading}
              chartValue={redis.instantaneousOpsPerSec} sampleKey={sampleKey.current} />
          </div>
        </>
      )}

      {dbType === 'mysql' && (
        <>
          <div className={css.grid} style={tab === 'overview' ? undefined : { display: 'none' }}>
            <DashboardCard title="运行时间" icon={<MetricIcon name="clock" />} value={mysql.uptimePretty}
              subtitle={`${mysql.uptimeSeconds} 秒`} color="cyan" loading={loading}
              chartValue={mysql.uptimeSeconds} sampleKey={sampleKey.current} />
            <DashboardCard title="连接数" icon={<MetricIcon name="link" />} value={mysql.threadsConnected}
              subtitle={`${mysql.threadsRunning} 活跃 / ${mysql.maxConnections} 最大`}
              progress={mysqlConnUsage(mysql)} color="cyan" loading={loading}
              chartValue={mysql.threadsConnected} sampleKey={sampleKey.current}
              detailTable={mysqlConnectionTable}
              description="当前连接占 max_connections 的比例;明细列出客户端 IP、账号、数据库、状态与正在执行的 SQL。" />
            <DashboardCard title="数据大小" icon={<MetricIcon name="database" />} value={formatDbBytes(mysql.dataSize)}
              subtitle={`索引 ${formatDbBytes(mysql.indexSize)}`} progress={mysqlDataRatio(mysql)}
              color="blue" loading={loading} chartValue={mysql.dataSize + mysql.indexSize}
              sampleKey={sampleKey.current} details={[
                { label: '数据文件', value: formatDbBytes(mysql.dataSize) },
                { label: '索引文件', value: formatDbBytes(mysql.indexSize) },
              ]}
              description={database ? `当前数据库 ${database} 的表数据与索引占用。` : '请先选择数据库后查看准确容量。'} />
            <DashboardCard title="表数量" icon={<MetricIcon name="table" />} value={mysql.tableCount} color="cyan"
              loading={loading} chartValue={mysql.tableCount} sampleKey={sampleKey.current}
              description={database ? `当前数据库 ${database} 的基础表与视图数量。` : '请先选择数据库后查看准确表数量。'} />
          </div>
          <div className={css.grid} style={tab === 'performance' ? undefined : { display: 'none' }}>
            <DashboardCard title="累计查询" icon={<MetricIcon name="search" />} value={mysql.queries.toLocaleString()}
              subtitle={`Questions ${mysql.questions.toLocaleString()}`} color="cyan" loading={loading}
              chartValue={mysql.queries} sampleKey={sampleKey.current}
              description="Queries 包含服务端执行的全部语句;Questions 更接近客户端发起的语句数量。" />
            <DashboardCard title="慢查询" icon={<MetricIcon name="turtle" />} value={mysql.slowQueries}
              color={mysql.slowQueries > 100 ? 'red' : mysql.slowQueries > 10 ? 'yellow' : 'green'}
              loading={loading} chartValue={mysql.slowQueries} sampleKey={sampleKey.current}
              detailTable={mysqlSlowQueryTable}
              description="Slow_queries 累计值;下方优先显示 mysql.slow_log 的具体语句、用户/IP、耗时与扫描行。" />
            <DashboardCard title="缓冲池命中率" icon={<MetricIcon name="box" />}
              value={`${mysql.bufferPoolHitRate.toFixed(2)}%`}
              subtitle={`使用 ${formatDbBytes(mysql.innodbBufferPoolUsed)} / ${formatDbBytes(mysql.innodbBufferPoolSize)}`}
              progress={mysql.bufferPoolHitRate} color="cyan" loading={loading}
              chartValue={mysql.bufferPoolHitRate} sampleKey={sampleKey.current}
              description="根据 InnoDB 逻辑读请求与物理读计算,越接近 100% 越好。" />
            <DashboardCard title="活跃线程" icon={<MetricIcon name="gear" />} value={mysql.threadsRunning}
              subtitle={`${mysql.threadsConnected} 已连接`} color="green" loading={loading}
              chartValue={mysql.threadsRunning} sampleKey={sampleKey.current}
              detailTable={mysqlConnectionTable}
              description="Threads_running 当前值;明细展示每个会话的客户端 IP、运行时长、状态及 SQL。" />
          </div>
          <div className={css.grid} style={tab === 'network' ? undefined : { display: 'none' }}>
            <DashboardCard title="网络接收" icon={<MetricIcon name="download" />} value={formatDbBytes(mysql.bytesReceived)}
              color="blue" loading={loading} chartValue={mysql.bytesReceived} sampleKey={sampleKey.current} />
            <DashboardCard title="网络发送" icon={<MetricIcon name="upload" />} value={formatDbBytes(mysql.bytesSent)}
              color="blue" loading={loading} chartValue={mysql.bytesSent} sampleKey={sampleKey.current} />
          </div>
        </>
      )}

      {dbType === 'postgresql' && (
        <>
          <div className={css.grid} style={tab === 'overview' ? undefined : { display: 'none' }}>
            <DashboardCard title="运行时间" icon={<MetricIcon name="clock" />} value={formatDbUptime(postgres.uptimeSeconds)}
              subtitle={`${postgres.uptimeSeconds} 秒`} color="cyan" loading={loading}
              chartValue={postgres.uptimeSeconds} sampleKey={sampleKey.current} />
            <DashboardCard title="连接数" icon={<MetricIcon name="link" />} value={postgres.connections}
              subtitle={`${postgres.activeConnections} 活跃 / ${postgres.maxConnections} 最大`}
              progress={postgresConnUsage(postgres)} color="cyan" loading={loading}
              chartValue={postgres.connections} sampleKey={sampleKey.current}
              detailTable={postgresConnectionTable}
              description="pg_stat_activity 会话明细,展示客户端 IP、账号、应用、等待事件与当前 SQL。" />
            <DashboardCard title="数据库大小" icon={<MetricIcon name="database" />} value={formatDbBytes(postgres.databaseSize)}
              color="blue" loading={loading} chartValue={postgres.databaseSize} sampleKey={sampleKey.current} />
            <DashboardCard title="当前 Schema 表数" icon={<MetricIcon name="table" />} value={postgres.tableCount} color="cyan"
              loading={loading} chartValue={postgres.tableCount} sampleKey={sampleKey.current} />
          </div>
          <div className={css.grid} style={tab === 'performance' ? undefined : { display: 'none' }}>
            <DashboardCard title="活跃会话" icon={<MetricIcon name="gear" />} value={postgres.activeConnections} color="green"
              loading={loading} chartValue={postgres.activeConnections} sampleKey={sampleKey.current}
              detailTable={postgresConnectionTable} />
            <DashboardCard title="慢语句" icon={<MetricIcon name="turtle" />} value={postgresSlowStatements.length}
              color={postgresSlowStatements.length ? 'yellow' : 'green'} loading={loading}
              chartValue={postgresSlowStatements.length} sampleKey={sampleKey.current}
              detailTable={postgresSlowQueryTable}
              description="优先读取 pg_stat_statements 的具体 SQL 和累计耗时;扩展不可用时展示当前运行超过 1 秒的语句。" />
            <DashboardCard title="缓存命中率" icon={<MetricIcon name="box" />} value={`${postgres.cacheHitRate.toFixed(2)}%`}
              progress={postgres.cacheHitRate} color="cyan" loading={loading}
              chartValue={postgres.cacheHitRate} sampleKey={sampleKey.current} />
            <DashboardCard title="累计事务" icon={<MetricIcon name="refresh" />} value={postgres.transactions.toLocaleString()}
              color="purple" loading={loading} chartValue={postgres.transactions} sampleKey={sampleKey.current} />
          </div>
        </>
      )}

      {(dbType !== 'mysql' && dbType !== 'postgresql' && dbType !== 'redis') && (
        <div className={css.unsupported}>仪表盘暂未支持 {dbTypeLabel},请先用 SQL 编辑器查询</div>
      )}
    </div>
  )
}
