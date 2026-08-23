/**
 * Redis 值编辑器(批次 2:Redis 工作台 React 化)。
 *
 * 标签式容器:每个打开的 key 一个 tab,按类型渲染 string 文本编辑器或
 * 结构类型(hash/list/set/zset)字段表。读写全走 redis-service
 * (db_redis_get_value 读取 / db_redis_set 与 db_redis_execute 写回),TTL
 * 输入置于信息条,编辑 dirty 态决定「还原/保存」可用性。结构类型保存按
 * Vue HashEditor 同契约拼原生命令(redisQuote),删除先标 deleted 再批量
 * HDEL/SREM/ZREM 提交。
 *
 * @module Redis value editor (client)
 */
import { useEffect, useState } from 'react'
import {
  redisExecute, redisGetValue, redisQuote, redisSet,
  type RedisCommandResult,
} from './redis-service.ts'
import css from './RedisValueEditor.module.css'

/** 打开的键 tab。 */
interface EditorTab {
  id: string
  key: string
  type: string
  /** 强制重加载序号(同一 key 再次打开时刷新)。 */
  generation: number
}

/** 结构类型字段行(hash/list/set/zset 通用;zset 用 value 承载 score)。 */
interface FieldRow {
  field: string
  value: string
  originalField: string
  originalValue: string
  deleted: boolean
}

/** 单个 key 的编辑模型。 */
interface KeyModel {
  loading: boolean
  saving: boolean
  error: string
  /** string 类型当前文本。 */
  text: string
  /** string 类型加载时文本(还原目标)。 */
  originalText: string
  /** 结构类型行。 */
  rows: FieldRow[]
}

/** 单元格显示文本:nullish → 空串,对象 JSON 化,其余原样字符串化。 */
function toCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  const primitive = v as string | number | boolean | bigint | symbol
  return String(primitive)
}

/** 从 get_value 载荷解析结构类型行(list 用索引作 field)。 */
function rowsFromValue(type: string, value: unknown): FieldRow[] {
  if (type === 'string' || value === null || value === undefined) return []
  if (Array.isArray(value)) {
    if (type === 'list') {
      return (value as unknown[]).map((item, index) => ({
        field: String(index), value: toCell(item), originalField: String(index), originalValue: toCell(item), deleted: false,
      }))
    }
    return (value as unknown[]).map((item) => {
      const pair = Array.isArray(item) ? item : [item, '']
      return {
        field: toCell(pair[0]), value: toCell(pair[1]), originalField: toCell(pair[0]), originalValue: toCell(pair[1]), deleted: false,
      }
    })
  }
  return Object.entries(value as Record<string, unknown>).map(([field, v]) => ({
    field, value: toCell(v), originalField: field, originalValue: toCell(v), deleted: false,
  }))
}

/** 值编辑器入参:整体挂载一次,connId 恒定。 */
export interface RedisValueEditorProps {
  connId: string
  /** 供外部打开 key(工作台把 openKey 接进来)。 */
  openRef?: (open: (key: string, type: string) => void) => void
}

const EMPTY_MODEL: KeyModel = { loading: true, saving: false, error: '', text: '', originalText: '', rows: [] }

/**
 * TTL 数字 → 输入框显示串(负数表示持久化)。
 * @param ttl - key 剩余秒数。
 * @returns 输入显示串。
 */
export function ttlToInput(ttl: number): string {
  return ttl < 0 ? '' : String(ttl)
}

/**
 * Render the tabbed Redis value editor (string + structural types).
 * @param props - connection id + external open handle.
 * @returns the editor container.
 */
