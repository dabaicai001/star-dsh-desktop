/**
 * StarHub memory sink: turn-stopping 钩子的纯函数与降级路径。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply,
  buildExtractPrompt,
  countMessages,
  MEMORY_WRITE_METHOD,
  persistExtractedFacts,
  projectNameOf,
  runTurnReview,
  wireLlmExtractor,
  writeFact,
} from '../src/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import { normalizeFacts, pickTargetScope, shouldReview } from '../src/gates.ts'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

/** 专属记忆模型路由(测试固定值)。 */
const ROUTE = { provider: 'mem-provider', model: 'mem-model' } as const

/** 从文本块流式返回一段文本的 llm stream 桩(finish.reason 为 FinishReason 对象)。 */
function streamingLlm(text: string) {
  const stream = vi.fn((_options: unknown) => (async function * () {
    if (text !== '') yield { type: 'text-delta', index: 0, text } as const
    yield { type: 'finish', reason: { kind: 'stop' } } as const
  })())
  return { stream }
}

function makeAgent(cwd?: string, events: ReadonlyArray<{ type: string }> = []) {
  return {
    session: {
      id: 'sess-1',
      header: cwd === undefined ? {} : { cwd },
      events,
    },
  }
}

describe('shouldReview', () => {
  it('rejects when user+assistant below threshold', () => {
    expect(shouldReview({ user: 1, assistant: 1 })).toBe(false)
    expect(shouldReview({ user: 2, assistant: 1 })).toBe(false)
  })
  it('accepts at threshold and above', () => {
    expect(shouldReview({ user: 2, assistant: 2 })).toBe(true)
    expect(shouldReview({ user: 10, assistant: 5 })).toBe(true)
  })
  it('tolerates non-finite inputs', () => {
    expect(shouldReview({ user: Number.NaN, assistant: Number.NaN })).toBe(false)
  })
})

describe('pickTargetScope', () => {
  it('returns folder:<cwd> when cwd present', () => {
    expect(pickTargetScope('E:\\ws\\starhub')).toBe('folder:E:\\ws\\starhub')
  })
  it('falls back to global when cwd missing or blank', () => {
    expect(pickTargetScope(undefined)).toBe('global')
    expect(pickTargetScope('')).toBe('global')
    expect(pickTargetScope('   ')).toBe('global')
  })
})

describe('normalizeFacts', () => {
  it('normalizes an array of objects with content strings', () => {
    const out = normalizeFacts(
      [{ content: 'preference: 中文回复' }, { content: '  spaces  ' }],
      { cwd: 'E:\\ws' },
    )
    expect(out).toEqual([
      { scope: 'folder:E:\\ws', content: 'preference: 中文回复' },
      { scope: 'folder:E:\\ws', content: 'spaces' },
    ])
  })
  it('parses a JSON string payload', () => {
    const out = normalizeFacts('{"facts":[{"content":"build cmd"}]}', { cwd: '/x' })
    expect(out).toEqual([{ scope: 'folder:/x', content: 'build cmd' }])
  })
  it('treats plain strings as a single fallback fact', () => {
    const out = normalizeFacts('hard-coded fallback fact', { cwd: '/x' })
    expect(out).toEqual([{ scope: 'folder:/x', content: 'hard-coded fallback fact' }])
  })
  it('drops empty, oversize and non-object items', () => {
    const out = normalizeFacts(
      [{ content: '' }, { content: 'x'.repeat(400) }, null, { foo: 1 }, { content: 'ok' }],
      { cwd: undefined },
    )
    expect(out).toEqual([{ scope: 'global', content: 'ok' }])
  })
  it('caps entries at the limit', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ content: `fact ${i}` }))
    const out = normalizeFacts(items, { cwd: '/x', maxEntries: 5 })
    expect(out).toHaveLength(5)
    expect(out[0]?.content).toBe('fact 0')
  })
  it('forces scope to pickTargetScope regardless of LLM label', () => {
    const out = normalizeFacts([{ scope: 'user', content: 'this is a personal preference' }], { cwd: '/x' })
    expect(out[0]?.scope).toBe('folder:/x')
  })
  it('treats blank strings and list-less objects as empty', () => {
    expect(normalizeFacts('', { cwd: '/x' })).toEqual([])
    expect(normalizeFacts('   ', { cwd: '/x' })).toEqual([])
    expect(normalizeFacts({ foo: 1 }, { cwd: '/x' })).toEqual([])
    expect(normalizeFacts(null, { cwd: '/x' })).toEqual([])
    expect(normalizeFacts(42, { cwd: '/x' })).toEqual([])
  })
  it('accepts an items array payload and a JSON array string', () => {
    expect(normalizeFacts({ items: [{ content: 'via items' }] }, { cwd: '/x' }))
      .toEqual([{ scope: 'folder:/x', content: 'via items' }])
    expect(normalizeFacts('[{"content":"via json array"}]', { cwd: '/x' }))
      .toEqual([{ scope: 'folder:/x', content: 'via json array' }])
  })
})

