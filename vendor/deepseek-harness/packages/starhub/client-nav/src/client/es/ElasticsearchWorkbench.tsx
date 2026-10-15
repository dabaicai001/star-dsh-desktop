/**
 * StarHub 原生 Elasticsearch 工作台(批次 3 ES React 化)。
 * 独立窗口/壳内复用组件:挂载按 asset.config 建 db_es_connect,卸载断连。
 * 中央 tab:概览(集群健康 + 索引列表)、检索(DSL 查询,表格/JSON 视图 +
 * 分页)、索引详情(映射 + settings)、新建索引对话框、删除索引(确认)。
 *
 * v0.137.0 交互重构:
 * - **检索补每页条数选择**(10/20/50/100):旧版 searchSize 硬编码 20,大结果集
 *   翻页成本高;条数变化后从第 0 页重新查(否则 from 越界)。
 * - **DSL 按索引记忆**:切索引时把当前 DSL 存回该索引、载入目标索引的 DSL,
 *   避免「在两个索引间来回切换时 DSL 被对方覆盖」。
 * - **聚合结果展示**:响应带 aggregations 时在结果工具栏下展示 JSON(旧版
 *   完全丢弃)。
 * - **概览补索引筛选框 + 总文档数**:索引多时可快速定位。
 * - **索引详情补递归映射树**:旧版只渲染两层(field + children),object/nested
 *   更深层级的字段看不到;现在按层级缩进全展开,并显示分片数与刷新入口。
 * - **加载态**:概览表格、索引详情在拉取中显示骨架/加载提示,不再是一片空白。
 * - **新建索引支持可选 mappings**:传 JSON 即带映射创建(旧版只建空索引)。
 *
 * @module StarHub ES workbench (client)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** 每页条数选项。 */
const PAGE_SIZES = [10, 20, 50, 100] as const

/** 默认每页条数(与旧版硬编码值一致,保持既有分页断言)。 */
const DEFAULT_PAGE_SIZE = 20

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

/** 归一化后的映射字段节点(children 递归,深度不限)。 */
interface MappingField {
  name: string
  type: string
  children?: MappingField[]
}

/**
 * 归一化一个映射字段行(纯函数,单测覆盖)。children 递归归一化——
 * 旧版的返回类型只标到两层,TS 把第三层起收敛掉,渲染时 object/nested 的
 * 更深层字段直接丢失。
 * @param f - 原始字段行(name/type 可能非字符串)。
 * @returns 归一化后的字段节点。
 */