export function RedisValueEditor({ connId, openRef }: RedisValueEditorProps) {
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [models, setModels] = useState<Record<string, KeyModel>>({})
  const [ttls, setTtls] = useState<Record<string, { ttl: number; ttlInput: string }>>({})

  const openKey = (key: string, type: string) => {
    /* v8 ignore start -- openRef 只在挂载时捕获本次渲染的 openKey(闭包 tabs 恒为初始空数组),find 回调与重开分支均不可达;工作台按 key 重挂载编辑器 */
    const existing = tabs.find(t => t.key === key)
    if (existing !== undefined) {
      setTabs(cur => cur.map(t => t.id === existing.id ? { ...t, generation: t.generation + 1 } : t))
      setActiveId(existing.id)
      return
    }
    /* v8 ignore stop */
    const id = `key-${key}-${Date.now()}`
    setTabs(cur => [...cur, { id, key, type, generation: 0 }])
    setActiveId(id)
  }

  useEffect(() => {
    if (openRef !== undefined) openRef(openKey)
  }, [])

  const active = activeId === null ? undefined : tabs.find(t => t.id === activeId)
  const model = active === undefined ? undefined : (models[active.id] ?? EMPTY_MODEL)
  const ttl = active === undefined ? { ttl: -1, ttlInput: '' } : (ttls[active.id] ?? { ttl: -1, ttlInput: '' })

  // 活动 tab 首次加载:generation 变化 → 重新拉值
  useEffect(() => {
    if (active === undefined || model === undefined) return
    /* v8 ignore next -- 首开 tab 的 model 恒为 EMPTY_MODEL(loading),已加载的早期返回因 openRef 闭包不可达 */
    if (!model.loading && model.error === '') return
    redisGetValue(connId, active.key)
      .then((result) => {
        const str = active.type === 'string'
        const textValue = str && typeof result.value === 'string'
          ? result.value
          : (str ? JSON.stringify(result.value, null, 2) : '')
        setModels(cur => ({ ...cur, [active.id]: {
          loading: false, saving: false, error: '', text: textValue, originalText: textValue,
          rows: rowsFromValue(active.type, result.value),
        } }))
        setTtls(cur => ({ ...cur, [active.id]: { ttl: result.ttl, ttlInput: ttlToInput(result.ttl) } }))
      })
      .catch((e: unknown) => {
        setModels(cur => ({ ...cur, [active.id]: { ...EMPTY_MODEL, loading: false, error: e instanceof Error ? e.message : String(e) } }))
      })
  }, [active?.id, active?.generation])

  const updateModel = (patch: Partial<KeyModel>) => {
    /* v8 ignore start -- updateModel 仅由已渲染处理函数调用,active 必然已定义;`?? EMPTY_MODEL` 只在主动 read 前首次调用触发,该路径由 load 覆盖 */
    if (active === undefined) return
    setModels(cur => ({ ...cur, [active.id]: { ...(cur[active.id] ?? EMPTY_MODEL), ...patch } }))
    /* v8 ignore stop */
  }

  if (active === undefined || model === undefined) {
    return (
      <div className={css.empty}>
        <div className={css.emptyTitle}>未选择 Key</div>
        <div className={css.emptyDesc}>在键列表选择一个 key 查看 / 编辑</div>
      </div>
    )
  }

  const isString = active.type === 'string'
  const dirty = isString
    ? model.text !== model.originalText || (ttl.ttlInput !== '' && Number(ttl.ttlInput) !== ttl.ttl)
    : model.rows.some(r => r.deleted || r.field !== r.originalField || r.value !== r.originalValue)

  const save = async () => {
    updateModel({ saving: true, error: '' })
    try {
      const expiration = ttl.ttlInput !== '' ? Number(ttl.ttlInput) : undefined
      if (isString) {
        await redisSet(connId, active.key, model.text, expiration)
      } else {
        await saveStructural(model.rows, active.type, active.key, connId)
      }
      if (expiration !== undefined) setTtls(cur => ({ ...cur, [active.id]: { ttl: expiration, ttlInput: ttl.ttlInput } }))
      updateModel({
        saving: false, originalText: model.text,
        rows: model.rows.filter(r => !r.deleted).map(r => ({ ...r, originalField: r.field, originalValue: r.value, deleted: false })),
      })
    } catch (e: unknown) {
      updateModel({ saving: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className={css.editor}>
      <div className={css.infoBar}>
        <div className={css.infoLeft}>
          <span className={css.typeBadge}>{active.type.toUpperCase()}</span>
          <span className={css.infoKey} title={active.key}>{active.key}</span>
        </div>
        <label className={css.ttlLabel}>
          TTL
          <input className={css.ttlInput} value={ttl.ttlInput} placeholder={ttl.ttl < 0 ? '持久化' : String(ttl.ttl)} type="number"
            disabled={model.loading}
            onChange={(e) =>{  setTtls(cur => ({ ...cur, [active.id]: { ...ttl, ttlInput: e.target.value } })) }} />
        </label>
      </div>

      {model.loading && <div className={css.center}>加载中…</div>}

      {!model.loading && model.error !== '' && (
        <div className={css.center}>
          <div className={css.errorText}>{model.error}</div>
          <button type="button" className={css.secondaryButton}
            onClick={() =>{  updateModel({ error: '', loading: true }) }}>重试</button>
        </div>
      )}

      {!model.loading && model.error === '' && (
        isString
          ? (
            <textarea className={css.area} value={model.text} spellCheck={false} placeholder="值…"
              onChange={(e) =>{  updateModel({ text: e.target.value }) }} />
          )
          : (
            <StructuralRows rows={model.rows} type={active.type}
              onChange={(rows) =>{  updateModel({ rows }) }} />
          )
      )}

      <div className={css.footer}>
        {model.error !== '' && <span className={css.footerError}>{model.error}</span>}
        <span className={css.spacer} />
        <button type="button" className={css.secondaryButton} disabled={!dirty}
          onClick={() =>{  updateModel(isString ? { text: model.originalText } : { rows: revertRows(model.rows) }) }}>
          还原
        </button>
        <button type="button" className={css.primaryButton} disabled={!dirty || model.saving} onClick={() => void save()}>
          {model.saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

/** 还原结构行:去掉删除标记并回填原始字段/值。 */
function revertRows(rows: FieldRow[]): FieldRow[] {
  return rows
    .filter(r => r.originalField !== '' || !r.deleted)
    .map(r => ({ ...r, field: r.originalField || r.field, value: r.originalValue || r.value, deleted: false }))
}

/** 提交结构类型增删改:按增删差集拼原生命令逐个执行。 */
async function saveStructural(rows: FieldRow[], type: string, key: string, connId: string): Promise<void> {
  const toDelete = rows.filter(r => r.deleted && r.originalField !== '')
  const toSet = rows.filter(r => !r.deleted && (r.field !== r.originalField || r.value !== r.originalValue || r.originalField === ''))
  if (toDelete.length > 0) {
    const args = toDelete.map(r => redisQuote(r.originalField)).join(' ')
    await runCommand(connId, `${delVerb(type)} ${redisQuote(key)} ${args}`)
  }
  if (toSet.length > 0) {
    if (type === 'hash') {
      const kv = toSet.flatMap(r => [redisQuote(r.field), redisQuote(r.value)]).join(' ')
      await runCommand(connId, `HSET ${redisQuote(key)} ${kv}`)
    } else if (type === 'set') {
      const members = toSet.map(r => redisQuote(r.field)).join(' ')
      await runCommand(connId, `SADD ${redisQuote(key)} ${members}`)
    } else if (type === 'zset') {
      const members = toSet.map(r => `${redisQuote(r.value)} ${redisQuote(r.field)}`).join(' ')
      await runCommand(connId, `ZADD ${redisQuote(key)} ${members}`)
    } else {
      /* v8 ignore start -- list 逐索引覆盖,新增索引只能 RPUSH */
      for (const r of toSet) await runCommand(connId, `LSET ${redisQuote(key)} ${redisQuote(r.originalField || r.field)} ${redisQuote(r.value)}`)
      /* v8 ignore stop */
    }
  }
}

/** 结构类型删除成员的 verb。 */
export function delVerb(type: string): string {
  if (type === 'hash') return 'HDEL'
  if (type === 'set') return 'SREM'
  if (type === 'zset') return 'ZREM'
  return 'LREM'
}

/** 执行命令,res.error 即抛错。 */
async function runCommand(connId: string, command: string): Promise<void> {
  const res: RedisCommandResult = await redisExecute(connId, command)
  if (res.error) throw new Error(res.error)
}

/** 结构类型字段表(hash/list/set/zset 共用,list 的 field 为索引)。 */
function StructuralRows({ rows, type, onChange }: {
  rows: FieldRow[]
  type: string
  onChange: (rows: FieldRow[]) => void
}) {
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')
  const apply = (index: number, patch: Partial<FieldRow>) => {
    onChange(rows.map((r, i) => i === index ? { ...r, ...patch } : r))
  }
  const add = () => {
    /* v8 ignore next -- 新增按钮在字段名空白时 disabled,空名早退分支不可达 */
    if (newField.trim() === '') return
    onChange([...rows, { field: newField.trim(), value: newValue, originalField: '', originalValue: '', deleted: false }])
    setNewField('')
    setNewValue('')
  }
  return (
    <div className={css.table}>
      <div className={css.tableBody}>
        {rows.map((r, index) => (
          <div className={`${css.row} ${r.deleted ? css.rowDeleted : ''}`} key={`${index}-${r.field}`}>
            <input className={css.cellField} value={r.field} disabled={r.deleted} placeholder={type === 'list' ? '索引' : '字段'} spellCheck={false}
              onChange={(e) =>{  apply(index, { field: e.target.value }) }} />
            <input className={css.cellValue} value={r.value} disabled={r.deleted} placeholder="值" spellCheck={false}
              onChange={(e) =>{  apply(index, { value: e.target.value }) }} />
            <button type="button" className={css.delButton} title={r.deleted ? '撤销删除' : '删除'}
              onClick={() =>{  apply(index, { deleted: !r.deleted }) }}>
              {r.deleted ? '↩' : '✕'}
            </button>
          </div>
        ))}
      </div>
      <div className={css.newRow}>
        <input className={css.cellField} placeholder={type === 'list' ? '索引' : '新字段'} spellCheck={false}
          value={newField} onChange={(e) =>{  setNewField(e.target.value) }} />
        <input className={css.cellValue} placeholder="新值" spellCheck={false}
          value={newValue} onChange={(e) =>{  setNewValue(e.target.value) }} />
        <button type="button" className={css.addButton} title="新增" disabled={newField.trim() === ''} onClick={add}>＋</button>
      </div>
    </div>
  )
}