describe('countMessages', () => {
  it('counts user/assistant events', () => {
    const agent = makeAgent('/x', [
      { type: 'user/message' },
      { type: 'assistant/message' },
      { type: 'tool/result' },
      { type: 'user/message' },
    ])
    expect(countMessages(agent)).toEqual({ user: 2, assistant: 1 })
  })
  it('returns zeros when events missing', () => {
    expect(countMessages(makeAgent('/x'))).toEqual({ user: 0, assistant: 0 })
  })
  it('returns zeros when events is not an array', () => {
    const agent = makeAgent('/x')
    ;(agent.session as { events: unknown }).events = 'bogus'
    expect(countMessages(agent)).toEqual({ user: 0, assistant: 0 })
  })
})

describe('buildExtractPrompt', () => {
  it('mentions the workspace folder', () => {
    const text = buildExtractPrompt(makeAgent('E:\\ws'))
    expect(text).toContain('workspace: E:\\ws')
  })
  it('mentions the project name derived from the cwd basename', () => {
    const text = buildExtractPrompt(makeAgent('E:\\ws\\starhub'))
    expect(text).toContain('project: starhub')
  })
  it('marks blank sessions', () => {
    expect(buildExtractPrompt(makeAgent())).toContain('workspace: <none>')
    expect(buildExtractPrompt(makeAgent())).toContain('project: <none>')
  })
})

describe('projectNameOf', () => {
  it('takes the last path segment as the project name', () => {
    expect(projectNameOf('E:\\ws\\starhub')).toBe('starhub')
    expect(projectNameOf('/home/dev/starhub/')).toBe('starhub')
    expect(projectNameOf('C:\\x')).toBe('x')
    expect(projectNameOf('')).toBe('')
  })
})

