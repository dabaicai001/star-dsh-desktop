// @vitest-environment jsdom
/**
 * 沙箱桌面工作面板(SandboxPanel):概览加载/错误态、实例卡片动作
 * (直播/接管独立窗口命令、停止/恢复/销毁生命周期命令、回放弹窗)、
 * 模板编辑/新增/删除。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SandboxPanel } from '../src/client/sandbox/SandboxPanel.tsx'
import type { SandboxOverview } from '../src/client/sandbox/services.ts'
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

const INSTANCE = {
  id: 'sb-1234567890',
  containerId: 'c-1',
  platform: 'local',
  novncPort: 6080,
  status: 'running',
  task: '配置数据库',
  createdAt: 1,
}

const TEMPLATE = {
  id: 't-1',
  name: 'ubuntu-desktop',
  recipe: 'name = "ubuntu-desktop"',
  imageTag: 'starhub-sandbox-ubuntu-desktop:latest',
  createdAt: 1,
}

function overviewResult(overrides: Partial<SandboxOverview> = {}): SandboxOverview {
  return { instances: [INSTANCE], templates: [TEMPLATE], platformAssetId: null, ...overrides }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invokeCalls = []
  invokeResult = () => null
  restoreHostBridge()
})

async function renderPanel(result: unknown = overviewResult()) {
  invokeResult = () => result
  stubTauri()
  render(<SandboxPanel />)
  await waitFor(() => expect(screen.queryByText('加载沙箱…')).toBeNull())
}

describe('SandboxPanel', () => {
  it('shows loading then the instance/template lists', async () => {
    await renderPanel()
    expect(screen.getByText('配置数据库')).toBeTruthy()
    expect(screen.getByText('ubuntu-desktop')).toBeTruthy()
    expect(invokeCalls[0]).toEqual({ cmd: 'desktop_ui_overview', args: {} })
  })

  it('shows the error state with retry when overview fails', async () => {
    invokeResult = () => Promise.reject(new Error('boom'))
    stubTauri()
    render(<SandboxPanel />)
    await waitFor(() => expect(screen.getByText(/沙箱概览不可用/)).toBeTruthy())
    expect(screen.getByText(/boom/)).toBeTruthy()
    // 重试按钮再发一次 overview
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(invokeCalls.filter(c => c.cmd === 'desktop_ui_overview').length).toBe(2)
    })
  })

  it('shows the empty-hint when no live instances', async () => {
    await renderPanel(overviewResult({ instances: [] }))
    expect(screen.getByText(/没有运行中的沙箱/)).toBeTruthy()
  })

  it('opens the live window in watch mode via 直播', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '直播' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        cmd: 'desktop_ui_open_live_window',
        args: { sandboxId: INSTANCE.id, containerId: 'c-1', novncPort: 6080, takeover: false },
      })
    })
  })

  it('opens the live window in takeover mode via 接管', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        cmd: 'desktop_ui_open_live_window',
        args: { sandboxId: INSTANCE.id, containerId: 'c-1', novncPort: 6080, takeover: true },
      })
    })
  })

  it('hides 接管 for paused instances', async () => {
    await renderPanel(overviewResult({ instances: [{ ...INSTANCE, status: 'paused' }] }))
    expect(screen.getByRole('button', { name: '直播' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '接管' })).toBeNull()
  })

  it('surfaces live-window errors in the banner', async () => {
    stubTauri()
    invokeResult = (cmd) => {
      if (cmd === 'desktop_ui_open_live_window') return Promise.reject(new Error('创建沙箱直播窗口失败:boom'))
      return overviewResult()
    }
    render(<SandboxPanel />)
    await waitFor(() => expect(screen.queryByText('加载沙箱…')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '直播' }))
    await waitFor(() => expect(screen.getByText(/创建沙箱直播窗口失败/)).toBeTruthy())
  })

  it('runs lifecycle actions (pause/resume directly; destroy only after confirmation)', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_lifecycle', args: { sandboxId: INSTANCE.id, action: 'pause' } })
    })
    // 销毁需先经确认弹窗:点「销毁」只开弹窗,不发命令。
    fireEvent.click(screen.getByRole('button', { name: '销毁' }))
    expect(screen.getByRole('dialog', { name: '确认操作' }).textContent).toContain('不可恢复')
    expect(invokeCalls).not.toContainEqual({ cmd: 'desktop_ui_lifecycle', args: { sandboxId: INSTANCE.id, action: 'destroy' } })
    fireEvent.click(screen.getByRole('button', { name: '确认销毁' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_lifecycle', args: { sandboxId: INSTANCE.id, action: 'destroy' } })
    })
    expect(screen.queryByRole('dialog', { name: '确认操作' })).toBeNull()
  })

  it('cancelling the destroy confirmation does not invoke lifecycle', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '销毁' }))
    expect(screen.getByRole('dialog', { name: '确认操作' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '确认操作' })).toBeNull()
    expect(invokeCalls.filter(c => c.cmd === 'desktop_ui_lifecycle')).toEqual([])
  })

  it('offers 恢复 for paused instances', async () => {
    await renderPanel(overviewResult({ instances: [{ ...INSTANCE, status: 'paused' }] }))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_lifecycle', args: { sandboxId: INSTANCE.id, action: 'resume' } })
    })
  })

  it('opens the replay dialog and closes it', async () => {
    stubTauri()
    invokeResult = (cmd) => cmd === 'desktop_ui_replay_frames'
      ? { frames: [{ action: 'click(10,20)', shotPath: null, createdAt: 1700000000 }] }
      : overviewResult()
    render(<SandboxPanel />)
    await waitFor(() => expect(screen.queryByText('加载沙箱…')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '回放' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '沙箱回放' })).toBeTruthy())
    expect(screen.getByText(/click\(10,20\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog', { name: '沙箱回放' })).toBeNull()
  })

  it('saves an edited template recipe and refreshes', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const dialog = screen.getByRole('dialog', { name: '编辑模板' })
    expect(dialog.textContent).toContain('ubuntu-desktop')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        cmd: 'desktop_ui_upsert_template',
        args: { name: 'ubuntu-desktop', recipeToml: 'name = "ubuntu-desktop"' },
      })
    })
  })

  it('opens the new-template dialog with the default recipe and cancels', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '新建模板' }))
    expect(screen.getByRole('dialog', { name: '编辑模板' }).textContent).toContain('新建模板')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '编辑模板' })).toBeNull()
  })

  it('deletes a template only after confirming and refreshes', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    // 确认弹窗出现,确认前不发删除命令。
    expect(screen.getByRole('dialog', { name: '确认操作' }).textContent).toContain('ubuntu-desktop')
    expect(invokeCalls.filter(c => c.cmd === 'desktop_ui_delete_template')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_delete_template', args: { name: 'ubuntu-desktop' } })
    })
  })

  it('dismisses the error banner via its close button', async () => {
    stubTauri()
    invokeResult = (cmd) => {
      if (cmd === 'desktop_ui_lifecycle') return Promise.reject(new Error('容器不存在'))
      return overviewResult()
    }
    render(<SandboxPanel />)
    await waitFor(() => expect(screen.queryByText('加载沙箱…')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(screen.getByText('容器不存在')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('容器不存在')).toBeNull()
  })

  it('surfaces lifecycle errors in the banner', async () => {
    stubTauri()
    invokeResult = (cmd) => {
      if (cmd === 'desktop_ui_lifecycle') return Promise.reject(new Error('容器不存在'))
      return overviewResult()
    }
    render(<SandboxPanel />)
    await waitFor(() => expect(screen.queryByText('加载沙箱…')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(screen.getByText('容器不存在')).toBeTruthy())
  })
})
