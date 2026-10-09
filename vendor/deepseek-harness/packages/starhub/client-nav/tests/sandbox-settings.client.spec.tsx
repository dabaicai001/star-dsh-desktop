// @vitest-environment jsdom
/**
 * 设置「沙箱平台」tab(settings/sandbox.tsx):加载当前平台与 Docker 资产候选,
 * 选择变化经 desktop_ui_set_platform 保存;空值 = 本机默认。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SandboxSettingsTab } from '../src/client/settings/sandbox.tsx'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

let invokeCalls: Array<{ cmd: string; args: unknown }> = []

/** 安装宿主桥 invoke 替身:overview / get_assets 分别返回,其余 null。 */
function stubTauri(overview: unknown, assets: unknown) {
  stubHostBridge((cmd, args) => {
    invokeCalls.push({ cmd, args })
    if (cmd === 'desktop_ui_overview') return Promise.resolve(overview)
    if (cmd === 'get_assets') return Promise.resolve(assets)
    return Promise.resolve(null)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invokeCalls = []
  restoreHostBridge()
})

describe('SandboxSettingsTab', () => {
  it('loads the current platform and docker assets, defaulting to 本机', async () => {
    stubTauri(
      { instances: [], templates: [], platformAssetId: null },
      [{ id: 'd1', type: 'docker', name: '远程 Docker' }, { id: 's1', type: 'ssh', name: '服务器' }],
    )
    render(<SandboxSettingsTab />)
    const select = await screen.findByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: '远程 Docker' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '服务器' })).toBeNull()
  })

  it('reflects a selected platform asset', async () => {
    stubTauri(
      { instances: [], templates: [], platformAssetId: 'd1' },
      [{ id: 'd1', type: 'docker', name: '远程 Docker' }],
    )
    render(<SandboxSettingsTab />)
    const select = await screen.findByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('d1')
  })

  it('saves the selection via desktop_ui_set_platform and shows 已保存', async () => {
    stubTauri(
      { instances: [], templates: [], platformAssetId: null },
      [{ id: 'd1', type: 'docker', name: '远程 Docker' }],
    )
    render(<SandboxSettingsTab />)
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'd1' } })
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_set_platform', args: { assetId: 'd1' } })
    })
    expect(screen.getByText('已保存。')).toBeTruthy()
  })

  it('surfaces save failures', async () => {
    stubHostBridge((cmd) => {
      if (cmd === 'desktop_ui_overview') {
        return Promise.resolve({ instances: [], templates: [], platformAssetId: null })
      }
      if (cmd === 'get_assets') return Promise.resolve([{ id: 'd1', type: 'docker', name: '远程 Docker' }])
      return Promise.reject(new Error('资产不存在'))
    })
    render(<SandboxSettingsTab />)
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'd1' } })
    await waitFor(() => expect(screen.getByText('资产不存在')).toBeTruthy())
  })

  it('shows load failure when the host bridge reports an error', async () => {
    stubHostBridge(() => Promise.reject(new Error('host bridge unavailable (browser preview)')))
    render(<SandboxSettingsTab />)
    await waitFor(() => expect(screen.getByText(/browser preview/)).toBeTruthy())
  })
})
