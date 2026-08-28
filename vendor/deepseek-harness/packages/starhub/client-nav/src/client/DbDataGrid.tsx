/**
 * StarHub 原生数据库结果网格(需求 5 React 化,批次 3 + 批次 5 补齐)。
 *
 * 手写 DOM 虚拟滚动表格(ROW_HEIGHT=28, OVERSCAN=8, topSpacer/bottomSpacer),
 * 服务端分页/排序(db_mysql_get_table_data 的 limit/offset/orderBy/orderDir),
 * NULL 高亮,宽列数字对齐。行是 Positional Array(row[colIdx])。
 *
 * 批次 5 补齐:
 * - 单元格编辑:双击进入编辑,Enter/失焦提交 → dirty 集(按行分组),保存按钮
 *   按行调 db_mysql_update_rows(sets={col:new}, where=pkCols 相等),成功后重载。
 * - 行右键菜单:复制为 INSERT(剪贴板)。
 * - 列筛选:列头筛选按钮 → 弹层输入 → columnFilters 服务端过滤(db_mysql_get_table_data
 *   的 columnFilters 参数),可清除。
 * - CSV 导出:客户端生成当前页 CSV 并下载。
 *
 * HubHex 风格 WHERE 条件栏(仿其表数据筛选输入):网格上方的条件输入框,占位
 * `id = xxx AND name LIKE '%xxx%'`,回车应用(服务端 raw filter 参数,后端包一层
 * `(…) WHERE`)、Shift+回车换行、Esc 清除;取代旧快捷筛选(其 quickFilter 参数
 * 未被 db_mysql_get_table_data 的 Tauri command 声明,原实现是被静默丢弃的死路)。
 *
 * v0.102.0:WHERE 栏加**字段提示**(whereSuggestions 纯函数):光标处有标识符词
 * 时提示列名(前缀优先、子串次之,带类型)与 SQL 关键字;表达式开头 / AND / OR /
 * NOT / 左括号后的空白位提示全部列。↑/↓ 选择,Tab/Enter 接受,Esc 先关弹层。
 * 列清单复用 list_columns(与主键列同一次调用,不再单独请求)。
 *
 * 命令面复用:db_mysql_get_table_data(PG 同样走它,RPC 按 connId 分派 pgx)、
 * db_mysql_list_columns(取主键列)、db_mysql_update_rows。返回 QueryResult:
 * `{ columns:[{name,type,nullable}], rows:unknown[][], totalRows?:number,
 * durationMs?:number, isSelect?:boolean, error?:string }`;`filter`(raw WHERE)/
 * `columnFilters` 由 db_mysql_get_table_data / db_clickhouse_get_table_data /
 * db_mysql_export_excel 的 Tauri command 显式声明透传。
 *
 * @module StarHub DB data grid (client)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tauriInvoke } from './tauri.ts'
import { ContextMenu, useContextMenu } from './ContextMenu.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DbDataGrid.module.css'

/** QueryResult 列信息(C 节数据形态;与 Vue src/types/db.ts ColumnInfo 同构)。 */
export interface QueryColumn { name: string; type?: string; nullable?: boolean }

/** get_table_data 返回(与 Vue QueryResult 同构)。 */
export interface QueryResult {
  columns: QueryColumn[]
  rows: unknown[][]
  totalRows?: number
  durationMs?: number
  isSelect?: boolean
  error?: string
}

/** 页大小选项。 */
const PAGE_SIZES = [100, 500, 1000, 5000] as const

/** 行高与窗口外预渲染行数,与 Vue DbSimpleGrid 对齐。 */
const ROW_HEIGHT = 28
const OVERSCAN = 8

/** 单元格展示:null → 'NULL';对象 → JSON 文本。 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  const primitive = value as string | number | boolean | bigint | symbol
  return String(primitive)
}

/** SQL 字符串字面量:null → NULL;数字原样;其余单引号包裹并转义单引号。 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  const primitive = value as string | bigint | symbol
  return `'${String(primitive).replace(/'/g, "''")}'`
}

/** 把一行拼成 INSERT 语句(列名反引号包裹,值走 sqlLiteral)。 */
export function rowToInsert(table: string, columns: QueryColumn[], row: unknown[]): string {
  const cols = columns.map(c => `\`${c.name}\``).join(', ')
  const values = row.map(v => sqlLiteral(v)).join(', ')
  return `INSERT INTO \`${table}\` (${cols}) VALUES (${values});`
}

