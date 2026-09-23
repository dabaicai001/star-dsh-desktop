// @vitest-environment jsdom
/**
 * Settings 迁移的覆盖率补充:补齐 services / about / audit / alert 各文件中
 * 首次测试未触达的分支(错误路径、次要 UI 分支、弹窗交互等),配合
 * settings-services / settings-tabs 两个主规格把 client-nav 包推到
 * per-file 100%。(v0.123.1 起「插件市场」与「AI 助手」tab 及其服务函数
 * 移除,plugins / ai 覆盖块随之删除。)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AuditTab, formatAuditDetail } from '../src/client/settings/audit.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { AboutTab } from '../src/client/settings/about.tsx'
import {
  checkForUpdates,
} from '../src/client/settings/services.ts'

/** jsdom 全局下的 Tauri IPC stub:按命令返回 map 里的值。 */
function stubTauriInternals(handlers: Record<string, (args?: unknown) => unknown>): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      const handler = handlers[cmd]
      if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${cmd}`))
      return Promise.resolve(handler(args))
    },
  }
  return () => {
    if (prev === undefined) {
      delete w.__TAURI_INTERNALS__
    } else {
      w.__TAURI_INTERNALS__ = prev
    }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('services extra branches', () => {
  it('checkForUpdates maps partial metadata and null metadata', async () => {
    const restore = stubTauriInternals({
      'plugin:updater|check': () => null,
    })
    try {
      await expect(checkForUpdates()).resolves.toEqual({ available: false })
    } finally {
      restore()
    }
    const restore2 = stubTauriInternals({
      'plugin:updater|check': () => ({ rid: 1, version: '9.0.0' }),
    })
    try {
      await expect(checkForUpdates()).resolves.toEqual({ available: true, version: '9.0.0' })
    } finally {
      restore2()
    }
    const restore3 = stubTauriInternals({
      'plugin:updater|check': () => ({ rid: 1 }),
    })
    try {
      await expect(checkForUpdates()).resolves.toEqual({ available: true })
    } finally {
      restore3()
    }
  })
})

describe('about extra branches', () => {
  it('stringifies non-Error check failures', async () => {
    const restore = stubTauriInternals({
      'plugin:updater|check': () => { throw 'raw check failure' },
    })
    try {
      render(<AboutTab />)
      fireEvent.click(screen.getByText('检查更新'))
      expect(await screen.findByText('raw check failure')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('stringifies non-Error download failures', async () => {
    const restore = stubTauriInternals({
      'plugin:updater|check': () => ({ rid: 1, version: '9.9.9' }),
      'plugin:updater|download_and_install': () => { throw 'raw install failure' },
    })
    try {
      render(<AboutTab />)
      fireEvent.click(screen.getByText('检查更新'))
      fireEvent.click(await screen.findByText('下载并安装'))
      expect(await screen.findByText('raw install failure')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('audit extra branches', () => {
  it('renders failed rows, null targets and command details; refresh and string failures', async () => {
    const restore = stubTauriInternals({
      audit_list: () => [
        { id: 1, timestamp: 0, category: 'ssh', action: 'run', target: null, detail: { command: 'ls' }, session_id: null, asset_id: null, success: false },
      ],
      audit_stats: () => [],
      audit_clear: () => { throw 'raw clear failure' },
    })
    try {
      render(<AuditTab />)
      expect(await screen.findByText('run')).toBeTruthy()
      expect(screen.getByText('--')).toBeTruthy() // null target
      expect(screen.getByText('失败')).toBeTruthy()
      expect(screen.getByText('ls')).toBeTruthy() // command detail
      // 刷新按钮
      fireEvent.click(screen.getByText('刷新'))
      await act(async () => { await Promise.resolve() })
      // 清理的非 Error 失败
      fireEvent.click(screen.getByText('清理全部'))
      expect(await screen.findByText(/清理失败: raw clear failure/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('formats audit detail and survives a failed load', async () => {
    const restore = stubTauriInternals({
      audit_list: () => { throw 'raw list failure' },
      audit_stats: () => [],
    })
    try {
      render(<AuditTab />)
      expect(await screen.findByText('暂无审计日志')).toBeTruthy() // 加载失败不崩,空态兜底
    } finally {
      restore()
    }
  })

  it('formatAuditDetail prefers command, falls back to target/JSON and survives circular detail', () => {
    expect(formatAuditDetail({ command: 'ls -la' })).toBe('ls -la')
    expect(formatAuditDetail({ source: 'x', error: 'e' })).toBe('source=x · error: e')
    expect(formatAuditDetail(null, null)).toBe('')
    const circular: Record<string, unknown> = { name: 'c' }
    circular.self = circular
    expect(formatAuditDetail(circular)).toBe('[object Object]')
  })
})

describe('alert extra branches', () => {
  it('covers refresh, disabled badge, empty webhook, cancel, non-✓ result and failure paths', async () => {
    const deleteCalls: unknown[] = []
    const restore = stubTauriInternals({
      alert_list: () => [
        { id: 'r1', name: '启用规则', enabled: true, category: 'ssh', metric: 'ssh.error_count', operator: '>', threshold: 5, duration_sec: 0, webhook_url: 'http://hook', cooldown_sec: 300, created_at: 0, updated_at: 0 },
        { id: 'r2', name: '禁用规则', enabled: false, category: 'db', metric: 'db.error_count', operator: '<', threshold: 1, duration_sec: 10, webhook_url: '', cooldown_sec: 60, created_at: 0, updated_at: 0 },
      ],
      alert_delete: (args) => { deleteCalls.push(args); return null },
      alert_test_webhook: () => '✗ 无法送达',
    })
    try {
      render(<AlertTab />)
      expect(await screen.findByText('启用规则')).toBeTruthy()
      expect(screen.getByText('禁用规则')).toBeTruthy()
      expect(screen.getByText('禁用')).toBeTruthy() // 禁用徽标
      expect(screen.getByText(/持续 10s/)).toBeTruthy() // 空 webhook 规则的 meta 行
      // 刷新
      fireEvent.click(screen.getByText('刷新'))
      await act(async () => { await Promise.resolve() })
      // 编辑 r1 并测试 webhook(非 ✓ 结果)
      fireEvent.click(screen.getAllByLabelText('编辑')[0]!)
      const dialog = screen.getByRole('dialog', { name: '编辑告警规则' })
      fireEvent.click(within(dialog).getByText('测试 Webhook'))
      expect(await screen.findByText('✗ 无法送达')).toBeTruthy()
      // 取消关闭弹窗
      fireEvent.click(within(dialog).getByText('取消'))
      expect(screen.queryByRole('dialog')).toBeNull()
      // 删除
      fireEvent.click(screen.getAllByLabelText('删除')[0]!)
      await act(async () => { await Promise.resolve() })
      expect(deleteCalls).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('surfaces load and save failures without crashing', async () => {
    const restore = stubTauriInternals({
      alert_list: () => { throw 'raw list failure' },
      alert_create: () => { throw new Error('create failed') },
    })
    try {
      render(<AlertTab />)
      fireEvent.click(screen.getByText('新建规则'))
      const dialog = screen.getByRole('dialog', { name: '新建告警规则' })
      // 逐个字段编辑(覆盖各 onChange;webhook 清空路径)
      fireEvent.change(within(dialog).getByPlaceholderText(/例如/), { target: { value: '新规则' } })
      fireEvent.change(within(dialog).getAllByRole('combobox')[0]!, { target: { value: 'docker' } })
      fireEvent.change(within(dialog).getAllByRole('combobox')[1]!, { target: { value: 'docker.error_rate' } })
      fireEvent.change(within(dialog).getAllByRole('combobox')[2]!, { target: { value: '>=' } })
      const numbers = within(dialog).getAllByRole('spinbutton')
      fireEvent.change(numbers[0]!, { target: { value: '7.5' } })
      fireEvent.change(numbers[1]!, { target: { value: '3' } })
      fireEvent.change(numbers[2]!, { target: { value: '120' } })
      fireEvent.change(within(dialog).getAllByRole('textbox')[1]!, { target: { value: 'http://new' } })
      fireEvent.change(within(dialog).getAllByRole('textbox')[1]!, { target: { value: '' } }) // 清空 → null 路径
      fireEvent.click(within(dialog).getByRole('checkbox')) // 启用开关
      // 保存失败 → 弹窗保持 + 不崩
      fireEvent.click(within(dialog).getByText('保存'))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('dialog', { name: '新建告警规则' })).toBeTruthy()
      // panel mousedown 阻止冒泡 → 弹窗保持
      fireEvent.mouseDown(screen.getByRole('dialog', { name: '新建告警规则' }))
      expect(screen.getByRole('dialog', { name: '新建告警规则' })).toBeTruthy()
      // backdrop 关闭
      fireEvent.mouseDown(screen.getByRole('dialog', { name: '新建告警规则' }).parentElement!)
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      restore()
    }
  })

  it('covers webhook test failure with a 5s auto-clear and delete failure', async () => {
    vi.useFakeTimers()
    let webhookCalls = 0
    const restore = stubTauriInternals({
      alert_list: () => [
        { id: 'r1', name: '规则', enabled: true, category: 'ssh', metric: 'ssh.error_count', operator: '>', threshold: 5, duration_sec: 0, webhook_url: 'http://hook', cooldown_sec: 300, created_at: 0, updated_at: 0 },
      ],
      alert_test_webhook: () => {
        webhookCalls += 1
        if (webhookCalls === 1) throw new Error('webhook boom')
        throw 'webhook raw'
      },
      alert_delete: () => { throw new Error('delete failed') },
    })
    try {
      render(<AlertTab />)
      fireEvent.click(screen.getByText('新建规则'))
      const dialog = () => screen.getByRole('dialog', { name: '新建告警规则' })
      // 输入 webhook 后测试(Error 失败)+ 5s 自动清除
      fireEvent.change(within(dialog()).getAllByRole('textbox')[1]!, { target: { value: 'http://bad' } })
      fireEvent.click(within(dialog()).getByText('测试 Webhook'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText('webhook boom')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.queryByText('webhook boom')).toBeNull()
      // 字符串失败
      fireEvent.click(within(dialog()).getByText('测试 Webhook'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText('webhook raw')).toBeTruthy()
      // 关闭弹窗后删除失败
      fireEvent.click(within(dialog()).getByText('取消'))
      fireEvent.click(screen.getByLabelText('删除'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    } finally {
      vi.useRealTimers()
      restore()
    }
  })
})
