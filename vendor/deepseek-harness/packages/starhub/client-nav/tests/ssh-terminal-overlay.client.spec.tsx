// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const xterm = vi.hoisted(() => ({
  dispose: vi.fn(),
  input: undefined as ((data: string) => void) | undefined,
  write: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() {}
    dispose = xterm.dispose
    write = xterm.write
    onData(handler: (data: string) => void) {
      xterm.input = handler
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

import { SshTerminalOverlay } from '../src/client/terminal/SshTerminalOverlay.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const asset = {
  id: 'ssh-1', type: 'ssh', name: 'server', group_id: null,
  config: { host: '10.0.0.5', port: 22, username: 'deploy', password: 'secret' },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  xterm.dispose.mockReset()
  xterm.input = undefined
  xterm.write.mockReset()
})

describe('SshTerminalOverlay', () => {
  it('subscribes before connecting, streams terminal bytes, and releases resources', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
    }
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock

    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', {
      id: 'ssh-1',
      config: {
        host: '10.0.0.5',
        port: 22,
        username: 'deploy',
        password: 'secret',
        auth: { Password: 'secret' },
        pty_cols: 80,
        pty_rows: 24,
      },
    }) })
    expect(invoke.mock.calls.findIndex(([command]) => command === 'plugin:event|listen'))
      .toBeLessThan(invoke.mock.calls.findIndex(([command]) => command === 'ssh_connect'))

    callbacks[0]?.({ event: 'ssh:data:ssh-1', id: 1, payload: [104, 105] })
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('hi')
    xterm.input?.('ls\r')
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-1', data: 'ls\r' }) })

    unmount()
    expect(xterm.dispose).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('ssh_disconnect', { id: 'ssh-1' })
    expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: 'ssh:data:ssh-1', eventId: 1 })
    expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: 'ssh:close:ssh-1', eventId: 2 })
  })

  it('calls onClose from the workspace close control', () => {
    const onClose = vi.fn()
    render(<SshTerminalOverlay asset={asset} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭 SSH 工作区' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('switches to the SFTP tab which reuses the live terminal session', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/home/deploy')
      if (command === 'sftp_list') {
        const path = (args?.path as string) ?? ''
        return Promise.resolve(path === '/home/deploy'
          ? [{ name: 'docs', path: '/home/deploy/docs', isDir: true, size: 0, permissions: 0o755, modified: 0 }]
          : [])
      }
      if (command === 'sftp_list_transfers') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }

    const { getByText, getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    // two tabs offered: 终端 + 文件 (SFTP)
    expect(getByText('终端')).toBeTruthy()
    // wait for the terminal to connect (so the SFTP tab reuses a live session)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // click the SFTP tab
    fireEvent.click(getByRole('button', { name: /文件/ }))
    // SFTP panel connects on the same session id (never a separate session)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_ensure_session', { id: 'ssh-1' }) })
    expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/home/deploy' })
    await waitFor(() =>{  expect(getByText('docs')).toBeTruthy() })
    unmount()
  })

  it('opens SFTP at the current terminal directory when cwd tracking has reported one', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/home/deploy')
      if (command === 'sftp_list') return Promise.resolve([])
      if (command === 'sftp_list_transfers') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => { callbacks.push(callback); return callbacks.length },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }

    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    callbacks[0]?.({ event: 'ssh:data:ssh-1', id: 1, payload: Array.from(new TextEncoder().encode('\u001b]7;/srv/app\u0007')) })
    fireEvent.click(getByRole('button', { name: /文件/ }))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/srv/app' }) })
    expect(invoke).not.toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/home/deploy' })
    unmount()
  })

  it('opens the broadcast dialog, lists connected sessions, sends a command, and reports success', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'ssh_get_sessions') {
        return Promise.resolve([
          { id: 'ssh-1', host: '10.0.0.5', port: 22, username: 'deploy', connected: true },
          { id: 'ssh-2', host: '10.0.0.6', port: 22, username: 'root', connected: true },
          { id: 'ssh-3', host: '10.0.0.7', port: 22, username: 'deploy', connected: false },
        ])
      }
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => { callbacks.push(callback); return callbacks.length },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByText, getByLabelText, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    fireEvent.click(getByText('广播'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_get_sessions', undefined) })
    // 只有 connected 的会话进列表(ssh-1 / ssh-2)。
    expect(screen.getByText('已选 2 / 2')).toBeTruthy()
    // 输入命令并提交 → 每个选中会话写 command\n。
    fireEvent.change(getByLabelText('广播命令'), { target: { value: 'uptime' } })
    fireEvent.click(getByText('广播 (2)'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-1', data: 'uptime\n' }) })
    expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-2', data: 'uptime\n' })
    await waitFor(() =>{  expect(screen.getByText('已广播到 2 个会话')).toBeTruthy() })
    unmount()
  })

  it('shows a notice when there are no connected sessions to broadcast to', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'ssh_get_sessions') return Promise.resolve([{ id: 'ssh-1', connected: false }])
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => { callbacks.push(callback); return callbacks.length },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByText, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    fireEvent.click(getByText('广播'))
    await waitFor(() =>{  expect(screen.getByText('没有已连接的会话可用于广播')).toBeTruthy() })
    unmount()
  })

  it('dismisses a broadcast notice via its close button', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'ssh_get_sessions') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => { callbacks.push(callback); return callbacks.length },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByText, unmount, queryByText } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    fireEvent.click(getByText('广播'))
    await waitFor(() =>{  expect(screen.getByText('没有已连接的会话可用于广播')).toBeTruthy() })
    // 关掉通知。
    const notice = getByText('没有已连接的会话可用于广播').closest('[role="status"]') as HTMLElement
    fireEvent.click(notice.querySelector('button') as HTMLElement)
    expect(queryByText('没有已连接的会话可用于广播')).toBeNull()
    unmount()
  })

  it('switches to the Web tab and starts the browser gateway', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'ssh_start_web_gateway') return Promise.resolve(18080)
      if (command === 'ssh_web_gateway_port') return Promise.resolve(18080)
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => { callbacks.push(callback); return callbacks.length },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    // 拦截 iframe.src,避免 jsdom 抛导航。
    const orig = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true, get() { return '' }, set() {},
    })
    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    fireEvent.click(getByRole('button', { name: /网页/ }))
    // 网页 tab 渲染出浏览器地址栏,导航一次 → 启动网关。
    expect(screen.getByLabelText('地址栏')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'example.com' } })
    fireEvent.keyDown(screen.getByLabelText('地址栏'), { key: 'Enter' })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_start_web_gateway', { sessionId: 'ssh-1' }) })
    unmount()
    if (orig !== undefined) Object.defineProperty(HTMLIFrameElement.prototype, 'src', orig)
  })

  it('reports partial failure when some broadcast sends reject', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'ssh_get_sessions') {
        return Promise.resolve([
          { id: 'ssh-1', connected: true },
          { id: 'ssh-2', connected: true },
        ])
      }
      if (command === 'ssh_write') {
        if (args?.id === 'ssh-2') return Promise.reject(new Error('boom'))
        return Promise.resolve(null)
      }
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => { callbacks.push(callback); return callbacks.length },
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByText, getByLabelText, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    fireEvent.click(getByText('广播'))
    await waitFor(() =>{  expect(screen.getByText('已选 2 / 2')).toBeTruthy() })
    fireEvent.change(getByLabelText('广播命令'), { target: { value: 'reboot' } })
    fireEvent.click(getByText('广播 (2)'))
    await waitFor(() =>{  expect(screen.getByText(/1 个会话发送失败/)).toBeTruthy() })
    unmount()
  })
})
