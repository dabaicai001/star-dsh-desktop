// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const xterm = vi.hoisted(() => ({
  dispose: vi.fn(),
  input: undefined as ((data: string) => void) | undefined,
  write: vi.fn(),
  writeln: vi.fn(),
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
    writeln = xterm.writeln
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
// ZMODEM sentry mock: forwards terminal octets to to_terminal (so the data
// path keeps rendering) and exposes the latest options so tests can drive
// on_detect / the receive offer handler directly.
const zmodemMock = vi.hoisted(() => ({
  options: null as {
    to_terminal?: (octets: number[]) => void
    sender?: (octets: number[]) => void
    on_detect?: (detection: { confirm: () => unknown; deny: () => void }) => void
    on_retract?: () => void
  } | null,
  sendFiles: vi.fn(),
  saveToDisk: vi.fn(),
}))
vi.mock('zmodem.js/src/zmodem_browser.js', () => ({
  default: {
    Sentry: class {
      constructor(options: NonNullable<typeof zmodemMock.options>) {
        zmodemMock.options = options
      }
      consume(octets: number[] | Uint8Array) {
        // Non-ZMODEM bytes pass through to the terminal render path.
        zmodemMock.options?.to_terminal?.(Array.from(octets as number[] | Uint8Array))
      }
    },
    Browser: {
      send_files: zmodemMock.sendFiles,
      save_to_disk: zmodemMock.saveToDisk,
    },
  },
}))
import { SshTerminalOverlay } from '../src/client/terminal/SshTerminalOverlay.tsx'
import {
  emitHostEvent, hostEventListeners, restoreHostBridge, restoreHostEvents, stubHostBridge, stubHostEvents,
  type HostBridgeHandler,
} from './host-bridge.ts'
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
/** 挂载宿主桥替身:invoke 记录调用,事件订阅走共享 SSE 连接(按事件名监听)。 */
function stubInternals(invoke: HostBridgeHandler) {
  stubHostBridge(invoke)
  stubHostEvents()
}
const asset = {
  id: 'ssh-1', type: 'ssh', name: 'server', group_id: null,
  config: { host: '10.0.0.5', port: 22, username: 'deploy', password: 'secret' },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreHostBridge()
  restoreHostEvents()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  xterm.dispose.mockReset()
  xterm.input = undefined
  xterm.write.mockReset()
  zmodemMock.options = null
  zmodemMock.sendFiles.mockReset()
  zmodemMock.saveToDisk.mockReset()
})
describe('SshTerminalOverlay', () => {
  it('subscribes before connecting, streams terminal bytes, and releases resources', async () => {
    // 订阅必须先于连接:连接发生时 data 事件监听已就位(共享 SSE 连接)。
    let dataListenerAtConnect = -1
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_connect') dataListenerAtConnect = hostEventListeners('ssh:data:ssh-1')
      return Promise.resolve(null)
    })
    stubInternals(invoke)
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
    expect(dataListenerAtConnect).toBe(1)
    emitHostEvent('ssh:data:ssh-1', [104, 105])
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('hi')
    xterm.input?.('ls\r')
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-1', data: 'ls\r' }) })
    unmount()
    expect(xterm.dispose).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('ssh_disconnect', { id: 'ssh-1' })
    // 卸载即退订:四个事件名的监听全部摘除(替代旧 plugin:event|unlisten 断言)。
    expect(hostEventListeners('ssh:data:ssh-1')).toBe(0)
    expect(hostEventListeners('ssh:close:ssh-1')).toBe(0)
    expect(hostEventListeners('ssh:kb-interactive:ssh-1')).toBe(0)
    expect(hostEventListeners('ssh:hostkey-confirm:ssh-1')).toBe(0)
  })
  it('calls onClose from the workspace close control', () => {
    const onClose = vi.fn()
    render(<SshTerminalOverlay asset={asset} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭 SSH 工作区' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('switches to the SFTP tab which reuses the live terminal session', async () => {
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
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
    stubInternals(invoke)
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
    const invoke = vi.fn((command: string) => {
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/home/deploy')
      if (command === 'sftp_list') return Promise.resolve([])
      if (command === 'sftp_list_transfers') return Promise.resolve([])
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    emitHostEvent('ssh:data:ssh-1', Array.from(new TextEncoder().encode('\u001b]7;/srv/app\u0007')))
    fireEvent.click(getByRole('button', { name: /文件/ }))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/srv/app' }) })
    expect(invoke).not.toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/home/deploy' })
    unmount()
  })
  it('injects the OSC 7 hook on an ANSI-colored prompt and SFTP follows the extracted cwd', async () => {
    // 回归:Ubuntu 默认 PS1 带 OSC 0 标题 + ANSI 颜色,裸正则永远识别不出
    // prompt → 注入永不发生,SFTP 只能在用户手敲 pwd 后跟随。剥控制序列后
    // 必须命中 prompt 并注入;~ 依登录 home 展开为 cwd,面板自动跟随。
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_exec') return Promise.resolve('/root\nbash\nbash') // pwd + $0 + ps probe
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/home/deploy') // ≠ home probe:初始打开在 /home/deploy
      if (command === 'sftp_list') return Promise.resolve([])
      if (command === 'sftp_list_transfers') return Promise.resolve([])
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_exec', expect.objectContaining({ id: 'ssh-1' })) })
    await act(async () => {}) // probe settles: home=/root and sshCwd=/root (login dir)
    fireEvent.click(getByRole('button', { name: /文件/ }))
    // SFTP opens directly at the already-tracked terminal cwd
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/root' }) })
    // Ubuntu default PS1 (`\u@\h:\w\$` → deploy@server:~/src$): OSC-0 title + colors
    const ubuntuPrompt = '\u001b]0;deploy@server: ~/src\u0007\u001b[01;32mdeploy@server\u001b[00m:\u001b[01;34m~/src\u001b[00m$ '
    act(() => {
      emitHostEvent('ssh:data:ssh-1', Array.from(new TextEncoder().encode(ubuntuPrompt)))
    })
    // prompt recognized through the control-stripped line → hook injected
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-1', data: expect.stringContaining('__starhub_osc7') }) })
    // ~ expanded against the login home → cwd /root/src reported → SFTP panel follows
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/root/src' }) })
    unmount()
  })
  it('injects the fish dialect hook for a fish login shell', async () => {
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_exec') return Promise.resolve('/root\nfish\nfish')
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/root')
      if (command === 'sftp_list') return Promise.resolve([])
      if (command === 'sftp_list_transfers') return Promise.resolve([])
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_exec', expect.objectContaining({ id: 'ssh-1' })) })
    await act(async () => {}) // probe settles: loginShellRef = fish
    fireEvent.click(getByRole('button', { name: /文件/ }))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_ensure_session', { id: 'ssh-1' }) })
    act(() => {
      emitHostEvent('ssh:data:ssh-1', Array.from(new TextEncoder().encode('deploy@server:~>')))
    })
    // the bash dialect would only print an error line in fish; the event hook runs
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-1', data: expect.stringContaining('--on-event fish_prompt') }) })
    unmount()
  })
  it('skips injection for shells immune to it (tcsh) while prompt extraction still tracks cwd', async () => {
    const invoke = vi.fn((command: string, _args?: Record<string, unknown>) => {
      if (command === 'ssh_exec') return Promise.resolve('/root\ntcsh\ntcsh')
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/root')
      if (command === 'sftp_list') return Promise.resolve([])
      if (command === 'sftp_list_transfers') return Promise.resolve([])
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_exec', expect.objectContaining({ id: 'ssh-1' })) })
    await act(async () => {}) // probe settles: loginShellRef = tcsh
    fireEvent.click(getByRole('button', { name: /文件/ }))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_ensure_session', { id: 'ssh-1' }) })
    act(() => {
      emitHostEvent('ssh:data:ssh-1', Array.from(new TextEncoder().encode('[user@server /var/log]>')))
    })
    await act(async () => {})
    // no hook ever written (it would only error in tcsh)…
    const hookWrite = invoke.mock.calls.find(call =>
      call[0] === 'ssh_write' && String((call[1] as { data?: string } | undefined)?.data ?? '').includes('__starhub_osc7'))
    expect(hookWrite).toBeUndefined()
    // …yet the prompt-carried path is extracted and the panel follows it
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/var/log' }) })
    unmount()
  })
  it('opens the broadcast dialog, lists connected sessions, sends a command, and reports success', async () => {
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_get_sessions') {
        return Promise.resolve([
          { id: 'ssh-1', host: '10.0.0.5', port: 22, username: 'deploy', connected: true },
          { id: 'ssh-2', host: '10.0.0.6', port: 22, username: 'root', connected: true },
          { id: 'ssh-3', host: '10.0.0.7', port: 22, username: 'deploy', connected: false },
        ])
      }
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByText, getByLabelText, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    fireEvent.click(getByText('广播'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_get_sessions', {}) })
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
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_get_sessions') return Promise.resolve([{ id: 'ssh-1', connected: false }])
      return Promise.resolve(null)
    })
    stubInternals(invoke)
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
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_get_sessions') return Promise.resolve([])
      return Promise.resolve(null)
    })
    stubInternals(invoke)
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
  it('opens the web browser in a standalone window from the 网页 button', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // 连接后点「网页」→ 打开独立 webview 窗口(内嵌 WebBrowser/网关由独立窗口承载)
    fireEvent.click(getByRole('button', { name: /网页/ }))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_open_web_window', { sessionId: 'ssh-1', assetName: 'server' }) })
    unmount()
  })
  it('reports partial failure when some broadcast sends reject', async () => {
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
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
    stubInternals(invoke)
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
  it('sends kb_interactive for MFA assets so the server prompt can be shown', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const mfaAsset = {
      ...asset,
      config: {
        ...asset.config,
        // NewConnectionDialog 保存 MFA 档时把主密码同时写入 password 与 mfaPassword。
        password: 'main-secret',
        authMode: 'mfa',
        mfaEnabled: true,
        mfaPassword: 'main-secret',
      },
    }
    const { unmount } = render(<SshTerminalOverlay asset={mfaAsset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', {
      id: 'ssh-1',
      config: expect.objectContaining({
        authMode: 'mfa',
        mfaEnabled: true,
        mfaPassword: 'main-secret',
        auth: { Password: 'main-secret' },
        kb_interactive: { enabled: true, password: 'main-secret' },
      }),
    }) })
    unmount()
  })
  it('shows the MFA prompt on kb-interactive and submits answers via ssh_kb_response', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // kb-interactive 事件(SSE 事件名带 sessionId)
    emitHostEvent('ssh:kb-interactive:ssh-1', {
      sessionId: 'ssh-1',
      instructions: '2FA required',
      prompts: [{ prompt: 'Verification code', echo: false }],
      autoFill: [null],
    })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    expect(screen.getByText('2FA required')).toBeTruthy()
    expect(screen.getByText('Verification code')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByText('提交验证码'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_kb_response', { id: 'ssh-1', responses: ['123456'] }) })
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('submits the MFA code when Enter is pressed in the input', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    emitHostEvent('ssh:kb-interactive:ssh-1', {
      sessionId: 'ssh-1',
      instructions: '',
      prompts: [{ prompt: 'OTP:', echo: false }],
      autoFill: [null],
    })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('OTP:'), { target: { value: '654321' } })
    // Enter 在验证码输入框内提交(等价点击「提交验证码」)。
    fireEvent.keyDown(screen.getByLabelText('OTP:'), { key: 'Enter' })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_kb_response', { id: 'ssh-1', responses: ['654321'] }) })
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('prefills kb answers from autoFill and clears the prompt on submit', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    emitHostEvent('ssh:kb-interactive:ssh-1', {
      sessionId: 'ssh-1',
      instructions: '',
      prompts: [
        { prompt: 'Password', echo: false },
        { prompt: 'TOTP', echo: false },
      ],
      autoFill: ['pre-filled-pwd', null],
    })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('pre-filled-pwd')
    expect((screen.getByLabelText('TOTP') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByText('提交验证码'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_kb_response', { id: 'ssh-1', responses: ['pre-filled-pwd', ''] }) })
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })
  it('shows the host-key prompt on first connect, lets the user trust & persist, and replies via ssh_hostkey_response', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // hostkey-confirm 事件(SSE 事件名带 sessionId)
    emitHostEvent('ssh:hostkey-confirm:ssh-1', {
      hostname: '10.0.0.5', port: 22, remote: '10.0.0.5:22',
      keyType: 'ssh-ed25519', sha256: 'SHA256:c3R1Yi1lZDI1NTE5LWZpbmdlcnByaW50',
    })
    await waitFor(() =>{  expect(screen.getByLabelText('主机密钥确认')).toBeTruthy() })
    expect(screen.getByText('10.0.0.5:22')).toBeTruthy()
    expect(screen.getByText('ssh-ed25519')).toBeTruthy()
    expect(screen.getByText(/c3R1Yi1lZDI1NTE5LWZpbmdlcnByaW50/)).toBeTruthy()
    fireEvent.click(screen.getByText('信任并保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_hostkey_response', { id: 'ssh-1', allowed: true, persist: true }) })
    expect(screen.queryByLabelText('主机密钥确认')).toBeNull()
    unmount()
  })

  it('rejects an unknown host key by responding allowed=false, disconnecting, and keeping the reason visible', async () => {
    const onClose = vi.fn()
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={onClose} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    emitHostEvent('ssh:hostkey-confirm:ssh-1', {
      hostname: '10.0.0.5', port: 22, remote: '10.0.0.5:22',
      keyType: 'ssh-rsa', sha256: 'SHA256:dW50cnVzdGVkLWZpbmdlcnByaW50',
    })
    await waitFor(() =>{  expect(screen.getByLabelText('主机密钥确认')).toBeTruthy() })
    fireEvent.click(screen.getByText('拒绝'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_hostkey_response', { id: 'ssh-1', allowed: false, persist: false }) })
    expect(invoke).toHaveBeenCalledWith('ssh_disconnect', { id: 'ssh-1' })
    // 拒绝后不再自动关窗:拒绝原因必须可见,状态进「已断开」并给重新连接入口
    // (此前先 setError 再 onClose,提示随 overlay 一起消失,用户看不到原因)。
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/已拒绝主机密钥/)).toBeTruthy()
    expect(screen.getByText('已断开')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy()
    expect(screen.queryByLabelText('主机密钥确认')).toBeNull()
    unmount()
  })
  it('marks a remotely closed session as disconnected and reconnects on demand', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // 连接成功 → 「已连接」
    await waitFor(() =>{  expect(screen.getByText('已连接')).toBeTruthy() })
    // 远端关闭事件(第 2 个监听 = ssh:close)
    emitHostEvent('ssh:close:ssh-1', 'Connection reset by peer')
    await waitFor(() =>{  expect(screen.getByText('已断开')).toBeTruthy() })
    // 断开后不再谎报「连接中」,并给出重新连接入口
    expect(screen.queryByText('连接中')).toBeNull()
    const connectCalls = invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect').length
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    // 重新连接 = 重新发起一次 ssh_connect(代次 +1 重建会话)
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect').length).toBe(connectCalls + 1)
    })
    unmount()
  })
  it('runs a ZMODEM send session (remote rz), picks a file and streams it back', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    const session = {
      type: 'send', on: vi.fn(() => session), start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined), abort: vi.fn(),
    }
    zmodemMock.sendFiles.mockImplementation((_s, _files, opts) => {
      // drive the progress + complete callbacks to cover their setters
      opts.on_progress?.({ name: 'a.txt' } as File, { get_offset: () => 5 } as never)
      opts.on_file_complete?.({ name: 'a.txt' } as File)
      return Promise.resolve()
    })
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    expect(screen.getByText('远端 rz 已就绪，请选择要发送的文件')).toBeTruthy()
    expect(screen.getByText('选择文件')).toBeTruthy()
    // chooseZmodemFiles: 点击按钮触发隐藏 input.click()
    fireEvent.click(screen.getByText('选择文件'))
    // sender: 回写 ZMODEM 协议字节走 ssh_write_binary
    act(() => { zmodemMock.options!.sender!([1, 2, 3]) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write_binary', { id: 'ssh-1', data: [1, 2, 3] }) })
    fireEvent.change(screen.getByLabelText('选择 ZMODEM 发送文件'), {
      target: { files: [{ name: 'a.txt', size: 10 }] },
    } as never)
    await waitFor(() =>{  expect(zmodemMock.sendFiles).toHaveBeenCalledTimes(1) })
    // on_file_complete ran → status flips to 已发送
    await waitFor(() =>{  expect(screen.getByText('已发送 a.txt')).toBeTruthy() })
    unmount()
  })
  it('receives a remote sz file (offer → accept → save to disk) and cancels cleanly', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    let offerHandler: ((...args: unknown[]) => void) | undefined
    const session = {
      type: 'receive',
      on: vi.fn((ev: string, handler: (...args: unknown[]) => void) => {
        if (ev === 'offer') offerHandler = handler
        return session
      }),
      start: vi.fn(), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn(),
    }
    const transfer = {
      get_details: () => ({ name: 'remote.tar', size: 100 }),
      get_offset: () => 50,
      accept: vi.fn().mockResolvedValue([new Uint8Array([1, 2])]),
    }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    expect(screen.getByText('正在等待远端文件…')).toBeTruthy()
    expect(screen.queryByText('选择文件')).toBeNull() // receive has no picker
    act(() => { offerHandler!(transfer) })
    await waitFor(() =>{  expect(zmodemMock.saveToDisk).toHaveBeenCalledWith([new Uint8Array([1, 2])], 'remote.tar') })
    await waitFor(() =>{  expect(screen.getByText('已接收 remote.tar')).toBeTruthy() })
    // session_end fires finish → bar hidden
    const sessEnd = session.on.mock.calls.find(([ev]) => ev === 'session_end')
    act(() => { ;(sessEnd![1] as () => void)() })
    expect(screen.queryByText('已接收 remote.tar')).toBeNull()
    unmount()
  })
  it('builds every SSH auth mode and the kb_interactive config from the asset config', async () => {
    const cases: Array<{ config: Record<string, unknown>; expectAuth: Record<string, unknown> }> = [
      // password only (the common case)
      { config: { host: 'h', port: 22, username: 'u', password: 'p' }, expectAuth: { Password: 'p' } },
      // key auth + passphrase
      { config: { host: 'h', port: 22, username: 'u', useKeyAuth: true, privateKey: 'KEY', passphrase: 'PP', usePasswordAuth: false }, expectAuth: { PrivateKey: { key: 'KEY', passphrase: 'PP' } } },
      // password + key → PasswordAndKey
      { config: { host: 'h', port: 22, username: 'u', useKeyAuth: true, privateKey: 'KEY', password: 'p' }, expectAuth: { PasswordAndKey: { password: 'p', key: 'KEY', passphrase: null } } },
      // nothing usable → Password: ''
      { config: { host: 'h', port: 22, username: 'u' }, expectAuth: { Password: '' } },
    ]
    for (const { config, expectAuth } of cases) {
      const invoke = vi.fn((_command: string, _args?: Record<string, unknown>) => {
        return Promise.resolve(null)
      })
      stubInternals(invoke)
      ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
      const { unmount } = render(<SshTerminalOverlay asset={{ ...asset, config } as unknown as typeof asset} onClose={vi.fn()} />)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
      const connectCall = invoke.mock.calls.find(([cmd]) => cmd === 'ssh_connect')!
      expect((connectCall[1]! as { config: { auth: unknown } }).config.auth).toEqual(expectAuth)
      unmount()
    }
    // kb_interactive: mfaPassword present → password field
    const invoke = vi.fn((_command: string, _args?: Record<string, unknown>) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
    const mfaAsset = { ...asset, config: { ...asset.config, mfaEnabled: true, mfaPassword: 'main-secret' } }
    const { unmount } = render(<SshTerminalOverlay asset={mfaAsset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    const connectCall = invoke.mock.calls.find(([cmd]) => cmd === 'ssh_connect')!
    expect((connectCall[1]! as { config: { kb_interactive: unknown } }).config.kb_interactive).toEqual({ enabled: true, password: 'main-secret' })
    unmount()
  })
  it('covers zmodem send guard, multi-file, zero-byte, send failure and cancel', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
    const session = {
      type: 'send', on: vi.fn(() => session), start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined), abort: vi.fn(),
    }
    // first success (multi-file + zero-byte progress), then a failing send_files
    zmodemMock.sendFiles
      .mockImplementationOnce((_s, _f, opts) => {
        opts.on_progress?.({ name: 'b.txt' } as File, { get_offset: () => 0 } as never) // totalBytes === 0 → progress 0
        return Promise.resolve()
      })
      .mockRejectedValueOnce(new Error('send boom'))
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    const input = screen.getByLabelText('选择 ZMODEM 发送文件')
    // empty files → early return (no send)
    fireEvent.change(input, { target: { files: [] } } as never)
    expect(zmodemMock.sendFiles).not.toHaveBeenCalled()
    // multi-file select → 正在发送 N 个文件 + on_progress with zero-byte
    fireEvent.change(input, { target: { files: [{ name: 'b.txt', size: 0 }, { name: 'c.txt', size: 0 }] } } as never)
    await waitFor(() =>{  expect(screen.getByText('正在发送 2 个文件')).toBeTruthy() })
    expect(zmodemMock.sendFiles).toHaveBeenCalledTimes(1)
    // second detect → send_files rejects → abort
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    fireEvent.change(input, { target: { files: [{ name: 'x', size: 1 }] } } as never)
    await waitFor(() =>{  expect(zmodemMock.sendFiles).toHaveBeenCalledTimes(2) })
    await waitFor(() =>{  expect(session.abort).toHaveBeenCalled() })
    // cancel (recv timer set → finishes with timer clear)
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    fireEvent.click(screen.getByText('取消'))
    unmount()
  })
  it('re-runs the terminal data path through the zmodem sentry for chunk edges', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // data (non-zmodem) → sentry.consume → to_terminal → handleChunk
    act(() => { emitHostEvent('ssh:data:ssh-1', []) }) // empty chunk → early return
    act(() => { emitHostEvent('ssh:data:ssh-1', Array.from(new TextEncoder().encode('\u001b]7;/srv\u0007'))) }) // OSC 7 cwd
    // pwd output chunk → cwd fallback
    act(() => { emitHostEvent('ssh:data:ssh-1', Array.from(new TextEncoder().encode('\n/opt/x\r\n'))) })
    unmount()
  })

  it('covers the follow-terminal toggle and a second receive offer (null size, stale timer)', async () => {
    const invoke = vi.fn((_command: string) => {
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    // follow-terminal SFTP toggle off (else branch) → no OSC7 injection
    fireEvent.click(screen.getByRole('button', { name: /文件/ }))
    // two offer handlers on a receive session (second offer clears the stale timer)
    const handlers: Record<string, (..._: unknown[]) => void> = {}
    const session = {
      type: 'receive',
      on: vi.fn((ev: string, h: (..._: unknown[]) => void) => { handlers[ev] = h; return session }),
      start: vi.fn(), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn(),
    }
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    const t0 = { get_details: () => ({ name: 'a', size: null }), get_offset: () => 1, accept: vi.fn().mockResolvedValue([]) }
    const t1 = { get_details: () => ({ name: 'b', size: 50 }), get_offset: () => 25, accept: vi.fn().mockResolvedValue([]) }
    act(() => { handlers.offer!(t0) })
    act(() => { handlers.offer!(t1) }) // second offer swaps the recv timer
    await waitFor(() =>{  expect(zmodemMock.saveToDisk).toHaveBeenCalled() })
    unmount()
  })
  it('covers kb-absent mfa, ssh_exec cwd, sentry sender catch and on_retract', async () => {
    const invoke = vi.fn((command: string, _args?: Record<string, unknown>) => {
      if (command === 'ssh_exec') return Promise.resolve('/srv/work') // pwd fallback → applyCwd
      if (command === 'ssh_write_binary') return Promise.reject(new Error('bin')) // sender catch
      return Promise.resolve(null)
    })
    stubInternals(invoke)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
    // mfa enabled WITHOUT mfaPassword → kb_interactive has no password field
    const kbAsset = { ...asset, config: { ...asset.config, mfaEnabled: true } }
    const { unmount } = render(<SshTerminalOverlay asset={kbAsset} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)) })
    const connectCall = invoke.mock.calls.find(([cmd]) => cmd === 'ssh_connect')!
    expect((connectCall[1]! as { config: { kb_interactive: unknown } }).config.kb_interactive).toEqual({ enabled: true })
    // ssh_exec pwd → applyCwd(254) ; sender catch
    act(() => { zmodemMock.options!.sender!([1]) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_write_binary', { id: 'ssh-1', data: [1] }) })
    // on_retract with a live session → finish; without → finish
    const session = { type: 'send', on: vi.fn(() => session), start: vi.fn(), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn() }
    act(() => { zmodemMock.options!.on_detect!({ confirm: () => session as never, deny: () => {} }) })
    act(() => { zmodemMock.options!.on_retract!() })
    unmount()
  })
})
