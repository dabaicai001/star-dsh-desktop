// @vitest-environment jsdom
/**
 * 共享宿主桥 seam(tauri.ts,去 Tauri 化 M2):`POST /starhub/api/invoke`
 * 路由({ok:true,result} 解包 / {ok:false,error} reject / 非 2xx reject)、
 * args 缺省不带 args 键、共享 SSE 连接的事件扇出与 dispose、openNewPage
 * 装了壳内页宿主时走面板(不 window.open)、没装时退化为新窗口与被拦截、
 * focusWindowByKey 有无 BroadcastChannel。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  focusWindowByKey, installWorkbenchPageHost, isTauriRuntime, openNewPage, starhubPageLabelPrefix, tauriInvoke, tauriListen,
} from '../src/client/tauri.ts'
import {
  emitHostEvent, hostBridgeCalls, hostEventListeners, restoreHostBridge, restoreHostEvents, stubHostBridge, stubHostEvents,
} from './host-bridge.ts'

afterEach(() => {
  restoreHostBridge()
  restoreHostEvents()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('tauriInvoke', () => {
  it('posts {cmd, args} to the invoke endpoint and unwraps {ok:true,result}', async () => {
    stubHostBridge((cmd, args) => {
      expect(cmd).toBe('broker_overview')
      expect(args).toEqual({ kind: 'kafka', params: { host: 'h' } })
      return { ok: true }
    })
    await expect(tauriInvoke('broker_overview', { kind: 'kafka', params: { host: 'h' } }))
      .resolves.toEqual({ ok: true })
    expect(hostBridgeCalls()).toEqual([
      { cmd: 'broker_overview', args: { kind: 'kafka', params: { host: 'h' } } },
    ])
  })

  it('omits the args key when no args are given', async () => {
    const original = globalThis.fetch
    let requestUrl = ''
    let requestMethod = ''
    let sent: Record<string, unknown> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestMethod = init?.method ?? ''
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ ok: true, result: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    try {
      await expect(tauriInvoke('audit_stats')).resolves.toBeNull()
      expect(requestUrl).toBe('/starhub/api/invoke')
      expect(requestMethod).toBe('POST')
      expect(sent).toEqual({ cmd: 'audit_stats' })
      expect('args' in sent).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })

  it('rejects with the bridge error message on {ok:false,error}', async () => {
    stubHostBridge(() => Promise.reject(new Error('boom')))
    await expect(tauriInvoke('broker_overview')).rejects.toThrow('boom')
  })

  it('rejects when the host bridge responds non-2xx', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof globalThis.fetch
    try {
      await expect(tauriInvoke('broker_overview')).rejects.toThrow('host bridge unavailable (503)')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('tauriListen', () => {
  it('subscribes on the shared SSE connection under the event name', async () => {
    stubHostEvents()
    expect(hostEventListeners('ssh:kb-interactive:t1')).toBe(0)
    const off = await tauriListen<string>('ssh:kb-interactive:t1', () => {})
    expect(hostEventListeners('ssh:kb-interactive:t1')).toBe(1)
    await off()
    expect(hostEventListeners('ssh:kb-interactive:t1')).toBe(0)
  })

  it('fans one shared SSE connection out to every handler of the event name', async () => {
    stubHostEvents()
    const seenA: string[] = []
    const seenB: string[] = []
    const offA = await tauriListen<string>('ssh:kb-interactive:t1', payload => { seenA.push(payload) })
    const offB = await tauriListen<string>('ssh:kb-interactive:t1', payload => { seenB.push(payload) })
    expect(hostEventListeners('ssh:kb-interactive:t1')).toBe(1)
    emitHostEvent('ssh:kb-interactive:t1', 'code?')
    expect(seenA).toEqual(['code?'])
    expect(seenB).toEqual(['code?'])
    await offA()
    emitHostEvent('ssh:kb-interactive:t1', 'again')
    expect(seenA).toEqual(['code?'])
    expect(seenB).toEqual(['code?', 'again'])
    await offB()
  })

  it('stops delivering after dispose even before the connection is established', async () => {
    stubHostEvents()
    const seen: string[] = []
    const off = await tauriListen<string>('e', payload => { seen.push(payload) })
    await off()
    emitHostEvent('e', 'x')
    expect(seen).toEqual([])
  })

  it('ignores frames whose data is not JSON', async () => {
    stubHostEvents()
    const seen: unknown[] = []
    await tauriListen('e', payload => { seen.push(payload) })
    // JSON.stringify(undefined) 不产出字符串,data 非 JSON(心跳/注释帧形态)
    emitHostEvent('e', undefined)
    expect(seen).toEqual([])
  })
})

describe('openNewPage', () => {
  it('routes to the in-shell page host when one is installed (no window.open)', async () => {
    const opened: Array<[string, string, string]> = []
    installWorkbenchPageHost((path, title, key) => { opened.push([path, title, key]) })
    const openSpy = vi.spyOn(window, 'open')
    try {
      await openNewPage('/starhub-react/index.html?asset=a1&workbench=ssh', '验收机', 'a1')
    } finally {
      installWorkbenchPageHost(null)
    }
    expect(opened).toEqual([['/starhub-react/index.html?asset=a1&workbench=ssh', '验收机', 'a1']])
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('clearing the host restores the window.open fallback', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({}) as Window)
    await openNewPage('/starhub-react/index.html?asset=a1', 'web-1', 'a1')
    const [opened, target, features] = openSpy.mock.calls[0] as [URL, string, string]
    expect(opened).toBeInstanceOf(URL)
    expect(String(opened)).toBe(
      `${window.location.origin}/starhub-react/index.html?asset=a1`,
    )
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')
  })

  it('throws when window.open is intercepted (popup blocked)', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null)
    await expect(openNewPage('/starhub-react/index.html?asset=a1', 'web-1')).rejects.toThrow('window.open intercepted')
  })
})

describe('focusWindowByKey', () => {
  it('broadcasts the key on the starhub-focus channel', async () => {
    const posted: unknown[] = []
    const closed: string[] = []
    class FakeBroadcastChannel {
      constructor(readonly name: string) {}
      postMessage(message: unknown): void { posted.push(message) }
      close(): void { closed.push(this.name) }
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    await expect(focusWindowByKey('a1')).resolves.toBe(true)
    expect(posted).toEqual([{ key: 'a1' }])
    expect(closed).toEqual(['starhub-focus'])
  })

  it('returns false without BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    await expect(focusWindowByKey('a1')).resolves.toBe(false)
  })
})

describe('starhubPageLabelPrefix', () => {
  it('renders the keyed prefix once', () => {
    expect(starhubPageLabelPrefix('a1')).toBe('starhub-page-a1-')
  })
})

describe('isTauriRuntime', () => {
  it('reports whether a host with fetch is reachable', () => {
    expect(isTauriRuntime()).toBe(true)
    const original = globalThis.fetch
    Reflect.deleteProperty(globalThis, 'fetch')
    try {
      expect(isTauriRuntime()).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })
})
