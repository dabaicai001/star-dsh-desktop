// @vitest-environment jsdom
/**
 * 堡垒机「选择机器」浮层(v0.98.7 实时终端):只接管 `dsh:` 前缀会话的通用
 * `ssh:bastion-select` 事件,其余会话不弹浮层;浮层内嵌 xterm 终端,订阅
 * `ssh:bastion-output:<sessionId>` 渲染 pty 输出,键盘输入经 `ssh_write` 回传;
 * 「执行 AI 命令」经 `ssh_bastion_response` 传非空哨兵,「取消」传空串。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// xterm 依赖真实实例在 jsdom 下会因缺 matchMedia 抛错,这里按
// ssh-terminal-overlay 的既有模式打桩,聚焦组件的订阅/回传行为。
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write() {}
    onData() {
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

import { BastionSelectCard } from '../src/client/bastion/BastionSelectCard.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

/** 挂载 Tauri internals:transformCallback 记录监听回调,invoke 记录调用。 */
function stubInternals(callbacks: Array<(event: unknown) => void>, invoke: ReturnType<typeof vi.fn>) {
  ;(window as unknown as {
    __TAURI_INTERNALS__: { invoke: typeof invoke; transformCallback: (cb: (event: unknown) => void) => number }
  }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback) => {
      callbacks.push(callback)
      return callbacks.length
    },
  }
}

describe('BastionSelectCard', () => {
  it('opens for dsh-prefixed sessions and submits the run sentinel on execute', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<BastionSelectCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
      event: 'ssh:bastion-select',
      target: { kind: 'Any' },
      handler: 1,
    }) })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'dsh:asset-1:ssh' } })
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    await waitFor(() =>{  expect(screen.getByText('堡垒机选择机器')).toBeTruthy() })
    expect(screen.getByText(/AI 连接 asset-1/)).toBeTruthy()

    // 终端容器存在;「执行 AI 命令」发送非空哨兵并进入执行中态。
    const runButton = screen.getByText('执行 AI 命令') as HTMLButtonElement
    fireEvent.click(runButton)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_bastion_response', { id: 'dsh:asset-1:ssh', selection: '__run__' }) })
    expect(screen.queryByText('执行中…')).toBeTruthy()
    unmount()
  })

  it('cancel sends an empty selection and closes the overlay', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { unmount } = render(<BastionSelectCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'dsh:asset-2:ssh' } })
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    await waitFor(() =>{  expect(screen.getByText('堡垒机选择机器')).toBeTruthy() })

    fireEvent.click(screen.getByText('取消'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_bastion_response', { id: 'dsh:asset-2:ssh', selection: '' }) })
    expect(screen.queryByText('堡垒机选择机器')).toBeNull()
    unmount()
  })

  it('ignores non-dsh sessions (interactive terminal / test connection) and stays null', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { queryByText, unmount } = render(<BastionSelectCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'asset-1' } })
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'test-123' } })
    expect(queryByText('堡垒机选择机器')).toBeNull()
    unmount()
  })

  it('returns null without tauri internals (preview)', () => {
    const { container } = render(<BastionSelectCard />)
    expect(container.firstChild).toBeNull()
  })
})
