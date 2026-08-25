// @vitest-environment jsdom
/**
 * 截图按钮:点击调用 startRegion;失败(浏览器预览 IPC 缺失 / Rust 侧前置
 * 校验失败,如 Linux PipeWire < 1.0)时把错误消息渲染为可见提示
 * (role=alert)并按 4s 自动消失——不再只写 console 让用户无感知。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ScreenshotButton, type ScreenshotButtonProps } from '../src/client/screenshot/ScreenshotButton.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function renderButton(startRegion: () => Promise<void>) {
  // 组件只消费 createDraftImages / startRegion / inputActions(可选);slot 的
  // 必填 share(InputZone + SessionStandardProps)给最小桩——与仓库组件测试
  // 惯例一致(queue-dock spec 同款:直接喂 props 桩,不挂渲染机)。
  const props: ScreenshotButtonProps = {
    createDraftImages: () => [] as readonly ComposerAttachment[],
    startRegion,
    session: undefined as unknown as ScreenshotButtonProps['session'],
    input: undefined as unknown as ScreenshotButtonProps['input'],
    sessionId: 's-1' as unknown as ScreenshotButtonProps['sessionId'],
    useSession: (() => undefined) as unknown as ScreenshotButtonProps['useSession'],
    useProjection: (() => undefined) as unknown as ScreenshotButtonProps['useProjection'],
    useInput: (() => undefined) as unknown as ScreenshotButtonProps['useInput'],
    inputActions: undefined as unknown as ScreenshotButtonProps['inputActions'],
    useSessions: (() => undefined) as unknown as ScreenshotButtonProps['useSessions'],
    useWorkspaces: (() => undefined) as unknown as ScreenshotButtonProps['useWorkspaces'],
  }
  render(<ScreenshotButton {...props} />)
}

describe('ScreenshotButton', () => {
  it('renders the scissors button and keeps no toast on success', async () => {
    const startRegion = vi.fn(() => Promise.resolve())
    renderButton(startRegion)
    fireEvent.click(screen.getByRole('button', { name: '截图' }))
    await waitFor(() => expect(startRegion).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the rejected string message as a visible toast (e.g. Linux PipeWire too old)', async () => {
    const message =
      '截图功能需要系统 PipeWire ≥ 1.0(Ubuntu 24.04 及以上)。当前系统 PipeWire 版本过旧,请升级系统后重试。'
    const startRegion = vi.fn(() => Promise.reject(message))
    renderButton(startRegion)
    fireEvent.click(screen.getByRole('button', { name: '截图' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
  })

  it('shows an Error message from the browser-preview rejection', async () => {
    const startRegion = vi.fn(() =>
      Promise.reject(new Error('Tauri IPC unavailable (browser preview)')),
    )
    renderButton(startRegion)
    fireEvent.click(screen.getByRole('button', { name: '截图' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Tauri IPC unavailable'),
    )
  })

  it('maps a missing/unregistered command (legacy no-screenshot build) to a friendly hint', async () => {
    const startRegion = vi.fn(() => Promise.reject('Command screenshot_begin_region not found'))
    renderButton(startRegion)
    fireEvent.click(screen.getByRole('button', { name: '截图' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('当前版本未编译截图功能'),
    )
  })

  it('auto-dismisses the toast after the duration', async () => {
    vi.useFakeTimers()
    const startRegion = vi.fn(() => Promise.reject('boom'))
    renderButton(startRegion)
    fireEvent.click(screen.getByRole('button', { name: '截图' }))
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toBe('boom')
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})