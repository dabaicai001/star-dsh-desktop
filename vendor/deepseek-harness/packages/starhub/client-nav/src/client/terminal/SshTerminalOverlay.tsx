/**
 * Shell-native SSH/SFTP terminal workspace.
 *
 * Opened in-page (no new window) when an SSH asset is clicked. Owns one xterm
 * instance connected via the StarHub interactive SSH session, and exposes
 * side panels that reuse the same live session: SFTP file transfer, the SSH AI
 * assistant, and host monitoring. SSH terminal and SFTP inherently share one
 * connection, so they ride the same workspace.
 *
 * cwd tracking (SFTP「跟随终端」): the terminal tracks the remote cwd from the
 * PTY stream (OSC 7 + prompt-path extraction + `pwd` fallback) and lazily
 * injects a dialect-matched OSC 7 hook into the running shell once follow is
 * enabled, the shell probe settled, and a prompt is seen, so `cd` reports cwd
 * live. The tracked `sshCwd` is handed to the SFTP panel for follow-nav.
 *
 * Workspace chrome (top → bottom): header (identity + status + session-level
 * actions) → toolbar (view tabs, quick commands, terminal tools) → terminal
 * with optional side panel → status bar (cwd, session id, grid, encoding,
 * duration, transfers). Keyboard: Ctrl/⌘+K command palette, Ctrl/⌘+F find.
 *
 * @module StarHub SSH/SFTP terminal workspace (client)
 */
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  IconCheckOutlineMedium, IconChevronsUpDownOutlineMedium, IconCloseCircleFillMedium, IconCloseFillMedium,
  IconCloseOutlineMedium, IconClockOutlineMedium, IconCodeOutlineMedium, IconCopyOutlineMedium,
  IconFolderOpenOutlineMedium, IconFullscreenOutlineMedium, IconGaugeOutlineMedium, IconPaperclipOutlineMedium,
  IconPlusOutlineMedium, IconRefreshOutlineMedium, IconSearchOutlineMedium, IconSlidersTwoOutlineMedium,
  IconSparkleMedium, IconUsersOutlineMedium, IconWarningTriangleOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import ZmodemModule from 'zmodem.js/src/zmodem_browser.js'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import type { RustAsset } from '../store.ts'
import { SftpPanel } from './SftpPanel.tsx'
import { SshAssistantPanel } from './SshAssistantPanel.tsx'
import { closeAssistant } from './assistant-service.ts'
import { TransferDialog } from './TransferDialog.tsx'
import { useTransferTasks } from './use-transfer-tasks.ts'
import { formatSize } from './sftp-service.ts'
import { BroadcastDialog, type BroadcastSession } from './BroadcastDialog.tsx'
import { createQuickCommand, importQuickCommands, loadQuickCommands, saveQuickCommands, type QuickCommand } from './quick-commands.ts'
import { clampSidePanelWidth, loadSidePanelWidth, saveSidePanelWidth } from './side-panel-width.ts'
import { loadCommandHistory, pushCommandHistory, reduceInputLine, type CommandHistoryEntry } from './command-history.ts'
import { findMatches, stepMatchIndex, type FindMatch } from './terminal-find.ts'
import { CommandPalette, type PaletteAction } from './CommandPalette.tsx'
import { TerminalFindBar } from './TerminalFindBar.tsx'
import { TerminalSettingsMenu } from './TerminalSettingsMenu.tsx'
import { HostMonitorPanel } from './HostMonitorPanel.tsx'
import { useTerminalTheme } from './terminal-theme.ts'
import { terminalOptions, updateTerminalSettings, useTerminalSettings } from './terminal-settings.ts'
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

/** Props for one native SSH/SFTP terminal workspace. */
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

type SidePanel = 'sftp' | 'ai' | 'monitor' | null

/** 工具条字号按钮的调节范围(与设置浮层滑块一致)。 */
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 22

/** 提示自动消失时长(ms)。 */
const TOAST_TIMEOUT_MS = 6000

/** 提示语气:成功 / 失败 / 中性。 */
type ToastTone = 'success' | 'error' | 'info'

/** 一条悬浮提示。 */
interface Toast {
  text: string
  tone: ToastTone
}

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
 * 终端实例会话 id 的随机后缀长度(base36 位数:36^6 ≈ 2.2e9 种,同机撞号概率可忽略)。
 */
const SESSION_SUFFIX_CHARS = 6

