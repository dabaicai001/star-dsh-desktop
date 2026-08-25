// @vitest-environment jsdom
/**
 * 堡垒机「选择机器」浮层:只接管 `dsh:` 前缀会话的通用 `ssh:bastion-select` 事件,
 * 其余会话不弹浮层;显示堡垒机菜单,用户输入目标机器项后经 `ssh_bastion_response`
 * 回传,提交后清空状态;空选择禁用提交。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BastionSelectCard } from '../src/client/bastion/BastionSelectCard.tsx'

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

describe('BastionSelectCard', () => {
  it('prompts for dsh-prefixed sessions, shows the menu, and submits the selection', async () => {
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
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: {
      sessionId: 'dsh:asset-1:ssh',
      menu: "1) web-1\n2) db-1\n请选择:",
    } })
    await waitFor(() =>{  expect(screen.getByText('堡垒机选择机器')).toBeTruthy() })
    expect(screen.getByText(/AI 连接 asset-1/)).toBeTruthy()
    expect(screen.getByText(/1\) web-1/)).toBeTruthy()

    const input = screen.getByLabelText('目标机器（输入菜单中的序号或名称）') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.click(screen.getByText('确认并继续'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_bastion_response', { id: 'dsh:asset-1:ssh', selection: '2' }) })
    expect(screen.queryByText('堡垒机选择机器')).toBeNull()
    unmount()
  })

  it('disabled submit until a non-empty selection is entered; Escape-empty cancels', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { unmount } = render(<BastionSelectCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: {
      sessionId: 'dsh:asset-2:ssh',
      menu: '1) a\n2) b\n请选择:',
    } })
    await waitFor(() =>{  expect(screen.getByText('堡垒机选择机器')).toBeTruthy() })
    expect((screen.getByText('确认并继续') as HTMLButtonElement).disabled).toBe(true)

    // 空选择点「取消」→ 回传空字符串(表示未选择)
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_bastion_response', { id: 'dsh:asset-2:ssh', selection: '' }) })
    unmount()
  })

  it('sends the selection on Enter in the input field', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { unmount } = render(<BastionSelectCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: {
      sessionId: 'dsh:asset-3:ssh',
      menu: '1) a\n请选择:',
    } })
    await waitFor(() =>{  expect(screen.getByText('堡垒机选择机器')).toBeTruthy() })
    const input = screen.getByLabelText('目标机器（输入菜单中的序号或名称）') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_bastion_response', { id: 'dsh:asset-3:ssh', selection: '1' }) })
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
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'asset-1', menu: '1) a\n请选择:' } })
    onEvent({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'test-123', menu: '1) a\n请选择:' } })
    expect(queryByText('堡垒机选择机器')).toBeNull()
    unmount()
  })

  it('returns null without tauri internals (preview)', () => {
    const { container } = render(<BastionSelectCard />)
    expect(container.firstChild).toBeNull()
  })
})
