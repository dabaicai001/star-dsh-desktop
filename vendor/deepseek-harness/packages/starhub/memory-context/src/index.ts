/**
 * StarHub memory context(2026-08-21,StarHub 本地包,不在上游):把长期记忆
 * 注入每个 agent 请求,补上「memory 工具写了但从不注入」的缺失环节。
 *
 * 数据流:
 * 1. 设置 → AI 助手「启用长期记忆」开关经 settings 通道写入
 *    `starhub-memory-context` namespace(client-nav 侧,ai.tsx);
 * 2. 本插件(host)在 `agent/pre-step` 读取该 namespace,关闭则完全不注入;
 * 3. 开启时经 `sdk-transport` 反向 RPC pull `starhub/memory.cards`(Rust 侧
 *    实现见 src-tauri/src/harness/mod.rs),scopes = user + global +
 *    `folder:<会话工作区绝对路径>`(session header.cwd,工作区文件夹独立记忆),
 *    Rust 侧顺带按 sessionId 解析资产绑定追加 `asset:<id>` 卡;
 * 4. 各卡非空段拼成一条 plugin 来源 user message 注入(形式对齐
 *    tool-context / live-context 的 `form: 'snapshot'`)。
 *
 * pull 失败/超时(2s)降级为不注入,不得阻断 agent turn;无工作区路径的
 * 会话(blank session)只注入 user/global/资产卡。
 *
 * @module @deepseek-ai/dsh-starhub-memory-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-memory-context'

/** The agent registry and settings service. */
export const inject = ['agents', 'settings']

/** Settings namespace holding the memory master switch (written by client-nav 的设置开关). */
export const MEMORY_CONTEXT_NAMESPACE = 'starhub-memory-context'

/**
 * 读取 autoReview 开关值;v0.92.0 起未写过视为关闭(默认关)。
 * memory-sink 钩子在 agent/turn-stopping 后调用本函数,关闭则整段跳过。
 * @param value - namespace 当前值;undefined 表示从未写过(视为关闭)。
 * @returns 是否开启自动沉淀(仅显式 true 为开启)。
 */
export function isAutoReviewEnabled(value: MemoryContextValue | undefined): boolean {
  return value?.autoReview === true
}

/** 桥方法名;Rust 侧实现见 src-tauri/src/harness/mod.rs(handle_memory_cards)。 */
const MEMORY_CARDS_METHOD = 'starhub/memory.cards'

/** 反向拉取记忆卡最多等待 2 秒;超时降级为不注入,不得阻断 agent turn。 */
const MEMORY_CARDS_TIMEOUT_MS = 2_000

/** 「启用长期记忆」与「自动沉淀记忆」开关的 namespace 值形状。
 * v0.92.0 (2026-08-22) 起两者均默认关闭:用户需在设置 → AI 助手显式打开后
 * 才有记忆预读注入或自动沉淀;关闭状态 = 完全不调 RPC / 不写库。
 * 旧版本(≤0.91.0)两者默认开启,namespace 写法需显式 patch 才能恢复关闭态。
 */
export interface MemoryContextValue {
  /** 是否注入长期记忆;缺省 false(v0.92.0 起)。 */
  enabled?: boolean
  /** 是否允许自动沉淀(agent/turn-stopping 后 LLM 抽摘要写入 ai_memories);缺省 false(v0.92.0 起)。 */
  autoReview?: boolean
}

/** Schemastery validation for the namespace value. */
export const MemoryContextSchema: z<MemoryContextValue> = z.object({
  enabled: z.boolean().default(false),
  autoReview: z.boolean().default(false),
})

/** `starhub/memory.cards` 的单张记忆卡(与 Rust AiMemoryCard 序列化同形)。 */
export interface MemoryCard {
  readonly scope: string
  readonly content: string
  readonly char_count: number
  readonly char_limit: number
  readonly entry_count: number
}

