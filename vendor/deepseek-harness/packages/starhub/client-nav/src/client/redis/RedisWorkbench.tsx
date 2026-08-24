/**
 * StarHub 原生 Redis 工作台(批次 2:Redis 工作台 React 化)。
 * 壳内全屏 overlay,替换 Vue embed RedisView。挂载按 asset.config 连
 * db_redis_connect,卸载断连。
 *
 * 左侧为 **DB 树**:db0–db15 全部默认收起,点击某个 db 才展开并懒加载
 * (db_redis_select 把客户端切换到该库,再 db_redis_db_size + db_redis_scan
 * 取该 db 的键;键按 ':' 二次分组为文件夹树,文件夹同样默认收起,点击该行
 * 才展开叶子)。同一时刻只展开一个 db——sidecar 的 Redis 客户端是单库语义
 * (Select 即重建连接),展开态 db 恒等于客户端当前 db,键操作(打开/重命名/
 * 删除/清空/新建)与 CLI(db_redis_execute)都作用在展开的库上。已加载的键
 * 按 db 缓存,收起再展开不重复请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RustAsset } from '../store.ts'
import { redisConnect, redisDBSize, redisDel, redisDisconnect, redisExecute, redisFlushDB, redisRename, redisScan, redisSelect, type RedisKeyInfo } from './redis-service.ts'
import { allFolderPaths, buildKeyTree, countLeaves, type KeyTreeNode } from './key-tree.ts'
import { RedisValueEditor } from './RedisValueEditor.tsx'
import css from './RedisWorkbench.module.css'

/** Redis 固定 DB 编号(单机 0-15)。 */
const DB_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

/** 单个 db 的懒加载缓存:展开时取一次,收起保留。 */
interface DbLoadable {
  keys: RedisKeyInfo[]
  cursor: number
  loading: boolean
  error: string | null
  /** DBSIZE 键总数(展开时与 SCAN 一起刷新)。 */
  size: number
  /** 本次加载使用的搜索匹配模式(缓存命中判定用)。 */
  match: string
}

/** 未加载 db 的占位记录(patchDbList 的合并基底)。 */
const EMPTY_DB_LOADABLE: DbLoadable = { keys: [], cursor: 0, loading: false, error: null, size: 0, match: '' }

/** 无展开文件夹的占位集(toggleKeyFolder 从不原地改动,可安全共享)。 */
const EMPTY_FOLDER_PATHS: ReadonlySet<string> = new Set()

