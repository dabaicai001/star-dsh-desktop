/**
 * Live/takeover frame channel: the WebSocket seat between the dsh GUI panel and
 * the sidecar's local frame server (去 Tauri 化 M3;StarHub-local module).
 *
 * The retired Tauri shell served the live view from a custom protocol
 * (`android-live://` / `obscura-live://`) inside a `WebviewWindow`. The dsh
 * Electron shell has no such window, so the frame channel rides the host's own
 * WebSocket upgrade route instead:
 *
 * ```text
 * 壳内面板 ──ws://<host>/starhub/live?channel=…&token=…──▶ 本模块
 *                                                          │  raw byte relay
 *                                                          ▼
 *                        ws://127.0.0.1:<port>/live/<channel>?token=…  (sidecar)
 * ```
 *
 * The relay is a **transparent byte pipe** after each side's own handshake.
 * WebSocket masking is directional (client→server masked, server→client not),
 * so forwarding bytes verbatim keeps both sides RFC-compliant — no frame
 * decoding, no re-encoding, and no WebSocket library dependency in this
 * package. The bridge therefore only owns the two handshakes:
 *
 * - it answers the browser's upgrade with `Sec-WebSocket-Accept` derived from
 *   the browser's own `Sec-WebSocket-Key`;
 * - it opens its own upgrade to the sidecar with a freshly generated key and
 *   verifies the sidecar answered `101`.
 *
 * Authorization is the sidecar's **one-time token**: it is minted by
 * `ui.live_open`, consumed by the sidecar at its own handshake, and never
 * logged or echoed. A wrong or reused token is rejected by the sidecar, which
 * closes the upstream socket; the relay then closes the browser socket. The
 * channel id is validated here against the same shape the sidecar enforces, so
 * a malformed value fails before any socket is opened.
 *
 * @module @deepseek-ai/dsh-starhub-bridge/live
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** Exact upgrade route the host serves for the frame channel. */
export const LIVE_UPGRADE_ROUTE = '/starhub/live'

/** Path prefix the sidecar's frame server serves (must match `starhub-live`). */
export const LIVE_PATH_PREFIX = '/live/'

/** WebSocket handshake magic GUID (RFC 6455 §1.3). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Channel kinds the sidecar registers (must match `starhub-live`). */
const CHANNEL_KINDS = ['android', 'browser', 'desktop'] as const

/**
 * One-time token shape: `uuid` simple form (32 lowercase hex).
 *
 * The sidecar mints tokens with `Uuid::new_v4().simple()`, so the value is
 * percent-encoding-free by construction. Validating the shape here lets the
 * relay put both members into the upstream URL verbatim — the sidecar parses
 * its path without decoding, so encoding would break the match.
 */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** Upstream connect + handshake budget (the sidecar is a local process). */
const UPSTREAM_TIMEOUT_MS = 5000

/** One parsed upgrade request. */
interface LiveRequest {
  readonly channel: string
  readonly token: string
}

/**
 * Validate the channel id shape (`<kind>:<target>`).
 *
 * Mirrors the sidecar's whitelist: the id reaches the sidecar's URL path, so a
 * rejection here is the first line of defence, not the only one.
 *
 * @param channel - candidate channel id.
 * @returns whether the sidecar would accept the shape.
 */
export function validChannelId(channel: string): boolean {
  const separator = channel.indexOf(':')
  if (separator <= 0 || separator === channel.length - 1) return false
  const kind = channel.slice(0, separator)
  const target = channel.slice(separator + 1)
  if (!(CHANNEL_KINDS as readonly string[]).includes(kind)) return false
  if (target.length > 96) return false
  return /^[A-Za-z0-9._:-]+$/.test(target)
}

/**
 * Read the `channel` and `token` query members of an upgrade request URL.
 *
 * @param url - raw request target (path plus query).
 * @returns the parsed pair, or `null` when either member is missing.
 */
export function parseLiveRequest(url: string | undefined): LiveRequest | null {
  if (url === undefined) return null
  const queryAt = url.indexOf('?')
  if (queryAt === -1) return null
  let channel = ''
  let token = ''
  for (const pair of url.slice(queryAt + 1).split('&')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const key = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    if (key === 'channel') channel = value
    else if (key === 'token') token = value
  }
  if (channel === '' || token === '') return null
  return { channel, token }
}

/** Compute `Sec-WebSocket-Accept` for a client key (RFC 6455 §1.3). */
function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** Reject one upgrade: answer an HTTP status, then drop the socket. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
}

/**
 * Build the `/starhub/live` upgrade handler.
 *
 * @param getEndpoint - resolves the sidecar's current frame endpoint. Called per
 *   connection so a sidecar that started its frame server after the bridge (or
 *   restarted it) is still reachable; implementations may memoize.
 * @param log - diagnostics sink for refused relays (never carries the token).
 * @returns the node:http upgrade handler for `registerUpgrade`.
 */
export function liveUpgradeHandler(
  getEndpoint: () => Promise<string | null>,
  log: (message: string) => void = () => {},
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    void relay(req, socket, head, getEndpoint, log).catch(() => {
      // relay 自己收尾每条失败路径;这里只兜住未预期异常,绝不让它变成
      // 未捕获拒绝杀死宿主进程。
      rejectUpgrade(socket, 502, 'Bad Gateway')
    })
  }
}

