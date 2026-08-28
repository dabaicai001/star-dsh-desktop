/**
 * StarHub memory context(2026-08-21,StarHub 本地包,不在上游):把长期记忆
 * 注入每个 agent 请求,补上「memory 工具写了但从不注入」的缺失环节。
 *
 * 数据流:
 * 1. 设置 → AI 助手「启用长期记忆」开关经 settings 通道写入
 *    `starhub-memory-context` namespace(client-nav 侧,ai.tsx);
 * 2. **记忆模型是记忆功能的硬前置(v0.94.0)**:namespace 里 `memoryProvider`
 *    + `memoryModel` 必须成对非空,记忆功能(注入 / 自动沉淀 / memory 工具)
 *    才允许工作;未配置时本插件不注入、memory-sink 不沉淀、memory 工具调用
 *    被 tools/pre-execute 锁死。
 * 3. 本插件(host)在 `agent/pre-step` 读取该 namespace,关闭或未配置则完全不注入;
 * 4. 开启且已配置时经 `sdk-transport` 反向 RPC pull `starhub/memory.cards`
 *    (Rust 侧实现见 src-tauri/src/harness/mod.rs),scopes = user + global +
 *    `folder:<会话工作区绝对路径>`(session header.cwd,工作区文件夹独立记忆),
 *    Rust 侧顺带按 sessionId 解析资产绑定追加 `asset:<id>` 卡;
 * 5. 各卡非空段拼成一条 plugin 来源 user message 注入(形式对齐
 *    tool-context / live-context 的 `form: 'snapshot'`)。
 * 6. **v0.102.0 去重**:`pre-step` 在每个 step(包括工具调用后的每个续步)都会
 *    触发,但只在「注入文本相对上次有变」时才重复注入;纯函数 `shouldInject`
 *    同时校验内容变化与会话事件流(`user/message` + `source.kind==='plugin'`
 *    + `source.plugin==='starhub-memory-context'`)中是否仍存在本次注入消息,
 *    compaction 把旧注入裁剪掉时也能正确重新注入。per-session Map 容量
 *    兜底 64,超出按 FIFO 删除最旧条目。
 *
 * pull 失败/超时(2s)降级为不注入,不得阻断 agent turn;无工作区路径的
 * 会话(blank session)只注入 user/global/资产卡。
 *
 * @module @deepseek-ai/dsh-starhub-memory-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-memory-context'

/** The agent registry and settings service. */
export const inject = ['agents', 'settings']

/** Settings namespace holding the memory master switch (written by client-nav 的设置开关). */
export const MEMORY_CONTEXT_NAMESPACE = 'starhub-memory-context'

/** memory 工具名(宿主侧 tools 包注册);本插件在 tools/pre-execute 上锁死未配置时的调用。 */
export const MEMORY_TOOL_NAME = 'memory'

/** per-session 去重 Map 的容量兜底;超出按 FIFO 删除最旧条目。 */
const INJECTION_DEDUP_LIMIT = 64

/**
 * 注入去重 Map 中每条记录的形状:把本 session 的最近一次注入文本记下来,
 * 下次 pre-step 命中相同文本 + 事件流中仍存在该注入消息时跳过注入。
 */
type InjectionRecord = { readonly text: string }

/**
 * 记忆模型路由:自动沉淀抽取与 memory 工具锁死门禁共用的 provider/model 对。
 * provider 与 model 必须成对非空(与 commit-message 的固定路由约定一致)。
 */
export interface MemoryRoute {
  readonly provider: string
  readonly model: string
}

/**
 * 读取 autoReview 开关值;v0.92.0 起未写过视为关闭(默认关)。
 * memory-sink 钩子在 agent/turn-stopping 后调用本函数,关闭则整段跳过。
 * @param value - namespace 当前值;undefined 表示从未写过(视为关闭)。
 * @returns 是否开启自动沉淀(仅显式 true 为开启)。
 */
export function isAutoReviewEnabled(value: MemoryContextValue | undefined): boolean {
  return value?.autoReview === true
}

/**
 * 解析记忆模型路由;provider 或 model 任一为空(或从未配置)返回 undefined。
 * 未配置 = 记忆功能整体关闭:预读注入不工作、自动沉淀不工作、memory 工具
 * 调用被锁死(见 apply 的 tools/pre-execute 门)。
 * @param value - namespace 当前值;undefined 表示从未写过。
 * @returns 记忆模型 provider/model 对;未配置返回 undefined。
 */
