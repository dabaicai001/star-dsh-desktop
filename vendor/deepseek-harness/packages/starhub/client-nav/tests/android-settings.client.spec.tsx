// @vitest-environment jsdom
/**
 * 设置「Android 设备」tab(settings/android.tsx):加载当前 adb 路径配置与实际
 * 解析值,保存经 android_ui_set_adb_path;空值 = 清除(回落自动探测)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AndroidSettingsTab } from '../src/client/settings/android.tsx'

let invokeCalls: Array<{ cmd: string; args: unknown }> = []

function stubTauri(config: unknown) {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      invokeCalls.push({ cmd, args })
      if (cmd === 'android_ui_get_config') return Promise.resolve(config)
      return Promise.resolve(null)
    },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invokeCalls = []
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('AndroidSettingsTab', () => {
  it('loads the configured adb path and resolved value', async () => {
    stubTauri({ adbPath: 'D:\\tools\\adb.exe', resolvedAdb: 'D:\\tools\\adb.exe' })
    render(<AndroidSettingsTab />)
    const input = await screen.findByPlaceholderText(/adb\.exe/) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('D:\\tools\\adb.exe'))
    expect(screen.getByText(/当前生效:D:\\tools\\adb\.exe/)).toBeTruthy()
  })

  it('saves the path via android_ui_set_adb_path and shows 已保存', async () => {
    stubTauri({ adbPath: null, resolvedAdb: null })
    render(<AndroidSettingsTab />)
    const input = await screen.findByPlaceholderText(/adb\.exe/)
    fireEvent.change(input, { target: { value: 'C:\\platform-tools\\adb.exe' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        cmd: 'android_ui_set_adb_path',
        args: { path: 'C:\\platform-tools\\adb.exe' },
      })
    })
    expect(screen.getByText('已保存。')).toBeTruthy()
  })

  it('clears the setting when saved empty (自动探测回落)', async () => {
    stubTauri({ adbPath: 'D:\\tools\\adb.exe', resolvedAdb: 'D:\\tools\\adb.exe' })
    render(<AndroidSettingsTab />)
    const input = await screen.findByPlaceholderText(/adb\.exe/) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('D:\\tools\\adb.exe'))
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'android_ui_set_adb_path', args: { path: null } })
    })
  })

  it('surfaces save failures', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        if (cmd === 'android_ui_get_config') return Promise.resolve({ adbPath: null, resolvedAdb: null })
        return Promise.reject(new Error('adb 路径不存在或不是文件'))
      },
    }
    render(<AndroidSettingsTab />)
    const input = await screen.findByPlaceholderText(/adb\.exe/)
    fireEvent.change(input, { target: { value: 'D:\\nope\\adb.exe' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByText('adb 路径不存在或不是文件')).toBeTruthy())
  })

  it('shows load failure when config fetch rejects', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('Tauri IPC unavailable (browser preview)')) }
    render(<AndroidSettingsTab />)
    await waitFor(() => expect(screen.getByText(/browser preview/)).toBeTruthy())
  })
})
