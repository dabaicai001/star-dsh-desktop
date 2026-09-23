/**
 * StarHub 原生 Redis 工作台(批次 2:Redis 工作台 React 化)。
 * 壳内全屏 overlay,替换 Vue embed RedisView。挂载按 asset.config 连
 * db_redis_connect,卸载断连。
 *
 * 左侧为 **DB 树**:db0–db15 全部默认收起,点击某个 db 才展开并懒加载
 * (db_redis_select 把客户端切换到该库,再 db_redis_db_size + db_redis_scan
 * 取该 db 的键)。键加载经 redisScanAccumulate 连续分页直到游标归零(单批
 * 上限 SCAN_BATCH_LIMIT,超过后展示「加载更多」按游标续传),解决大 db 只展示
 * 首页 SCAN(~百条)的问题;加载中展示「已加载 / 总数」进度。键按 ':' 二次分组
 * 为文件夹树,文件夹同样默认收起,点击该行才展开叶子。同一时刻只展开一个
 * db——sidecar 的 Redis 客户端是单库语义(Select 即重建连接),展开态 db 恒等于
 * 客户端当前 db,键操作(打开/重命名/删除/清空/新建)与 CLI(db_redis_execute)
 * 都作用在展开的库上。已加载的键按 db 缓存,收起再展开不重复请求(部分加载的
 * 缓存命中时自动续传一批)。
 *
 * v0.102.0:
 * - **搜索移到每个展开的 db 区块内**(per-db 搜索词,互不影响),输入经 350ms
 *   防抖自动重扫该 db(旧版全局搜索框只写 state、从不触发重扫,等于失效);
 *   不含 glob 字符(* ? [ ])的词自动包成 `*词*` 子串匹配,含 glob 字符原样透传。
 * - **修复不能切换 key**:旧版经 openRef 回调打开,openRef 只在编辑器挂载
 *   effect 里捕获一次,openValue 从 key A 换成 key B 时编辑器不重挂载、永远
 *   停在 A;现在 RedisValueEditor 改为受控 props(redisKey/keyType)并以
 *   React key 按 key 重挂载。
 *
 * P0 修复(库漂移):CLI 的 SELECT 不透传给 sidecar 执行(持久连接会真实切库而
 * UI 状态不跟随,后续 FLUSHDB/删除会作用在看不见的库上),改为走 redisSelect RPC
 * 并同步 activeDb/expandedDb 与键列表;FLUSHDB 执行前先显式 select 目标库,且确认
 * 弹窗要求输入 db 序号二次确认(替代 window.confirm)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineMedium, IconChevronRightOutlineMedium, IconCloseFillMedium, IconCloseOutlineMedium,
  IconCodeOutlineMedium, IconEditOutlineMedium, IconPlusOutlineMedium, IconTrashOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RustAsset } from '../store.ts'
import { redisConnect, redisDBSize, redisDel, redisDisconnect, redisExecute, redisFlushDB, redisQuote, redisRename, redisScan, redisScanAccumulate, redisSelect, type RedisKeyInfo } from './redis-service.ts'
import { allFolderPaths, buildKeyTree, countLeaves, type KeyTreeNode } from './key-tree.ts'
import { RedisValueEditor } from './RedisValueEditor.tsx'
import css from './RedisWorkbench.module.css'

/** Redis 固定 DB 编号(单机 0-15)。 */
const DB_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

/** 单批连续 SCAN 的 key 总量上限:超过则停在 batch 末尾,由「加载更多」续传。 */
const SCAN_BATCH_LIMIT = 10_000

/** 搜索输入防抖:停敲 350ms 后自动按新匹配重扫展开的 db。 */
const SEARCH_DEBOUNCE_MS = 350

/**
 * 搜索词 → SCAN MATCH 模式:含 glob 字符(* ? [ ])原样透传(用户自定义模式),
 * 否则包成 `*词*` 子串匹配(符合「搜索」直觉,避免裸词只匹配完整 key)。
 * @param term - 用户输入(已 trim)。
 * @returns MATCH 模式;空串表示不过滤。
 */
export function toScanMatch(term: string): string {
  if (term === '') return ''
  return /[*?[\]]/.test(term) ? term : `*${term}*`
}

/**
 * 解析 CLI 输入的 SELECT 目标库。
 * @param command - CLI 原始输入(未 trim 也可)。
 * @returns 非 SELECT 命令返回 null;合法 SELECT 返回目标 db(0-15);SELECT 但参数
 *   缺失/非法返回 'invalid'。
 */
