/**
 * Assistant HTTP/SSE routes (StarHub-local, same-origin under the dsh web
 * server, mirroring the bridge's workbench API envelope `{ok, result|error}`).
 *
 * The SSH assistant panel is a plain React app with no dsh client runtime, so
 * every interaction rides these routes:
 *
 * - `POST /starhub/api/assistant/open`    `{sshSessionId, assetId, assetName}` → `{assistantId, provider, model, reused}`
 * - `POST /starhub/api/assistant/prompt`  `{assistantId, text}`
 * - `POST /starhub/api/assistant/stop`    `{assistantId}`
 * - `POST /starhub/api/assistant/close`   `{assistantId}`
 * - `POST /starhub/api/assistant/model`   `{assistantId, provider, model}`
 * - `POST /starhub/api/assistant/approval` `{assistantId, requestId, outcome}`
 * - `GET  /starhub/api/assistant/models`  provider/model catalog for the picker
 * - `GET  /starhub/api/assistant/stream?assistantId=` SSE frame stream
 *
 * @module @deepseek-ai/dsh-starhub-ssh-assistant/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AssistantRegistry } from './registry.ts'
import { encodeAssistantFrame } from './frames.ts'

/** Route prefix for every assistant route. */
export const ASSISTANT_API_PREFIX = '/starhub/api/assistant'

/** Exact route paths registered on the web server. */
export const ASSISTANT_ROUTES = {
  open: `${ASSISTANT_API_PREFIX}/open`,
  prompt: `${ASSISTANT_API_PREFIX}/prompt`,
  stop: `${ASSISTANT_API_PREFIX}/stop`,
  close: `${ASSISTANT_API_PREFIX}/close`,
  model: `${ASSISTANT_API_PREFIX}/model`,
  approval: `${ASSISTANT_API_PREFIX}/approval`,
  models: `${ASSISTANT_API_PREFIX}/models`,
  stream: `${ASSISTANT_API_PREFIX}/stream`,
  activeConns: `${ASSISTANT_API_PREFIX}/active-conns`,
} as const

/** Maximum accepted request body for one assistant call (bytes). */
const MAX_BODY_BYTES = 1024 * 1024

/** Maximum prompt text length (characters). */
const MAX_PROMPT_CHARS = 32 * 1024

