/**
 * Redis 值编辑器(v0.102.0 重构:受控 props 取代 openRef/tabs)。
 *
 * 工作台把「当前打开的 key」以 `redisKey` / `keyType` props 传入(并以
 * React key 强制按 key 重挂载),修复旧 openRef 只在挂载 effect 里捕获一次、
 * 切换 key 不生效的问题;旧的 tab/generation 模型(从未渲染 tab 栏)一并移除。
 *
 * 按类型渲染:string → 文本编辑器;hash/list/set/zset → 结构字段表
 * (hash 字段+值,list 索引+值,set 单成员列,zset 成员+分数)。读写全走
 * redis-service(db_redis_get_value 读取 / db_redis_set 与 db_redis_execute
 * 写回),TTL 输入置于信息条,dirty 态决定「还原/保存」可用性。结构类型保存
 * 按 Vue HashEditor 同契约拼原生命令(redisQuote);字段改名(set/zset/hash)
 * 现在先 DEL 旧成员再 ADD 新成员(旧版只增不删,改名会留下旧值);list 新增行
 * 走 RPUSH(旧版对空 originalField 也 LSET,越界必失败)。结构表带成员筛选框
 * (客户端子串过滤,仅影响展示,不影响保存的全量行)。
 *
 * @module Redis value editor (client)
 */
import { useEffect, useMemo, useState } from 'react'
import {
  redisExecute, redisGetValue, redisQuote, redisSet,
  type RedisCommandResult,
} from './redis-service.ts'
import css from './RedisValueEditor.module.css'

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

