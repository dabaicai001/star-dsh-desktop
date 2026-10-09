// @vitest-environment jsdom
/**
 * 「请求人工介入」横幅(SandboxUserActionBanner):无事件渲染 null;收到
 * starhub://desktop-user-action 弹出横幅,「打开直播画面」拉起接管窗口,
 * 「已完成」/「无法完成」经 desktop_user_action_reply 应答并收起。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SandboxUserActionBanner } from '../src/client/sandbox/SandboxUserActionBanner.tsx'
import {
  emitHostEvent, hostEventListeners, restoreHostBridge, restoreHostEvents, stubHostBridge, stubHostEvents,
} from './host-bridge.ts'

const USER_ACTION_EVENT = 'starhub://desktop-user-action'

let invokeCalls: Array<{ cmd: string; args: unknown }> = []

/** 安装宿主桥 invoke 替身 + 假事件流:记录调用,事件订阅走 SSE。 */
function stubTauri() {
  stubHostBridge((cmd, args) => {
    invokeCalls.push({ cmd, args })
    return Promise.resolve(null)
  })
  stubHostEvents()
}

function fireUserAction(payload: unknown) {
  emitHostEvent(USER_ACTION_EVENT, payload)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invokeCalls = []
  restoreHostBridge()
  restoreHostEvents()
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
    await waitFor(() => expect(hostEventListeners(USER_ACTION_EVENT)).toBe(1))
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
    await waitFor(() => expect(hostEventListeners(USER_ACTION_EVENT)).toBe(1))
    act(() => { fireUserAction(EVENT) })
    fireEvent.click(screen.getByRole('button', { name: '无法完成' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_user_action_reply', args: { requestId: 'r-1', done: false } })
    })
  })

  it('opens the takeover live window via 打开直播画面', async () => {
    stubTauri()
    render(<SandboxUserActionBanner />)
    await waitFor(() => expect(hostEventListeners(USER_ACTION_EVENT)).toBe(1))
    act(() => { fireUserAction(EVENT) })
    fireEvent.click(screen.getByRole('button', { name: '打开直播画面' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        cmd: 'desktop_ui_open_live_window',
        args: { sandboxId: 'sb-1', containerId: 'c-1', novncPort: 6080, takeover: true },
      })
    })
    // 开窗不收起横幅,倒计时/应答按钮仍可用
    expect(screen.queryByRole('alertdialog')).not.toBeNull()
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
