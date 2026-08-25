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
 * 5. 调用 `extractFacts(agent, signal, route)` 用**专属记忆模型**做一次独立
 *    LLM chat completion(`ctx.llm.stream`,provider/model 取自 namespace 路由),
 *    返回 JSON 数组;`normalizeFacts` 收敛 scope + 去空 + 限长 + 限条数。
 * 6. `pickTargetScope(cwd)` 决定 folder/global;逐条经 sdk-transport 反向
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

/** 抽取 LLM 调用的系统提示(模型侧契约;改动请同步 README)。 */
const EXTRACT_SYSTEM_PROMPT = [
  'You are a long-term memory distiller for a StarHub AI coding assistant.',
  'Review the just-completed conversation turn and decide whether it contains',
  'durable facts worth persisting into long-term memory (preferences, project',
  'conventions, completed work, environment topology, corrections).',
  'If there is nothing durable, return {"facts": []}.',
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
 * Type for the dsh Agent surface used by the turn-stopping hook.
 * Kept narrow to avoid pulling in the full agent type and to keep the
 * dependency surface minimal for tests.
 */
export interface MemorySinkAgent {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    readonly events?: ReadonlyArray<{ readonly type: string }>
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
 * Build the user-prompt payload handed to the LLM extractor. The exact turn
 * transcript is intentionally NOT included — the hook sees only the final
 * signal that the turn is over, so the extractor relies on the agent-loop
 * injecting the most recent assistant turn via the `prompt` slot, which the
 * host wires to the assistant's last message. This keeps the dependency
 * surface minimal and the call deterministic.
 * @param agent - the stopping agent;its session cwd shapes the prompt.
 * @returns the extractor user-prompt text.
 */
export function buildExtractPrompt(agent: MemorySinkAgent): string {
  const cwd = agent.session.header.cwd
  const cwdLine = cwd === undefined || cwd.trim() === ''
    ? 'workspace: <none>'
    : `workspace: ${cwd}`
  const projectLine = cwd === undefined || cwd.trim() === ''
    ? 'project: <none>'
    : `project: ${projectNameOf(cwd)}`
  return [
    'Distill durable facts from the just-completed turn into long-term memory.',
    cwdLine,
    projectLine,
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
  if (!shouldReview(countMessages(params.agent))) return
  if (params.llm === undefined) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new Error('extract timed out')) }, EXTRACT_TIMEOUT_MS)
    })
    const result = await Promise.race([
      params.llm({
        route: params.route,
        system: EXTRACT_SYSTEM_PROMPT,
        prompt: buildExtractPrompt(params.agent),
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
