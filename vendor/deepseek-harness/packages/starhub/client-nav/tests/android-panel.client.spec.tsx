// @vitest-environment jsdom
/**
 * Android 实体机面板(AndroidPanel):设备列表加载/错误/预览/空态、
 * 状态徽标(unauthorized/offline 提示)、就绪设备「打开直播」命令契约。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AndroidPanel } from '../src/client/android/AndroidPanel.tsx'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

let invokeCalls: Array<{ cmd: string; args: unknown }> = []
let invokeResult: (cmd: string) => unknown = () => null

/** 安装宿主桥 invoke 替身:记录调用并按 invokeResult 返回。 */
function stubTauri() {
  stubHostBridge((cmd, args) => {
    invokeCalls.push({ cmd, args })
    return Promise.resolve(invokeResult(cmd))
  })
}

/** 模拟无宿主桥:移除 fetch 使 isTauriRuntime() 为 false(替代旧「无 Tauri internals」预览态)。 */
function withoutHostBridge<T>(run: () => T): T {
  const original = globalThis.fetch
  Reflect.deleteProperty(globalThis, 'fetch')
  try {
    return run()
  } finally {
    globalThis.fetch = original
  }
}

const READY = { serial: '303d7c9b', state: 'device', model: 'Xiaomi 14' }
const UNAUTH = { serial: 'emulator-5554', state: 'unauthorized', model: '' }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invokeCalls = []
  invokeResult = () => null
  restoreHostBridge()
})

async function renderPanel(devices: unknown = [READY]) {
  invokeResult = () => devices
  stubTauri()
  render(<AndroidPanel />)
  await waitFor(() => expect(screen.queryByText('加载设备…')).toBeNull())
}

describe('AndroidPanel', () => {
  it('shows loading then the device cards', async () => {
    await renderPanel()
    expect(screen.getByText('Xiaomi 14')).toBeTruthy()
    expect(screen.getByText(/303d7c9b · 就绪/)).toBeTruthy()
    expect(invokeCalls[0]).toEqual({ cmd: 'android_ui_list_devices', args: {} })
  })

  it('shows the error banner and retries on failure', async () => {
    invokeResult = () => Promise.reject(new Error('adb 命令超时(15s)'))
    stubTauri()
    render(<AndroidPanel />)
    await waitFor(() => expect(screen.getByText(/设备列表不可用/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() => {
      expect(invokeCalls.filter(c => c.cmd === 'android_ui_list_devices').length).toBe(2)
    })
  })

  it('falls into the preview hint without a host bridge', async () => {
    withoutHostBridge(() => { render(<AndroidPanel />) })
    await waitFor(() => expect(screen.getByText(/浏览器里/)).toBeTruthy())
  })

  it('shows the empty-state guide when no device is attached', async () => {
    await renderPanel([])
    expect(screen.getByText(/未发现设备/)).toBeTruthy()
  })

  it('offers 打开直播 only for ready devices and shows hints otherwise', async () => {
    await renderPanel([READY, UNAUTH])
    expect(screen.getByText(/允许 USB 调试/)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: '打开直播' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'android_ui_open_live', args: { serial: READY.serial } })
    })
  })

  it('surfaces live-window errors in the banner', async () => {
    stubTauri()
    invokeResult = (cmd) => {
      if (cmd === 'android_ui_open_live') return Promise.reject(new Error('创建直播窗口失败:boom'))
      return [READY]
    }
    render(<AndroidPanel />)
    await waitFor(() => expect(screen.queryByText('加载设备…')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '打开直播' }))
    await waitFor(() => expect(screen.getByText(/创建直播窗口失败/)).toBeTruthy())
  })
})
