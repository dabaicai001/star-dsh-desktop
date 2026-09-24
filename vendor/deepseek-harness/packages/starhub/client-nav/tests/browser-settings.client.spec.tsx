// @vitest-environment jsdom
/**
 * 设置「AI 浏览器」tab(settings/browser.tsx):引擎 + Jev 决策配置。
 * 核心行为:全部字段都是本地草稿,只有点击底部唯一的「保存」才经
 * browser_set_engine / browser_set_jev_config 落库;API key 走 keyring,
 * 保留独立的「保存密钥 / 删除密钥」按钮。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserSettingsTab } from '../src/client/settings/browser.tsx'

/** jsdom 全局下的 Tauri IPC stub:按命令返回 map 里的值,记录全部调用。 */
function stubTauriInternals(handlers: Record<string, (args?: unknown) => unknown>): {
  calls: Array<{ cmd: string; args: unknown }>
  restore: () => void
} {
  const calls: Array<{ cmd: string; args: unknown }> = []
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      const handler = handlers[cmd]
      if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${cmd}`))
      // 包一层异步调用:handler 的同步 throw 转成 rejection(真实 IPC 也是拒绝)
      return (async () => handler(args))()
    },
  }
  return {
    calls,
    restore: () => {
      if (prev === undefined) {
        delete w.__TAURI_INTERNALS__
      } else {
        w.__TAURI_INTERNALS__ = prev
      }
    },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('BrowserSettingsTab', () => {
  it('loads the persisted engine, Jev config and key presence', async () => {
    const { restore } = stubTauriInternals({
      browser_get_engine: () => 'obscura',
      browser_get_jev_config: () => ({
        enabled: true, baseUrl: 'https://gateway.internal', model: 'jev-pro', threshold: 0.8, timeoutMs: 15000,
      }),
      get_ai_model_api_key: () => 'secret',
    })
    try {
      render(<BrowserSettingsTab />)
      const select = await screen.findByRole('combobox') as HTMLSelectElement
      expect(select.value).toBe('obscura')
      expect((screen.getByDisplayValue('https://gateway.internal') as HTMLInputElement).value).toBe('https://gateway.internal')
      expect((screen.getByDisplayValue('jev-pro') as HTMLInputElement).value).toBe('jev-pro')
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
      expect(screen.getByText('已配置')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('persists nothing until the single 保存 button is clicked', async () => {
    const { calls, restore } = stubTauriInternals({
      browser_get_engine: () => 'webview',
      browser_get_jev_config: () => null,
      get_ai_model_api_key: () => { throw new Error('missing') },
    })
    try {
      render(<BrowserSettingsTab />)
      await screen.findByRole('combobox')
      await act(async () => { await Promise.resolve() })
      // 唯一的保存入口:tab 内只有一个「保存」(密钥区是「保存密钥 / 删除密钥」)
      expect(screen.getAllByText('保存')).toHaveLength(1)
      expect(screen.queryByText('保存配置')).toBeNull()
      // 改引擎 / 改 Jev 字段 → 仅本地草稿,不触发任何写命令
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'obscura' } })
      fireEvent.change(screen.getByDisplayValue('https://api.typesafe.ai'), { target: { value: 'https://gateway.internal' } })
      fireEvent.change(screen.getByDisplayValue('jev-latest'), { target: { value: 'jev-pro' } })
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.change(screen.getAllByRole('spinbutton')[0]!, { target: { value: '0.9' } })
      fireEvent.change(screen.getAllByRole('spinbutton')[1]!, { target: { value: '20000' } })
      await act(async () => { await Promise.resolve() })
      expect(calls.filter(c => c.cmd === 'browser_set_engine' || c.cmd === 'browser_set_jev_config')).toHaveLength(0)
      // 未保存提示
      expect(screen.getByText(/有未保存的修改/)).toBeTruthy()
      expect(screen.queryByText('已保存。')).toBeNull()
    } finally {
      restore()
    }
  })

  it('writes engine and Jev config together on 保存 and clears the dirty hint', async () => {
    const setEngine = vi.fn((..._args: unknown[]) => null)
    const setJev = vi.fn((..._args: unknown[]) => null)
    const { restore } = stubTauriInternals({
      browser_get_engine: () => 'webview',
      browser_get_jev_config: () => null,
      get_ai_model_api_key: () => { throw new Error('missing') },
      browser_set_engine: args => setEngine(args),
      browser_set_jev_config: args => setJev(args),
    })
    try {
      render(<BrowserSettingsTab />)
      await screen.findByRole('combobox')
      await act(async () => { await Promise.resolve() })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'obscura' } })
      fireEvent.change(screen.getByDisplayValue('https://api.typesafe.ai'), { target: { value: '  https://gateway.internal  ' } })
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByText('保存'))
      await waitFor(() => { expect(setEngine).toHaveBeenCalledTimes(1) })
      expect(setEngine).toHaveBeenCalledWith({ engine: 'obscura' })
      expect(setJev).toHaveBeenCalledWith({
        enabled: true,
        baseUrl: 'https://gateway.internal', // 首尾空白被 trim
        model: 'jev-latest',
        threshold: 0.6,
        timeoutMs: 8000,
      })
      expect(screen.getByText('已保存。')).toBeTruthy()
      expect(screen.queryByText(/有未保存的修改/)).toBeNull()
    } finally {
      restore()
    }
  })

  it('keeps the dirty state and surfaces the error when 保存 fails', async () => {
    const { restore } = stubTauriInternals({
      browser_get_engine: () => 'webview',
      browser_get_jev_config: () => null,
      get_ai_model_api_key: () => { throw new Error('missing') },
      browser_set_engine: () => { throw new Error('disk full') },
      browser_set_jev_config: () => null,
    })
    try {
      render(<BrowserSettingsTab />)
      await screen.findByRole('combobox')
      await act(async () => { await Promise.resolve() })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'obscura' } })
      fireEvent.click(screen.getByText('保存'))
      expect(await screen.findByText('disk full')).toBeTruthy()
      expect(screen.queryByText('已保存。')).toBeNull()
      expect(screen.getByText(/有未保存的修改/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('saves and deletes the Jev API key through the keyring commands', async () => {
    const setKey = vi.fn((..._args: unknown[]) => null)
    const deleteKey = vi.fn((..._args: unknown[]) => null)
    const { restore } = stubTauriInternals({
      browser_get_engine: () => 'webview',
      browser_get_jev_config: () => null,
      get_ai_model_api_key: () => 'secret',
      set_ai_model_api_key: args => setKey(args),
      delete_ai_model_api_key: args => deleteKey(args),
    })
    try {
      render(<BrowserSettingsTab />)
      await screen.findByRole('combobox')
      await act(async () => { await Promise.resolve() })
      const keyInput = screen.getByPlaceholderText('已配置,输入新值可覆盖')
      // 草稿为空 → 保存密钥禁用
      expect(screen.getByText('保存密钥').getAttribute('disabled')).not.toBeNull()
      fireEvent.change(keyInput, { target: { value: ' sk-new ' } })
      fireEvent.click(screen.getByText('保存密钥'))
      await waitFor(() => { expect(setKey).toHaveBeenCalledTimes(1) })
      expect(setKey).toHaveBeenCalledWith({ id: 'jev', value: 'sk-new' })
      // 删除密钥独立于底部「保存」
      fireEvent.click(screen.getByText('删除密钥'))
      await waitFor(() => { expect(deleteKey).toHaveBeenCalledTimes(1) })
      expect(deleteKey).toHaveBeenCalledWith({ id: 'jev' })
      expect(screen.queryByText('未配置')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows the load failure banner without a Tauri bridge', async () => {
    render(<BrowserSettingsTab />)
    expect(await screen.findByText(/Tauri IPC unavailable/)).toBeTruthy()
  })
})