describe('writeFact', () => {
  it('invokes the transport with the expected payload', async () => {
    const request = vi.fn(async () => ({ row: { id: 'r1' } }))
    await writeFact({ request } as unknown as JsonRpcTransportPeer, {
      scope: 'folder:/x', content: 'preference',
    })
    expect(request).toHaveBeenCalledWith(MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'preference',
    })
  })
  it('is a no-op without transport', async () => {
    const request = vi.fn()
    await writeFact(undefined, { scope: 'global', content: 'x' })
    expect(request).not.toHaveBeenCalled()
  })
  it('swallows transport errors', async () => {
    const request = vi.fn(async () => { throw new Error('bridge down') })
    await expect(writeFact({ request } as unknown as JsonRpcTransportPeer, {
      scope: 'global', content: 'x',
    })).resolves.toBeUndefined()
  })
  it('swallows a write that exceeds the 2s budget', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(() => new Promise<never>(() => {}))
      const writePromise = writeFact({ request } as unknown as JsonRpcTransportPeer, {
        scope: 'global', content: 'x',
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(writePromise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('persistExtractedFacts', () => {
  it('persists each normalized fact', async () => {
    const request = vi.fn(async () => ({}))
    const out = await persistExtractedFacts(
      { request } as unknown as JsonRpcTransportPeer,
      makeAgent('/x'),
      [{ content: 'a' }, { content: 'b' }],
    )
    expect(out).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(1, MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'a',
    })
  })
})

describe('runTurnReview', () => {
  it('skips when autoReview disabled', async () => {
    const llm = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: new AbortController().signal,
      transport: undefined,
      llm,
      autoReviewEnabled: false,
      route: ROUTE,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('skips when below message gate', async () => {
    const llm = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [{ type: 'user/message' }, { type: 'assistant/message' }]),
      signal: new AbortController().signal,
      transport: undefined,
      llm,
      autoReviewEnabled: true,
      route: ROUTE,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('skips when signal already aborted', async () => {
    const llm = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: controller.signal,
      transport: undefined,
      llm,
      autoReviewEnabled: true,
      route: ROUTE,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('skips when llm extractor missing', async () => {
    const request = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: new AbortController().signal,
      transport: { request } as unknown as JsonRpcTransportPeer,
      llm: undefined,
      autoReviewEnabled: true,
      route: ROUTE,
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('skips when the memory model route is missing (v0.94.0 hard gate)', async () => {
    const llm = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: new AbortController().signal,
      transport: undefined,
      llm,
      autoReviewEnabled: true,
      route: undefined,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('runs the full pipeline when enabled and gated', async () => {
    const request = vi.fn(async () => ({}))
    const llm = vi.fn(async () => ({ facts: [{ content: 'persisted' }] }))
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: new AbortController().signal,
      transport: { request } as unknown as JsonRpcTransportPeer,
      llm,
      autoReviewEnabled: true,
      route: ROUTE,
    })
    expect(llm).toHaveBeenCalledOnce()
    expect(llm).toHaveBeenCalledWith(expect.objectContaining({ route: ROUTE }))
    expect(request).toHaveBeenCalledWith(MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'persisted',
    })
  })
  it('swallows LLM errors and does not write', async () => {
    const request = vi.fn()
    const llm = vi.fn(async () => { throw new Error('boom') })
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: new AbortController().signal,
      transport: { request } as unknown as JsonRpcTransportPeer,
      llm,
      autoReviewEnabled: true,
      route: ROUTE,
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('swallows an extraction that exceeds the 6s budget', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn()
      const llm = vi.fn(() => new Promise<never>(() => {}))
      const reviewPromise = runTurnReview({
        agent: makeAgent('/x', [
          { type: 'user/message' }, { type: 'assistant/message' },
          { type: 'user/message' }, { type: 'assistant/message' },
        ]),
        signal: new AbortController().signal,
        transport: { request } as unknown as JsonRpcTransportPeer,
        llm,
        autoReviewEnabled: true,
        route: ROUTE,
      })
      await vi.advanceTimersByTimeAsync(6_000)
      await expect(reviewPromise).resolves.toBeUndefined()
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('logs non-Error LLM failures by their string form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const llm = vi.fn(async () => { throw 'plain failure' })
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'user/message' }, { type: 'assistant/message' },
        { type: 'user/message' }, { type: 'assistant/message' },
      ]),
      signal: new AbortController().signal,
      transport: undefined,
      llm,
      autoReviewEnabled: true,
      route: ROUTE,
    })
    expect(warn).toHaveBeenCalledWith('[starhub-memory-sink] turn review failed:', 'plain failure')
    warn.mockRestore()
  })
})

describe('wireLlmExtractor', () => {
  const ctxWith = (services: Record<string, unknown>): Context =>
    ({ get: (serviceName: string) => services[serviceName] }) as unknown as Context

  it('returns undefined without a usable llm service', () => {
    expect(wireLlmExtractor(ctxWith({}))).toBeUndefined()
    expect(wireLlmExtractor(ctxWith({ llm: null }))).toBeUndefined()
    expect(wireLlmExtractor(ctxWith({ llm: 'nope' }))).toBeUndefined()
    expect(wireLlmExtractor(ctxWith({ llm: {} }))).toBeUndefined()
    expect(wireLlmExtractor(ctxWith({ llm: { stream: 1 } }))).toBeUndefined()
  })

  it('streams through the given route and returns assembled text', async () => {
    const { stream } = streamingLlm('{"facts":[{"content":"kept"}]}')
    const extractor = wireLlmExtractor(ctxWith({ llm: { stream } }))
    expect(extractor).toBeDefined()
    const signal = new AbortController().signal
    const out = await extractor!({ route: ROUTE, system: 's', prompt: 'p', signal })
    expect(out).toBe('{"facts":[{"content":"kept"}]}')
    expect(stream).toHaveBeenCalledOnce()
    const options = stream.mock.calls[0]![0] as { provider: string; model: string; system: string; messages: unknown[] }
    expect(options.provider).toBe('mem-provider')
    expect(options.model).toBe('mem-model')
    expect(options.system).toBe('s')
    // An already-aborted signal rejects before stream is called.
    const aborted = new AbortController()
    aborted.abort()
    await expect(extractor!({ route: ROUTE, system: 's', prompt: 'p', signal: aborted.signal }))
      .rejects.toThrow('aborted')
    // An abort mid-flight rejects the pending stream consumption.
    const slow = wireLlmExtractor(ctxWith({
      llm: { stream: (_options: unknown) => (async function * () { yield await new Promise<never>(() => {}) })() },
    }))!
    const controller = new AbortController()
    const pending = slow({ route: ROUTE, system: 's', prompt: 'p', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  it('surfaces a non-stop finish as a failure', async () => {
    const stream = vi.fn(() => (async function * () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider down' } } } as const
    })())
    const extractor = wireLlmExtractor(ctxWith({ llm: { stream } }))!
    await expect(extractor({ route: ROUTE, system: 's', prompt: 'p', signal: new AbortController().signal }))
      .rejects.toThrow('provider down')
  })
})

describe('apply (turn-stopping hook)', () => {
  type TurnStoppingListener = (payload: { agent: unknown; signal: AbortSignal }) => Promise<void>

  function makeSinkCtx(services: Record<string, unknown>, namespaceValue: unknown) {
    const listeners: TurnStoppingListener[] = []
    const ctx = {
      get: (serviceName: string) => services[serviceName],
      on: (_event: string, listener: TurnStoppingListener) => {
        listeners.push(listener)
        return () => undefined
      },
      effect: (callback: () => unknown) => callback(),
      settings: {
        get: () => namespaceValue,
        // memory-context 已注册该 namespace;再 register 即 duplicate-registration
        // 硬失败(v0.92.2 组合事故),这里让 register 抛错以断言本插件不再调用它。
        register: () => { throw new Error('settings namespace "starhub-memory-context" is already registered') },
      },
    } as unknown as Context
    return { ctx, listeners }
  }

  const busyAgent = () => makeAgent('/x', [
    { type: 'user/message' }, { type: 'assistant/message' },
    { type: 'user/message' }, { type: 'assistant/message' },
  ])

  it('runs the review pipeline when autoReview and the memory route are on', async () => {
    const request = vi.fn(async () => ({}))
    const { stream } = streamingLlm('{"facts":[{"content":"kept"}]}')
    const { ctx, listeners } = makeSinkCtx(
      { 'sdk-transport': { request }, llm: { stream } },
      { autoReview: true, memoryProvider: 'mem-provider', memoryModel: 'mem-model' },
    )
    apply(ctx)
    expect(listeners).toHaveLength(1)
    await listeners[0]!({ agent: busyAgent(), signal: new AbortController().signal })
    expect(stream).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'kept',
    })
  })

  it('skips auto-distill when autoReview is on but the memory route is missing (v0.94.0)', async () => {
    const request = vi.fn(async () => ({}))
    const { stream } = streamingLlm('{"facts":[{"content":"kept"}]}')
    const { ctx, listeners } = makeSinkCtx(
      { 'sdk-transport': { request }, llm: { stream } },
      { autoReview: true },
    )
    apply(ctx)
    await listeners[0]!({ agent: busyAgent(), signal: new AbortController().signal })
    expect(stream).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('skips the review when the namespace never opted in (default off)', async () => {
    const request = vi.fn(async () => ({}))
    const { stream } = streamingLlm('{"facts":[{"content":"kept"}]}')
    const { ctx, listeners } = makeSinkCtx(
      { 'sdk-transport': { request }, llm: { stream } },
      undefined,
    )
    apply(ctx)
    await listeners[0]!({ agent: busyAgent(), signal: new AbortController().signal })
    expect(stream).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('reads the memory-context namespace without re-registering it (v0.92.2 collision)', async () => {
    const request = vi.fn(async () => ({}))
    const { stream } = streamingLlm('{"facts":[{"content":"kept"}]}')
    const { ctx, listeners } = makeSinkCtx(
      { 'sdk-transport': { request }, llm: { stream } },
      { autoReview: true, memoryProvider: 'mem-provider', memoryModel: 'mem-model' },
    )
    // memory-context 已注册该 namespace:register 再被调用即抛,apply 不得调用它。
    expect(() => apply(ctx)).not.toThrow()
    await listeners[0]!({ agent: busyAgent(), signal: new AbortController().signal })
    expect(stream).toHaveBeenCalledOnce()
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
    expect(registered).toEqual(['@deepseek-ai/dsh-starhub-memory-sink'])
    // The companion is intentionally empty: no runtime invariant to assert.
    installers[0]!()
    expect(dispose).toBeTypeOf('function')
  })
})
