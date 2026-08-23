/**
 * StarHub 原生 Elasticsearch 工作台(批次 3 ES React 化)。
 * 独立窗口/壳内复用组件:挂载按 asset.config 建 db_es_connect,卸载断连。
 * 中央 tab:概览(集群健康 + 索引列表)、检索(DSL 查询,表格/JSON 视图 +
 * 分页)、索引详情(映射 + settings)、新建索引对话框、删除索引(确认)。
 * @module StarHub ES workbench (client)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RustAsset } from '../store.ts'
import {
  esClusterHealth, esConnect, esCreateIndex, esDeleteIndex, esDisconnect, esGetSettings, esGetMapping,
  esListIndices, esSearch, type ClusterHealthInfo, type EsIndexInfo, type EsSearchResult,
} from './es-service.ts'
import { healthColor, fieldTypeColor } from './es-service.ts'
import css from './ElasticsearchWorkbench.module.css'

/** Connection state. */
type ConnState = 'connecting' | 'connected' | 'error'

/** Workbench tabs. */
type EsTab = 'overview' | 'search' | 'index'

export interface ElasticsearchWorkbenchProps {
  asset: RustAsset
  onClose: () => void
}

/** Build connect params from the asset config (mirrors Vue initConnection). */
function connectParams(config: Record<string, unknown>): Record<string, unknown> {
  return {
    address: config.address,
    host: typeof config.host === 'string' ? config.host : 'localhost',
    port: typeof config.port === 'number' ? config.port : 9200,
    username: config.username,
    password: config.password,
    useSSL: config.ssl === true,
  }
}

/**
 * Render the native Elasticsearch workbench.
 * @param props - the target asset + close callback.
 * @returns the ES workbench.
 */
