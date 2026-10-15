/**
 * SSH 终端「最近命令」与输入行还原。
 *
 * 远端 shell 自己维护历史文件,但 StarHub 的终端是「裸 PTY + 前端渲染」,
 * 拿不到 shell 的 history 列表。这里在前端按「用户实际提交的行」记一份
 * (onData 累加字符、回车时提交),供命令面板的「最近命令」分组复用——
 * 不落盘任何敏感信息之外的内容,只存命令文本本身,上限 60 条,连续重复
 * 只留一条。
 *
 * @module StarHub SSH terminal command history (client)
 */

/** localStorage key。 */
const STORAGE_KEY = 'starhub:ssh:command-history'

/** 保留的最近命令条数上限。 */
export const COMMAND_HISTORY_LIMIT = 60

/** 一条最近命令。 */
export interface CommandHistoryEntry {
  /** 提交的完整命令行(已去首尾空白)。 */
  cmd: string
  /** 提交时间戳(ms)。 */
  at: number
}

/**
 * 读取最近命令(localStorage 不可用或内容损坏时返回空数组)。
 * @returns 最新在前的命令列表。
 */
export function loadCommandHistory(): CommandHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is CommandHistoryEntry => (
      typeof entry === 'object' && entry !== null
      && typeof (entry as CommandHistoryEntry).cmd === 'string'
      && (entry as CommandHistoryEntry).cmd !== ''
      && typeof (entry as CommandHistoryEntry).at === 'number'
    ))
  } catch {
    return []
  }
}

/**
 * 写回最近命令(整表覆盖,最新在前,超上限截断)。
 * @param entries - 要保存的列表。
 */
export function saveCommandHistory(entries: readonly CommandHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, COMMAND_HISTORY_LIMIT)))
  } catch {
    // localStorage 不可用(隐私模式等):静默降级,历史仅存在内存里
  }
}

/**
 * 追加一条最近命令:连续重复只留最新一条,置顶,超上限截断。
 * @param current - 现有列表(最新在前)。
 * @param cmd - 新提交的命令(空串忽略)。
 * @returns 新列表(引用不变时原样返回,避免无意义重渲)。
 */
export function pushCommandHistory(current: readonly CommandHistoryEntry[], cmd: string): CommandHistoryEntry[] {
  const trimmed = cmd.trim()
  if (trimmed === '') return [...current]
  const next: CommandHistoryEntry[] = [{ cmd: trimmed, at: Date.now() }]
  for (const entry of current) {
    if (entry.cmd === trimmed) continue
    next.push(entry)
    if (next.length >= COMMAND_HISTORY_LIMIT) break
  }
  saveCommandHistory(next)
  return next
}

/** 清空最近命令。 */
export function clearCommandHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // localStorage 不可用:无需处理
  }
}

/**
 * 还原「当前正在输入的行」:终端的 onData 是字符流,前端据此拼出用户敲的
 * 命令行,回车时作为一条最近命令提交。
 *
 * 按字符推进,因此单字符输入与整段批量输入(粘贴、快速连打)走同一条路径;
 * 转义序列(方向键 / 功能键)吃到字母终止符为止,不当成输入字符。
 * @param current - 当前行缓冲。
 * @param data - 一段 onData 数据。
 * @returns 新的行缓冲,以及本段是否提交了一条命令(提交后缓冲清空)。
 */
export function reduceInputLine(current: string, data: string): { line: string; submitted: string | null } {
  let line = current
  let submitted: string | null = null
  let escape = false
  for (const char of data) {
    if (escape) {
      // 转义序列未完:吃到字母 / ~ 终止符为止
      if (/[A-Za-z~]/.test(char)) escape = false
      continue
    }
    if (char === '\x1b') {
      // 方向键等:shell 自己接管历史,前端丢掉行缓冲
      escape = true
      line = ''
      continue
    }
    if (char === '\r' || char === '\n') {
      const trimmed = line.trim()
      if (trimmed !== '') submitted = trimmed
      line = ''
      continue
    }
    if (char === '\x7f') {
      line = line.slice(0, -1)
      continue
    }
    // 其余控制字符(Ctrl+C / Ctrl+U …):放弃当前行
    if (char.charCodeAt(0) < 32) {
      line = ''
      continue
    }
    line += char
  }
  return { line, submitted }
}