export function parseCliSelect(command: string): number | 'invalid' | null {
  const tokens = command.trim().split(/\s+/).filter(t => t !== '')
  const first = tokens[0]
  if (first === undefined || first.toLowerCase() !== 'select') return null
  if (tokens.length !== 2) return 'invalid'
  const db = Number(tokens[1])
  if (!Number.isInteger(db) || db < 0 || db > 15) return 'invalid'
  return db
}

/** 单个 db 的懒加载缓存:展开时取一次,收起保留。 */
interface DbLoadable {
  keys: RedisKeyInfo[]
  cursor: number
  /** SCAN 游标是否已归零(false = 还有未加载的键,可「加载更多」续传)。 */
  complete: boolean
  loading: boolean
  error: string | null
  /** DBSIZE 键总数(展开时与 SCAN 一起刷新)。 */
  size: number
  /** 本次加载使用的搜索匹配模式(缓存命中判定用);null = 从未加载过键——
      新建 key/FLUSHDB 后只刷新 size 会基于 EMPTY 建出「有 size 无键」的占位
      记录,若 match 也是 '' 会被 toggleDb 误判为完整缓存而跳过加载(展开后
      显示「暂无 key」),故未加载恒为 null,命中判定天然失败。 */
  match: string | null
}

/** 未加载 db 的占位记录(patchDbList 的合并基底)。 */
const EMPTY_DB_LOADABLE: DbLoadable = { keys: [], cursor: 0, complete: true, loading: false, error: null, size: 0, match: null }

/** 无展开文件夹的占位集(toggleKeyFolder 从不原地改动,可安全共享)。 */
const EMPTY_FOLDER_PATHS: ReadonlySet<string> = new Set()

/** 新建 key 支持的类型。 */
export const NEW_KEY_TYPES = ['string', 'hash', 'list', 'set', 'zset'] as const

/** 新建 key 对话框输入。 */
interface NewKeyDraft {
  key: string
  type: string
  value: string
  /** 目标 db(打开弹窗时默认当前展开/所在库,可改)。 */
  db: number
  /** hash 的字段名。 */
  field: string
  /** zset 的分值。 */
  score: string
}

/**
 * 组装新建 key 的 Redis 命令:按类型分派(hash 用 field+value,zset 用 score+member,
 * list/set 以 value 作首个成员——Redis 不允许创建空集合,必须先写一个元素)。
 * @param draft - 对话框输入(key 已 trim)。
 * @returns 命令文本;hash 缺 field / zset score 非数字时返回 null(调用方提示)。
 */
export function buildCreateKeyCommand(draft: NewKeyDraft): string | null {
  const key = redisQuote(draft.key)
  const value = redisQuote(draft.value)
  switch (draft.type) {
    case 'hash': {
      if (draft.field.trim() === '') return null
      return `HSET ${key} ${redisQuote(draft.field)} ${value}`
    }
    case 'list': return `RPUSH ${key} ${value}`
    case 'set': return `SADD ${key} ${value}`
    case 'zset': {
      const score = Number(draft.score)
      if (draft.score.trim() === '' || !Number.isFinite(score)) return null
      return `ZADD ${key} ${score} ${value}`
    }
    default: return `SET ${key} ${value}`
  }
}

/** 树行渲染入参:节点 + 深度 + 展开态与操作回调。 */
interface KeyTreeRowProps {
  node: KeyTreeNode
  depth: number
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (key: string, type: string) => void
  onRename: (key: string) => void
  onDelete: (key: string) => void
}

/**
 * 渲染一行键树节点:文件夹行(箭头 + 段名 + 叶子计数,点击折叠/展开,子级递归)
 * 或叶子行(类型徽标 + 最后一段,操作沿用完整 key)。
 * @param props - 节点与回调。
 * @returns 该行(及展开时的子级行)。
 */
