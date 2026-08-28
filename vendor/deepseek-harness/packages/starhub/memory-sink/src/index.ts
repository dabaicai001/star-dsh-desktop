/**
 * StarHub memory sink (2026-08-22, v0.92.0): agent/turn-stopping 钩子自动把
 * 当轮持久事实落入 ai_memories,补上「memory 工具写了从不自动沉淀」的缺口。
 *
 * 数据流:
 * 1. agent 回合结束 → dsh 发出 `agent/turn-stopping`(`{ agent, turn, signal }`)。
 * 2. 本插件读取 settings namespace `starhub-memory-context.autoReview`;关闭或
 *    namespace 未写过(v0.92.0 起默认关)则整段跳过。
 * 3. **记忆模型硬前置(v0.94.0)**:namespace 的 `memoryProvider` + `memoryModel`
 *    未成对配置时整段跳过(开关打开也没用,与设置「只有配置了才能勾选」对齐)。
 * 4. 通过门禁 `shouldReview({user, assistant})` 决定要不要调用 LLM 抽取;
 *    太短的会话不调用(零成本)。
 * 5. **v0.102.0 转录感知抽取**:`buildExtractPrompt` 现在附带真实转录
 *    (`extractTurnTranscript` 从 `agent.session.events` 尾部收集
 *    `user/message` + `assistant/message` 事件,排除 memory-context 注入的
 *    plugin 来源 user 消息,避免「记忆复读回音」);空转录返回 null,
 *    `runTurnReview` 直接跳过 LLM 调用,根除「无米下锅凭空编造」。
 * 6. 调用 `extractFacts(agent, signal, route)` 用**专属记忆模型**做一次独立
 *    LLM chat completion(`ctx.llm.stream`,provider/model 取自 namespace 路由),
 *    返回 JSON 数组;`normalizeFacts` 收敛 scope + 去空 + 限长 + 限条数。
 * 7. `pickTargetScope(cwd)` 决定 folder/global;逐条经 sdk-transport 反向
 *    RPC `starhub/memory.write` 调 Rust `ai_memory_add`。
 *
 * 失败/超时均吞掉(不污染主 agent turn 的 dispose 链),日志走 console.warn。
 * Rust 侧 `ai_memory_add` 返回的 [FULL] / [DUPLICATE] 错误同样吞掉(沉淀阶段
 * 不强求成功,后续 turn 仍可重试;事实质量差时 LLM 摘要本身就该收敛)。
 *
 * @module @deepseek-ai/dsh-starhub-memory-sink
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BlockAssembler,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  MEMORY_CONTEXT_NAMESPACE,
  isAutoReviewEnabled,
  memoryRouteOf,
  type MemoryContextValue,
  type MemoryRoute,
} from '@deepseek-ai/dsh-starhub-memory-context'
import {
  normalizeFacts,
  shouldReview,
  type DistilledFact,
} from './gates.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-memory-sink'

/** The agent registry, settings service, and SDK transport. */
export const inject = ['agents', 'settings']

/** Reverse-RPC method registered by the Rust host; payload `{ scope, content }`. */
export const MEMORY_WRITE_METHOD = 'starhub/memory.write'

/** 一次 LLM 抽取调用最多等待 6 秒;超时降级为不写入。 */
const EXTRACT_TIMEOUT_MS = 6_000

/** 一次 RPC 写入最多等待 2 秒;超时降级为不写入。 */
const WRITE_TIMEOUT_MS = 2_000

/** `extractTurnTranscript` 默认最多收集的转录消息条数。 */
const TRANSCRIPT_DEFAULT_MAX_MESSAGES = 8

/** `extractTurnTranscript` 默认总字符上限。 */
const TRANSCRIPT_DEFAULT_MAX_CHARS = 3_000

/** `extractTurnTranscript` 单条消息字符上限(超出尾部加 `…`)。 */
const TRANSCRIPT_PER_MESSAGE_MAX_CHARS = 800

