/**
 * StarHub commit message:请求体校验、消息帧、HTTP handler 状态机。
 */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMIT_MESSAGE_PATH, createHandler, frameRequest, parseRequestBody,
  type CommitMessageDeps,
} from '../src/index.ts'

const CONFIG = { maxInputBytes: 1024, maxOutputTokens: 512, timeoutMs: 30_000 }

function makeDeps(message = 'feat: add thing'): CommitMessageDeps & { generate: ReturnType<typeof vi.fn> } {
  return {
    resolveRoute: () => ({ provider: 'p', model: 'm' }),
    generate: vi.fn(async () => message),
  }
}

function makeRequest(method: string, body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  ;(stream as unknown as { method: string }).method = method
  return stream as IncomingMessage
}

interface CapturedResponse {
  readonly status: number
  readonly body: string
}

function makeResponse() {
  const captured: { status: number; body: string } = { status: 0, body: '' }
  const res = {
    writeHead: (status: number) => { captured.status = status },
    end: (body?: string) => { captured.body = body ?? '' },
  } as unknown as ServerResponse
  return { res, captured: captured as CapturedResponse }
}

async function invoke(deps: CommitMessageDeps, req: IncomingMessage, config = CONFIG) {
  const { res, captured } = makeResponse()
  await createHandler(deps, config)(req, res)
  return captured
}

describe('parseRequestBody', () => {
  it('accepts a well-formed summary', () => {
    const parsed = parseRequestBody({ status: ' M a.ts', diffStat: ' a.ts | 2 +-', recentSubjects: ['fix: x'] })
    expect(parsed.status).toBe(' M a.ts')
    expect(parsed.recentSubjects).toEqual(['fix: x'])
  })

  it('rejects non-object, missing fields, and blank status', () => {
    expect(() => parseRequestBody(null)).toThrow('JSON')
    expect(() => parseRequestBody({ status: 1, diffStat: '', recentSubjects: [] })).toThrow('字段')
    expect(() => parseRequestBody({ status: '', diffStat: '', recentSubjects: [] })).toThrow('没有改动')
    expect(() => parseRequestBody({ status: 'M a', diffStat: '', recentSubjects: [1] })).toThrow('字段')
  })
})

describe('frameRequest', () => {
  it('frames the summary as JSON so user text cannot break delimiters', () => {
    const framed = frameRequest({ status: '?? a.ts', diffStat: '', recentSubjects: ['feat: y'] })
    expect(framed).toContain('?? a.ts')
    expect(framed).toContain('feat: y')
    expect(JSON.parse(framed.slice(framed.indexOf('{')))).toMatchObject({ status: '?? a.ts' })
  })
})

describe('createHandler', () => {
  it('returns the drafted message on success', async () => {
    const deps = makeDeps('  feat: add thing  ')
    const out = await invoke(deps, makeRequest('POST', JSON.stringify({
      status: ' M a.ts', diffStat: ' a.ts | 2 +-', recentSubjects: [],
    })))
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toEqual({ message: 'feat: add thing' })
    expect(deps.generate).toHaveBeenCalledOnce()
  })

  it('rejects non-POST with 405', async () => {
    const out = await invoke(makeDeps(), makeRequest('GET'))
    expect(out.status).toBe(405)
  })

  it('rejects invalid bodies with 400 and oversized bodies with 413', async () => {
    expect((await invoke(makeDeps(), makeRequest('POST', 'not json'))).status).toBe(400)
    expect((await invoke(makeDeps(), makeRequest('POST', JSON.stringify({
      status: '  ', diffStat: '', recentSubjects: [],
    })))).status).toBe(400)
    const huge = JSON.stringify({ status: 'x'.repeat(2048), diffStat: '', recentSubjects: [] })
    expect((await invoke(makeDeps(), makeRequest('POST', huge), { ...CONFIG, maxInputBytes: 64 })).status).toBe(413)
  })

  it('maps generation failure and empty output to 502', async () => {
    const failing: CommitMessageDeps = {
      resolveRoute: () => ({ provider: 'p', model: 'm' }),
      generate: async () => { throw new Error('provider down') },
    }
    const body = JSON.stringify({ status: ' M a.ts', diffStat: '', recentSubjects: [] })
    const failed = await invoke(failing, makeRequest('POST', body))
    expect(failed.status).toBe(502)
    expect((JSON.parse(failed.body) as { error: string }).error).toContain('provider down')
    const empty = await invoke(makeDeps('   '), makeRequest('POST', body))
    expect(empty.status).toBe(502)
  })
})

describe('apply wiring', () => {
  it('claims the exact route on the web server', async () => {
    const { apply } = await import('../src/index.ts')
    const register = vi.fn(() => () => undefined)
    const ctx = {
      webServer: { register },
      effect: (callback: () => unknown) => callback(),
    } as unknown as Parameters<typeof apply>[0]
    apply(ctx, { ...CONFIG })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: COMMIT_MESSAGE_PATH }))
  })

  it('rejects a half-specified fixed route', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = {
      webServer: { register: vi.fn() },
      effect: (callback: () => unknown) => callback(),
    } as unknown as Parameters<typeof apply>[0]
    expect(() =>{  apply(ctx, { ...CONFIG, provider: 'p' }) }).toThrow('together')
  })
})
