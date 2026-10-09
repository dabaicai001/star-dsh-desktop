// @vitest-environment jsdom
/**
 * `starhub://open-asset` 监听(host-events.ts 的 open-asset 半):一律按
 * focusWindowByKey 聚焦已有窗口(ssh 资产也是独立窗口,不再是壳内
 * overlay),找不到才 openAssetPage;未知资产触发刷新并丢弃请求。另覆盖
 * subscribeHostEvents 的注册/卸载与 dispose 竞态(事件走共享 SSE 连接)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStarHubAssets, type RustAsset } from '../src/client/store.ts'
import type { StarHubAsset } from '../src/client/sections.ts'
import {
  createOpenAssetHandler, subscribeHostEvents, type OpenAssetPayload,
} from '../src/client/host-events.ts'
import {
  emitHostEvent, hostEventListeners, restoreHostBridge, restoreHostEvents, stubHostBridge, stubHostEvents,
} from './host-bridge.ts'

/** 构造一个最小资产。 */
function rustAsset(id: string, type: string, config: Record<string, unknown> = {}): RustAsset {
  return {
    id, type, name: id, group_id: null, config,
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  restoreHostBridge()
  restoreHostEvents()
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

  /** 事件订阅已不走 invoke(共享 SSE 连接);任何 invoke 调用都是意外。 */
  function stubInvoke() {
    return vi.fn((cmd: string) => Promise.reject(new Error(`unexpected command: ${cmd}`)))
  }

  it('registers both listeners, delivers payloads and stops delivering after dispose', async () => {
    const invoke = stubInvoke()
    stubHostBridge(invoke)
    stubHostEvents()
    const onOpenAsset = vi.fn()
    const onAskAi = vi.fn()
    const dispose = subscribeHostEvents({ onOpenAsset, onAskAi })
    // 两个事件名各订阅一次(共享 SSE 连接按事件名 addEventListener)。
    await vi.waitFor(() => {
      expect(hostEventListeners(OPEN_EVENT)).toBe(1)
      expect(hostEventListeners(ASK_EVENT)).toBe(1)
    })
    const openPayload: OpenAssetPayload = { assetId: 'a1', tool: 'auto', action: 'open' }
    emitHostEvent(OPEN_EVENT, openPayload)
    emitHostEvent(ASK_EVENT, { text: '看看日志' })
    expect(onOpenAsset).toHaveBeenCalledWith(openPayload)
    expect(onAskAi).toHaveBeenCalledWith({ text: '看看日志' })
    // 让两个 listen promise 的 then 全部落定(offs 已推入),dispose 的
    // 循环体才会真正执行退订。
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    dispose()
    // dispose 后 handler 从扇出表移除:再派发不再送达(替代旧 unlisten 断言)。
    emitHostEvent(OPEN_EVENT, openPayload)
    emitHostEvent(ASK_EVENT, { text: '再来' })
    expect(onOpenAsset).toHaveBeenCalledTimes(1)
    expect(onAskAi).toHaveBeenCalledTimes(1)
  })

  it('disposes an in-flight listen without leaking the subscription', async () => {
    const invoke = stubInvoke()
    stubHostBridge(invoke)
    stubHostEvents()
    const onOpenAsset = vi.fn()
    const onAskAi = vi.fn()
    const dispose = subscribeHostEvents({ onOpenAsset, onAskAi })
    // 立即卸载:监听 promise 落定后直接退订,不保留订阅
    dispose()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    emitHostEvent(OPEN_EVENT, { assetId: 'a1', action: 'open' })
    emitHostEvent(ASK_EVENT, { text: 'x' })
    expect(onOpenAsset).not.toHaveBeenCalled()
    expect(onAskAi).not.toHaveBeenCalled()
  })
})
