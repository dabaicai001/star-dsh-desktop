/**
 * Native SFTP file-transfer panel for the shell SSH/SFTP overlay.
 *
 * Mirrors the Vue `SftpPanel.vue` behavior: directory browse with breadcrumbs /
 * path editing / hidden toggle, single + ctrl/shift multi-select, context menu
 * (open / download / upload / new-folder / rename / delete / copy path), streamed
 * upload & download through the shared TransferManager, and a live transfer list
 * with pause / resume / cancel / retry.
 *
 * It reuses the terminal's live SSH session (`sessionId`): SFTP never re-auths,
 * it just opens the SFTP subsystem channel via `sftp_ensure_session`. When the
 * terminal is not connected yet the panel shows a waiting state.
 *
 * @module StarHub SFTP panel (client)
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  IconDownloadOutline16, IconFolderOpenOutline16, IconLinkOutline16,
  IconPlusOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import { isTauriRuntime } from '../settings/services.ts'
import type { RustAsset } from '../store.ts'
import {
  sftpList, sftpEnsureSession, sftpStartUpload, sftpStartDownload, sftpCancelTransfer,
  sftpPauseTransfer, sftpResumeTransfer, sftpRetryTransfer, sftpRemove, sftpRename, sftpListTransfers,
  joinPath, parentPath, formatSize,
  type SftpEntry, type TransferProgressEvent, type TransferStatusEvent, type TransferTask,
} from './sftp-service.ts'
import css from './SftpPanel.module.css'

/** Props: the SSH asset (config source) and the live terminal session to reuse. */
export interface SftpPanelProps {
  asset: RustAsset
  /** Live SSH session id (terminal owns it; SFTP reuses the channel). */
  sessionId: string
  /** Terminal connected state; the panel operates only once it is true. */
  sshConnected: boolean
  /** Terminal current working dir for the follow-terminal toggle. */
  sshCwd?: string
  /** Fired when the follow-terminal toggle flips; enables OSC 7 injection. */
  onFollowTerminal?: (enabled: boolean) => void
}

const FOLLOW_TERMINAL_KEY = 'starhub.sftp.followTerminal'

/** Small right-click menu model. */
interface MenuState {
  x: number
  y: number
  entry: SftpEntry | null
}

type FileDialog =
  | { mode: 'create-folder'; value: string }
  | { mode: 'rename'; entry: SftpEntry; value: string }
  | { mode: 'delete'; paths: string[] }

/** Open a native file/dir picker through the dialog plugin; null when cancelled/preview. */
async function pickPath(kind: 'file' | 'folder' | 'files'): Promise<string[] | null> {
  if (!isTauriRuntime()) return null
  const res = await tauriInvoke<string | string[] | null>('plugin:dialog|open', {
    options: {
      directory: kind === 'folder',
      multiple: kind === 'files',
    },
  })
  if (res === null) return null
  return Array.isArray(res) ? res : [res]
}

/**
 * Render the SFTP panel body (status bar + toolbar + file list + transfer list).
 * @param props - asset, live terminal session id, connected state and cwd.
 * @returns the SFTP panel markup.
 */
