// @vitest-environment jsdom
/**
 * Settings 各 tab 组件行为:审计加载/清空、告警 CRUD 弹窗、关于更新状态机。
 * (v0.123.1 起「插件市场」「AI 助手」tab 移除。)
 * 各 tab 以独立 settings.section 注册(dsh 设置侧栏 StarHub 可展开分组
 * 直渲,无面板内部嵌套列);IPC 走宿主桥 invoke 替身;
 * 无宿主桥(预览)分支一并覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AuditTab, formatAuditDetail, formatAuditTime } from '../src/client/settings/audit.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { AboutTab } from '../src/client/settings/about.tsx'
import { hostBridgeCalls, restoreHostBridge, stubHostBridge } from './host-bridge.ts'

/** 安装宿主桥 invoke 替身:按命令返回 map 里的值;返回还原回调。 */
function stubTauriInternals(handlers: Record<string, (args?: unknown) => unknown>): () => void {
  stubHostBridge((cmd, args) => {
    const handler = handlers[cmd]
    if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${cmd}`))
    return Promise.resolve(handler(args))
  })
  return () => { restoreHostBridge() }
}

/** 模拟无宿主桥:移除 fetch 使 isTauriRuntime() 为 false(替代旧「无 Tauri internals」预览态)。 */
async function withoutHostBridge<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  Reflect.deleteProperty(globalThis, 'fetch')
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/** 显式类型化的 objectContaining 包装(原生签名返回 any,避免 any 传播)。 */
function objectContaining<T extends object>(expected: T): T {
  return expect.objectContaining(expected as Record<string, unknown>) as T
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
  restoreHostBridge()
})

describe('AuditTab', () => {
  it('shows the empty table in browser preview', async () => {
    await withoutHostBridge(async () => {
      render(<AuditTab />)
      expect(screen.getByText('暂无审计日志')).toBeTruthy()
      expect(screen.queryByText('统计')).toBeNull()
    })
  })

  it('renders logs and stats, reloads on filter change and clears all', async () => {
    const calls: Array<[string, unknown]> = []
    const restore = stubTauriInternals({
      audit_list: (args) => {
        calls.push(['audit_list', args])
        return [{
          id: 1, timestamp: 1_700_000_000, category: 'ssh', action: 'connect',
          target: '10.0.0.1', detail: { database: 'db1', durationMs: 12, rows: 3 }, session_id: null,
          asset_id: null, success: true,
        }]
      },
      audit_stats: () => [{ category: 'ssh', date: '2026-01-01', total: 3, success: 2, failed: 1 }],
      audit_clear: () => 2,
    })
    try {
      render(<AuditTab />)
      expect(await screen.findByText('connect')).toBeTruthy()
      expect(screen.getByText('10.0.0.1')).toBeTruthy()
      expect(screen.getByText('db=db1 · 12ms · rows=3')).toBeTruthy()
      expect(screen.getByText('统计')).toBeTruthy()
      // 筛选变更 → 带 filter 重拉
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ai' } })
      await act(async () => { await Promise.resolve() })
      expect(calls.some(([cmd, args]) => cmd === 'audit_list'
        && (args as { categoryFilter: string }).categoryFilter === 'ai')).toBe(true)
      // 清理全部 → 提示 + 重载 + 3s 后消失(fake timers 只包这段生命周期)
      vi.useFakeTimers()
      fireEvent.click(screen.getByText('清理全部'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText(/已清理 2 条日志/)).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(screen.queryByText(/已清理 2 条日志/)).toBeNull()
    } finally {
      vi.useRealTimers()
      restore()
    }
  })

  it('shows the clear failure message', async () => {
    const restore = stubTauriInternals({
      audit_list: () => [],
      audit_stats: () => [],
      audit_clear: () => { throw new Error('disk full') },
    })
    try {
      render(<AuditTab />)
      fireEvent.click(await screen.findByText('清理全部'))
      expect(await screen.findByText(/清理失败: disk full/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('formats timestamps and details like the Vue version', () => {
    expect(formatAuditTime(1_700_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(formatAuditDetail(null, 'target-fallback')).toBe('target-fallback')
    expect(formatAuditDetail({ sql: 'SELECT 1', database: 'd', table: 't', rows: 2 })).toBe('SELECT 1 · db=d · table=t · rows=2')
    expect(formatAuditDetail({ unknown: { a: 1 } })).toBe('{"unknown":{"a":1}}')
  })
})

describe('AlertTab', () => {
  it('shows the empty state in preview and creates a rule via the dialog', async () => {
    await withoutHostBridge(async () => {
      render(<AlertTab />)
      expect(await screen.findByText(/暂无告警规则/)).toBeTruthy()
      fireEvent.click(screen.getByText('新建规则'))
      const dialog = screen.getByRole('dialog', { name: '新建告警规则' })
      fireEvent.change(within(dialog).getByPlaceholderText(/例如/), { target: { value: 'SSH 错误' } })
      fireEvent.click(within(dialog).getByText('保存'))
      await act(async () => { await Promise.resolve() })
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('renders rules, edits, deletes and tests webhooks in desktop mode', async () => {
    const update = vi.fn((..._args: unknown[]) => ({ id: 'r1' }))
    const remove = vi.fn((..._args: unknown[]) => null)
    const restore = stubTauriInternals({
      alert_list: () => [{
        id: 'r1', name: 'SSH 连接失败', enabled: true, category: 'ssh', metric: 'ssh.error_count',
        operator: '>', threshold: 5, duration_sec: 0, webhook_url: 'http://hook', cooldown_sec: 300,
        created_at: 0, updated_at: 0,
      }],
      alert_update: args => update(args),
      alert_delete: args => remove(args),
      alert_test_webhook: () => '✓ 发送成功',
    })
    try {
      render(<AlertTab />)
      expect(await screen.findByText('SSH 连接失败')).toBeTruthy()
      expect(screen.getByText('启用')).toBeTruthy()
      // 编辑弹窗预填
      fireEvent.click(screen.getByLabelText('编辑'))
      const dialog = screen.getByRole('dialog', { name: '编辑告警规则' })
      expect(within(dialog).getByDisplayValue('SSH 连接失败')).toBeTruthy()
      fireEvent.click(within(dialog).getByText('保存'))
      await act(async () => { await Promise.resolve() })
      expect(update).toHaveBeenCalledWith({ id: 'r1', input: objectContaining({ name: 'SSH 连接失败' }) })
      // 测试 webhook(编辑弹窗里有输入框与按钮)
      fireEvent.click(screen.getByLabelText('编辑'))
      fireEvent.click(within(screen.getByRole('dialog', { name: '编辑告警规则' })).getByText('测试 Webhook'))
      expect(await screen.findByText('✓ 发送成功')).toBeTruthy()
      fireEvent.click(screen.getByRole('dialog', { name: '编辑告警规则' }).querySelector('[aria-label="关闭"]')!)
      // 删除
      fireEvent.click(screen.getByLabelText('删除'))
      await act(async () => { await Promise.resolve() })
      expect(remove).toHaveBeenCalledWith({ id: 'r1' })
    } finally {
      restore()
    }
  })

  it('disables save until a name is entered', async () => {
    render(<AlertTab />)
    fireEvent.click(await screen.findByText('新建规则'))
    const dialog = screen.getByRole('dialog', { name: '新建告警规则' })
    const save = within(dialog).getByText('保存')
    expect(save.getAttribute('disabled')).not.toBeNull()
  })
})

describe('AboutTab', () => {
  it('shows the version placeholder and no-update state in preview', async () => {
    await withoutHostBridge(async () => {
      render(<AboutTab />)
      expect(screen.getByText(/v--/)).toBeTruthy()
      fireEvent.click(screen.getByText('检查更新'))
      expect(await screen.findByText('已是最新版本')).toBeTruthy()
    })
  })

  it('loads the app version and reports no update even when the bridge would expose updater data', async () => {
    // 自更新归 Electron 壳:StarHub 侧不再调 plugin:updater|*,恒报已是最新版本。
    const restore = stubTauriInternals({
      'plugin:app|version': () => '9.9.9',
      'plugin:updater|check': () => ({ rid: 1, version: '10.0.0' }),
    })
    try {
      render(<AboutTab />)
      expect(await screen.findByText(/v9\.9\.9/)).toBeTruthy()
      fireEvent.click(screen.getByText('检查更新'))
      expect(await screen.findByText('已是最新版本')).toBeTruthy()
      expect(screen.queryByText('下载并安装')).toBeNull()
      // 只有版本读取过桥,updater 命令一次都没发。
      expect(hostBridgeCalls()).toEqual([{ cmd: 'plugin:app|version', args: {} }])
    } finally {
      restore()
    }
  })
})
