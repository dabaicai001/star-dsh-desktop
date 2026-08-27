// @vitest-environment jsdom
/**
 * 堡垒机静默执行迷你面板(BastionExecPanel,v0.99.0 功能②):复用路径命令不弹
 * 「选机器」浮层,本面板订阅通用 `ssh:bastion-exec`(带 sessionId),右下角
 * 展示最近一次命令输出;只接管 `dsh:` 前缀会话;可折叠/展开/关闭。
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

const execEvent = {
  event: 'ssh:bastion-exec',
  id: 1,
  payload: {
    sessionId: 'dsh:asset-1:ssh',
    command: 'ls -la /var/log',
    output: 'total 48\ndrwxr-xr-x 2 root root 4096 Aug 27 11:00 .\ndmesg',
  },
}

describe('BastionExecPanel', () => {
  it('shows the latest bastion command output for dsh sessions', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<BastionExecPanel />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'ssh:bastion-exec', target: { kind: 'Any' } })) })

    callbacks[0]!(execEvent)
    await waitFor(() =>{  expect(screen.getByText('堡垒机静默执行')).toBeTruthy() })
    expect(screen.getByText('asset-1')).toBeTruthy()
    expect(screen.getByText('$ ls -la /var/log')).toBeTruthy()
    expect(screen.getByText(/total 48/)).toBeTruthy()
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

    callbacks[0]!({ ...execEvent, payload: { ...execEvent.payload, sessionId: 'asset-1' } })
    expect(queryByText('堡垒机静默执行')).toBeNull()
    unmount()
  })

  it('collapses and re-expands the body, and closes the panel', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<BastionExecPanel />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })
    callbacks[0]!(execEvent)
    await waitFor(() =>{  expect(screen.getByText('堡垒机静默执行')).toBeTruthy() })

    // 折叠:命令输出隐藏
    fireEvent.click(screen.getByText('▾'))
    expect(screen.queryByText('$ ls -la /var/log')).toBeNull()
    // 展开:输出恢复
    fireEvent.click(screen.getByText('▸'))
    expect(screen.getByText('$ ls -la /var/log')).toBeTruthy()
    // 关闭:面板消失
    fireEvent.click(screen.getByLabelText('关闭输出面板'))
    expect(screen.queryByText('堡垒机静默执行')).toBeNull()
    unmount()
  })

  it('returns null in preview mode where tauri internals are absent', () => {
    const { container } = render(<BastionExecPanel />)
    expect(container.firstChild).toBeNull()
  })
})