export function memoryRouteOf(value: MemoryContextValue | undefined): MemoryRoute | undefined {
  const provider = value?.memoryProvider?.trim() ?? ''
  const model = value?.memoryModel?.trim() ?? ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * 记忆功能是否已配置(专属记忆模型是否就位)。
 * @param value - namespace 当前值。
 * @returns 已配置(provider + model 均非空)时为 true。
 */
export function isMemoryConfigured(value: MemoryContextValue | undefined): boolean {
  return memoryRouteOf(value) !== undefined
}

/** 桥方法名;Rust 侧实现见 src-tauri/src/harness/mod.rs(handle_memory_cards)。 */
const MEMORY_CARDS_METHOD = 'starhub/memory.cards'

/** 反向拉取记忆卡最多等待 2 秒;超时降级为不注入,不得阻断 agent turn。 */
const MEMORY_CARDS_TIMEOUT_MS = 2_000

/**
 * 「启用长期记忆与自动沉淀」单开关(v0.96.4 起把原「启用长期记忆」「自动
 * 沉淀记忆」两开关合并,client-nav 同值写 enabled 与 autoReview)与「记忆
 * 模型」配置的 namespace 值形状。v0.92.0 (2026-08-22) 起均默认关闭:用户需在
 * 设置 → AI 助手显式打开后才有记忆预读注入或自动沉淀;关闭状态 = 完全不调
 * RPC / 不写库。v0.94.0 (2026-08-23) 起记忆模型是硬前置:`memoryProvider` +
 * `memoryModel` 必须成对非空,记忆功能才可能工作(未配置时即使开关打开也整体关闭)。
 */
export interface MemoryContextValue {
  /** 是否注入长期记忆;缺省 false(v0.92.0 起)。 */
  enabled?: boolean
  /** 是否允许自动沉淀(agent/turn-stopping 后 LLM 抽摘要写入 ai_memories);缺省 false(v0.92.0 起)。 */
  autoReview?: boolean
  /** 专属记忆模型的 provider 路由(与 memoryModel 必须成对非空)。 */
  memoryProvider?: string
  /** 专属记忆模型的 model id(与 memoryProvider 必须成对非空)。 */
  memoryModel?: string
}

/** Schemastery validation for the namespace value. */
export const MemoryContextSchema: z<MemoryContextValue> = z.object({
  enabled: z.boolean().default(false),
  autoReview: z.boolean().default(false),
  memoryProvider: z.string().default(''),
  memoryModel: z.string().default(''),
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
 * 会话事件流元素的窄化形状,只要找到「上次注入文本仍在事件流里」所需字段。
 * 注入消息的特征:`type==='user/message'` + `data.source.kind==='plugin'` +
 * `data.source.plugin==='starhub-memory-context'`(本插件名),DSH 不变量保证
 * 模型可见的输入一定进入会话日志。
 *
 * `data` 用 `unknown` 是因为 DSH 严格联合里 `user/message` 的 data 是
 * `UserMessage` 接口(无索引签名),内部按 Record 形态安全探测。
 */
export interface InjectionEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * 在事件流中查找本次注入文本是否仍存在(且属于本插件注入)。
 * 防御性读 events:非数组 / 元素缺 data / content 非数组 / 块缺 text 都视为
 * 不可命中,返回 false(v0.102.0 dedup 设计:不可命中 ⇒ 重新注入)。
 * @param events - agent.session.events(可能为 undefined)。
 * @param text - 本次即将注入的文本。
 * @param pluginId - 注入方 plugin id;默认本插件名,允许测试覆写。
 * @returns true 当且仅当事件流中存在 `user/message` + `plugin==pluginId`
 *   的消息,且其文本内容完全等于 `text`。
 */
export function hasLiveInjection(
  events: ReadonlyArray<InjectionEvent> | undefined,
  text: string,
  pluginId: string = name,
): boolean {
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (event === null || event === undefined) continue
    if (event.type !== 'user/message') continue
    const data = event.data
    if (data === undefined || data === null || typeof data !== 'object') continue
    const dataRecord = data as Readonly<Record<string, unknown>>
    const source = dataRecord['source']
    if (source === undefined || source === null || typeof source !== 'object') continue
    const sourceRecord = source as Readonly<Record<string, unknown>>
    if (sourceRecord['kind'] !== 'plugin' || sourceRecord['plugin'] !== pluginId) continue
    const content = dataRecord['content']
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block === null || block === undefined) continue
      if (typeof block !== 'object') continue
      const blockRecord = block as Readonly<Record<string, unknown>>
      if (blockRecord['type'] === 'text' && blockRecord['text'] === text) return true
    }
  }
  return false
}

