/**
 * Bridge compatibility layer: the `starhub/tool.execute` protocol the nine
 * StarHub plugins speak, mapped onto sidecar methods.
 *
 * The fake sidecar records the (method, params) pairs it receives and answers
 * with the shapes the real Rust sidecar produces, so the assertions pin the
 * mapping — not a mock's convenience.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_REQUEST_METHOD,
  BIND_ASSET_METHOD,
  BRIDGE_NOTIFICATIONS_SERVICE,
  BRIDGE_TRANSPORT_SERVICE,
  createBridgePeer,
  EXEC_ABORT_METHOD,
  FOCUS_TOOL_METHOD,
  LIVE_SNAPSHOT_METHOD,
  NotificationDispatcher,
  OPEN_ASSET_METHOD,
  TOOL_EXECUTE_METHOD,
  toolResultText,
} from '../src/compat.ts'

interface Recorded {
  readonly method: string
  readonly params: unknown
}

/** Fake sidecar: records requests, answers with canned sidecar shapes. */
function fakeSidecar(answers: Record<string, unknown> = {}) {
  const requests: Recorded[] = []
  const notifications: Recorded[] = []
  return {
    requests,
    notifications,
    peer: {
      async request(method: string, params: object): Promise<unknown> {
        requests.push({ method, params })
        if (method in answers) return answers[method]
        throw new Error(`method not found: ${method}`)
      },
      notify(method: string, params?: object): void {
        notifications.push({ method, params })
      },
    },
  }
}

describe('bridge peer: starhub/tool.execute', () => {
  it('maps the tool name to the sidecar method and unwraps the text result', async () => {
    const sidecar = fakeSidecar({ ssh_exec: { text: 'total 0\nfile' } })
    const peer = createBridgePeer(sidecar.peer)
    const result = await peer.request(TOOL_EXECUTE_METHOD, {
      sessionId: 's1',
      name: 'ssh_exec',
      args: { command: 'ls' },
    })
    expect(result).toBe('total 0\nfile')
    expect(sidecar.requests).toEqual([
      { method: 'ssh_exec', params: { command: 'ls', sessionId: 's1' } },
    ])
  })

  it('injects the bridge sessionId so the sidecar can resolve the bound asset', async () => {
    const sidecar = fakeSidecar({ ssh_session_status: { text: 'no session' } })
    const peer = createBridgePeer(sidecar.peer)
    await peer.request(TOOL_EXECUTE_METHOD, {
      sessionId: 's1',
      name: 'ssh_session_status',
      args: {},
    })
    // 旧宿主用信封里的 session_id 解析资产;sidecar 从参数里读,故兼容层注入。
    expect(sidecar.requests[0]?.params).toEqual({ sessionId: 's1' })
  })

  it('keeps the model args untouched apart from the injected sessionId', async () => {
    const sidecar = fakeSidecar({ ssh_exec: { text: 'ok' } })
    const peer = createBridgePeer(sidecar.peer)
    await peer.request(TOOL_EXECUTE_METHOD, {
      sessionId: 's1',
      name: 'ssh_exec',
      args: { command: 'ls', timeoutSec: 5 },
    })
    expect(sidecar.requests[0]?.params).toEqual({ command: 'ls', timeoutSec: 5, sessionId: 's1' })
  })

  it('accepts a bare-string sidecar result verbatim', async () => {
    const sidecar = fakeSidecar({ db_query: 'id\n1' })
    const peer = createBridgePeer(sidecar.peer)
    await expect(
      peer.request(TOOL_EXECUTE_METHOD, { sessionId: 's1', name: 'db_query', args: { sql: 'SELECT 1' } }),
    ).resolves.toBe('id\n1')
  })

  it('passes an empty args object when the plugin omits args', async () => {
    const sidecar = fakeSidecar({ ssh_session_status: { text: 'no session' } })
    const peer = createBridgePeer(sidecar.peer)
    await peer.request(TOOL_EXECUTE_METHOD, { sessionId: 's1', name: 'ssh_session_status' })
    expect(sidecar.requests[0]?.params).toEqual({ sessionId: 's1' })
  })

  it('rejects a missing tool name (same shape as the retired host)', async () => {
    const sidecar = fakeSidecar()
    const peer = createBridgePeer(sidecar.peer)
    await expect(
      peer.request(TOOL_EXECUTE_METHOD, { sessionId: 's1', args: {} }),
    ).rejects.toThrow('starhub/tool.execute 缺少 name')
    expect(sidecar.requests).toEqual([])
  })

  it('surfaces an unknown sidecar method as the tool failure', async () => {
    const sidecar = fakeSidecar()
    const peer = createBridgePeer(sidecar.peer)
    await expect(
      peer.request(TOOL_EXECUTE_METHOD, { sessionId: 's1', name: 'excel_get_context', args: {} }),
    ).rejects.toThrow('method not found: excel_get_context')
  })

  it('rejects a non-text sidecar result instead of leaking an object to the model', async () => {
    const sidecar = fakeSidecar({ ssh_exec: { ok: true } })
    const peer = createBridgePeer(sidecar.peer)
    await expect(
      peer.request(TOOL_EXECUTE_METHOD, { sessionId: 's1', name: 'ssh_exec', args: {} }),
    ).rejects.toThrow('starhub host returned a non-string result')
  })
})

