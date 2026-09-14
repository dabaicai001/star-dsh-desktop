/**
 * Native SFTP file-transfer panel for the shell SSH/SFTP overlay.
 *
 * Mirrors the Vue `SftpPanel.vue` behavior: directory browse with breadcrumbs /
 * path editing / hidden toggle, single + ctrl/shift multi-select, context menu
 * (open / download / upload / new-folder / rename / delete / copy path), streamed
 * upload & download through the shared TransferManager. 传输任务列表在 2026-09-11
 * 移出面板,由 overlay 级 useTransferTasks 投影 + TransferDialog 弹框承载
 * (关面板传输不丢;本面板只保留工具栏入口按钮 + 未完成任务徽标,并经
 * uploadDoneNonce 在上传完成后刷新当前目录)。
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
  sftpList, sftpEnsureSession, sftpStartUpload, sftpStartDownload,
  sftpRemove, sftpRename,
  joinPath, parentPath, formatSize,
  type SftpEntry,
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
  /** 进行中(含暂停)的传输任务数:工具栏入口徽标。 */
  transferActiveCount?: number
  /** 打开传输任务弹框(overlay 承载)。 */
  onOpenTransfers?: () => void
  /** 上传完成 nonce(overlay 级投影在上传 done 时自增):据此刷新当前目录。 */
  uploadDoneNonce?: number
}

const FOLLOW_TERMINAL_KEY = 'starhub.sftp.followTerminal'

