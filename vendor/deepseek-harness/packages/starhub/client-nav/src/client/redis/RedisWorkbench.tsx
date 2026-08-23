/**
 * StarHub 原生 Redis 工作台(批次 2:Redis 工作台 React 化)。
 * 壳内全屏 overlay,替换 Vue embed RedisView。挂载按 asset.config 连
 * db_redis_connect,卸载断连。中央区:DB 切换 + 键总数 + 键列表(SCAN 分页
 * + 搜索过滤)+ 键操作(打开/重命名/删除/清空/新建)+ CLI(db_redis_execute)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RustAsset } from '../store.ts'
import { redisConnect, redisDBSize, redisDel, redisDisconnect, redisExecute, redisFlushDB, redisRename, redisScan, redisSelect, type RedisKeyInfo } from './redis-service.ts'
import { allFolderPaths, buildKeyTree, countLeaves, type KeyTreeNode } from './key-tree.ts'
import { RedisValueEditor } from './RedisValueEditor.tsx'
import css from './RedisWorkbench.module.css'

/** 键列表加载态。 */
interface Loadable {
  keys: RedisKeyInfo[]
  cursor: number
  loading: boolean
  error: string | null
}

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
 * 渲染一行树节点:文件夹行(箭头 + 段名 + 叶子计数,点击折叠/展开,子级递归)
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
  const [currentDb, setCurrentDb] = useState(0)
  const [dbSize, setDbSize] = useState(0)
  const [search, setSearch] = useState('')
  const [list, setList] = useState<Loadable>({ keys: [], cursor: 0, loading: false, error: null })
  const [cliOpen, setCliOpen] = useState(false)
  const [cliInput, setCliInput] = useState('')
  const [cliOutput, setCliOutput] = useState<string>('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [newKeyDraft, setNewKeyDraft] = useState<NewKeyDraft>({ key: '', type: 'string', value: '' })
  const [toast, setToast] = useState<string | null>(null)
  const [openValue, setOpenValue] = useState<{ key: string; type: string } | null>(null)
  // 键树文件夹展开态;null = 未初始化(首次按「全展开」呈现,与旧平铺视图等价)。
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set())
  const connRef = useRef<string | null>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    /* v8 ignore start -- toast 自动消除是时序副作用,由出现断言覆盖 */
    window.setTimeout(() =>{  setToast(cur => (cur === msg ? null : cur)) }, 2500)
    /* v8 ignore stop */
  }, [])

  const refreshSize = useCallback(async (connId: string) => {
    try {
      const { size } = await redisDBSize(connId)
      setDbSize(size)
    } catch (e: unknown) {
      notify(`获取键数失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }, [notify])

  const loadKeys = useCallback(async (connId: string) => {
    const match = search.trim() === '' ? undefined : search.trim()
    setList(prev => ({ ...prev, loading: true, error: null }))
    try {
      const result = await redisScan(connId, 0, match)
      setList({ keys: result.keys, cursor: result.cursor, loading: false, error: null })
    } catch (e: unknown) {
      setList(prev => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [search])

  // 挂载建连一次,卸载断连
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
        await Promise.all([refreshSize(info.connId), loadKeys(info.connId)])
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

  const switchDb = async (db: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    try {
      await redisSelect(connId, db)
      setCurrentDb(db)
      setOpenValue(null)
      await Promise.all([refreshSize(connId), loadKeys(connId)])
    } catch (e: unknown) {
      notify(`切换 DB 失败:${e instanceof Error ? e.message : String(e)}`)
    }
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
      await Promise.all([refreshSize(connId), loadKeys(connId)])
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
      await loadKeys(connId)
    } catch (e: unknown) {
      notify(`重命名失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const flushDb = async () => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    if (!window.confirm(`FLUSHDB — 将删除 db${currentDb} 全部 key,继续?`)) return
    try {
      await redisFlushDB(connId)
      setDbSize(0)
      setOpenValue(null)
      notify(`db${currentDb} 已清空`)
      await loadKeys(connId)
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
      await Promise.all([refreshSize(connId), loadKeys(connId)])
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
      await Promise.all([refreshSize(connId), loadKeys(connId)])
    } catch (e: unknown) {
      setCliOutput(e instanceof Error ? e.message : String(e))
    }
  }

  const openKey = useCallback((key: string, type: string) =>{  setOpenValue({ key, type }) }, [])

  // 键树:SCAN 结果按 ':' 分组;搜索态强制全展开(过滤结果直接可见)。
  const keyTree = useMemo(() => buildKeyTree(list.keys), [list.keys])
  const expandedFolders = useMemo(() => {
    const all = allFolderPaths(keyTree)
    if (search.trim() !== '') return all
    const open = new Set(all)
    for (const path of collapsedFolders) open.delete(path)
    return open
  }, [keyTree, collapsedFolders, search])

  /** 折叠/展开文件夹(默认全展开,折叠集持久在会话内)。 */
  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const id = connRef.current

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`Redis ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span className={css.title}>{asset.name}</span>
            <span className={css.statusDot}>{connected ? '已连接' : '未连接'}</span>
            <span className={css.badge}>db{currentDb}</span>
            <span className={css.keyCount}>{dbSize.toLocaleString()} keys</span>
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
                <select className={css.dbSelect} value={currentDb} disabled={!connected}
                  onChange={(e) => { void switchDb(Number(e.target.value)) }}>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(db => <option key={db} value={db}>db{db}</option>)}
                </select>
                <input className={css.searchInput} placeholder="搜索 key…" value={search} disabled={!connected}
                  onChange={(e) =>{  setSearch(e.target.value) }} aria-label="搜索 key" />
                <button type="button" className={css.iconButton} title="刷新" aria-label="刷新"
                  disabled={!connected || list.loading}
                  /* v8 ignore next -- 刷新钮在未连接时 disabled,`c === null` 分支不可达 */
                  onClick={() => { const c = connRef.current; if (c !== null) void loadKeys(c) }}>⟳</button>
                <button type="button" className={css.iconButton} title="清空 DB" aria-label="清空 DB"
                  disabled={!connected} onClick={() => void flushDb()}>⌀</button>
                <button type="button" className={css.iconButton} title="CLI" aria-label="CLI"
                  disabled={!connected} onClick={() =>{  setCliOpen(v => !v) }}>⌨</button>
                <button type="button" className={css.primaryButton} title="新建 Key" aria-label="新建 Key"
                  disabled={!connected} onClick={() =>{  setNewKeyOpen(true) }}>＋</button>
              </div>

              {list.loading && <div className={css.status}>加载键…</div>}
              {!list.loading && list.error !== null && (
                <div className={css.status}>
                  <span>加载失败:{list.error}</span>
                  <button type="button" className={css.retryButton}
                    /* v8 ignore next -- 重试钮仅在已连接的错误态出现,`c === null` 分支不可达 */
                    onClick={() => { const c = connRef.current; if (c !== null) void loadKeys(c) }}>重试</button>
                </div>
              )}
              {!list.loading && list.error === null && list.keys.length === 0 && <div className={css.status}>暂无 key。</div>}
              {!list.loading && list.error === null && list.keys.length > 0 && (
                <div className={css.keyList}>
                  {keyTree.map(node => (
                    <KeyTreeRow key={node.path} node={node} depth={0} expanded={expandedFolders}
                      onToggle={toggleFolder} onOpen={openKey}
                      onRename={(key) => { setRenaming(key); setRenameTo(key) }}
                      onDelete={key => void deleteKey(key)} />
                  ))}
                </div>
              )}
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
