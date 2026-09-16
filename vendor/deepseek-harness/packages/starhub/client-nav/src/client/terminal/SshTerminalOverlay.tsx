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
 * PTY stream (OSC 7 + prompt-path extraction + `pwd` fallback) and lazily
 * injects a dialect-matched OSC 7 hook into the running shell once follow is
 * enabled, the shell probe settled, and a prompt is seen, so `cd` reports cwd
 * live. The tracked `sshCwd` is handed to the SFTP panel for follow-nav.
 *
 * @module StarHub SSH/SFTP overlay (client)
 */
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { IconCheckOutline14, IconCloseFill14, IconCloseOutline16, IconCodeOutline16, IconFolderOpenOutline16, IconLinkOutline16, IconPaperclipOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import ZmodemModule from 'zmodem.js/src/zmodem_browser.js'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import type { RustAsset } from '../store.ts'
import { SftpPanel } from './SftpPanel.tsx'
import { TransferDialog } from './TransferDialog.tsx'
import { useTransferTasks } from './use-transfer-tasks.ts'
import { formatSize } from './sftp-service.ts'
import { BroadcastDialog, type BroadcastSession } from './BroadcastDialog.tsx'
import { createQuickCommand, importQuickCommands, loadQuickCommands, saveQuickCommands, type QuickCommand } from './quick-commands.ts'
import { useTerminalTheme } from './terminal-theme.ts'
import { terminalOptions, useTerminalSettings } from './terminal-settings.ts'
import {
  OSC7_INJECT_ECHO_TEXT, buildOsc7InjectCommand, createCwdTracker, createHiddenEchoFilter,
  extractPromptCwd, isShellPromptLine, parseLoginShell, parsePwdOutput, stripTerminalControl,
  type HiddenEchoFilter,
} from './terminal-cwd.ts'
import css from './SshTerminalOverlay.module.css'

/** ZMODEM transfer (rz/sz) — thin types over the zmodem.js browser module. */
interface ZmodemTransfer {
  get_details: () => { name: string; size?: number | null }
  get_offset: () => number
  accept: () => Promise<Array<Uint8Array>>
}

interface ZmodemSession {
  type: 'send' | 'receive'
  on: (event: string, handler: (...args: unknown[]) => void) => ZmodemSession
  start: () => void
  close: () => Promise<void>
  abort: () => void
}

interface ZmodemDetection {
  confirm: () => ZmodemSession
  deny: () => void
}

interface ZmodemApi {
  Sentry: new (options: {
    to_terminal: (octets: number[]) => void
    sender: (octets: number[]) => void
    on_detect: (detection: ZmodemDetection) => void
    on_retract: () => void
  }) => { consume: (octets: number[] | Uint8Array) => void }
  Browser: {
    send_files: (
      session: ZmodemSession,
      files: FileList,
      options: {
        on_progress?: (file: File, transfer: ZmodemTransfer) => void
        on_file_complete?: (file: File) => void
      },
    ) => Promise<void>
    save_to_disk: (payloads: Array<Uint8Array>, name: string) => void
  }
}

const Zmodem = ZmodemModule as ZmodemApi

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

type SidePanel = 'sftp' | null

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
  /** 已断开(远端关闭 / 连接失败 / 拒绝主机密钥):此前这些情况一律显示「连接中」。 */
  const [closed, setClosed] = useState(false)
  /** 连接代次:点「重新连接」+1,重跑建连 effect(会话 id 与终端随之重建)。 */
  const [connectNonce, setConnectNonce] = useState(0)
  const [sidePanel, setSidePanel] = useState<SidePanel>(null)
  // SFTP / 网页右栏宽度(px):拖左边框调整,夹在 min 与 max 之间;内存态即可。
  const [sidePanelWidth, setSidePanelWidth] = useState(500)
  const sidePanelMinWidth = 340
  const sidePanelMaxWidth = 560
  const sidePanelResizeRef = useRef(false)
  const onSidePanelResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    sidePanelResizeRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])
  const onSidePanelResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidePanelResizeRef.current) return
    // 拖动左边框:向左收窄、向右加宽。以容器右缘为基准反推宽度。
    const container = event.currentTarget.parentElement
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const next = Math.round(rect.right - event.clientX)
    setSidePanelWidth(Math.max(sidePanelMinWidth, Math.min(sidePanelMaxWidth, next)))
  }, [])
  const onSidePanelResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidePanelResizeRef.current) return
    sidePanelResizeRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])
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
  // ZMODEM(rz/sz):远端执行 rz(我们发送)或 sz(我们接收)时弹出传输弹窗。
  const zmodemInputRef = useRef<HTMLInputElement>(null)
  const [zmodemPromptVisible, setZmodemPromptVisible] = useState(false)
  const [zmodemStatus, setZmodemStatus] = useState('')
  const [zmodemProgress, setZmodemProgress] = useState(0)
  const [zmodemFileName, setZmodemFileName] = useState('')
  const [zmodemTransferred, setZmodemTransferred] = useState(0)
  const [zmodemTotal, setZmodemTotal] = useState(0)
  const [zmodemType, setZmodemType] = useState<'send' | 'receive' | null>(null)
  const zmodemSessionRef = useRef<ZmodemSession | null>(null)
  const zmodemSentryRef = useRef<InstanceType<ZmodemApi['Sentry']> | null>(null)
  const zmodemRecvTimerRef = useRef<number | null>(null)

  /** 结束/清空一次 zmodem 会话(复位状态)。 */
  const finishZmodem = () => {
    if (zmodemRecvTimerRef.current !== null) {
      window.clearInterval(zmodemRecvTimerRef.current)
      zmodemRecvTimerRef.current = null
    }
    zmodemSessionRef.current = null
    setZmodemPromptVisible(false)
    setZmodemStatus('')
    setZmodemProgress(0)
    setZmodemFileName('')
    setZmodemTransferred(0)
    setZmodemTotal(0)
    setZmodemType(null)
  }

  /** 断开/重置:中止在途会话并清空弹窗与 sentry。 */
  const resetZmodem = () => {
    if (zmodemSessionRef.current) {
      try { zmodemSessionRef.current.abort() } catch { /* 会话可能已关闭 */ }
    }
    finishZmodem()
    zmodemSentryRef.current = null
  }

  /** 选择要发送的文件(远端 rz)。 */
  const chooseZmodemFiles = () => { zmodemInputRef.current?.click() }

  /** 用户选择发送文件后,交给 zmodem 发送。 */
  async function onZmodemFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target
    if (!input.files?.length || !zmodemSessionRef.current) return
    const files = input.files
    const session = zmodemSessionRef.current
    const totalBytes = Array.from(files).reduce((sum, file) => sum + file.size, 0)
    // The early return above guarantees files.length >= 1; noUncheckedIndexedAccess
    // still types files[0] as File | undefined, so narrow it once before use.
    const firstFileName = files[0]?.name ?? ''
    // zmodem.js 的 Transfer.get_offset() 是「当前文件」的字节偏移,跨文件会重置为 0;
    // 多文件发送时不能直接用它当总进度。用「前序文件累计 + 当前文件偏移」算出批总量,
    // 并把进度映射到 0..100(完成后由 close() 收口到 100)。
    const cumulative = new Map<File, number>()
    try {
      setZmodemTotal(totalBytes)
      setZmodemStatus(files.length === 1 ? `正在发送 ${firstFileName}` : `正在发送 ${files.length} 个文件`)
      setZmodemFileName(files.length === 1 ? firstFileName : `${files.length} 个文件`)
      await Zmodem.Browser.send_files(session, files, {
        on_progress: (file, transfer) => {
          const sent = transfer.get_offset()
          const prior = cumulative.get(file) ?? 0
          setZmodemFileName(file.name)
          setZmodemTransferred(prior + sent)
          setZmodemProgress(totalBytes > 0 ? Math.min(99, (prior + sent) / totalBytes * 100) : 0)
        },
        on_file_complete: file => {
          // 当前文件完成:把该文件偏移计入前序,下一文件从累计值继续。
          cumulative.set(file, file.size)
          setZmodemStatus(`已发送 ${file.name}`)
        },
      })
      await session.close()
      setZmodemProgress(100)
    } catch {
      session.abort()
    } finally {
      input.value = ''
      window.setTimeout(finishZmodem, 700)
    }
  }

  /** 取消一次接收/发送。 */
  const cancelZmodem = () => {
    zmodemSessionRef.current?.abort()
    finishZmodem()
  }

  const sessionId = asset.id
  // cwd / injection state shared between the effect and the follow callback.
  const isConnectedRef = useRef(false)
  const osc7InjectPendingRef = useRef(false)
  const osc7InjectedRef = useRef(false)
  const shellPromptSeenRef = useRef(false)
  const cwdRef = useRef('')
  // Login-shell name from the connect-time silent exec; picks the OSC 7 inject
  // command per shell (null = undetected → conservative bash/zsh command).
  const loginShellRef = useRef<string | null>(null)
  // Remote home (login dir) used to expand `~` tokens extracted from prompt lines.
  const homeRef = useRef('')
  // Settles after the connect-time silent exec (shell probe) returns or fails;
  // injection waits for it so a fish shell never receives the bash dialect.
  const shellProbedRef = useRef(false)
  const disposedRef = useRef(false)
  const { theme, termRef } = useTerminalTheme()
  const terminalSettings = useTerminalSettings()
  // 隐藏回显过滤器:一次性武装语义(组件级持有,供 tryInjectOsc7 在写入
  // 注入命令前 arm;effect 里的渲染路径消费)。默认零缓冲透传。
  const hiddenEchoRef = useRef<HiddenEchoFilter | null>(null)
  if (hiddenEchoRef.current === null) {
    hiddenEchoRef.current = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
  }
  const hiddenEcho = hiddenEchoRef.current

  // v8 ignore start -- OSC 7 / cwd reporting needs a live shell (prompt + ssh_write round-trip); jsdom cannot drive it
  const applyCwd = (next: string) => {
    if (!next || next === cwdRef.current) return
    cwdRef.current = next
    if (!disposedRef.current) setSshCwd(next)
  }

  /** Lazily inject the OSC 7 hook after the shell reaches a prompt. */
  const tryInjectOsc7 = () => {
    if (!osc7InjectPendingRef.current || osc7InjectedRef.current || !isConnectedRef.current) return
    // Wait for the connect-time shell probe: injecting the bash dialect into a
    // live fish prompt prints an error line for nothing (and vice versa).
    if (!shellProbedRef.current) return
    const command = buildOsc7InjectCommand(loginShellRef.current)
    if (command === '') {
      // Injection-immune shell (csh/tcsh/…): nothing to inject; prompt-path
      // extraction + pwd parsing remain the cwd signals for this session.
      osc7InjectPendingRef.current = false
      osc7InjectedRef.current = true
      return
    }
    osc7InjectPendingRef.current = false
    osc7InjectedRef.current = true
    // 抑制窗口只包住注入回显:含 __starhub_osc7 的回显行被整行剔除后自动解除。
    // 窗口外零缓冲透传——常驻过滤会把行尾 `_`(marker 前缀)扣到下个 chunk,
    // 表现为「终端里下划线丢失 / 下个字符到达时一次蹦出两个」。
    hiddenEcho.arm()
    void tauriInvoke('ssh_write', { id: sessionId, data: command }).catch(() => {
      const held = hiddenEcho.disarm()
      if (held !== '' && termRef.current !== null) termRef.current.write(held)
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

  // v8 ignore stop --

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme/settings 在挂载时按当时的显示设置创建终端;主题后续由 useTerminalTheme 动态重刷,字体/字号/编码在下次打开终端时生效。
    const term = new Terminal({
      ...terminalOptions(terminalSettings),
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
    const decoder = new TextDecoder(terminalSettings.encoding)

    const input = term.onData((data) => {
      // ZMODEM 传输进行中:Ctrl+C(0x03)应中止会话,而不是把原始字节写到 shell。
      // 否则远端 rz/sz 会继续等数据,终端卡在传输态,用户以为 ctrl+c 失效。
      if (zmodemSessionRef.current !== null && data === '\x03') {
        cancelZmodem()
        return
      }
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
      // Prompt detection runs on the control-stripped last line: PS1 with ANSI
      // colors / OSC-0 titles (Ubuntu default) never matches the bare regex.
      const lastLine = stripTerminalControl(chunk.split('\n').pop() ?? '').trimEnd()
      if (isShellPromptLine(lastLine)) {
        shellPromptSeenRef.current = true
        // Second cwd signal: default PS1 formats carry the cwd (`\u@\h:\w\$`,
        // `[root@host ~]#`); `~` expands against the login home. Works even
        // when OSC 7 injection never lands (custom shells, exotic prompts).
        const fromPrompt = extractPromptCwd(lastLine, homeRef.current)
        if (fromPrompt !== null) applyCwd(fromPrompt)
        if (osc7InjectPendingRef.current) tryInjectOsc7()
      }
    }

    /** Sentry `to_terminal`: decode non-ZMODEM octets into the terminal render path. */
    const handleTerminalOctets = (octets: number[]) => {
      handleChunk(decoder.decode(new Uint8Array(octets), { stream: true }))
    }

    /** Build the ZMODEM sentry that routes terminal bytes vs. the rz/sz protocol. */
    const setupZmodemSentry = () => {
      resetZmodem()
      zmodemSentryRef.current = new Zmodem.Sentry({
        to_terminal: handleTerminalOctets,
        sender: (octets) => {
          void tauriInvoke('ssh_write_binary', { id: sessionId, data: octets }).catch(() => {})
        },
        on_detect: (detection) => {
          const session = detection.confirm()
          zmodemSessionRef.current = session
          setZmodemType(session.type)
          setZmodemProgress(0)
          setZmodemFileName('')
          setZmodemTransferred(0)
          setZmodemTotal(0)
          if (session.type === 'send') {
            setZmodemStatus('远端 rz 已就绪，请选择要发送的文件')
            setZmodemPromptVisible(true)
            return
          }
          setZmodemStatus('正在等待远端文件…')
          setZmodemPromptVisible(true)
          session.on('offer', (...args: unknown[]) => {
            const transfer = args[0] as ZmodemTransfer
            const details = transfer.get_details()
            const total = details.size ?? 0
            setZmodemFileName(details.name)
            setZmodemTotal(total)
            setZmodemStatus(`正在接收 ${details.name}`)
            if (zmodemRecvTimerRef.current !== null) window.clearInterval(zmodemRecvTimerRef.current)
            zmodemRecvTimerRef.current = window.setInterval(() => {
              const offset = transfer.get_offset()
              setZmodemTransferred(offset)
              if (total > 0) setZmodemProgress(Math.min(99, (offset / total) * 100))
            }, 200)
            void transfer.accept().then((payloads) => {
              if (zmodemRecvTimerRef.current !== null) {
                window.clearInterval(zmodemRecvTimerRef.current)
                zmodemRecvTimerRef.current = null
              }
              setZmodemTransferred(total || zmodemTransferred)
              Zmodem.Browser.save_to_disk(payloads, details.name)
              setZmodemStatus(`已接收 ${details.name}`)
              setZmodemProgress(100)
            })
          })
          session.on('session_end', finishZmodem)
          session.start()
        },
        on_retract: () => {
          if (!zmodemSessionRef.current) finishZmodem()
        },
      })
    }

    // The sentry must exist before the first ssh:data byte arrives.
    setupZmodemSentry()

    /**
     * Initialize cwd from a silent exec right after connect: `pwd` yields the
     * login dir (= home, for prompt `~` expansion), `echo $0` + `ps -p $$ -o comm=`
     * reveal the login shell so the OSC 7 inject matches the shell dialect.
     */
    const initCwdFromExec = async () => {
      if (disposed) return
      try {
        const out = await tauriInvoke<string>('ssh_exec', { id: sessionId, command: 'pwd; echo $0; ps -p $$ -o comm= 2>/dev/null', timeoutSec: 5 })
        const cwd = parsePwdOutput(out)
        if (cwd !== null) {
          // The login dir doubles as the remote home for `~` expansion.
          homeRef.current = cwd
          // OSC 7 may have reported a fresher dir; only fill when empty
          if (cwdRef.current === '') applyCwd(cwd)
        }
        loginShellRef.current = parseLoginShell(out)
      } catch { /* fall back to later OSC 7 / prompt-path / pwd parsing */ } finally {
        shellProbedRef.current = true
        // Injection stays gated on a seen prompt (the shell must be idle at a
        // prompt — never mid-command or at a password prompt).
        if (shellPromptSeenRef.current && osc7InjectPendingRef.current) tryInjectOsc7()
      }
    }

    const connect = async () => {
      try {
        [unlistenData, unlistenClose, unlistenKb, unlistenHostkey] = await Promise.all([
          tauriListen<number[]>(`ssh:data:${sessionId}`, (bytes) => {
            // Feed raw octets into the ZMODEM sentry; it routes terminal text to
            // handleTerminalOctets and the rz/sz protocol to the active session.
            if (zmodemSentryRef.current !== null) zmodemSentryRef.current.consume(bytes)
          }),
          tauriListen<string>(`ssh:close:${sessionId}`, (reason) => {
            isConnectedRef.current = false
            setConnected(false)
            // 远端断开/超时:进入「已断开」态(此前与「连接中」共用同一文案,黄点永远转着)。
            setClosed(true)
            resetZmodem()
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
            // 堡垒机模式显式声明(serde 字段为 snake_case):仅在资产已配置时
            // 下发,存量资产缺省走后端旧行为(MFA 资产视为堡垒机)。
            ...(asset.config.bastionMode === undefined
              ? {}
              : { bastion_mode: asset.config.bastionMode === true }),
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
        setClosed(false)
        resizeObserver = new ResizeObserver(resize)
        if (host.current !== null) resizeObserver.observe(host.current)
        resize()
        term.focus()
        enableCwdTracking()
        void initCwdFromExec()
      } catch (caught) {
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : String(caught))
          // 建连失败也是终态:状态点/文字进「已断开」,头部给「重新连接」。
          setClosed(true)
        }
      }
    }

    void connect()
    return () => {
      disposed = true
      disposedRef.current = true
      isConnectedRef.current = false
      resetZmodem()
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
    // connectNonce:「重新连接」按下后重建会话与终端(asset 在窗口生命周期内恒定)。
  }, [asset, connectNonce])

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

  /** 处理主机密钥确认决策。拒绝时主动断开 SSH 会话并进入「已断开」态:
   *  此前先 setError 再立刻 onClose(),提示随 overlay 一起消失,用户看不到拒绝原因;
   *  现在保留工作区、显示原因,由用户决定「重新连接」还是「关闭」。*/
  const resolveHostKey = (allowed: boolean, persist: boolean): void => {
    if (hostKeyPrompt === null) return
    const promptSnapshot = hostKeyPrompt
    setHostKeyPrompt(null)
    if (allowed) {
      void tauriInvoke('ssh_hostkey_response', { id: sessionId, allowed: true, persist }).catch(() => {})
      return
    }
    // 拒绝:不信任该指纹,断开本次会话;错误留在工作区内可见。
    void tauriInvoke('ssh_hostkey_response', { id: sessionId, allowed: false, persist: false })
      .catch(() => { /* 后端 sender 可能已被取消;失败不阻塞下面的断开 */ })
    void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
    if (!disposedRef.current) {
      setError(`已拒绝主机密钥:${promptSnapshot.remote} (${promptSnapshot.keyType})`)
      setConnected(false)
      setClosed(true)
    }
  }

  /** 重新连接:清掉上一轮的断开原因,代次 +1 重跑建连 effect。 */
  const reconnect = (): void => {
    setError(null)
    setClosed(false)
    setConnectNonce(n => n + 1)
  }

  // SFTP 传输任务投影(会话级,2026-09-11 弹框化):监听与 SftpPanel 生命周期
  // 解耦——关掉「文件」页签后传输在后台继续,徽标仍在;弹框由本层承载。
  // 注意:本 hook 必须保持在组件末尾、所有 useEffect 之后调用——其 effect 的
  // 事件监听器注册顺序晚于终端自身的 ssh:data 等监听,既有测试按回调注册
  // 序号取监听器,前置会整体移位。
  const transferTasks = useTransferTasks(sessionId)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)

  const sidePanelLabel = '文件传输'
  const toggleSidePanel = (panel: Exclude<SidePanel, null>): void => {
    setSidePanel(current => current === panel ? null : panel)
  }

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`SSH 工作区 ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span className={connected ? css.statusOnline : (closed ? css.statusOffline : css.statusPending)} aria-label={connected ? 'SSH 已连接' : (closed ? 'SSH 已断开' : 'SSH 连接中')} />
            <div className={css.identity}>
              <span className={css.title}>{asset.name}</span>
              <span className={css.endpoint}>{typeof asset.config.username === 'string' ? `${asset.config.username}@` : ''}{typeof asset.config.host === 'string' ? asset.config.host : '未配置主机'}</span>
            </div>
          </div>
          <div className={css.headRight}>
            {!connected && closed && (
              <button type="button" className={css.reconnectAction} onClick={reconnect} title="重新建立 SSH 连接">重新连接</button>
            )}
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
              >
                <IconFolderOpenOutline16 size={15} /> 文件
                {transferTasks.activeCount > 0 && (
                  <span
                    className={css.tabBadge}
                    title={`${transferTasks.activeCount} 个传输任务进行中(点击查看)`}
                    onClick={(event) => {
                      // 徽标点击直接开传输弹框,不切换侧栏
                      event.stopPropagation()
                      setTransferDialogOpen(true)
                    }}
                  >{transferTasks.activeCount}</span>
                )}
              </button>
              <button
                type="button"
                className={css.workspaceTab}
                onClick={() => {
                  if (!connected) return
                  void tauriInvoke('ssh_open_web_window', { sessionId, assetName: asset.name }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
                }}
                title={connected ? '在独立窗口打开网页访问(webview)' : '等待 SSH 连接后启用网页访问'}
                aria-pressed={false}
              ><IconLinkOutline16 size={15} /> 网页</button>
              <span className={css.connectionState}><span className={connected ? css.connectionOnline : (closed ? css.connectionOffline : css.connectionPending)} />{connected ? '已连接' : (closed ? '已断开' : '连接中')}</span>
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
            <input
              ref={zmodemInputRef} className={css.fileInput} type="file" multiple
              aria-label="选择 ZMODEM 发送文件"
              onChange={(event) => void onZmodemFilesSelected(event)}
            />
            {zmodemPromptVisible && (
              <div className={css.zmodemBackdrop}>
                <div className={css.zmodemDialog} role="dialog" aria-label="ZMODEM 传输">
                  <div className={css.zmodemHead}>
                    <span className={css.zmodemLabel}>ZMODEM</span>
                    <span className={css.zmodemStatus}>{zmodemStatus}</span>
                  </div>
                  {zmodemFileName !== '' && (
                    <span className={css.zmodemFile}>
                      {zmodemFileName} ({formatSize(zmodemTransferred)} / {formatSize(zmodemTotal)})
                    </span>
                  )}
                  <div className={css.zmodemTrack} aria-hidden="true">
                    <div className={css.zmodemFill} style={{ width: `${zmodemProgress}%` }} />
                  </div>
                  <div className={css.zmodemActions}>
                    {zmodemType === 'send' && (
                      <button type="button" className={css.zmodemBtnPrimary} onClick={chooseZmodemFiles}>选择文件</button>
                    )}
                    <button type="button" className={css.zmodemBtn} onClick={cancelZmodem}>取消</button>
                  </div>
                </div>
              </div>
            )}
            <div ref={host} className={css.terminal} />
          </main>
          {sidePanel !== null && (
            <div
              className={css.sidePanelResize}
              onPointerDown={onSidePanelResizeStart}
              onPointerMove={onSidePanelResizeMove}
              onPointerUp={onSidePanelResizeEnd}
              onPointerCancel={onSidePanelResizeEnd}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧边栏宽度"
            />
          )}
          {sidePanel !== null && (
            <aside className={css.sidePanel} style={{ '--side-panel-width': `${sidePanelWidth}px` } as CSSProperties} aria-label={sidePanelLabel}>
              <header className={css.sidePanelHeader}>
                <div>
                  <span className={css.sidePanelTitle}>{sidePanelLabel}</span>
                  <span className={css.sidePanelDetail}>与当前 SSH 会话共享连接</span>
                </div>
              </header>
              <div className={css.sidePanelBody}>
                <SftpPanel
                  asset={asset}
                  sessionId={sessionId}
                  sshConnected={connected}
                  sshCwd={sshCwd}
                  onFollowTerminal={onFollowTerminal}
                  transferActiveCount={transferTasks.activeCount}
                  onOpenTransfers={() => { setTransferDialogOpen(true) }}
                  uploadDoneNonce={transferTasks.uploadDoneNonce}
                />
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
      {transferDialogOpen && (
        <TransferDialog
          sessionId={sessionId}
          api={transferTasks}
          onClose={() => { setTransferDialogOpen(false) }}
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
        <div
          className={css.kbBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="MFA 验证"
          onKeyDown={(event) => {
            // Enter 在任何输入框中提交验证码(等价点击「提交验证码」),避免用户
            // 输完验证码还要移动鼠标点按钮;Escape 关闭弹窗并断开当前连接。
            if (event.key === 'Enter') {
              event.preventDefault()
              submitKbAnswers()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
              if (!disposedRef.current) {
                setKbPrompt(null)
                setKbAnswers([])
              }
            }
          }}
        >
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