/** 抽取 LLM 调用的系统提示(模型侧契约;改动请同步 README)。
 * v0.102.0 起增补:只能从给定 transcript 提炼事实,禁止编造 transcript 之外的
 * 内容;无持久价值事实必须返回 `{"facts": []}`,避免空转录时编造记忆。 */
const EXTRACT_SYSTEM_PROMPT = [
  'You are a long-term memory distiller for a StarHub AI coding assistant.',
  'Review the just-completed conversation turn and decide whether it contains',
  'durable facts worth persisting into long-term memory (preferences, project',
  'conventions, completed work, environment topology, corrections).',
  'Only distill facts that are stated in the transcript provided; do not invent',
  'or infer facts that go beyond what the transcript actually contains.',
  'If the transcript is empty or carries nothing durable, return {"facts": []}.',
  'Otherwise return JSON {"facts": [{"content": "<concise fact, ≤280 chars>"}]}.',
  'Reject ephemeral debugging, raw logs, secrets, or anything queryable from',
  'source code. Each fact must be information-dense (one line).',
  'Facts that apply only to a named project must carry that project name inside',
  'the content (e.g. "[starhub] production DB is 10.0.0.5"); facts common to all',
  'projects may stay unlabeled.',
].join(' ')

/** Schemastery shape returned by the extraction LLM call. */
export const ExtractedFactsSchema: z<{ facts: Array<{ content: string }> }> = z.object({
  facts: z.array(z.object({ content: z.string().default('') })).default([]),
})

/**
 * 会话事件流元素的窄化形状,用于抽取转录。DSH 真实事件形状:
 * - `user/message` ⇒ `data.content` 是 message content block 数组
 * - `assistant/message` ⇒ `data.message.content` 是 message content block 数组
 *
 * `extractTurnTranscript` 在两种形态间通用地走「找 `content` 数组 → 找
 * `text` 块」路径。plugin 来源(`source.kind === 'plugin'`)的 user 消息视为
 * 「上下文注入」,不进入转录。
 *
 * `data` 用 `unknown` 是因为 DSH 严格联合里 `user/message` 的 data 是
 * `UserMessage` 接口(无索引签名)、`assistant/message` 的 data 是另一形态;
 * 入口一律用 `unknown`,内部按 Record 形态安全探测。
 */
export interface MemorySinkEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * Type for the dsh Agent surface used by the turn-stopping hook.
 * Kept narrow to avoid pulling in the full agent type and to keep the
 * dependency surface minimal for tests.
 *
 * `events` 的形状在 v0.102.0 起放宽为 `{ type; data? }[]`(只读),由
 * `extractTurnTranscript` 负责按 type / source.kind 收敛真实可读文本。
 */
export interface MemorySinkAgent {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    readonly events?: ReadonlyArray<MemorySinkEvent>
  }
}

/**
 * Type for the optional LLM call capability injected by the host. The call is
 * routed to the dedicated memory model (`route.provider`/`route.model`); the
 * real surface lives behind `ctx.llm.stream` (dsh-llm), tests stub this shape.
 */
export type LlmExtractor = (params: {
  route: MemoryRoute
  system: string
  prompt: string
  signal: AbortSignal
}) => Promise<unknown>

/**
 * Persist a single distilled fact through the host SDK transport.
 * Errors are swallowed (best-effort write; the durable path stays usable).
 * @param transport - sdk-transport peer;missing ⇒ no-op.
 * @param fact - distilled fact produced by normalizeFacts.
 */