/**
 * 生成一个终端实例独占的 SSH 会话 id(`<assetId>__<6 位 base36 随机>`)。
 *
 * 会话 id 既是 sidecar 会话表的键,也是 `ssh:data:<id>` 这类事件的事件名:两个窗口共用
 * `asset.id` 时会命中同一个键——第二个 `ssh_connect` 覆盖第一个的会话,两个窗口读写
 * 同一条 shell(输入互相串台、还能看到对方注入 OSC 7 的回显),关掉任一个窗口还会把
 * 另一个的连接一起断掉。每次挂载取一个新后缀,同资产的多个窗口就彼此独立;同一个实例
 * 内「重新连接」沿用同一个 id(只换连接代次)。
 * @param assetId - 资产 id(保留在 id 前缀里,便于从日志看出会话属于哪个资产)。
 * @returns 形如 `5fcb151b-ab1d-42df-b8ce-03a6c1f9b45c__k3f9a2` 的实例会话 id。
 */
export function terminalSessionId(assetId: string): string {
  const suffix = Math.floor(Math.random() * 36 ** SESSION_SUFFIX_CHARS)
    .toString(36)
    .padStart(SESSION_SUFFIX_CHARS, '0')
  return `${assetId}__${suffix}`
}

/**
 * 毫秒时长转 `mm:ss` / `h:mm:ss`(头部连接时长用)。
 * @param ms - 毫秒数。
 * @returns 时钟格式时长。
 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** 夹在字号按钮的合法区间内。 */
function clampFontSize(value: number): number {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value))
}

