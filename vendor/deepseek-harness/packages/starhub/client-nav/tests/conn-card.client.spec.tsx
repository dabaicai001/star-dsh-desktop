// @vitest-environment jsdom
/**
 * 主壳 AI 连接卡(StarHubConnCard,v0.99.0 整体重构):合并 MFA 验证与堡垒机
 * 选机器为一张统一卡。核心回归点:
 * - 只接管 `dsh:` 前缀会话(交互终端 assetId / 测试连接 test-* 不弹窗);
 * - 组件级监听结束信号 `ssh:bastion-done`(通用,payload sessionId),不随
 *   浮层重挂载丢失——修复「命令已执行但按钮卡在『执行中…』、浮层不关」;
 * - `ssh_bastion_response` 失败不再静默:复位按钮并提示;
 * - 互斥:同一时刻至多一张卡,新请求顶掉旧卡。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StarHubConnCard } from '../src/client/conn/StarHubConnCard.tsx'

beforeEach(() => {
  // xterm 在 jsdom 下依赖 matchMedia(DPR 探测)与 ResizeObserver(fit 布局),
  // vitest 环境均未提供。
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: MockResizeObserver,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
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

const kbPayload = {
  sessionId: 'dsh:asset-1:ssh',
  instructions: 'Enter 2FA code',
  prompts: [{ prompt: 'Verification code', echo: false }],
  autoFill: [null],
}

describe('StarHubConnCard', () => {
  it('prompts MFA for dsh sessions and submits answers via ssh_kb_response', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<StarHubConnCard />)
    // plugin:event|listen 的 handler 是每次注册递增的 callback id,只断言事件名与 target。
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'ssh:kb-interactive', target: { kind: 'Any' } })) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'ssh:bastion-select', target: { kind: 'Any' } })) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'ssh:bastion-done', target: { kind: 'Any' } })) })

    callbacks[0]!({ event: 'ssh:kb-interactive', id: 1, payload: kbPayload })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    expect(screen.getByText('Enter 2FA code')).toBeTruthy()
    expect(screen.getByText(/AI 连接 asset-1/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '987654' } })
    fireEvent.click(screen.getByText('提交'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_kb_response', { id: 'dsh:asset-1:ssh', responses: ['987654'] }) })
    // 提交后卡仍展示等待后端连接成功信号(可能有第二轮 MFA)。
    expect(screen.getByLabelText('MFA 验证')).toBeTruthy()
    unmount()
  })

  it('shows connected feedback when ssh:mfa-connected arrives, then closes on 完成', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })
    callbacks[0]!({ event: 'ssh:kb-interactive', id: 1, payload: kbPayload })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    // 精确 connected 监听是 mfa 卡挂载后的最后一个 listen。
    const connectedEvent = callbacks[callbacks.length - 1]!
    connectedEvent({ event: 'ssh:mfa-connected:dsh:asset-1:ssh', id: 2, payload: { sessionId: 'dsh:asset-1:ssh' } })
    await waitFor(() =>{  expect(screen.getByText(/连接成功/)).toBeTruthy() })
    expect(screen.getByText(/会话可复用/)).toBeTruthy()
    fireEvent.click(screen.getByText('完成'))
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('opens the bastion terminal on ssh:bastion-select and closes on generic ssh:bastion-done', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    // bastion-select 是第 2 个注册的通用监听。
    const bastionSelect = callbacks[1]!
    bastionSelect({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'dsh:asset-1:ssh' } })
    await waitFor(() =>{  expect(screen.getByLabelText('堡垒机选择机器')).toBeTruthy() })
    expect(screen.getByText(/AI 连接 asset-1 需选择目标机器/)).toBeTruthy()

    // 组件级通用 done 事件(带 sessionId)到达即关闭浮层,不依赖浮层重挂载。
    const bastionDone = callbacks[2]!
    bastionDone({ event: 'ssh:bastion-done', id: 1, payload: { sessionId: 'dsh:asset-1:ssh' } })
    await waitFor(() =>{  expect(screen.queryByLabelText('堡垒机选择机器')).toBeNull() })
    unmount()
  })

  it('resets the button and shows an error when ssh_bastion_response fails (no silent stuck)', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'ssh_bastion_response') return Promise.reject(new Error('No pending bastion prompt'))
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })
    callbacks[1]!({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'dsh:asset-1:ssh' } })
    await waitFor(() =>{  expect(screen.getByLabelText('堡垒机选择机器')).toBeTruthy() })

    fireEvent.click(screen.getByText('执行 AI 命令'))
    await waitFor(() =>{  expect(screen.getByText(/通知后端失败/)).toBeTruthy() })
    // 按钮复位,可再次点击。
    expect((screen.getByText('执行 AI 命令') as HTMLButtonElement).disabled).toBe(false)
    unmount()
  })

  it('new request replaces the previous card (mutual exclusion)', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })
    callbacks[0]!({ event: 'ssh:kb-interactive', id: 1, payload: kbPayload })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    callbacks[1]!({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'dsh:asset-2:ssh' } })
    await waitFor(() =>{  expect(screen.getByLabelText('堡垒机选择机器')).toBeTruthy() })
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('ignores non-dsh sessions and stays null', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { queryByLabelText, unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    callbacks[0]!({ event: 'ssh:kb-interactive', id: 1, payload: { ...kbPayload, sessionId: 'asset-1' } })
    callbacks[1]!({ event: 'ssh:bastion-select', id: 1, payload: { sessionId: 'test-123' } })
    expect(queryByLabelText('MFA 验证')).toBeNull()
    expect(queryByLabelText('堡垒机选择机器')).toBeNull()
    unmount()
  })

  it('returns null in preview mode where tauri internals are absent', () => {
    const { container } = render(<StarHubConnCard />)
    expect(container.firstChild).toBeNull()
  })
})
