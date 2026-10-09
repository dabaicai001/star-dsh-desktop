/**
 * Live/takeover frame channel relay: the WebSocket seat between the dsh GUI
 * panel and the sidecar's local frame server (去 Tauri 化 M3).
 *
 * The assertions pin the relay's decisions (route shape, query parsing, channel
 * whitelist, handshake outcome) against fakes; the byte pipe itself is exercised
 * end-to-end by `relay.forwards.frames.both.ways`, which runs the real handler
 * against a real loopback WebSocket server and a real WebSocket client — a fake
 * socket would prove nothing about masking or framing.
 */
import { createServer, type Server } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  LIVE_PATH_PREFIX,
  LIVE_UPGRADE_ROUTE,
  liveUpgradeHandler,
  parseLiveRequest,
  validChannelId,
} from '../src/live.ts'

/** RFC 6455 handshake GUID, duplicated here so the fake server stays independent. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A 32-hex one-time token, the shape the sidecar mints. */
const TOKEN = '3e2bfeb71c5941b7907d9daf2c1a5ca5'

/** Build a minimal upgrade request carrying a URL and a client key. */
function upgradeRequest(url: string, key = 'dGhlIHNhbXBsZSBub25jZQ=='): IncomingMessage {
  return { url, headers: { 'sec-websocket-key': key } } as unknown as IncomingMessage
}

/** The upgrade URL the panel opens (channel + one-time token in the query). */
function liveUrl(channel: string, token = TOKEN): string {
  return `/starhub/live?channel=${channel}&token=${token}`
}

/** A duplex that records writes and can be driven from the test. */
function fakeSocket() {
  const written: Buffer[] = []
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(Buffer.from(chunk))
      cb()
    },
  })
  return {
    socket,
    written,
    text: () => Buffer.concat(written).toString('latin1'),
  }
}

describe('route and channel constants', () => {
  it('serves one exact upgrade route under the starhub prefix', () => {
    expect(LIVE_UPGRADE_ROUTE).toBe('/starhub/live')
    expect(LIVE_PATH_PREFIX).toBe('/live/')
  })

  it('accepts only the sidecar channel shapes', () => {
    expect(validChannelId('android:emulator-5554')).toBe(true)
    expect(validChannelId('android:192.168.1.5:43217')).toBe(true)
    expect(validChannelId('android')).toBe(false)
    expect(validChannelId('android:')).toBe(false)
    expect(validChannelId(':x')).toBe(false)
    // M3 定稿:只有 Android 一个帧源(browser / 沙箱桌面由 dsh 原生承接)
    expect(validChannelId('browser:page-1')).toBe(false)
    expect(validChannelId('desktop:inst-1')).toBe(false)
    expect(validChannelId('evil:x')).toBe(false)
    expect(validChannelId('android:a b')).toBe(false)
    expect(validChannelId('android:$(reboot)')).toBe(false)
    expect(validChannelId('android:/etc/passwd')).toBe(false)
    expect(validChannelId(`android:${'a'.repeat(97)}`)).toBe(false)
  })
})

describe('parseLiveRequest', () => {
  it('reads channel and token from the query', () => {
    expect(parseLiveRequest(liveUrl('android:s1'))).toEqual({ channel: 'android:s1', token: TOKEN })
  })

  it('keeps the channel verbatim (the sidecar does not decode its path)', () => {
    expect(parseLiveRequest(liveUrl('android:192.168.1.5:43217'))?.channel).toBe(
      'android:192.168.1.5:43217',
    )
  })

  it('rejects a missing query, a missing member, or no URL', () => {
    expect(parseLiveRequest('/starhub/live')).toBeNull()
    expect(parseLiveRequest('/starhub/live?channel=android:s1')).toBeNull()
    expect(parseLiveRequest('/starhub/live?token=abc')).toBeNull()
    expect(parseLiveRequest(undefined)).toBeNull()
  })
})

