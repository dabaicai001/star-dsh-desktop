// @vitest-environment jsdom
/**
 * 主壳 AI 连接卡(StarHubConnCard,v0.99.0 整体重构):合并 MFA 验证与堡垒机
 * 选机器为一张统一卡。核心回归点:
 * - 只接管 `dsh:` 前缀会话(交互终端 assetId / 测试连接 test-* 不弹窗);
 * - 组件级监听结束信号 `ssh:bastion-done`(通用,payload sessionId),不随
 *   浮层重挂载丢失——修复「命令已执行但按钮卡在『执行中…』、浮层不关」;
 * - `ssh_bastion_response` 失败不再静默:复位按钮并提示;
 * - 互斥:同一时刻至多一张卡,新请求顶掉旧卡。
 * IPC 走宿主桥 invoke 替身,事件订阅走共享 SSE 连接(emitHostEvent 派发)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StarHubConnCard } from '../src/client/conn/StarHubConnCard.tsx'
import {
  emitHostEvent, hostEventListeners, restoreHostBridge, restoreHostEvents, stubHostBridge, stubHostEvents,
  type HostBridgeHandler,
} from './host-bridge.ts'

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
  restoreHostBridge()
  restoreHostEvents()
})

/** 挂载宿主桥替身:invoke 记录调用,事件订阅走共享 SSE 连接。 */
function stubInternals(invoke: HostBridgeHandler) {
  stubHostBridge(invoke)
  stubHostEvents()
}

const kbPayload = {
  sessionId: 'dsh:asset-1:ssh',
  instructions: 'Enter 2FA code',
  prompts: [{ prompt: 'Verification code', echo: false }],
  autoFill: [null],
}

