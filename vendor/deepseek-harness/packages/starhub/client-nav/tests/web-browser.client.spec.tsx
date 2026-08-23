// @vitest-environment jsdom
/**
 * WebBrowser(需求 6 web 子集):地址栏规范化导航、网关幂等启动(_start_web_gateway
 * / _web_gateway_port 校验/重启)、back/forward/reload postMessage、navigated
 * 上报回写地址栏、卸载停网关、空/无效地址提示、导航失败错误。组件全覆盖。
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WebBrowser } from '../src/client/terminal/WebBrowser.tsx'

// 拦截 iframe.src 赋值(jsdom 镜像属性不触发 navigate,记录即可)。
let iframeSrcSetter: Mock<(_v: string) => void>
let originalSrcDescriptor: PropertyDescriptor | undefined
// 稳定的假 contentWindow:让 source 检查在 jsdom 里可命中。
let fakeContentWindow: { postMessage: Mock<(...a: unknown[]) => void> }
let originalContentWindowDescriptor: PropertyDescriptor | undefined

function spyIframe() {
  iframeSrcSetter = vi.fn((_v: string) => {})
  originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true,
    get() { return '' },
    set(v: string) { iframeSrcSetter(v) },
  })
  fakeContentWindow = { postMessage: vi.fn() }
  originalContentWindowDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true, get() { return fakeContentWindow },
  })
}

function restoreIframe() {
  if (originalSrcDescriptor !== undefined) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', originalSrcDescriptor)
  }
  if (originalContentWindowDescriptor !== undefined) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', originalContentWindowDescriptor)
  }
}

/** 模拟未类型化的 IPC 拒绝(真实 Tauri 载荷可能是纯字符串而非 Error)。 */
function rawRejection(reason: string): Promise<never> {
  const reject = Promise.reject.bind(Promise)
  return reject(reason)
}

