/**
 * StarHub 本地补丁(联动契约 §0/§2.1):sdk-notifications 多路分发器单测。
 * 入站 notification(无 id 帧)按 method 分发给订阅者;未订阅静默;
 * 订阅者异常被隔离,不打断 transport 读循环(由 plugin-apply 的接线测试覆盖)。
 */
import { describe, expect, it, vi } from 'vitest'
import { SdkNotificationDispatcher } from '../src/notifications.ts'

describe('SdkNotificationDispatcher', () => {
  it('delivers one notification to every subscriber of its method', () => {
    const dispatcher = new SdkNotificationDispatcher()
    const first = vi.fn()
    const second = vi.fn()
    dispatcher.subscribe('starhub/registry.sync', first)
    dispatcher.subscribe('starhub/registry.sync', second)

    const params = { sessions: [] }
    dispatcher.dispatch('starhub/registry.sync', params)

    expect(first).toHaveBeenCalledExactlyOnceWith(params)
    expect(second).toHaveBeenCalledExactlyOnceWith(params)
  })

  it('drops notifications for methods without subscribers', () => {
    const dispatcher = new SdkNotificationDispatcher()
    const handler = vi.fn()
    dispatcher.subscribe('starhub/domain.event', handler)

    expect(() =>{  dispatcher.dispatch('starhub/other.method', {}) }).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  it('isolates a throwing subscriber from siblings and the dispatcher', () => {
    const dispatcher = new SdkNotificationDispatcher()
    const throwing = vi.fn(() => { throw new Error('subscriber failed') })
    const healthy = vi.fn()
    dispatcher.subscribe('starhub/domain.event', throwing)
    dispatcher.subscribe('starhub/domain.event', healthy)

    expect(() =>{  dispatcher.dispatch('starhub/domain.event', { kind: 'x' }) }).not.toThrow()
    expect(healthy).toHaveBeenCalledOnce()
    // A later dispatch still reaches the throwing subscriber's siblings.
    expect(() =>{  dispatcher.dispatch('starhub/domain.event', { kind: 'y' }) }).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(2)
  })

  it('removes exactly one subscription per disposer', () => {
    const dispatcher = new SdkNotificationDispatcher()
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = dispatcher.subscribe('starhub/registry.sync', first)
    dispatcher.subscribe('starhub/registry.sync', second)

    disposeFirst()
    dispatcher.dispatch('starhub/registry.sync', {})

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('releases the method bucket after the last subscriber unsubscribes', () => {
    const dispatcher = new SdkNotificationDispatcher()
    const handler = vi.fn()
    const dispose = dispatcher.subscribe('starhub/registry.sync', handler)

    dispose()
    expect(() =>{  dispatcher.dispatch('starhub/registry.sync', {}) }).not.toThrow()
    expect(handler).not.toHaveBeenCalled()

    // A fresh subscription on the released method works again.
    const replacement = vi.fn()
    dispatcher.subscribe('starhub/registry.sync', replacement)
    dispatcher.dispatch('starhub/registry.sync', { sessions: [] })
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('snapshots subscribers so mid-dispatch disposal does not skip siblings', () => {
    const dispatcher = new SdkNotificationDispatcher()
    const sibling = vi.fn()
    const disposeSibling = dispatcher.subscribe('starhub/registry.sync', sibling)
    const self = vi.fn(() => { disposeSibling() })
    dispatcher.subscribe('starhub/registry.sync', self)

    dispatcher.dispatch('starhub/registry.sync', {})
    // Both ran in the snapshot; the sibling is gone for the next dispatch.
    expect(self).toHaveBeenCalledOnce()
    expect(sibling).toHaveBeenCalledOnce()

    dispatcher.dispatch('starhub/registry.sync', {})
    expect(self).toHaveBeenCalledTimes(2)
    expect(sibling).toHaveBeenCalledOnce()
  })
})