function KeyTreeRow({ node, depth, expanded, onToggle, onOpen, onRename, onDelete }: KeyTreeRowProps) {
  const indent = { paddingLeft: 5 + depth * 14 }
  if (node.keyInfo !== null) {
    const k = node.keyInfo
    return (
      <div className={css.keyRow} style={indent}>
        <button type="button" className={css.keyMain} onClick={() =>{  onOpen(k.key, k.type) }}>
          <span className={css.keyType}>{k.type}</span>
          <span className={css.keyName} title={k.key}>{node.name}</span>
        </button>
        <div className={css.keyActions}>
          <button type="button" className={css.miniButton} title="重命名" aria-label={`重命名 ${k.key}`}
            onClick={() =>{  onRename(k.key) }}><IconEditOutlineMedium size={13} /></button>
          <button type="button" className={css.miniDanger} title="删除" aria-label={`删除 ${k.key}`}
            onClick={() =>{  onDelete(k.key) }}><IconCloseFillMedium size={13} /></button>
        </div>
      </div>
    )
  }
  const open = expanded.has(node.path)
  return (
    <>
      <div className={css.keyRow} style={indent}>
        <button type="button" className={css.keyMain} onClick={() =>{  onToggle(node.path) }}
          aria-expanded={open} aria-label={`文件夹 ${node.path}`}>
          <span className={css.folderChevron} aria-hidden="true">
            {open ? <IconChevronDownOutlineMedium size={12} /> : <IconChevronRightOutlineMedium size={12} />}
          </span>
          <span className={css.folderName} title={node.path}>{node.name}</span>
          <span className={css.folderCount}>{countLeaves(node)}</span>
        </button>
      </div>
      {open && node.children.map(child => (
        <KeyTreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded}
          onToggle={onToggle} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />
      ))}
    </>
  )
}

/** CLI 结果显示文本:对象 JSON 化(含 null),undefined 空串,其余原样。 */
function toCliText(v: unknown): string {
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  if (v === undefined) return ''
  const primitive = v as string | number | boolean | bigint | symbol
  return String(primitive)
}

/**
 * Render the native Redis workbench overlay.
 * @param props - the target asset + close callback.
 * @returns the Redis workbench overlay.
 */
