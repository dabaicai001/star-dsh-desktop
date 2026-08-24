// @vitest-environment jsdom
/**
 * 截图按钮:点击调用 startRegion;失败(浏览器预览 IPC 缺失 / Rust 侧前置
 * 校验失败,如 Linux PipeWire < 1.0)时把错误消息渲染为可见提示
 * (role=alert)并按 4s 自动消失——不再只写 console 让用户无感知。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ScreenshotButton } from '../src/client/screenshot/ScreenshotButton.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function renderButton(startRegion: () => Promise<void>) {
  render(
    <ScreenshotButton
      createDraftImages={() => [] as readonly ComposerAttachment[]}
      startRegion={startRegion}
    />,
  )
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