export function SftpPanel({ asset, sessionId, sshConnected, sshCwd, onFollowTerminal }: SftpPanelProps) {
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  // SFTP opens at the terminal's current directory by default; users can pause follow explicitly.
  const [followTerminal, setFollowTerminal] = useState(true)
  const [pathEditing, setPathEditing] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState(-1)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [transfers, setTransfers] = useState<TransferTask[]>([])
  const [showTransfers, setShowTransfers] = useState(false)
  const [fileDialog, setFileDialog] = useState<FileDialog | null>(null)

  const pathInputRef = useRef<HTMLInputElement>(null)
  const loadIdRef = useRef(0)
  const connectedRef = useRef(false)
  const sshCwdRef = useRef(sshCwd)
  sshCwdRef.current = sshCwd

  // ---- connect the SFTP channel on the live session ----
  useEffect(() => {
    if (!sshConnected) {
      setConnected(false)
      connectedRef.current = false
      return
    }
    const abort = new AbortController()
    const isAborted = (): boolean => abort.signal.aborted
    setConnecting(true)
    setError(null)
    void (async () => {
      try {
        const info = await sftpEnsureSession(sessionId)
        if (isAborted()) return
        connectedRef.current = true
        setConnected(true)
        // Prefer the terminal cwd so an opened SFTP panel immediately mirrors the live SSH shell.
        const cwd = sshCwdRef.current
        let initialPath = cwd?.startsWith('/') ? cwd : '/'
        if (initialPath === '/') {
          try {
            const dir = await tauriInvoke<string>('sftp_home_dir', { id: sessionId })
            if (dir.startsWith('/')) initialPath = dir
          } catch { /* home lookup is optional; root remains usable */ }
        }
        if (!isAborted()) void loadDir(initialPath)
        if (info?.mode === 'fallback_exec' && info.server_path) {
          // non-fatal diagnostic; surface in the toolbar title if needed
        }
      } catch (caught) {
        if (!abort.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      } finally {
        if (!abort.signal.aborted) setConnecting(false)
      }
    })()
    return () => { abort.abort() }
  }, [sessionId, sshConnected])

  // ---- transfer event listeners (global; filter by our session) ----
  useEffect(() => {
    let unstatus: TauriUnlisten | undefined
    let unprogress: TauriUnlisten | undefined
    void tauriListen<TransferStatusEvent>('sftp://transfer-status', (ev) => {
      if (ev.sessionId !== sessionId) return
      setTransfers((prev) => {
        const found = prev.findIndex(t => t.id === ev.transferId)
        if (found === -1) {
          return [...prev, {
            id: ev.transferId, sessionId, direction: ev.direction, files: [],
            status: ev.status, totalBytes: 0, transferredBytes: 0, error: ev.error ?? null,
          }]
        }
        const next = prev.slice()
        const existing = next[found]
        if (existing === undefined) return prev
        const err = ev.error ?? null
        next[found] = {
          id: existing.id,
          sessionId: existing.sessionId,
          direction: existing.direction,
          files: existing.files,
          status: ev.status,
          totalBytes: existing.totalBytes,
          transferredBytes: existing.transferredBytes,
          ...(err !== null ? { error: err } : {}),
        }
        // completed/cancelled/failed transfers clear from the list after a beat
        if (ev.status === 'done' || ev.status === 'cancelled' || ev.status === 'failed') {
          setTimeout(() => {
            setTransfers(cur => cur.filter(t => t.id !== ev.transferId))
          }, 4000)
        }
        return next
      })
    }).then((off) => { unstatus = off })
    void tauriListen<TransferProgressEvent>('sftp://transfer-progress', (ev) => {
      setTransfers(prev => prev.map(t => t.id === ev.transferId
        ? { ...t, transferredBytes: ev.transferred, totalBytes: ev.total || t.totalBytes }
        : t))
    }).then((off) => { unprogress = off })
    // seed with any existing tasks
    void sftpListTransfers(sessionId).then(setTransfers).catch(() => {})
    return () => {
      void unstatus?.()
      void unprogress?.()
    }
  }, [sessionId])

  const visibleEntries = useMemo(
    () => showHidden ? entries : entries.filter(e => !e.name.startsWith('.')),
    [entries, showHidden],
  )

  // ---- directory helpers ----
  async function loadDir(target: string): Promise<void> {
    if (!connectedRef.current) return
    setMenu(null)
    setSelected(new Set())
    setLoading(true)
    const thisId = ++loadIdRef.current
    try {
      const list = await sftpList(sessionId, target)
      if (thisId !== loadIdRef.current) return
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(list)
      setPath(target)
    } catch (caught) {
      if (thisId !== loadIdRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (thisId === loadIdRef.current) setLoading(false)
    }
  }

  function navigateUp(): void { void loadDir(parentPath(path)) }
  function refresh(): void { void loadDir(path) }
  function navigateTo(entry: SftpEntry): void { if (entry.isDir) void loadDir(joinPath(path, entry.name)) }

  // ---- follow terminal cwd ----
  function toggleFollow(): void {
    const next = !followTerminal
    setFollowTerminal(next)
    try { localStorage.setItem(FOLLOW_TERMINAL_KEY, String(next)) } catch { /* ignore unavailable browser storage */ }
    onFollowTerminal?.(next)
    if (next && sshCwd !== undefined && sshCwd !== '' && sshCwd !== path && connectedRef.current) {
      void loadDir(sshCwd)
    }
  }
  useEffect(() => {
    if (!followTerminal || !connectedRef.current) return
    if (sshCwd === undefined || !sshCwd.startsWith('/') || sshCwd === path) return
    void loadDir(sshCwd)
  }, [sshCwd, followTerminal])

  // ---- selection ----
  function onFileClick(entry: SftpEntry, index: number, event: ReactMouseEvent): void {
    if (entry.isDir && !event.ctrlKey && !event.metaKey && !event.shiftKey) { navigateTo(entry); return }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected)
      if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path)
      setSelected(next)
    } else if (event.shiftKey && lastClicked >= 0) {
      const start = Math.min(lastClicked, index)
      const end = Math.max(lastClicked, index)
      const next = new Set(selected)
      for (let i = start; i <= end; i++) { const e = visibleEntries[i]; if (e) next.add(e.path) }
      setSelected(next)
    } else {
      setSelected(new Set([entry.path]))
    }
    setLastClicked(index)
  }

  // ---- transfers ----
  async function startUpload(localPaths: string[], dest: string): Promise<void> {
    if (localPaths.length === 0) return
    try {
      await sftpStartUpload(sessionId, localPaths, dest)
      setTimeout(() => { void loadDir(path) }, 2000)
    } catch (caught) {
      setError(`Upload failed: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  async function uploadFiles(): Promise<void> {
    setMenu(null)
    try {
      const picked = await pickPath('files')
      if (picked !== null) await startUpload(picked, path)
    } catch (caught) {
      setError(`无法打开上传文件选择器: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  async function uploadFolder(): Promise<void> {
    setMenu(null)
    try {
      const picked = await pickPath('folder')
      if (picked !== null) await startUpload(picked, path)
    } catch (caught) {
      setError(`无法打开上传文件夹选择器: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  async function download(pick: string[] | null, entry: SftpEntry | null): Promise<void> {
    const paths = (pick !== null && pick.length > 0) ? pick
      : (entry ? [entry.path] : [...selected])
    if (paths.length === 0) return
    try {
      const dir = await pickPath('folder')
      if (dir === null || dir[0] === undefined) return
      await sftpStartDownload(sessionId, paths, dir[0])
    } catch (caught) {
      setError(`无法开始下载: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  function newFolder(): void {
    setMenu(null)
    setFileDialog({ mode: 'create-folder', value: 'new-folder' })
  }
  function rename(entry: SftpEntry): void {
    setMenu(null)
    setFileDialog({ mode: 'rename', entry, value: entry.name })
  }
  function remove(entry: SftpEntry | null): void {
    setMenu(null)
    const paths = selected.size > 0 ? [...selected] : (entry ? [entry.path] : [])
    if (paths.length > 0) setFileDialog({ mode: 'delete', paths })
  }
  async function submitFileDialog(): Promise<void> {
    if (fileDialog === null) return
    const dialog = fileDialog
    if (dialog.mode !== 'delete' && dialog.value.trim() === '') return
    setFileDialog(null)
    try {
      if (dialog.mode === 'create-folder') {
        await tauriInvoke<void>('sftp_mkdir', { id: sessionId, path: joinPath(path, dialog.value.trim()) })
      } else if (dialog.mode === 'rename') {
        if (dialog.value.trim() === dialog.entry.name) return
        await sftpRename(sessionId, dialog.entry.path, joinPath(parentPath(dialog.entry.path), dialog.value.trim()))
      } else {
        for (const target of dialog.paths) await sftpRemove(sessionId, target)
        setSelected(new Set())
      }
      await loadDir(path)
    } catch (caught) {
      setError(`File operation failed: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  function copyPath(entry: SftpEntry): void {
    setMenu(null)
    void navigator.clipboard.writeText(entry.path)
  }

  // ---- context menu ----
  function onContextMenu(event: ReactMouseEvent, entry: SftpEntry | null): void {
    event.preventDefault()
    if (entry !== null && !selected.has(entry.path)) setSelected(new Set([entry.path]))
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }

  const pathSegments = path.split('/').filter(Boolean)

  return (
    <div className={css.panel}>
      {/* status bar */}
      <div className={css.statusBar}>
        <span className={`${css.dot} ${connected ? css.online : (connecting ? css.connecting : (error ? css.error : css.offline))}`} />
        <span className={css.statusLabel}>SFTP</span>
        <span className={css.hostLabel}>{asset.name}</span>
        {!sshConnected && <span className={css.waiting}>等待终端连接…</span>}
      </div>

      {/* non-connected / error / connecting states */}
      {connecting && <div className={css.stateOverlay}>连接中…</div>}
      {!connected && !connecting && error !== null && (
        <div className={`${css.stateOverlay} ${css.error}`}>
          <pre role="alert">{error}</pre>
          <button type="button" onClick={() =>{  setError(null) }}>RETRY</button>
        </div>
      )}
      {!connected && !connecting && error === null && (
        <div className={css.stateOverlay}>
          <span className={css.stateIcon} aria-hidden="true"><IconFolderOpenOutline16 size={18} /></span>
          <strong>{sshConnected ? '正在准备 SFTP 文件通道' : '终端未连接，SFTP 等待 SSH 会话连接'}</strong>
          <span>{sshConnected ? '正在复用当前 SSH 会话，请稍候。' : '终端连接成功后，文件浏览与传输会自动可用。'}</span>
        </div>
      )}

      {connected && (
        <>
          {/* toolbar */}
          <div className={css.toolbar}>
            <div className={css.toolGroup}>
              <button type="button" className={css.tbBtn} title="上级目录" aria-label="上级目录" onClick={navigateUp}><IconFolderOpenOutline16 size={15} /></button>
              <button type="button" className={css.tbBtn} title="刷新" aria-label="刷新" disabled={loading} onClick={refresh}><IconRefreshOutline16 size={15} /></button>
              <button type="button" className={`${css.tbBtn} ${showHidden ? css.active : ''}`} title="显示隐藏文件" aria-label="显示隐藏文件" onClick={() =>{  setShowHidden(v => !v) }}><IconLinkOutline16 size={15} /></button>
            </div>
            <div className={css.toolGroup}>
              <button type="button" className={css.tbBtn} title="上传文件" aria-label="上传文件" onClick={() => void uploadFiles()}><IconPlusOutline16 size={15} /></button>
              <button type="button" className={css.tbBtn} title="上传文件夹" aria-label="上传文件夹" onClick={() => void uploadFolder()}><IconFolderOpenOutline16 size={15} /></button>
              <button type="button" className={css.tbBtn} title="下载" aria-label="下载" disabled={selected.size === 0} onClick={() => void download(null, null)}><IconDownloadOutline16 size={15} /></button>
              <button type="button" className={css.tbBtn} title="新建文件夹" aria-label="新建文件夹" onClick={newFolder}><IconPlusOutline16 size={15} /></button>
            </div>
            <div className={`${css.toolGroup} ${css.toolsEnd}`}>
              <button type="button" className={`${css.tbBtn} ${followTerminal ? css.active : ''}`} title={followTerminal ? '已跟随终端路径' : '跟随终端路径'} aria-label="跟随终端路径" disabled={!sshConnected} onClick={toggleFollow}><IconLinkOutline16 size={15} /></button>
              <button type="button" className={css.tbBtn} title="传输任务" aria-label="传输任务" onClick={() =>{  setShowTransfers(v => !v) }}><IconFolderOpenOutline16 size={15} /></button>
            </div>
          </div>

          {/* breadcrumb / path input */}
          {pathEditing ? (
            <div className={css.breadcrumb}>
              <input
                ref={pathInputRef}
                className={css.pathInput}
                value={pathInput}
                spellCheck={false}
                autoFocus
                onChange={(e) =>{  setPathInput(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setPathEditing(false); const t = pathInput.trim(); if (t && t !== path) void loadDir(t.startsWith('/') || t.startsWith('~') ? t : `/${t}`) }
                  if (e.key === 'Escape') setPathEditing(false)
                }}
                onBlur={() =>{  setPathEditing(false) }}
              />
            </div>
          ) : (
            <div className={css.breadcrumb} title="点击当前路径段可编辑路径" onClick={() => { setPathInput(path); setPathEditing(true) }}>
              {path === '/' ? <span className={css.crumb}>/</span> : pathSegments.map((seg, i) => (
                <span
                  key={i}
                  className={css.crumb}
                  title={i === pathSegments.length - 1 ? '点击编辑路径' : `进入 /${pathSegments.slice(0, i + 1).join('/')}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (i === pathSegments.length - 1) { setPathInput(path); setPathEditing(true) }
                    else void loadDir('/' + pathSegments.slice(0, i + 1).join('/'))
                  }}
                >
                  / {seg}
                </span>
              ))}
            </div>
          )}

          {/* file list */}
          <div className={css.fileList} onClick={() =>{  setMenu(null) }} onContextMenu={(e) =>{  onContextMenu(e, null) }}>
            {loading && <div className={css.listLoading}>加载中…</div>}
            {!loading && visibleEntries.length === 0 && <div className={css.listEmpty}>空目录</div>}
            {!loading && visibleEntries.length > 0 && path !== '/' && (
              <div className={css.fileRow} onClick={navigateUp} onContextMenu={(e) =>{  onContextMenu(e, null) }}>
                <span className={`${css.fileIcon} ${css.dir}`}><IconFolderOpenOutline16 size={15} /></span>
                <span className={css.fileName}>..</span>
              </div>
            )}
            {!loading && visibleEntries.map((entry, index) => (
              <div
                key={entry.path}
                className={`${css.fileRow} ${selected.has(entry.path) ? css.selected : ''}`}
                onClick={(e) =>{  onFileClick(entry, index, e) }}
                onContextMenu={(e) =>{  onContextMenu(e, entry) }}
              >
                <span className={`${css.fileIcon} ${entry.isDir ? css.dir : ''}`}>{entry.isDir ? <IconFolderOpenOutline16 size={15} /> : <IconLinkOutline16 size={14} />}</span>
                <span className={css.fileName}>{entry.name}</span>
                <span className={css.fileSize}>{entry.isDir ? '—' : formatSize(entry.size)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* transfers */}
      {showTransfers && (
        <div className={css.transfers}>
          <div className={css.transfersHead}>传输任务</div>
          {transfers.length === 0 && <div className={css.transferEmpty}>暂无任务</div>}
          {transfers.map((t) => {
            const pct = t.totalBytes > 0 ? Math.round((t.transferredBytes / t.totalBytes) * 100) : 0
            return (
              <div key={t.id} className={css.transferRow}>
                <span className={css.transferName}>{t.direction === 'upload' ? '↑ 上传' : '↓ 下载'}</span>
                <span className={css.transferStatus}>{t.status}{t.error ? ` · ${t.error}` : ''}</span>
                <span className={css.transferProgress}>{pct}% ({formatSize(t.transferredBytes)} / {formatSize(t.totalBytes)})</span>
                {t.status === 'running' && <button type="button" onClick={() => void sftpPauseTransfer(sessionId, t.id)}>暂停</button>}
                {t.status === 'paused' && <button type="button" onClick={() => void sftpResumeTransfer(sessionId, t.id)}>继续</button>}
                {(t.status === 'failed' || t.status === 'cancelled') && <button type="button" onClick={() => void sftpRetryTransfer(sessionId, t.id)}>重试</button>}
                <button type="button" onClick={() => void sftpCancelTransfer(sessionId, t.id)}>取消</button>
              </div>
            )
          })}
        </div>
      )}

      {/* context menu */}
      {menu !== null && (
        <div
          className={css.menuBackdrop}
          onMouseDown={() =>{  setMenu(null) }}
          onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
        >
          <div className={css.contextMenu} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) =>{  e.stopPropagation() }}>
            {menu.entry !== null && menu.entry.isDir && (
              <button type="button" className={css.menuItem} onClick={() => { const e = menu.entry; setMenu(null); if (e) navigateTo(e) }}>打开</button>
            )}
            <button type="button" className={css.menuItem} onClick={() => { const e = menu.entry; setMenu(null); void download(null, e) }}>下载</button>
            {menu.entry === null && (
              <>
                <span className={css.menuDivider} />
                <button type="button" className={css.menuItem} onClick={() => void uploadFiles()}>上传文件</button>
                <button type="button" className={css.menuItem} onClick={() => void uploadFolder()}>上传文件夹</button>
                <button type="button" className={css.menuItem} onClick={newFolder}>新建文件夹</button>
              </>
            )}
            {menu.entry !== null && selected.size <= 1 && (
              <button type="button" className={css.menuItem} onClick={() => { const e = menu.entry; if (e) rename(e) }}>重命名</button>
            )}
            <button type="button" className={`${css.menuItem} ${css.danger}`} onClick={() => { const e = menu.entry; remove(e) }}>删除</button>
            {menu.entry !== null && selected.size <= 1 && (
              <button type="button" className={css.menuItem} onClick={() => { const e = menu.entry; if (e) copyPath(e) }}>复制路径</button>
            )}
          </div>
        </div>
      )}
      {fileDialog !== null && (
        <div className={css.fileDialogBackdrop} role="presentation" onMouseDown={() =>{  setFileDialog(null) }}>
          <section className={css.fileDialog} role="dialog" aria-modal="true" aria-label={fileDialog.mode === 'delete' ? '确认删除' : fileDialog.mode === 'rename' ? '重命名' : '新建文件夹'} onMouseDown={(event) =>{  event.stopPropagation() }}>
            <div className={css.fileDialogHead}>{fileDialog.mode === 'delete' ? '确认删除' : fileDialog.mode === 'rename' ? '重命名' : '新建文件夹'}</div>
            {fileDialog.mode === 'delete' ? <p>将永久删除 {fileDialog.paths.length} 个项目，无法恢复。</p> : (
              <input autoFocus className={css.fileDialogInput} value={fileDialog.value} onChange={(event) =>{  setFileDialog({ ...fileDialog, value: event.target.value }) }} onKeyDown={(event) => { if (event.key === 'Enter') void submitFileDialog(); if (event.key === 'Escape') setFileDialog(null) }} />
            )}
            <div className={css.fileDialogActions}>
              <button type="button" onClick={() =>{  setFileDialog(null) }}>取消</button>
              <button type="button" className={fileDialog.mode === 'delete' ? css.dangerAction : css.primaryAction} onClick={() => void submitFileDialog()}>{fileDialog.mode === 'delete' ? '删除' : '确认'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default SftpPanel