/**
 * 判定本 step 是否应该注入记忆文本(v0.102.0 去重核心):
 * - `lastText === undefined`:本 session 首次 pre-step,直接注入。
 * - `lastText === text`:文本未变;events 缺失/为空数组时退化按 Map 去重(任意
 *   环境都能抑制重复);events 非空数组时还要校验事件流里仍存在本次注入,
 *   否则(compaction 等可能裁掉旧注入)仍要重新注入。
 * - `lastText !== text`:记忆内容变了,无论 events 怎样都重新注入并刷新 Map。
 * @param lastText - 本 session 上次注入的文本;undefined 表示无记录。
 * @param text - 本次即将注入的文本。
 * @param events - agent.session.events;用于事件流活体校验。
 * @param pluginId - 注入方 plugin id;默认本插件名,允许测试覆写。
 * @returns true 表示应当注入,false 表示跳过。
 */
export function shouldInject(
  lastText: string | undefined,
  text: string,
  events: ReadonlyArray<InjectionEvent> | undefined,
  pluginId: string = name,
): boolean {
  if (lastText === undefined) return true
  if (lastText !== text) return true
  // 文本相同:只有当 events 明确非空数组且其中存在本次注入时才跳过;
  // events 缺失/为空数组 → 退化按 Map 去重,保证任何环境下频率都降下来。
  if (!Array.isArray(events) || events.length === 0) return false
  return !hasLiveInjection(events, text, pluginId)
}

/**
 * 记录本 session 的最近一次注入文本;Map 容量超过 `INJECTION_DEDUP_LIMIT`
 * 时按 FIFO 删除最旧条目。**会** mutate 入参 map(由 caller 决定生命周期)。
 * @param map - per-session 注入记录 Map。
 * @param sessionId - 会话 id。
 * @param text - 本次注入文本。
 */
export function recordInjection(
  map: Map<string, InjectionRecord>,
  sessionId: string,
  text: string,
): void {
  if (map.size >= INJECTION_DEDUP_LIMIT) {
    // Map 遍历顺序 = 插入顺序(FIFO);第一个 key 即最旧条目。
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(sessionId, { text })
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
 * 注册插件:声明 settings 命名空间一次,并在每次 agent pre-step 按开关 + 记忆模型
 * 配置注入长期记忆(user + global + 当前工作区文件夹 + 绑定资产);同时挂
 * tools/pre-execute 锁死门,未配置记忆模型时拒绝 memory 工具调用。
 * v0.102.0 起:per-session Map 去重,「内容变化才重复」,compaction 裁掉旧注入
 * 时由事件流活体校验补回重新注入。
 * @param ctx - plugin context;监听器随插件 fiber 卸载。
 */
export function apply(ctx: Context): void {
  const ns: SettingsNamespace = settingsNamespace(MEMORY_CONTEXT_NAMESPACE)
  // Declare the namespace once; the pre-step listener reads it per request.
  const scope = ctx.settings.register(ns, MemoryContextSchema)

  // per-session 最近一次注入文本;Fiber 内闭包,apply 卸载即丢;Map 容量
  // 兜底由 recordInjection(INJECTION_DEDUP_LIMIT)负责 FIFO。
  const injectionLog: Map<string, InjectionRecord> = new Map()

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
      // v0.94.0:记忆模型是硬前置;开关打开但未配置,不注入(配置缺失不该静默)。
      if (!isMemoryConfigured(value)) {
        console.warn(
          '[starhub-memory-context] 记忆开关已打开但未配置记忆模型(provider+model),'
          + '跳过记忆注入;请到「设置 → AI 助手」配置记忆模型',
        )
        return decision
      }
      const cwd = agent.session.header.cwd
      const scopes = ['user', 'global', ...(cwd === undefined ? [] : [`folder:${cwd}`])]
      const text = await composeMemoryContext(transport, scopes, String(agent.session.id))
      if (text === null) return decision
      // v0.102.0 dedup:per-session Map 记录上次注入文本,内容未变且事件流中
      // 仍存在本次注入时直接返回原 decision,跳过重复注入。
      const sessionId = String(agent.session.id)
      const events = (agent.session as { readonly events?: ReadonlyArray<InjectionEvent> }).events
      const lastText = injectionLog.get(sessionId)?.text
      if (!shouldInject(lastText, text, events)) return decision
      recordInjection(injectionLog, sessionId, text)
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

  // v0.94.0:memory 工具锁死门——未配置记忆模型时拒绝调用(preset/审批门之前
  // 短路,不弹确认卡,也不进 Rust 写路径)。配置后放行,交回链尾(approval-bridge
  // 的 ALWAYS_ASK 风险门负责逐条确认)。独立 effect,随插件 fiber 一并卸载。
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== MEMORY_TOOL_NAME) return next()
    const value = scope.get() as MemoryContextValue | undefined
    if (isMemoryConfigured(value)) return next()
    return {
      kind: 'deny',
      reason: '记忆功能未启用:请先在「设置 → AI 助手」配置记忆模型(选择 provider 与 model),之后才能使用 memory 工具',
    }
  }, { prepend: true }), 'starhub-memory-context: memory-tool lock gate')
}