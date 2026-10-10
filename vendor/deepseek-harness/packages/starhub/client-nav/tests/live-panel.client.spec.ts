// @vitest-environment jsdom
/**
 * 壳内直播/接管通道簿(去 Tauri 化 M3):开通道 / 同通道聚焦(换令牌)/ 激活 /
 * 关通道的语义,以及「没有宿主时不开面板」的预览降级。
 *
 * 通道簿与工作台页簿同一套心智:同通道重复开不开第二份 WS,关当前通道时激活
 * 余下最后开的一条,关未知通道幂等。令牌是一次性的,因此「聚焦已开通道」
 * 必须换上新令牌——旧令牌已被上一次握手消费。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLivePanelStore,
  installLivePanelHost,
  openAndroidLive,
  type LiveChannel,
} from '../src/client/live/live-panel.ts'
import { hostBridgeCalls, restoreHostBridge, stubHostBridge } from './host-bridge.ts'

/** 一条直播通道(令牌由 sidecar 的 ui.live_open 签发)。 */
function channel(id: string, token = `t${id}`, label = id): LiveChannel {
  return { channel: `android:${id}`, kind: 'android', token, label }
}

/** `android_ui_open_live` 的成功应答信封(sidecar M3 方法面)。 */
function liveOpenAnswer(id: string, token: string): Record<string, unknown> {
  return {
    endpoint: 'ws://127.0.0.1:52377',
    token,
    channel: { channel: `android:${id}`, kind: 'android', mode: 'frames', width: 0, height: 0, error: null },
  }
}

describe('live panel store', () => {
  it('opens a channel and marks it connecting', () => {
    const store = createLivePanelStore()
    store.open(channel('s1', 'tok-1'))
    const state = store.source.getSnapshot()
    expect(state.channels.map((entry) => entry.channel)).toEqual(['android:s1'])
    expect(state.activeChannel).toBe('android:s1')
    expect(state.status).toBe('connecting')
  })

  it('re-opening an open channel focuses it and swaps the one-time token', () => {
    const store = createLivePanelStore()
    store.open(channel('s1', 'old-token'))
    store.open(channel('s2', 'tok-2'))
    store.open(channel('s1', 'new-token'))
    const state = store.source.getSnapshot()
    expect(state.channels.map((entry) => entry.channel), '不开第二份').toEqual(['android:s1', 'android:s2'])
    expect(state.activeChannel, '重复 open = 聚焦').toBe('android:s1')
    expect(state.channels[0]?.token, '旧令牌已被上一次握手消费').toBe('new-token')
  })

  it('activate only switches to an open channel', () => {
    const store = createLivePanelStore()
    store.open(channel('s1'))
    store.open(channel('s2'))
    store.activate('android:s1')
    expect(store.source.getSnapshot().activeChannel).toBe('android:s1')
    store.activate('android:ghost')
    expect(store.source.getSnapshot().activeChannel, '未开的通道不改当前通道').toBe('android:s1')
  })

  it('closing the active channel activates the last remaining one', () => {
    const store = createLivePanelStore()
    store.open(channel('s1'))
    store.open(channel('s2'))
    store.open(channel('s3'))
    store.close('android:s3')
    let state = store.source.getSnapshot()
    expect(state.channels.map((entry) => entry.channel)).toEqual(['android:s1', 'android:s2'])
    expect(state.activeChannel, '关当前通道 → 余下最后开的一条').toBe('android:s2')
    store.close('android:s1')
    state = store.source.getSnapshot()
    expect(state.activeChannel, '关非当前通道:当前通道不动').toBe('android:s2')
  })

  it('closing the last channel empties the book and resets the frame state', () => {
    const store = createLivePanelStore()
    store.open(channel('s1'))
    store.setMeta({ mode: 'scrcpy', width: 1080, height: 2400 })
    store.setTakeover(true)
    store.close('android:s1')
    const state = store.source.getSnapshot()
    expect(state.channels).toEqual([])
    expect(state.activeChannel).toBeNull()
    expect(state.status).toBe('idle')
    expect(state.mode).toBe('frames')
    expect(state.width).toBe(0)
    expect(state.takeover).toBe(false)
  })

  it('closing an unknown channel is a no-op', () => {
    const store = createLivePanelStore()
    store.open(channel('s1'))
    store.close('android:ghost')
    const state = store.source.getSnapshot()
    expect(state.channels.map((entry) => entry.channel)).toEqual(['android:s1'])
  })

  it('meta updates only overwrite the members the frame carries', () => {
    const store = createLivePanelStore()
    store.open(channel('s1'))
    store.setMeta({ mode: 'scrcpy', width: 1080, height: 2400 })
    store.setMeta({ error: 'scrcpy-server 资源缺失' })
    const state = store.source.getSnapshot()
    expect(state.mode, '未带的成员保持原值').toBe('scrcpy')
    expect(state.width).toBe(1080)
    expect(state.error).toBe('scrcpy-server 资源缺失')
    store.setMeta({ error: null })
    expect(store.source.getSnapshot().error).toBeNull()
  })

  it('refreshToken mints a fresh one-time token for the active channel', async () => {
    stubHostBridge((cmd, args) => {
      if (cmd === 'live_token') return { token: `fresh-${String(args.channel)}` }
      throw new Error(`unexpected ${cmd}`)
    })
    const store = createLivePanelStore()
    store.open(channel('s1', 'consumed'))
    await store.refreshToken()
    expect(store.source.getSnapshot().channels[0]?.token).toBe('fresh-android:s1')
    expect(hostBridgeCalls()).toEqual([{ cmd: 'live_token', args: { channel: 'android:s1' } }])
  })
})

describe('openAndroidLive', () => {
  beforeEach(() => {
    installLivePanelHost(null)
  })

  afterEach(() => {
    installLivePanelHost(null)
    restoreHostBridge()
  })

  it('opens the channel and hands it to the installed host', async () => {
    stubHostBridge(() => liveOpenAnswer('s1', 'tok-1'))
    const opened: LiveChannel[] = []
    installLivePanelHost((entry) => { opened.push(entry) })
    const result = await openAndroidLive('s1', 'Pixel 7')
    expect(result.channel).toBe('android:s1')
    expect(result.token).toBe('tok-1')
    expect(result.label).toBe('Pixel 7')
    expect(opened).toHaveLength(1)
    expect(hostBridgeCalls()).toEqual([{ cmd: 'android_ui_open_live', args: { serial: 's1' } }])
  })

  it('falls back to the serial when the sidecar omits the label', async () => {
    stubHostBridge(() => liveOpenAnswer('s1', 'tok-1'))
    const result = await openAndroidLive('s1', '')
    expect(result.label).toBe('s1')
  })

  it('rejects when the sidecar answers without a token', async () => {
    stubHostBridge(() => ({ channel: { channel: 'android:s1' } }))
    await expect(openAndroidLive('s1', 'Pixel 7')).rejects.toThrow('直播通道未返回一次性令牌')
  })

  it('propagates the sidecar error verbatim', async () => {
    stubHostBridge(() => { throw new Error('设备 serial 非法: "bad serial"') })
    await expect(openAndroidLive('bad serial', 'x')).rejects.toThrow('设备 serial 非法')
  })

  it('without a host (browser preview) it still opens the sidecar channel', async () => {
    stubHostBridge(() => liveOpenAnswer('s1', 'tok-1'))
    const result = await openAndroidLive('s1', 'Pixel 7')
    expect(result.channel).toBe('android:s1')
    expect(hostBridgeCalls()).toHaveLength(1)
  })
})
