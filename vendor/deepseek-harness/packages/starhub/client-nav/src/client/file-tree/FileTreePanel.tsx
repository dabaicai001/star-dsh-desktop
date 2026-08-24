/**
 * 项目文件目录树(2026-08-24):右侧详情列的文件树视图,以会话 cwd 为根,
 * 懒加载展开目录(展开时经 `local_list_directory` 拉取子项,带缓存)。
 *
 * 交互:
 * - 目录行点击展开/收起;文件行点击弹出 FileInfoDialog(元信息 + 内容预览);
 * - 行右键菜单:引用文件/文件夹(把 `@名称 (路径)` 追加进对话框输入框,
 *   让 AI 做专项修改)、复制路径、查看信息(仅文件);
 * - 面板顶部搜索框:文件名模糊匹配(默认)或文件内容检索(切换 mode),
 *   命中即替换树视图;点结果文件看信息、右键可引用;
 * - 头部显示根路径 + 「返回资产列表」。
 *
 * 本组件是纯展示 + 交互,数据源/写输入框全部经 props 注入(不直接摸
 * Tauri/会话服务),便于组件测试与 HMR。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconCopyOutline16, IconFolderClose16, IconFolderOpen16, IconRightUpOutline16,
  IconSearchOutline16, writeClipboard, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ContextMenu, useContextMenu } from '../ContextMenu.tsx'
import { FileInfoDialog, renderFileReference } from './FileInfoDialog.tsx'
import { listLocalDirectory, type LocalFileEntry } from './file-tree-service.ts'
import { searchLocalFiles, type LocalSearchHit } from './file-search-service.ts'
import css from './FileTreePanel.module.css'

/** 右键菜单目标(树行或搜索结果行;目录引用加斜杠)。 */
interface MenuTarget {
  readonly path: string
  readonly name: string
  readonly kind: 'directory' | 'file'
}

/** 排序:目录在前,文件在后,各自按名称升序(Rust 侧已按名排,这里再分组)。 */
function sortEntries(entries: readonly LocalFileEntry[]): LocalFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === 'directory' && b.kind !== 'directory') return -1
    if (a.kind !== 'directory' && b.kind === 'directory') return 1
    return a.name.localeCompare(b.name)
  })
}

/** 搜索关键词去空白后的有效查询(空 = 不搜索)。 */
function normalizedQuery(query: string): string {
  return query.trim()
}

/**
 * 渲染项目文件目录树。
 * @param props.cwd - 会话工作区绝对路径(树的根)。
 * @param props.onClose - 返回资产列表(关闭文件树视图)。
 * @param props.insertReference - 把引用文本追加进当前会话对话框输入框。
 * @returns 目录树面板(含文件信息弹窗与搜索)。
 */