/**
 * Render one xterm instance backed by a StarHub interactive SSH session, with
 * cwd tracking for the SFTP follow-terminal flow. Each workspace owns its own
 * session id (see {@link terminalSessionId}), so two windows on the same asset
 * never share a shell.
 * @param props - selected SSH asset and workspace close callback.
 * @returns the native SSH/SFTP terminal workspace.
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
  // SFTP / 网页右栏宽度(px):拖左边框调整,夹在 min 与 max 之间;宽度记忆在
  // localStorage(side-panel-width.ts),重开侧栏沿用上次拖好的值。
  const [sidePanelWidth, setSidePanelWidth] = useState(loadSidePanelWidth)
  const sidePanelResizeRef = useRef(false)
  // 拖拽中的最新宽度:end 回调读它落盘——useCallback 闭包里的 state 是旧的。
  const sidePanelWidthRef = useRef(sidePanelWidth)
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
    const next = clampSidePanelWidth(rect.right - event.clientX)
    sidePanelWidthRef.current = next
    setSidePanelWidth(next)
  }, [])
  const onSidePanelResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidePanelResizeRef.current) return
    sidePanelResizeRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    saveSidePanelWidth(sidePanelWidthRef.current)
  }, [])
  const [sshCwd, setSshCwd] = useState('')
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(loadQuickCommands)
  const [quickEditorOpen, setQuickEditorOpen] = useState(false)
  // 客户端记录的「最近命令」(onData 还原输入行,回车时入账)。
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>(loadCommandHistory)
  // MFA/2FA:服务器 keyboard-interactive 请求(非空时渲染验证码输入弹窗)。
  const [kbPrompt, setKbPrompt] = useState<KbInteractiveEvent | null>(null)
  const [kbAnswers, setKbAnswers] = useState<string[]>([])
  // 新主机密钥:首次连接新服务器时后端要求用户确认指纹(非空时阻断 SSH 终端、
  // 渲染三选项弹窗:拒绝 / 仅本次 / 信任并保存)。
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyConfirmEvent | null>(null)
  const quickImportRef = useRef<HTMLInputElement>(null)
  // 命令广播(需求 6 broadcast 子集):弹层会话列表 + 发送结果提示。
  const [broadcastSessions, setBroadcastSessions] = useState<BroadcastSession[] | null>(null)
  // 悬浮提示(广播结果 / 快捷命令发送 / 复制粘贴反馈)。
  const [toast, setToast] = useState<Toast | null>(null)
  /** 弹一条悬浮提示。 */
  const notify = useCallback((text: string, tone: ToastTone = 'success') => { setToast({ text, tone }) }, [])
  // 工作台展示态:全屏 / 命令面板 / 终端设置浮层 / 查找条。
  const [fullscreen, setFullscreen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findHits, setFindHits] = useState<FindMatch[]>([])
  const [findIndex, setFindIndex] = useState(-1)
  // 状态栏:终端网格尺寸 + 连接时刻(连接时长)。
  const [grid, setGrid] = useState({ cols: 0, rows: 0 })
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
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
        on_file_complete: (file) => {
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

  // 每个终端实例一条独立会话(见 terminalSessionId):同资产开两个窗口时互不串台。
  const [sessionId] = useState(() => terminalSessionId(asset.id))
  // cwd / injection state shared between the effect and the follow callback.
  const isConnectedRef = useRef(false)
  const osc7InjectPendingRef = useRef(false)
  const osc7InjectedRef = useRef(false)
  const shellPromptSeenRef = useRef(false)
  const cwdRef = useRef('')
  // 当前输入行(用于还原「最近命令」)。
  const inputLineRef = useRef('')
  // FitAddon 句柄:字号/字体变化后重新适配网格。
  const fitRef = useRef<FitAddon | null>(null)
  // PTY 解码器:编码设置变化时换新(流式状态随之重置)。
  const decoderRef = useRef<TextDecoder | null>(null)
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
    // 抑制窗口只包住注入回显:含 __starhub_osc7 的回显行被整行剔除(原位代入
    // 行复位,否则 shell 重印的提示符会紧贴上一个,屏幕上并排两个提示符)
    // 后自动解除。窗口外零缓冲透传——常驻过滤会把行尾 `_`(marker 前缀)
    // 扣到下个 chunk,表现为「终端里下划线丢失 / 下个字符到达时一次蹦出两个」。
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

  // 编码设置变化 → 换解码器(下一次 chunk 起生效)。
  useEffect(() => {
    decoderRef.current = new TextDecoder(terminalSettings.encoding)
  }, [terminalSettings.encoding])

  // 终端显示设置实时生效:字体 / 字号 / 光标 / 回滚行数改了立刻应用到实例,
  // 并按新网格重新 resize PTY。主题由 useTerminalTheme 另路刷新。
  useEffect(() => {
    const term = termRef.current
    const options = term?.options
    if (term === null || options === undefined) return
    options.fontFamily = terminalSettings.fontFamily
    options.fontSize = terminalSettings.fontSize
    options.cursorBlink = terminalSettings.cursorBlink
    options.scrollback = terminalSettings.scrollback
    fitRef.current?.fit()
    if (isConnectedRef.current) {
      void tauriInvoke('ssh_resize', { id: sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
    }
  }, [sessionId, terminalSettings, termRef])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme/settings 在挂载时创建终端;主题由 useTerminalTheme 动态重刷,字体/字号/编码下次打开生效。
    const term = new Terminal({
      ...terminalOptions(terminalSettings),
      theme,
    })
    termRef.current = term
    const addon = new FitAddon()
    fitRef.current = addon
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

    const input = term.onData((data) => {
      // ZMODEM 传输进行中:Ctrl+C(0x03)应中止会话,而不是把原始字节写到 shell。
      // 否则远端 rz/sz 会继续等数据,终端卡在传输态,用户以为 ctrl+c 失效。
      if (zmodemSessionRef.current !== null && data === '\x03') {
        cancelZmodem()
        return
      }
      // 还原输入行:回车时作为一条「最近命令」入账(供命令面板复用)。
      const reduced = reduceInputLine(inputLineRef.current, data)
      inputLineRef.current = reduced.line
      if (reduced.submitted !== null) {
        setCommandHistory(current => pushCommandHistory(current, reduced.submitted as string))
      }
      if (isConnectedRef.current) void tauriInvoke('ssh_write', { id: sessionId, data }).catch(() => {})
    })

    const resize = () => {
      addon.fit()
      setGrid({ cols: term.cols, rows: term.rows })
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
      const decoder = decoderRef.current ?? new TextDecoder(terminalSettings.encoding)
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
          if (zmodemSessionRef.current === null) finishZmodem()
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
        setConnectedAt(Date.now())
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
      const decoder = decoderRef.current
      const tail = decoder === null ? '' : decoder.decode()
      if (tail) handleChunk(tail)
      void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
      term.dispose()
      fitRef.current = null
    }
    // connectNonce:「重新连接」按下后重建会话与终端(asset 在窗口生命周期内恒定)。
  }, [asset, connectNonce])

  /** 打开广播弹层:拉取所有已连接的 SSH 会话作为目标列表。 */
  const openBroadcast = async (): Promise<void> => {
    setToast(null)
    try {
      const infos = await tauriInvoke<Array<{ id: string; host?: string; port?: number; username?: string; connected?: boolean }>>('ssh_get_sessions')
      const sessions: BroadcastSession[] = infos
        .filter(s => s.connected === true)
        .map((s) => {
          const endpoint = `${s.username ?? ''}@${s.host ?? ''}:${s.port ?? 22}`
          // 会话 id 现在是「资产 id__随机后缀」(同资产可开多窗口),不适合当标题:
          // 自己的窗口显示资产名,别人的窗口显示主机(端点留在下一行)。
          return { sessionId: s.id, title: s.id === sessionId ? asset.name : (s.host ?? s.id), host: endpoint }
        })
      if (sessions.length === 0) {
        notify('没有已连接的会话可用于广播', 'info')
        return
      }
      setBroadcastSessions(sessions)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const runQuickCommand = async (command: QuickCommand): Promise<void> => {
    if (!connected) return
    try {
      await tauriInvoke('ssh_write', { id: sessionId, data: `${command.cmd}\n` })
      notify(`已发送: ${command.label}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 把一条命令写入当前会话(命令面板 / 最近命令共用)。 */
  const runCommand = useCallback(async (command: string): Promise<void> => {
    if (!connected || command.trim() === '') return
    try {
      await tauriInvoke('ssh_write', { id: sessionId, data: `${command}\n` })
      notify(`已发送: ${command}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [connected, notify, sessionId])

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
      notify(`已导入 ${result.commands.length} 条快捷命令${result.skippedScripts > 0 ? `，跳过 ${result.skippedScripts} 条本地脚本` : ''}`)
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
    notify(failed === 0
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

  // ── 终端工具动作 ────────────────────────────────────────────────

  /** 清空终端缓冲。 */
  const clearTerminal = useCallback(() => { termRef.current?.clear() }, [termRef])

  /** 复制终端选中内容到剪贴板。 */
  const copySelection = useCallback(async (): Promise<void> => {
    const selection = termRef.current?.getSelection()
    if (selection === undefined || selection === '') {
      notify('终端里没有选中内容', 'info')
      return
    }
    try {
      await navigator.clipboard.writeText(selection)
      notify('已复制选中内容')
    } catch {
      notify('复制失败:浏览器拒绝了剪贴板访问', 'error')
    }
  }, [notify, termRef])

  /** 把剪贴板内容粘贴进终端。 */
  const pasteClipboard = useCallback(async (): Promise<void> => {
    const term = termRef.current
    if (term === null) return
    try {
      const text = await navigator.clipboard.readText()
      if (text !== '') term.paste(text)
    } catch {
      notify('粘贴失败:浏览器拒绝了剪贴板访问', 'error')
    }
  }, [notify, termRef])

  /** 增减字号(夹在按钮区间内)。 */
  const bumpFontSize = useCallback((delta: number) => {
    updateTerminalSettings({ fontSize: clampFontSize(terminalSettings.fontSize + delta) })
  }, [terminalSettings.fontSize])

  /** 打开查找条。 */
  const openFind = useCallback(() => { setFindOpen(true) }, [])

  /** 跳到上一个 / 下一个命中。 */
  const stepFind = useCallback((forward: boolean) => {
    setFindIndex(current => stepMatchIndex(findHits.length, current, forward))
  }, [findHits.length])

  // 查找关键字变化 → 重扫缓冲区并跳到第一个命中。
  // connected 也列入依赖:重连会重建终端实例,扫的是新缓冲区。
  useEffect(() => {
    if (!findOpen) return
    const term = termRef.current
    if (term === null) return
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)
      lines.push(line === undefined ? '' : line.translateToString(true))
    }
    const hits = findMatches(lines, findQuery)
    setFindHits(hits)
    setFindIndex(hits.length > 0 ? 0 : -1)
  }, [connected, findOpen, findQuery, termRef])

  // 当前命中变化 → 高亮并滚到可见区。
  useEffect(() => {
    const term = termRef.current
    const hit = findHits[findIndex]
    if (term === null || hit === undefined) return
    term.select(hit.row, hit.col, hit.length)
    term.scrollToLine(hit.row)
  }, [findHits, findIndex, termRef])

  // 全局快捷键:Ctrl/⌘+K 命令面板、Ctrl/⌘+F 查找、Esc 逐层关闭。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFindOpen(true)
        return
      }
      if (event.key !== 'Escape') return
      if (paletteOpen) setPaletteOpen(false)
      else if (findOpen) setFindOpen(false)
      else if (settingsOpen) setSettingsOpen(false)
      else if (fullscreen) setFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [findOpen, fullscreen, paletteOpen, settingsOpen])

  // 连接时长:仅已连接时走秒针,避免空转重渲。
  useEffect(() => {
    if (!connected) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [connected])

  // 悬浮提示自动消失。
  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => { setToast(null) }, TOAST_TIMEOUT_MS)
    return () => { window.clearTimeout(timer) }
  }, [toast])

  // SFTP 传输任务投影(会话级,2026-09-11 弹框化):监听与 SftpPanel 生命周期
  // 解耦——关掉「文件」页签后传输在后台继续,徽标仍在;弹框由本层承载。
  // 注意:本 hook 必须保持在组件末尾、所有 useEffect 之后调用——其 effect 的
  // 事件监听器注册顺序晚于终端自身的 ssh:data 等监听,既有测试按回调注册
  // 序号取监听器,前置会整体移位。
  const transferTasks = useTransferTasks(sessionId)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)

  const sidePanelLabel = sidePanel === 'ai' ? 'AI 助手' : sidePanel === 'monitor' ? '主机监控' : '文件传输'
  const sidePanelDetail = sidePanel === 'ai'
    ? '复用 dsh 模型连接'
    : sidePanel === 'monitor' ? '只读采集,不干扰终端会话' : '与当前 SSH 会话共享连接'
  const toggleSidePanel = (panel: Exclude<SidePanel, null>): void => {
    setSidePanel(current => current === panel ? null : panel)
  }
  // 助手会话 id:面板打开时回传,overlay 卸载(关页面)时销毁——助手随终端
  // 页开合自动建/销毁,不在后台常驻。
  const assistantIdRef = useRef<string | null>(null)
  useEffect(() => () => {
    const opened = assistantIdRef.current
    if (opened !== null) {
      assistantIdRef.current = null
      void closeAssistant(opened).catch(() => undefined)
    }
  }, [])
  // 头部头像徽标:取资产名首字符,颜色随连接状态变化。
  const avatarInitial = (asset.name.trim().charAt(0) || '?').toUpperCase()
  const endpoint = `${typeof asset.config.username === 'string' ? `${asset.config.username}@` : ''}${typeof asset.config.host === 'string' ? asset.config.host : '未配置主机'}${typeof asset.config.port === 'number' ? `:${asset.config.port}` : ''}`

  /** 命令面板动作清单(快捷命令 / 最近命令 / 终端操作 / 工作区)。 */
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = []
    for (const command of quickCommands) {
      actions.push({
        id: `quick-${command.id}`,
        label: command.label === '' ? command.cmd : command.label,
        hint: command.cmd,
        group: '快捷命令',
        disabled: !connected,
        run: () => { void runQuickCommand(command) },
      })
    }
    for (const entry of commandHistory.slice(0, 12)) {
      actions.push({
        id: `history-${entry.at}-${entry.cmd}`,
        label: entry.cmd,
        group: '最近命令',
        disabled: !connected,
        run: () => { void runCommand(entry.cmd) },
      })
    }
    actions.push(
      { id: 'act-clear', label: '清空终端', hint: 'Ctrl+L', group: '终端操作', run: clearTerminal },
      { id: 'act-copy', label: '复制选中内容', group: '终端操作', run: () => void copySelection() },
      { id: 'act-paste', label: '粘贴到终端', group: '终端操作', run: () => void pasteClipboard() },
      { id: 'act-find', label: '查找终端输出', hint: 'Ctrl+F', group: '终端操作', run: openFind },
      { id: 'act-font-inc', label: '增大字号', group: '终端操作', run: () => { bumpFontSize(1) } },
      { id: 'act-font-dec', label: '减小字号', group: '终端操作', run: () => { bumpFontSize(-1) } },
      { id: 'act-fullscreen', label: fullscreen ? '退出全屏' : '全屏显示', group: '终端操作', run: () => { setFullscreen(value => !value) } },
      { id: 'act-sftp', label: '打开文件面板', group: '工作区', run: () => { setSidePanel('sftp') } },
      { id: 'act-ai', label: '打开 AI 助手', group: '工作区', run: () => { setSidePanel('ai') } },
      { id: 'act-monitor', label: '打开主机监控', group: '工作区', run: () => { setSidePanel('monitor') } },
      { id: 'act-broadcast', label: '广播命令到多个会话', group: '工作区', run: () => void openBroadcast() },
      { id: 'act-quick', label: '管理快捷命令', group: '工作区', run: () => { setQuickEditorOpen(true) } },
      { id: 'act-settings', label: '终端设置', group: '工作区', run: () => { setSettingsOpen(true) } },
      { id: 'act-reconnect', label: '重新连接', group: '工作区', disabled: connected, run: reconnect },
    )
    return actions
    // openBroadcast / runQuickCommand / reconnect 等每次渲染都是新闭包,但它们只被
    // 面板调用一次;列入依赖会让 useMemo 每拍重算,失去意义。
  }, [bumpFontSize, clearTerminal, commandHistory, connected, copySelection, fullscreen, openFind, pasteClipboard, quickCommands, runCommand])

  return (
    <div className={css.backdrop}>
      <section className={`${css.panel} ${fullscreen ? css.panelFullscreen : ''}`} aria-label={`SSH 工作区 ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span
              className={`${css.avatar} ${connected ? css.avatarOnline : (closed ? css.avatarOffline : css.avatarPending)}`}
              aria-hidden="true"
            >{avatarInitial}</span>
            <div className={css.identity}>
              <span className={css.title}>{asset.name}</span>
              <span className={css.endpoint}>{endpoint}</span>
            </div>
            <span
              className={`${css.statusPill} ${connected ? css.statusPillOnline : (closed ? css.statusPillOffline : css.statusPillPending)}`}
              aria-label={connected ? 'SSH 已连接' : (closed ? 'SSH 已断开' : 'SSH 连接中')}
            >
              <span className={connected ? css.connectionOnline : (closed ? css.connectionOffline : css.connectionPending)} aria-hidden="true" />
              <span className={css.statusPillText}>{connected ? '已连接' : (closed ? '已断开' : '连接中')}</span>
            </span>
            {connected && connectedAt !== null && (
              <span className={css.duration} title="本次连接已持续">
                <IconClockOutlineMedium size={12} />{formatDuration(now - connectedAt)}
              </span>
            )}
          </div>
          <div className={css.headRight}>
            {!connected && closed && (
              <button type="button" className={css.reconnectAction} onClick={reconnect} title="重新建立 SSH 连接"><IconRefreshOutlineMedium size={13} />重新连接</button>
            )}
            <button
              type="button"
              className={css.broadcastAction}
              onClick={() => void openBroadcast()}
              title="命令广播:把同一命令发送到多个已连接 SSH 会话"
              aria-label="广播"
            ><IconUsersOutlineMedium size={14} /><span>广播</span><span className={css.broadcastDetail}>命令</span></button>
            <span className={css.settingsAnchor}>
              <button
                type="button"
                className={settingsOpen ? css.headerActionActive : css.headerAction}
                onClick={() =>{  setSettingsOpen(open => !open) }}
                title="终端设置:字体 / 字号 / 编码 / 回滚行数"
                aria-label="终端设置"
                aria-expanded={settingsOpen}
              ><IconSlidersTwoOutlineMedium size={15} /></button>
              {settingsOpen && <TerminalSettingsMenu settings={terminalSettings} onClose={() =>{  setSettingsOpen(false) }} />}
            </span>
            <button
              type="button"
              className={fullscreen ? css.headerActionActive : css.headerAction}
              onClick={() =>{  setFullscreen(value => !value) }}
              title={fullscreen ? '退出全屏 (Esc)' : '全屏显示'}
              aria-label="全屏显示"
              aria-pressed={fullscreen}
            ><IconFullscreenOutlineMedium size={15} /></button>
            <span className={css.headerDivider} aria-hidden="true" />
            <button type="button" className={css.iconButton} onClick={onClose} title="关闭" aria-label="关闭 SSH 工作区"><IconCloseOutlineMedium size={16} /></button>
          </div>
        </header>
        {error !== null && <div className={css.error} role="alert">{error}</div>}
        <input ref={quickImportRef} className={css.fileInput} type="file" accept=".qbl,.qblx" onChange={event => void importQuickCommandFile(event)} />
        <div className={css.workspace}>
          {toast !== null && (
            <div className={`${css.notice} ${css[`notice_${toast.tone}`]}`} role="status">
              <span className={css.noticeMark} aria-hidden="true">
                {toast.tone === 'error'
                  ? <IconWarningTriangleOutlineMedium size={12} />
                  : toast.tone === 'info' ? <IconChevronsUpDownOutlineMedium size={12} /> : <IconCheckOutlineMedium size={13} />}
              </span>
              <span className={css.noticeText}>{toast.text}</span>
              <button type="button" className={css.noticeClose} onClick={() =>{  setToast(null) }} aria-label="关闭提示"><IconCloseFillMedium size={11} /></button>
            </div>
          )}
          <main className={css.terminalWorkspace} aria-label="SSH 终端">
            <div className={css.toolbar}>
              <div className={css.tabGroup} role="tablist" aria-label="SSH 工作区">
                <span className={css.terminalTab} role="tab" aria-selected="true"><IconCodeOutlineMedium size={13} />终端</span>
                <button
                  type="button"
                  className={sidePanel === 'sftp' ? css.workspaceTabActive : css.workspaceTab}
                  onClick={() =>{  toggleSidePanel('sftp') }}
                  title={connected ? '显示或隐藏 SFTP 文件面板' : '等待 SSH 连接后启用 SFTP'}
                  aria-pressed={sidePanel === 'sftp'}
                >
                  <IconFolderOpenOutlineMedium size={13} />文件
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
                  className={sidePanel === 'ai' ? css.workspaceTabActive : css.workspaceTab}
                  onClick={() =>{  toggleSidePanel('ai') }}
                  title="AI 助手:操作这台已连接的服务器(复用 dsh 模型连接)"
                  aria-pressed={sidePanel === 'ai'}
                ><IconSparkleMedium size={13} />AI</button>
                <button
                  type="button"
                  className={sidePanel === 'monitor' ? css.workspaceTabActive : css.workspaceTab}
                  onClick={() =>{  toggleSidePanel('monitor') }}
                  title="主机监控:负载 / 内存 / 磁盘 / 网络"
                  aria-pressed={sidePanel === 'monitor'}
                ><IconGaugeOutlineMedium size={13} />监控</button>
              </div>
              <div className={css.quickList} aria-label="快捷命令">
                {quickCommands.map(command => (
                  <button key={command.id} type="button" className={css.quickCommand} onClick={() => void runQuickCommand(command)} disabled={!connected} title={command.cmd}>{command.label}</button>
                ))}
                {quickCommands.length === 0 && (
                  <button type="button" className={css.quickEmpty} onClick={() =>{  setQuickEditorOpen(true) }} title="管理快捷命令">
                    添加常用 SSH 命令
                  </button>
                )}
              </div>
              <div className={css.quickTools}>
                <button type="button" className={css.quickIconButton} onClick={() => quickImportRef.current?.click()} title="导入 Xshell .qbl / .qblx" aria-label="导入 Xshell 快捷命令"><IconPaperclipOutlineMedium size={14} /></button>
                <button type="button" className={css.quickIconButton} onClick={() =>{  setQuickEditorOpen(true) }} title={`管理快捷命令(已保存 ${quickCommands.length} 条)`} aria-label="管理快捷命令"><IconPlusOutlineMedium size={14} /></button>
              </div>
              <span className={css.toolDivider} aria-hidden="true" />
              <div className={css.toolGroup}>
                <button type="button" className={css.fontButton} onClick={() =>{  bumpFontSize(-1) }} title="减小字号" aria-label="减小字号">A−</button>
                <button type="button" className={css.fontButton} onClick={() =>{  bumpFontSize(1) }} title="增大字号" aria-label="增大字号">A+</button>
                <button type="button" className={css.toolButton} onClick={clearTerminal} title="清空终端" aria-label="清空终端"><IconCloseCircleFillMedium size={14} /></button>
                <button type="button" className={css.toolButton} onClick={() => void copySelection()} title="复制选中内容" aria-label="复制选中内容"><IconCopyOutlineMedium size={14} /></button>
                <button type="button" className={css.toolButton} onClick={() => void pasteClipboard()} title="粘贴剪贴板内容到终端" aria-label="粘贴到终端">粘贴</button>
                <button type="button" className={css.toolButton} onClick={openFind} title="在终端输出中查找 (Ctrl+F)" aria-label="查找终端输出"><IconSearchOutlineMedium size={14} /></button>
                <button type="button" className={css.toolButton} onClick={() =>{  setPaletteOpen(true) }} title="命令面板 (Ctrl+K)" aria-label="打开命令面板"><IconChevronsUpDownOutlineMedium size={14} /></button>
              </div>
            </div>
            <input
              ref={zmodemInputRef} className={css.fileInput} type="file" multiple
              aria-label="选择 ZMODEM 发送文件"
              onChange={event => void onZmodemFilesSelected(event)}
            />
            {zmodemPromptVisible && (
              <div
                className={css.zmodemBackdrop}
                onClick={() => {
                  // 仅在等待选文件阶段把遮罩点击视为取消;传输进行中不误伤。
                  if (zmodemType === 'send' && zmodemProgress === 0) cancelZmodem()
                }}
              >
                <div className={css.zmodemDialog} role="dialog" aria-label="ZMODEM 传输" onClick={(event) => { event.stopPropagation() }}>
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
            <div className={css.terminalLayer}>
              <div ref={host} className={css.terminal} />
              {findOpen && (
                <TerminalFindBar
                  query={findQuery}
                  onQueryChange={setFindQuery}
                  matchCount={findHits.length}
                  activeIndex={findIndex}
                  onStep={stepFind}
                  onClose={() =>{  setFindOpen(false) }}
                />
              )}
            </div>
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
                  <span className={css.sidePanelDetail}>{sidePanelDetail}</span>
                </div>
                <button type="button" className={css.sidePanelClose} onClick={() =>{  setSidePanel(null) }} title="收起面板" aria-label="收起侧边面板">
                  <IconCloseOutlineMedium size={14} />
                </button>
              </header>
              <div className={css.sidePanelBody}>
                {sidePanel === 'ai'
                  ? (
                    <SshAssistantPanel
                      sshSessionId={sessionId}
                      assetId={asset.id}
                      assetName={asset.name}
                      onOpened={(id) =>{  assistantIdRef.current = id }}
                    />
                  )
                  : sidePanel === 'monitor'
                    ? <HostMonitorPanel sessionId={sessionId} sshConnected={connected} />
                    : (
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
                    )}
              </div>
            </aside>
          )}
        </div>
        <footer className={css.statusBar} aria-label="会话状态">
          <button
            type="button"
            className={css.statusCwd}
            onClick={() =>{  if (sshCwd !== '') toggleSidePanel('sftp') }}
            title={sshCwd === '' ? '等待终端报告当前目录' : `在文件面板中打开 ${sshCwd}`}
          >
            <IconFolderOpenOutlineMedium size={12} />
            <span className={css.statusCwdText}>{sshCwd === '' ? '等待目录…' : sshCwd}</span>
          </button>
          <button
            type="button"
            className={css.statusSession}
            onClick={() => void navigator.clipboard.writeText(sessionId).then(
              () => { notify('已复制会话 id') },
              () => { notify('复制失败:浏览器拒绝了剪贴板访问', 'error') },
            )}
            title="复制会话 id(排障时贴给日志)"
          >
            <IconCopyOutlineMedium size={11} />
            <span className={css.statusSessionText}>{sessionId}</span>
          </button>
          <span className={css.statusSpacer} />
          <span className={css.statusItem} title="终端网格">{grid.cols > 0 ? `${grid.cols}×${grid.rows}` : '—'}</span>
          <span className={css.statusItem} title="PTY 解码编码">{terminalSettings.encoding}</span>
          <span className={css.statusItem} title="字号">{terminalSettings.fontSize}px</span>
          {transferTasks.activeCount > 0 && (
            <button type="button" className={css.statusTransfer} onClick={() =>{  setTransferDialogOpen(true) }} title="查看传输任务">
              传输 {transferTasks.activeCount}
            </button>
          )}
        </footer>
      </section>
      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() =>{  setPaletteOpen(false) }} />}
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
  const [filter, setFilter] = useState('')
  const update = (id: string, key: 'label' | 'cmd', value: string): void => {
    onChange(commands.map(command => command.id === id ? { ...command, [key]: value } : command))
  }
  const needle = filter.trim().toLowerCase()
  const visible = needle === ''
    ? commands
    : commands.filter(command => `${command.label} ${command.cmd}`.toLowerCase().includes(needle))
  return (
    <div
      className={css.quickEditorBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="管理快捷命令"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <section className={css.quickEditor} onClick={(event) => { event.stopPropagation() }}>
        <header className={css.quickEditorHeader}>
          <div><span className={css.quickEditorTitle}>快捷命令</span><span className={css.quickEditorHint}>点击命令将发送到当前 SSH 会话</span></div>
          <button type="button" className={css.iconButton} onClick={onClose} title="关闭" aria-label="关闭"><IconCloseOutlineMedium size={15} /></button>
        </header>
        <div className={css.quickEditorFilter}>
          <IconSearchOutlineMedium size={13} />
          <input
            className={css.quickEditorFilterInput}
            value={filter}
            placeholder="筛选命令(名称或内容)"
            aria-label="筛选快捷命令"
            onChange={(event) => { setFilter(event.target.value) }}
          />
          <span className={css.quickEditorCount}>{visible.length}/{commands.length}</span>
        </div>
        <div className={css.quickEditorList}>
          {visible.map(command => (
            <div className={css.quickEditorRow} key={command.id}>
              <input value={command.label} placeholder="名称" aria-label="快捷命令名称" onChange={(event) =>{  update(command.id, 'label', event.target.value) }} />
              <textarea value={command.cmd} placeholder="SSH 命令" aria-label="快捷命令内容" onChange={(event) =>{  update(command.id, 'cmd', event.target.value) }} />
              <button type="button" className={css.quickDelete} onClick={() =>{  onChange(commands.filter(item => item.id !== command.id)) }} title="删除快捷命令" aria-label={`删除 ${command.label || '快捷命令'}`}><IconCloseFillMedium size={12} /></button>
            </div>
          ))}
          {visible.length === 0 && <div className={css.quickEditorEmpty}>{commands.length === 0 ? '暂无快捷命令。可新增一条，或从 Xshell 导入 `.qbl` / `.qblx`。' : '没有匹配的快捷命令。'}</div>}
        </div>
        <footer className={css.quickEditorFooter}>
          <button type="button" className={css.quickAdd} onClick={() =>{  onChange([...commands, createQuickCommand()]) }}><IconPlusOutlineMedium size={14} /> 添加命令</button>
          <span className={css.spacer} />
          <button type="button" className={css.quickDone} onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  )
}
