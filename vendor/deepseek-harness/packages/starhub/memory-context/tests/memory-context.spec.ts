/**
 * StarHub memory context:渲染、开关语义、pull 降级、pre-step 注入。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import {
  apply, composeMemoryContext, hasLiveInjection, isAutoReviewEnabled, isMemoryConfigured,
  MEMORY_TOOL_NAME, memoryRouteOf, recordInjection, renderMemoryContext, shouldInject,
} from '../src/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'

type PreStepListener = (
  payload: { agent: unknown; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

function makeTransport(result: unknown) {
  const request = vi.fn(async () => result)
  return { transport: { request } as unknown as JsonRpcTransportPeer, request }
}

function makeFailingTransport() {
  const request = vi.fn(async () => { throw new Error('boom') })
  return { transport: { request } as unknown as JsonRpcTransportPeer, request }
}

function makeAgent(cwd?: string) {
  return {
    session: {
      id: 'sess-1',
      header: {
        ...(cwd === undefined ? {} : { cwd }),
      },
    },
  }
}

function makeCtx(services: Record<string, unknown>, namespaceValue: unknown) {
  const listeners: PreStepListener[] = []
  const on = vi.fn((_event: string, listener: PreStepListener) => {
    listeners.push(listener)
    return () => undefined
  })
  const effect = vi.fn((callback: () => unknown) => callback())
  const register = vi.fn(() => ({ get: () => namespaceValue }))
  const ctx = {
    get: (serviceName: string) => services[serviceName],
    on,
    effect,
    settings: { register },
  } as unknown as Context
  return { ctx, listeners, register }
}

const ENTER: PreStepDecision = { kind: 'enter', messages: [] }

const CARDS = {
  cards: [
    { scope: 'user', content: '偏好中文回复', char_count: 6, char_limit: 1375, entry_count: 1 },
    { scope: 'global', content: '', char_count: 0, char_limit: 2200, entry_count: 0 },
    { scope: 'folder:E:\\ws\\starhub', content: '构建走 npm run build:window', char_count: 24, char_limit: 1375, entry_count: 1 },
  ],
}

describe('renderMemoryContext', () => {
  it('renders non-empty cards and skips empty ones', () => {
    const text = renderMemoryContext(CARDS.cards)!
    expect(text).toContain('Long-term memories')
    expect(text).toContain('[user profile]')
    expect(text).toContain('偏好中文回复')
    expect(text).toContain('[workspace folder (E:\\ws\\starhub)]')
    expect(text).toContain('构建走 npm run build:window')
    expect(text).not.toContain('[environment & experience]')
  })

  it('returns null when every card is empty', () => {
    expect(renderMemoryContext([
      { scope: 'user', content: '', char_count: 0, char_limit: 1375, entry_count: 0 },
    ])).toBeNull()
  })

  it('labels bound-asset cards', () => {
    const text = renderMemoryContext([
      { scope: 'asset:a1', content: '生产库', char_count: 3, char_limit: 1375, entry_count: 1 },
    ])!
    expect(text).toContain('[bound asset (a1)]')
  })

  it('labels non-empty global cards and falls back to the raw scope for unknown kinds', () => {
    const text = renderMemoryContext([
      { scope: 'global', content: '构建走 npm run build', char_count: 10, char_limit: 2200, entry_count: 1 },
      { scope: 'team', content: '团队约定', char_count: 4, char_limit: 1375, entry_count: 1 },
    ])!
    expect(text).toContain('[environment & experience]')
    expect(text).toContain('构建走 npm run build')
    expect(text).toContain('[team]')
  })
})

describe('isAutoReviewEnabled', () => {
  it('defaults off unless the namespace explicitly opts in (v0.92.0)', () => {
    expect(isAutoReviewEnabled(undefined)).toBe(false)
    expect(isAutoReviewEnabled({})).toBe(false)
    expect(isAutoReviewEnabled({ enabled: true })).toBe(false)
    expect(isAutoReviewEnabled({ autoReview: false })).toBe(false)
    expect(isAutoReviewEnabled({ autoReview: true })).toBe(true)
  })
})

describe('memoryRouteOf / isMemoryConfigured (v0.94.0 hard gate)', () => {
  it('requires provider and model to be a non-empty pair', () => {
    expect(memoryRouteOf(undefined)).toBeUndefined()
    expect(memoryRouteOf({})).toBeUndefined()
    expect(memoryRouteOf({ enabled: true })).toBeUndefined()
    expect(memoryRouteOf({ memoryProvider: 'p' })).toBeUndefined()
    expect(memoryRouteOf({ memoryModel: 'm' })).toBeUndefined()
    expect(memoryRouteOf({ memoryProvider: '  ', memoryModel: 'm' })).toBeUndefined()
    expect(memoryRouteOf({ memoryProvider: 'mem-provider', memoryModel: 'mem-model' }))
      .toEqual({ provider: 'mem-provider', model: 'mem-model' })
    expect(memoryRouteOf({ memoryProvider: ' p ', memoryModel: ' m ' }))
      .toEqual({ provider: 'p', model: 'm' })
  })
  it('reports configuration through isMemoryConfigured', () => {
    expect(isMemoryConfigured(undefined)).toBe(false)
    expect(isMemoryConfigured({ memoryProvider: 'p' })).toBe(false)
    expect(isMemoryConfigured({ memoryProvider: 'p', memoryModel: 'm' })).toBe(true)
  })
})

describe('composeMemoryContext', () => {
  it('pulls cards through the transport with scopes and sessionId', async () => {
    const { transport, request } = makeTransport(CARDS)
    const text = await composeMemoryContext(transport, ['user', 'global'], 'sess-1')
    expect(text).toContain('偏好中文回复')
    expect(request).toHaveBeenCalledWith('starhub/memory.cards', {
      scopes: ['user', 'global'],
      sessionId: 'sess-1',
    })
  })

  it('degrades to null on pull failure', async () => {
    const { transport } = makeFailingTransport()
    expect(await composeMemoryContext(transport, ['user'], 'sess-1')).toBeNull()
  })

  it('degrades to null without a transport or with a malformed result', async () => {
    expect(await composeMemoryContext(undefined, ['user'], 'sess-1')).toBeNull()
    expect(await composeMemoryContext(makeTransport({ nope: 1 }).transport, ['user'], 'sess-1')).toBeNull()
    // 非对象与 null 结果同样视为畸形。
    expect(await composeMemoryContext(makeTransport('plain').transport, ['user'], 'sess-1')).toBeNull()
    expect(await composeMemoryContext(makeTransport(null).transport, ['user'], 'sess-1')).toBeNull()
  })

  it('degrades to null when the pull exceeds the 2s budget', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(() => new Promise<never>(() => {}))
      const transport = { request } as unknown as JsonRpcTransportPeer
      const textPromise = composeMemoryContext(transport, ['user'], 'sess-1')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await textPromise).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('apply (pre-step injection)', () => {
  async function runListener(listeners: PreStepListener[], agent: unknown) {
    const listener = listeners[0]
    expect(listener).toBeDefined()
    return listener!({ agent, signal: new AbortController().signal }, () => Promise.resolve(ENTER))
  }

  it('injects memory text with user/global/folder scopes when enabled and the route is configured', async () => {
    const { ctx, listeners } = makeCtx(
      { 'sdk-transport': makeTransport(CARDS).transport },
      { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
    )
    apply(ctx)
    const decision = await runListener(listeners, makeAgent('E:\\ws\\starhub'))
    expect(decision.kind).toBe('enter')
    const messages = (decision as { messages: Array<{ content: Array<{ text?: string }> }> }).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content[0]!.text).toContain('偏好中文回复')
  })

  it('does not inject when the namespace was never written (default off since v0.92.0)', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, undefined)
    apply(ctx)
    const decision = await runListener(listeners, makeAgent('/w'))
    expect(decision).toBe(ENTER)
    expect(request).not.toHaveBeenCalled()
  })

  it('omits the folder scope for sessions without a cwd', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx(
      { 'sdk-transport': transport },
      { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
    )
    apply(ctx)
    await runListener(listeners, makeAgent())
    expect(request).toHaveBeenCalledWith('starhub/memory.cards', {
      scopes: ['user', 'global'],
      sessionId: 'sess-1',
    })
  })

  it('does not inject when the master switch is off', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, { enabled: false })
    apply(ctx)
    const decision = await runListener(listeners, makeAgent('/w'))
    expect(decision).toBe(ENTER)
    expect(request).not.toHaveBeenCalled()
  })

  it('does not inject when enabled but the memory route is missing (v0.94.0 hard gate)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { transport, request } = makeTransport(CARDS)
      const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, { enabled: true })
      apply(ctx)
      const decision = await runListener(listeners, makeAgent('/w'))
      expect(decision).toBe(ENTER)
      expect(request).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('未配置记忆模型'))
    } finally {
      warn.mockRestore()
    }
  })

  it('passes through rejected decisions untouched', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, undefined)
    apply(ctx)
    const rejected: PreStepDecision = { kind: 'reject' }
    const listener = listeners[0]!
    const decision = await listener(
      { agent: makeAgent('/w'), signal: new AbortController().signal },
      () => Promise.resolve(rejected),
    )
    expect(decision).toBe(rejected)
    expect(request).not.toHaveBeenCalled()
  })

  it('returns the decision untouched when every card comes back empty', async () => {
    const empty = { cards: [{ scope: 'user', content: '', char_count: 0, char_limit: 1375, entry_count: 0 }] }
    const { transport, request } = makeTransport(empty)
    const { ctx, listeners } = makeCtx(
      { 'sdk-transport': transport },
      { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
    )
    apply(ctx)
    const decision = await runListener(listeners, makeAgent('/w'))
    expect(decision).toBe(ENTER)
    expect(request).toHaveBeenCalledOnce()
  })

  it('returns the decision untouched when the step signal is already aborted', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, { enabled: true })
    apply(ctx)
    const controller = new AbortController()
    controller.abort()
    const decision = await listeners[0]!(
      { agent: makeAgent('/w'), signal: controller.signal },
      () => Promise.resolve(ENTER),
    )
    expect(decision).toBe(ENTER)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('memory tool lock gate (tools/pre-execute, v0.94.0)', () => {
  type PreExecListener = (
    exec: { name: string },
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string }>

  const ALLOW = { kind: 'allow' as const }

  /** apply() 注册两个监听器:listeners[0] = pre-step,listeners[1] = 工具锁死门。 */
  function gateListener(listeners: PreStepListener[]): PreExecListener {
    const listener = listeners[1]
    expect(listener).toBeDefined()
    return listener as unknown as PreExecListener
  }

  it('denies memory tool calls when the route is missing', async () => {
    const { ctx, listeners } = makeCtx({}, { enabled: true })
    apply(ctx)
    const decision = await gateListener(listeners)({ name: MEMORY_TOOL_NAME }, () => Promise.resolve(ALLOW))
    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('配置记忆模型')
  })

  it('allows memory tool calls once the route is configured', async () => {
    const { ctx, listeners } = makeCtx({}, { memoryProvider: 'p', memoryModel: 'm' })
    apply(ctx)
    await expect(gateListener(listeners)({ name: MEMORY_TOOL_NAME }, () => Promise.resolve(ALLOW)))
      .resolves.toEqual(ALLOW)
  })

  it('passes non-memory tools through untouched even when unconfigured', async () => {
    const { ctx, listeners } = makeCtx({}, undefined)
    apply(ctx)
    await expect(gateListener(listeners)({ name: 'ssh_exec' }, () => Promise.resolve(ALLOW)))
      .resolves.toEqual(ALLOW)
  })
})

