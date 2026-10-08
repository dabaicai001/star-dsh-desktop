/**
 * Workbench API routes: the HTTP/SSE face that replaces the Tauri IPC bridge
 * for the standalone React workbench.
 *
 * The handlers are exercised against node:http request/response fakes, so the
 * assertions pin the wire contract (status codes, JSON bodies, SSE framing)
 * rather than a browser.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { eventsHandler, EVENTS_ROUTE, invokeHandler, INVOKE_ROUTE, WORKBENCH_API_PREFIX } from '../src/workbench.ts'

/** Minimal IncomingMessage: a readable stream carrying the request body. */
function fakeRequest(method: string, body = ''): IncomingMessage {
  const stream = new PassThrough()
  stream.write(body)
  stream.end()
  return Object.assign(stream, { method }) as unknown as IncomingMessage
}

/** Minimal ServerResponse: records head/body and stays writable until ended. */
function fakeResponse() {
  const chunks: string[] = []
  const emitter = new EventEmitter()
  const res = {
    writableEnded: false,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk)
      if (this.writableEnded) return this
      this.writableEnded = true
      emitter.emit('close')
      return this
    },
    on(event: string, handler: () => void) {
      emitter.on(event, handler)
      return this
    },
    emit(event: string) {
      emitter.emit(event)
      return this
    },
  }
  return {
    res: res as unknown as ServerResponse & { status?: number; headers?: Record<string, string> },
    body: () => chunks.join(''),
  }
}

/** Fake sidecar transport: records requests, answers canned sidecar shapes. */
function fakeSidecar(answers: Record<string, unknown> = {}) {
  const requests: Array<{ method: string; params: object }> = []
  return {
    requests,
    peer: {
      async request(method: string, params: object): Promise<unknown> {
        requests.push({ method, params })
        if (method in answers) return answers[method]
        throw new Error(`method not found: ${method}`)
      },
      notify(): void {},
    },
  }
}

describe('route constants', () => {
  it('keeps the workbench API under its own prefix', () => {
    expect(WORKBENCH_API_PREFIX).toBe('/starhub/api')
    expect(INVOKE_ROUTE).toBe('/starhub/api/invoke')
    expect(EVENTS_ROUTE).toBe('/starhub/api/events')
  })
})

describe('POST /starhub/api/invoke', () => {
  it('maps cmd to a sidecar method and answers {ok:true,result}', async () => {
    const sidecar = fakeSidecar({ starhub_list_assets: { text: '[]' } })
    const { res, body } = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('POST', JSON.stringify({ cmd: 'starhub_list_assets', args: {} })), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(body())).toEqual({ ok: true, result: { text: '[]' } })
    expect(sidecar.requests).toEqual([{ method: 'starhub_list_assets', params: {} }])
  })

  it('passes the args object through and defaults it to {}', async () => {
    const sidecar = fakeSidecar({ ssh_exec: { text: 'ok' } })
    const { res } = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('POST', JSON.stringify({ cmd: 'ssh_exec', args: { command: 'ls' } })), res)
    expect(sidecar.requests[0]?.params).toEqual({ command: 'ls' })
    const second = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('POST', JSON.stringify({ cmd: 'ssh_exec' })), second.res)
    expect(sidecar.requests[1]?.params).toEqual({})
  })

  it('answers {ok:false,error} for a command the sidecar does not implement', async () => {
    const sidecar = fakeSidecar()
    const { res, body } = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('POST', JSON.stringify({ cmd: 'audit_list', args: {} })), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(body())).toEqual({ ok: false, error: 'method not found: audit_list' })
  })

  it('rejects a missing cmd with 400', async () => {
    const sidecar = fakeSidecar()
    const { res, body } = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('POST', JSON.stringify({ args: {} })), res)
    expect(res.status).toBe(400)
    expect(JSON.parse(body())).toMatchObject({ ok: false, error: 'cmd is required' })
  })

  it('rejects a non-object body and an oversized body with 400', async () => {
    const sidecar = fakeSidecar()
    const arrayBody = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('POST', '[1,2]'), arrayBody.res)
    expect(arrayBody.res.status).toBe(400)

    const huge = fakeResponse()
    const request = fakeRequest('POST', JSON.stringify({ cmd: 'x', args: { blob: 'y'.repeat(1024 * 1024 + 16) } }))
    await invokeRoute(sidecar)(request, huge.res)
    expect(huge.res.status).toBe(400)
    expect(JSON.parse(huge.body())).toMatchObject({ error: 'request body too large' })
  })

  it('rejects a non-POST method with 405', async () => {
    const sidecar = fakeSidecar()
    const { res, body } = fakeResponse()
    await invokeRoute(sidecar)(fakeRequest('GET'), res)
    expect(res.status).toBe(405)
    expect(JSON.parse(body())).toEqual({ ok: false, error: 'method not allowed' })
  })
})

describe('GET /starhub/api/events', () => {
  it('streams every sidecar notification under its original event name', async () => {
    let broadcast: ((event: string, params: unknown) => void) | undefined
    const { res, body } = fakeResponse()
    const pending = eventsHandler(installed => {
      broadcast = installed
      return () => {}
    })(fakeRequest('GET'), res)

    expect(res.status).toBe(200)
    expect(res.headers?.['content-type']).toContain('text/event-stream')
    expect(body()).toContain(': starhub bridge connected')

    broadcast?.('ssh:exec-done', { id: 's1' })
    broadcast?.('starhub://open-asset', { assetId: 'a1' })
    expect(body()).toContain('event: ssh:exec-done\ndata: {"id":"s1"}\n\n')
    expect(body()).toContain('event: starhub://open-asset\ndata: {"assetId":"a1"}\n\n')

    // 客户端断开:订阅被摘除,响应结束。
    res.emit?.('close')
    await pending
    expect(res.writableEnded).toBe(true)
  })

  it('rejects a non-GET method with 405', async () => {
    const { res, body } = fakeResponse()
    await eventsHandler(() => () => {})(fakeRequest('POST'), res)
    expect(res.status).toBe(405)
    expect(JSON.parse(body())).toEqual({ ok: false, error: 'method not allowed' })
  })
})

/** Bind the invoke route to one fake sidecar. */
function invokeRoute(sidecar: ReturnType<typeof fakeSidecar>) {
  return invokeHandler(sidecar.peer as never)
}