export function FileTreePanel({ cwd, onClose, insertReference }: {
  cwd: string
  onClose: () => void
  insertReference: (text: string) => void
}) {
  const menu = useContextMenu()
  /** 展开中的目录路径(懒加载;关闭目录不丢弃缓存)。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  /** 已加载的目录条目缓存(path → entries)。 */
  const [cache, setCache] = useState<ReadonlyMap<string, readonly LocalFileEntry[]>>(() => new Map())
  /** 加载中的目录路径(避免重复请求)。 */
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set())
  /** 目录加载失败的错误信息(path → error)。 */
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  /** 右键菜单目标行;null = 菜单关闭。 */
  const [target, setTarget] = useState<MenuTarget | null>(null)
  /** 文件信息弹窗目标路径;null = 弹窗关闭。 */
  const [infoPath, setInfoPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  /** 搜索关键词(原样输入)。 */
  const [query, setQuery] = useState('')
  /** 搜索模式:文件名 / 内容。 */
  const [mode, setMode] = useState<'name' | 'content'>('name')
  /** 搜索结果;null = 未搜索(树视图)。 */
  const [hits, setHits] = useState<readonly LocalSearchHit[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  /** 搜索代次:新输入使旧请求的结果作废。 */
  const searchGeneration = useRef(0)
  /** 已自动展开过的根目录(避免失败后 loading 移除导致 expand 重建 → effect 重跑 → 无限重发)。 */
  const autoExpandedRoot = useRef<string | null>(null)

  /** 展开一个目录:标记展开并(缓存未命中时)拉取子项。 */
  const expand = useCallback((path: string) => {
    setExpanded(prev => new Set(prev).add(path))
    if (cache.has(path) || loading.has(path)) return
    setLoading(prev => new Set(prev).add(path))
    listLocalDirectory(path)
      .then((entries) => {
        setCache(prev => new Map(prev).set(path, entries))
        setErrors(prev => {
          if (!prev.has(path)) return prev
          const next = new Map(prev)
          next.delete(path)
          return next
        })
      })
      .catch((error: unknown) => {
        setErrors(prev => new Map(prev).set(path, error instanceof Error ? error.message : String(error)))
      })
      .finally(() => {
        setLoading(prev => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      })
  }, [cache, loading])

  /** 收起一个目录。 */
  const collapse = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [])

  // 挂载与 cwd 变化时自动展开根目录(懒加载第一层)。同一 cwd 只自动展开
  // 一次:读取失败时 loading 的移除会让 expand 重建并重跑本 effect,若不
  // 拦截会形成「失败 → 再请求 → 再失败」的无限循环(CPU 满载)。
  useEffect(() => {
    if (autoExpandedRoot.current === cwd) return
    autoExpandedRoot.current = cwd
    expand(cwd)
  }, [cwd, expand])

  // 搜索:query/mode 变化时触发;空 query 回到树视图。
  useEffect(() => {
    const needle = normalizedQuery(query)
    if (needle === '') {
      searchGeneration.current += 1
      setHits(null)
      setSearchError(null)
      return
    }
    const generation = ++searchGeneration.current
    setHits(null)
    setSearchError(null)
    searchLocalFiles(cwd, needle, mode)
      .then((result) => {
        if (generation !== searchGeneration.current) return
        setHits(result)
      })
      .catch((error: unknown) => {
        if (generation !== searchGeneration.current) return
        setSearchError(error instanceof Error ? error.message : String(error))
        setHits(null)
      })
  }, [cwd, query, mode])

  /** 目录行点击:加载失败过的目录 = 重试(不收起);否则展开/收起。 */
  const toggleDirectory = useCallback((entry: LocalFileEntry) => {
    /* v8 ignore next 1 -- only directory rows reach this callback; file rows route to the info dialog */
    if (entry.kind !== 'directory') return
    if (errors.has(entry.path)) {
      expand(entry.path)
      return
    }
    if (expanded.has(entry.path)) collapse(entry.path)
    else expand(entry.path)
  }, [errors, expanded, expand, collapse])

  /** 树行右键:记录目标并打开菜单(使用真实指针坐标)。 */
  const onRowContextMenu = useCallback((entry: LocalFileEntry, e: MouseEvent) => {
    setTarget({ path: entry.path, name: entry.name, kind: entry.kind === 'directory' ? 'directory' : 'file' })
    menu.onContextMenu(e)
  }, [menu])

  /** 搜索结果行右键:目标来自命中(内容模式可带行号)。 */
  const onHitContextMenu = useCallback((hit: LocalSearchHit, e: MouseEvent) => {
    setTarget({ path: hit.path, name: hit.name, kind: hit.kind === 'directory' ? 'directory' : 'file' })
    menu.onContextMenu(e)
  }, [menu])

  const onSelect = (id: string) => {
    /* v8 ignore next 1 -- the menu only selects while open, so `target` is always set here */
    if (target === null) return
    if (id === 'reference') {
      insertReference(renderFileReference(target.name, target.path, target.kind))
    } else if (id === 'copy') {
      void writeClipboard(target.path).then((ok) => { if (ok) setCopied(true) })
    } else if (id === 'info') {
      setInfoPath(target.path)
    }
    setTarget(null)
  }

  const menuItems: MenuEntry[] = [
    { id: 'reference', label: target?.kind === 'directory' ? '引用文件夹' : '引用文件', icon: <IconRightUpOutline16 /> },
    { id: 'copy', label: copied ? '已复制路径' : '复制路径', icon: <IconCopyOutline16 /> },
  ]
  if (target?.kind === 'file') {
    menuItems.push({ type: 'separator', id: 'file-info-separator' })
    menuItems.push({ id: 'info', label: '查看信息', icon: <IconRightUpOutline16 /> })
  }

  const rootName = cwd.split(/[\\/]/).at(-1) ?? cwd
  const showSearching = normalizedQuery(query) !== '' && searchError === null && hits === null

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>文件树</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.iconButton}
          title="返回资产列表"
          aria-label="返回资产列表"
          onClick={onClose}
        >
          <IconCloseOutline16 size={13} />
        </button>
      </div>
      <div className={css.path} title={cwd}>{cwd}</div>
      <div className={css.searchRow}>
        <span className={css.searchIcon} aria-hidden="true">
          <IconSearchOutline16 size={12} />
        </span>
        <input
          className={css.searchInput}
          placeholder={mode === 'name' ? '搜索文件名…' : '搜索文件内容…'}
          value={query}
          onChange={(ev) => { setQuery(ev.target.value) }}
        />
        <div className={css.modeSwitch} role="group" aria-label="搜索模式">
          <button
            type="button"
            className={mode === 'name' ? css.modeActive : css.modeIdle}
            onClick={() => { setMode('name') }}
          >
            文件名
          </button>
          <button
            type="button"
            className={mode === 'content' ? css.modeActive : css.modeIdle}
            onClick={() => { setMode('content') }}
          >
            内容
          </button>
        </div>
      </div>
      <div className={css.tree}>
        {query.trim() === '' ? (
          <>
            <FileTreeNode
              name={rootName}
              path={cwd}
              kind="directory"
              depth={0}
              expanded={expanded}
              cache={cache}
              loading={loading}
              errors={errors}
              onToggle={toggleDirectory}
              onContextMenu={onRowContextMenu}
              onInfo={setInfoPath}
            />
          </>
        ) : showSearching ? (
          <div className={css.statusLine}>搜索中…</div>
        ) : searchError !== null ? (
          <div className={css.statusLineError}>{searchError}</div>
        ) : hits !== null && hits.length === 0 ? (
          <div className={css.statusLine}>无匹配结果</div>
        ) : (
          <div className={css.searchList}>
            {hits!.map(hit => (
              <SearchHitRow
                key={hit.path}
                hit={hit}
                cwd={cwd}
                onInfo={setInfoPath}
                onContextMenu={onHitContextMenu}
              />
            ))}
          </div>
        )}
      </div>
      <ContextMenu
        menu={menu}
        items={menuItems}
        onSelect={onSelect}
        className={css.menuRoot}
      />
      <FileInfoDialog
        path={infoPath}
        onClose={() => { setInfoPath(null) }}
        onReference={insertReference}
      />
    </div>
  )
}