// Context menu is positioned at the cursor via `fixed`; keep it inside the viewport
// so a menu opened near the bottom/right of the file list is not clipped.
const MENU_ESTIMATED_HEIGHT = 220
const MENU_ESTIMATED_WIDTH = 174
const MENU_VIEWPORT_MARGIN = 8

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
export function SftpPanel({
  asset, sessionId, sshConnected, sshCwd, onFollowTerminal,
  transferActiveCount = 0, onOpenTransfers, uploadDoneNonce = 0,
}: SftpPanelProps) {
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 最后一次失败操作的重放闭包;非 null 时错误横幅给出「重试」按钮。
  // 重连类失败(通道没建起来)不走这里,由未连接覆盖层的「重试」直接重建通道。
  const [retryOp, setRetryOp] = useState<(() => void) | null>(null)
  // 重连通道 nonce:未连接覆盖层「重试」点击 +1,触发 ensure effect 重新建链。
  const [connectNonce, setConnectNonce] = useState(0)

  /** 记录一次可见失败:错误文本 + 可选的重放闭包(横幅「重试」按钮)。 */
  const failWith = (message: string, retry: (() => void) | null): void => {
    // useState 的 setter 会把函数值当 updater,必须再包一层。
    setRetryOp(retry === null ? null : () => retry)
    setError(message)
  }

  /** 关闭错误横幅(并丢弃待重试操作)。 */
  const dismissError = (): void => {
    setRetryOp(null)
    setError(null)
  }

  /** 重放最后一次失败操作。 */
  const retryFailed = (): void => {
    const op = retryOp
    dismissError()
    if (op !== null) op()
  }
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  // SFTP opens at the terminal's current directory by default; users can pause follow explicitly.
  // 开关持久化到 localStorage:缺省开,显式存过 'false' 才关(此前只写不读,刷新后恒回开)。
  const [followTerminal, setFollowTerminal] = useState(() => {
    try {
      return window.localStorage.getItem(FOLLOW_TERMINAL_KEY) !== 'false'
    } catch {
      return true
    }
  })
  const [pathEditing, setPathEditing] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState(-1)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [fileDialog, setFileDialog] = useState<FileDialog | null>(null)
  // 原生拖拽上传:OS 文件拖入窗口时显示覆盖层,drop 时把它上传到当前目录。
  const [showDropOverlay, setShowDropOverlay] = useState(false)

  const pathInputRef = useRef<HTMLInputElement>(null)
  const loadIdRef = useRef(0)
  const connectedRef = useRef(false)
  const sshCwdRef = useRef(sshCwd)
  sshCwdRef.current = sshCwd
  // 跟随终端开关的 ref 镜像:连接/重连 effect 按当前开关决定是否注入 OSC 7,
  // 不在重连时无视用户已关闭的开关强开(此前恒 onFollowTerminal(true))。
  const followTerminalRef = useRef(followTerminal)
  followTerminalRef.current = followTerminal
  // 上传完成刷新:overlay 级投影在上传 done 时自增 nonce(替代旧实现
  // 「开始后固定 2s 刷一次」——与完成时机无关,大文件传完列表仍旧)。
  const lastUploadDoneRef = useRef(uploadDoneNonce)

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
    dismissError()
    // SFTP 面板默认 followTerminal=true。连接后按当前开关通知终端侧注入 OSC 7,
    // 让 shell 在每次 cd 后上报 cwd——否则只有在用户手动点「跟随终端路径」
    // 时才注入,面板打开后 cd 不会触发跟随。重连时尊重用户已关闭的开关。
    if (followTerminalRef.current) onFollowTerminal?.(true)
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
          // 通道建立失败:重试 = 重建通道(connectNonce +1 重跑本 effect),
          // 由未连接覆盖层的「重试」按钮触发,不进操作重放队列。
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      } finally {
        if (!abort.signal.aborted) setConnecting(false)
      }
    })()
    return () => { abort.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDir/onFollowTerminal 为渲染期闭包,本 effect 只随会话/连接态/手动重连 nonce 重建通道。
  }, [sessionId, sshConnected, connectNonce])

  // ---- 上传完成后刷新当前目录(done → loadDir 联动) ----
  useEffect(() => {
    if (uploadDoneNonce === lastUploadDoneRef.current) return
    lastUploadDoneRef.current = uploadDoneNonce
    if (connectedRef.current) void loadDir(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只随 nonce 变化触发;loadDir/path 取当次渲染值即可。
  }, [uploadDoneNonce])

  // ---- native drag-drop upload (OS file dropped into the webview) ----
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unenter: TauriUnlisten | undefined
    let unover: TauriUnlisten | undefined
    let undrop: TauriUnlisten | undefined
    let unleave: TauriUnlisten | undefined
    void tauriListen<{ paths?: string[]; position?: unknown }>('tauri://drag-enter', () => setShowDropOverlay(true)).then((off) => { unenter = off })
    void tauriListen<{ paths?: string[]; position?: unknown }>('tauri://drag-over', () => setShowDropOverlay(true)).then((off) => { unover = off })
    void tauriListen<{ paths?: string[]; position?: unknown }>('tauri://drag-drop', (ev) => {
      setShowDropOverlay(false)
      const paths = ev?.paths ?? []
      if (paths.length > 0 && connectedRef.current) void startUpload(paths, path)
    }).then((off) => { undrop = off })
    void tauriListen<{ paths?: string[]; position?: unknown }>('tauri://drag-leave', () => setShowDropOverlay(false)).then((off) => { unleave = off })
    return () => {
      void unenter?.()
      void unover?.()
      void undrop?.()
      void unleave?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startUpload/connectedRef/path are stable refs or re-created per render; re-subscribe only when the target dir changes
  }, [sessionId, path])

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
      failWith(caught instanceof Error ? caught.message : String(caught), () => { void loadDir(target) })
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
      // 目录刷新由 uploadDoneNonce 效应在上传真正完成时触发
      // 立即弹出传输任务弹框,让用户实时看到进度(此前需手动点工具栏「传输任务」)
      onOpenTransfers?.()
    } catch (caught) {
      failWith(`上传失败: ${caught instanceof Error ? caught.message : String(caught)}`, () => { void startUpload(localPaths, dest) })
    }
  }
  async function uploadFiles(): Promise<void> {
    setMenu(null)
    try {
      const picked = await pickPath('files')
      if (picked !== null) await startUpload(picked, path)
    } catch (caught) {
      failWith(`无法打开上传文件选择器: ${caught instanceof Error ? caught.message : String(caught)}`, () => { void uploadFiles() })
    }
  }
  async function uploadFolder(): Promise<void> {
    setMenu(null)
    try {
      const picked = await pickPath('folder')
      if (picked !== null) await startUpload(picked, path)
    } catch (caught) {
      failWith(`无法打开上传文件夹选择器: ${caught instanceof Error ? caught.message : String(caught)}`, () => { void uploadFolder() })
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
      // 立即弹出传输任务弹框,让用户实时看到进度(此前需手动点工具栏「传输任务」)
      onOpenTransfers?.()
    } catch (caught) {
      failWith(`无法开始下载: ${caught instanceof Error ? caught.message : String(caught)}`, () => { void download(pick, entry) })
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
  /** 执行文件对话框对应的实际操作(新建文件夹/重命名/删除);失败记入可重放错误。 */
  async function runFileDialogOp(dialog: FileDialog): Promise<void> {
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
      failWith(`文件操作失败: ${caught instanceof Error ? caught.message : String(caught)}`, () => { void runFileDialogOp(dialog) })
    }
  }

  async function submitFileDialog(): Promise<void> {
    if (fileDialog === null) return
    const dialog = fileDialog
    if (dialog.mode !== 'delete' && dialog.value.trim() === '') return
    setFileDialog(null)
    await runFileDialogOp(dialog)
  }
  function copyPath(entry: SftpEntry): void {
    setMenu(null)
    navigator.clipboard.writeText(entry.path).catch((caught: unknown) => {
      failWith(`复制路径失败: ${caught instanceof Error ? caught.message : String(caught)}`, null)
    })
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
          {/* 重试 = 重建 SFTP 通道(connectNonce +1 重跑 ensure effect),不再只是清错误。 */}
          <button type="button" onClick={() =>{  dismissError(); setConnectNonce(n => n + 1) }}>重试</button>
        </div>
      )}
      {!connected && !connecting && error === null && (
        <div className={css.stateOverlay}>
          <span className={css.stateIcon} aria-hidden="true"><IconFolderOpenOutline16 size={18} /></span>
          <strong>{sshConnected ? '正在准备 SFTP 文件通道' : '终端未连接，SFTP 等待 SSH 会话连接'}</strong>
          <span>{sshConnected ? '正在复用当前 SSH 会话，请稍候。' : '终端连接成功后，文件浏览与传输会自动可用。'}</span>
        </div>
      )}

      {connected && error !== null && (
        /* 已连接后的操作错误(列目录/上传/下载/删除/重命名等)常驻横幅,可重试可关闭;
           此前这些错误只写进未连接态才渲染的 stateOverlay,连接后全部不可见。 */
        <div className={css.opError} role="alert">
          <span className={css.opErrorText}>{error}</span>
          {retryOp !== null && <button type="button" className={css.opErrorAction} onClick={retryFailed}>重试</button>}
          <button type="button" className={css.opErrorClose} aria-label="关闭错误提示" onClick={dismissError}>×</button>
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
              <button type="button" className={`${css.tbBtn} ${followTerminal ? css.active : ''}`} title={followTerminal ? '已跟随终端路径' : '跟随终端路径'} aria-label="跟随终端路径" aria-pressed={followTerminal} disabled={!sshConnected} onClick={toggleFollow}><IconLinkOutline16 size={15} /></button>
              {/* 传输任务入口:打开弹框(overlay 承载);有进行中任务时显示计数徽标 */}
              <button
                type="button"
                className={css.tbBtn}
                title="传输任务"
                aria-label="传输任务"
                onClick={() => onOpenTransfers?.()}
              >
                <IconDownloadOutline16 size={15} />
                {transferActiveCount > 0 && <span className={css.tbBadge}>{transferActiveCount}</span>}
              </button>
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

      {/* context menu */}
      {menu !== null && (
        <div
          className={css.menuBackdrop}
          onMouseDown={() =>{  setMenu(null) }}
          onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
        >
          <div
            className={css.contextMenu}
            style={{ left: Math.min(menu.x, window.innerWidth - MENU_ESTIMATED_WIDTH - MENU_VIEWPORT_MARGIN), top: Math.min(menu.y, window.innerHeight - MENU_ESTIMATED_HEIGHT - MENU_VIEWPORT_MARGIN) }}
            onMouseDown={(e) =>{  e.stopPropagation() }}
          >
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
      {showDropOverlay && (
        <div className={css.dropOverlay} role="presentation">
          <span className={css.dropText}>松开以上传到当前目录</span>
        </div>
      )}
    </div>
  )
}

export default SftpPanel
