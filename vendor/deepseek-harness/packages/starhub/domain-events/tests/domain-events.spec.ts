/**
 * StarHub domain events(联动契约 §1/§2.1/§5):环形缓冲、线边界校验、
 * 按 ts 倒序查询、插件接线(订阅 + provide + 卸载)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DomainEventStore, apply } from '../src/index.ts'

function makeHub() {
  const handlers = new Map<string, (params: unknown) => void>()
  const subscribe = vi.fn((method: string, handler: (params: unknown) => void) => {
    handlers.set(method, handler)
    return () => { handlers.delete(method) }
  })
  return { handlers, subscribe }
}

function makeCtx(hub: unknown) {
  const provided: Record<string, unknown> = {}
  const provide = vi.fn((serviceName: string, value: unknown) => { provided[serviceName] = value })
  const effect = vi.fn((callback: () => (() => void) | undefined) => callback())
  const ctx = {
    get: (serviceName: string) => serviceName === 'sdk-notifications' ? hub : undefined,
    provide,
    effect,
  } as unknown as Context
  return { ctx, provided, provide, effect }
}

describe('DomainEventStore', () => {
  it('starts empty for any query', () => {
    const store = new DomainEventStore()
    expect(store.recent()).toEqual([])
    expect(store.recent('a1')).toEqual([])
  })

  it('stores an event with an asset id in its own bucket', () => {
    const store = new DomainEventStore()
    const event = { kind: 'ssh.exec_completed', assetId: 'a1', ts: 100, summary: 'ran ls' }
    store.push(event)

    expect(store.recent('a1')).toEqual([{ ...event, origin: 'user' }])
    expect(store.recent('a2')).toEqual([])
  })

  it('stores an event without an asset id in the global bucket', () => {
    const store = new DomainEventStore()
    const event = { kind: 'session.attached', ts: 100, summary: 'shell attached' }
    store.push(event)

    expect(store.recent('a1')).toEqual([])
    expect(store.recent()).toEqual([{ ...event, origin: 'user' }])
  })

  it('normalizes origin: omitted and unknown become user, ai stays ai', () => {
    const store = new DomainEventStore()
    store.push({ kind: 'k', ts: 1, summary: 'no origin' })
    store.push({ kind: 'k', ts: 2, summary: 'ai origin', origin: 'ai' })
    store.push({ kind: 'k', ts: 3, summary: 'bogus origin', origin: 'bogus' })

    expect(store.recent()).toEqual([
      expect.objectContaining({ ts: 3, origin: 'user' }),
      expect.objectContaining({ ts: 2, origin: 'ai' }),
      expect.objectContaining({ ts: 1, origin: 'user' }),
    ])
  })

  it('preserves the domain payload verbatim', () => {
    const store = new DomainEventStore()
    store.push({ kind: 'db.query_executed', assetId: 'a9', ts: 5, summary: 'query', data: { rowCount: 12 } })

    expect(store.recent('a9')[0]?.data).toEqual({ rowCount: 12 })
  })

  it('drops frames missing or malformed in kind, ts, summary, or assetId', () => {
    const store = new DomainEventStore()
    const invalid = [
      null,
      'nonsense',
      {},
      { kind: '', ts: 1, summary: 'x' },
      { kind: 'k', ts: 1 },
      { kind: 'k', summary: 'x' },
      { kind: 'k', ts: '1', summary: 'x' },
      { kind: 'k', ts: Number.NaN, summary: 'x' },
      { kind: 'k', ts: 1, summary: '' },
      { kind: 'k', ts: 1, summary: 7 },
      { kind: 'k', assetId: '', ts: 1, summary: 'x' },
      { kind: 'k', assetId: 9, ts: 1, summary: 'x' },
    ]
    for (const frame of invalid) store.push(frame)

    expect(store.recent()).toEqual([])
  })

  it('keeps only the newest 50 events per asset (ring buffer)', () => {
    const store = new DomainEventStore()
    for (let index = 1; index <= 55; index += 1) {
      store.push({ kind: 'ssh.exec_completed', assetId: 'a1', ts: index, summary: `run ${index}` })
    }

    const recent = store.recent('a1', 100)
    expect(recent).toHaveLength(50)
    expect(recent[0]?.summary).toBe('run 55')
    expect(recent.at(-1)?.summary).toBe('run 6')
  })

  it('returns events newest-first across the global bucket and every asset', () => {
    const store = new DomainEventStore()
    store.push({ kind: 'g1', ts: 30, summary: 'global 30' })
    store.push({ kind: 'a1-100', assetId: 'a1', ts: 100, summary: 'a1 100' })
    store.push({ kind: 'a2-50', assetId: 'a2', ts: 50, summary: 'a2 50' })
    store.push({ kind: 'g1-10', ts: 10, summary: 'global 10' })

    expect(store.recent().map(event => event.summary)).toEqual([
      'a1 100',
      'a2 50',
      'global 30',
      'global 10',
    ])
  })

  it('applies the limit with the default of 10 and floors non-integer limits', () => {
    const store = new DomainEventStore()
    for (let ts = 1; ts <= 15; ts += 1) {
      store.push({ kind: 'k', ts, summary: `s${ts}` })
    }

    expect(store.recent()).toHaveLength(10)
    expect(store.recent(undefined, 3).map(event => event.ts)).toEqual([15, 14, 13])
    expect(store.recent(undefined, 0)).toEqual([])
    expect(store.recent(undefined, -1)).toEqual([])
    expect(store.recent(undefined, Number.NaN)).toEqual([])
    expect(store.recent(undefined, 3.9).map(event => event.ts)).toEqual([15, 14, 13])
    expect(store.recent(undefined, 100)).toHaveLength(15)
  })

  it('returns a defensive copy that cannot corrupt the buffer', () => {
    const store = new DomainEventStore()
    store.push({ kind: 'k', ts: 2, summary: 'two' })
    store.push({ kind: 'k', ts: 1, summary: 'one' })

    const view = store.recent()
    view.length = 0
    expect(store.recent()).toHaveLength(2)
  })
})

describe('starhub-domain-events plugin apply', () => {
  it('subscribes to domain.event, provides the service, and pushes on delivery', () => {
    const { handlers, subscribe } = makeHub()
    const { ctx, provided, provide } = makeCtx({ subscribe })

    apply(ctx)

    expect(provide).toHaveBeenCalledWith('starhub-domain-events', expect.any(DomainEventStore))
    expect(subscribe).toHaveBeenCalledWith('starhub/domain.event', expect.any(Function))
    const store = provided['starhub-domain-events'] as DomainEventStore
    expect(store.recent()).toEqual([])

    const handler = handlers.get('starhub/domain.event')
    expect(handler).toBeDefined()
    handler?.({ kind: 'ssh.exec_completed', assetId: 'a1', ts: 7, summary: 'ran' })
    expect(store.recent('a1')).toEqual([{ kind: 'ssh.exec_completed', assetId: 'a1', ts: 7, summary: 'ran', origin: 'user' }])
  })

  it('disposes the subscription with the fiber effect', () => {
    const { handlers, subscribe } = makeHub()
    const { ctx, effect } = makeCtx({ subscribe })
    apply(ctx)

    const cleanup = effect.mock.results[0]?.value as (() => void) | undefined
    expect(typeof cleanup).toBe('function')
    cleanup?.()
    expect(handlers.has('starhub/domain.event')).toBe(false)
  })

  it('fails loud when sdk-notifications is missing from the composition', () => {
    const { ctx } = makeCtx(undefined)

    expect(() =>{  apply(ctx) }).toThrow(
      'starhub-domain-events requires sdk-jsonrpc-server (sdk-notifications service) in the same composition',
    )
  })
})
