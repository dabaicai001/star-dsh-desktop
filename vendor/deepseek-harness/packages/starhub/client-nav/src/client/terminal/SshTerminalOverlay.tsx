/**
 * Shell-native SSH/SFTP terminal overlay.
 *
 * Opened in-page (no new window) when an SSH asset is clicked. Owns one xterm
 * instance connected via the StarHub interactive SSH session, and exposes a
 * second tab with the native SFTP file-transfer panel that reuses the same live
 * session. SSH terminal and SFTP inherently share one connection, so they ride
 * the same overlay.
 *
 * cwd tracking (SFTP「跟随终端」): the terminal tracks the remote cwd from the
 * PTY stream (OSC 7 + `pwd` fallback) and lazily injects an OSC 7 hook into the
 * running shell once follow is enabled and a prompt is seen, so `cd` reports
 * cwd live. The tracked `sshCwd` is handed to the SFTP panel for follow-nav.
 *
 * @module StarHub SSH/SFTP overlay (client)
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { IconCloseOutline16, IconFolderOpenOutline16, IconLinkOutline16, IconPaperclipOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import type { RustAsset } from '../store.ts'
import { SftpPanel } from './SftpPanel.tsx'
import { BroadcastDialog, type BroadcastSession } from './BroadcastDialog.tsx'
import { WebBrowser } from './WebBrowser.tsx'
import { createQuickCommand, importQuickCommands, loadQuickCommands, saveQuickCommands, type QuickCommand } from './quick-commands.ts'
import {
  OSC7_INJECT_COMMAND, OSC7_INJECT_ECHO_TEXT, createCwdTracker, createHiddenEchoFilter, isShellPromptLine, parsePwdOutput,
} from './terminal-cwd.ts'
import css from './SshTerminalOverlay.module.css'

/** Props for one native SSH/SFTP terminal overlay. */
export interface SshTerminalOverlayProps {
  asset: RustAsset
  onClose: () => void
}

type SidePanel = 'sftp' | 'web' | null

/**
 * Build the Rust `SshAuth` variant from an asset config, mirroring the Vue
 * `buildAuth` (src/services/ssh.ts): password / private key / both, with the
 * usePasswordAuth / useKeyAuth flags.
 * @param config - the hydrated asset config.
 * @returns the serde `SshAuth` tagged object.
 */
function buildSshAuth(config: Record<string, unknown>): Record<string, unknown> {
  const usePassword = config.usePasswordAuth !== false
  const useKey = config.useKeyAuth === true
  const password = typeof config.password === 'string' ? config.password : ''
  const privateKey = typeof config.privateKey === 'string' ? config.privateKey : ''
  const passphrase = typeof config.passphrase === 'string' ? config.passphrase : null
  if (usePassword && useKey && password !== '' && privateKey !== '') {
    return { PasswordAndKey: { password, key: privateKey, passphrase } }
  }
  if (password !== '' && usePassword) return { Password: password }
  if (privateKey !== '' && useKey) return { PrivateKey: { key: privateKey, passphrase } }
  return { Password: '' }
}

/**
 * Render one xterm instance backed by a StarHub interactive SSH session, with
 * cwd tracking for the SFTP follow-terminal flow.
 * @param props - selected SSH asset and overlay close callback.
 * @returns the native SSH/SFTP terminal overlay.
 */
