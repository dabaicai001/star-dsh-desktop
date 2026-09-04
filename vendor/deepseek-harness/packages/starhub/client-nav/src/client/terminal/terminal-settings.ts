/**
 * SSH 终端显示设置(设置 → SSH):字体、字号、编码、光标闪烁。
 *
 * 持久化到 localStorage(key `starhub.terminal.settings`),不依赖 Tauri IPC,
 * 因此在浏览器预览里也能读写。SSH 终端(SshTerminalOverlay)与 Docker exec
 * 终端(DockerExecTerminal)都消费这些值;字体/字号/光标在创建 xterm 时传入,
 * 编码经 TextDecoder(label)解码 PTY octets。
 *
 * @module SSH terminal settings (client)
 */
import { useSyncExternalStore } from 'react'

/** localStorage key。 */
export const TERMINAL_SETTINGS_KEY = 'starhub.terminal.settings'

/** 默认字体栈(与旧硬编码一致,保证升级后行为不变)。 */
export const DEFAULT_TERMINAL_FONT = 'SF Mono, JetBrains Mono, Fira Code, Consolas, Courier, PingFang SC, Microsoft YaHei'

/**
 * 可选字体预设(下拉框):展示名 → 字体栈字符串(即持久化的 fontFamily 值)。
 * 每个栈都以等宽/老牌等宽收尾,保证缺字体时仍可读;Windows/macOS/Linux 都覆盖。
 */
export const TERMINAL_FONTS: ReadonlyArray<{ label: string; value: string }> = [
  {
    label: '系统默认(SF Mono / JetBrains Mono / Fira Code / Consolas)',
    value: DEFAULT_TERMINAL_FONT,
  },
  { label: 'JetBrains Mono', value: 'JetBrains Mono, SF Mono, Consolas, Menlo, monospace' },
  { label: 'Fira Code', value: 'Fira Code, SF Mono, Consolas, Menlo, monospace' },
  { label: 'Consolas', value: 'Consolas, SF Mono, Menlo, monospace' },
  { label: 'Menlo', value: 'Menlo, Consolas, monospace' },
  { label: 'Cascadia Code', value: 'Cascadia Code, Consolas, monospace' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'PingFang SC(苹方,需中英文混排)', value: 'PingFang SC, Microsoft YaHei, Consolas, monospace' },
]

/** 判断某个字体栈是否为预设之一(用于下拉框回显;自定义值时补一个当前项)。 */
export function isTerminalFontPreset(fontFamily: string): boolean {
  return TERMINAL_FONTS.some(option => option.value === fontFamily)
}

/** 支持的 PTY 解码编码(TextDecoder 的 label 参数)。 */
export const TERMINAL_ENCODINGS = ['utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr'] as const

export type TerminalEncoding = (typeof TERMINAL_ENCODINGS)[number]

/** SSH 终端显示设置。 */
export interface TerminalSettings {
  /** 字体栈(逗号分隔,含 fallback)。 */
  fontFamily: string
  /** 字号(px),xterm ITerminalOptions.fontSize。 */
  fontSize: number
  /** PTY octets 解码编码(TextDecoder label)。 */
  encoding: TerminalEncoding
  /** 光标闪烁。 */
  cursorBlink: boolean
}

function defaults(): TerminalSettings {
  return {
    fontFamily: DEFAULT_TERMINAL_FONT,
    fontSize: 13,
    encoding: 'utf-8',
    cursorBlink: true,
  }
}

/** 归一化一次持久化设置(缺字段回退默认,非法值修正)。 */
export function normalizeTerminalSettings(raw: Partial<TerminalSettings> | null | undefined): TerminalSettings {
  const base = defaults()
  const next: TerminalSettings = { ...base, ...(raw ?? {}) }
  if (typeof next.fontFamily !== 'string' || next.fontFamily.trim() === '') next.fontFamily = base.fontFamily
  if (typeof next.fontSize !== 'number' || !Number.isFinite(next.fontSize)) next.fontSize = base.fontSize
  // 夹在合法 xterm 字号区间(6..64)。
  next.fontSize = Math.max(6, Math.min(64, Math.round(next.fontSize)))
  if (!(TERMINAL_ENCODINGS as readonly string[]).includes(next.encoding)) next.encoding = base.encoding
  if (typeof next.cursorBlink !== 'boolean') next.cursorBlink = base.cursorBlink
  return next
}

/** 读取 SSH 终端设置(localStorage 不可用时返回默认)。 */
export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(TERMINAL_SETTINGS_KEY) ?? 'null') as Partial<TerminalSettings> | null
    return normalizeTerminalSettings(raw)
  } catch {
    return defaults()
  }
}

/** 写回 SSH 终端设置(整对象覆盖)。localStorage 不可用时静默降级。 */
export function saveTerminalSettings(settings: TerminalSettings): void {
  try {
    localStorage.setItem(TERMINAL_SETTINGS_KEY, JSON.stringify(normalizeTerminalSettings(settings)))
  } catch {
    // localStorage 不可用(隐私模式等):静默降级,与 aiSettings 持久化语义一致
  }
  refresh()
}

// 订阅通知:跨组件(设置 tab ↔ 终端)用同一事件同步刷新。
// useSyncExternalStore 要求 snapshot 引用稳定(否则每次 render 都判为变化、
// 无限重渲),所以缓存最近一次读取值,仅在值真正变化时换新引用。
const listeners = new Set<() => void>()
let cached: TerminalSettings = loadTerminalSettings()

function refresh(): void {
  const next = loadTerminalSettings()
  if (JSON.stringify(next) === JSON.stringify(cached)) return
  cached = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): TerminalSettings {
  // 每次快照重读 localStorage:外部直接 `saveTerminalSettings` / 另一 tab
  // 写入都会反映出来;仅当值真正变化时换成新引用(useSyncExternalStore
  // 以 Object.is 判等,不变则复用旧引用,不重渲)。
  const next = loadTerminalSettings()
  if (JSON.stringify(next) !== JSON.stringify(cached)) cached = next
  return cached
}

/**
 * 反应式读取 SSH 终端设置:任何组件保存后,其它已挂载的终端立即用新值。
 * @returns 归一化后的设置。
 */
export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 更新 SSH 终端设置;写回 localStorage 并通知订阅者。
 * @param patch - 要合并的字段。
 */
export function updateTerminalSettings(patch: Partial<TerminalSettings>): void {
  saveTerminalSettings(normalizeTerminalSettings({ ...loadTerminalSettings(), ...patch }))
}

/** 构造 xterm 的 ITerminalOptions 公共面(SSH 与 Docker 终端共用)。 */
export function terminalOptions(settings: TerminalSettings): {
  fontFamily: string
  fontSize: number
  cursorBlink: boolean
} {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: settings.cursorBlink,
  }
}
