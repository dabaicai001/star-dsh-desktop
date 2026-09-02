/**
 * StarHub 原生数据库工作台(需求 5:DB 工作台 React 化,仿 hexhub;批次 1)。
 *
 * 形态:壳内全屏 overlay(经 shell.overlay 槽内的 DbWorkbench 分支渲染),替换
 * 原先 DB 资产「openNewPage 开独立性 Vue embed 窗口」。工作台自带连接生命周期:
 * 打开资产时按 asset.config 建连(db_<type>_connect → connId),左侧连接树列库、
 * 展开库列表,右侧为内容区(本批为连接/库的只读概览,SQL 编辑器与结果网格等
 * 后续批次接入)。
 *
 * 命令面全部复用既有 Tauri command(starhub-commands 已授权,见
 * capabilities/default.json + permissions/commands.toml):db_mysql_connect /
 * db_mysql_list_databases / db_mysql_list_tables 等;PG 复用 db_mysql_* 命令
 * (RPC 按 connId 内嵌类型分派 pgx)。连接按资产只建一次,disconnect 在关闭时
 * 调用。
 *
 * @module StarHub DB workbench (client)
 */

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RustAsset } from './store.ts'
import { tauriInvoke } from './tauri.ts'
import { DbDataGrid, cellText } from './DbDataGrid.tsx'
import { SqlEditor, type SqlCompletionSchema } from './SqlEditor.tsx'
import { ContextMenu, useContextMenu } from './ContextMenu.tsx'
import {
  IconBrowseOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconCloseFill14,
  IconCloseOutline16, IconCodeOutline16, IconDataOutline16, IconInspectOutline12,
  IconPlayOutline16, IconPlusOutline16, IconRefreshOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { NewTableDialog, ColumnListDialog, IndexListDialog } from './DbTableDialogs.tsx'
import { DbDashboard } from './dashboard/DbDashboard.tsx'
import { MetricIcon } from './dashboard/metric-icons.tsx'
import type { CreateTableDbType } from './ddlGenerator.ts'
import { isTauriRuntime } from './settings/services.ts'
import { formatSql, splitStatements } from './sqlFormat.ts'
import { addHistory, clearHistory, loadHistory, type SqlHistoryEntry } from './sqlHistory.ts'
import css from './DbWorkbench.module.css'

/** db_mysql_execute 的返回(与 QueryResult 同构;SQL 执行结果复用)。 */
interface SqlQueryResult { columns?: unknown; rows?: unknown; error?: string }

/** 一个查询标签页:独立 SQL 草稿与最近一次执行结果(仿 HubHex 新建查询)。 */
interface QueryTab {
  /** 稳定 id(递增,不作数组下标)。 */
  id: number
  /** 展示名(查询 N)。 */
  name: string
  /** 编辑器草稿。 */
  sql: string
  /** 该标签最近一次执行的结果(null = 未执行过)。 */
  result: SqlQueryResult | null
  /** 该标签最近一次执行的错误(null = 无错误)。 */
  error: string | null
}

/** 新建一个空白查询标签(名称按全局序号递增)。 */
function makeQueryTab(id: number): QueryTab {
  return { id, name: `查询 ${id}`, sql: '', result: null, error: null }
}

/** 从 db_mysql_list_columns 结果提取列名(返回元素为 {name} 对象行)。 */
function extractColumnNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  return rows
    .map(r => (typeof r === 'object' && r !== null ? (r as Record<string, unknown>).name : undefined))
    .filter((n): n is string => typeof n === 'string')
}

/** 表行动作集(点击选中 / 右键菜单 / 字段树开关)。 */
interface TableRowActions {
  onSelect: () => void
  onToggleColumns: () => void
  onShowDdl: () => void
  onColumns: () => void
  onIndexes: () => void
  onDrop: () => void
  onTruncate: () => void
}

/** 一棵字段树节点(表展开后的列)。 */
interface ColumnNode { name: string; type?: string; key?: string }