describe('liveUpgradeHandler refusals', () => {
  it('answers 400 without a usable channel, token, or client key', async () => {
    const handler = liveUpgradeHandler(async () => 'ws://127.0.0.1:1')
    for (const [url, key] of [
      ['/starhub/live', 'k'],
      [liveUrl('evil:x'), 'k'],
      [liveUrl('android:s1', 'not-hex'), 'k'],
      [liveUrl('android:s1'), ''],
    ] as const) {
      const fake = fakeSocket()
      handler(upgradeRequest(url, key), fake.socket, Buffer.alloc(0))
      await vi.waitFor(() => expect(fake.text()).toContain('HTTP/1.1 400'))
    }
  })

  it('answers 503 when the sidecar has no frame server', async () => {
    const log = vi.fn()
    const handler = liveUpgradeHandler(async () => null, log)
    const fake = fakeSocket()
    handler(upgradeRequest(liveUrl('android:s1')), fake.socket, Buffer.alloc(0))
    await vi.waitFor(() => expect(fake.text()).toContain('HTTP/1.1 503'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('frame server unavailable'))
  })

  it('answers 502 when the sidecar refuses the token', async () => {
    // 端口 1 上没有任何监听方:上游握手必然失败
    const log = vi.fn()
    const handler = liveUpgradeHandler(async () => 'ws://127.0.0.1:1', log)
    const fake = fakeSocket()
    handler(upgradeRequest(liveUrl('android:s1')), fake.socket, Buffer.alloc(0))
    await vi.waitFor(() => expect(fake.text()).toContain('HTTP/1.1 502'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refused by sidecar'))
  })
})

/**
 * 真 loopback 上的端到端中继:一个手写的最小 WS server 充当 sidecar,一个真
 * `net` 客户端充当壳内面板。断言覆盖掩码方向性(客户端帧必须带掩码,服务端帧
 * 不带)与双向字节原样转发——这两点只有跑真实管线才证得动。
 */
describe('relay forwards frames both ways', () => {
  /**
   * 最小 WS server:完成一次 upgrade 握手,之后把收到的每个字节记录为
   * 「上游帧」,并回写一个不掩码的服务端帧(浏览器侧要求服务端帧不带掩码)。
   */
  function fakeSidecarServer(onHandshake?: (header: string) => void) {
    const upstreamFrames: Buffer[] = []
    const server: Server = createServer(socket => {
      let buffered = Buffer.alloc(0)
      let upgraded = false
      socket.on('data', chunk => {
        if (upgraded) {
          upstreamFrames.push(Buffer.from(chunk))
          return
        }
        buffered = Buffer.concat([buffered, chunk])
        const boundary = buffered.indexOf('\r\n\r\n')
        if (boundary === -1) return
        const header = buffered.toString('latin1')
        onHandshake?.(header)
        const key = /sec-websocket-key: (.+)\r\n/.exec(header)?.[1] ?? ''
        const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
        upgraded = true
        buffered = Buffer.alloc(0)
        // 服务端 → 客户端:不掩码(浏览器侧要求),与 101 同段写出
        socket.write(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
            ),
            Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
          ]),
        )
      })
    })
    return { server, upstreamFrames }
  }

  /** 起一个假 sidecar,返回端口与帧记录器。 */
  async function startFakeSidecar(onHandshake?: (header: string) => void) {
    const fake = fakeSidecarServer(onHandshake)
    await new Promise<void>(resolve => fake.server.listen(0, '127.0.0.1', resolve))
    const port = (fake.server.address() as { port: number }).port
    return { port, ...fake }
  }

  it('completes both handshakes and pipes bytes verbatim', async () => {
    const handshakes: string[] = []
    const { server, upstreamFrames, port } = await startFakeSidecar(header => {
      handshakes.push(header)
      expect(header).toContain(`GET /live/android:s1?token=${TOKEN}`)
      expect(header).toContain('sec-websocket-version: 13')
    })

    const handler = liveUpgradeHandler(async () => `ws://127.0.0.1:${port}`)
    const fake = fakeSocket()
    const clientKey = randomBytes(16).toString('base64')
    handler(upgradeRequest(liveUrl('android:s1'), clientKey), fake.socket, Buffer.alloc(0))

    await vi.waitFor(() => expect(handshakes.length).toBe(1))
    await vi.waitFor(() => expect(fake.text()).toContain('HTTP/1.1 101'))
    const expectedAccept = createHash('sha1').update(clientKey + WS_GUID).digest('base64')
    expect(fake.text()).toContain(`sec-websocket-accept: ${expectedAccept}`)

    // 客户端 → 服务端:带掩码的二进制帧(浏览器行为),必须原样到达
    const masked = Buffer.from([0x82, 0x81, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d])
    fake.socket.emit('data', masked)
    await vi.waitFor(() => expect(upstreamFrames.length).toBeGreaterThan(0))
    expect(upstreamFrames[0]).toEqual(masked)

    // 服务端 → 客户端:与 101 同段的不掩码帧已写到浏览器侧
    expect(fake.written.some(chunk => chunk.includes(Buffer.from('hello')))).toBe(true)

    fake.socket.destroy()
    server.close()
  })

  it('forwards the frame that shares the handshake segment', async () => {
    const { server, port } = await startFakeSidecar()
    const handler = liveUpgradeHandler(async () => `ws://127.0.0.1:${port}`)
    const fake = fakeSocket()
    handler(upgradeRequest(liveUrl('android:s1')), fake.socket, Buffer.alloc(0))
    await vi.waitFor(() => expect(fake.text()).toContain('HTTP/1.1 101'))
    // 与上游 101 同段的首帧:中继必须把它送到浏览器侧,而不是丢掉
    await vi.waitFor(() =>
      expect(fake.written.some(chunk => chunk.includes(Buffer.from('hello')))).toBe(true),
    )
    fake.socket.destroy()
    server.close()
  })

  it('forwards the head bytes that arrive with the browser handshake', async () => {
    const { server, upstreamFrames, port } = await startFakeSidecar()
    const handler = liveUpgradeHandler(async () => `ws://127.0.0.1:${port}`)
    const fake = fakeSocket()
    const head = Buffer.from([0x82, 0x81, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])
    handler(upgradeRequest(liveUrl('android:s1')), fake.socket, head)
    await vi.waitFor(() => expect(upstreamFrames.length).toBeGreaterThan(0))
    expect(upstreamFrames[0]).toEqual(head)
    fake.socket.destroy()
    server.close()
  })
})