/** Relay one upgrade: validate, handshake both sides, pipe bytes. */
async function relay(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  getEndpoint: () => Promise<string | null>,
  log: (message: string) => void,
): Promise<void> {
  const parsed = parseLiveRequest(req.url)
  if (parsed === null) {
    rejectUpgrade(socket, 400, 'Bad Request')
    return
  }
  if (!validChannelId(parsed.channel) || !TOKEN_PATTERN.test(parsed.token)) {
    log(
      `live relay refused: malformed request for ${JSON.stringify(parsed.channel)}`,
    )
    rejectUpgrade(socket, 400, 'Bad Request')
    return
  }
  const endpoint = await getEndpoint()
  if (endpoint === null) {
    log(`live relay refused: sidecar frame server unavailable for ${parsed.channel}`)
    rejectUpgrade(socket, 503, 'Service Unavailable')
    return
  }
  const clientKey = req.headers['sec-websocket-key']
  if (typeof clientKey !== 'string' || clientKey === '') {
    rejectUpgrade(socket, 400, 'Bad Request')
    return
  }

  const upstream = await openUpstream(endpoint, parsed)
  if (upstream === null) {
    // sidecar 拒绝(令牌无效/已用/通道已关):101 缺失翻译成对浏览器可见的关闭
    log(`live relay refused by sidecar for ${parsed.channel}`)
    rejectUpgrade(socket, 502, 'Bad Gateway')
    return
  }
  const link = upstream.socket

  // 浏览器侧握手应答:accept 由浏览器自己的 key 推导,与上游无关
  if (socket.destroyed) {
    link.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-accept: ${acceptKey(clientKey)}\r\n\r\n`,
  )
  // 两个方向的「握手前已到达字节」必须分开送:head 是浏览器侧的帧(去上游),
  // pending 是上游与 101 同段的帧(来浏览器)。混在一起会把协议方向搞反。
  if (head.length > 0) link.write(head)
  if (upstream.pending.length > 0) socket.write(upstream.pending)

  // 透明转发:masking 方向性保证两端都合规,不需要解帧
  socket.on('data', chunk => {
    if (!link.destroyed) link.write(chunk)
  })
  link.on('data', chunk => {
    if (!socket.destroyed) socket.write(chunk)
  })
  const closeBoth = (): void => {
    if (!socket.destroyed) socket.destroy()
    if (!link.destroyed) link.destroy()
  }
  socket.on('error', closeBoth)
  link.on('error', closeBoth)
  socket.on('close', closeBoth)
  link.on('close', closeBoth)
}

/** An upstream socket whose handshake is consumed, plus bytes that arrived with it. */
interface UpstreamLink {
  readonly socket: Socket
  /** Frame bytes that shared the handshake's TCP segment, to forward verbatim. */
  readonly pending: Buffer
}

/**
 * Open the upstream WebSocket to the sidecar and complete its handshake.
 *
 * @param endpoint - sidecar frame endpoint.
 * @param request - validated channel and token.
 * @returns the connected link with the handshake consumed, or `null` when the
 *   sidecar refused.
 */
async function openUpstream(
  endpoint: string,
  request: LiveRequest,
): Promise<UpstreamLink | null> {
  const target = new URL(endpoint)
  const port = target.port === '' ? 80 : Number(target.port)
  // 两侧都不做百分号编码:channel 已过白名单、token 是 hex,原样进 URL 才能与
  // sidecar 的「不解码直接取路径」对上。
  const path = `${LIVE_PATH_PREFIX}${request.channel}?token=${request.token}`
  const key = randomBytes(16).toString('base64')

  return new Promise<UpstreamLink | null>(resolve => {
    const upstream = connect({ host: target.hostname, port })
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      upstream.destroy()
      resolve(null)
    }
    const timer = setTimeout(fail, UPSTREAM_TIMEOUT_MS)
    timer.unref?.()
    const done = (value: UpstreamLink | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    upstream.once('error', fail)
    upstream.on('connect', () => {
      upstream.write(
        `GET ${path} HTTP/1.1\r\n` +
          `host: ${target.hostname}:${port}\r\n` +
          'upgrade: websocket\r\n' +
          'connection: Upgrade\r\n' +
          `sec-websocket-key: ${key}\r\n` +
          'sec-websocket-version: 13\r\n\r\n',
      )
    })

    // 消费 101 响应头;与响应同段的帧字节由调用方原样转发(不 unshift:那会让
    // 流的 flowing 状态在握手期间反复翻转,反而难推理)
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const boundary = buffered.indexOf('\r\n\r\n')
      if (boundary === -1) {
        if (buffered.length > 64 * 1024) fail()
        return
      }
      const header = buffered.subarray(0, boundary).toString('latin1')
      const statusLine = header.split('\r\n')[0] ?? ''
      upstream.off('data', onData)
      upstream.removeListener('error', fail)
      if (!statusLine.includes(' 101 ')) {
        fail()
        return
      }
      done({ socket: upstream, pending: buffered.subarray(boundary + 4) })
    }
    upstream.on('data', onData)
  })
}
