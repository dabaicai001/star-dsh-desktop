/**
 * StarHub DB 表操作对话框(批次 4b):新建表 / 批量改列 / 批量索引三个 React 模态框,
 * 从 Vue 端(NewTableDialog / ColumnListDialog / IndexListDialog)移植,复用
 * ddlGenerator 生成 DDL,经 `db_mysql_execute`(PG 复用;ClickHouse 用
 * `db_clickhouse_execute`)执行。为控制复杂度,类型/列的供选用原生 datalist,
 * 省去 Vue 端的 fixed 定位浮层。
 *
 * @module StarHub DB table dialogs (client)
 */

import { useEffect, useMemo, useState } from 'react'
import { tauriInvoke } from './tauri.ts'
import {
  generateBatchColumnDDL,
  generateBatchIndexDDL,
  generateCreateTableDDL,
  type ColumnEdit,
  type ColumnMeta,
  type CreateTableColumn,
  type CreateTableDbType,
  type IndexEdit,
} from './ddlGenerator.ts'
import css from './DbTableDialogs.module.css'

/** 执行返回的最小形态(与 QueryResult 同构;带可选的 error 字段)。 */
interface ExecResult { error?: string }

/** 拒绝值 → 错误文本:String() 语义,对象 JSON 化(与既有提示文案一致)。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  try {
    const serialized = JSON.stringify(error)
    return typeof serialized === 'string' ? serialized : ''
  } catch {
    return '[object Object]'
  }
}

/**
 * 按方言分发执行一条 DDL 语句(ClickHouse 走 db_clickhouse_execute,其余复用
 * db_mysql_execute)。
 * @param connId - 连接 id。
 * @param sql - 待执行语句。
 * @param database - 目标库(可选)。
 * @param dialect - 方言。
 * @throws 当执行返回 error 或 IPC 调用失败。
 */
async function execDdl(connId: string, sql: string, database: string | undefined, dialect: CreateTableDbType): Promise<void> {
  const cmd = dialect === 'clickhouse' ? 'db_clickhouse_execute' : 'db_mysql_execute'
  const res = await tauriInvoke<ExecResult>(cmd, {
    connId,
    sql,
    ...(database !== undefined ? { database } : {}),
  })
  if (typeof res === 'object' && typeof res.error === 'string' && res.error !== '') {
    throw new Error(res.error)
  }
}

// ====== 新建表 ======

/** 新建表的单列编辑行。 */
interface NewColRow extends CreateTableColumn {}

const NEW_TABLE_TYPE_OPTIONS: Record<CreateTableDbType, string[]> = {
  mysql: [
    'BIGINT', 'INT', 'SMALLINT', 'TINYINT',
    'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT', 'MEDIUMTEXT',
    'DECIMAL', 'DOUBLE', 'FLOAT',
    'DATE', 'DATETIME', 'TIMESTAMP',
    'BOOLEAN', 'JSON', 'BLOB',
  ],
  postgresql: [
    'BIGINT', 'INT', 'SMALLINT',
    'VARCHAR', 'CHAR', 'TEXT',
    'NUMERIC', 'DECIMAL', 'DOUBLE PRECISION', 'REAL',
    'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON', 'JSONB', 'UUID', 'BYTEA',
  ],
  clickhouse: [
    'String', 'FixedString',
    'Int8', 'Int16', 'Int32', 'Int64',
    'UInt8', 'UInt16', 'UInt32', 'UInt64',
    'Float32', 'Float64', 'Decimal',
    'Date', 'DateTime', 'Bool', 'UUID', 'JSON',
  ],
}

const CH_ENGINES = ['MergeTree', 'ReplacingMergeTree', 'SummingMergeTree', 'Memory', 'Log', 'TinyLog']

/**
 * 新建表对话框:表名 / (MySQL: Engine+Charset;ClickHouse: Engine)/ 注释 + 列网格。
 * @param connId - 连接 id。
 * @param database - 目标库(必填)。
 * @param dialect - 方言。
 * @param onClose - 关闭回调。
 * @param onCreated - 建表成功回调(携带表名)。
 */
