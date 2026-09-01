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
import { IconCheckOutline14, IconCloseFill14, IconCloseOutline16, IconCodeOutline16, IconFolderOpenOutline16, IconLinkOutline16, IconPaperclipOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import type { RustAsset } from '../store.ts'
import { SftpPanel } from './SftpPanel.tsx'
import { BroadcastDialog, type BroadcastSession } from './BroadcastDialog.tsx'
import { WebBrowser } from './WebBrowser.tsx'
import { createQuickCommand, importQuickCommands, loadQuickCommands, saveQuickCommands, type QuickCommand } from './quick-commands.ts'
import { useTerminalTheme } from './terminal-theme.ts'
import {
  OSC7_INJECT_COMMAND, OSC7_INJECT_ECHO_TEXT, createCwdTracker, createHiddenEchoFilter, isShellPromptLine, parsePwdOutput,
} from './terminal-cwd.ts'
import css from './SshTerminalOverlay.module.css'

/** Props for one native SSH/SFTP terminal overlay. */
export interface SshTerminalOverlayProps {
  asset: RustAsset
  onClose: () => void
}

/** `ssh:kb-interactive:<sessionId>` 负载:服务器 keyboard-interactive 请求 + 预填。 */
export interface KbInteractiveEvent {
  sessionId: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
  autoFill: Array<string | null>
}

/** `ssh:hostkey-confirm:<sessionId>` 负载:新主机密钥等待用户确认。 */
export interface HostKeyConfirmEvent {
  hostname: string
  port: number
  remote: string
  keyType: string
  sha256: string
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
 * Build the Rust `KeyboardInteractiveConfig` from an asset config, mirroring
 * the Rust-side translation (commands/ssh.rs parse): `mfaEnabled` → enabled,
 * `mfaPassword` → password. The raw asset config stores the dialog-facing
 * fields (authMode/mfaEnabled/mfaPassword), while the Rust `SshConfig` serde
 * expects `kb_interactive`. Omitting this makes real connections fail with
 * `[AUTH_FAILED] Server requires keyboard-interactive MFA` even though the
 * test-connection dialog (which hand-writes `kb_interactive`) prompts fine.
 * @param config - the hydrated asset config.
 * @returns the serde `KeyboardInteractiveConfig`, or null when MFA is off.
 */
function buildKbInteractive(config: Record<string, unknown>): Record<string, unknown> | null {
  const enabled = config.authMode === 'mfa' || config.mfaEnabled === true
  if (!enabled) return null
  const mfaPassword = typeof config.mfaPassword === 'string' ? config.mfaPassword : ''
  return { enabled: true, ...(mfaPassword !== '' ? { password: mfaPassword } : {}) }
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
  // MFA/2FA:服务器 keyboard-interactive 请求(非空时渲染验证码输入弹窗)。
  const [kbPrompt, setKbPrompt] = useState<KbInteractiveEvent | null>(null)
  const [kbAnswers, setKbAnswers] = useState<string[]>([])
  // 新主机密钥:首次连接新服务器时后端要求用户确认指纹(非空时阻断 SSH 终端、
  // 渲染三选项弹窗:拒绝 / 仅本次 / 信任并保存)。
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyConfirmEvent | null>(null)
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
  const { theme, termRef } = useTerminalTheme()

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme is a one-time init palette; live changes are re-applied by useTerminalTheme.
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SF Mono, JetBrains Mono, Fira Code, Consolas, Courier, PingFang SC, Microsoft YaHei',
      fontSize: 13,
      theme,
    })
    termRef.current = term
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
    let unlistenKb: TauriUnlisten | undefined
    let unlistenHostkey: TauriUnlisten | undefined

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
        [unlistenData, unlistenClose, unlistenKb, unlistenHostkey] = await Promise.all([
          tauriListen<number[]>(`ssh:data:${sessionId}`, (bytes) => {
            handleChunk(decoder.decode(new Uint8Array(bytes), { stream: true }))
          }),
          tauriListen<string>(`ssh:close:${sessionId}`, (reason) => {
            isConnectedRef.current = false
            setConnected(false)
            if (!disposed) term.writeln(`\r\n[连接已关闭: ${reason}]`)
          }),
          // MFA/2FA:服务器 keyboard-interactive 请求,弹终端内验证码输入框。
          tauriListen<KbInteractiveEvent>(`ssh:kb-interactive:${sessionId}`, (event) => {
            if (disposed) return
            setKbAnswers(event.autoFill.map(value => value ?? ''))
            setKbPrompt(event)
          }),
          // 主机密钥确认:首次连新服务器必须由用户信任指纹后端才会放行。
          // 此前测试连接(NewConnectionDialog)与正式连接(SshTerminalOverlay)
          // 共用一个事件名却只在测试侧 listen,正式连接会因无人消费 sender
          // 导致后端 60s 超时拒绝。这里订阅,把决定权交回用户。
          tauriListen<HostKeyConfirmEvent>(`ssh:hostkey-confirm:${sessionId}`, (event) => {
            if (disposed) return
            setHostKeyPrompt(event)
          }),
        ])
        if (disposed) {
          void unlistenData()
          void unlistenClose()
          void unlistenKb()
          void unlistenHostkey()
          return
        }
        const kbInteractive = buildKbInteractive(asset.config)
        await tauriInvoke('ssh_connect', {
          id: sessionId,
          config: {
            ...asset.config,
            auth: buildSshAuth(asset.config),
            // MFA/2FA:把对话框字段(mfaEnabled/mfaPassword)翻译成 Rust
            // SshConfig 期望的 kb_interactive;缺此字段时正式连接遇到
            // keyboard-interactive 服务器会误报 [AUTH_FAILED] 而不弹验证码。
            ...(kbInteractive === null ? {} : { kb_interactive: kbInteractive }),
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
      void unlistenKb?.()
      void unlistenHostkey?.()
      setHostKeyPrompt(null)
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

  /** 提交 keyboard-interactive 应答(MFA TOTP 输入),回复后端 pending 通道。 */
  const submitKbAnswers = (): void => {
    if (kbPrompt === null) return
    void tauriInvoke('ssh_kb_response', { id: sessionId, responses: kbAnswers }).catch(() => {})
    setKbPrompt(null)
    setKbAnswers([])
  }

  /** 处理主机密钥确认决策。拒绝时主动断开 SSH 会话并关闭 overlay,
   *  避免后端 60s 超时(后续重试会因为 known_hosts 仍没有这个指纹而再次弹)。*/
  const resolveHostKey = (allowed: boolean, persist: boolean): void => {
    if (hostKeyPrompt === null) return
    const promptSnapshot = hostKeyPrompt
    setHostKeyPrompt(null)
    if (allowed) {
      void tauriInvoke('ssh_hostkey_response', { id: sessionId, allowed: true, persist }).catch(() => {})
      return
    }
    // 拒绝:不响应 sender,直接关 SSH 让用户回到资产列表。
    void tauriInvoke('ssh_hostkey_response', { id: sessionId, allowed: false, persist: false })
      .catch(() => { /* 后端 sender 可能已被取消;失败不阻塞下面的断开 */ })
    void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
    if (!disposedRef.current) {
      setError(`已拒绝主机密钥:${promptSnapshot.remote} (${promptSnapshot.keyType})`)
    }
    onClose()
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
            <span className={css.noticeMark} aria-hidden="true"><IconCheckOutline14 size={13} /></span>
            <span>{broadcastNotice}</span>
            <button type="button" className={css.noticeClose} onClick={() =>{  setBroadcastNotice(null) }} aria-label="关闭提示"><IconCloseFill14 size={11} /></button>
          </div>
        )}
        <div className={css.workspace}>
          <main className={css.terminalWorkspace} aria-label="SSH 终端">
            <div className={css.workspaceTabs} role="tablist" aria-label="SSH 工作区">
              <span className={css.terminalTab} role="tab" aria-selected="true"><IconCodeOutline16 size={14} /> 终端</span>
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
      {kbPrompt !== null && (
        <div className={css.kbBackdrop} role="dialog" aria-modal="true" aria-label="MFA 验证">
          <section className={css.kbDialog}>
            <header className={css.kbHeader}>
              <span className={css.kbTitle}>MFA 验证</span>
              <span className={css.kbHint}>{typeof asset.config.host === 'string' ? `${asset.config.host} 需要验证` : '服务器需要验证'}</span>
            </header>
            <div className={css.kbBody}>
              {kbPrompt.instructions !== '' && <div className={css.kbInstructions}>{kbPrompt.instructions}</div>}
              {kbPrompt.prompts.map((prompt, index) => (
                <div className={css.kbField} key={`${index}-${prompt.prompt}`}>
                  <label className={css.kbLabel} htmlFor={`kb-answer-${index}`}>
                    {prompt.prompt !== '' ? prompt.prompt : '一次性验证码'}
                  </label>
                  <input
                    id={`kb-answer-${index}`}
                    className={css.kbInput}
                    type={prompt.echo ? 'text' : 'password'}
                    value={kbAnswers[index] ?? ''}
                    autoFocus={index === 0}
                    onChange={(event) => {
                      const next = [...kbAnswers]
                      next[index] = event.target.value
                      setKbAnswers(next)
                    }}
                  />
                </div>
              ))}
              <span className={css.kbTimeHint}>请在 360 秒内完成验证,超时连接将断开。</span>
            </div>
            <footer className={css.kbFooter}>
              <button type="button" className={css.kbSubmit} onClick={submitKbAnswers}>提交验证码</button>
            </footer>
          </section>
        </div>
      )}
      {hostKeyPrompt !== null && (
        <div className={css.hkBackdrop} role="dialog" aria-modal="true" aria-label="主机密钥确认">
          <section className={css.hkDialog}>
            <header className={css.hkHeader}>
              <span className={css.hkTitle}>是否信任此主机?</span>
              <span className={css.hkHint}>该服务器尚未加入 known_hosts,首次连接需确认指纹。</span>
            </header>
            <div className={css.hkBody}>
              <div className={css.hkRow}>
                <span className={css.hkLabel}>主机</span>
                <span className={css.hkValue}>{hostKeyPrompt.remote}</span>
              </div>
              <div className={css.hkRow}>
                <span className={css.hkLabel}>密钥类型</span>
                <span className={css.hkValue}>{hostKeyPrompt.keyType}</span>
              </div>
              <div className={css.hkRow}>
                <span className={css.hkLabel}>指纹(SHA256)</span>
                <span className={css.hkValueMono}>{hostKeyPrompt.sha256}</span>
              </div>
              <div className={css.hkDanger}>
                请确认指纹与服务器管理员提供的指纹一致。指纹不一致可能意味着你正在遭受中间人攻击。
              </div>
            </div>
            <footer className={css.hkFooter}>
              <button
                type="button"
                className={css.hkBtnDanger}
                onClick={() => { resolveHostKey(false, false) }}
                title="拒绝并断开本次 SSH 连接"
              >拒绝</button>
              <span className={css.spacer} />
              <button
                type="button"
                className={css.hkBtnSecondary}
                onClick={() => { resolveHostKey(true, false) }}
                title="本次会话信任此指纹,不写入 known_hosts"
              >仅本次</button>
              <button
                type="button"
                className={css.hkBtnPrimary}
                onClick={() => { resolveHostKey(true, true) }}
                title="写入 known_hosts,后续自动信任"
              >信任并保存</button>
            </footer>
          </section>
        </div>
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
              <button type="button" className={css.quickDelete} onClick={() =>{  onChange(commands.filter(item => item.id !== command.id)) }} title="删除快捷命令" aria-label={`删除 ${command.label || '快捷命令'}`}><IconCloseFill14 size={12} /></button>
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