/** 单个表行:点击=选中,右键=菜单(查看 DDL / 编辑列 / 索引 / 删表 / 清空)。 */
function TableRow({ table, selected, database, supportsAlter, expanded, columns, loading, actions }: {
  table: string
  selected: boolean
  database?: string
  supportsAlter: boolean
  /** 字段树是否展开。 */
  expanded: boolean
  /** 已加载的列(expanded 时渲染);空 = 尚未加载。 */
  columns: ColumnNode[]
  /** 列是否加载中。 */
  loading: boolean
  actions: TableRowActions
}) {
  const menu = useContextMenu()
  const items: readonly MenuEntry[] = [
    { id: 'ddl', label: '查看 DDL' },
    ...(supportsAlter
      ? [
        { id: 'columns', label: '编辑列' },
        { id: 'indexes', label: '索引' },
      ]
      : []),
    { id: 'truncate', label: '清空表' },
    { id: 'drop', label: '删除表', danger: true },
  ]
  return (
    <li key={table}>
      <div className={css.tableRowWrap}>
        <div
          className={`${css.treeRow} ${css.tableRow} ${selected ? css.selected : ''}`}
          title={database !== undefined ? `${database}.${table}` : table}
          onClick={actions.onSelect}
          onContextMenu={menu.onContextMenu}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>{  if (e.key === 'Enter') actions.onSelect() }}
        >
          <button
            type="button"
            className={css.treeChevron}
            onClick={(e) =>{  e.stopPropagation(); actions.onToggleColumns() }}
            title={expanded ? '收起字段' : '展开字段'}
            aria-label={expanded ? `收起 ${table} 字段` : `展开 ${table} 字段`}
            aria-expanded={expanded}
          >
            {expanded ? <IconChevronDownOutline14 size={11} /> : <IconChevronRightOutline14 size={11} />}
          </button>
          <span className={css.nodeIcon} aria-hidden="true"><IconBrowseOutline16 size={13} /></span>
          <span>{table}</span>
          {loading && <span className={css.hint}>…</span>}
        </div>
        <ContextMenu
          menu={menu}
          items={items}
          onSelect={(id) => {
            if (id === 'ddl') actions.onShowDdl()
            else if (id === 'columns') actions.onColumns()
            else if (id === 'indexes') actions.onIndexes()
            else if (id === 'truncate') actions.onTruncate()
            else if (id === 'drop') actions.onDrop()
          }}
          className={css.menuRoot}
        />
      </div>
      {expanded && (
        <ul className={css.treeList}>
          {loading ? (
            <li className={`${css.columnRow} ${css.hint}`}>加载列…</li>
          ) : (
            columns.map(col => (
              <li key={col.name} className={css.columnRow}>
                <span className={css.columnType} title={col.type ?? ''}>{col.type ?? '?'}</span>
                <span className={css.columnName}>{col.name}{col.key === 'PRI' ? <span className={css.columnPk}>·PK</span> : ''}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  )
}

/** 库行的右键动作集合(批次 4b:新建表 / 刷新表列表)。 */
interface DbRowActions {
  onToggle: () => void
  onNewTable: () => void
  onRefresh: () => void
}

/** 单个库行:点击=展开/收起,右键=菜单(新建表 / 刷新表列表)。 */
function DatabaseRow({ node, children, actions }: {
  node: Extract<TreeNode, { kind: 'database' }>
  /** 展开时渲染的已有表列表(由父组件注入,避免在模块级闭包引用组件状态)。 */
  children?: ReactNode
  actions: DbRowActions
}) {
  const menu = useContextMenu()
  const items: readonly MenuEntry[] = [
    { id: 'new-table', label: '新建表' },
    { id: 'refresh', label: '刷新表列表' },
  ]
  return (
    <div className={css.treeNode}>
      <button
        type="button"
        className={css.treeRow}
        onClick={actions.onToggle}
        onContextMenu={menu.onContextMenu}
        title={node.name}
      >
        <span className={css.chevron} aria-hidden="true">
          {node.expanded ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
        </span>
        <span className={css.nodeIcon} aria-hidden="true"><IconDataOutline16 size={14} /></span>
        <span>{node.name}</span>
        {node.loading && <span className={css.hint}>…</span>}
      </button>
      <ContextMenu
        menu={menu}
        items={items}
        onSelect={(id) => {
          if (id === 'new-table') actions.onNewTable()
          else if (id === 'refresh') actions.onRefresh()
        }}
        className={css.menuRoot}
      />
      {node.expanded && children}
    </div>
  )
}

/** db 资产可复用的 connect 参数(与 Vue src/types/asset.ts + services/db.ts 同构)。 */
interface DbConnectParams {
  host: string
  port: number
  username: string
  password: string
  database?: string
  ssl?: boolean
}

/** 连接结果(与 Vue DbConnectionInfo 同构)。 */
interface DbConnectionInfo {
  connId: string
  host: string
  port: number
  database?: string
  db?: number
}

/** 一个库或表条目(list_databases / list_tables 返回元素的最小形态)。 */
interface DbObjectRow {
  name: string
}

/** 树节点:库或表。 */
type TreeNode =
  | { kind: 'database'; name: string; expanded: boolean; tables: string[]; loading: boolean }
  | { kind: 'table'; name: string }

/** 当前选中的表(带其父库,给 get_table_data 的 database 参数)。 */
interface SelectedTable { table: string; database?: string }

/** 左侧树记忆持久化形态(localStorage JSON)。 */
interface TreeMemory { expanded?: string[]; selected?: SelectedTable | null; currentDb?: string; monitor?: boolean }

/** 监控右栏可拖拽宽度边界(px)。 */
const MONITOR_MIN_WIDTH = 280
const MONITOR_MAX_WIDTH = 420

/** DB 类型 → connect 命令名(与 Vue services/db.ts 对齐;各型有独立 connect)。 */
function connectCommand(dbType: string): string {
  switch (dbType) {
    case 'postgresql': return 'db_postgres_connect'
    case 'clickhouse': return 'db_clickhouse_connect'
    case 'redis': return 'db_redis_connect'
    case 'elasticsearch': return 'db_es_connect'
    default: return 'db_mysql_connect'
  }
}

/** 把资产 config 组装成 connect 参数(config 由 get_assets 经 keyring hydrate 含密码)。 */
export function defaultDbPort(dbType: string): number {
  switch (dbType) {
    case 'postgresql': return 5432
    case 'clickhouse': return 9000
    case 'redis': return 6379
    case 'elasticsearch': return 9200
    default: return 3306
  }
}

function toConnectParams(config: Record<string, unknown>, dbType: string): DbConnectParams {
  return {
    host: typeof config.host === 'string' ? config.host : '',
    port: typeof config.port === 'number' ? config.port : defaultDbPort(dbType),
    username: typeof config.username === 'string' ? config.username : '',
    password: typeof config.password === 'string' ? config.password : '',
    ...(typeof config.database === 'string' && config.database !== ''
      ? { database: config.database }
      : {}),
    ...(typeof config.ssl === 'boolean' ? { ssl: config.ssl } : {}),
  }
}

/** DB 类型 → disconnect 命令名(各型独立)。 */
function disconnectCommand(dbType: string): string {
  switch (dbType) {
    case 'postgresql': return 'db_postgres_disconnect'
    case 'clickhouse': return 'db_clickhouse_disconnect'
    case 'redis': return 'db_redis_disconnect'
    case 'elasticsearch': return 'db_es_disconnect'
    default: return 'db_mysql_disconnect'
  }
}

/**
 * Render the native database workbench: full-screen overlay with a connection
 * tree (databases → tables) on the left and an empty content area on the right.
 * @param props - the target asset and a close callback.
 * @returns the workbench overlay.
 */
export function DbWorkbench({ asset, onClose }: { asset: RustAsset; onClose: () => void }) {
  const [connectError, setConnectError] = useState<string | null>(null)
  const [dbs, setDbs] = useState<TreeNode[]>([])
  const [dbsLoading, setDbsLoading] = useState(false)
  const [treeSearch, setTreeSearch] = useState('')
  const [selected, setSelected] = useState<SelectedTable | null>(null)
  // SQL 查询区状态:多查询标签(新建查询按钮追加),每个标签独立草稿与结果。
  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(() => [makeQueryTab(1)])
  const [activeQueryId, setActiveQueryId] = useState(1)
  const nextQueryIdRef = useRef(2)
  const [sqlLoading, setSqlLoading] = useState(false)
  // 内容区模式:「SQL 查询」编辑器模式(SQL 编辑区 + 可拖拽结果区)或
  // 「表数据」浏览模式(DbDataGrid 拿满全高)。点表自动切表数据,新建/执行/
  // 切查询标签自动切回 SQL 查询,也可用头部按钮手动切换。
  const [mode, setMode] = useState<'sql' | 'table'>('sql')
  // SQL 编辑区高度(px):SQL 模式内可拖拽分隔条调整,夹在 min/max 间,内存态。
  const [sqlPaneHeight, setSqlPaneHeight] = useState(300)
  const sqlResizeRef = useRef(false)
  const onSqlResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sqlResizeRef.current) return
    // 拖动下边框:向容器上缘反推高度(分隔条在编辑区下方)。
    const container = event.currentTarget.parentElement
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const next = Math.round(event.clientY - rect.top)
    setSqlPaneHeight(Math.max(160, Math.min(560, next)))
  }, [])
  const onSqlResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    sqlResizeRef.current = true
    if (typeof (event.currentTarget as HTMLDivElement).setPointerCapture === 'function') {
      ;(event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId)
    }
  }, [])
  const onSqlResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sqlResizeRef.current) return
    sqlResizeRef.current = false
    if (typeof (event.currentTarget as HTMLDivElement).releasePointerCapture === 'function') {
      ;(event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId)
    }
  }, [])
  // 查询历史(批次 5):弹层开关 + 当前加载的条目。
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState<SqlHistoryEntry[]>([])
  // 表操作弹层(批次 4a):查看 DDL / 确认删除 / 清空。
  const [ddl, setDdl] = useState<{ table: string; content: string; loading?: boolean } | null>(null)
  // 批次 4b 对话框:新建表(按库) / 编辑列 / 索引(按表)。
  const [dialog, setDialog] = useState<
    | { kind: 'new-table'; database: string }
    | { kind: 'columns'; database: string; table: string }
    | { kind: 'indexes'; database: string; table: string }
    | null
  >(null)
  // Excel 全量导出(后端执行)的进行态。
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  // 最新 connId(供 list_tables 与卸载 cleanup 断连;效应闭包拿不到最新异步态)。
  const connRef = useRef<string | null>(null)
  const [connected, setConnected] = useState(false)
  // 渲染态 connId(connRef 变更不触发重渲染,监控面板/数据网格需要 props 随连接更新)。
  const [connId, setConnId] = useState('')
  const setConn = useCallback((id: string) => { connRef.current = id; setConnId(id); setConnected(true) }, [])
  // 监控右栏开关(MySQL / PG / Redis 有 Dashboard;默认关闭,选择持久化进树记忆)。
  const monitorSupported = ['mysql', 'postgresql', 'redis'].includes(typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql')
  const [showMonitor, setShowMonitor] = useState(false)
  // 监控右栏宽度(px):拖拽左边框调整,夹在 min 与 max 之间;内存态即可。
  const [monitorWidth, setMonitorWidth] = useState(340)
  const monitorResizeRef = useRef(false)
  const onMonitorResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    monitorResizeRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])
  const onMonitorResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!monitorResizeRef.current) return
    // 拖动左边框:向左收窄、向右加宽。以容器右缘为基准反推宽度。
    const container = event.currentTarget.parentElement
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const next = Math.round(rect.right - event.clientX)
    setMonitorWidth(Math.max(MONITOR_MIN_WIDTH, Math.min(MONITOR_MAX_WIDTH, next)))
  }, [])
  const onMonitorResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!monitorResizeRef.current) return
    monitorResizeRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])
  // 执行 SQL 的当前库:默认取资产配置的 database,点表/手选后跟随;参与持久化记忆。
  const [currentDb, setCurrentDb] = useState<string>(() =>
    typeof asset.config.database === 'string' ? asset.config.database : '')
  // 惰性列缓存:表名 → 列名[](state 驱动补全 schema 重算——列在树展开后异步到达,
  // 若放模块级 Map 则 set 不触发重渲染,sqlSchema memo 永远读不到新列)。
  const [columnsByTable, setColumnsByTable] = useState<Record<string, string[]>>({})
  // 字段树:已展开的表名集合(点表行 chevron 切换)与列详情(name/type/key)缓存。
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const [tableColumns, setTableColumns] = useState<Record<string, ColumnNode[]>>({})
  const [tableColumnsLoading, setTableColumnsLoading] = useState<Record<string, boolean>>({})

  // DB 实体类型来自资产 config.dbType(sections.ts 同样判定);决定方言与表操作可用性。
  const dbType = typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql'
  // 命令前缀:MySQL / PG / SQLite / MSSQL 共用 db_mysql_*(sidecar 按 connId 内嵌类型
  // 分派 pgx/sqlite 等);ClickHouse 走独立 db_clickhouse_* 命令面(否则报
  // "is not relational SQL")。
  const cmdPrefix = dbType === 'clickhouse' ? 'db_clickhouse' : 'db_mysql'
  const dialect: CreateTableDbType = dbType === 'postgresql' ? 'postgresql' : dbType === 'clickhouse' ? 'clickhouse' : 'mysql'
  // 改列/索引为 MySQL 方言语法(与 Vue 端一致),仅 MySQL 显示这两项。
  const supportsAlter = dbType === 'mysql'

  const dbTypeLabel = dbType === 'postgresql' ? 'PostgreSQL' : dbType.toUpperCase()

  const loadDatabases = useCallback(async (id: string) => {
    setDbsLoading(true)
    setConnectError(null)
    try {
      // list_databases 直接返回库名字符串数组(非 [{name}] 对象行)。
      const names = await tauriInvoke<string[]>(`${cmdPrefix}_list_databases`, { connId: id })
      setDbs(names.map(name => ({ kind: 'database', name, expanded: false, tables: [], loading: false })))
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e))
    } finally {
      setDbsLoading(false)
    }
  }, [])

  // 挂载时建连一次,卸载时断连(连接按资产只建一次)。
  useEffect(() => {
    const params = toConnectParams(asset.config, dbType)
    if (params.host === '' || params.username === '') {
      setConnectError('数据库资产配置不完整(缺 host/username)')
      return
    }
    let cancelled = false
    const disconnect = (id: string): void => {
      void tauriInvoke(disconnectCommand(dbType), { connId: id }).catch(() => {})
    }
    tauriInvoke<DbConnectionInfo>(connectCommand(dbType), { params })
      .then((info) => {
        if (cancelled) {
          if (info.connId) disconnect(info.connId)
          return
        }
        if (!info.connId) throw new Error('连接未返回 connId')
        setConn(info.connId)
        void loadDatabases(info.connId)
      })
      .catch((e: unknown) => {
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      if (connRef.current !== null) disconnect(connRef.current)
    }
    // 只随资产 id 变化;connectCommand 对同类型恒定,不列入依赖避免重连。
  }, [asset.id])

  const refreshDatabases = useCallback(() => {
    const id = connRef.current
    if (id === null) return
    setSelected(null)
    setColumnsByTable({})
    void loadDatabases(id)
  }, [loadDatabases])

  const normalizedTreeSearch = treeSearch.trim().toLocaleLowerCase()
  const visibleDbs = normalizedTreeSearch === ''
    ? dbs
    : dbs.filter(node => node.kind === 'database' && (
      node.name.toLocaleLowerCase().includes(normalizedTreeSearch)
      || node.tables.some(table => table.toLocaleLowerCase().includes(normalizedTreeSearch))
    ))

  /** 展开库并懒加载表列表(expanded 立即置位,供树记忆持久化即时可见)。 */
  const expandDb = useCallback(async (name: string) => {
    const id = connRef.current
    setDbs(prev => prev.map(d => (d.kind === 'database' && d.name === name ? { ...d, expanded: true, loading: true } : d)))
    if (id === null) return
    try {
      const rows = await tauriInvoke<DbObjectRow[]>(`${cmdPrefix}_list_tables`, { connId: id, database: name })
      setDbs(prev => prev.map(d => (
        d.kind === 'database' && d.name === name
          ? { ...d, loading: false, tables: rows.map(r => r.name) }
          : d
      )))
    } catch (e) {
      setDbs(prev => prev.map(d => (d.kind === 'database' && d.name === name ? { ...d, loading: false } : d)))
      setConnectError(e instanceof Error ? e.message : String(e))
    }
  }, [cmdPrefix])

  const toggleDb = useCallback(async (node: TreeNode) => {
    if (node.kind !== 'database') return
    if (node.expanded) {
      setDbs(prev => prev.map(d => (d.kind === 'database' && d.name === node.name ? { ...d, expanded: false } : d)))
      return
    }
    if (node.tables.length === 0 && !node.loading) {
      await expandDb(node.name)
      return
    }
    setDbs(prev => prev.map(d => (d.kind === 'database' && d.name === node.name ? { ...d, expanded: true } : d)))
  }, [expandDb])

  // ---- 左侧树记忆(localStorage,按资产隔离):展开库 / 选中表 / 当前库 ----
  const treeStoreKey = `starhub.db.workbench.${asset.id}`
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || dbs.length === 0) return
    restoredRef.current = true
    let saved: TreeMemory | null = null
    try {
      const raw = localStorage.getItem(treeStoreKey)
      saved = raw === null ? null : JSON.parse(raw) as TreeMemory
    } catch { saved = null }
    if (saved === null) return
    if (typeof saved.currentDb === 'string' && saved.currentDb !== '') setCurrentDb(saved.currentDb)
    if (typeof saved.monitor === 'boolean') setShowMonitor(saved.monitor)
    if (saved.selected !== null && saved.selected !== undefined && typeof saved.selected.table === 'string') {
      setSelected(saved.selected)
      setMode('table')
    }
    // 默认展开上次展开的库;选中表所在库即使不在 expanded 里也一并展开。
    const selectedDb = typeof saved.selected?.database === 'string' && saved.selected.database !== '' ? [saved.selected.database] : []
    for (const name of new Set([...(saved.expanded ?? []), ...selectedDb])) void expandDb(name)
  }, [dbs, treeStoreKey, expandDb])

  useEffect(() => {
    if (!restoredRef.current) return
    const expanded = dbs.filter(d => d.kind === 'database' && d.expanded).map(d => d.name)
    try {
      localStorage.setItem(treeStoreKey, JSON.stringify({ expanded, selected, currentDb, monitor: showMonitor }))
    } catch { /* 存储不可用(隐私模式等)时静默降级 */ }
  }, [dbs, selected, currentDb, showMonitor, treeStoreKey])

  // ─── 查询标签页操作(新建 / 关闭 / 修改) ───
  // 不变式:queryTabs 恒非空(单标签时关闭钮隐藏),activeTab 恒存在(兜底空标签)。
  const activeTab = queryTabs.find(t => t.id === activeQueryId) ?? queryTabs[0] ?? makeQueryTab(0)

  /** 就地修改某个查询标签(state 驱动重渲染)。 */
  const patchTab = useCallback((id: number, patch: Partial<QueryTab>) => {
    setQueryTabs(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  /** 新建查询:追加空白标签并激活(编辑器聚焦交给 autofocus 的 SqlEditor)。 */
  const newQuery = useCallback(() => {
    const id = nextQueryIdRef.current
    nextQueryIdRef.current += 1
    setQueryTabs(prev => [...prev, makeQueryTab(id)])
    setActiveQueryId(id)
    setMode('sql')
  }, [])

  /** 展开表字段树;首次展开时懒加载列详情(name/type/key)。 */
  const toggleTableColumns = useCallback(async (table: string, database?: string) => {
    const id = connRef.current
    if (id === null) return
    const expanded = expandedTables.has(table)
    // 展开:加载列(若未缓存)+ 计数;收起:仅移除展开态。
    if (!expanded && tableColumns[table] === undefined && !tableColumnsLoading[table]) {
      setTableColumnsLoading(prev => ({ ...prev, [table]: true }))
      try {
        const rows = await tauriInvoke<Array<Record<string, unknown>>>(`${cmdPrefix}_list_columns`, {
          connId: id, table, ...(database !== undefined && database !== '' ? { database } : {}),
        })
        const cols: ColumnNode[] = (Array.isArray(rows) ? rows : [])
          .map(r => ({
            name: String(r.name ?? ''),
            ...(typeof r.type === 'string' && r.type !== '' ? { type: r.type } : {}),
            ...(typeof r.key === 'string' && r.key !== '' ? { key: r.key } : {}),
          }))
          .filter(c => c.name !== '')
        setTableColumns(prev => ({ ...prev, [table]: cols }))
        setColumnsByTable(prev => ({ ...prev, [table]: cols.map(c => c.name) }))
      } catch { /* 列加载失败:保留展开态但不显示列 */ }
      finally { setTableColumnsLoading(prev => ({ ...prev, [table]: false })) }
    }
    setExpandedTables(prev => {
      const next = new Set(prev)
      if (next.has(table)) { next.delete(table) } else { next.add(table) }
      return next
    })
  }, [expandedTables, tableColumns, tableColumnsLoading, cmdPrefix])

  /** 关闭查询标签:至少保留一个;关闭当前标签时激活相邻标签。 */
  const closeQuery = useCallback((id: number) => {
    setQueryTabs(prev => {
      if (prev.length <= 1) return prev
      return prev.filter(t => t.id !== id)
    })
    if (id === activeQueryId) {
      const idx = queryTabs.findIndex(t => t.id === id)
      const remaining = queryTabs.filter(t => t.id !== id)
      const neighbor = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]
      if (neighbor !== undefined) setActiveQueryId(neighbor.id)
    }
  }, [activeQueryId, queryTabs])

  // SQL 执行(Mod-Enter 执行 / Shift-Mod-e EXPLAIN):调 db_mysql_execute / explain。
  // 多语句拆分——非 EXPLAIN 时按分号拆多条逐条执行,记录查询历史;结果/错误写回
  // 执行发起时的活动标签。
  const executeSql = useCallback(async (statement: string, explain: boolean) => {
    const tabId = activeQueryId
    const id = connRef.current
    if (id === null) {
      patchTab(tabId, { error: '未连接数据库' })
      return
    }
    if (statement.trim() === '') return
    setSqlLoading(true)
    patchTab(tabId, { error: null })
    try {
      const cmd = explain ? `${cmdPrefix}_explain` : `${cmdPrefix}_execute`
      const statements = explain ? [statement] : splitStatements(statement)
      // 带上当前库:未选库时靠连接默认库;选择器/点表会更新 currentDb。
      const dbArg = currentDb !== '' ? { database: currentDb } : {}
      let last: SqlQueryResult | null = null
      for (const stmt of statements) {
        const res = await tauriInvoke<SqlQueryResult>(cmd, { connId: id, sql: stmt, ...dbArg })
        last = res
        if (res.error !== undefined && res.error !== '') {
          patchTab(tabId, { error: res.error })
          break
        }
      }
      if (last !== null) patchTab(tabId, { result: last })
      // 执行过的原文记入历史(与 Vue 一致:即使出错也记录尝试)。
      addHistory(statement, currentDb)
    } catch (e) {
      patchTab(tabId, { error: e instanceof Error ? e.message : String(e) })
    } finally {
      setSqlLoading(false)
    }
  }, [activeQueryId, currentDb, cmdPrefix, patchTab])

  /** 查询历史弹层:打开时刷新条目;再次点击关闭。 */
  const toggleHistory = (): void => {
    if (!historyOpen) setHistoryEntries(loadHistory())
    setHistoryOpen(open => !open)
  }

  /** 点历史条目 → 回填到当前活动查询标签并收起弹层。 */
  const useHistoryEntry = (entry: SqlHistoryEntry): void => {
    patchTab(activeQueryId, { sql: entry.sql })
    setHistoryOpen(false)
  }

  /** 清空查询历史。 */
  const clearSqlHistory = (): void => {
    clearHistory()
    setHistoryEntries([])
  }

  /** 格式化当前活动标签的 SQL(纯函数;按钮触发)。 */
  const formatCurrentSql = (): void => {
    patchTab(activeQueryId, { sql: formatSql(activeTab.sql) })
  }

  /** 查看表 DDL(get_table_ddl → 弹层)。 */
  const showTableDdl = useCallback(async (table: string, database?: string) => {
    const id = connRef.current
    if (id === null) return
    setDdl({ table, content: '', loading: true })
    try {
      const res = await tauriInvoke<{ ddl?: string }>(`${cmdPrefix}_get_table_ddl`, {
        connId: id, table, ...(database !== undefined ? { database } : {}),
      })
      setDdl({ table, content: res.ddl ?? '(无 DDL)' })
    } catch (e) {
      setDdl({ table, content: `获取 DDL 失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  }, [cmdPrefix])

  /** 删除表(危险,需二次确认;成功从树里移除,若正选中则清选中)。 */
  const dropTable = useCallback(async (table: string, database?: string) => {
    if (!window.confirm(`确定删除表「${table}」?此操作不可恢复。`)) return
    const id = connRef.current
    if (id === null) return
    try {
      await tauriInvoke(`${cmdPrefix}_drop_table`, { connId: id, table, ...(database !== undefined ? { database } : {}) })
      setDbs(prev => prev.map((d) => {
        if (d.kind !== 'database' || !d.tables.includes(table)) return d
        return { ...d, tables: d.tables.filter(t => t !== table) }
      }))
      if (selected !== null && selected.table === table) setSelected(null)
    } catch (e) {
      setConnectError(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [selected, cmdPrefix])

  /** 清空表(危险,需二次确认;成功后提示,不清选中)。 */
  const truncateTable = useCallback(async (table: string, database?: string) => {
    if (!window.confirm(`确定清空表「${table}」所有数据?此操作不可恢复。`)) return
    const id = connRef.current
    if (id === null) return
    try {
      await tauriInvoke(`${cmdPrefix}_truncate_table`, { connId: id, table, ...(database !== undefined ? { database } : {}) })
    } catch (e) {
      setConnectError(`清空失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [cmdPrefix])

  /** 刷新某个库的表列表(库右键 → 刷新表列表)。 */
  const refreshDbTables = useCallback(async (database: string) => {
    const id = connRef.current
    if (id === null) return
    setDbs(prev => prev.map(d => (d.kind === 'database' && d.name === database ? { ...d, loading: true, expanded: true } : d)))
    try {
      const rows = await tauriInvoke<DbObjectRow[]>(`${cmdPrefix}_list_tables`, { connId: id, database })
      setDbs(prev => prev.map(d => (
        d.kind === 'database' && d.name === database
          ? { ...d, loading: false, tables: rows.map(r => r.name) }
          : d
      )))
    } catch (e) {
      setDbs(prev => prev.map(d => (d.kind === 'database' && d.name === database ? { ...d, loading: false } : d)))
      setConnectError(e instanceof Error ? e.message : String(e))
    }
  }, [cmdPrefix])

  /** 建表成功:把新表并入该库节点(若已展开)并清掉列缓存。 */
  const onTableCreated = useCallback((database: string, tableName: string) => {
    setColumnsByTable(prev => {
      const next = { ...prev }
      delete next[tableName]
      return next
    })
    setDbs(prev => prev.map(d => (
      d.kind === 'database' && d.name === database && !d.tables.includes(tableName)
        ? { ...d, expanded: true, tables: [...d.tables, tableName] }
        : d
    )))
  }, [])

  /** 全量导出当前表到 Excel(后端执行,服务端直写 xlsx;whereFilter 透传 raw WHERE)。 */
  const exportTableExcel = useCallback(async (table: string, database: string | undefined, orderBy: string | null, orderDir: 'asc' | 'desc', whereFilter: string | null) => {
    const id = connRef.current
    if (id === null) return
    if (!isTauriRuntime()) {
      setConnectError('浏览器预览环境不支持导出 Excel')
      return
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const safe = `${database ?? ''}_${table}`.replace(/[^\w.]/g, '_').slice(0, 40) || 'export'
    const filePath = await tauriInvoke<string | null>('plugin:dialog|save', {
      options: {
        defaultPath: `export_${safe}_${stamp}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      },
    })
    if (filePath === null) return
    setExportError(null)
    setExporting(true)
    try {
      const cmd = dialect === 'clickhouse' ? 'db_clickhouse_export_excel' : 'db_mysql_export_excel'
      const args: Record<string, unknown> = { connId: id, table, filePath }
      if (database !== undefined) args.database = database
      if (orderBy !== null) {
        args.orderBy = orderBy
        args.orderDir = orderDir
      }
      if (whereFilter !== null && whereFilter !== '') args.filter = whereFilter
      const res = await tauriInvoke<{ filePath: string; totalRows?: number; durationMs?: number }>(cmd, args)
      const rows = res.totalRows ?? 0
      setConnectError(null)
      window.alert(`导出完成:${rows.toLocaleString()} 行 → ${res.filePath}`)
    } catch (e) {
      setConnectError(`导出失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }, [dialect])

  // 把已展开库的表拼成补全 schema(表名 → 列名;列名在展开时惰性拉取,
  // 经 columnsByTable state 驱动 memo 重算,列到达后立即参与补全)。
  const sqlSchema: SqlCompletionSchema = useMemo(() => {
    const out: SqlCompletionSchema = {}
    for (const db of dbs) {
      if (db.kind !== 'database') continue
      for (const table of db.tables) out[table] = columnsByTable[table] ?? []
    }
    return out
  }, [dbs, columnsByTable])
  // 展开库时懒加载列到 state(供 SQL 补全)。
  useEffect(() => {
    const id = connRef.current
    if (id === null) return
    for (const db of dbs) {
      if (db.kind !== 'database') continue
      for (const table of db.tables) {
        if (columnsByTable[table] !== undefined) continue
        void tauriInvoke<unknown>(`${cmdPrefix}_list_columns`, {
          connId: id, table, database: db.name,
        })
          .then((cols) => {
            setColumnsByTable(prev => ({ ...prev, [table]: extractColumnNames(cols) }))
          })
          .catch(() => { /* 补全失败静默 */ })
      }
    }
    // 仅随 dbs 变化重跑;列 state 更新不重跑(避免重复请求)。
  }, [dbs, cmdPrefix])

  return (
    <div className={css.backdrop}>
      <div className={css.panel}>
        <header className={css.header}>
          <span className={connected ? css.statusOnline : css.statusPending} aria-label={connected ? '数据库已连接' : '数据库连接中'} />
          <div className={css.identity}>
            <span className={css.title}>{asset.name}</span>
            <span className={css.sub}>{dbTypeLabel} · {typeof asset.config.host === 'string' ? asset.config.host : '未配置主机'}</span>
          </div>
          <span className={css.spacer} />
          <button type="button" className={css.iconButton} onClick={() => { const id = connRef.current; if (id !== null) void loadDatabases(id) }} title="刷新数据库" aria-label="刷新数据库"><IconRefreshOutline14 size={15} /></button>
          <button type="button" className={css.iconButton} onClick={onClose} title="关闭工作区" aria-label="关闭工作区"><IconCloseOutline16 size={15} /></button>
        </header>
        <div className={css.body}>
          <aside className={css.tree}>
            <div className={css.treeToolbar}>
              <span className={css.treeTitle}>数据库对象</span>
              <button type="button" className={css.treeRefresh} onClick={refreshDatabases} title="刷新数据库列表" aria-label="刷新数据库列表"><IconRefreshOutline14 size={14} /></button>
            </div>
            <input
              type="search"
              className={css.treeSearch}
              value={treeSearch}
              onChange={(event) =>{  setTreeSearch(event.target.value) }}
              placeholder="搜索数据库或表"
              aria-label="搜索数据库或表"
            />
            {connectError !== null && <div className={css.error}>{connectError}</div>}
            {dbsLoading && <div className={css.hint}>加载数据库…</div>}
            {!dbsLoading && dbs.length === 0 && !connectError && <div className={css.hint}>无数据库</div>}
            {normalizedTreeSearch !== '' && visibleDbs.length === 0 && !dbsLoading && (
              <div className={css.hint}>没有匹配的已加载表</div>
            )}
            <ul className={css.treeList}>
              {visibleDbs.map((node) => {
                if (node.kind !== 'database') return null
                const databaseMatches = node.name.toLocaleLowerCase().includes(normalizedTreeSearch)
                const visibleTables = normalizedTreeSearch === '' || databaseMatches
                  ? node.tables
                  : node.tables.filter(table => table.toLocaleLowerCase().includes(normalizedTreeSearch))
                return (
                  <li key={node.name}>
                    <DatabaseRow
                      node={{ ...node, expanded: normalizedTreeSearch !== '' || node.expanded }}
                      actions={{
                        onToggle: () => void toggleDb(node),
                        onNewTable: () =>{  setDialog({ kind: 'new-table', database: node.name }) },
                        onRefresh: () => void refreshDbTables(node.name),
                      }}
                    >
                      <ul className={css.treeList}>
                        {visibleTables.map(t => (
                          <TableRow
                            key={t}
                            table={t}
                            database={node.name}
                            supportsAlter={supportsAlter}
                            selected={selected !== null && selected.table === t}
                            expanded={expandedTables.has(t)}
                            columns={tableColumns[t] ?? []}
                            loading={tableColumnsLoading[t] === true}
                            actions={{
                              onSelect: () => { setSelected({ table: t, database: node.name }); setCurrentDb(node.name); setMode('table') },
                              onToggleColumns: () => void toggleTableColumns(t, node.name),
                              onShowDdl: () => void showTableDdl(t, node.name),
                              onColumns: () =>{  setDialog({ kind: 'columns', database: node.name, table: t }) },
                              onIndexes: () =>{  setDialog({ kind: 'indexes', database: node.name, table: t }) },
                              onDrop: () => void dropTable(t, node.name),
                              onTruncate: () => void truncateTable(t, node.name),
                            }}
                          />
                        ))}
                      </ul>
                    </DatabaseRow>
                  </li>
                )
              })}
            </ul>
          </aside>
          <section className={css.contentGrid}>
            <div className={css.contentHeader}>
              <button
                type="button"
                className={`${css.contentTab} ${mode === 'sql' ? css.contentTabActive : ''}`}
                onClick={() =>{  setMode('sql') }}
                aria-pressed={mode === 'sql'}
              >SQL 查询</button>
              <button
                type="button"
                className={`${css.contentTab} ${mode === 'table' ? css.contentTabActive : ''}`}
                onClick={() =>{  setMode('table') }}
                aria-pressed={mode === 'table'}
              >表数据</button>
              <span className={css.contentDetail}>{mode === 'sql' ? '执行查询、浏览数据和导出结果' : '浏览表数据(排序 / 分页 / WHERE 筛选 / 编辑 / 导出)'}</span>
              <span className={css.spacer} />
              {monitorSupported && (
                <button
                  type="button"
                  className={`${css.iconButton} ${showMonitor ? css.monitorActive : ''}`}
                  onClick={() =>{  setShowMonitor(v => !v) }}
                  title={showMonitor ? '收起监控面板' : '展开监控面板'}
                  aria-label="监控面板"
                  aria-pressed={showMonitor}
                ><IconDataOutline16 size={15} /></button>
              )}
            </div>
            {connected ? (
              mode === 'sql' ? (
                <div className={css.sqlMode}>
                  <div className={css.sqlPane} style={{ height: sqlPaneHeight }}>
                    <div className={css.sqlBar}>
                      <span className={css.sqlLabel}>SQL</span>
                      <select
                        className={css.dbSelect}
                        value={currentDb}
                        onChange={(event) =>{  setCurrentDb(event.target.value) }}
                        title="执行 SQL 的当前数据库"
                        aria-label="当前数据库"
                      >
                        <option value="">(未选库)</option>
                        {dbs.map(d => d.kind === 'database' && (
                          <option key={d.name} value={d.name}>{d.name}</option>
                        ))}
                      </select>
                      <span className={css.hint}>Mod-Enter 执行 · Shift-Mod-e EXPLAIN · Tab 缩进</span>
                      {sqlLoading && <span className={css.hint}>执行中…</span>}
                      <span className={css.spacer} />
                      <button type="button" className={css.sqlRunBtn} onClick={() => void executeSql(activeTab.sql, false)} disabled={sqlLoading || activeTab.sql.trim() === ''} title={activeTab.sql.trim() === '' ? '输入 SQL 后可执行' : '执行 SQL (Mod-Enter)'} aria-label="执行 SQL"><IconPlayOutline16 size={13} /></button>
                      <button type="button" className={css.sqlBarBtn} onClick={() => void executeSql(activeTab.sql, true)} disabled={sqlLoading || activeTab.sql.trim() === ''} title={activeTab.sql.trim() === '' ? '输入 SQL 后可执行 EXPLAIN' : '执行 EXPLAIN (Shift-Mod-e)'} aria-label="执行 EXPLAIN"><IconInspectOutline12 size={13} /></button>
                      <button type="button" className={css.sqlBarBtn} onClick={formatCurrentSql} title="格式化 SQL" aria-label="格式化 SQL"><IconCodeOutline16 size={13} /></button>
                      <button type="button" className={`${css.sqlBarBtn} ${historyOpen ? css.sqlBarBtnActive : ''}`} onClick={toggleHistory} title="查询历史" aria-label="查询历史"><MetricIcon name="clock" size={13} /></button>
                    </div>
                    {/* 查询标签条:仿 HubHex 多查询标签,「新建查询」追加空白标签。 */}
                    <div className={css.queryTabsRow} role="tablist" aria-label="查询标签">
                      {queryTabs.map(tab => (
                        <div key={tab.id} className={`${css.queryTab} ${tab.id === activeQueryId ? css.queryTabActive : ''}`}>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={tab.id === activeQueryId}
                            className={css.queryTabName}
                            onClick={() =>{  setActiveQueryId(tab.id); setMode('sql') }}
                            title={tab.sql !== '' ? tab.sql : tab.name}
                          >
                            {tab.name}{tab.result !== null ? ' ●' : ''}
                          </button>
                          {queryTabs.length > 1 && (
                            <button
                              type="button"
                              className={css.queryTabClose}
                              onClick={() =>{  closeQuery(tab.id) }}
                              title={`关闭 ${tab.name}`}
                              aria-label={`关闭 ${tab.name}`}
                            ><IconCloseFill14 size={11} /></button>
                          )}
                        </div>
                      ))}
                      <button type="button" className={css.queryTabNew} onClick={newQuery} title="新建查询标签" aria-label="新建查询"><IconPlusOutline16 size={12} /> 新建查询</button>
                    </div>
                    {historyOpen && (
                      <div className={css.historyPanel}>
                        <div className={css.historyHeader}>
                          <span className={css.hint}>查询历史</span>
                          <span className={css.spacer} />
                          <button type="button" className={css.sqlBarBtn} onClick={clearSqlHistory}>清除</button>
                        </div>
                        <div className={css.historyList}>
                          {historyEntries.length === 0 ? (
                            <div className={css.hint}>暂无历史</div>
                          ) : (
                            historyEntries.map((entry, idx) => (
                              <button
                                key={idx}
                                type="button"
                                className={css.historyItem}
                                onClick={() =>{  useHistoryEntry(entry) }}
                                title={`${entry.db !== '' ? `[${entry.db}] ` : ''}${entry.sql}`}
                              >
                                <span className={css.historySql}>{entry.sql}</span>
                                <span className={css.hint}>{(new Date(entry.time)).toLocaleTimeString()}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                    <SqlEditor
                      value={activeTab.sql}
                      onChange={(next) =>{  patchTab(activeQueryId, { sql: next }) }}
                      dialect={dialect === 'postgresql' ? 'postgresql' : 'mysql'}
                      onExecute={(statement, explain) => void executeSql(statement, explain)}
                      schema={sqlSchema}
                      placeholder="SELECT * FROM users WHERE …"
                    />
                    {activeTab.error !== null && <div className={css.error}>{activeTab.error}</div>}
                  </div>
                  {/* SQL 编辑区与结果区之间的可拖拽横向分隔条。 */}
                  <div
                    className={css.sqlResize}
                    onPointerDown={onSqlResizeStart}
                    onPointerMove={onSqlResizeMove}
                    onPointerUp={onSqlResizeEnd}
                    onPointerCancel={onSqlResizeEnd}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="调整 SQL 编辑区高度"
                  />
                  {/* 结果区:当前活动标签的执行结果,或空态占位。 */}
                  <div className={css.sqlResultArea}>
                    {activeTab.result !== null && activeTab.error === null ? (
                      <SqlQueryResultView result={activeTab.result} onClose={() =>{  patchTab(activeQueryId, { result: null }) }} />
                    ) : (
                      <div className={css.placeholder}>运行查询后将在此显示结果(执行 / EXPLAIN)</div>
                    )}
                  </div>
                </div>
              ) : (
                selected === null ? (
                  <div className={css.placeholder}>选择左侧一个表查看数据(排序 / 分页 / WHERE 筛选 / NULL 高亮已就位)</div>
                ) : (
                  <DbDataGrid
                    key={selected.table}
                    connId={connId}
                    table={selected.table}
                    cmdPrefix={cmdPrefix}
                    {...(selected.database !== undefined ? { database: selected.database } : {})}
                    onExport={(orderBy, orderDir, whereFilter) =>
                      void exportTableExcel(selected.table, selected.database, orderBy, orderDir, whereFilter)}
                  />
                )
              )
            ) : (
              <div className={css.placeholder}>连接数据库后将在此显示 SQL 编辑器</div>
            )}
            {exporting && <div className={css.exportMsg}>正在导出 Excel…</div>}
            {exportError !== null && !exporting && <div className={css.error}>{exportError}</div>}
          </section>
          {monitorSupported && showMonitor && (
            <div
              className={css.monitorResize}
              onPointerDown={onMonitorResizeStart}
              onPointerMove={onMonitorResizeMove}
              onPointerUp={onMonitorResizeEnd}
              onPointerCancel={onMonitorResizeEnd}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整监控面板宽度"
            />
          )}
          {monitorSupported && showMonitor && (
            <aside className={css.monitor} style={{ width: monitorWidth }}>
              <DbDashboard
                connId={connId}
                dbType={dbType}
                connected={connected}
                database={currentDb !== '' ? currentDb : selected?.database}
              />
            </aside>
          )}
        </div>
        {ddl !== null && (
          <div className={css.ddlBackdrop}>
            <div className={css.ddlPanel}>
              <header className={css.ddlHeader}>
                <span className={css.title}>DDL · {ddl.table}</span>
                <span className={css.spacer} />
                <button type="button" className={css.closeBtn} onClick={() =>{  setDdl(null) }}>关闭</button>
              </header>
              <pre className={css.ddlBody}>{ddl.loading === true ? '加载中…' : (ddl.content || '')}</pre>
            </div>
          </div>
        )}
        {dialog !== null && dialog.kind === 'new-table' && (
          <NewTableDialog
            connId={connId}
            database={dialog.database}
            dialect={dialect}
            onClose={() =>{  setDialog(null) }}
            onCreated={(name) =>{  onTableCreated(dialog.database, name) }}
          />
        )}
        {dialog !== null && dialog.kind === 'columns' && (
          <ColumnListDialog
            connId={connId}
            database={dialog.database}
            table={dialog.table}
            onClose={() => {
              setDialog(null)
              setColumnsByTable(prev => {
                const next = { ...prev }
                delete next[dialog.table]
                return next
              })
            }}
          />
        )}
        {dialog !== null && dialog.kind === 'indexes' && (
          <IndexListDialog
            connId={connId}
            database={dialog.database}
            table={dialog.table}
            onClose={() =>{  setDialog(null) }}
          />
        )}
      </div>
    </div>
  )
}

export default DbWorkbench

/** 顶部 SQL 区与底部表网格之间的样式名引用(sqlPane/sqlBar 等见 css)。 */

/**
 * 渲染一次 SQL 执行的原始结果(execute 返回全量 QueryResult),填充底部数据栏:
 * 一行渲染列头,数据行直接展示,NULL 灰显;rowCount 上限防爆。SQL 结果不走
 * 服务端分页(execute 一次性返回),因此不做虚拟滚动。onClose 关闭后回到表数据。
 */
function SqlQueryResultView({ result, onClose }: { result: SqlQueryResult; onClose: () => void }) {
  const columns = Array.isArray(result.columns)
    ? (result.columns as Array<{ name?: string; type?: string; nullable?: boolean }>)
    : []
  const rows = Array.isArray(result.rows) ? (result.rows as unknown[][]) : []
  const display = rows.slice(0, 200)
  const truncated = rows.length > display.length
  return (
    <div className={css.sqlResult}>
      <div className={css.sqlResultBar}>
        <span>执行结果{columns.length > 0 ? ` · ${columns.length} 列` : ''}{rows.length > 0 ? ` · ${rows.length} 行` : ''}</span>
        <span className={css.spacer} />
        <button type="button" className={css.sqlBarBtn} onClick={onClose} title="关闭执行结果,回到表数据" aria-label="关闭执行结果">返回表数据</button>
      </div>
      {columns.length === 0 ? (
        <div className={css.hint}>完成{rows.length > 0 ? `,影响 ${rows.length} 行` : ''}</div>
      ) : (
        <div className={css.sqlTableWrap}>
          <table className={css.sqlTable}>
            <thead>
              <tr>{columns.map((c, i) => <th key={c.name ?? i}>{c.name}</th>)}</tr>
            </thead>
            <tbody>
              {display.map((row, ri) => (
                <tr key={ri}>
                  {columns.map((_c, ci) => (
                    <td key={ci} className={row[ci] === null || row[ci] === undefined ? css.tdNull : undefined}>
                      {cellText(row[ci])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <div className={css.hint}>仅显示前 200 行</div>}
    </div>
  )
}