export function NewTableDialog({ connId, database, dialect, onClose, onCreated }: {
  connId: string
  database: string
  dialect: CreateTableDbType
  onClose: () => void
  onCreated: (tableName: string) => void
}) {
  const [tableName, setTableName] = useState('')
  const [cols, setCols] = useState<NewColRow[]>(() =>
    [{ name: 'id', type: dialect === 'clickhouse' ? 'UInt64' : 'BIGINT', size: '', nullable: false, primaryKey: true, defaultValue: '', comment: '' }],
  )
  const [engine, setEngine] = useState('InnoDB')
  const [chEngine, setChEngine] = useState('MergeTree')
  const [charset, setCharset] = useState('utf8mb4')
  const [tableComment, setTableComment] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const typeOptions = NEW_TABLE_TYPE_OPTIONS[dialect]
  const canCreate = tableName.trim() !== '' &&
    cols.length > 0 &&
    cols.every(c => c.name.trim() !== '' && c.type.trim() !== '')

  const updateCol = (idx: number, patch: Partial<NewColRow>) => {
    setCols(prev => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  }

  const addCol = () => {
    setCols(prev => [...prev, { name: '', type: dialect === 'clickhouse' ? 'String' : 'VARCHAR', size: '', nullable: true, primaryKey: false, defaultValue: '', comment: '' }])
  }
  const removeCol = (idx: number) => {
    if (cols.length > 1) setCols(prev => prev.filter((_, i) => i !== idx))
  }
  const moveCol = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= cols.length) return
    setCols((prev) => {
      const next = [...prev]
      const tmp = next[idx]
      const swapped = next[target]
      if (tmp === undefined || swapped === undefined) return prev
      next[idx] = swapped
      next[target] = tmp
      return next
    })
  }

  const onCreate = async () => {
    if (!canCreate || creating) return
    if (!database) { setError('请先选择数据库'); return }
    setCreating(true)
    setError(null)
    try {
      const statements = generateCreateTableDDL({
        dbType: dialect,
        database,
        table: tableName.trim(),
        columns: cols.map(c => ({
          name: c.name.trim(),
          type: c.type,
          size: c.size,
          nullable: c.nullable,
          primaryKey: c.primaryKey,
          defaultValue: c.defaultValue,
          comment: c.comment,
        })),
        engine: dialect === 'clickhouse' ? chEngine : engine,
        charset,
        tableComment,
      })
      for (const ddl of statements) await execDdl(connId, ddl, database, dialect)
      onCreated(tableName.trim())
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <DialogShell title="新建表" subtitle={database} wide onClose={onClose}>
      {error !== null && <div className={css.error}>{error}</div>}

      <div className={css.formRow}>
        <label className={css.formLabel}>表名 <span className={css.required}>*</span></label>
        <input className={css.input} value={tableName} onChange={(e) =>{  setTableName(e.target.value) }} placeholder="请输入表名" autoFocus />
      </div>

      {dialect === 'mysql' && (
        <div className={css.formRowGroup}>
          <div className={css.formRowHalf}>
            <label className={css.formLabel}>Engine</label>
            <select className={css.select} value={engine} onChange={(e) =>{  setEngine(e.target.value) }}>
              <option value="InnoDB">InnoDB</option>
              <option value="MyISAM">MyISAM</option>
              <option value="Memory">Memory</option>
            </select>
          </div>
          <div className={css.formRowHalf}>
            <label className={css.formLabel}>Charset</label>
            <select className={css.select} value={charset} onChange={(e) =>{  setCharset(e.target.value) }}>
              <option value="utf8mb4">utf8mb4</option>
              <option value="utf8">utf8</option>
              <option value="latin1">latin1</option>
            </select>
          </div>
        </div>
      )}

      {dialect === 'clickhouse' && (
        <div className={css.formRow}>
          <label className={css.formLabel}>Engine</label>
          <select className={css.select} value={chEngine} onChange={(e) =>{  setChEngine(e.target.value) }}>
            {CH_ENGINES.map(eng => <option key={eng} value={eng}>{eng}</option>)}
          </select>
        </div>
      )}

      <div className={css.formRow}>
        <label className={css.formLabel}>表注释</label>
        <input className={css.input} value={tableComment} onChange={(e) =>{  setTableComment(e.target.value) }} placeholder="可选" />
      </div>

      <div className={css.columnsSection}>
        <div className={css.columnsHeader}>
          <span className={css.columnsTitle}>列定义</span>
          <button type="button" className={css.smallBtn} onClick={addCol} title="添加列">+</button>
        </div>
        <div className={css.columnsTable}>
          <div className={`${css.columnsRow} ${css.headerRow} ${css.gridNew}`}>
            <span>列名</span><span>类型</span><span>长度/精度</span><span>NULL</span><span>PK</span><span>默认值</span><span>注释</span><span></span>
          </div>
          {cols.map((c, idx) => (
            <div key={idx} className={`${css.columnsRow} ${css.gridNew}`}>
              <input className={css.cellInput} value={c.name} onChange={(e) =>{  updateCol(idx, { name: e.target.value }) }} placeholder="列名" />
              <select className={css.cellInput} value={c.type} onChange={(e) =>{  updateCol(idx, { type: e.target.value }) }}>
                {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input className={css.cellInput} value={c.size} onChange={(e) =>{  updateCol(idx, { size: e.target.value }) }} placeholder={c.type.toUpperCase().startsWith('DECIMAL') || c.type.toUpperCase().startsWith('NUMERIC') ? '10,2' : '255'} />
              <span className={css.check}><input type="checkbox" checked={c.nullable} onChange={(e) =>{  updateCol(idx, { nullable: e.target.checked }) }} /></span>
              <span className={css.check}><input type="checkbox" checked={c.primaryKey} onChange={(e) =>{  updateCol(idx, { primaryKey: e.target.checked }) }} /></span>
              <input
                className={css.cellInput} value={c.defaultValue}
                onChange={(e) =>{  updateCol(idx, { defaultValue: e.target.value }) }}
              />
              <input className={css.cellInput} value={c.comment} onChange={(e) =>{  updateCol(idx, { comment: e.target.value }) }} />
              <span className={css.cellActions}>
                <button type="button" className={css.smallBtn} disabled={idx === 0} onClick={() =>{  moveCol(idx, -1) }} title="↑">↑</button>
                <button type="button" className={css.smallBtn} disabled={idx === cols.length - 1} onClick={() =>{  moveCol(idx, 1) }} title="↓">↓</button>
                <button type="button" className={`${css.smallBtn} ${css.danger}`} disabled={cols.length <= 1} onClick={() =>{  removeCol(idx) }} title="删除">×</button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <footer className={css.footer}>
        <button className={css.btnSecondary} onClick={onClose}>取消</button>
        <button className={css.btnPrimary} disabled={!canCreate || creating} onClick={() => void onCreate()}>
          {creating ? '创建中…' : '创建'}
        </button>
      </footer>
    </DialogShell>
  )
}

// ====== 批量改列 ======

const COMMON_TYPES = [
  'TINYINT', 'TINYINT(1)', 'SMALLINT', 'MEDIUMINT', 'INT', 'INT(11)', 'BIGINT',
  'FLOAT', 'DOUBLE', 'DECIMAL(10,2)',
  'CHAR(36)', 'VARCHAR(64)', 'VARCHAR(128)', 'VARCHAR(255)', 'VARCHAR(500)',
  'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB',
  'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
  'JSON', 'BOOLEAN', 'BIT', 'ENUM', 'SET', 'BINARY', 'VARBINARY',
]

/** 把服务器列转换为可编辑列形态。 */
function columnToEdit(c: ColumnMeta): ColumnEdit {
  return {
    ...c,
    newName: c.name,
    newType: c.type,
    newNullable: c.nullable === 'YES',
    newDefault: c.defaultValue ?? '',
    newComment: c.comment,
    dirty: false,
    dropped: false,
  }
}

/** 计算该列是否相对原始值有变更。 */
function columnDirty(e: ColumnEdit): boolean {
  return e.newName !== e.name ||
    e.newType !== e.type ||
    e.newNullable !== (e.nullable === 'YES') ||
    e.newDefault !== (e.defaultValue ?? '') ||
    e.newComment !== e.comment
}

/**
 * 批量改列对话框:载入表列,以表格批量编辑(改名/类型/可空/默认/注释/删除),
 * 应用时经 generateBatchColumnDDL 生成单条 ALTER TABLE 执行。
 * @param connId - 连接 id。
 * @param database - 库名。
 * @param table - 表名。
 * @param onClose - 关闭回调。
 */
export function ColumnListDialog({ connId, database, table, onClose }: {
  connId: string
  database: string
  table: string
  onClose: () => void
}) {
  const [original, setOriginal] = useState<ColumnMeta[]>([])
  const [edits, setEdits] = useState<ColumnEdit[]>([])
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [newCol, setNewCol] = useState({ name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' })

  useEffect(() => {
    let cancelled = false
    void tauriInvoke<ColumnMeta[]>('db_mysql_list_columns', {
      connId, table, database,
    })
      .then((rows) => {
        if (cancelled) return
        const list = rows.filter(r => typeof r === 'object' && typeof r.name === 'string')
        setOriginal(list)
        setEdits(list.map(columnToEdit))
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!cancelled) { setError(errorText(e)); setLoading(false) }
      })
    return () => { cancelled = true }
  }, [connId, table, database])

  const typeOptions = useMemo(() => {
    const merged = [...edits.map(e => e.newType), ...COMMON_TYPES]
    return Array.from(new Set(merged))
  }, [edits])

  const filtered = useMemo(() => {
    if (!search) return edits
    const q = search.toLowerCase()
    return edits.filter(e => (e.name + e.newType).toLowerCase().includes(q))
  }, [edits, search])

  const updateEdit = (idx: number, patch: Partial<ColumnEdit>) => {
    setEdits(prev => prev.map((e, i) => {
      if (i !== idx) return e
      const next = { ...e, ...patch }
      next.dirty = columnDirty(next)
      return next
    }))
  }

  const toggleDrop = (idx: number) => {
    setEdits(prev => prev.map((e, i) => (i === idx ? { ...e, dropped: !e.dropped, dirty: true } : e)))
  }
  const resetCol = (idx: number) => {
    setEdits(prev => prev.map((e, i) => {
      if (i !== idx) return e
      const orig = original[i]
      return orig !== undefined ? columnToEdit(orig) : e
    }))
  }
  const addNewCol = () => {
    if (!newCol.name.trim()) return
    const name = newCol.name.trim()
    setEdits(prev => [...prev, {
      name, newName: name, type: newCol.type, newType: newCol.type,
      dataType: '', nullable: 'YES', newNullable: newCol.nullable,
      key: '', defaultValue: null, newDefault: newCol.defaultVal,
      extra: '', comment: '', newComment: newCol.comment,
      ordinalPosition: 0, dirty: true, dropped: false,
    }])
    setNewCol({ name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' })
  }

  const applyChanges = async () => {
    const ddls = generateBatchColumnDDL(database, table, original, edits)
    if (ddls.length === 0) return
    setExecuting(true)
    setError(null)
    setSuccess(null)
    try {
      for (const ddl of ddls) await execDdl(connId, ddl, database, 'mysql')
      setSuccess(`Applied ${ddls.length} DDL statement(s)`)
      // 重载列定义(应用成功 → 原始值刷新)。
      const rows = await tauriInvoke<ColumnMeta[]>('db_mysql_list_columns', { connId, table, database })
      const list = rows.filter(r => typeof r === 'object' && typeof r.name === 'string')
      setOriginal(list)
      setEdits(list.map(columnToEdit))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExecuting(false)
    }
  }

  const keyBadge = (e: ColumnEdit): string => {
    if (e.key === 'PRI') return 'PK'
    if (e.key === 'UNI') return 'UQ'
    if (e.key === 'MUL') return 'IDX'
    return ''
  }

  return (
    <DialogShell title={`${database}.${table}`} subtitle={`${edits.length} columns`} wide onClose={onClose}>
      <div className={css.searchRow}>
        <input className={css.input} value={search} onChange={(e) =>{  setSearch(e.target.value) }} placeholder="搜索列名/类型…" />
      </div>
      {loading && <div className={css.loading}>加载列定义…</div>}
      {!loading && error !== null && <div className={css.error}>{error}</div>}
      {!loading && success !== null && <div className={css.success}>{success}</div>}

      {!loading && (
        <>
          <div className={css.body} style={{ padding: 0 }}>
            <table className={css.structTable}>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>#</th>
                  <th>名称</th><th>类型</th><th style={{ width: 44 }}>NULL</th><th>默认值</th>
                  <th>注释</th><th style={{ width: 44 }}>键</th><th style={{ width: 74 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, idx) => (
                  <tr key={`${e.name}-${idx}`} className={`${e.dirty && !e.dropped ? css.dirty : ''} ${e.dropped ? css.dropped : ''}`}>
                    <td className={css.tdIdx}>{idx + 1}</td>
                    <td>
                      <input
                        className={css.cellInput} value={e.newName}
                        onChange={(ev) =>{  updateEdit(idx, { newName: ev.target.value }) }}
                      />
                    </td>
                    <td>
                      <input className={css.cellInput} list="col-type-list" value={e.newType} onChange={(ev) =>{  updateEdit(idx, { newType: ev.target.value }) }} placeholder="VARCHAR(255)" />
                    </td>
                    <td className={css.tdCenter}><input type="checkbox" checked={e.newNullable} onChange={(ev) =>{  updateEdit(idx, { newNullable: ev.target.checked }) }} /></td>
                    <td>
                      <input
                        className={css.cellInput} value={e.newDefault}
                        onChange={(ev) =>{  updateEdit(idx, { newDefault: ev.target.value }) }}
                      />
                    </td>
                    <td>
                      <input
                        className={css.cellInput} value={e.newComment}
                        onChange={(ev) =>{  updateEdit(idx, { newComment: ev.target.value }) }}
                      />
                    </td>
                    <td className={css.tdCenter}>{keyBadge(e) && <span className={css.keyBadge}>{keyBadge(e)}</span>}</td>
                    <td className={css.tdActions}>
                      <button type="button" className={`${css.smallBtn} ${e.dropped ? css.active : ''}`} onClick={() =>{  toggleDrop(idx) }} title="删除">×</button>
                      {e.dirty && !e.dropped && <button type="button" className={css.smallBtn} onClick={() =>{  resetCol(idx) }} title="重置">↺</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="col-type-list">
              {typeOptions.map(t => <option key={t} value={t} />)}
            </datalist>
            <div className={css.addRow}>
              <input className={css.cellInput} style={{ width: 110 }} value={newCol.name} onChange={(e) =>{  setNewCol({ ...newCol, name: e.target.value }) }} placeholder="新列名" />
              <input className={css.cellInput} style={{ width: 130 }} list="col-type-list" value={newCol.type} onChange={(e) =>{  setNewCol({ ...newCol, type: e.target.value }) }} placeholder="VARCHAR(255)" />
              <label className={css.muted} style={{ display: 'flex', alignItems: 'center', gap: 4, backgroundColor: 'transparent' }}>
                <input type="checkbox" checked={newCol.nullable} onChange={(e) =>{  setNewCol({ ...newCol, nullable: e.target.checked }) }} /> NULL
              </label>
              <input className={css.cellInput} style={{ width: 84 }} value={newCol.defaultVal} onChange={(e) =>{  setNewCol({ ...newCol, defaultVal: e.target.value }) }} placeholder="default" />
              <input className={css.cellInput} style={{ width: 120 }} value={newCol.comment} onChange={(e) =>{  setNewCol({ ...newCol, comment: e.target.value }) }} placeholder="comment" />
              <button className={css.btnSecondary} onClick={addNewCol}>+ 新增</button>
            </div>
          </div>
          <footer className={css.footer}>
            <button className={css.btnSecondary} onClick={onClose}>取消</button>
            <button className={css.btnPrimary} disabled={executing} onClick={() => void applyChanges()}>
              {executing ? '应用中…' : '应用更改'}
            </button>
          </footer>
        </>
      )}
      {!loading && (
        <footer className={css.footer} style={{ display: 'none' }} />
      )}
    </DialogShell>
  )
}

// ====== 批量索引 ======

const INDEX_TYPES = ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']

/** 索引行字段统一转字符串(MySQL 元数据字段均为字符串;缺省回退空串)。 */
function indexFieldText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 把服务器索引行分组折叠成索引编辑项(按 keyName 合并列)。 */
function indexesToEdits(list: Array<Record<string, unknown>>): IndexEdit[] {
  const groups = new Map<string, { nonUnique: number; indexType: string; columns: string[] }>()
  for (const row of list) {
    const name = indexFieldText(row.keyName)
    if (name === '') continue
    let group = groups.get(name)
    if (group === undefined) {
      group = { nonUnique: Number(row.nonUnique ?? 1), indexType: indexFieldText(row.indexType), columns: [] }
      groups.set(name, group)
    }
    group.columns.push(indexFieldText(row.columnName))
  }
  const out: IndexEdit[] = []
  for (const [name, info] of groups) {
    const colsStr = info.columns.join(', ')
    const unique = info.nonUnique === 0
    out.push({
      name,
      newName: name,
      columns: colsStr,
      newColumns: colsStr,
      unique,
      newUnique: unique,
      indexType: info.indexType || 'BTREE',
      newIndexType: info.indexType || 'BTREE',
      dirty: false,
      dropped: false,
      isNew: false,
    })
  }
  return out
}

/** 计算索引是否相对原始有变更。 */
function indexDirty(e: IndexEdit): boolean {
  return e.newName !== e.name ||
    e.newColumns !== e.columns ||
    e.newUnique !== e.unique ||
    e.newIndexType !== e.indexType
}

/**
 * 批量索引对话框:载入表索引与列名,批量编辑(改名/列/唯一/类型/删除),应用时经
 * generateBatchIndexDDL 生成 DROP + CREATE 语句逐条执行。
 * @param connId - 连接 id。
 * @param database - 库名。
 * @param table - 表名。
 * @param onClose - 关闭回调。
 */
export function IndexListDialog({ connId, database, table, onClose }: {
  connId: string
  database: string
  table: string
  onClose: () => void
}) {
  const [edits, setEdits] = useState<IndexEdit[]>([])
  const [tableColumns, setTableColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [newIdx, setNewIdx] = useState({ name: '', columns: '', unique: false, indexType: 'BTREE' })

  useEffect(() => {
    let cancelled = false
    const base = { connId, table, database }
    void Promise.all([
      tauriInvoke<Array<Record<string, unknown>>>('db_mysql_list_indexes', base),
      tauriInvoke<ColumnMeta[]>('db_mysql_list_columns', base),
    ])
      .then(([idxRows, colRows]) => {
        if (cancelled) return
        setEdits(indexesToEdits(idxRows))
        setTableColumns(colRows.map(c => c.name))
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!cancelled) { setError(errorText(e)); setLoading(false) }
      })
    return () => { cancelled = true }
  }, [connId, table, database])

  const filtered = useMemo(() => {
    if (!search) return edits
    const q = search.toLowerCase()
    return edits.filter(e => e.name.toLowerCase().includes(q))
  }, [edits, search])

  const updateEdit = (idx: number, patch: Partial<IndexEdit>) => {
    setEdits(prev => prev.map((e, i) => {
      if (i !== idx) return e
      const next = { ...e, ...patch }
      next.dirty = indexDirty(next)
      return next
    }))
  }
  const toggleDrop = (idx: number) => {
    setEdits(prev => prev.map((e, i) => (i === idx ? { ...e, dropped: !e.dropped, dirty: true } : e)))
  }
  const resetEdit = (idx: number) => {
    setEdits(prev => prev.map((e, i) => {
      if (i !== idx) return e
      return { ...e, newName: e.name, newColumns: e.columns, newUnique: e.unique, newIndexType: e.indexType, dropped: false, dirty: false }
    }))
  }
  const addNewIdx = () => {
    const name = newIdx.name.trim()
    const cols = newIdx.columns.trim()
    if (!name || !cols) return
    setEdits(prev => [...prev, {
      name, newName: name, columns: cols, newColumns: cols,
      unique: newIdx.unique, newUnique: newIdx.unique,
      indexType: newIdx.indexType, newIndexType: newIdx.indexType,
      dirty: true, dropped: false, isNew: true,
    }])
    setNewIdx({ name: '', columns: '', unique: false, indexType: 'BTREE' })
  }

  const applyChanges = async () => {
    const ddls = generateBatchIndexDDL(database, table, edits)
    if (ddls.length === 0) return
    setExecuting(true)
    setError(null)
    setSuccess(null)
    try {
      for (const ddl of ddls) await execDdl(connId, ddl, database, 'mysql')
      setSuccess(`Applied ${ddls.length} DDL statement(s)`)
      const idxRows = await tauriInvoke<Array<Record<string, unknown>>>('db_mysql_list_indexes', { connId, table, database })
      setEdits(indexesToEdits(idxRows))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExecuting(false)
    }
  }

  return (
    <DialogShell title={`${database}.${table}`} subtitle={`${edits.length} indexes · ${tableColumns.length} columns`} wide onClose={onClose}>
      <div className={css.searchRow}>
        <input className={css.input} value={search} onChange={(e) =>{  setSearch(e.target.value) }} placeholder="搜索索引名…" />
      </div>
      {loading && <div className={css.loading}>加载索引…</div>}
      {!loading && error !== null && <div className={css.error}>{error}</div>}
      {!loading && success !== null && <div className={css.success}>{success}</div>}

      {!loading && (
        <>
          <div className={css.body} style={{ padding: 0 }}>
            <table className={css.structTable}>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>#</th>
                  <th>索引名</th><th>列</th><th style={{ width: 56 }}>UNIQUE</th>
                  <th style={{ width: 90 }}>类型</th><th style={{ width: 74 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, idx) => (
                  <tr key={`${e.name}-${idx}`} className={`${e.dirty && !e.dropped ? css.dirty : ''} ${e.dropped ? css.dropped : ''}`}>
                    <td className={css.tdIdx}>{idx + 1}</td>
                    <td>
                      <input
                        className={css.cellInput} value={e.newName}
                        onChange={(ev) =>{  updateEdit(idx, { newName: ev.target.value }) }}
                      />
                    </td>
                    <td>
                      <input className={css.cellInput} list="idx-col-list" value={e.newColumns} onChange={(ev) =>{  updateEdit(idx, { newColumns: ev.target.value }) }} placeholder="col1, col2" />
                    </td>
                    <td className={css.tdCenter}><input type="checkbox" checked={e.newUnique} onChange={(ev) =>{  updateEdit(idx, { newUnique: ev.target.checked }) }} /></td>
                    <td>
                      <select
                        className={css.cellInput} value={e.newIndexType}
                        onChange={(ev) =>{  updateEdit(idx, { newIndexType: ev.target.value }) }}
                      >
                        {INDEX_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className={css.tdActions}>
                      <button type="button" className={`${css.smallBtn} ${e.dropped ? css.active : ''}`} onClick={() =>{  toggleDrop(idx) }} title="删除">×</button>
                      {e.dirty && !e.dropped && <button type="button" className={css.smallBtn} onClick={() =>{  resetEdit(idx) }} title="重置">↺</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="idx-col-list">
              {tableColumns.map(c => <option key={c} value={c} />)}
            </datalist>
            <div className={css.addRow}>
              <input className={css.cellInput} style={{ width: 110 }} value={newIdx.name} onChange={(e) =>{  setNewIdx({ ...newIdx, name: e.target.value }) }} placeholder="新索引名" />
              <input className={css.cellInput} style={{ width: 160 }} list="idx-col-list" value={newIdx.columns} onChange={(e) =>{  setNewIdx({ ...newIdx, columns: e.target.value }) }} placeholder="col1, col2" />
              <label className={css.muted} style={{ display: 'flex', alignItems: 'center', gap: 4, backgroundColor: 'transparent' }}>
                <input type="checkbox" checked={newIdx.unique} onChange={(e) =>{  setNewIdx({ ...newIdx, unique: e.target.checked }) }} /> UNIQUE
              </label>
              <select
                className={css.cellInput} style={{ width: 84 }} value={newIdx.indexType}
                onChange={(e) =>{  setNewIdx({ ...newIdx, indexType: e.target.value }) }}
              >
                {INDEX_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className={css.btnSecondary} onClick={addNewIdx}>+ 新增</button>
            </div>
          </div>
          <footer className={css.footer}>
            <button className={css.btnSecondary} onClick={onClose}>取消</button>
            <button className={css.btnPrimary} disabled={executing} onClick={() => void applyChanges()}>
              {executing ? '应用中…' : '应用更改'}
            </button>
          </footer>
        </>
      )}
    </DialogShell>
  )
}

/** 对话框外壳:标题栏 + 可滚动 body + 底部操作区。 */
function DialogShell({ title, subtitle, wide, onClose, children }: {
  title: string
  subtitle?: string
  wide?: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`${css.panel} ${wide ? css.panelWide : ''}`}>
        <header className={css.header}>
          <span className={css.title}>{title}</span>
          {subtitle !== undefined && <span className={css.subtitle}>{subtitle}</span>}
          <span className={css.spacer} />
          <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
        </header>
        <div className={css.body}>{children}</div>
      </div>
    </div>
  )
}

export default NewTableDialog