/** One provider row of the model catalog. */
export interface ModelCatalogProvider {
  readonly provider: string
  readonly displayName: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** Model catalog payload for the panel's picker. */
export interface ModelCatalog {
  readonly providers: readonly ModelCatalogProvider[]
}

/** Route dependencies: the registry plus the model catalog reader. */
export interface AssistantRouteDeps {
  readonly registry: AssistantRegistry
  readonly listModels: () => Promise<ModelCatalog>
}

/** JSON envelope every non-stream route answers with. */
type ApiBody = { ok: true; result: unknown } | { ok: false; error: string }

/**
 * Read and JSON-parse a bounded request body.
 * @param req - inbound request.
 * @returns the parsed object; rejects on oversize or malformed JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  // IncomingMessage 的异步迭代面在 @types/node 里是 any;收敛成显式元素类型,
  // 避免 any 顺流进 Buffer 运算(与 bridge workbench.ts 同一读取语义)。
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
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
function sendJson(res: ServerResponse, status: number, body: ApiBody): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(`${JSON.stringify(body)}\n`)
}

/** Required non-empty string field. */
function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

/** Build one JSON route handler from a thin business callback. */
function jsonRoute(
  run: (body: Record<string, unknown>) => Promise<unknown>,
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
    try {
      sendJson(res, 200, { ok: true, result: await run(body) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * `POST .../open` — open or reuse the assistant of one terminal page.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function openHandler(deps: AssistantRouteDeps) {
  return jsonRoute(async body => await deps.registry.open({
    sshSessionId: requiredString(body, 'sshSessionId'),
    assetId: requiredString(body, 'assetId'),
    assetName: requiredString(body, 'assetName'),
  }))
}

/**
 * `POST .../prompt` — queue one user prompt.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function promptHandler(deps: AssistantRouteDeps) {
  return jsonRoute( (body) => {
    const assistantId = requiredString(body, 'assistantId')
    const text = body.text
    if (typeof text !== 'string' || text.trim() === '') throw new Error('text is required')
    if (text.length > MAX_PROMPT_CHARS) throw new Error('text is too long')
    deps.registry.prompt(assistantId, text)
    return Promise.resolve({ accepted: true })
  })
}

/**
 * `POST .../stop` — abort the active turn.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function stopHandler(deps: AssistantRouteDeps) {
  return jsonRoute( (body) => {
    deps.registry.stop(requiredString(body, 'assistantId'))
    return Promise.resolve({ stopped: true })
  })
}

/**
 * `POST .../close` — dispose the assistant and its session.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function closeHandler(deps: AssistantRouteDeps) {
  return jsonRoute( async (body) => {
    await deps.registry.close(requiredString(body, 'assistantId'))
    return { closed: true }
  })
}

/**
 * `POST .../model` — switch the assistant's model route.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function modelHandler(deps: AssistantRouteDeps) {
  return jsonRoute( async (body) => {
    const assistantId = requiredString(body, 'assistantId')
    await deps.registry.setModel(
      assistantId,
      requiredString(body, 'provider'),
      requiredString(body, 'model'),
    )
    return { updated: true }
  })
}

/**
 * `POST .../approval` — settle one parked approval from the panel.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function approvalHandler(deps: AssistantRouteDeps) {
  return jsonRoute( (body) => {
    const assistantId = requiredString(body, 'assistantId')
    const requestId = requiredString(body, 'requestId')
    const outcome = body.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new Error('outcome must be "allowed-once" or "rejected"')
    }
    const settled = deps.registry.submitApproval(assistantId, requestId, outcome)
    if (!settled) throw new Error('审批请求不存在或已处理')
    return Promise.resolve({ settled: true })
  })
}

/**
 * `GET .../models` — the provider/model catalog for the panel's picker.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function modelsHandler(deps: AssistantRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      sendJson(res, 200, { ok: true, result: await deps.listModels() })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * `GET .../active-conns` — AI exec connection ids whose assistant panel is
 * live. The shell connection card consults this so a verification prompt for
 * an assistant-owned connection renders in the panel, not twice.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function activeConnsHandler(deps: AssistantRouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    sendJson(res, 200, { ok: true, result: { conns: deps.registry.activeConns() } })
  }
}

/**
 * `GET .../stream?assistantId=` — the assistant's SSE frame stream.
 *
 * The response head is written before the first frame can leave: the
 * registry's attach replays its event window synchronously, so a single
 * `res.write` ahead of `writeHead` would flush Node's implicit head (no
 * `content-type`) and make the later `writeHead` throw
 * `ERR_HTTP_HEADERS_SENT`. A browser `EventSource` treats a 200 without
 * `text/event-stream` as a fatal error — the panel would show a permanently
 * dropped stream. The handler owns the response for the connection's
 * lifetime: it attaches a frame sink to the registry entry (which immediately
 * replays status + model) and detaches on close.
 * @param deps - route dependencies.
 * @returns the request handler.
 */
export function streamHandler(deps: AssistantRouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const assistantId = new URL(req.url ?? '/', 'http://x').searchParams.get('assistantId') ?? ''
    if (assistantId === '') {
      sendJson(res, 400, { ok: false, error: 'assistantId is required' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': starhub assistant connected\n\n')
    let detach: () => void
    try {
      detach = deps.registry.attach(assistantId, (frame) => {
        if (!res.writableEnded) res.write(encodeAssistantFrame(frame))
      })
    } catch (error) {
      // 响应头已发出:状态码改不了,用 SSE 错误帧告知面板(面板折叠成错误项)。
      if (!res.writableEnded) {
        res.write(encodeAssistantFrame({
          t: 'error',
          message: error instanceof Error ? error.message : String(error),
        }))
        res.end()
      }
      return
    }
    const onClose = (): void => {
      detach()
      if (!res.writableEnded) res.end()
    }
    req.on('close', onClose)
    res.on('close', onClose)
  }
}
