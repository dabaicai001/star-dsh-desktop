// @vitest-environment jsdom
/**
 * 主壳 MFA 验证卡:只接管 `dsh:` 前缀会话的通用 `ssh:kb-interactive` 事件,
 * 其余(交互终端 assetId / 测试连接 test-*)不弹窗;输入 TOTP 后经
 * `ssh_kb_response` 回传,提交后清空状态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MfaPromptCard } from '../src/client/mfa/MfaPromptCard.tsx'

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

describe('MfaPromptCard', () => {
  it('prompts for dsh-prefixed sessions and submits answers with the session id', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const { unmount } = render(<MfaPromptCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
      event: 'ssh:kb-interactive',
      target: { kind: 'Any' },
      handler: 1,
    }) })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:kb-interactive', id: 1, payload: {
      sessionId: 'dsh:asset-1:ssh',
      instructions: 'Enter 2FA code',
      prompts: [{ prompt: 'Verification code', echo: false }],
      autoFill: [null],
    } })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    expect(screen.getByText('Enter 2FA code')).toBeTruthy()
    expect(screen.getByText(/AI 连接 asset-1/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '987654' } })
    fireEvent.click(screen.getByText('提交验证码'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_kb_response', { id: 'dsh:asset-1:ssh', responses: ['987654'] }) })
    expect(screen.queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('ignores non-dsh sessions (interactive terminal / test connection) and stays null', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { queryByLabelText, unmount } = render(<MfaPromptCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:kb-interactive', id: 1, payload: {
      sessionId: 'asset-1',
      instructions: '',
      prompts: [{ prompt: 'TOTP', echo: false }],
      autoFill: [null],
    } })
    onEvent({ event: 'ssh:kb-interactive', id: 1, payload: {
      sessionId: 'test-123',
      instructions: '',
      prompts: [{ prompt: 'TOTP', echo: false }],
      autoFill: [null],
    } })
    expect(queryByLabelText('MFA 验证')).toBeNull()
    unmount()
  })

  it('prefills autoFill answers and submits without user edits', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)
    const { unmount } = render(<MfaPromptCard />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalled() })

    const onEvent = callbacks[0]!
    onEvent({ event: 'ssh:kb-interactive', id: 1, payload: {
      sessionId: 'dsh:asset-2:ssh',
      instructions: '',
      prompts: [
        { prompt: 'Password', echo: false },
        { prompt: 'TOTP', echo: false },
      ],
      autoFill: ['pwd', null],
    } })
    await waitFor(() =>{  expect(screen.getByLabelText('MFA 验证')).toBeTruthy() })
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('pwd')
    fireEvent.click(screen.getByText('提交验证码'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('ssh_kb_response', { id: 'dsh:asset-2:ssh', responses: ['pwd', ''] }) })
    unmount()
  })

  it('returns null in preview mode where tauri internals are absent', () => {
    const { container } = render(<MfaPromptCard />)
    expect(container.firstChild).toBeNull()
  })
})