/** 单元格是否数字(用于右对齐)。 */
export function isNumericCell(value: unknown): boolean {
  return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
}

/** 把结果转 CSV(引号/逗号/换行转义;null → 空串,与 Vue 导出契约一致)。 */
export function rowsToCsv(columns: QueryColumn[], rows: unknown[][]): string {
  const escape = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const header = columns.map(c => escape(c.name)).join(',')
  const body = rows.map(row => row.map(cell => escape(cell === null || cell === undefined ? '' : cellText(cell))).join(',')).join('\n')
  return `${header}\n${body}`
}

/** 触发浏览器下载文本文件(jsdom 下 URL.createObjectURL 需 stub)。 */
export function downloadTextFile(filename: string, content: string, mime = 'text/csv'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** WHERE 自动补全的 SQL 关键字候选(单词级,前缀匹配)。 */
export const WHERE_KEYWORDS = ['AND', 'OR', 'NOT', 'LIKE', 'IN', 'IS', 'NULL', 'BETWEEN', 'TRUE', 'FALSE'] as const

/** 一条 WHERE 补全建议:列(带类型 detail)或关键字。 */
export interface WhereSuggestion { kind: 'column' | 'keyword'; text: string; detail?: string }

/**
 * WHERE 输入的字段提示(纯函数,供组件与单测共用):
 * - 光标前有标识符词(≥1 字符):列名前缀匹配优先、子串匹配次之(带类型 detail),
 *   再补 SQL 关键字前缀匹配;与当前词完全相同的项剔除(词已输完,Enter 应直接
 *   应用筛选而非接受补全)。
 * - 光标前是表达式开头 / AND / OR / NOT / 左括号后的空白:提示全部列。
 * @param text - 当前 WHERE 草稿全文。
 * @param cursor - 光标位置(selectionStart)。
 * @param columns - 表列清单(list_columns 的 name/type)。
 * @param limit - 建议条数上限(默认 8)。
 * @returns 建议集(start 为当前词替换起点);无可提示返回 null。
 */
/** 列 → 建议项(无类型时省略 detail,满足 exactOptionalPropertyTypes)。 */
const colSuggestion = (c: QueryColumn): WhereSuggestion => ({
  kind: 'column',
  text: c.name,
  ...(c.type !== undefined ? { detail: c.type } : {}),
})

export function whereSuggestions(text: string, cursor: number, columns: readonly QueryColumn[], limit = 8): { start: number; items: WhereSuggestion[] } | null {
  const before = text.slice(0, cursor)
  const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)
  if (m !== null) {
    const word = m[0]
    const lower = word.toLowerCase()
    const cols: WhereSuggestion[] = columns
      .filter(c => c.name.toLowerCase().includes(lower))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(lower) ? 0 : 1
        const bp = b.name.toLowerCase().startsWith(lower) ? 0 : 1
        return ap !== bp ? ap - bp : a.name.localeCompare(b.name)
      })
      .map(colSuggestion)
    const kws: WhereSuggestion[] = WHERE_KEYWORDS
      .filter(k => k.startsWith(word.toUpperCase()))
      .map(k => ({ kind: 'keyword', text: k }))
    const items = [...cols, ...kws].filter(s => s.text.toLowerCase() !== lower).slice(0, limit)
    return items.length > 0 ? { start: cursor - word.length, items } : null
  }
  // 空词触发位:输入开头 / AND / OR / NOT / 左括号之后(等值运算符后是该填值,不提示列)。
  if (columns.length > 0 && /(^|\bAND|\bOR|\bNOT|\()\s*$/i.test(before)) {
    return { start: cursor, items: columns.slice(0, limit).map(colSuggestion) }
  }
  return null
}

/**
 * Render a virtualized, server-paginated DB result grid with editing, filters,
 * CSV export, and a copy-as-INSERT row context menu.
 * @param props - connection id, table name, and selected database.
 * @param props.onExport - optional callback invoked with the current sort
 *   state when the user clicks 导出 Excel; omitted to hide the button.
 * @returns the data grid (toolbar + virtual rows + pager).
 */
