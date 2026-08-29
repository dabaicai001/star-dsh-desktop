// @vitest-environment jsdom
/**
 * 沙箱桌面工作面板(SandboxPanel):概览加载/错误态、实例卡片动作
 * (直播 iframe、停止/恢复/销毁生命周期命令、回放弹窗)、接管互斥
 * (开关 + 关闭直播自动退出接管)、模板编辑/新增/删除。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SandboxPanel } from '../src/client/sandbox/SandboxPanel.tsx'
import type { SandboxOverview } from '../src/client/sandbox/services.ts'

let invokeCalls: Array<{ cmd: string; args: unknown }> = []
let invokeResult: (cmd: string) => unknown = () => null

function stubTauri() {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      invokeCalls.push({ cmd, args })
      return Promise.resolve(invokeResult(cmd))
    },
  }
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
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
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
    expect(invokeCalls[0]).toEqual({ cmd: 'desktop_ui_overview', args: undefined })
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

  it('opens the noVNC viewer in watch mode and closes it', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '直播' }))
    const frame = screen.getByTitle(/沙箱直播/) as HTMLIFrameElement
    expect(frame.src).toContain('view_only=1')
    expect(screen.getByText(/围观中/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭直播' }))
    expect(screen.queryByTitle(/沙箱直播/)).toBeNull()
  })

  it('toggles takeover via desktop_set_takeover and swaps the iframe mode', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '直播' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_set_takeover', args: { containerId: 'c-1', active: true } })
    })
    const frame = screen.getByTitle(/沙箱直播/) as HTMLIFrameElement
    expect(frame.src).not.toContain('view_only=1')
    expect(screen.getByText(/接管中/)).toBeTruthy()
    // 关闭直播自动退出接管
    fireEvent.click(screen.getByRole('button', { name: '关闭直播' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_set_takeover', args: { containerId: 'c-1', active: false } })
    })
  })

  it('runs lifecycle actions (pause/destroy) and refreshes', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_lifecycle', args: { sandboxId: INSTANCE.id, action: 'pause' } })
    })
    fireEvent.click(screen.getByRole('button', { name: '销毁' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_lifecycle', args: { sandboxId: INSTANCE.id, action: 'destroy' } })
    })
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

  it('deletes a template after confirmation-free button and refreshes', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(invokeCalls).toContainEqual({ cmd: 'desktop_ui_delete_template', args: { name: 'ubuntu-desktop' } })
    })
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