describe('StarHubConnCard', () => {
  it('prompts MFA for dsh sessions and submits answers via ssh_kb_response', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    stubInternals(invoke)

    const { unmount } = render(<StarHubConnCard />)
    // 三个通用事件各订阅一次(共享 SSE 连接按事件名监听)。
    await waitFor(() => {
      expect(hostEventListeners('ssh:kb-interactive')).toBe(1)
      expect(hostEventListeners('ssh:bastion-select')).toBe(1)
      expect(hostEventListeners('ssh:bastion-done')).toBe(1)
    })
    emitHostEvent('ssh:kb-interactive', kbPayload)
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
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    stubInternals(invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(hostEventListeners('ssh:kb-interactive')).toBe(1) })
    emitHostEvent('ssh:kb-interactive', kbPayload)
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    // 精确 connected 监听按当前 mfa 卡 sessionId 订阅(事件名带 sessionId)。
    await waitFor(() =>{  expect(hostEventListeners('ssh:mfa-connected:dsh:asset-1:ssh')).toBe(1) })
    emitHostEvent('ssh:mfa-connected:dsh:asset-1:ssh', { sessionId: 'dsh:asset-1:ssh' })
    await waitFor(() =>{  expect(screen.getByText(/连接成功/)).toBeTruthy() })
    expect(screen.getByText(/会话可复用/)).toBeTruthy()
    fireEvent.click(screen.getByText('完成'))
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('opens the bastion terminal on ssh:bastion-select and closes on generic ssh:bastion-done', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    stubInternals(invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(hostEventListeners('ssh:bastion-select')).toBe(1) })

    emitHostEvent('ssh:bastion-select', { sessionId: 'dsh:asset-1:ssh' })
    await waitFor(() =>{  expect(screen.getByLabelText('堡垒机选择机器')).toBeTruthy() })
    expect(screen.getByText(/AI 连接 asset-1 需选择目标机器/)).toBeTruthy()

    // 组件级通用 done 事件(带 sessionId)到达即关闭浮层,不依赖浮层重挂载。
    emitHostEvent('ssh:bastion-done', { sessionId: 'dsh:asset-1:ssh' })
    await waitFor(() =>{  expect(screen.queryByLabelText('堡垒机选择机器')).toBeNull() })
    unmount()
  })

  it('resets the button and shows an error when ssh_bastion_response fails (no silent stuck)', async () => {
    const invoke = vi.fn((command: string) => {
      if (command === 'ssh_bastion_response') return Promise.reject(new Error('No pending bastion prompt'))
      return Promise.resolve(null)
    })
    stubInternals(invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(hostEventListeners('ssh:bastion-select')).toBe(1) })
    emitHostEvent('ssh:bastion-select', { sessionId: 'dsh:asset-1:ssh' })
    await waitFor(() =>{  expect(screen.getByLabelText('堡垒机选择机器')).toBeTruthy() })

    fireEvent.click(screen.getByText('执行 AI 命令'))
    await waitFor(() =>{  expect(screen.getByText(/通知后端失败/)).toBeTruthy() })
    // 按钮复位,可再次点击。
    expect(screen.getByText<HTMLButtonElement>('执行 AI 命令').disabled).toBe(false)
    unmount()
  })

  it('new request replaces the previous card (mutual exclusion)', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    stubInternals(invoke)

    const { unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(hostEventListeners('ssh:bastion-select')).toBe(1) })
    emitHostEvent('ssh:kb-interactive', kbPayload)
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    emitHostEvent('ssh:bastion-select', { sessionId: 'dsh:asset-2:ssh' })
    await waitFor(() =>{  expect(screen.getByLabelText('堡垒机选择机器')).toBeTruthy() })
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('ignores non-dsh sessions and stays null', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    stubInternals(invoke)
    const { queryByLabelText, unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(hostEventListeners('ssh:bastion-select')).toBe(1) })

    emitHostEvent('ssh:kb-interactive', { ...kbPayload, sessionId: 'asset-1' })
    emitHostEvent('ssh:bastion-select', { sessionId: 'test-123' })
    expect(queryByLabelText('MFA 验证')).toBeNull()
    expect(queryByLabelText('堡垒机选择机器')).toBeNull()
    unmount()
  })

  it('suppresses cards the assistant panel already owns', async () => {
    // 助手面板接管的连接(MFA/堡垒机卡在面板内应答):壳内卡不重复弹。
    // active-conns 查询走同源助手路由,invoke 仍走宿主桥。
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    const combinedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const path = url.replace(/^https?:\/\/[^/]+/, '')
      const envelope = (body: unknown, status = 200): Response => {
        const text = JSON.stringify(body)
        if (typeof Response === 'function') {
          return new Response(text, { status, headers: { 'content-type': 'application/json' } })
        }
        return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) as unknown } as unknown as Response
      }
      if (path === '/starhub/api/invoke') {
        const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) as { cmd?: string } : {}
        return envelope({ ok: true, result: await invoke(parsed.cmd ?? '') })
      }
      if (path === '/starhub/api/assistant/active-conns') {
        return envelope({ ok: true, result: { conns: ['dsh:asset-1:ssh'] } })
      }
      return envelope({ ok: false, error: 'unmatched' }, 404)
    }
    stubHostEvents()
    vi.stubGlobal('fetch', combinedFetch)
    const { queryByLabelText, unmount } = render(<StarHubConnCard />)
    await waitFor(() =>{  expect(hostEventListeners('ssh:kb-interactive')).toBe(1) })

    emitHostEvent('ssh:kb-interactive', kbPayload)
    // 抑制生效:壳内不弹卡(等一个宏任务让 active-conns 查询落定)。
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(queryByLabelText('MFA 验证')).toBeNull()

    // 未被接管的会话照旧弹卡。
    emitHostEvent('ssh:kb-interactive', { ...kbPayload, sessionId: 'dsh:asset-9:ssh' })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    unmount()
    vi.unstubAllGlobals()
  })

  it('returns null in preview mode where the host bridge is absent', () => {
    const { container } = render(<StarHubConnCard />)
    expect(container.firstChild).toBeNull()
  })
})