export function RedisWorkbench({ asset, onClose }: { asset: RustAsset; onClose: () => void }) {
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  /** 当前展开的 db;null = 全部收起。 */
  const [expandedDb, setExpandedDb] = useState<number | null>(null)
  /** 客户端当前所在 db(展开切换后恒等于展开的 db)。 */
  const [activeDb, setActiveDb] = useState(0)
  /** 各 db 懒加载缓存(键 + 总数 + 搜索匹配)。 */
  const [dbLists, setDbLists] = useState<ReadonlyMap<number, DbLoadable>>(new Map())
  /** per-db 搜索词(v0.102.0:搜索框移入各 db 区块,词按 db 隔离持久)。 */
  const [searchDrafts, setSearchDrafts] = useState<ReadonlyMap<number, string>>(new Map())
  const [cliOpen, setCliOpen] = useState(false)
  const [cliInput, setCliInput] = useState('')
  const [cliOutput, setCliOutput] = useState<string>('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [newKeyDraft, setNewKeyDraft] = useState<NewKeyDraft>({ key: '', type: 'string', value: '', db: 0, field: '', score: '' })
  /** FLUSHDB 二次确认:目标 db(打开弹窗时锁定)与用户输入的确认序号。 */
  const [flushConfirm, setFlushConfirm] = useState<number | null>(null)
  const [flushInput, setFlushInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [openValue, setOpenValue] = useState<{ key: string; type: string } | null>(null)
  /** 键树文件夹展开态:db → 已展开路径集(默认全收起,点击文件夹行才展开)。 */
  const [expandedKeys, setExpandedKeys] = useState<ReadonlyMap<number, ReadonlySet<string>>>(new Map())
  const connRef = useRef<string | null>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    /* v8 ignore start -- toast 自动消除是时序副作用,由出现断言覆盖 */
    window.setTimeout(() =>{  setToast(cur => (cur === msg ? null : cur)) }, 2500)
    /* v8 ignore stop */
  }, [])

  /** 合并写入某个 db 的加载记录(不存在的 db 以 EMPTY 为基底)。 */
  const patchDbList = useCallback((db: number, patch: Partial<DbLoadable>) => {
    setDbLists(prev => {
      const next = new Map(prev)
      next.set(db, { ...(prev.get(db) ?? EMPTY_DB_LOADABLE), ...patch })
      return next
    })
  }, [])

  /** 刷新某个 db 的键总数(DBSIZE)。 */
  const refreshSizeForDb = useCallback(async (connId: string, db: number) => {
    try {
      const { size } = await redisDBSize(connId)
      patchDbList(db, { size })
    } catch (e: unknown) {
      notify(`获取键数失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }, [notify, patchDbList])

  /** 取/写某个 db 的搜索词(per-db 隔离)。 */
  const searchFor = useCallback((db: number) => searchDrafts.get(db) ?? '', [searchDrafts])
  const setSearchFor = useCallback((db: number, text: string) => {
    setSearchDrafts(prev => new Map(prev).set(db, text))
  }, [])

  /** 连续加载某个 db 的键(从 0 游标 SCAN 到归零/单批上限;按 match 过滤),写入该 db 缓存。 */
  const loadKeysForDb = useCallback(async (connId: string, db: number, match: string) => {
    patchDbList(db, { loading: true, error: null })
    try {
      const { keys, cursor, complete } = await redisScanAccumulate(
        (cur, m, count) => redisScan(connId, cur, m, count),
        0, match === '' ? undefined : match, [], SCAN_BATCH_LIMIT,
      )
      patchDbList(db, { keys, cursor, complete, loading: false, error: null, match })
    } catch (e: unknown) {
      patchDbList(db, { loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [patchDbList])

  /**
   * 从缓存游标续传某个 db 的剩余键(「加载更多」/ 部分缓存展开时自动续传一批):
   * 保留已加载键,redisScanAccumulate 按其 key 去重,再加载至多一批。
   */
  const loadMoreKeysForDb = useCallback(async (connId: string, db: number) => {
    const cached = dbLists.get(db)
    /* v8 ignore next -- 防御:续传仅在已有缓存记录时触发(按钮随展开渲染) */
    if (cached === undefined || cached.complete || cached.loading) return
    patchDbList(db, { loading: true, error: null })
    try {
      const { keys, cursor, complete } = await redisScanAccumulate(
        (cur, m, count) => redisScan(connId, cur, m, count),
        /* v8 ignore next -- 续传守卫要求 complete=false,而 match=null(从未加载)的记录恒 complete=true,null 臂不可达 */
        cached.cursor, cached.match !== null && cached.match !== '' ? cached.match : undefined, cached.keys, cached.keys.length + SCAN_BATCH_LIMIT,
      )
      patchDbList(db, { keys, cursor, complete, loading: false, error: null })
    } catch (e: unknown) {
      patchDbList(db, { loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [dbLists, patchDbList])

  // 挂载建连一次,卸载断连;不自动取键(DB 树全部收起,点击才懒加载)。
  useEffect(() => {
    const config = asset.config
    const connParams = {
      host: typeof config.host === 'string' ? config.host : '',
      port: typeof config.port === 'number' ? config.port : 6379,
      db: 0,
      ssl: config.ssl === true,
      ...(typeof config.password === 'string' ? { password: config.password } : {}),
    }
    let cancelled = false
    redisConnect(connParams)
      .then(async (info) => {
        /* v8 ignore next -- 卸载竞态守卫 */
        if (cancelled) return
        if (!info.connId) throw new Error('Redis 连接未返回 connId')
        connRef.current = info.connId
        setConnected(true)
      })
      .catch((e: unknown) => {
        /* v8 ignore start -- `String(e)` 兜底非 Error;`!cancelled` 卸载守卫由成功路径覆盖 */
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e))
        /* v8 ignore stop */
      })
    return () => {
      cancelled = true
      /* v8 ignore start -- fire-and-forget 断连 */
      if (connRef.current !== null) void redisDisconnect(connRef.current).catch(() => {})
      /* v8 ignore stop */
    }
    // 只随资产 id
  }, [asset.id])

  /** 展开/收起某个 db;展开时切客户端(如需)并懒加载该 db 的键。 */
  const toggleDb = async (db: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    if (expandedDb === db) {
      // 收起:关闭值编辑器,已加载的键留在缓存里,再展开直接命中。
      setExpandedDb(null)
      setOpenValue(null)
      return
    }
    setExpandedDb(db)
    setOpenValue(null)
    if (activeDb !== db) {
      try {
        await redisSelect(connId, db)
        setActiveDb(db)
      } catch (e: unknown) {
        setExpandedDb(cur => (cur === db ? null : cur))
        notify(`切换 DB 失败:${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    const cached = dbLists.get(db)
    const match = toScanMatch(searchFor(db).trim())
    // 缓存命中:键 + 搜索匹配一致时不再从头请求。完整缓存直接复用;部分缓存
    // (上次停在单批上限)自动从游标续传一批,避免大 db 每次展开都重扫。
    if (cached !== undefined && cached.match === match) {
      if (cached.complete) return
      void loadMoreKeysForDb(connId, db)
      return
    }
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db, match)])
  }

  /** 重新加载某个 db 的键与总数(错误重试 / 刷新钮共用),沿用该 db 当前搜索词。 */
  const reloadDb = async (db: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db, toScanMatch(searchFor(db).trim()))])
  }

  /** 重新加载当前展开 db(键操作 / CLI / 清空后的数据同步)。 */
  const refreshExpanded = async (connId: string) => {
    /* v8 ignore next -- 调用方全部保证展开态:键行/刷新钮仅在展开时可用 */
    if (expandedDb === null) return
    await Promise.all([refreshSizeForDb(connId, expandedDb), loadKeysForDb(connId, expandedDb, toScanMatch(searchFor(expandedDb).trim()))])
  }

  // 搜索词防抖:展开 db 的搜索词与其缓存匹配串不一致时,停敲 350ms 自动重扫;
  // toggleDb 的首次加载(entry 未建)不在此处触发,避免双请求;加载进行中
  // (toggleDb 首次加载在途)同样跳过,加载落地后 dbLists 变化会重估本效应。
  const expandedSearch = expandedDb === null ? '' : searchFor(expandedDb)
  useEffect(() => {
    if (expandedDb === null) return
    const connId = connRef.current
    if (connId === null) return
    const entry = dbLists.get(expandedDb)
    const desired = toScanMatch(expandedSearch.trim())
    if (entry === undefined || entry.loading || entry.match === desired) return
    const timer = window.setTimeout(() =>{  void loadKeysForDb(connId, expandedDb, desired) }, SEARCH_DEBOUNCE_MS)
    return () =>{  window.clearTimeout(timer) }
  }, [expandedDb, expandedSearch, dbLists, loadKeysForDb])

  /** 键变更操作后同步:展开时刷新其键,收起时只刷新当前 db 总数。 */
  const syncAfterMutation = async (connId: string) => {
    if (expandedDb === null) await refreshSizeForDb(connId, activeDb)
    else await refreshExpanded(connId)
  }

  const deleteKey = async (key: string) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    if (!window.confirm(`确定删除 key「${key}」?`)) return
    try {
      await redisDel(connId, [key])
      notify(`已删除:${key}`)
      setOpenValue(cur => (cur?.key === key ? null : cur))
      await refreshExpanded(connId)
    } catch (e: unknown) {
      notify(`删除失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const doRename = async () => {
    const connId = connRef.current
    const target = renaming
    /* v8 ignore next -- 按钮在重命名态下 disabled,防御守卫 */
    if (connId === null || target === null) return
    const next = renameTo.trim()
    if (next === '' || next === target) { setRenaming(null); return }
    try {
      await redisRename(connId, target, next)
      notify('Key 已重命名')
      setRenaming(null)
      setRenameTo('')
      await refreshExpanded(connId)
    } catch (e: unknown) {
      notify(`重命名失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开 FLUSHDB 二次确认弹窗:目标库 = 展开库或当前库,确认需输入 db 序号。 */
  const askFlushDb = () => {
    setFlushInput('')
    setFlushConfirm(expandedDb ?? activeDb)
  }

  /**
   * 清空指定 db:先显式 redisSelect 把持久连接切到目标库再 FLUSHDB——sidecar 的
   * FlushDB 清的是「连接当前所在库」,库漂移(如 CLI 绕过拦截)时确认文案与实际
   * 清空的库会不一致;select 后 activeDb 与目标库强绑定。
   * @param target - 确认弹窗打开时锁定的目标 db。
   */
  const flushDb = async (target: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    try {
      if (target !== activeDb) {
        await redisSelect(connId, target)
        setActiveDb(target)
      }
      await redisFlushDB(connId)
      setFlushConfirm(null)
      setOpenValue(null)
      notify(`db${target} 已清空`)
      // 上面 setActiveDb 尚未落地,按 target 显式同步(而非闭包内旧 activeDb)。
      if (expandedDb === null) await refreshSizeForDb(connId, target)
      else await refreshExpanded(connId)
    } catch (e: unknown) {
      notify(`清空 DB 失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开新建 key 弹窗:目标 db 默认当前展开库(未展开则连接所在库),可改。 */
  const openNewKey = () => {
    setNewKeyDraft({ key: '', type: 'string', value: '', db: expandedDb ?? activeDb, field: '', score: '' })
    setNewKeyOpen(true)
  }

  const createKey = async () => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    const key = newKeyDraft.key.trim()
    /* v8 ignore next -- 空 key 时创建按钮 disabled,守卫生不可达 */
    if (key === '') return
    const command = buildCreateKeyCommand({ ...newKeyDraft, key })
    if (command === null) {
      notify(newKeyDraft.type === 'hash' ? 'hash 需要填写字段名' : 'zset 需要合法的数字分值')
      return
    }
    const target = newKeyDraft.db
    try {
      // 目标库与连接所在库不一致时先切库(与 FLUSHDB 同款防库漂移),并同步 UI 状态。
      if (target !== activeDb) {
        await redisSelect(connId, target)
        setActiveDb(target)
      }
      await redisExecute(connId, command)
      setNewKeyOpen(false)
      notify('Key 已创建')
      if (expandedDb === target) await refreshExpanded(connId)
      else await refreshSizeForDb(connId, target)
    } catch (e: unknown) {
      notify(`创建失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const runCli = async () => {
    const connId = connRef.current
    const command = cliInput.trim()
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null || command === '') return
    // SELECT 不透传给 sidecar:持久连接的 Select 会真实切换所在库,而 UI 的
    // activeDb/expandedDb 不跟随 → 后续 FLUSHDB/删除/键列表全作用在「看不见的库」。
    // 改为走 redisSelect RPC 并同步 UI 状态与键列表。
    const selectTarget = parseCliSelect(command)
    if (selectTarget === 'invalid') {
      setCliOutput('无效的 db 序号:SELECT 只接受 0-15 的整数,如 SELECT 3')
      return
    }
    if (selectTarget !== null) {
      if (selectTarget === activeDb && expandedDb === selectTarget) {
        setCliOutput(`已在 db${selectTarget}`)
        return
      }
      try {
        if (selectTarget !== activeDb) await redisSelect(connId, selectTarget)
        setActiveDb(selectTarget)
        setOpenValue(null)
        setCliOutput(`已切换到 db${selectTarget}`)
        // 展开并加载目标 db,保证 UI 展示库与连接所在库一致(与 toggleDb 展开路径同)。
        if (expandedDb !== selectTarget) {
          setExpandedDb(selectTarget)
          const cached = dbLists.get(selectTarget)
          const match = toScanMatch(searchFor(selectTarget).trim())
          if (cached !== undefined && cached.match === match) {
            if (!cached.complete) void loadMoreKeysForDb(connId, selectTarget)
          } else {
            await Promise.all([refreshSizeForDb(connId, selectTarget), loadKeysForDb(connId, selectTarget, match)])
          }
        }
      } catch (e: unknown) {
        setCliOutput(`切换 DB 失败:${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    try {
      const res = await redisExecute(connId, command)
      setCliOutput(res.error ?? toCliText(res.result))
      await syncAfterMutation(connId)
    } catch (e: unknown) {
      setCliOutput(e instanceof Error ? e.message : String(e))
    }
  }

  const openKey = useCallback((key: string, type: string) =>{  setOpenValue({ key, type }) }, [])

  /** 展开/收起某个 db 里的键文件夹(展开集按 db 隔离,会话内持久)。 */
  const toggleKeyFolder = useCallback((db: number, path: string) => {
    setExpandedKeys(prev => {
      const next = new Map(prev)
      const cur = new Set(next.get(db) ?? [])
      if (cur.has(path)) cur.delete(path)
      else cur.add(path)
      next.set(db, cur)
      return next
    })
  }, [])

  /** 当前展开 db 的加载记录与键树(收起时为空)。 */
  const expandedEntry = expandedDb !== null ? dbLists.get(expandedDb) : undefined
  const keyTree = useMemo(() => buildKeyTree(expandedEntry?.keys ?? []), [expandedEntry?.keys])
  const expandedFolders = useMemo(() => {
    // 搜索态强制全展开,让过滤结果直接可见;否则默认全收起,只显示已点开的文件夹。
    if (expandedSearch.trim() !== '') return allFolderPaths(keyTree)
    if (expandedDb === null) return EMPTY_FOLDER_PATHS
    return expandedKeys.get(expandedDb) ?? EMPTY_FOLDER_PATHS
  }, [keyTree, expandedKeys, expandedDb, expandedSearch])

  const id = connRef.current
  const shownDb = expandedDb ?? activeDb
  const shownEntry = dbLists.get(shownDb)

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`Redis ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span className={css.title}>{asset.name}</span>
            <span className={css.statusDot}>{connected ? '已连接' : '未连接'}</span>
            <span className={css.badge} data-testid="redis-head-badge">db{shownDb}</span>
            <span className={css.keyCount} data-testid="redis-head-count">{(shownEntry?.size ?? 0).toLocaleString()} keys</span>
          </div>
          <button type="button" className={css.closeButton} onClick={onClose}>关闭</button>
        </header>

        {connectError !== null && (
          <div className={css.errorBar}>
            <span>{connectError}</span>
            <button type="button" className={css.retryButton} onClick={onClose}>返回</button>
          </div>
        )}

        {connectError === null && (
          <div className={css.body}>
            <div className={css.side}>
              <div className={css.toolbar}>
                <button type="button" className={css.iconButton} title="刷新" aria-label="刷新"
                  disabled={!connected || expandedDb === null || expandedEntry?.loading === true}
                  /* v8 ignore next -- 刷新钮在未展开/未连接时 disabled,守卫分支不可达 */
                  onClick={() => { const c = connRef.current; if (c !== null) void refreshExpanded(c) }}>⟳</button>
                <button type="button" className={css.iconButton} title="清空 DB" aria-label="清空 DB"
                  disabled={!connected} onClick={() =>{  askFlushDb() }}><IconTrashOutlineMedium size={15} /></button>
                <button type="button" className={css.iconButton} title="CLI" aria-label="CLI"
                  disabled={!connected} onClick={() =>{  setCliOpen(v => !v) }}><IconCodeOutlineMedium size={15} /></button>
                <span className={css.toolbarSpacer} />
                <button type="button" className={css.primaryButton} title="新建 Key" aria-label="新建 Key"
                  disabled={!connected} onClick={() =>{  openNewKey() }}><IconPlusOutlineMedium size={14} /> 新建 Key</button>
              </div>

              <div className={css.dbTree} role="tree" aria-label="DB 列表">
                {DB_INDEXES.map(db => {
                  const open = expandedDb === db
                  const entry = dbLists.get(db)
                  return (
                    <div className={`${css.dbNode} ${open ? css.dbNodeOpen : ''}`} key={db} role="treeitem">
                      <div className={css.dbRow}>
                        <button type="button" className={css.keyMain} onClick={() =>{  void toggleDb(db) }}
                          aria-expanded={open} aria-label={`数据库 db${db}`}>
                          <span className={css.folderChevron} aria-hidden="true">
                            {open ? <IconChevronDownOutlineMedium size={12} /> : <IconChevronRightOutlineMedium size={12} />}
                          </span>
                          <span className={css.dbName}>db{db}</span>
                          {entry !== undefined && <span className={css.folderCount}>{entry.size.toLocaleString()}</span>}
                        </button>
                      </div>
                      {open && (
                        <div className={css.dbChildren}>
                          <div className={css.dbSearchRow}>
                            <input
                              className={css.dbSearch}
                              placeholder={`搜索 db${db} 的 key…`}
                              aria-label="搜索 key"
                              spellCheck={false}
                              value={searchFor(db)}
                              onChange={(e) =>{  setSearchFor(db, e.target.value) }}
                            />
                            {searchFor(db) !== '' && (
                              <button type="button" className={css.dbSearchClear} aria-label="清除搜索" title="清除搜索"
                                onClick={() =>{  setSearchFor(db, '') }}><IconCloseOutlineMedium size={12} /></button>
                            )}
                          </div>
                          {entry === undefined && <div className={css.dbStatus}>加载键…</div>}
                          {entry !== undefined && entry.loading && (
                            <div className={css.dbStatus} data-testid="redis-scan-progress">
                              <span>正在加载键… {entry.keys.length.toLocaleString()}{entry.size > 0 ? ` / ${entry.size.toLocaleString()}` : ''}</span>
                            </div>
                          )}
                          {entry !== undefined && !entry.loading && entry.error !== null && (
                            <div className={css.dbStatus}>
                              <span>加载失败:{entry.error}</span>
                              <button type="button" className={css.retryButton}
                                /* v8 ignore next -- 重试钮仅在已连接 + 展开的错误态出现,守卫分支不可达 */
                                onClick={() => { const c = connRef.current; if (c !== null) void reloadDb(db) }}>重试</button>
                            </div>
                          )}
                          {entry !== undefined && !entry.loading && entry.error === null && entry.keys.length === 0 && (
                            <div className={css.dbStatus}>暂无 key。</div>
                          )}
                          {entry !== undefined && entry.error === null && entry.keys.length > 0 && (
                            <>
                              <div className={css.keyList}>
                                {keyTree.map(node => (
                                  <KeyTreeRow key={node.path} node={node} depth={0} expanded={expandedFolders}
                                    onToggle={(path) => toggleKeyFolder(db, path)} onOpen={openKey}
                                    onRename={(key) => { setRenaming(key); setRenameTo(key) }}
                                    onDelete={key => void deleteKey(key)} />
                                ))}
                              </div>
                              {/* 部分加载(停在单批上限):展示剩余量 + 按游标续传。 */}
                              {entry.complete === false && (
                                <div className={css.dbStatus}>
                                  <span>已加载 {entry.keys.length.toLocaleString()} / {entry.size.toLocaleString()} keys</span>
                                  <button type="button" className={css.retryButton} data-testid="redis-load-more"
                                    disabled={entry.loading}
                                    onClick={() => { const c = connRef.current; if (c !== null) void loadMoreKeysForDb(c, db) }}>加载更多</button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className={css.main}>
              {renaming !== null && (
                <div className={css.renameBar}>
                  <input className={css.searchInput} value={renameTo} aria-label="新 key 名"
                    placeholder={renaming} onChange={(e) =>{  setRenameTo(e.target.value) }} />
                  <button type="button" className={css.primaryButton} onClick={() => void doRename()}>确认</button>
                  <button type="button" className={css.secondaryButton} onClick={() =>{  setRenaming(null) }}>取消</button>
                </div>
              )}
              {cliOpen && (
                <div className={css.cliBar}>
                  <input className={css.searchInput} placeholder="redis 命令,如 GET foo" value={cliInput} aria-label="命令输入"
                    onChange={(e) =>{  setCliInput(e.target.value) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void runCli() }} />
                  <button type="button" className={css.primaryButton} onClick={() => void runCli()}>执行</button>
                </div>
              )}
              {cliOutput !== '' && <pre className={css.cliOutput}>{cliOutput}</pre>}
              {openValue !== null && id !== null ? (
                <RedisValueEditor
                  key={openValue.key}
                  connId={id}
                  redisKey={openValue.key}
                  keyType={openValue.type}
                />
              ) : (
                <div className={css.placeholder}>
                  <div className={css.placeholderTitle}>未选择 Key</div>
                  <div className={css.placeholderDesc}>在左侧展开一个 db,点击 key 查看 / 编辑</div>
                </div>
              )}
            </div>
          </div>
        )}

        {newKeyOpen && (
          <div className={css.modalBackdrop}>
            <div className={css.modal}>
              <div className={css.modalTitle}>新建 Key</div>
              <div className={css.modalFieldRow}>
                <select className={css.modalSelect} aria-label="目标 DB" title="目标 DB"
                  value={newKeyDraft.db} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, db: Number(e.target.value) })) }}>
                  {DB_INDEXES.map(db => <option key={db} value={db}>db{db}</option>)}
                </select>
                <select className={css.modalSelect} aria-label="类型" title="类型"
                  value={newKeyDraft.type} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, type: e.target.value })) }}>
                  {NEW_KEY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <input className={css.searchInput} placeholder="key 名" aria-label="key 名"
                value={newKeyDraft.key} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, key: e.target.value })) }} />
              {newKeyDraft.type === 'hash' && (
                <input className={css.searchInput} placeholder="字段名" aria-label="字段名"
                  value={newKeyDraft.field} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, field: e.target.value })) }} />
              )}
              {newKeyDraft.type === 'zset' && (
                <input className={css.searchInput} placeholder="分值(数字)" aria-label="分值"
                  spellCheck={false} value={newKeyDraft.score} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, score: e.target.value })) }} />
              )}
              <input className={css.searchInput}
                placeholder={newKeyDraft.type === 'string' ? '值(string)' : newKeyDraft.type === 'hash' ? '值(hash)' : '首个成员'}
                aria-label={newKeyDraft.type === 'string' ? '值(string)' : newKeyDraft.type === 'hash' ? '值(hash)' : '首个成员'}
                value={newKeyDraft.value} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, value: e.target.value })) }} />
              <div className={css.modalActions}>
                <button type="button" className={css.secondaryButton} onClick={() =>{  setNewKeyOpen(false) }}>取消</button>
                <button type="button" className={css.primaryButton}
                  disabled={newKeyDraft.key.trim() === '' || (newKeyDraft.type === 'hash' && newKeyDraft.field.trim() === '')}
                  onClick={() => void createKey()}>创建</button>
              </div>
            </div>
          </div>
        )}

        {flushConfirm !== null && (
          <div className={css.modalBackdrop}>
            <div className={css.modal}>
              <div className={css.modalTitle}>清空 db{flushConfirm}</div>
              <div className={css.placeholderDesc}>将删除 db{flushConfirm} 的全部 key,操作不可恢复。请输入 db 序号 {flushConfirm} 确认:</div>
              <input className={css.searchInput} placeholder={`输入 ${flushConfirm} 确认`} aria-label="确认 db 序号"
                spellCheck={false} value={flushInput}
                onChange={(e) =>{  setFlushInput(e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && flushInput.trim() === String(flushConfirm)) void flushDb(flushConfirm) }} />
              <div className={css.modalActions}>
                <button type="button" className={css.secondaryButton} onClick={() =>{  setFlushConfirm(null) }}>取消</button>
                <button type="button" className={css.dangerButton} disabled={flushInput.trim() !== String(flushConfirm)}
                  onClick={() => void flushDb(flushConfirm)}>清空</button>
              </div>
            </div>
          </div>
        )}

        {toast !== null && <div className={css.toast}>{toast}</div>}
      </section>
    </div>
  )
}