/** 搜索结果行:图标 + 名称 + 相对路径(内容模式附匹配行)。 */
function SearchHitRow({ hit, cwd, onInfo, onContextMenu }: {
  hit: LocalSearchHit
  cwd: string
  onInfo: (path: string) => void
  onContextMenu: (hit: LocalSearchHit, e: MouseEvent) => void
}) {
  const isDir = hit.kind === 'directory'
  const relative = relativeTo(cwd, hit.path)
  return (
    <div
      className={css.rowWrap}
      onContextMenu={(e) => { onContextMenu(hit, e) }}
    >
      <button
        type="button"
        className={css.row}
        title={hit.snippet !== null ? `${hit.path}:${hit.line}\n${hit.snippet}` : hit.path}
        aria-label={isDir ? `文件夹 ${hit.name}` : hit.name}
        onClick={() => { if (!isDir) onInfo(hit.path) }}
      >
        <span className={css.chevron} />
        {isDir ? <IconFolderClose16 size={14} /> : <span className={css.fileDot} aria-hidden="true" />}
        <span className={css.hitText}>
          <span className={css.rowName}>{hit.name}</span>
          <span className={css.hitMeta}>{relative}</span>
          {hit.snippet !== null && <span className={css.hitSnippet}>{hit.snippet}</span>}
        </span>
      </button>
    </div>
  )
}

