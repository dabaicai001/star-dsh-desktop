/**
 * Workbench API: the HTTP/SSE seat that replaces the Tauri IPC bridge for the
 * standalone React workbench (去 Tauri 化 M1;StarHub-local package).
 *
 * The React workbench (`apps/starhub-window`, served by `starhub-host-static`
 * under `/starhub-react/`) used to call `window.__TAURI_INTERNALS__.invoke`
 * and listen on Tauri events. In the standalone composition there is no Tauri
 * shell, so the same two faces ride the bridge's own routes:
 *
 * - `POST /starhub/api/invoke` `{cmd, args}` → `{ok:true,result}` /
 *   `{ok:false,error}`; `cmd` is a sidecar method name (the Tauri command
 *   names mirror the sidecar method names for the domains that moved).
 * - `GET /starhub/api/events` — Server-Sent Events stream carrying every
 *   sidecar notification under its original event name (`ssh:exec-done`,
 *   `sftp://transfer-progress`, `starhub://open-asset`, …), so a workbench
 *   listener keeps the event names it already uses.
 *
 * Both routes are same-origin under the dsh web server (loopback +
 * trustedHosts policy), so the workbench reuses the host page's session
 * without extra authorization plumbing. Commands the sidecar does not
 * implement answer `{ok:false,error}` — the workbench renders its
 * preview/error state, the same degradation a missing Tauri IPC produced.
 *
 * @module @deepseek-ai/dsh-starhub-bridge/workbench
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

/** Route prefix for the workbench API (distinct from the `/starhub-react` assets). */
export const WORKBENCH_API_PREFIX = '/starhub/api'

/** Exact route for a command invocation. */
export const INVOKE_ROUTE = `${WORKBENCH_API_PREFIX}/invoke`

/** Exact route for the Server-Sent Events stream. */
export const EVENTS_ROUTE = `${WORKBENCH_API_PREFIX}/events`

/**
 * Method prefix for the sidecar's UI plane (M2).
 *
 * The workbench speaks the retired Tauri command names; the sidecar registers
 * them under `ui.<command>` so the UI plane can never collide with the model
 * tool surface (same resource, different parameters — e.g. `sftp_list`).
 */
export const UI_METHOD_PREFIX = 'ui.'

/** Map one workbench command name to its sidecar method. */
export function uiMethod(cmd: string): string {
  return `${UI_METHOD_PREFIX}${cmd}`
}

/** Maximum accepted request body for one invocation (bytes). */
const MAX_INVOKE_BODY_BYTES = 1024 * 1024

/** Read and JSON-parse a bounded request body; rejects on oversize or bad JSON. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_INVOKE_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Write one JSON response and end it. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Build the `POST /starhub/api/invoke` handler.
 * @param sidecar - live sidecar transport.
 * @returns the node:http request handler.
 */
export function invokeHandler(
  sidecar: JsonRpcTransportPeer,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : ''
    if (cmd === '') {
      sendJson(res, 400, { ok: false, error: 'cmd is required' })
      return
    }
    const args = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as object
    try {
      const result = await sidecar.request(uiMethod(cmd), args)
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      // 未实现的命令 / sidecar 报错:软错误给工作台(与 Tauri IPC 缺失同款降级)。
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** One connected SSE client. */
interface EventClient {
  readonly write: (frame: string) => void
  readonly close: () => void
}

/**
 * Build the `GET /starhub/api/events` SSE handler.
 *
 * The handler owns the response for the connection's lifetime: it registers a
 * broadcaster on the dispatcher, emits a comment on connect (so proxies flush
 * headers), and unregisters on close.
 *
 * @param subscribe - subscribes one broadcaster to every sidecar notification
 *   (the dispatcher's `attach` seam) and returns its disposer.
 * @returns the node:http request handler.
 */
export function eventsHandler(
  subscribe: (broadcast: (event: string, payload: unknown) => void) => () => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': starhub bridge connected\n\n')
    const client: EventClient = {
      write: (frame: string) => {
        if (!res.writableEnded) res.write(frame)
      },
      close: () => {
        if (!res.writableEnded) res.end()
      },
    }
    const dispose = subscribe((event: string, payload: unknown) => {
      const data = JSON.stringify(payload ?? {})
      // 事件名原样透传(工作台监听的名字不变);data 单行 JSON。
      client.write(`event: ${event}\ndata: ${data}\n\n`)
    })
    const onClose = (): void => {
      dispose()
      client.close()
    }
    req.on('close', onClose)
    res.on('close', onClose)
  }
}