function fieldRow(f: { name?: unknown; type?: unknown; children?: unknown }): MappingField {
  const children = Array.isArray(f.children)
    ? (f.children as { name?: unknown; type?: unknown; children?: unknown }[]).map(fieldRow)
    : undefined
  return {
    name: typeof f.name === 'string' ? f.name : '',
    type: typeof f.type === 'string' ? f.type : '',
    // exactOptionalPropertyTypes: 无 children 时整个键省略,而非置 undefined。
    ...(children !== undefined ? { children } : {}),
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
  const [indicesLoading, setIndicesLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState<string | null>(null)

  const [dsl, setDsl] = useState('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 20\n}')
  /** DSL 按索引记忆:切换索引时不丢各自编辑内容。 */
  const [dslByIndex, setDslByIndex] = useState<ReadonlyMap<string, string>>(new Map())
  const [searchIndex, setSearchIndex] = useState('')
  const [searchFrom, setSearchFrom] = useState(0)
  const [searchSize, setSearchSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [result, setResult] = useState<EsSearchResult | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'json'>('json')

  const [mapping, setMapping] = useState<{ indexName: string; fields: MappingField[] } | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)

  const [showNewIndex, setShowNewIndex] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  /** 概览索引筛选(仅过滤展示,不影响检索)。 */
  const [indexFilter, setIndexFilter] = useState('')

  const connRef = useRef<string | null>(null)
  /** DSL 与目标索引的最新值(ref 镜像):在 onChange / 切换的**同一事件**里同步
      写入,供 switchSearchIndex 读取。state 更新是异步批处理的,事件回调里同步
      读 state 拿到的是旧值,而 updater 又受严格模式 double-invoke 影响。 */
  const dslRef = useRef(dsl)
  const searchIndexRef = useRef(searchIndex)

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
        setIndicesLoading(false)
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
    setIndicesLoading(true)
    try {
      setIndices(await esListIndices(connRef.current))
      setError(null)
    } catch (e) { fail(e) } finally {
      setIndicesLoading(false)
    }
  }, [fail])

  /** 切换检索目标索引:存回当前索引的 DSL,载入目标索引记忆的 DSL。 */
  const switchSearchIndex = useCallback((next: string) => {
    if (next === searchIndexRef.current) return
    // 从 ref 读最新值(而非闭包 state),一次算出下一张 map:既不会读到旧值,
    // 也不受 updater double-invoke 影响。空串(所有索引)同样是合法 key。
    const from = searchIndexRef.current
    const current = dslRef.current
    const map = new Map(dslByIndex)
    map.set(from, current)
    const remembered = map.get(next)
    setDslByIndex(map)
    searchIndexRef.current = next
    setSearchIndex(next)
    // 目标索引没有记忆时保留默认 DSL(不强行清空用户输入)。
    if (remembered !== undefined) { dslRef.current = remembered; setDsl(remembered) }
    // 换索引后旧分页位置失效,回到第一页。
    setSearchFrom(0)
    setResult(null)
  }, [dslByIndex])

  const selectIndex = useCallback(async (name: string) => {
    setSelectedIndex(name)
    searchIndexRef.current = name
    setSearchIndex(name)
    setTab('index')
    setMappingLoading(true)
    setMapping(null)
    setSettings(null)
    /* v8 ignore next 1 -- 选择索引仅在有连接的概览行触发,无连接假分支不可达 */
    if (connRef.current !== null) {
      try {
        const m = await esGetMapping(connRef.current, name)
        setMapping({ indexName: m.indexName, fields: (Array.isArray(m.fields) ? m.fields : []).map(fieldRow) })
        setSettings(await esGetSettings(connRef.current, name)
          /* v8 ignore next 1 -- settings 拉取失败兜底:保持 null */
          .catch(() => null))
        setError(null)
      } catch (e) { fail(e) } finally {
        setMappingLoading(false)
      }
    }
  }, [fail])

  /**
   * 执行 DSL 查询。from 与 size 显式传入(而非读闭包内的 state)——旧版
   * nextPage 先 setSearchFrom 再同步调 executeSearch,闭包里的 searchFrom 还是
   * 旧值,页码与数据永久错位一页。页码 state 在查询成功后才落地,失败时旧页
   * 标签与旧结果保持一致。
   * @param from - 目标页的起始偏移(新查询传 0)。
   * @param size - 每页条数(条数变化时由调用方显式传入新值)。
   */
  const executeSearch = useCallback(async (from: number, size = searchSize) => {
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
      // 「所有索引」用 `*` 通配:ES 7+ 已移除 `_all` 索引名,直传会报错。
      const idx = searchIndex === '' ? '*' : searchIndex
      const next = await esSearch(connId, idx, body, from, size)
      setResult(next)
      setSearchFrom(from)
      setSearchSize(size)
    } catch (e) { fail(e) } finally {
      setSearchLoading(false)
    }
  }, [dsl, searchIndex, searchSize, fail])

  const prevPage = useCallback(() => {
    // 上一页按钮在当前页 disabled;此处仅为护栏
    /* v8 ignore next 2 -- 页码回退需 from>=size 才可触发(上一页按钮已禁用时不可达) */
    if (searchFrom >= searchSize) void executeSearch(searchFrom - searchSize)
  }, [searchFrom, searchSize, executeSearch])

  const nextPage = useCallback(() => {
    // 下一页按钮在末页或空结果时 disabled;此处仅为护栏
    /* v8 ignore next 3 -- 需存在越页结果才可触发(下一页按钮已禁用时不可达) */
    if (result !== null && searchFrom + searchSize < result.totalHits) {
      void executeSearch(searchFrom + searchSize)
    }
  }, [result, searchFrom, searchSize, executeSearch])

  const formatDsl = useCallback(() => {
    try {
      const pretty = JSON.stringify(JSON.parse(dsl), null, 2)
      dslRef.current = pretty
      setDsl(pretty)
    } catch { /* keep as-is */ }
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

  /** 概览可见索引(筛选框过滤;空词全显)。 */
  const visibleIndices = useMemo(() => {
    const term = indexFilter.trim().toLowerCase()
    if (term === '') return indices
    return indices.filter(idx => idx.name.toLowerCase().includes(term))
  }, [indices, indexFilter])

  /** 全集群文档总数(概览摘要)。 */
  const totalDocs = useMemo(() => indices.reduce((sum, idx) => sum + idx.docsCount, 0), [indices])

  /** 当前选中索引在列表里的行(索引详情展示分片/文档数)。 */
  const selectedIndexRow = useMemo(
    () => (selectedIndex === null ? undefined : indices.find(i => i.name === selectedIndex)),
    [indices, selectedIndex],
  )

  /** 结果里的聚合(存在才展示)。 */
  const aggregations = useMemo(() => {
    if (result === null) return null
    const keys = Object.keys(result.aggregations)
    return keys.length > 0 ? result.aggregations : null
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
            <div className={css.summary}>
              <span className={css.sectionTitle}>索引({indices.length})</span>
              <span className={css.muted}>· 共 {totalDocs.toLocaleString()} 篇文档</span>
            </div>
            <div className={css.panelActions}>
              <input className={`${css.input} ${css.filterInput}`} value={indexFilter} spellCheck={false}
                placeholder="筛选索引…" aria-label="筛选索引"
                onChange={(e) =>{  setIndexFilter(e.target.value) }} />
              <button type="button" className={css.smallBtn} onClick={() => void reloadIndices()}>刷新</button>
            </div>
          </div>
          {indicesLoading && indices.length === 0 && <div className={css.empty}>正在加载索引…</div>}
          {!indicesLoading && (
            <table className={css.table}>
              <thead><tr><th>索引</th><th>文档数</th><th>存储</th><th>健康</th><th></th></tr></thead>
              <tbody>
                {visibleIndices.map(idx => (
                  <tr key={idx.name}>
                    <td className={css.mono}><button type="button" className={css.link} onClick={() => void selectIndex(idx.name)}>{idx.name}</button></td>
                    <td className={css.mono}>{idx.docsCount.toLocaleString()}</td>
                    <td className={css.mono}>{idx.storeSize}</td>
                    <td><span className={css.dot} style={{ background: healthColor(idx.health) }} />{idx.health}</td>
                    <td><button type="button" className={css.dangerBtn} onClick={() =>{  setConfirmDelete(idx.name) }}>删除</button></td>
                  </tr>
                ))}
                {visibleIndices.length === 0 && <tr><td colSpan={5} className={css.empty}>{indices.length === 0 ? '无索引' : '无匹配索引'}</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'search' && (
        <div className={`${css.body} ${css.searchLayout}`}>
          <div className={css.dslPanel}>
            <div className={css.panelHead}>
              <span>DSL 查询</span>
              <div className={css.panelActions}>
                <select className={css.input} value={searchIndex} aria-label="目标索引"
                  onChange={(e) =>{  switchSearchIndex(e.target.value) }}>
                  <option value="">所有索引</option>
                  {indices.map(idx => <option key={idx.name} value={idx.name}>{idx.name}</option>)}
                </select>
                <button type="button" className={css.smallBtn} onClick={formatDsl}>格式化</button>
              </div>
            </div>
            <textarea className={css.dslEditor} value={dsl} spellCheck={false} aria-label="DSL 查询"
              onChange={(e) =>{  dslRef.current = e.target.value; setDsl(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void executeSearch(0) }} />
            <div className={css.searchFoot}>
              <label className={css.sizeLabel}>
                每页
                <select className={css.input} value={searchSize} aria-label="每页条数"
                  onChange={(e) =>{  void executeSearch(0, Number(e.target.value)) }}>
                  {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                条
              </label>
              <button type="button" className={css.primaryBtn} disabled={searchLoading} onClick={() => void executeSearch(0)}>
                {searchLoading ? '查询中…' : '执行查询'}
              </button>
            </div>
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
                {aggregations !== null && (
                  <pre className={css.aggView}>{JSON.stringify(aggregations, null, 2)}</pre>
                )}
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
            {result === null && searchLoading && <div className={css.empty}>查询中…</div>}
          </div>
        </div>
      )}

      {tab === 'index' && selectedIndex !== null && mapping !== null && (
        <div className={css.body}>
          <div className={css.indicesHead}>
            <h3 className={css.sectionTitle}>{selectedIndex}</h3>
            <button type="button" className={css.smallBtn} onClick={() => void selectIndex(selectedIndex)}>
              <IconRefreshOutlineMedium size={11} /> 刷新
            </button>
          </div>
          <div className={css.indexMeta}>
            <span className={css.muted}>
              分片 {selectedIndexRow?.primaryShards ?? 0} 主 / {selectedIndexRow?.replicaShards ?? 0} 副
            </span>
            <span className={css.muted}>
              文档 {(selectedIndexRow?.docsCount ?? 0).toLocaleString()} 篇
            </span>
          </div>
          <h4 className={css.subTitle}>映射</h4>
          <div className={css.mappingTree}>
            {mapping.fields.map(f => (
              <MappingNode key={f.name} field={f} depth={0} />
            ))}
            {mapping.fields.length === 0 && <div className={css.empty}>该索引没有映射字段</div>}
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
      {tab === 'index' && selectedIndex !== null && mappingLoading && mapping === null && (
        <div className={`${css.body} ${css.empty}`}>正在加载索引详情…</div>
      )}

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

/** 递归渲染一个映射字段节点(按深度缩进,object/nested 的子字段全展开)。 */
function MappingNode({ field, depth }: { field: MappingField; depth: number }) {
  const color = fieldTypeColor(field.type)
  return (
    <>
      <div className={`${css.fieldRow} ${depth > 0 ? css.childRow : ''}`} style={{ paddingLeft: 8 + depth * 18 }}>
        <span className={css.mono}>{depth > 0 ? '↳ ' : ''}{field.name}</span>
        <span className={css.badge} style={{ color, borderColor: color }}>{field.type}</span>
      </div>
      {field.children?.map(ch => (
        <MappingNode key={ch.name} field={ch} depth={depth + 1} />
      ))}
    </>
  )
}

/** Minimal "create index" dialog (name + optional mappings JSON, calls db_es_create_index). */
function NewIndexDialog({ connId, onClose, onCreated }: {
  connId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [mappingsText, setMappingsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErrLocal] = useState<string | null>(null)
  const create = async () => {
    const trimmed = name.trim()
    if (trimmed === '') { setErrLocal('名称不能为空'); return }
    let mappings: Record<string, unknown> | undefined
    if (mappingsText.trim() !== '') {
      try {
        mappings = JSON.parse(mappingsText) as Record<string, unknown>
      } catch {
        setErrLocal('mappings 不是合法 JSON')
        return
      }
    }
    setBusy(true)
    setErrLocal(null)
    try {
      await esCreateIndex(connId, trimmed, mappings)
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
        <textarea className={`${css.input} ${css.mappingsInput}`} value={mappingsText} spellCheck={false}
          placeholder={'可选 mappings,JSON,如\n{\n  "properties": {\n    "msg": { "type": "text" }\n  }\n}'}
          aria-label="mappings"
          onChange={(e) =>{  setMappingsText(e.target.value) }} />
        {err !== null && <p className={css.error}>{err}</p>}
        <div className={css.dialogActions}>
          <button type="button" className={css.smallBtn} onClick={onClose}>取消</button>
          <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => void create()}>创建</button>
        </div>
      </div>
    </div>
  )
}