describe('package shells', () => {
  it('the invariant companion registers ownership with an empty installer', async () => {
    const registered: string[] = []
    const installers: Array<() => void> = []
    const ctx = {
      invariants: {
        register: (pkg: string, install: () => void) => {
          registered.push(pkg)
          installers.push(install)
          return () => undefined
        },
      },
    } as unknown as Context
    const dispose = await applyInvariant(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-starhub-memory-context'])
    // The companion is intentionally empty: no runtime invariant to assert.
    installers[0]!()
    expect(dispose).toBeTypeOf('function')
  })
})

describe('v0.102.0 injection dedup', () => {
  const TEXT = 'Long-term memories (persistent across sessions; ...):\n[user profile]\nfoo'

  function injectionEvent(text: string, plugin = 'starhub-memory-context') {
    return {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin },
      },
    }
  }

  describe('hasLiveInjection', () => {
    it('matches a plugin-sourced user message with matching text', () => {
      const events = [injectionEvent(TEXT)]
      expect(hasLiveInjection(events, TEXT)).toBe(true)
    })

    it('ignores plugin events with mismatching plugin id', () => {
      const events = [injectionEvent(TEXT, 'some-other-plugin')]
      expect(hasLiveInjection(events, TEXT)).toBe(false)
    })

    it('ignores plugin events with mismatching text', () => {
      const events = [injectionEvent('something-else')]
      expect(hasLiveInjection(events, TEXT)).toBe(false)
    })

    it('ignores user-sourced messages (not plugin)', () => {
      const events = [{
        type: 'user/message',
        data: { content: [{ type: 'text', text: TEXT }], source: { kind: 'user' } },
      }]
      expect(hasLiveInjection(events, TEXT)).toBe(false)
    })

    it('returns false on missing or non-array events', () => {
      expect(hasLiveInjection(undefined, TEXT)).toBe(false)
      // @ts-expect-error -- non-array inputs are defensive-tested
      expect(hasLiveInjection('bogus', TEXT)).toBe(false)
    })

    it('survives malformed event entries without throwing', () => {
      const events = [
        { type: 'user/message' },
        { type: 'user/message', data: null },
        { type: 'user/message', data: { content: 'not-an-array' } },
        { type: 'user/message', data: { content: [{ type: 'image' }] } },
        injectionEvent(TEXT),
      ]
      expect(hasLiveInjection(events, TEXT)).toBe(true)
    })
  })

  describe('shouldInject', () => {
    it('injects when no previous record exists for the session', () => {
      expect(shouldInject(undefined, TEXT, [injectionEvent(TEXT)])).toBe(true)
    })

    it('skips when text matches and events still hold the live injection', () => {
      expect(shouldInject(TEXT, TEXT, [injectionEvent(TEXT)])).toBe(false)
    })

    it('re-injects when text matches but events no longer carry the injection', () => {
      // compaction 可能把上一条注入裁掉了;仍要重新注入。
      const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'unrelated' }] } }]
      expect(shouldInject(TEXT, TEXT, events)).toBe(true)
    })

    it('skips via Map dedup when events are absent', () => {
      // 任何环境(events 缺失)都能抑制重复注入。
      expect(shouldInject(TEXT, TEXT, undefined)).toBe(false)
    })

    it('skips via Map dedup when events are an empty array', () => {
      expect(shouldInject(TEXT, TEXT, [])).toBe(false)
    })

    it('re-injects when text changes', () => {
      const newText = TEXT + '\nappend'
      expect(shouldInject(TEXT, newText, [injectionEvent(TEXT)])).toBe(true)
    })
  })

  describe('recordInjection', () => {
    it('stores the latest text under the session id', () => {
      const map = new Map<string, { text: string }>()
      recordInjection(map, 'sess-1', TEXT)
      expect(map.get('sess-1')?.text).toBe(TEXT)
    })

    it('evicts the oldest session when over the 64-session cap (FIFO)', () => {
      const map = new Map<string, { text: string }>()
      for (let i = 0; i < 64; i += 1) recordInjection(map, `sess-${i}`, TEXT)
      expect(map.size).toBe(64)
      recordInjection(map, 'sess-65', TEXT)
      expect(map.size).toBe(64)
      // 最旧的 sess-0 被 FIFO 踢出。
      expect(map.has('sess-0')).toBe(false)
      expect(map.has('sess-65')).toBe(true)
    })
  })

  describe('apply dedup end-to-end', () => {
    async function runStep(
      listeners: PreStepListener[],
      agent: unknown,
      decision: PreStepDecision = ENTER,
    ): Promise<PreStepDecision> {
      const listener = listeners[0]
      expect(listener).toBeDefined()
      return listener!({ agent, signal: new AbortController().signal }, () => Promise.resolve(decision))
    }

    it('skips a second pre-step when text and live injection are both present', async () => {
      const { transport } = makeTransport(CARDS)
      const { ctx, listeners } = makeCtx(
        { 'sdk-transport': transport },
        { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
      )
      apply(ctx)
      const agent = makeAgent('/w')
      // 第一次注入:events 是空(模拟刚启动,日志还没追上)→ 仍注入。
      const first = await runStep(listeners, agent)
      expect(first.kind).toBe('enter')
      expect((first as { messages: unknown[] }).messages).toHaveLength(1)
      // 把本次注入文本回灌到 events(模拟 agent-loop 已写入日志)。
      const injectedText = ((((first as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[0]!.text) ?? '') as string)
      ;(agent as { session: { events?: unknown[] } }).session.events = [injectionEvent(injectedText)]
      // 第二次 pre-step:内容 + 事件流都匹配 → 跳过。
      const second = await runStep(listeners, agent)
      expect(second).toBe(ENTER)
    })

    it('re-injects when the live injection is gone from events (compaction clip)', async () => {
      const { transport } = makeTransport(CARDS)
      const { ctx, listeners } = makeCtx(
        { 'sdk-transport': transport },
        { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
      )
      apply(ctx)
      const agent = makeAgent('/w')
      const first = await runStep(listeners, agent)
      const injectedText = ((((first as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[0]!.text) ?? '') as string)
      // 事件流里留一条无关 user/message(模拟 compaction 把上次注入裁掉)。
      ;(agent as { session: { events?: unknown[] } }).session.events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'unrelated' }] } }]
      const second = await runStep(listeners, agent)
      expect(second.kind).toBe('enter')
      expect((second as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[0]!.text).toBe(injectedText)
    })

    it('re-injects when the rendered memory text changes', async () => {
      // 通过可变的 transport 响应模拟「卡片内容变化 → 渲染文本变化」:
      // 同一 transport 在两次 request 间返回不同内容,plugin 必须重新注入。
      const mutableResult = { current: { cards: [{ scope: 'user', content: 'A', char_count: 1, char_limit: 1375, entry_count: 1 }] } }
      const request = vi.fn(async () => mutableResult.current)
      const transport = { request } as unknown as JsonRpcTransportPeer
      const { ctx, listeners } = makeCtx(
        { 'sdk-transport': transport },
        { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
      )
      apply(ctx)
      const agent = makeAgent('/w')
      // 第一次注入,events 回灌本次文本。
      const first = await runStep(listeners, agent)
      const firstText = ((((first as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[0]!.text) ?? '') as string)
      expect(firstText).toContain('A')
      ;(agent as { session: { events?: unknown[] } }).session.events = [injectionEvent(firstText)]
      // 渲染文本变化 → 必须重新注入。
      mutableResult.current = { cards: [{ scope: 'user', content: 'B', char_count: 1, char_limit: 1375, entry_count: 1 }] }
      const second = await runStep(listeners, agent)
      expect(second.kind).toBe('enter')
      const secondText = ((((second as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[0]!.text) ?? '') as string)
      expect(secondText).not.toBe(firstText)
      expect(secondText).toContain('B')
    })

    it('dedupes by Map alone when session.events is absent', async () => {
      const { transport } = makeTransport(CARDS)
      const { ctx, listeners } = makeCtx(
        { 'sdk-transport': transport },
        { enabled: true, memoryProvider: 'p', memoryModel: 'm' },
      )
      apply(ctx)
      // 两次 pre-step,session.events 始终缺失(DSH web 会话就属此情形)。
      const agent = makeAgent('/w')
      const first = await runStep(listeners, agent)
      expect((first as { messages: unknown[] }).messages).toHaveLength(1)
      const second = await runStep(listeners, agent)
      expect(second).toBe(ENTER)
    })
  })
})