describe('bridge peer: linkage methods', () => {
  it('forwards bind.asset / open.asset / focus.tool / live.snapshot verbatim', async () => {
    const sidecar = fakeSidecar({
      bind_asset_context: { ok: true, action: 'bound' },
      [OPEN_ASSET_METHOD]: { ok: true, action: 'opened' },
      [FOCUS_TOOL_METHOD]: { ok: true, action: 'focused' },
      [LIVE_SNAPSHOT_METHOD]: { sessions: [], transfers: [], recentExecs: [], taskTrails: [] },
    })
    const peer = createBridgePeer(sidecar.peer)

    await expect(
      peer.request(BIND_ASSET_METHOD, { assetId: 'a1', sessionId: 's1' }),
    ).resolves.toEqual({ ok: true, action: 'bound' })
    await expect(
      peer.request(OPEN_ASSET_METHOD, { assetId: 'a1', sessionId: 's1' }),
    ).resolves.toEqual({ ok: true, action: 'opened' })
    await expect(
      peer.request(FOCUS_TOOL_METHOD, { assetId: 'a1', tool: 'terminal', sessionId: 's1' }),
    ).resolves.toEqual({ ok: true, action: 'focused' })
    await expect(peer.request(LIVE_SNAPSHOT_METHOD, {})).resolves.toMatchObject({ sessions: [] })

    expect(sidecar.requests.map(entry => entry.method)).toEqual([
      'bind_asset_context',
      OPEN_ASSET_METHOD,
      FOCUS_TOOL_METHOD,
      LIVE_SNAPSHOT_METHOD,
    ])
  })

  it('fails loud on the approval bridge instead of faking an outcome', async () => {
    const sidecar = fakeSidecar()
    const peer = createBridgePeer(sidecar.peer)
    await expect(
      peer.request(APPROVAL_REQUEST_METHOD, { sessionId: 's1', toolName: 'ssh_exec' }),
    ).rejects.toThrow(/does not answer starhub\/approval\.request/)
  })

  it('rejects an unknown bridge method with the host wording', async () => {
    const sidecar = fakeSidecar()
    const peer = createBridgePeer(sidecar.peer)
    await expect(peer.request('starhub/nope', {})).rejects.toThrow(
      'unknown StarHub bridge method: starhub/nope',
    )
  })
})

describe('bridge peer: outbound notifications', () => {
  it('forwards the stop-generation signal to the sidecar', () => {
    const sidecar = fakeSidecar()
    const peer = createBridgePeer(sidecar.peer)
    peer.notify(EXEC_ABORT_METHOD, { execId: 'e1' })
    expect(sidecar.notifications).toEqual([{ method: EXEC_ABORT_METHOD, params: { execId: 'e1' } }])
  })

  it('ignores notifications the plugins never send', () => {
    const sidecar = fakeSidecar()
    const peer = createBridgePeer(sidecar.peer)
    peer.notify('starhub/domain.event', { kind: 'x' })
    expect(sidecar.notifications).toEqual([])
  })
})

describe('toolResultText', () => {
  it('unwraps the sidecar {text} envelope and bare strings', () => {
    expect(toolResultText({ text: 'ok' })).toBe('ok')
    expect(toolResultText('ok')).toBe('ok')
  })

  it('rejects anything else', () => {
    expect(() => toolResultText({ ok: true })).toThrow('non-string result')
    expect(() => toolResultText(null)).toThrow('non-string result')
    expect(() => toolResultText(42)).toThrow('non-string result')
  })
})

describe('NotificationDispatcher', () => {
  it('dispatches by the inner event name and isolates subscriber failures', () => {
    const dispatcher = new NotificationDispatcher()
    const seen: unknown[] = []
    const dispose = dispatcher.subscribe('starhub/domain.event', params => { seen.push(params) })
    const boom = vi.fn(() => { throw new Error('subscriber bug') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    dispatcher.subscribe('starhub/domain.event', boom)

    dispatcher.dispatch('starhub/domain.event', { kind: 'ssh.exec_completed' })
    dispatcher.dispatch('starhub/registry.sync', { sessions: [] })

    expect(seen).toEqual([{ kind: 'ssh.exec_completed' }])
    expect(boom).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
    dispose()
    dispatcher.dispatch('starhub/domain.event', { kind: 'db.query_executed' })
    expect(seen).toHaveLength(1)
  })

  it('fans every event out to wildcard subscribers', () => {
    const dispatcher = new NotificationDispatcher()
    const frames: Array<[string, unknown]> = []
    const dispose = dispatcher.subscribeAll((event, params) => { frames.push([event, params]) })
    dispatcher.dispatch('ssh:exec-done', { id: 'x' })
    dispatcher.dispatch('starhub://open-asset', { assetId: 'a1' })
    expect(frames).toEqual([
      ['ssh:exec-done', { id: 'x' }],
      ['starhub://open-asset', { assetId: 'a1' }],
    ])
    dispose()
    dispatcher.dispatch('ssh:exec-done', { id: 'y' })
    expect(frames).toHaveLength(2)
  })

  it('unwraps the sidecar notification envelope when attached', () => {
    const dispatcher = new NotificationDispatcher()
    const seen: unknown[] = []
    dispatcher.subscribe('starhub/domain.event', params => { seen.push(params) })
    let handler: ((method: string, params: object) => void) | undefined
    dispatcher.attach({
      onNotification(installed: (method: string, params: object) => void) { handler = installed },
    })
    handler?.('starhub/domain-event', { event: 'starhub/domain.event', payload: { kind: 'k' } })
    handler?.('starhub/domain-event', { payload: { kind: 'ignored' } })
    handler?.('other', { event: 'x', payload: {} })
    expect(seen).toEqual([{ kind: 'k' }])
  })

  it('names the services the nine plugins read', () => {
    expect(BRIDGE_TRANSPORT_SERVICE).toBe('sdk-transport')
    expect(BRIDGE_NOTIFICATIONS_SERVICE).toBe('sdk-notifications')
  })
})
