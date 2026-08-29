// @vitest-environment jsdom
/**
 * 「请求人工介入」横幅(SandboxUserActionBanner):无事件渲染 null;收到
 * starhub://desktop-user-action 弹出横幅,「已完成」/「无法完成」经
 * desktop_user_action_reply 应答并收起。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SandboxUserActionBanner } from '../src/client/sandbox/SandboxUserActionBanner.tsx'

/** 事件回调注册表(transformCallback 捕获)。 */
let eventHandlers: Array<(envelope: { payload: unknown }) => void> = []
let invokeCalls: Array<{ cmd: string; args: unknown }> = []

function stubTauri() {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: unknown }
  }
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      invokeCalls.push({ cmd, args })
      return Promise.resolve(cmd === 'plugin:event|listen' ? 1 : null)
    },
    transformCallback: (cb: (envelope: { payload: unknown }) => void) => {
      eventHandlers.push(cb)
      return eventHandlers.length - 1
    },
  }
}

function fireUserAction(payload: unknown) {
  for (const handler of eventHandlers) handler({ payload })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  eventHandlers = []
  invokeCalls = []
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

const EVENT = {
  requestId: 'r-1',
  sandboxId: 'sb-1',
  containerId: 'c-1',
  novncPort: 6080,
  message: '请扫码登录微信',
  timeoutSeconds: 300,
}

describe('SandboxUserActionBanner', () => {
  it('renders nothing without a pending request', () => {
    stubTauri()
    const { container } = render(<SandboxUserActionBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the banner on the event and replies 已完成', async () => {
    stubTauri()
    render(<SandboxUserActionBanner />)
    await waitFor(() => expect(eventHandlers.length).toBe(1))
    act(() => { fireUserAction(EVENT) })
    expect(screen.getByRole('alertdialog').textContent).toContain('请扫码登录微信')
    fireEvent.click(screen.getByRole('button', { name: '已完成' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_user_action_reply', args: { requestId: 'r-1', done: true } })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('replies 无法完成 on the cancel button', async () => {
    stubTauri()
    render(<SandboxUserActionBanner />)
    await waitFor(() => expect(eventHandlers.length).toBe(1))
    act(() => { fireUserAction(EVENT) })
    fireEvent.click(screen.getByRole('button', { name: '无法完成' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_user_action_reply', args: { requestId: 'r-1', done: false } })
    })
  })

  it('counts down and dismisses at zero', async () => {
    vi.useFakeTimers()
    try {
      stubTauri()
      render(<SandboxUserActionBanner />)
      await act(async () => { await Promise.resolve() })
      act(() => { fireUserAction({ ...EVENT, timeoutSeconds: 1 }) })
      expect(screen.queryByRole('alertdialog')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(1500) })
      expect(screen.queryByRole('alertdialog')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