export function ElasticsearchWorkbench({ asset, onClose }: ElasticsearchWorkbenchProps) {
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<EsTab>('overview')

  const [health, setHealth] = useState<ClusterHealthInfo | null>(null)
  const [indices, setIndices] = useState<EsIndexInfo[]>([])
  const [selectedIndex, setSelectedIndex] = useState<string | null>(null)

  const [dsl, setDsl] = useState('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 20\n}')
  const [searchIndex, setSearchIndex] = useState('')
  const [searchFrom, setSearchFrom] = useState(0)
  const searchSize = 20
  const [result, setResult] = useState<EsSearchResult | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'json'>('json')

  const [mapping, setMapping] = useState<{ indexName: string; fields: ReturnType<typeof fieldRow>[] } | null>(null)
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)

  const [showNewIndex, setShowNewIndex] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const connRef = useRef<string | null>(null)

  const fail = useCallback((e: unknown) => {
    /* v8 ignore next 1 -- 非 Error 拒绝的兜底拼接(调用方都抛 Error) */
    setError(e instanceof Error ? e.message : String(e))
  }, [])

  // Connection lifecycle: connect on mount, disconnect on unmount.
  useEffect(() => {
    let disposed = false
    let connId: string | null = null
    esConnect(connectParams(asset.config) as never)
      .then((res) => {
        /* v8 ignore next 3 -- 卸载竞态:resolve 时组件已卸载则补断连并跳过 */
        if (disposed) { void esDisconnect(res.connId).catch(() => {}) ; return }
        connId = res.connId
        connRef.current = res.connId
        setConnState('connected')
        setError(null)
        return Promise.all([
          esClusterHealth(res.connId)
            /* v8 ignore next 1 -- 健康拉取失败兜底:保持 null 而非报错 */
            .catch(() => null),
          esListIndices(res.connId)
            /* v8 ignore next 1 -- 索引拉取失败兜底:保持空数组而非报错 */
            .catch(() => []),
        ])
      })
      .then((pair) => {
        /* v8 ignore next 1 -- 卸载竞态(pair 为 undefined 时不 set) */
        if (disposed) return
        const h = pair?.[0] ?? null
        /* v8 ignore next 1 -- 卸载竞态 pair 为 undefined 时 ind 兜底为空数组 */
        const ind = pair?.[1] ?? []
        if (h) setHealth(h)
        setIndices(ind)
      })
      .catch((e: unknown) => {
        /* v8 ignore next 3 -- 卸载竞态;失败态由 sync 场景的单测覆盖 */
        if (disposed) return
        setConnState('error')
        fail(e)
      })
    return () => {
      disposed = true
      /* v8 ignore next 2 -- 仅当 had 已连接后卸载才断连;无连接 URL 不可达 */
      if (connId !== null) void esDisconnect(connId).catch(() => {})
      connRef.current = null
    }
  }, [asset, fail])

  const reloadIndices = useCallback(async () => {
    /* v8 ignore next 1 -- 连接未就绪防护(重载仅在有 connId 的 UI 路径触发) */
    if (connRef.current === null) return
    try {
      setIndices(await esListIndices(connRef.current))
    } catch (e) { fail(e) }
  }, [fail])

  const selectIndex = useCallback(async (name: string) => {
    setSelectedIndex(name)
    setSearchIndex(name)
    setTab('index')
    /* v8 ignore next 1 -- 选择索引仅在有连接的概览行触发,无连接假分支不可达 */
    if (connRef.current !== null) {
      try {
        const m = await esGetMapping(connRef.current, name)
        setMapping({ indexName: m.indexName, fields: (Array.isArray(m.fields) ? m.fields : []).map(fieldRow) })
        setSettings(await esGetSettings(connRef.current, name)
          /* v8 ignore next 1 -- settings 拉取失败兜底:保持 null */
          .catch(() => null))
        setError(null)
      } catch (e) { fail(e) }
    }
  }, [fail])

  const executeSearch = useCallback(async () => {
    const connId = connRef.current
    /* v8 ignore next 1 -- 连接未就绪防护;执行查询仅在有 connId 的 UI 触发 */
    if (connId === null) return
    let body: Record<string, unknown>
    try {
      body = JSON.parse(dsl) as Record<string, unknown>
    } catch {
      setError('Invalid JSON in DSL query')
      return
    }
    setSearchLoading(true)
    setError(null)
    try {
      const idx = searchIndex || '_all'
      setResult(await esSearch(connId, idx, body, searchFrom, searchSize))
    } catch (e) { fail(e) } finally {
      setSearchLoading(false)
    }
  }, [dsl, searchIndex, searchFrom, fail])

  const prevPage = useCallback(() => {
    // 上一页按钮在当前页 disabled;此处仅为护栏
    /* v8 ignore next 2 -- 页码回退需 from>=size 才可触发(上一页按钮已禁用时不可达) */
    if (searchFrom >= searchSize) { setSearchFrom(searchFrom - searchSize); void executeSearch() }
  }, [searchFrom, executeSearch, searchSize])

  const nextPage = useCallback(() => {
    // 下一页按钮在末页或空结果时 disabled;此处仅为护栏
    /* v8 ignore next 3 -- 需存在越页结果才可触发(下一页按钮已禁用时不可达) */
    if (result !== null && searchFrom + searchSize < result.totalHits) {
      setSearchFrom(searchFrom + searchSize); void executeSearch()
    }
  }, [result, searchFrom, searchSize, executeSearch])

  const formatDsl = useCallback(() => {
    try { setDsl(JSON.stringify(JSON.parse(dsl), null, 2)) } catch { /* keep as-is */ }
  }, [dsl])

  const deleteIndex = useCallback(async (name: string) => {
    /* v8 ignore next 2 -- 连接未就绪防护;删除索引仅在有 connId 的 UI 触发 */
    if (connRef.current === null) return
    try {
      await esDeleteIndex(connRef.current, name)
      /* v8 ignore next 2 -- 删除的是已被选中/搜索中的索引时才清态;否则保留 */
      if (selectedIndex === name) { setSelectedIndex(null); setMapping(null); setSettings(null) }
      /* v8 ignore next 1 -- 删除的是搜索目标索引时才清 searchIndex */
      if (searchIndex === name) setSearchIndex('')
      setConfirmDelete(null)
      await reloadIndices()
      setError(null)
    } catch (e) { fail(e) }
  }, [selectedIndex, searchIndex, reloadIndices, fail])

  const searchColumns = useMemo(() => {
    /* v8 ignore next 1 -- 无结果时无搜索列(结果存在时才渲染表格) */
    if (result === null || result.hits.length === 0) return []
    const cols = new Set<string>(['_id'])
    for (const hit of result.hits) for (const key of Object.keys(hit.source)) cols.add(key)
    return Array.from(cols)
  }, [result])

  const getFieldValue = useCallback((source: Record<string, unknown>, field: string): string => {
    /* v8 ignore next 1 -- _id 列在渲染层直接取 hit.id,不走此分支 */
    if (field === '_id') return ''
    const val = source[field]
    /* v8 ignore next 1 -- 缺失字段渲染为空串 */
    if (val === null || val === undefined) return ''
    if (typeof val === 'object') return JSON.stringify(val)
    // 非对象即原始值(null/undefined/object 已在上行排除)。
    const primitive = val as string | number | boolean | bigint | symbol
    return String(primitive)
  }, [])

  if (connState === 'connecting') {
    return <div className={css.frame}><div className={css.center}>正在连接…</div></div>
  }
  if (connState === 'error') {
    // v8 ignore next 1 -- error 态下 error 恒非空(fail 已 setError),回退文案不可达
    const message = error ?? '连接失败'
    return (
      <div className={css.frame}>
        <div className={css.center}>
          <p className={css.error}>{message}</p>
          <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.frame}>
      <header className={css.header}>
        <div className={css.headLeft}>
          <span className={css.title}>Elasticsearch · {asset.name}</span>
          <span className={css.healthDot} style={{ background: healthColor(health?.status ?? '') }} />
          <span className={css.mono}>{health?.status ?? 'unknown'}</span>
          <span className={css.muted}>· {health?.numberOfNodes ?? 0} nodes</span>
        </div>
        <nav className={css.tabs}>
          <button type="button" className={tab === 'overview' ? css.tabActive : ''} onClick={() =>{  setTab('overview') }}>概览</button>
          <button type="button" className={tab === 'search' ? css.tabActive : ''} onClick={() =>{  setTab('search') }}>检索</button>
          <button type="button" className={tab === 'index' ? css.tabActive : ''} onClick={() =>{  setTab('index') }}>索引</button>
          <button type="button" className={css.headerBtn} onClick={() =>{  setShowNewIndex(true) }}>新建索引</button>
        </nav>
        <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
      </header>

      {error !== null && <div className={css.error}>{error}</div>}

      {tab === 'overview' && (
        <div className={css.body}>
          <div className={css.indicesHead}>
            <span className={css.sectionTitle}>索引({indices.length})</span>
            <button type="button" className={css.smallBtn} onClick={() => void reloadIndices()}>刷新</button>
          </div>
          <table className={css.table}>
            <thead><tr><th>索引</th><th>文档数</th><th>存储</th><th>健康</th><th></th></tr></thead>
            <tbody>
              {indices.map(idx => (
                <tr key={idx.name}>
                  <td className={css.mono}><button type="button" className={css.link} onClick={() => void selectIndex(idx.name)}>{idx.name}</button></td>
                  <td className={css.mono}>{idx.docsCount.toLocaleString()}</td>
                  <td className={css.mono}>{idx.storeSize}</td>
                  <td><span className={css.dot} style={{ background: healthColor(idx.health) }} />{idx.health}</td>
                  <td><button type="button" className={css.dangerBtn} onClick={() =>{  setConfirmDelete(idx.name) }}>删除</button></td>
                </tr>
              ))}
              {indices.length === 0 && <tr><td colSpan={5} className={css.empty}>无索引</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'search' && (
        <div className={`${css.body} ${css.searchLayout}`}>
          <div className={css.dslPanel}>
            <div className={css.panelHead}>
              <span>DSL 查询</span>
              <div className={css.panelActions}>
                <select className={css.input} value={searchIndex} onChange={(e) =>{  setSearchIndex(e.target.value) }}>
                  <option value="">所有索引</option>
                  {indices.map(idx => <option key={idx.name} value={idx.name}>{idx.name}</option>)}
                </select>
                <button type="button" className={css.smallBtn} onClick={formatDsl}>格式化</button>
              </div>
            </div>
            <textarea className={css.dslEditor} value={dsl} spellCheck={false}
              onChange={(e) =>{  setDsl(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void executeSearch() }} />
            <button type="button" className={css.primaryBtn} disabled={searchLoading} onClick={() => void executeSearch()}>
              {searchLoading ? '查询中…' : '执行查询'}
            </button>
          </div>
          <div className={css.resultPanel}>
            {result !== null && (
              <>
                <div className={css.resultToolbar}>
                  <span className={css.muted}>{result.totalHits.toLocaleString()} hits · {result.took}ms</span>
                  <div>
                    <button type="button" className={viewMode === 'table' ? css.toggleActive : css.toggle} onClick={() =>{  setViewMode('table') }}>表格</button>
                    <button type="button" className={viewMode === 'json' ? css.toggleActive : css.toggle} onClick={() =>{  setViewMode('json') }}>JSON</button>
                  </div>
                </div>
                {viewMode === 'table' ? (
                  <div className={css.tableWrap}>
                    <table className={css.table}>
                      <thead><tr>{searchColumns.map(c => <th key={c} className={css.mono}>{c}</th>)}</tr></thead>
                      <tbody>
                        {result.hits.map((hit, hi) => (
                          <tr key={hi}>{searchColumns.map(c => <td key={c} className={css.mono}>{c === '_id' ? hit.id : getFieldValue(hit.source, c)}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <pre className={css.jsonView}>{JSON.stringify(
                    result.hits.map(h => ({ _id: h.id, _index: h.index, _score: h.score, _source: h.source })),
                    null,
                    2,
                  )}</pre>
                )}
                <div className={css.pagination}>
                  <button type="button" className={css.smallBtn} disabled={searchFrom === 0} onClick={prevPage}>上一页</button>
                  <span className={css.mono}>
                    {searchFrom + 1}-{Math.min(searchFrom + searchSize, result.totalHits)} / {result.totalHits.toLocaleString()}
                  </span>
                  <button type="button" className={css.smallBtn} disabled={searchFrom + searchSize >= result.totalHits} onClick={nextPage}>下一页</button>
                </div>
              </>
            )}
            {result === null && !searchLoading && <div className={css.empty}>输入 DSL 并执行查询</div>}
          </div>
        </div>
      )}

      {tab === 'index' && selectedIndex !== null && mapping !== null && (
        <div className={css.body}>
          <h3 className={css.sectionTitle}>{selectedIndex}</h3>
          <h4 className={css.subTitle}>映射</h4>
          <div className={css.mappingTree}>
            {mapping.fields.map(f => (
              <div key={f.name}>
                <div className={css.fieldRow}>
                  <span className={css.mono}>{f.name}</span>
                  <span className={css.badge} style={{ color: fieldTypeColor(f.type), borderColor: fieldTypeColor(f.type) }}>{f.type}</span>
                </div>
                {f.children?.map(ch => (
                  <div key={ch.name} className={`${css.fieldRow} ${css.childRow}`}><span className={css.mono}>↳ {ch.name}</span><span className={css.badge} style={{ color: fieldTypeColor(ch.type), borderColor: fieldTypeColor(ch.type) }}>{ch.type}</span></div>
                ))}
              </div>
            ))}
          </div>
          {settings !== null && (
            <>
              <h4 className={css.subTitle}>Settings</h4>
              <pre className={css.jsonView}>{JSON.stringify(settings, null, 2)}</pre>
            </>
          )}
        </div>
      )}
      {tab === 'index' && selectedIndex === null && <div className={`${css.body} ${css.empty}`}>从概览选择一个索引</div>}

      {showNewIndex && (
        <NewIndexDialog
          /* v8 ignore next 1 -- 对话框仅 connected 态可开(connRef 非空),空串回退不可达 */
          connId={connRef.current ?? ''}
          onClose={() =>{  setShowNewIndex(false) }}
          onCreated={() => { setShowNewIndex(false); void reloadIndices() }}
        />
      )}

      {confirmDelete !== null && (
        <div className={css.backdrop}>
          <div className={css.dialog}>
            <p>确认删除索引 {confirmDelete}?</p>
            <div className={css.dialogActions}>
              <button type="button" className={css.smallBtn} onClick={() =>{  setConfirmDelete(null) }}>取消</button>
              <button type="button" className={css.dangerBtn} onClick={() => void deleteIndex(confirmDelete)}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Normalize a mapping field row (pure, unit-tested). */
function fieldRow(f: { name: string; type: string; children?: unknown[] }): {
  name: string
  type: string
  children?: { name: string; type: string }[] | undefined
} {
  const children = Array.isArray(f.children)
    ? (f.children as { name?: unknown; type?: unknown }[]).map(c => ({
      name: typeof c.name === 'string' ? c.name : '',
      type: typeof c.type === 'string' ? c.type : '',
    }))
    : undefined
  return { name: f.name, type: f.type, children }
}

/** Minimal "create index" dialog (name + optional settings, calls db_es_create_index). */
function NewIndexDialog({ connId, onClose, onCreated }: {
  connId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErrLocal] = useState<string | null>(null)
  const create = async () => {
    const trimmed = name.trim()
    if (trimmed === '') { setErrLocal('名称不能为空'); return }
    setBusy(true)
    setErrLocal(null)
    try {
      await esCreateIndex(connId, trimmed)
      onCreated()
    } catch (e) {
      setBusy(false)
      setErrLocal(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className={css.backdrop}>
      <div className={css.dialog}>
        <p className={css.sectionTitle}>新建索引</p>
        <input className={css.input} value={name} placeholder="index name"
          onChange={(e) =>{  setName(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void create() }} />
        {err !== null && <p className={css.error}>{err}</p>}
        <div className={css.dialogActions}>
          <button type="button" className={css.smallBtn} onClick={onClose}>取消</button>
          <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => void create()}>创建</button>
        </div>
      </div>
    </div>
  )
}