/** 新建 key 对话框输入。 */
interface NewKeyDraft {
  key: string
  type: string
  value: string
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
            onClick={() =>{  onRename(k.key) }}>⟳</button>
          <button type="button" className={css.miniDanger} title="删除" aria-label={`删除 ${k.key}`}
            onClick={() =>{  onDelete(k.key) }}>✕</button>
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
          <span className={css.folderChevron}>{open ? '▾' : '▸'}</span>
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
  const [search, setSearch] = useState('')
  const [cliOpen, setCliOpen] = useState(false)
  const [cliInput, setCliInput] = useState('')
  const [cliOutput, setCliOutput] = useState<string>('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [newKeyDraft, setNewKeyDraft] = useState<NewKeyDraft>({ key: '', type: 'string', value: '' })
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

  /** 懒加载某个 db 的键(SCAN 一页;带当前搜索过滤),写入该 db 缓存。 */
  const loadKeysForDb = useCallback(async (connId: string, db: number) => {
    const match = search.trim()
    patchDbList(db, { loading: true, error: null })
    try {
      const result = await redisScan(connId, 0, match === '' ? undefined : match)
      patchDbList(db, { keys: result.keys, cursor: result.cursor, loading: false, error: null, match })
    } catch (e: unknown) {
      patchDbList(db, { loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [search, patchDbList])

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
    const match = search.trim()
    // 缓存命中(键 + 搜索匹配一致):不重复请求;若该 db 恰有在途刷新,其落盘
    // 更新同样会刷新本条记录,跳过是安全的。
    if (cached !== undefined && cached.match === match) return
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db)])
  }

  /** 重新加载某个 db 的键与总数(错误重试 / 刷新钮共用)。 */
  const reloadDb = async (db: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db)])
  }

  /** 重新加载当前展开 db(键操作 / CLI / 清空后的数据同步)。 */
  const refreshExpanded = async (connId: string) => {
    /* v8 ignore next -- 调用方全部保证展开态:键行/刷新钮仅在展开时可用 */
    if (expandedDb === null) return
    await Promise.all([refreshSizeForDb(connId, expandedDb), loadKeysForDb(connId, expandedDb)])
  }

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

  const flushDb = async () => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    const target = expandedDb ?? activeDb
    if (!window.confirm(`FLUSHDB — 将删除 db${target} 全部 key,继续?`)) return
    try {
      await redisFlushDB(connId)
      setOpenValue(null)
      notify(`db${target} 已清空`)
      await syncAfterMutation(connId)
    } catch (e: unknown) {
      notify(`清空 DB 失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const createKey = async () => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    const key = newKeyDraft.key.trim()
    /* v8 ignore next -- 空 key 时创建按钮 disabled,守卫生不可达 */
    if (key === '') return
    try {
      await redisExecute(connId, `SET ${key} '${newKeyDraft.value.replace(/'/g, "\\'")}'`)
      setNewKeyOpen(false)
      setNewKeyDraft({ key: '', type: 'string', value: '' })
      notify('Key 已创建')
      await syncAfterMutation(connId)
    } catch (e: unknown) {
      notify(`创建失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const runCli = async () => {
    const connId = connRef.current
    const command = cliInput.trim()
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null || command === '') return
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
    if (search.trim() !== '') return allFolderPaths(keyTree)
    if (expandedDb === null) return EMPTY_FOLDER_PATHS
    return expandedKeys.get(expandedDb) ?? EMPTY_FOLDER_PATHS
  }, [keyTree, expandedKeys, expandedDb, search])

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
                <input className={css.searchInput} placeholder="搜索 key…" value={search} disabled={!connected}
                  onChange={(e) =>{  setSearch(e.target.value) }} aria-label="搜索 key" />
                <button type="button" className={css.iconButton} title="刷新" aria-label="刷新"
                  disabled={!connected || expandedDb === null || expandedEntry?.loading === true}
                  /* v8 ignore next -- 刷新钮在未展开/未连接时 disabled,守卫分支不可达 */
                  onClick={() => { const c = connRef.current; if (c !== null) void refreshExpanded(c) }}>⟳</button>
                <button type="button" className={css.iconButton} title="清空 DB" aria-label="清空 DB"
                  disabled={!connected} onClick={() => void flushDb()}>⌀</button>
                <button type="button" className={css.iconButton} title="CLI" aria-label="CLI"
                  disabled={!connected} onClick={() =>{  setCliOpen(v => !v) }}>⌨</button>
                <button type="button" className={css.primaryButton} title="新建 Key" aria-label="新建 Key"
                  disabled={!connected} onClick={() =>{  setNewKeyOpen(true) }}>＋</button>
              </div>

              <div className={css.dbTree} role="tree" aria-label="DB 列表">
                {DB_INDEXES.map(db => {
                  const open = expandedDb === db
                  const entry = dbLists.get(db)
                  return (
                    <div className={css.dbNode} key={db} role="treeitem">
                      <div className={css.dbRow}>
                        <button type="button" className={css.keyMain} onClick={() =>{  void toggleDb(db) }}
                          aria-expanded={open} aria-label={`数据库 db${db}`}>
                          <span className={css.folderChevron}>{open ? '▾' : '▸'}</span>
                          <span className={css.dbName}>db{db}</span>
                          {entry !== undefined && <span className={css.folderCount}>{entry.size.toLocaleString()}</span>}
                        </button>
                      </div>
                      {open && (
                        <div className={css.dbChildren}>
                          {(entry === undefined || entry.loading) && <div className={css.dbStatus}>加载键…</div>}
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
                          {entry !== undefined && !entry.loading && entry.error === null && entry.keys.length > 0 && (
                            <div className={css.keyList}>
                              {keyTree.map(node => (
                                <KeyTreeRow key={node.path} node={node} depth={0} expanded={expandedFolders}
                                  onToggle={(path) => toggleKeyFolder(db, path)} onOpen={openKey}
                                  onRename={(key) => { setRenaming(key); setRenameTo(key) }}
                                  onDelete={key => void deleteKey(key)} />
                              ))}
                            </div>
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
                  connId={id}
                  openRef={(open) => { open(openValue.key, openValue.type) }}
                />
              ) : (
                <div className={css.placeholder}>选择一个 key 查看 / 编辑</div>
              )}
            </div>
          </div>
        )}

        {newKeyOpen && (
          <div className={css.modalBackdrop}>
            <div className={css.modal}>
              <div className={css.modalTitle}>新建 Key</div>
              <input className={css.searchInput} placeholder="key 名" aria-label="key 名"
                value={newKeyDraft.key} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, key: e.target.value })) }} />
              <input className={css.searchInput} placeholder="值(string)" aria-label="值(string)"
                value={newKeyDraft.value} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, value: e.target.value })) }} />
              <div className={css.modalActions}>
                <button type="button" className={css.secondaryButton} onClick={() =>{  setNewKeyOpen(false) }}>取消</button>
                <button type="button" className={css.primaryButton} disabled={newKeyDraft.key.trim() === ''} onClick={() => void createKey()}>创建</button>
              </div>
            </div>
          </div>
        )}

        {toast !== null && <div className={css.toast}>{toast}</div>}
      </section>
    </div>
  )
}