/** scope → 注入段标题(folder 卡用「workspace folder」面向上文,路径放在 scope 行)。 */
function cardTitle(scope: string): string {
  if (scope === 'user') return 'user profile'
  if (scope === 'global') return 'environment & experience'
  if (scope.startsWith('folder:')) return `workspace folder (${scope.slice('folder:'.length)})`
  if (scope.startsWith('asset:')) return `bound asset (${scope.slice('asset:'.length)})`
  return scope
}

/**
 * 渲染一次注入的记忆文本;空卡(无条目)整段省略。
 * @param cards - `starhub/memory.cards` 返回的记忆卡列表。
 * @returns 注入文本;全部为空时返回 null(不注入)。
 */
export function renderMemoryContext(cards: readonly MemoryCard[]): string | null {
  const sections: string[] = []
  for (const card of cards) {
    if (card.entry_count <= 0 || card.content.trim() === '') continue
    sections.push(`[${cardTitle(card.scope)}]`)
    sections.push(card.content)
  }
  if (sections.length === 0) return null
  return [
    'Long-term memories (persistent across sessions; apply them proactively, and save new durable facts with the memory tool):',
    ...sections,
  ].join('\n')
}

/**
 * 组装一次注入文本:经 sdk-transport 反向 pull 记忆卡,失败/超时降级为 null。
 * @param transport - sdk-transport;缺失时直接返回 null。
 * @param scopes - 要拉取的 scope 列表(user / global / folder:<path>)。
 * @param sessionId - 当前会话 id(Rust 侧据此解析资产绑定追加 asset 卡)。
 * @returns 注入文本;无内容或失败时返回 null。
 */
export async function composeMemoryContext(
  transport: JsonRpcTransportPeer | undefined,
  scopes: readonly string[],
  sessionId: string,
): Promise<string | null> {
  if (transport === undefined) return null
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new Error('starhub/memory.cards timed out')) }, MEMORY_CARDS_TIMEOUT_MS)
    })
    const result: unknown = await Promise.race([
      transport.request(MEMORY_CARDS_METHOD, { scopes, sessionId }),
      timeoutPromise,
    ])
    if (typeof result !== 'object' || result === null) return null
    const cards = (result as { cards?: unknown }).cards
    if (!Array.isArray(cards)) return null
    return renderMemoryContext(cards as MemoryCard[])
  } catch {
    // pull 失败/超时(宿主报错、进程断开或未实现)降级为不注入,不打断 pre-step。
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 注册插件:声明 settings 命名空间一次,并在每次 agent pre-step 按开关注入
 * 长期记忆(user + global + 当前工作区文件夹 + 绑定资产)。
 * @param ctx - plugin context;监听器随插件 fiber 卸载。
 */
export function apply(ctx: Context): void {
  const ns: SettingsNamespace = settingsNamespace(MEMORY_CONTEXT_NAMESPACE)
  // Declare the namespace once; the pre-step listener reads it per request.
  const scope = ctx.settings.register(ns, MemoryContextSchema)

  ctx.effect(() => {
    // sdk-transport 是宿主私有服务名,不走 Context 接口声明合并,读取后窄化;
    // 在 effect 阶段读取(提供方 sdk-jsonrpc-server 可能尚未 apply)。
    const transport = ctx.get('sdk-transport') as JsonRpcTransportPeer | undefined

    return ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      // 「启用长期记忆」开关(设置 → AI 助手);v0.92.0 起 namespace 未写过视为关闭,
      // 用户需在设置面板显式打开后才有记忆预读注入。
      const value = scope.get() as MemoryContextValue | undefined
      if (value?.enabled !== true) return decision
      const cwd = agent.session.header.cwd
      const scopes = ['user', 'global', ...(cwd === undefined ? [] : [`folder:${cwd}`])]
      const text = await composeMemoryContext(transport, scopes, String(agent.session.id))
      if (text === null) return decision
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
          }),
        ],
      }
    }, { prepend: true })
  }, 'starhub-memory-context: pre-step injection')
}