/** 值编辑器入参:工作台按当前打开的 key 传入,切换 key 时以 React key 重挂载。 */
export interface RedisValueEditorProps {
  connId: string
  /** 当前打开的完整 key 名。 */
  redisKey: string
  /** key 的 Redis 类型(string/hash/list/set/zset)。 */
  keyType: string
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

/** 结构类型字段占位符方案:set 单成员列;zset 成员+分数;list 索引+值;hash 字段+值。 */
export function fieldPlaceholders(type: string): { field: string; value: string; single: boolean } {
  if (type === 'set') return { field: '成员', value: '', single: true }
  if (type === 'zset') return { field: '成员', value: '分数', single: false }
  if (type === 'list') return { field: '索引', value: '值', single: false }
  return { field: '字段', value: '值', single: false }
}

/**
 * Render the Redis value editor for one key (string + structural types).
 * @param props - connection id + the open key and its type.
 * @returns the editor for the given key.
 */
export function RedisValueEditor({ connId, redisKey, keyType }: RedisValueEditorProps) {
  const [model, setModel] = useState<KeyModel>(EMPTY_MODEL)
  const [ttl, setTtl] = useState<{ ttl: number; ttlInput: string }>({ ttl: -1, ttlInput: '' })
  /** 重试序号:加载失败后 bump 触发重新拉取(旧版只置 loading,不重拉,会卡死在加载态)。 */
  const [generation, setGeneration] = useState(0)

  const isString = keyType === 'string'

  // key 切换(重挂载或 props 变化)/ 重试 → 重新拉值与 TTL。
  useEffect(() => {
    let cancelled = false
    setModel(EMPTY_MODEL)
    redisGetValue(connId, redisKey)
      .then((result) => {
        /* v8 ignore next -- 防御:key 快速切换卸载竞态,取消后丢弃过期响应 */
        if (cancelled) return
        const str = keyType === 'string'
        const textValue = str && typeof result.value === 'string'
          ? result.value
          : (str ? JSON.stringify(result.value, null, 2) : '')
        setModel({
          loading: false, saving: false, error: '', text: textValue, originalText: textValue,
          rows: rowsFromValue(keyType, result.value),
        })
        setTtl({ ttl: result.ttl, ttlInput: ttlToInput(result.ttl) })
      })
      .catch((e: unknown) => {
        /* v8 ignore next -- 防御:key 快速切换卸载竞态,取消后丢弃过期错误 */
        if (cancelled) return
        setModel({ ...EMPTY_MODEL, loading: false, error: e instanceof Error ? e.message : String(e) })
      })
    return () => { cancelled = true }
  }, [connId, redisKey, keyType, generation])

  const updateModel = (patch: Partial<KeyModel>): void => {
    setModel(cur => ({ ...cur, ...patch }))
  }

  const dirty = isString
    ? model.text !== model.originalText || (ttl.ttlInput !== '' && Number(ttl.ttlInput) !== ttl.ttl)
    : model.rows.some(r => r.deleted || r.field !== r.originalField || r.value !== r.originalValue)

  const save = async (): Promise<void> => {
    updateModel({ saving: true, error: '' })
    try {
      const expiration = ttl.ttlInput !== '' ? Number(ttl.ttlInput) : undefined
      if (isString) {
        await redisSet(connId, redisKey, model.text, expiration)
      } else {
        await saveStructural(model.rows, keyType, redisKey, connId)
      }
      if (expiration !== undefined) setTtl({ ttl: expiration, ttlInput: ttl.ttlInput })
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
          <span className={`${css.typeBadge} ${css[`type_${keyType}`] ?? ''}`}>{keyType.toUpperCase()}</span>
          <span className={css.infoKey} title={redisKey}>{redisKey}</span>
        </div>
        <label className={css.ttlLabel}>
          TTL
          <input className={css.ttlInput} value={ttl.ttlInput} placeholder={ttl.ttl < 0 ? '持久化' : String(ttl.ttl)} type="number"
            disabled={model.loading} aria-label="TTL 秒数"
            onChange={(e) =>{  setTtl(cur => ({ ...cur, ttlInput: e.target.value })) }} />
        </label>
      </div>

      {model.loading && <div className={css.center}>加载中…</div>}

      {!model.loading && model.error !== '' && (
        <div className={css.center}>
          <div className={css.errorText}>{model.error}</div>
          <button type="button" className={css.secondaryButton}
            onClick={() =>{  setGeneration(g => g + 1) }}>重试</button>
        </div>
      )}

      {!model.loading && model.error === '' && (
        isString
          ? (
            <textarea className={css.area} value={model.text} spellCheck={false} placeholder="值…"
              onChange={(e) =>{  updateModel({ text: e.target.value }) }} />
          )
          : (
            <StructuralRows rows={model.rows} type={keyType}
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

/** 提交结构类型增删改:删除(含改名旧成员)先按 verb 批量删,再按类型写回。 */
async function saveStructural(rows: FieldRow[], type: string, key: string, connId: string): Promise<void> {
  const toDelete = rows.filter(r => r.deleted && r.originalField !== '')
  const toSet = rows.filter(r => !r.deleted && (r.field !== r.originalField || r.value !== r.originalValue || r.originalField === ''))
  // 改名(list 除外,其 field 是索引)= 删旧成员 + 增新成员;旧版只增不删会残留旧值。
  const renamed = type === 'list' ? [] : toSet.filter(r => r.originalField !== '' && r.field !== r.originalField)
  const delTargets = [...toDelete.map(r => r.originalField), ...renamed.map(r => r.originalField)]
  if (delTargets.length > 0) {
    const args = delTargets.map(r => redisQuote(r)).join(' ')
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
      // list:既有行按原索引 LSET 覆盖;新增行(无原索引)只能 RPUSH 追加。
      for (const r of toSet) {
        if (r.originalField === '') await runCommand(connId, `RPUSH ${redisQuote(key)} ${redisQuote(r.value)}`)
        else await runCommand(connId, `LSET ${redisQuote(key)} ${redisQuote(r.originalField)} ${redisQuote(r.value)}`)
      }
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

/** 结构类型字段表(hash/list/set/zset 共用);带成员筛选(仅过滤展示,保存仍走全量行)。 */
function StructuralRows({ rows, type, onChange }: {
  rows: FieldRow[]
  type: string
  onChange: (rows: FieldRow[]) => void
}) {
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')
  const [filter, setFilter] = useState('')
  const ph = fieldPlaceholders(type)
  // 筛选只决定可见性:apply 用原始下标回写全量 rows,过滤态编辑不错位。
  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => term === '' || row.field.toLowerCase().includes(term) || row.value.toLowerCase().includes(term))
  }, [rows, filter])
  const apply = (index: number, patch: Partial<FieldRow>) => {
    onChange(rows.map((r, i) => i === index ? { ...r, ...patch } : r))
  }
  const add = () => {
    // 必填项:set/list 新增只有值输入;hash/zset 必须有字段(成员)名。
    const needed = ph.single || type === 'list' ? newValue.trim() : newField.trim()
    /* v8 ignore next -- 新增按钮在必填输入空白时 disabled,空名早退分支不可达 */
    if (needed === '') return
    // list 新增行只有值(RPUSH 追加,索引由服务端分配);set 单列成员;其余 field+value。
    const row: FieldRow = type === 'list'
      ? { field: '', value: newValue, originalField: '', originalValue: '', deleted: false }
      : ph.single
        ? { field: newValue.trim(), value: '', originalField: '', originalValue: '', deleted: false }
        : { field: newField.trim(), value: newValue, originalField: '', originalValue: '', deleted: false }
    onChange([...rows, row])
    setNewField('')
    setNewValue('')
  }
  const addDisabled = ph.single || type === 'list' ? newValue.trim() === '' : newField.trim() === ''
  return (
    <div className={css.table}>
      <div className={css.filterRow}>
        <input className={css.filterInput} value={filter} aria-label="筛选成员" spellCheck={false}
          placeholder={`筛选成员…(共 ${rows.length} 条)`}
          onChange={(e) =>{  setFilter(e.target.value) }} />
        {filter !== '' && (
          <button type="button" className={css.filterClear} aria-label="清除筛选" title="清除筛选"
            onClick={() =>{  setFilter('') }}>×</button>
        )}
      </div>
      <div className={css.tableBody}>
        {visible.map(({ row: r, index }) => (
          <div className={`${css.row} ${r.deleted ? css.rowDeleted : ''}`} key={`${index}-${r.originalField}`}>
            {type !== 'list' || r.originalField !== '' ? (
              ph.single ? (
                <input className={`${css.cellField} ${css.cellMember}`} value={r.field} disabled={r.deleted} placeholder={ph.field} spellCheck={false}
                  onChange={(e) =>{  apply(index, { field: e.target.value }) }} />
              ) : (
                <>
                  <input className={css.cellField} value={r.field} disabled={r.deleted || type === 'list'} placeholder={ph.field} spellCheck={false}
                    onChange={(e) =>{  apply(index, { field: e.target.value }) }} />
                  <input className={css.cellValue} value={r.value} disabled={r.deleted} placeholder={ph.value} spellCheck={false}
                    onChange={(e) =>{  apply(index, { value: e.target.value }) }} />
                </>
              )
            ) : (
              <input className={`${css.cellValue} ${css.cellMember}`} value={r.value} disabled={r.deleted} placeholder="值" spellCheck={false}
                onChange={(e) =>{  apply(index, { value: e.target.value }) }} />
            )}
            <button type="button" className={css.delButton} title={r.deleted ? '撤销删除' : '删除'}
              onClick={() =>{  apply(index, { deleted: !r.deleted }) }}>
              {r.deleted ? '↩' : '✕'}
            </button>
          </div>
        ))}
        {visible.length === 0 && (
          <div className={css.noMatch}>{rows.length === 0 ? '暂无成员' : '无匹配成员'}</div>
        )}
      </div>
      <div className={css.newRow}>
        {!(ph.single || type === 'list') && (
          <input className={css.cellField} placeholder={`新${ph.field}`} spellCheck={false} aria-label={`新${ph.field}`}
            value={newField} onChange={(e) =>{  setNewField(e.target.value) }} />
        )}
        <input className={css.cellValue} placeholder={ph.single ? '新成员' : type === 'list' ? '新值(RPUSH 追加)' : `新${ph.value}`}
          spellCheck={false} aria-label="新值"
          value={newValue} onChange={(e) =>{  setNewValue(e.target.value) }} />
        <button type="button" className={css.addButton} title="新增" aria-label="新增" disabled={addDisabled} onClick={add}>＋</button>
      </div>
    </div>
  )
}
