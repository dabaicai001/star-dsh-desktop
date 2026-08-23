/**
 * StarHub memory sink (2026-08-22, v0.92.0):turn-stopping 钩子的纯判定函数。
 *
 * 单文件零依赖,便于 vitest 直接覆盖;运行时由 memory-sink 的 apply() import。
 * 门禁来自旧 Vue `legacy-core/services/aiMemoryReviewGates.ts`,这里改造成
 * 适配 dsh 的两个判定:
 *  - `shouldReview(messageCounts)`:agent turn-stopping 时,会话里 user+assistant
 *    消息总数是否达到阈值(过短没值得沉淀的内容)。
 *  - `pickTargetScope({ cwd })`:本轮持久事实落到哪个 scope;有 cwd → folder:<cwd>,
 *    否则 → global(不写 user 偏好,留给模型显式调 memory 工具)。
 *
 * @module @deepseek-ai/dsh-starhub-memory-sink/gates
 */

/** 触发沉淀所需的最少消息数(user + assistant 之和,继承自旧 gates.REVIEW_MIN_MESSAGES)。 */
export const REVIEW_MIN_MESSAGES = 4

/** scope 常量(与 Rust 端 add_memory 校验一致)。 */
export const SCOPE_GLOBAL = 'global' as const
const FOLDER_PREFIX = 'folder:'

/**
 * 判定本轮是否值得触发沉淀:user+assistant 消息总数是否达到阈值。
 * @param messageCounts - 会话内 user 与 assistant 消息计数。
 * @returns 总数 ≥ {@link REVIEW_MIN_MESSAGES} 时 true。
 */
export function shouldReview(messageCounts: { user: number; assistant: number }): boolean {
  const total = (messageCounts.user || 0) + (messageCounts.assistant || 0)
  return total >= REVIEW_MIN_MESSAGES
}

/**
 * 根据会话 cwd 决定本轮事实的默认 scope。
 * cwd 缺省(blank session)回退 global;否则落到工作区文件夹卡。
 * @param cwd - 会话工作区绝对路径,undefined 表示无工作区。
 * @returns scope 字符串,调用方负责套 FOLDER_PREFIX。
 */
export function pickTargetScope(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') return SCOPE_GLOBAL
  return `${FOLDER_PREFIX}${cwd}`
}

/**
 * 规范化 LLM 返回的候选事实条目:trim + 去空 + 限长(单条 ≤ 280 字符,
 * 整批 ≤ 8 条;超过部分截断,保留最高密度)。这是 trust boundary,所有
 * 外部(LLM 输出)入参在此收敛。
 * @param raw - LLM 输出的 JSON 字符串或已解析对象。
 * @returns 净化后的条目数组。
 */
export interface DistilledFact {
  readonly scope: string
  readonly content: string
}

/** 规范化入参的可选上限。 */
export interface NormalizeOptions {
  /** 会话工作区绝对路径,用于派生目标 scope;undefined 回退 global。 */
  readonly cwd: string | undefined
  /** 整批条数上限;缺省 {@link DEFAULT_MAX_ENTRIES}。 */
  readonly maxEntries?: number
  /** 单条内容字符上限;缺省 {@link DEFAULT_MAX_CHARS}。 */
  readonly maxCharsPerEntry?: number
}

const DEFAULT_MAX_ENTRIES = 8
const DEFAULT_MAX_CHARS = 280

/**
 * 规范化 LLM 返回的候选事实条目(trust boundary):所有外部入参在此收敛。
 * @param raw - LLM 输出的 JSON 字符串或已解析对象。
 * @param options - scope 派生与条数/长度上限。
 * @returns 净化后的条目数组(去空、去超长;scope 一律由 pickTargetScope 决定)。
 */
export function normalizeFacts(
  raw: unknown,
  options: NormalizeOptions,
): DistilledFact[] {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxChars = options.maxCharsPerEntry ?? DEFAULT_MAX_CHARS
  const allowedScope = pickTargetScope(options.cwd)
  const list = extractList(raw)
  const out: DistilledFact[] = []
  for (const item of list) {
    if (out.length >= maxEntries) break
    if (typeof item !== 'object' || item === null) continue
    const content = typeof (item as { content?: unknown }).content === 'string'
      ? ((item as { content: string }).content).trim()
      : ''
    if (content === '' || content.length > maxChars) continue
    // LLM 标注的 scope 仅作为提示;落地统一用 pickTargetScope 决定的 scope,
    // 避免 LLM 误标 user/asset 绕过路径约束。
    out.push({ scope: allowedScope, content: content.slice(0, maxChars) })
  }
  return out
}

function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        return extractList(parsed)
      } catch {
        // fall through to plain-text handling
      }
    }
    // 兼容纯文本返回:把整段当一条 fact 候选。
    return trimmed === '' ? [] : [{ content: trimmed }]
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as { facts?: unknown; items?: unknown }
    if (Array.isArray(obj.facts)) return obj.facts
    if (Array.isArray(obj.items)) return obj.items
  }
  return []
}