export async function writeFact(
  transport: JsonRpcTransportPeer | undefined,
  fact: DistilledFact,
): Promise<void> {
  if (transport === undefined) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new Error('starhub/memory.write timed out')) }, WRITE_TIMEOUT_MS)
    })
    await Promise.race([
      transport.request(MEMORY_WRITE_METHOD, { scope: fact.scope, content: fact.content }),
      timeoutPromise,
    ])
  } catch {
    // Persistence is best-effort: a transient transport drop or a [FULL]/[DUPLICATE]
    // rejection from Rust is not worth blocking the turn. The next review pass may
    // re-emit the fact in a more compact form.
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Count user/assistant messages in the agent session for the gate check.
 * Reads `agent.session.events` if present;returns zeros on malformed input.
 * @param agent - the stopping agent whose session events are counted.
 * @returns user/assistant message counts;zeros when events are absent or malformed.
 */
export function countMessages(agent: MemorySinkAgent): { user: number; assistant: number } {
  const raw: unknown = agent.session.events
  if (!Array.isArray(raw)) return { user: 0, assistant: 0 }
  const events: ReadonlyArray<unknown> = raw
  let user = 0
  let assistant = 0
  for (const event of events) {
    const { type } = event as { readonly type: string }
    // dsh 会话事件词表是 `user/message` / `assistant/message`(core/session
    // SessionEventMap),不是旧的 `message/user` / `message/assistant`;旧名会把
    // 计数恒为 0,导致 shouldReview 永远 false、自动沉淀从不触发(v0.96.4 修复)。
    if (type === 'user/message') user += 1
    else if (type === 'assistant/message') assistant += 1
  }
  return { user, assistant }
}

/**
 * 把单条事件的内容数组拼成纯文本。只取 `type === 'text'` 且 `text` 是
 * 字符串的块;空内容、非数组、缺 text 的块都安全跳过(不抛错)。
 * @param blocks - message content 数组(可能为 undefined 或非数组)。
 * @returns 拼接好的纯文本;无内容返回空串。
 */
function extractTextFromContent(
  blocks: ReadonlyArray<{ readonly type?: string; readonly text?: string }> | undefined,
): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block === undefined || block === null) continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 从事件 `data` 信封里取出 message content 数组。DSH 会话日志里两种
 * 形态都会出现:
 * - `user/message` 直接挂 `data.content`(UserMessage 顶层就是 content)。
 * - `assistant/message` 把 AssistantMessage 嵌套在 `data.message.content`
 *   里(外层 data 还包了 turn/step/usage 等元数据)。
 * memory-context 注入的 plugin 消息采用 user/message 形态。
 * 防御性读:中间任何一层不是对象都视为无可用内容。
 * @param data - 事件 data 信封;可能为 undefined。
 * @returns content 数组;无可用内容返回 undefined。
 */
function readMessageContent(
  data: MemorySinkEvent['data'],
): ReadonlyArray<{ readonly type?: string; readonly text?: string }> | undefined {
  if (data === undefined || data === null) return undefined
  if (typeof data !== 'object') return undefined
  const record = data as Readonly<Record<string, unknown>>
  const top = record['content']
  if (Array.isArray(top)) return top as ReadonlyArray<{ readonly type?: string; readonly text?: string }>
  const nested = record['message']
  if (nested !== undefined && nested !== null && typeof nested === 'object') {
    const inner = (nested as Readonly<Record<string, unknown>>)['content']
    if (Array.isArray(inner)) {
      return inner as ReadonlyArray<{ readonly type?: string; readonly text?: string }>
    }
  }
  return undefined
}

/**
 * 截断单条消息到 `maxChars` 字符(超出部分尾部追加 `…`),便于控制转录总
 * 体长度。
 * @param text - 原始文本。
 * @param maxChars - 截断阈值;<= 0 时不截断。
 * @returns 截断后的文本;未截断时原样返回。
 */