export function SshTerminalOverlay({ asset, onClose }: SshTerminalOverlayProps) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [sidePanel, setSidePanel] = useState<SidePanel>(null)
  const [sshCwd, setSshCwd] = useState('')
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(loadQuickCommands)
  const [quickEditorOpen, setQuickEditorOpen] = useState(false)
  const quickImportRef = useRef<HTMLInputElement>(null)
  // 命令广播(需求 6 broadcast 子集):弹层会话列表 + 发送结果提示。
  const [broadcastSessions, setBroadcastSessions] = useState<BroadcastSession[] | null>(null)
  const [broadcastNotice, setBroadcastNotice] = useState<string | null>(null)

  const sessionId = asset.id
  // cwd / injection state shared between the effect and the follow callback.
  const isConnectedRef = useRef(false)
  const osc7InjectPendingRef = useRef(false)
  const osc7InjectedRef = useRef(false)
  const shellPromptSeenRef = useRef(false)
  const cwdRef = useRef('')
  const disposedRef = useRef(false)

  const applyCwd = (next: string) => {
    if (!next || next === cwdRef.current) return
    cwdRef.current = next
    if (!disposedRef.current) setSshCwd(next)
  }

  /** Lazily inject the OSC 7 hook after the shell reaches a prompt. */
  const tryInjectOsc7 = () => {
    if (!osc7InjectPendingRef.current || osc7InjectedRef.current || !isConnectedRef.current) return
    osc7InjectPendingRef.current = false
    osc7InjectedRef.current = true
    void tauriInvoke('ssh_write', { id: sessionId, data: OSC7_INJECT_COMMAND }).catch(() => {
      // allow a later retry on the next follow toggle
      osc7InjectedRef.current = false
      osc7InjectPendingRef.current = true
    })
  }

  /** Start OSC 7 cwd reporting once the terminal is connected and the shell is ready. */
  const enableCwdTracking = () => {
    if (osc7InjectedRef.current || disposedRef.current) return
    osc7InjectPendingRef.current = true
    if (shellPromptSeenRef.current) tryInjectOsc7()
  }

  /** SFTP「跟随终端」toggle keeps cwd reporting active for the live SSH session. */
  const onFollowTerminal = (enabled: boolean) => {
    if (enabled) enableCwdTracking()
  }

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#101822' },
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    if (host.current !== null) {
      term.open(host.current)
      addon.fit()
    }

    let disposed = false
    disposedRef.current = false
    let resizeObserver: ResizeObserver | undefined
    let unlistenData: TauriUnlisten | undefined
    let unlistenClose: TauriUnlisten | undefined

    const cwdTracker = createCwdTracker()
    const decoder = new TextDecoder()
    const hiddenEcho = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])

    const input = term.onData((data) => {
      if (isConnectedRef.current) void tauriInvoke('ssh_write', { id: sessionId, data }).catch(() => {})
    })

    const resize = () => {
      addon.fit()
      if (isConnectedRef.current) void tauriInvoke('ssh_resize', { id: sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
    }

    /** Handle one decoded terminal chunk: render + track cwd + detect prompt. */
    const handleChunk = (chunk: string) => {
      if (!chunk) return
      const visible = hiddenEcho(chunk)
      if (visible) term.write(visible)
      const next = cwdTracker.onChunk(chunk)
      if (next !== null) applyCwd(next)
      if (!shellPromptSeenRef.current) {
        const lastLine = chunk.split('\n').pop() ?? ''
        if (isShellPromptLine(lastLine.trimEnd())) shellPromptSeenRef.current = true
      } else if (osc7InjectPendingRef.current) {
        tryInjectOsc7()
      }
    }

    /** Initialize cwd from a silent exec `pwd` (login dir) right after connect. */
    const initCwdFromExec = async () => {
      if (disposed) return
      try {
        const out = await tauriInvoke<string>('ssh_exec', { id: sessionId, command: 'pwd', timeoutSec: 5 })
        const cwd = parsePwdOutput(out)
        // OSC 7 may have reported a fresher dir; only fill when empty
        if (cwd !== null && cwdRef.current === '') applyCwd(cwd)
      } catch { /* fall back to later OSC 7 / pwd parsing */ }
    }

    const connect = async () => {
      try {
        [unlistenData, unlistenClose] = await Promise.all([
          tauriListen<number[]>(`ssh:data:${sessionId}`, (bytes) => {
            handleChunk(decoder.decode(new Uint8Array(bytes), { stream: true }))
          }),
          tauriListen<string>(`ssh:close:${sessionId}`, (reason) => {
            isConnectedRef.current = false
            setConnected(false)
            if (!disposed) term.writeln(`\r\n[连接已关闭: ${reason}]`)
          }),
        ])
        if (disposed) {
          void unlistenData()
          void unlistenClose()
          return
        }
        await tauriInvoke('ssh_connect', {
          id: sessionId,
          config: {
            ...asset.config,
            auth: buildSshAuth(asset.config),
            pty_cols: term.cols,
            pty_rows: term.rows,
          },
        })
        if (disposedRef.current) {
          void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
          return
        }
        isConnectedRef.current = true
        setConnected(true)
        resizeObserver = new ResizeObserver(resize)
        if (host.current !== null) resizeObserver.observe(host.current)
        resize()
        term.focus()
        enableCwdTracking()
        void initCwdFromExec()
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught))
      }
    }

    void connect()
    return () => {
      disposed = true
      disposedRef.current = true
      isConnectedRef.current = false
      input.dispose()
      resizeObserver?.disconnect()
      void unlistenData?.()
      void unlistenClose?.()
      const tail = decoder.decode()
      if (tail) handleChunk(tail)
      void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
      term.dispose()
    }
  }, [asset])

  /** 打开广播弹层:拉取所有已连接的 SSH 会话作为目标列表。 */
  const openBroadcast = async (): Promise<void> => {
    setBroadcastNotice(null)
    try {
      const infos = await tauriInvoke<Array<{ id: string; host?: string; port?: number; username?: string; connected?: boolean }>>('ssh_get_sessions')
      const sessions: BroadcastSession[] = infos
        .filter(s => s.connected === true)
        .map((s) => {
          const endpoint = `${s.username ?? ''}@${s.host ?? ''}:${s.port ?? 22}`
          return { sessionId: s.id, title: s.id, host: endpoint }
        })
      if (sessions.length === 0) {
        setBroadcastNotice('没有已连接的会话可用于广播')
        return
      }
      setBroadcastSessions(sessions)
    } catch (e) {
      setBroadcastNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const runQuickCommand = async (command: QuickCommand): Promise<void> => {
    if (!connected) return
    try {
      await tauriInvoke('ssh_write', { id: sessionId, data: `${command.cmd}\n` })
      setBroadcastNotice(`已发送: ${command.label}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const updateQuickCommands = (next: QuickCommand[]): void => {
    setQuickCommands(next)
    saveQuickCommands(next)
  }

  const importQuickCommandFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file === undefined) return
    try {
      const result = await importQuickCommands(file)
      updateQuickCommands([...quickCommands, ...result.commands])
      setBroadcastNotice(`已导入 ${result.commands.length} 条快捷命令${result.skippedScripts > 0 ? `，跳过 ${result.skippedScripts} 条本地脚本` : ''}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 关闭广播弹层。 */
  const closeBroadcast = (): void =>{  setBroadcastSessions(null) }

  /** 把命令写入每个选中的会话(逐会话容错;提示成功/失败计数)。 */
  const sendBroadcast = async (command: string, sessionIds: string[]): Promise<void> => {
    let failed = 0
    for (const sid of sessionIds) {
      try {
        await tauriInvoke('ssh_write', { id: sid, data: `${command}\n` })
      } catch {
        failed += 1
      }
    }
    closeBroadcast()
    setBroadcastNotice(failed === 0
      ? `已广播到 ${sessionIds.length} 个会话`
      : `广播完成,${failed} 个会话发送失败`)
  }

  const sidePanelLabel = sidePanel === 'sftp' ? '文件传输' : '网页访问'
  const toggleSidePanel = (panel: Exclude<SidePanel, null>): void => {
    setSidePanel(current => current === panel ? null : panel)
  }

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`SSH 工作区 ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span className={connected ? css.statusOnline : css.statusPending} aria-label={connected ? 'SSH 已连接' : 'SSH 连接中'} />
            <div className={css.identity}>
              <span className={css.title}>{asset.name}</span>
              <span className={css.endpoint}>{typeof asset.config.username === 'string' ? `${asset.config.username}@` : ''}{typeof asset.config.host === 'string' ? asset.config.host : '未配置主机'}</span>
            </div>
          </div>
          <div className={css.headRight}>
            <button type="button" className={css.iconButton} onClick={onClose} title="关闭" aria-label="关闭 SSH 工作区"><IconCloseOutline16 size={16} /></button>
            <button
              type="button"
              className={css.broadcastAction}
              onClick={() => void openBroadcast()}
              title="命令广播:把同一命令发送到多个已连接 SSH 会话"
              aria-label="广播"
            ><span>广播</span><span className={css.broadcastDetail}>命令</span></button>
          </div>
        </header>
        {error !== null && <div className={css.error} role="alert">{error}</div>}
        <input ref={quickImportRef} className={css.fileInput} type="file" accept=".qbl,.qblx" onChange={event => void importQuickCommandFile(event)} />
        {broadcastNotice !== null && (
          <div className={css.notice} role="status">
            <span className={css.noticeMark} aria-hidden="true">✓</span>
            <span>{broadcastNotice}</span>
            <button type="button" className={css.noticeClose} onClick={() =>{  setBroadcastNotice(null) }} aria-label="关闭提示">×</button>
          </div>
        )}
        <div className={css.workspace}>
          <main className={css.terminalWorkspace} aria-label="SSH 终端">
            <div className={css.workspaceTabs} role="tablist" aria-label="SSH 工作区">
              <span className={css.terminalTab} role="tab" aria-selected="true"><span aria-hidden="true">›_</span> 终端</span>
              <span className={css.spacer} />
              <button
                type="button"
                className={sidePanel === 'sftp' ? css.workspaceTabActive : css.workspaceTab}
                onClick={() =>{  toggleSidePanel('sftp') }}
                title={connected ? '显示或隐藏 SFTP 文件面板' : '等待 SSH 连接后启用 SFTP'}
                aria-pressed={sidePanel === 'sftp'}
              ><IconFolderOpenOutline16 size={15} /> 文件</button>
              <button
                type="button"
                className={sidePanel === 'web' ? css.workspaceTabActive : css.workspaceTab}
                onClick={() =>{  toggleSidePanel('web') }}
                title={connected ? '显示或隐藏 SSH 网页面板' : '等待 SSH 连接后启用网页访问'}
                aria-pressed={sidePanel === 'web'}
              ><IconLinkOutline16 size={15} /> 网页</button>
              <span className={css.connectionState}><span className={connected ? css.connectionOnline : css.connectionPending} />{connected ? '已连接' : '连接中'}</span>
            </div>
            <div className={css.quickBar} aria-label="快捷命令">
              <span className={css.quickLabel}>QUICK</span>
              <div className={css.quickList}>
                {quickCommands.map(command => (
                  <button key={command.id} type="button" className={css.quickCommand} onClick={() => void runQuickCommand(command)} disabled={!connected} title={command.cmd}>{command.label}</button>
                ))}
                {quickCommands.length === 0 && <span className={css.quickEmpty}>添加常用 SSH 命令</span>}
              </div>
              <button type="button" className={css.quickIconButton} onClick={() => quickImportRef.current?.click()} title="导入 Xshell .qbl / .qblx" aria-label="导入 Xshell 快捷命令"><IconPaperclipOutline16 size={14} /></button>
              <button type="button" className={css.quickIconButton} onClick={() =>{  setQuickEditorOpen(true) }} title="管理快捷命令" aria-label="管理快捷命令"><IconPlusOutline16 size={14} /></button>
            </div>
            <div ref={host} className={css.terminal} />
          </main>
          {sidePanel !== null && (
            <aside className={css.sidePanel} aria-label={sidePanelLabel}>
              <header className={css.sidePanelHeader}>
                <div>
                  <span className={css.sidePanelTitle}>{sidePanelLabel}</span>
                  <span className={css.sidePanelDetail}>{sidePanel === 'sftp' ? '与当前 SSH 会话共享连接' : '通过 SSH 安全网关访问'}</span>
                </div>
              </header>
              <div className={css.sidePanelBody}>
                {sidePanel === 'web' ? (
                  <WebBrowser sessionId={sessionId} assetName={asset.name} sshConnected={connected} />
                ) : (
                  <SftpPanel
                    asset={asset}
                    sessionId={sessionId}
                    sshConnected={connected}
                    sshCwd={sshCwd}
                    onFollowTerminal={onFollowTerminal}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
      {quickEditorOpen && (
        <QuickCommandEditor
          commands={quickCommands}
          onChange={updateQuickCommands}
          onClose={() =>{  setQuickEditorOpen(false) }}
        />
      )}
      {broadcastSessions !== null && (
        <BroadcastDialog
          sessions={broadcastSessions}
          onSubmit={({ command, sessionIds }) => void sendBroadcast(command, sessionIds)}
          onClose={closeBroadcast}
        />
      )}
    </div>
  )
}

function QuickCommandEditor({ commands, onChange, onClose }: {
  commands: QuickCommand[]
  onChange: (commands: QuickCommand[]) => void
  onClose: () => void
}) {
  const update = (id: string, key: 'label' | 'cmd', value: string): void => {
    onChange(commands.map(command => command.id === id ? { ...command, [key]: value } : command))
  }
  return (
    <div className={css.quickEditorBackdrop} role="dialog" aria-modal="true" aria-label="管理快捷命令">
      <section className={css.quickEditor}>
        <header className={css.quickEditorHeader}>
          <div><span className={css.quickEditorTitle}>快捷命令</span><span className={css.quickEditorHint}>点击命令将发送到当前 SSH 会话</span></div>
          <button type="button" className={css.iconButton} onClick={onClose} title="关闭" aria-label="关闭"><IconCloseOutline16 size={15} /></button>
        </header>
        <div className={css.quickEditorList}>
          {commands.map(command => (
            <div className={css.quickEditorRow} key={command.id}>
              <input value={command.label} placeholder="名称" aria-label="快捷命令名称" onChange={(event) =>{  update(command.id, 'label', event.target.value) }} />
              <textarea value={command.cmd} placeholder="SSH 命令" aria-label="快捷命令内容" onChange={(event) =>{  update(command.id, 'cmd', event.target.value) }} />
              <button type="button" className={css.quickDelete} onClick={() =>{  onChange(commands.filter(item => item.id !== command.id)) }} title="删除快捷命令" aria-label={`删除 ${command.label || '快捷命令'}`}>×</button>
            </div>
          ))}
          {commands.length === 0 && <div className={css.quickEditorEmpty}>暂无快捷命令。可新增一条，或从 Xshell 导入 `.qbl` / `.qblx`。</div>}
        </div>
        <footer className={css.quickEditorFooter}>
          <button type="button" className={css.quickAdd} onClick={() =>{  onChange([...commands, createQuickCommand()]) }}><IconPlusOutline16 size={14} /> 添加命令</button>
          <span className={css.spacer} />
          <button type="button" className={css.quickDone} onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  )
}