function stubInvoke(scenario: {
  gatewayPort?: number | (() => number)
  checkAlive?: (() => number | null)
  failStart?: boolean
  failNav?: boolean
}) {
  const calls: Array<[cmd: string, args: Record<string, unknown>]> = []
  let port = 0
  const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = (args ?? {})
    calls.push([cmd, a])
    if (scenario.failNav) return Promise.reject(new Error('forward failure'))
    switch (cmd) {
      case 'ssh_start_web_gateway':
        if (scenario.failStart) return Promise.reject(new Error('gateway start failed'))
        port = typeof scenario.gatewayPort === 'function' ? scenario.gatewayPort() : (scenario.gatewayPort ?? 18080)
        return Promise.resolve(port)
      case 'ssh_web_gateway_port':
        return Promise.resolve(scenario.checkAlive !== undefined ? scenario.checkAlive() : port)
      case 'ssh_stop_web_gateway':
        return Promise.resolve(null)
      default:
        return Promise.reject(new Error(`unexpected ${cmd}`))
    }
  })
  ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
  return { invoke, calls }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreIframe()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('WebBrowser', () => {
  it('normalizes and navigates the address, starting the gateway once', async () => {
    spyIframe()
    const { calls } = stubInvoke({ gatewayPort: 18080 })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    const input = screen.getByLabelText<HTMLInputElement>('地址栏')
    fireEvent.change(input, { target: { value: 'example.com/a' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([cmd]) => cmd === 'ssh_start_web_gateway')).toBe(true) })
    expect(calls).toContainEqual(['ssh_start_web_gateway', { sessionId: 'ssh-1' }])
    await waitFor(() =>{  expect(iframeSrcSetter).toHaveBeenCalled() })
    expect(iframeSrcSetter.mock.calls[0]?.[0] ?? '').toContain('/__proxy__/https/example.com/a')
    expect(input.value).toBe('https://example.com/a')
  })

  it('reuses a live gateway via the port check instead of restarting', async () => {
    const { calls } = stubInvoke({ gatewayPort: 18080 })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([cmd]) => cmd === 'ssh_start_web_gateway')).toBe(true) })
    // 首次启动后,再次导航走端口校验,不再回源重启。
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'y.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'ssh_web_gateway_port' && a.sessionId === 'ssh-1')).toBe(true) })
    const starts = calls.filter(([cmd]) => cmd === 'ssh_start_web_gateway')
    expect(starts.length).toBe(1)
  })

  it('restarts the gateway when the cached port went stale', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      const a = (args ?? {})
      calls.push([cmd, a])
      if (cmd === 'ssh_start_web_gateway') {
        // 第一次 18080,后续(重启)19090。
        return Promise.resolve(calls.filter(([c]) => c === 'ssh_start_web_gateway').length === 1 ? 18080 : 19090)
      }
      if (cmd === 'ssh_web_gateway_port') return Promise.resolve(0)
      if (cmd === 'ssh_stop_web_gateway') return Promise.resolve(null)
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'a.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([cmd]) => cmd === 'ssh_start_web_gateway')).toBe(true) })
    // 二次导航:端口校验 0 → 重启。
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'b.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(calls.filter(([cmd]) => cmd === 'ssh_start_web_gateway').length).toBeGreaterThanOrEqual(2) })
  })

  it('shows a notice for an invalid URL and does not navigate', async () => {
    const { calls } = stubInvoke({})
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: '::::' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText('地址无效,请输入有效 URL')).toBeTruthy() })
    expect(calls.some(([cmd]) => cmd === 'ssh_start_web_gateway')).toBe(false)
  })

  it('surfaces a gateway start failure as an error', async () => {
    stubInvoke({ failStart: true })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText('gateway start failed')).toBeTruthy() })
  })

  it('sends back/forward/reload commands to the gateway bridge', async () => {
    spyIframe()
    stubInvoke({ gatewayPort: 18080 })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    // 先导航以建网关。
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('https://x.com/') })
    fireEvent.click(screen.getByTitle('后退'))
    fireEvent.click(screen.getByTitle('前进'))
    fireEvent.click(screen.getByTitle('刷新'))
    const posts = fakeContentWindow.postMessage.mock.calls.map(c => c[0]) as Array<{ type?: string }>
    expect(posts.map(p => p.type)).toEqual(['back', 'forward', 'reload'])
    const targets = fakeContentWindow.postMessage.mock.calls.map(c => c[1])
    expect(targets.every(t => t === 'http://127.0.0.1:18080')).toBe(true)
  })

  it('does not send bridge commands before the gateway is up', async () => {
    spyIframe()
    stubInvoke({})
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.click(screen.getByTitle('后退'))
    expect(fakeContentWindow.postMessage).not.toHaveBeenCalled()
  })

  it('writes back the address from a navigated bridge message', async () => {
    spyIframe()
    stubInvoke({ gatewayPort: 18080 })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('https://x.com/') })
    window.dispatchEvent(new MessageEvent('message', {
      data: { __starhub: 1, type: 'navigated', href: 'http://127.0.0.1:18080/__proxy__/https/new.example/page' },
      origin: 'http://127.0.0.1:18080',
      source: fakeContentWindow as unknown as Window,
    }))
    await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('https://new.example/page') })
  })

  it('ignores bridge messages from wrong origins or a foreign source', async () => {
    spyIframe()
    const { calls } = stubInvoke({ gatewayPort: 18080 })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('https://x.com/') })
    const input = screen.getByLabelText<HTMLInputElement>('地址栏')
    // 错误 origin → 忽略。
    window.dispatchEvent(new MessageEvent('message', {
      data: { __starhub: 1, type: 'navigated', href: 'http://127.0.0.1:18080/__proxy__/https/bad.example/' },
      origin: 'http://evil.example',
      source: fakeContentWindow as unknown as Window,
    }))
    await waitFor(() =>{  expect(input.value).toBe('https://x.com/') })
    // 匹配 origin 但 source 不是本 iframe → 忽略。
    window.dispatchEvent(new MessageEvent('message', {
      data: { __starhub: 1, type: 'navigated', href: 'http://127.0.0.1:18080/__proxy__/https/other.example/' },
      origin: 'http://127.0.0.1:18080',
      source: { postMessage: vi.fn() } as unknown as Window,
    }))
    await waitFor(() =>{  expect(input.value).toBe('https://x.com/') })
    // 非桥接消息(无 __starhub)→ 忽略。
    window.dispatchEvent(new MessageEvent('message', {
      data: { nope: true },
      origin: 'http://127.0.0.1:18080',
      source: fakeContentWindow as unknown as Window,
    }))
    expect(input.value).toBe('https://x.com/')
    // 合法桥接消息但 type 不是 navigated → 忽略(不进 inner block)。
    window.dispatchEvent(new MessageEvent('message', {
      data: { __starhub: 1, type: 'some-other-event' },
      origin: 'http://127.0.0.1:18080',
      source: fakeContentWindow as unknown as Window,
    }))
    expect(input.value).toBe('https://x.com/')
    void calls
  })

  it('stops the gateway on unmount', async () => {
    const { calls } = stubInvoke({ gatewayPort: 18080 })
    const { unmount } = render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([cmd]) => cmd === 'ssh_start_web_gateway')).toBe(true) })
    unmount()
    expect(calls).toContainEqual(['ssh_stop_web_gateway', { sessionId: 'ssh-1' }])
  })

  it('does not write back when the navigated href is not a proxy path', async () => {
    spyIframe()
    const { calls } = stubInvoke({ gatewayPort: 18080 })
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('https://x.com/') })
    const input = screen.getByLabelText<HTMLInputElement>('地址栏')
    // navigated 上报的是非代理 URL(proxyToOriginal 返回 null),地址栏保持原值。
    window.dispatchEvent(new MessageEvent('message', {
      data: { __starhub: 1, type: 'navigated', href: 'https://direct.example/somewhere' },
      origin: 'http://127.0.0.1:18080',
      source: fakeContentWindow as unknown as Window,
    }))
    expect(input.value).toBe('https://x.com/')
    expect(input.value).not.toContain('direct.example')
    void calls
  })

  it('swallows a gateway stop failure on unmount', async () => {
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'ssh_start_web_gateway') return Promise.resolve(18080)
      if (cmd === 'ssh_web_gateway_port') return Promise.resolve(18080)
      if (cmd === 'ssh_stop_web_gateway') return Promise.reject(new Error('stop failed'))
      void args
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    const { unmount } = render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_start_web_gateway', { sessionId: 'ssh-1' }) })
    expect(() =>{  unmount() }).not.toThrow()
  })

  it('ignores non-Enter keys in the address bar', async () => {
    stubInvoke({})
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    // 非 Enter(如 Tab)不应触发导航。
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Tab' })
    expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('x.com')
  })

  it('resets the cached port when the gateway port check rejects', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      const a = (args ?? {})
      calls.push([cmd, a])
      if (cmd === 'ssh_start_web_gateway') return Promise.resolve(18080)
      // 首次导航后的二次导航:端口校验拒绝 → 视为失效 → 再次启动。
      if (cmd === 'ssh_web_gateway_port') return Promise.reject(new Error('gone'))
      if (cmd === 'ssh_stop_web_gateway') return Promise.resolve(null)
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'a.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('地址栏')).value).toBe('https://a.com/') })
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'b.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(calls.filter(([cmd]) => cmd === 'ssh_start_web_gateway').length).toBeGreaterThanOrEqual(2) })
  })

  it('formats a non-Error gateway failure as a string', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'ssh_start_web_gateway') return rawRejection('plain-string-failure')
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'x.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText('plain-string-failure')).toBeTruthy() })
  })

  it('guards against re-entrant submission while loading', async () => {
    const deferred = { resolve: null as ((v: number) => void) | null }
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'ssh_start_web_gateway') {
        return new Promise<number>((resolve) => { deferred.resolve = resolve })
      }
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<WebBrowser sessionId="ssh-1" assetName="server" />)
    const input = screen.getByLabelText<HTMLInputElement>('地址栏')
    // 首次提交挂起 loading;二次提交被 loading 守卫拦住。
    fireEvent.change(input, { target: { value: 'a.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'b.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledTimes(1) })
    deferred.resolve?.(18080)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledTimes(1) })
  })
})