function truncateMessage(text: string, maxChars: number): string {
  if (maxChars <= 0) return text
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * `extractTurnTranscript` 的可选参数:限制消息条数 / 总字符数。
 */
export interface ExtractTurnTranscriptOptions {
  /** 最多收集的消息数(用户 + 助手合计);缺省 {@link TRANSCRIPT_DEFAULT_MAX_MESSAGES}。 */
  readonly maxMessages?: number
  /** 总字符上限;超过即停止追加消息。缺省 {@link TRANSCRIPT_DEFAULT_MAX_CHARS}。 */
  readonly maxChars?: number
  /** 单条消息字符上限;超出尾部加 `…`。缺省 {@link TRANSCRIPT_PER_MESSAGE_MAX_CHARS}。 */
  readonly maxCharsPerMessage?: number
}

/**
 * 从 `agent.session.events` 尾部向前抽取本轮 user / assistant 转录文本。
 * - 只接受 `type === 'user/message'` 或 `type === 'assistant/message'` 的事件;
 * - `user/message` 必须 `data.source.kind === 'user'`(默认记忆上下文注入是
 *   plugin 源,本插件过滤掉,避免「记忆复读回音」);
 * - 按 events 顺序保留时间正序(user/assistant 交替);
 * - 单条消息按 `maxCharsPerMessage` 截断(尾部 `…`),总条数按 `maxMessages`,
 *   总字符按 `maxChars` 双重截断;
 * - 防御性读 events:非数组 / 元素缺 data / content 非数组 / 块缺 text 全
 *   安全跳过,不抛错。
 * @param agent - the stopping agent;its session.events is the transcript source.
 * @param opts - 截断阈值;缺省按模块常量。
 * @returns `user: ...\nassistant: ...` 形式的转录;无可用内容返回空串。
 */
export function extractTurnTranscript(
  agent: MemorySinkAgent,
  opts?: ExtractTurnTranscriptOptions,
): string {
  const events = agent.session.events
  if (!Array.isArray(events) || events.length === 0) return ''
  const maxMessages = opts?.maxMessages ?? TRANSCRIPT_DEFAULT_MAX_MESSAGES
  const maxChars = opts?.maxChars ?? TRANSCRIPT_DEFAULT_MAX_CHARS
  const maxPerMessage = opts?.maxCharsPerMessage ?? TRANSCRIPT_PER_MESSAGE_MAX_CHARS
  if (maxMessages <= 0) return ''

  // 从尾部向前收集,保证拿到「最近 maxMessages 条」;再按原序翻回来。
  const collected: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (let i = events.length - 1; i >= 0 && collected.length < maxMessages; i -= 1) {
    const event = events[i]
    if (event === undefined || event === null) continue
    const role = classifyEventRole(event)
    if (role === null) continue
    const text = truncateMessage(
      extractTextFromContent(readMessageContent(event.data)),
      maxPerMessage,
    )
    if (text === '') continue
    collected.push({ role, text })
  }
  collected.reverse()

  // 按总字符上限再截一次;超长就按时间顺序丢尾。
  const lines: string[] = []
  let used = 0
  for (const { role, text } of collected) {
    const label = `${role}: `
    const cost = label.length + text.length + 1 // +1 for newline
    if (used + cost > maxChars && lines.length > 0) break
    lines.push(`${label}${text}`)
    used += cost
  }
  return lines.join('\n')
}

/**
 * 判定会话事件是 user 还是 assistant 角色;不符合条件的返回 null。
 * `user/message` 必须 `data.source.kind === 'user'`(排除 plugin 注入);
 * `assistant/message` 无 source 限制(DSH 默认产生的就是 assistant 角色)。
 */
function classifyEventRole(event: MemorySinkEvent): 'user' | 'assistant' | null {
  if (event.type === 'user/message') {
    const data = event.data
    if (data === undefined || data === null || typeof data !== 'object') return null
    const source = (data as Readonly<Record<string, unknown>>)['source']
    if (source === undefined || source === null || typeof source !== 'object') return null
    const kind = (source as Readonly<Record<string, unknown>>)['kind']
    return kind === 'user' ? 'user' : null
  }
  if (event.type === 'assistant/message') return 'assistant'
  return null
}

/**
 * Build the user-prompt payload handed to the LLM extractor.
 * v0.102.0 起:`extractTurnTranscript` 从 `agent.session.events` 取真实转录,
 * 转录为空时返回 null,`runTurnReview` 会直接跳过 LLM 调用(避免空转录编造)。
 * 转录非空时把 workspace / project 行 + 转录一起交给模型。
 * @param agent - the stopping agent;its session cwd shapes the prompt and
 *   `events` provides the just-completed turn transcript.
 * @returns the extractor user-prompt text;null when no usable transcript exists.
 */
export function buildExtractPrompt(agent: MemorySinkAgent): string | null {
  const cwd = agent.session.header.cwd
  const cwdLine = cwd === undefined || cwd.trim() === ''
    ? 'workspace: <none>'
    : `workspace: ${cwd}`
  const projectLine = cwd === undefined || cwd.trim() === ''
    ? 'project: <none>'
    : `project: ${projectNameOf(cwd)}`
  const transcript = extractTurnTranscript(agent)
  if (transcript === '') return null
  return [
    'Distill durable facts from the conversation transcript below into long-term memory.',
    cwdLine,
    projectLine,
    '<transcript>',
    transcript,
    '</transcript>',
    'Return JSON only, no prose.',
  ].join('\n')
}

/**
 * 从工作区绝对路径取项目名(末段目录名,去尾部斜杠)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 项目名(目录末段);空路径返回空串。
 */
export function projectNameOf(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')
}

/**
 * Normalize the LLM output, decide the target scope, and persist each fact.
 * Pure orchestration helper;kept separate from apply() so tests can drive
 * it without booting a Cordis context.
 * @param transport - sdk-transport peer used for the reverse RPC;undefined skips writes.
 * @param agent - the stopping agent;its session cwd derives the target scope.
 * @param llmOutput - the extractor's raw JSON output (string or parsed object).
 * @returns the normalized facts that were persisted.
 */
export async function persistExtractedFacts(
  transport: JsonRpcTransportPeer | undefined,
  agent: MemorySinkAgent,
  llmOutput: unknown,
): Promise<DistilledFact[]> {
  const cwd = agent.session.header.cwd
  const facts = normalizeFacts(llmOutput, { cwd })
  for (const fact of facts) {
    await writeFact(transport, fact)
  }
  return facts
}

/**
 * The full turn-stopping pipeline: gate → extract → persist.
 * Errors at any step are swallowed and logged at warn level.
 *
 * v0.102.0 起:`buildExtractPrompt` 返回 null(无可用转录)时直接跳过 LLM
 * 调用,根除「无米下锅凭空编造」;其余门禁(autoReview、route、signal、
 * shouldReview)顺序不变。
 * @param params - gate inputs, the abort signal, and the optional extractor.
 * @returns after the best-effort pipeline settles (never rejects).
 */
export async function runTurnReview(params: {
  agent: MemorySinkAgent
  signal: AbortSignal
  transport: JsonRpcTransportPeer | undefined
  llm: LlmExtractor | undefined
  autoReviewEnabled: boolean
  route: MemoryRoute | undefined
}): Promise<void> {
  if (!params.autoReviewEnabled) return
  // 记忆模型硬前置:未配置路由不沉淀(开关打开了也没用,与设置 UI 一致)。
  if (params.route === undefined) return
  if (params.signal.aborted) return
  // 消息数门槛:仅当 `agent.session.events` 能提供计数时才用 `shouldReview` 拦截。
  // DSH web 会话(DSH GUI 内核)的消息事件并不总是进入 `session.events`(实证
  // `session.jsonl.zstd` 只有 session 头、无 user/assistant 事件),此时计数恒为 0,
  // 若强依赖计数会让自动沉淀永远不触发。已触发 `agent/turn-stopping` 本身就代表
  // 本轮回合确有对话,因此计数缺失(0/0)时不再拦截,交由专属记忆模型的 LLM 抽取
  // 自行判断是否有值得沉淀的持久事实(空轮次返回 {"facts":[]} 不落库,零写入成本)。
  const counts = countMessages(params.agent)
  if (counts.user > 0 || counts.assistant > 0) {
    if (!shouldReview(counts)) return
  }
  if (params.llm === undefined) return
  // v0.102.0:转录为空时跳过 LLM 调用,杜绝「无对话可抽却让 LLM 编造」——
  // 调用方本来就会过滤返回的 facts,但与其消耗一次 LLM 调用,不如直接拒跑。
  const prompt = buildExtractPrompt(params.agent)
  if (prompt === null) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new Error('extract timed out')) }, EXTRACT_TIMEOUT_MS)
    })
    const result = await Promise.race([
      params.llm({
        route: params.route,
        system: EXTRACT_SYSTEM_PROMPT,
        prompt,
        signal: params.signal,
      }),
      timeoutPromise,
    ])
    await persistExtractedFacts(params.transport, params.agent, result)
  } catch (error) {
    // Best-effort: a failed review must not surface to the turn-stopping chain.
    console.warn('[starhub-memory-sink] turn review failed:', error instanceof Error ? error.message : error)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Register the turn-stopping listener.
 * @param ctx - Cordis plugin context.
 */
export function apply(ctx: Context): void {
  const ns: SettingsNamespace = settingsNamespace(MEMORY_CONTEXT_NAMESPACE)
  ctx.effect(() => {
    const transport = ctx.get('sdk-transport') as JsonRpcTransportPeer | undefined
    return ctx.on('agent/turn-stopping', async ({ agent, signal }): Promise<void> => {
      // namespace 由 dsh-starhub-memory-context 注册,本插件只读 autoReview +
      // 记忆模型路由;重复 register 会触发 settings duplicate-registration
      // 硬失败(v0.92.2 事故)。
      const value = ctx.settings.get(ns) as MemoryContextValue | undefined
      const route = memoryRouteOf(value)
      await runTurnReview({
        agent,
        signal,
        transport,
        // LLM extractor: dsh-llm exposes `ctx.llm.stream` in production;
        // we treat it as optional and skip when absent. The host wires it via a
        // property proxy; using ctx.get keeps the dep optional.
        llm: route === undefined ? undefined : wireLlmExtractor(ctx),
        autoReviewEnabled: isAutoReviewEnabled(value),
        route,
      })
    })
  }, 'starhub-memory-sink: turn-stopping auto-distill')
}

/**
 * Build an LLM extractor closure from the dsh `llm` service if available.
 * The closure streams one completion through the dedicated memory route
 * (`route.provider` / `route.model`), collects text blocks via BlockAssembler
 * and returns the assembled text (normalizeFacts accepts JSON or plain text).
 * Honours the turn signal (abort races the pending stream) and the caller's
 * timeout budget (handled by runTurnReview's race).
 * Returns undefined when the service is not registered (e.g. in unit tests
 * or in hosts that don't expose a streaming surface).
 * @param ctx - Cordis plugin context; only the `llm` service is read.
 * @returns The extractor closure, or undefined when no usable `llm.stream` exists.
 */
export function wireLlmExtractor(ctx: Context): LlmExtractor | undefined {
  const candidate = ctx.get('llm') as unknown
  if (candidate === undefined || candidate === null) return undefined
  if (typeof candidate !== 'object') return undefined
  const stream = (candidate as { stream?: unknown }).stream
  if (typeof stream !== 'function') return undefined
  return async ({ route, system, prompt, signal }): Promise<unknown> => {
    // Check before calling stream: inside a Promise.race the aborted
    // promise's reaction is queued after an instantly-resolved stream's,
    // so a pre-aborted signal would lose the race and still resolve.
    if (signal.aborted) return Promise.reject(new Error('aborted'))
    const abortPromise = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    const consume = (async (): Promise<unknown> => {
      const assembler = new BlockAssembler()
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-starhub-memory-sink' },
        })],
        system,
        signal,
      }
      const chunks = (stream as (input: GenerateOptions) => AsyncIterable<StreamChunk>)(options)
      for await (const chunk of chunks) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind !== 'stop') {
        const reason = finish.kind === 'error' || finish.kind === 'aborted'
          ? finish.failure.message
          : `memory extraction finished with ${finish.kind}`
        throw new Error(reason)
      }
      return assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    })()
    return Promise.race([consume, abortPromise])
  }
}