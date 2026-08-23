/**
 * StarHub session registry(联动契约 §2.1/§5):快照整体替换语义、线边界校验、
 * 插件接线(订阅 + provide + 卸载)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionRegistry, apply } from '../src/index.ts'

const SNAPSHOT = {
  sessions: [
    { assetId: 'a1', sessionId: 's1', kind: 'ssh', attachedBy: ['shell'] },
    { assetId: 'a2', sessionId: 's2', kind: 'db', attachedBy: ['db-panel', 'ai'] },
  ],
}

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

describe('SessionRegistry', () => {
  it('starts empty and answers no asset', () => {
    const registry = new SessionRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.forAsset('a1')).toBeUndefined()
  })

  it('replaces the view wholesale from a full snapshot', () => {
    const registry = new SessionRegistry()
    registry.replace(SNAPSHOT)

    expect(registry.list()).toEqual(SNAPSHOT.sessions)
    expect(registry.forAsset('a1')).toEqual(SNAPSHOT.sessions[0])
    expect(registry.forAsset('a2')).toMatchObject({ sessionId: 's2', kind: 'db' })
    expect(registry.forAsset('missing')).toBeUndefined()
  })

  it('drops assets absent from the next full snapshot', () => {
    const registry = new SessionRegistry()
    registry.replace(SNAPSHOT)
    registry.replace({ sessions: [{ assetId: 'a2', sessionId: 's2', kind: 'db', attachedBy: [] }] })

    expect(registry.list()).toEqual([{ assetId: 'a2', sessionId: 's2', kind: 'db', attachedBy: [] }])
    expect(registry.forAsset('a1')).toBeUndefined()
  })

  it('keeps the current view when the frame is not an object with a sessions array', () => {
    const registry = new SessionRegistry()
    registry.replace(SNAPSHOT)

    registry.replace(null)
    registry.replace('nonsense')
    registry.replace({})
    registry.replace({ sessions: 'not-an-array' })

    expect(registry.list()).toEqual(SNAPSHOT.sessions)
  })

  it('skips malformed entries without dropping the valid ones', () => {
    const registry = new SessionRegistry()
    const cases: unknown[] = [
      null,
      42,
      {},
      { assetId: '', sessionId: 's', kind: 'ssh', attachedBy: [] },
      { assetId: 'a', sessionId: '', kind: 'ssh', attachedBy: [] },
      { assetId: 'a', sessionId: 's', kind: 'ftp', attachedBy: [] },
      { assetId: 'a', sessionId: 's', kind: 'ssh', attachedBy: 'shell' },
      { assetId: 'a', sessionId: 's', kind: 'ssh', attachedBy: ['shell', 7] },
    ]
    registry.replace({
      sessions: [
        ...cases,
        { assetId: 'ok', sessionId: 's-ok', kind: 'sftp', attachedBy: ['panel'] },
      ],
    })

    expect(registry.list()).toEqual([{ assetId: 'ok', sessionId: 's-ok', kind: 'sftp', attachedBy: ['panel'] }])
  })

  it('detaches the returned attachedBy array from the caller', () => {
    const registry = new SessionRegistry()
    const attachedBy = ['shell']
    registry.replace({ sessions: [{ assetId: 'a1', sessionId: 's1', kind: 'ssh', attachedBy }] })
    attachedBy.push('ai')

    expect(registry.forAsset('a1')?.attachedBy).toEqual(['shell'])
  })
})

describe('starhub-session-registry plugin apply', () => {
  it('subscribes to registry.sync, provides the service, and replaces on delivery', () => {
    const { handlers, subscribe } = makeHub()
    const { ctx, provided, provide } = makeCtx({ subscribe })

    apply(ctx)

    expect(provide).toHaveBeenCalledWith('starhub-session-registry', expect.any(SessionRegistry))
    expect(subscribe).toHaveBeenCalledWith('starhub/registry.sync', expect.any(Function))
    const registry = provided['starhub-session-registry'] as SessionRegistry
    expect(registry.list()).toEqual([])

    const handler = handlers.get('starhub/registry.sync')
    expect(handler).toBeDefined()
    handler?.(SNAPSHOT)
    expect(registry.list()).toEqual(SNAPSHOT.sessions)
  })

  it('disposes the subscription with the fiber effect', () => {
    const { handlers, subscribe } = makeHub()
    const { ctx, effect } = makeCtx({ subscribe })
    apply(ctx)

    // The fake effect invokes the callback and returns its cleanup disposer.
    const cleanup = effect.mock.results[0]?.value as (() => void) | undefined
    expect(typeof cleanup).toBe('function')

    const handler = handlers.get('starhub/registry.sync')
    expect(handler).toBeDefined()
    cleanup?.()
    expect(handlers.has('starhub/registry.sync')).toBe(false)
  })

  it('fails loud when sdk-notifications is missing from the composition', () => {
    const { ctx } = makeCtx(undefined)

    expect(() =>{  apply(ctx) }).toThrow(
      'starhub-session-registry requires sdk-jsonrpc-server (sdk-notifications service) in the same composition',
    )
  })
})