/** 相对 cwd 的展示路径(反斜杠统一为 / 便于阅读)。 */
function relativeTo(cwd: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  /* v8 ignore next 1 -- hits always come from searchLocalFiles(root); a foreign path (symlink escape) is unreachable */
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : path
}

/** 递归树节点:目录渲染子项,文件渲染叶子行。 */
function FileTreeNode({ name, path, kind, depth, expanded, cache, loading, errors, onToggle, onContextMenu, onInfo }: {
  name: string
  path: string
  kind: LocalFileEntry['kind']
  depth: number
  expanded: ReadonlySet<string>
  cache: ReadonlyMap<string, readonly LocalFileEntry[]>
  loading: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  onToggle: (entry: LocalFileEntry) => void
  onContextMenu: (entry: LocalFileEntry, e: MouseEvent) => void
  onInfo: (path: string) => void
}) {
  const entry = { name, path, kind, size: 0, modifiedAt: null, readonly: false, hidden: false }
  if (kind !== 'directory') {
    return (
      <FileRow
        entry={entry}
        depth={depth}
        expanded={false}
        onToggle={() => {}}
        onContextMenu={onContextMenu}
        onInfo={onInfo}
      />
    )
  }
  const isExpanded = expanded.has(path)
  const children = isExpanded ? sortEntries(cache.get(path) ?? []) : []
  const isRoot = depth === 0
  return (
    <>
      <FileRow
        entry={entry}
        depth={depth}
        expanded={isExpanded}
        onToggle={() => { onToggle(entry) }}
        onContextMenu={onContextMenu}
        onInfo={onInfo}
      />
      {isExpanded && (loading.has(path) || isRoot) && !cache.has(path) && (
        <div className={css.rowWrap} style={{ paddingLeft: 5 + (depth + 1) * 14 }}>
          <div className={css.statusLine}>加载中…</div>
        </div>
      )}
      {isExpanded && errors.get(path) !== undefined && (
        <div className={css.rowWrap} style={{ paddingLeft: 5 + (depth + 1) * 14 }}>
          <div className={css.statusLineError}>{errors.get(path)}</div>
        </div>
      )}
      {children.map(child => (
        <FileTreeNode
          key={child.path}
          name={child.name}
          path={child.path}
          kind={child.kind}
          depth={depth + 1}
          expanded={expanded}
          cache={cache}
          loading={loading}
          errors={errors}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
          onInfo={onInfo}
        />
      ))}
    </>
  )
}

/** 单行渲染:目录行(展开/收起箭头 + 文件夹图标)或文件行(文件图标)。 */
function FileRow({ entry, depth, expanded, onToggle, onContextMenu, onInfo }: {
  entry: LocalFileEntry
  depth: number
  expanded: boolean
  onToggle: () => void
  onContextMenu: (entry: LocalFileEntry, e: MouseEvent) => void
  onInfo: (path: string) => void
}) {
  const isDir = entry.kind === 'directory'
  return (
    <div
      className={css.rowWrap}
      style={{ paddingLeft: 5 + depth * 14 }}
      onContextMenu={(e) => { onContextMenu(entry, e) }}
    >
      <button
        type="button"
        className={css.row}
        title={isDir ? `${entry.name} (点击展开/收起)` : entry.path}
        aria-expanded={isDir ? expanded : undefined}
        aria-label={isDir ? `文件夹 ${entry.name}` : entry.name}
        onClick={() => { if (isDir) onToggle(); else onInfo(entry.path) }}
      >
        <span className={css.chevron}>
          {isDir && (expanded ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />)}
        </span>
        {isDir
          ? (expanded ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />)
          : <span className={css.fileDot} aria-hidden="true" />}
        <span className={css.rowName}>{entry.name}</span>
      </button>
    </div>
  )
}