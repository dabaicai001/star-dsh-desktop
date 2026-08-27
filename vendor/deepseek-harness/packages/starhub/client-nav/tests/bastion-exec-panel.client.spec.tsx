// @vitest-environment jsdom
/**
 * SSH 命令执行迷你面板组(BastionExecPanel,v0.99.0):所有 ssh_exec 完成后后端
 * 广播通用 `ssh:exec-done`(带 sessionId),右下角为**每个会话连接**展示一块
 * 面板(可同时多块);只接管 `dsh:` 前缀会话;每块可折叠/展开/关闭。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BastionExecPanel } from '../src/client/conn/BastionExecPanel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
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

function makeEvent(sessionId: string, command: string, output: string) {
  return { event: 'ssh:exec-done', id: 1, payload: { sessionId, command, output } }
}

const execEvent = makeEvent('dsh:asset-1:ssh', 'ls -la /var/log', 'total 48\ndmesg')

describe('BastionExecPanel', () => {
  it('shows the latest ssh command output for dsh sessions', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<BastionExecPanel />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'ssh:exec-done', target: { kind: 'Any' } })) })

    callbacks[0]!(execEvent)
    await waitFor(() =>{  expect(screen.getByText('SSH 命令执行')).toBeTruthy() })
    expect(screen.getByText('asset-1')).toBeTruthy()
    expect(screen.getByText('$ ls -la /var/log')).toBeTruthy()
    expect(screen.getByText(/total 48/)).toBeTruthy()
    unmount()
  })

  it('shows multiple panels, one per session connection', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<BastionExecPanel />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })
    callbacks[0]!(makeEvent('dsh:asset-1:ssh', 'ls /a', 'aaa'))
    callbacks[0]!(makeEvent('dsh:asset-2:ssh', 'df -h', 'bbb'))

    await waitFor(() =>{  expect(screen.getByRole('region', { name: 'SSH 命令输出 asset-1' })).toBeTruthy() })
    expect(screen.getByRole('region', { name: 'SSH 命令输出 asset-2' })).toBeTruthy()
    // 各自命令独立展示
    expect(screen.getByText('$ ls /a')).toBeTruthy()
    expect(screen.getByText('$ df -h')).toBeTruthy()

    // 关闭一块,另一块保留
    fireEvent.click(screen.getByLabelText('关闭 asset-1 输出面板'))
    expect(screen.queryByRole('region', { name: 'SSH 命令输出 asset-1' })).toBeNull()
    expect(screen.getByRole('region', { name: 'SSH 命令输出 asset-2' })).toBeTruthy()
    unmount()
  })

  it('ignores non-dsh sessions and stays null', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { queryByText, unmount } = render(<BastionExecPanel />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    callbacks[0]!(makeEvent('asset-1', 'ls', 'x'))
    expect(queryByText('SSH 命令执行')).toBeNull()
    unmount()
  })

  it('collapses and re-expands a panel, and closes it', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<BastionExecPanel />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })
    callbacks[0]!(execEvent)
    await waitFor(() =>{  expect(screen.getByText('SSH 命令执行')).toBeTruthy() })

    fireEvent.click(screen.getByText('▾'))
    expect(screen.queryByText('$ ls -la /var/log')).toBeNull()
    fireEvent.click(screen.getByText('▸'))
    expect(screen.getByText('$ ls -la /var/log')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('关闭 asset-1 输出面板'))
    expect(screen.queryByText('SSH 命令执行')).toBeNull()
    unmount()
  })

  it('returns null in preview mode where tauri internals are absent', () => {
    const { container } = render(<BastionExecPanel />)
    expect(container.firstChild).toBeNull()
  })
})
