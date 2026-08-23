// @vitest-environment jsdom
/**
 * `starhub://open-asset` 监听(host-events.ts 的 open-asset 半):一律按
 * focusWindowByKey 聚焦已有 webview 窗口(ssh 资产也是独立窗口,不再是壳内
 * overlay),找不到才 openAssetPage;未知资产触发刷新并丢弃请求。另覆盖
 * subscribeHostEvents 的注册/卸载与 dispose 竞态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStarHubAssets, type RustAsset } from '../src/client/store.ts'
import type { StarHubAsset } from '../src/client/sections.ts'
import {
  createOpenAssetHandler, subscribeHostEvents, type OpenAssetPayload,
} from '../src/client/host-events.ts'

/** 构造一个最小资产。 */
function rustAsset(id: string, type: string, config: Record<string, unknown> = {}): RustAsset {
  return {
    id, type, name: id, group_id: null, config,
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }
}

/** 带 transformCallback 的完整 internals stub:按事件名注册回调并手动触发。 */
function stubFullInternals(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: (cb: unknown, once?: boolean) => number }
  }
  const prev = w.__TAURI_INTERNALS__
  let nextId = 1
  const registered = new Map<number, (envelope: { event: string; id: number; payload: unknown }) => void>()
  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: unknown) => {
      const id = nextId
      nextId += 1
      registered.set(id, cb as typeof registered extends Map<number, infer V> ? V : never)
      return id
    },
  }
  return {
    restore: () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of registered.values()) cb({ event, id: 0, payload })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('createOpenAssetHandler', () => {
  function harness(assets: ReturnType<typeof createStarHubAssets>, focusWindow: (key: string) => Promise<boolean>) {
    const openAssetPage = vi.fn<(asset: StarHubAsset) => void>()
    const handler = createOpenAssetHandler({ assets, openAssetPage, focusWindow })
    return { openAssetPage, handler }
  }

  it('opens the asset page on action=open', () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'db')], loading: false, error: null, preview: false })
    const focusWindow = vi.fn(() => Promise.resolve(false))
    const { openAssetPage, handler } = harness(assets, focusWindow)
    handler({ assetId: 'a1', tool: 'auto', action: 'open' })
    expect(openAssetPage).toHaveBeenCalledTimes(1)
    expect(openAssetPage.mock.calls[0]![0].id).toBe('a1')
    expect(focusWindow).not.toHaveBeenCalled()
  })

  it('focus resolves to an existing webview window without opening a page', async () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'ssh', { host: 'h' })], loading: false, error: null, preview: false })
    const focusWindow = vi.fn(() => Promise.resolve(true))
    const { openAssetPage, handler } = harness(assets, focusWindow)
    handler({ assetId: 'a1', tool: 'auto', action: 'focus' })
    await Promise.resolve()
    expect(focusWindow).toHaveBeenCalledWith('a1')
    expect(openAssetPage).not.toHaveBeenCalled()
  })

  it('focus without a matching window opens the asset page', async () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'ssh')], loading: false, error: null, preview: false })
    const focusWindow = vi.fn(() => Promise.resolve(false))
    const { openAssetPage, handler } = harness(assets, focusWindow)
    handler({ assetId: 'a1', action: 'focus' })
    await vi.waitFor(() =>{  expect(openAssetPage).toHaveBeenCalledTimes(1) })
    expect(focusWindow).toHaveBeenCalledWith('a1')
  })

  it('drops the request and refreshes the list when the asset is unknown', () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [], loading: false, error: null, preview: false })
    const refresh = vi.spyOn(assets, 'refresh')
    const focusWindow = vi.fn(() => Promise.resolve(false))
    const { openAssetPage, handler } = harness(assets, focusWindow)
    handler({ assetId: 'nope', tool: 'auto', action: 'open' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(openAssetPage).not.toHaveBeenCalled()
    expect(focusWindow).not.toHaveBeenCalled()
  })
})

describe('subscribeHostEvents', () => {
  const OPEN_EVENT = 'starhub://open-asset'
  const ASK_EVENT = 'starhub://ask-ai'

  function stubInvoke(eventIds: Record<string, number>) {
    return vi.fn((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'plugin:event|listen') {
        return Promise.resolve(eventIds[String(args?.event)] ?? -1)
      }
      if (cmd === 'plugin:event|unlisten') return Promise.resolve(null)
      return Promise.reject(new Error(`unexpected command: ${cmd}`))
    })
  }

  it('registers both listeners, delivers payloads and unlistens on dispose', async () => {
    const invoke = stubInvoke({ [OPEN_EVENT]: 41, [ASK_EVENT]: 42 })
    const stub = stubFullInternals(invoke)
    try {
      const onOpenAsset = vi.fn()
      const onAskAi = vi.fn()
      const dispose = subscribeHostEvents({ onOpenAsset, onAskAi })
      await vi.waitFor(() => {
        expect(invoke.mock.calls.filter(c => c[0] === 'plugin:event|listen')).toHaveLength(2)
      })
      const openPayload: OpenAssetPayload = { assetId: 'a1', tool: 'auto', action: 'open' }
      stub.emit(OPEN_EVENT, openPayload)
      stub.emit(ASK_EVENT, { text: '看看日志' })
      expect(onOpenAsset).toHaveBeenCalledWith(openPayload)
      expect(onAskAi).toHaveBeenCalledWith({ text: '看看日志' })
      // 让两个 listen promise 的 then 全部落定(offs 已推入),dispose 的
      // 循环体才会真正执行 unlisten。
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      dispose()
      // unlisten 经微任务落定(dispose 后监听 promise 的 then 才推入 offs)
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: OPEN_EVENT, eventId: 41 })
        expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: ASK_EVENT, eventId: 42 })
      })
    } finally {
      stub.restore()
    }
  })

  it('disposes an in-flight listen without leaking the subscription', async () => {
    const invoke = stubInvoke({ [OPEN_EVENT]: 1, [ASK_EVENT]: 2 })
    const stub = stubFullInternals(invoke)
    try {
      const dispose = subscribeHostEvents({ onOpenAsset: vi.fn(), onAskAi: vi.fn() })
      // 立即卸载:监听 promise 落定后直接 unlisten,不保留订阅
      dispose()
      await vi.waitFor(() => {
        const unlistens = invoke.mock.calls.filter(c => c[0] === 'plugin:event|unlisten')
        expect(unlistens.length).toBeGreaterThanOrEqual(2)
      })
      const unlistens = invoke.mock.calls.filter(c => c[0] === 'plugin:event|unlisten')
      expect(unlistens.some(c => (c[1] as { event: string }).event === OPEN_EVENT)).toBe(true)
      expect(unlistens.some(c => (c[1] as { event: string }).event === ASK_EVENT)).toBe(true)
    } finally {
      stub.restore()
    }
  })
})