export function DbDataGrid({
  connId, table, database, cmdPrefix = 'db_mysql', onExport,
}: { connId: string; table: string; database?: string; cmdPrefix?: 'db_mysql' | 'db_clickhouse'; onExport?: (orderBy: string | null, orderDir: 'asc' | 'desc', whereFilter: string | null) => void }) {
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(100)
  const [orderBy, setOrderBy] = useState<string | null>(null)
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [scrollTop, setScrollTop] = useState(0)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  // 表头横向滚动跟随 tbody(thead 自身 overflow:hidden,不占滚动条)。
  const theadRef = useRef<HTMLDivElement | null>(null)
  // 列筛选(服务端):列名 → 筛选文本;空串/缺省表示不过滤。
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})
  // HubHex 风格 WHERE 条件筛选(服务端 raw filter):whereFilter 为已应用值
  // (Enter 应用),whereDraft 为 textarea 输入草稿(Shift+Enter 换行,Esc 清除)。
  const [whereFilter, setWhereFilter] = useState('')
  const [whereDraft, setWhereDraft] = useState('')
  const whereRef = useRef<HTMLTextAreaElement | null>(null)
  // 列筛选弹层:当前列名 / 输入 / 锚点行底坐标(相对视口,弹层 fixed)。
  const [filterCol, setFilterCol] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [filterPos, setFilterPos] = useState({ top: 0, left: 0 })
  // 主键列(list_columns 的 key==='PRI'),用于构造 UPDATE WHERE。
  const [pkCols, setPkCols] = useState<string[]>([])
  // 全量列清单(list_columns 的 name/type),喂 WHERE 自动补全(v0.102.0)。
  const [tableCols, setTableCols] = useState<QueryColumn[]>([])
  // 表总行数(get_row_count,仅在无列筛选时作为分页基数;有筛选时用结果里的
  // 过滤后 totalRows)。sidecar 各适配器只在带 WHERE 时才回传 totalRows,
  // 否则恒 0 → 分页恒 1/1,所以无筛选时单独取一次 COUNT。
  const [baseCount, setBaseCount] = useState<number | null>(null)
  // 单元格编辑:dirty 集 key `${rowIdx}::${colName}` → {col, originalValue, newValue}。
  const [dirty, setDirty] = useState<Map<string, { col: string; originalValue: unknown; newValue: unknown }>>(new Map())
  // 正在编辑的单元格(rowIdx, colIdx)与输入文本。
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null)
  const [editText, setEditText] = useState('')
  // 批量保存进行中。
  const [saving, setSaving] = useState(false)
  const menu = useContextMenu()

  // 有任一筛选(WHERE 条件 / 列筛选)时以结果自带 totalRows 为分页基数,否则用全表 COUNT。
  const filtering = whereFilter !== '' || Object.values(columnFilters).some(v => v !== '')
  const totalRows = filtering
    ? (result?.totalRows ?? 0)
    : (baseCount ?? result?.totalRows ?? 0)
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize))
  const columns = result?.columns ?? []
  const rows = result?.rows ?? []

  // 总数收缩(加筛选 / 删行)导致当前页越界时回退到末页。
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1)
  }, [page, pageCount])

  // 切换表时重置 WHERE 筛选(列筛选保持原行为,不在此处置)。
  useEffect(() => {
    setWhereFilter('')
    setWhereDraft('')
  }, [table])

  const load = useCallback(async (offset: number, size: number, sortCol: string | null, dir: 'asc' | 'desc', filters: Record<string, string>, where: string) => {
    setLoading(true)
    setError(null)
    try {
      const args: Record<string, unknown> = { connId, table, limit: size, offset }
      if (database !== undefined && database !== '') args.database = database
      if (sortCol !== null) {
        args.orderBy = sortCol
        args.orderDir = dir
      }
      const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''))
      if (Object.keys(activeFilters).length > 0) args.columnFilters = activeFilters
      if (where !== '') args.filter = where
      const res = await tauriInvoke<QueryResult>(`${cmdPrefix}_get_table_data`, args)
      if (res.error !== undefined && res.error !== '') {
        setError(res.error)
      } else {
        setResult(res)
        setDirty(new Map())
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connId, table, database, cmdPrefix])

  // 表 / 页大小 / 页 / 排序 / 列筛选 / WHERE 条件变化 → 重新拉服务端数据。
  useEffect(() => {
    void load(page * pageSize, pageSize, orderBy, orderDir, columnFilters, whereFilter)
  }, [page, pageSize, orderBy, orderDir, columnFilters, whereFilter, load])

  // 列清单:每次表切换后经 list_columns 取一次——主键列(key==='PRI')构造 UPDATE
  // WHERE;全量列名+类型喂 WHERE 自动补全。
  useEffect(() => {
    let cancelled = false
    setPkCols([])
    setTableCols([])
    void tauriInvoke<Array<Record<string, unknown>>>(`${cmdPrefix}_list_columns`, {
      connId, table, ...(database !== undefined && database !== '' ? { database } : {}),
    })
      .then((cols) => {
        /* v8 ignore next -- 防御:表切换卸载竞态,取消后丢弃过期响应 */
        if (cancelled) return
        const list = Array.isArray(cols) ? cols : []
        const pks = list
          .filter(c => c.key === 'PRI' || c.key === 'PRI,')
          .map(c => String(c.name))
          .filter(n => n !== '')
        setPkCols(pks)
        setTableCols(
          list
            .map(c => ({ name: String(c.name ?? ''), ...(typeof c.type === 'string' ? { type: c.type } : {}) }))
            .filter(c => c.name !== ''),
        )
      })
      .catch(() => { /* 列清单获取失败不阻塞浏览(编辑禁用 + 无补全) */ })
    return () => { cancelled = true }
  }, [connId, table, database, cmdPrefix])

  // 无筛选分页基数:表切换时取一次全表 COUNT(失败静默,退回结果自带 totalRows)。
  useEffect(() => {
    let cancelled = false
    setBaseCount(null)
    void tauriInvoke<number>(`${cmdPrefix}_get_row_count`, {
      connId, table, ...(database !== undefined && database !== '' ? { database } : {}),
    })
      .then((n) => {
        /* v8 ignore next -- 防御:表切换卸载竞态,取消后丢弃过期响应 */
        if (!cancelled && typeof n === 'number' && Number.isFinite(n)) setBaseCount(n)
      })
      .catch(() => { /* 行数获取失败不阻塞浏览 */ })
    return () => { cancelled = true }
  }, [connId, table, database, cmdPrefix])

  const toggleSort = (col: QueryColumn): void => {
    if (orderBy === col.name) {
      setOrderDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setOrderBy(col.name)
      setOrderDir('asc')
    }
    setPage(0)
  }

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleEnd = Math.min(rows.length, Math.ceil((scrollTop + (viewportRef.current?.clientHeight ?? 400)) / ROW_HEIGHT) + OVERSCAN)
  const visibleRows = rows.slice(visibleStart, visibleEnd)

  // ─── 列筛选弹层 ───
  const openFilter = (e: React.MouseEvent, col: string): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setFilterPos({ top: rect.bottom + 4, left: rect.left })
    setFilterCol(col)
    setFilterText(columnFilters[col] ?? '')
  }

  const closeFilter = (): void => {
    setFilterCol(null)
    setFilterText('')
  }

  const applyFilter = (): void => {
    /* v8 ignore next -- 防御:弹层关闭后不会触发应用(按钮随弹层渲染) */
    if (filterCol !== null) {
      setColumnFilters(prev => ({ ...prev, [filterCol]: filterText }))
      setPage(0)
    }
    closeFilter()
  }

  const clearFilter = (): void => {
    /* v8 ignore next -- 防御:弹层关闭后不会触发清除(按钮随弹层渲染) */
    if (filterCol !== null) {
      setColumnFilters(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== filterCol)))
      setPage(0)
    }
    closeFilter()
  }

  const onFilterKeydown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') applyFilter()
    if (e.key === 'Escape') closeFilter()
  }

  // ─── 行右键:复制为 INSERT ───
  const [menuRow, setMenuRow] = useState<number>(-1)
  const rowMenuItems: readonly MenuEntry[] = [
    { id: 'copy-insert', label: '复制为 INSERT' },
  ]
  const onRowContextMenu = (e: React.MouseEvent, rowIdx: number): void => {
    setMenuRow(rowIdx)
    menu.onContextMenu(e)
  }
  const copyInsert = (rowIdx: number): void => {
    const row = rows[rowIdx]
    /* v8 ignore next -- 防御:行号来自可见行枚举,恒有对应行 */
    if (row === undefined) return
    const sql = rowToInsert(table, columns, row)
    void navigator.clipboard.writeText(sql).catch(() => {})
  }

  // ─── 单元格编辑 ───
  const dirtyKey = (rowIdx: number, col: string): string => `${rowIdx}::${col}`
  const valuesEqual = (a: unknown, b: unknown): boolean => Object.is(a, b)

  const startEdit = (rowIdx: number, colIdx: number): void => {
    const cell = rows[rowIdx]?.[colIdx]
    setEditing({ row: rowIdx, col: colIdx })
    setEditText(cellText(cell))
  }

  /** 把一次编辑应用到 dirty 副本(纯函数;供失焦提交与 Ctrl+S 共用)。 */
  const applyEditToDirty = (
    base: Map<string, { col: string; originalValue: unknown; newValue: unknown }>,
  ): Map<string, { col: string; originalValue: unknown; newValue: unknown }> => {
    if (editing === null) return base
    const col = columns[editing.col]
    /* v8 ignore next -- 防御:col 下标由渲染映射生成,恒在 columns 范围内 */
    if (col === undefined) return base
    const originalValue = rows[editing.row]?.[editing.col]
    // 编辑文本 → 值:空串保持 null(与网格显示一致);数字列尝试转 number。
    let newValue: unknown = editText
    if (editText === '') newValue = null
    else if (isNumericCell(originalValue)) {
      const n = Number(editText)
      if (!Number.isNaN(n)) newValue = n
    }
    const next = new Map(base)
    if (valuesEqual(originalValue, newValue)) {
      next.delete(dirtyKey(editing.row, col.name))
    } else {
      next.set(dirtyKey(editing.row, col.name), { col: col.name, originalValue, newValue })
    }
    return next
  }

  const commitEdit = (): void => {
    /* v8 ignore next -- 防御:输入框失焦/回车仅在编辑态触发 */
    if (editing === null) return
    setDirty(prev => applyEditToDirty(prev))
    setEditing(null)
  }

  const cancelEdit = (): void => { setEditing(null) }

  const hasDirty = dirty.size > 0

  const saveAll = useCallback(async (dirtyOverride?: Map<string, { col: string; originalValue: unknown; newValue: unknown }>) => {
    const source = dirtyOverride ?? dirty
    if (source.size === 0) return
    setSaving(true)
    setError(null)
    let failed = false
    try {
      // 按行分组:一行一次 update_rows(sets 为该行所有 dirty 列)。
      const byRow = new Map<number, Array<{ col: string; newValue: unknown }>>()
      for (const [key, change] of source) {
        const rowIdx = Number(key.split('::')[0])
        const list = byRow.get(rowIdx) ?? []
        list.push({ col: change.col, newValue: change.newValue })
        byRow.set(rowIdx, list)
      }
      for (const [rowIdx, changes] of byRow) {
        const row = rows[rowIdx]
        /* v8 ignore next -- 防御:行号来自 dirty 键,保存前网格已持有该行 */
        if (row === undefined) continue
        const pkWhere = pkCols
          .map((pk) => {
            const idx = columns.findIndex(c => c.name === pk)
            return idx >= 0 ? `\`${pk}\` = ${sqlLiteral(row[idx])}` : null
          })
          .filter((part): part is string => part !== null)
          .join(' AND ')
        if (pkWhere === '') {
          setError('表缺少主键列,无法定位行更新')
          failed = true
          continue
        }
        const sets: Record<string, unknown> = {}
        for (const c of changes) sets[c.col] = c.newValue
        const args: Record<string, unknown> = { connId, table, sets, where: pkWhere }
        if (database !== undefined && database !== '') args.database = database
        const res = await tauriInvoke<{ rowsAffected?: number; error?: string }>(`${cmdPrefix}_update_rows`, args)
        if (res.error !== undefined && res.error !== '') {
          setError(res.error)
          failed = true
          break
        }
        if (res.rowsAffected === 0) {
          setError('更新 0 行(行数据可能已被修改)')
          failed = true
          break
        }
      }
      if (!failed) {
        // 全部成功 → 清 dirty 并重载当前页。
        setDirty(new Map())
        void load(page * pageSize, pageSize, orderBy, orderDir, columnFilters, whereFilter)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [dirty, rows, pkCols, columns, connId, table, database, cmdPrefix, page, pageSize, orderBy, orderDir, columnFilters, whereFilter, load])

  // Ctrl/Cmd+S 全局保存(与 Vue 对齐);编辑输入中先提交再保存。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        const pending = applyEditToDirty(dirty)
        setEditing(null)
        void saveAll(pending)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () =>{  window.removeEventListener('keydown', onKeyDown) }
  }, [dirty, editing, editText, columns, rows, saveAll])

  const exportCsv = (): void => {
    /* v8 ignore next -- 防御:按钮在无数据时 disabled,点击路径恒有行列 */
    if (columns.length === 0 || rows.length === 0) return
    downloadTextFile(`${table}_page${page + 1}.csv`, rowsToCsv(columns, rows))
  }

  const filteredCount = useMemo(() => Object.values(columnFilters).filter(v => v !== '').length, [columnFilters])

  // ─── WHERE 自动补全(v0.102.0):焦点门(未聚焦不弹)+ 光标位置跟踪 +
  // Esc/失焦关弹层抑制 + 高亮下标 ───
  const [whereFocused, setWhereFocused] = useState(false)
  const [whereCursor, setWhereCursor] = useState(0)
  const [sugDismissed, setSugDismissed] = useState(false)
  const [sugActive, setSugActive] = useState(0)
  const sug = useMemo(
    () => (whereFocused && !sugDismissed ? whereSuggestions(whereDraft, whereCursor, tableCols) : null),
    [whereDraft, whereCursor, tableCols, whereFocused, sugDismissed],
  )
  /** 接受一条建议:替换当前词(或插入到空词位),光标落到插入文本之后。 */
  const acceptSuggestion = (text: string): void => {
    /* v8 ignore next -- 调用方(键盘/点击)均在弹层非空分支,防御未就绪 */
    if (sug === null) return
    const next = whereDraft.slice(0, sug.start) + text + whereDraft.slice(whereCursor)
    const pos = sug.start + text.length
    setWhereDraft(next)
    setWhereCursor(pos)
    setSugActive(0)
    // 接受一次后关闭,继续输入(onChange)再重新弹。
    setSugDismissed(true)
    requestAnimationFrame(() => {
      whereRef.current?.setSelectionRange(pos, pos)
      whereRef.current?.focus()
    })
  }

  // ─── WHERE 条件筛选:Enter 应用(服务端 raw filter)/ Esc 清除 / × 按钮清除 ───
  const applyWhereFilter = (): void => {
    setWhereFilter(whereDraft.trim())
    setPage(0)
  }
  const clearWhereFilter = (): void => {
    setWhereFilter('')
    setWhereDraft('')
    setPage(0)
  }
  const onWhereKeydown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 补全弹层打开时优先接管:↑/↓ 导航,Tab/Enter 接受,Esc 仅关弹层(不清空)。
    if (sug !== null && sug.items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSugActive(a => (a + 1) % sug.items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSugActive(a => (a - 1 + sug.items.length) % sug.items.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const item = sug.items[Math.min(sugActive, sug.items.length - 1)]
        /* v8 ignore next -- 弹层分支已保证 items 非空,active 下标经取模收束 */
        if (item !== undefined) acceptSuggestion(item.text)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSugDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      applyWhereFilter()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      clearWhereFilter()
    }
  }
  const onWhereChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setWhereDraft(e.target.value)
    setWhereCursor(e.target.selectionStart ?? e.target.value.length)
    setSugDismissed(false)
    setSugActive(0)
  }
  const onWhereSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    setWhereCursor(e.currentTarget.selectionStart)
    setSugActive(0)
  }
  // textarea 随内容行数自动增高(单行起,封顶 120px)。
  useEffect(() => {
    const el = whereRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [whereDraft])

  const onRowSelect = (id: string): void => {
    // 菜单项选择分发:目前只有「复制为 INSERT」一项;menuRow 在右键时写入,
    // 防御 menuRow 未就绪(如菜单项经程序化触发)时静默跳过。
    /* v8 ignore next -- 防御:menuRow 由右键前置写入,菜单项选择恒有行号 */
    if (id === 'copy-insert' && menuRow >= 0) copyInsert(menuRow)
  }

  return (
    <div className={css.root}>
      <div className={css.meta}>
        <span>表 <span className={css.metaTable}>{table}</span>{totalRows > 0 ? ` · ${totalRows.toLocaleString()} 行` : ''}</span>
        {(filteredCount > 0 || whereFilter !== '') && (
          <span className={css.filterBadge}>{filteredCount + (whereFilter !== '' ? 1 : 0)} 个筛选</span>
        )}
        <span className={css.spacer} />
        {onExport !== undefined && (
          <button type="button" className={css.exportBtn} onClick={() =>{  onExport(orderBy, orderDir, whereFilter !== '' ? whereFilter : null) }} title="全量导出该表到 Excel(后端执行,含当前筛选)">
            导出 Excel
          </button>
        )}
        <button type="button" className={css.exportBtn} onClick={exportCsv} disabled={rows.length === 0} title="导出当前页为 CSV">
          导出 CSV
        </button>
        {hasDirty && (
          <button type="button" className={css.saveBtn} onClick={() => void saveAll()} disabled={saving} title="批量保存修改 (Ctrl/Cmd+S)">
            保存 {dirty.size}
          </button>
        )}
        {loading && <span className={css.hint}>加载…</span>}
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      <div className={`${css.whereBar} ${whereFilter !== '' ? css.whereActive : ''}`}>
        <span className={css.whereIcon} aria-hidden="true">WHERE</span>
        <div className={css.whereField}>
          <textarea
            ref={whereRef}
            className={css.whereInput}
            rows={1}
            value={whereDraft}
            onChange={onWhereChange}
            onSelect={onWhereSelect}
            onFocus={() =>{  setWhereFocused(true) }}
            onBlur={() =>{  setWhereFocused(false); setSugDismissed(true) }}
            onKeyDown={onWhereKeydown}
            placeholder="id = xxx AND name LIKE '%xxx%'  (回车键刷新,Shift+回车换行,Tab 接受提示)"
            aria-label="WHERE 条件筛选"
            spellCheck={false}
            title="输入 WHERE 条件后回车刷新(Shift+回车换行),Tab/Enter 接受字段提示,Esc 清除"
          />
          {sug !== null && (
            <div className={css.sugList} role="listbox" aria-label="字段提示">
              {sug.items.map((s, i) => (
                <button
                  key={`${s.kind}:${s.text}`}
                  type="button"
                  role="option"
                  aria-selected={i === sugActive}
                  className={`${css.sugItem} ${i === sugActive ? css.sugActive : ''}`}
                  onMouseDown={(e) =>{  e.preventDefault(); acceptSuggestion(s.text) }}
                  onMouseEnter={() =>{  setSugActive(i) }}
                >
                  <span className={s.kind === 'column' ? css.sugKindCol : css.sugKindKw}>
                    {s.kind === 'column' ? '列' : '词'}
                  </span>
                  <span className={css.sugText}>{s.text}</span>
                  {s.detail !== undefined && s.detail !== '' && <span className={css.sugDetail}>{s.detail}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {whereDraft !== '' && (
          <button
            type="button"
            className={css.whereClear}
            onClick={clearWhereFilter}
            title="清除 WHERE 筛选"
            aria-label="清除 WHERE 筛选"
          >×</button>
        )}
      </div>
      <div className={css.grid} role="grid" aria-label={`表 ${table} 数据`}>
        <div className={css.thead} ref={theadRef} role="row">
          <div className={css.theadRow}>
            <div className={css.th} style={{ width: 60 }}>#</div>
            {columns.map(col => (
              <div key={col.name} className={css.th} style={{ width: 160 }} role="columnheader">
                <button
                  type="button"
                  className={css.thSort}
                  onClick={() =>{  toggleSort(col) }}
                  title={col.type ?? ''}
                >
                  <span className={css.thLabel}>{col.name}</span>
                  {orderBy === col.name && <span className={css.sortMark}>{orderDir === 'asc' ? '▲' : '▼'}</span>}
                </button>
                <button
                  type="button"
                  className={`${css.filterBtn} ${(columnFilters[col.name] ?? '') !== '' ? css.filterActive : ''}`}
                  onClick={(e) =>{  openFilter(e, col.name) }}
                  title="列筛选"
                  aria-label={`筛选 ${col.name}`}
                >
                  ⌄
                </button>
              </div>
            ))}
          </div>
        </div>
        <div
          ref={viewportRef}
          className={css.tbody}
          role="rowgroup"
          style={{ height: Math.min(rows.length * ROW_HEIGHT, 480) }}
          onScroll={(e) => {
            const el = e.target as HTMLDivElement
            setScrollTop(el.scrollTop)
            // 表头横向跟随表体滚动(thead overflow:hidden,JS 同步 scrollLeft)。
            if (theadRef.current !== null) theadRef.current.scrollLeft = el.scrollLeft
          }}
        >
          <div style={{ height: visibleStart * ROW_HEIGHT }} />
          {visibleRows.map((row, rowIndex) => {
            const absoluteRow = visibleStart + rowIndex
            return (
              <div
                key={absoluteRow}
                className={css.tr}
                role="row"
                style={{ height: ROW_HEIGHT }}
                onContextMenu={(e) =>{  onRowContextMenu(e, absoluteRow) }}
              >
                <div className={css.td} style={{ width: 60 }}>{absoluteRow + 1}</div>
                {row.map((cell, colIndex) => {
                  // v8 ignore next -- 防御:行/列恒等长(服务端按 columns 顺序返回),列缺失属畸形数据
                  const dirtyCell = dirty.get(dirtyKey(absoluteRow, columns[colIndex]?.name ?? ''))
                  const displayed = dirtyCell !== undefined ? dirtyCell.newValue : cell
                  const col = columns[colIndex]
                  const isNull = displayed === null || displayed === undefined
                  return (
                    <div
                      key={colIndex}
                      className={`${css.td} ${isNull ? css.null : ''} ${!isNull && col?.type?.toLowerCase().includes('int') ? css.num : ''} ${dirtyCell !== undefined ? css.dirty : ''}`}
                      style={{ width: 160 }}
                      title={cellText(displayed)}
                      onDoubleClick={() =>{  startEdit(absoluteRow, colIndex) }}
                    >
                      {editing !== null && editing.row === absoluteRow && editing.col === colIndex ? (
                        <input
                          className={css.cellInput}
                          data-testid="cell-edit-input"
                          value={editText}
                          autoFocus
                          onChange={(e) =>{  setEditText(e.target.value) }}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit()
                            if (e.key === 'Escape') cancelEdit()
                          }}
                        />
                      ) : (
                        cellText(displayed)
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          <div style={{ height: (rows.length - visibleEnd) * ROW_HEIGHT }} />
        </div>
      </div>
      <ContextMenu
        menu={menu}
        items={rowMenuItems}
        onSelect={onRowSelect}
        className={css.menuRoot}
      />
      {filterCol !== null && (
        <>
          <div className={css.filterBackdrop} onClick={closeFilter} />
          <div className={css.filterPopover} style={{ top: filterPos.top, left: filterPos.left }}>
            <div className={css.filterHeader}>{filterCol}</div>
            <input
              className={css.filterInput}
              value={filterText}
              onChange={(e) =>{  setFilterText(e.target.value) }}
              onKeyDown={onFilterKeydown}
              autoFocus
              placeholder="输入筛选值…"
            />
            <div className={css.filterActions}>
              <button type="button" className={css.filterBtnSmall} onClick={clearFilter}>清除</button>
              <button type="button" className={css.filterBtnSmall} onClick={applyFilter}>应用</button>
            </div>
          </div>
        </>
      )}
      <div className={css.pager}>
        <button type="button" disabled={page === 0} onClick={() =>{  setPage(p => Math.max(0, p - 1)) }}>上一页</button>
        <span>{page + 1} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount - 1} onClick={() =>{  setPage(p => p + 1) }}>下一页</button>
        <select
          className={css.sizeSelect}
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}
          aria-label="每页行数"
        >
          {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {result?.durationMs !== undefined && <span className={css.hint}>{result.durationMs} ms</span>}
      </div>
    </div>
  )
}

export default DbDataGrid
