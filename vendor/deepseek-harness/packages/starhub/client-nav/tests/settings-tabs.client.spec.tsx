// @vitest-environment jsdom
/**
 * Settings 各 tab 组件行为:审计加载/清空、告警 CRUD 弹窗、插件安装入口/
 * 市场(「已安装插件」列表已按用户要求移除,已装列表仅静默服务市场
 * 「已安装」标记)、关于更新状态机、AI 白名单/记忆(含记忆管理弹窗)。
 * 五个 tab 以独立 settings.section 注册(dsh 设置侧栏 StarHub 可展开分组
 * 直渲,无面板内部嵌套列);IPC 走 window.__TAURI_INTERNALS__ stub;
 * 浏览器预览分支(无 Tauri)一并覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { AuditTab, formatAuditDetail, formatAuditTime } from '../src/client/settings/audit.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { PluginsTab } from '../src/client/settings/plugins.tsx'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AiTab } from '../src/client/settings/ai.tsx'
import { AI_STORAGE_KEY } from '../src/client/settings/aiSettings.ts'

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

/** 显式类型化的 objectContaining 包装(原生签名返回 any,避免 any 传播)。 */
function objectContaining<T extends object>(expected: T): T {
  return expect.objectContaining(expected as Record<string, unknown>) as T
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('AuditTab', () => {
  it('shows the empty table in browser preview', () => {
    render(<AuditTab />)
    expect(screen.getByText('暂无审计日志')).toBeTruthy()
    expect(screen.queryByText('统计')).toBeNull()
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
    render(<AlertTab />)
    expect(await screen.findByText(/暂无告警规则/)).toBeTruthy()
    fireEvent.click(screen.getByText('新建规则'))
    const dialog = screen.getByRole('dialog', { name: '新建告警规则' })
    fireEvent.change(within(dialog).getByPlaceholderText(/例如/), { target: { value: 'SSH 错误' } })
    fireEvent.click(within(dialog).getByText('保存'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog')).toBeNull()
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

describe('PluginsTab', () => {
  it('shows install entry and empty market in browser preview (installed-list empty)', async () => {
    render(<PluginsTab />)
    expect(screen.getByText('已安装插件')).toBeTruthy()
    expect(screen.getByText('暂无已安装插件。')).toBeTruthy()
    expect(screen.getByText('安装插件')).toBeTruthy()
    expect(screen.getByText('暂无市场插件。')).toBeTruthy()
  })

  it('installs by URL, filters the market and marks installed entries', async () => {
    const installUrl = vi.fn((..._args: unknown[]) => ({ id: 'p9', name: 'installed', version: '1.0.0', source: { kind: 'url' }, entry: 'index.js', enabled: false }))
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [
        { id: 'p1-cool', name: 'demo', version: '1.0.0', source: { kind: 'market' }, entry: 'index.js', enabled: true },
      ],
      dsh_plugin_market_fetch: () => ({
        fetchedAt: '2026-01-01', stale: false,
        categories: [{
          name: '工具',
          plugins: [
            { name: 'Cool Plugin', url: 'https://github.com/x/p1-cool', description: 'cool', stars: 5, npm: 'cool-pkg' },
            { name: 'Fresh Plugin', url: 'https://github.com/x/fresh', description: 'new', stars: 1 },
          ],
        }],
      }),
      dsh_plugin_install_url: args => installUrl(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      expect(await screen.findByText('Cool Plugin')).toBeTruthy()
      // 已装标记:市场项 url 含已装插件 id → 按钮显示「已安装」且禁用
      const installedButton = await screen.findByText('已安装')
      expect(installedButton.hasAttribute('disabled')).toBe(true)
      // URL 安装
      fireEvent.change(screen.getByPlaceholderText(/GitHub 仓库 URL/), { target: { value: 'https://github.com/a/b' } })
      fireEvent.click(screen.getByText('URL 安装'))
      await vi.waitFor(() =>{  expect(installUrl).toHaveBeenCalledWith({ url: 'https://github.com/a/b' }) })
      await vi.waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>(/GitHub 仓库 URL/)).value).toBe('') })
      // 市场安装
      fireEvent.click(screen.getByText('安装'))
      await vi.waitFor(() =>{  expect(installUrl).toHaveBeenCalledWith({ url: 'https://github.com/x/fresh' }) })
      // 市场:搜索过滤
      fireEvent.change(screen.getByPlaceholderText('搜索插件…'), { target: { value: 'Cool' } })
      expect(await screen.findByText('Cool Plugin')).toBeTruthy()
      expect(screen.queryByText('Fresh Plugin')).toBeNull()
    } finally {
      restore()
    }
  })

  it('imports a local directory through the native dialog', async () => {
    const install = vi.fn((..._args: unknown[]) => ({ id: 'p1', name: 'n', version: '1', source: { kind: 'local-dir' }, entry: 'i.js', enabled: false }))
    const restore = stubTauriInternals({
      'plugin:dialog|open': () => 'C:/plugins/my-plugin',
      dsh_plugin_install_local: args => install(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByText('导入目录'))
      await act(async () => { await Promise.resolve() })
      expect(install).toHaveBeenCalledWith({ path: 'C:/plugins/my-plugin' })
    } finally {
      restore()
    }
  })
})

describe('AboutTab', () => {
  it('shows the version placeholder and no-update state in preview', async () => {
    render(<AboutTab />)
    expect(screen.getByText(/v--/)).toBeTruthy()
    fireEvent.click(screen.getByText('检查更新'))
    expect(await screen.findByText('已是最新版本')).toBeTruthy()
  })

  it('loads the app version and drives the update state machine in desktop mode', async () => {
    const install = vi.fn((..._args: unknown[]) => null)
    const restart = vi.fn((..._args: unknown[]) => null)
    const restore = stubTauriInternals({
      'plugin:app|version': () => '9.9.9',
      'plugin:updater|check': () => ({ rid: 1, version: '10.0.0' }),
      'plugin:updater|download_and_install': args => install(args),
      'plugin:process|restart': () => restart(),
    })
    try {
      render(<AboutTab />)
      expect(await screen.findByText(/v9\.9\.9/)).toBeTruthy()
      fireEvent.click(screen.getByText('检查更新'))
      expect(await screen.findByText(/有新版本: v10\.0\.0/)).toBeTruthy()
      fireEvent.click(screen.getByText('下载并安装'))
      await vi.waitFor(() =>{  expect(install).toHaveBeenCalledWith(expect.objectContaining({ rid: 1 })) })
      await vi.waitFor(() =>{  expect(restart).toHaveBeenCalledTimes(1) })
    } finally {
      restore()
    }
  })

  it('shows the download failure error', async () => {
    const restore = stubTauriInternals({
      'plugin:updater|check': () => ({ rid: 1, version: '10.0.0' }),
      'plugin:updater|download_and_install': () => { throw new Error('install failed') },
    })
    try {
      render(<AboutTab />)
      fireEvent.click(screen.getByText('检查更新'))
      fireEvent.click(await screen.findByText('下载并安装'))
      expect(await screen.findByText('install failed')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows the update error state', async () => {
    const restore = stubTauriInternals({
      'plugin:updater|check': () => { throw new Error('no network') },
    })
    try {
      render(<AboutTab />)
      fireEvent.click(screen.getByText('检查更新'))
      expect(await screen.findByText('no network')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('AiTab', () => {
  it('renders memory settings in preview (whitelist removed); memory manager is openable', async () => {
    // v0.92.0: 不再整体禁用「管理记忆」按钮;浏览器预览下 ai_memory_list 的 IPC
    // 失败会以错误文本形式展示而非弹窗被吞。测试只验证 dialog 能打开(IPC
    // 错误文本的渲染形态依赖 stub 实现,不强断言)。
    render(<AiTab />)
    expect(screen.queryByText('命令白名单')).toBeNull()
    expect(screen.getByText('记忆与上下文')).toBeTruthy()
    fireEvent.click(screen.getByText('管理记忆'))
    expect(await screen.findByRole('dialog', { name: '长期记忆管理' })).toBeTruthy()
  })

  it('ignores legacy whitelist entries from stored data and keeps memory toggles', async () => {
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { commandWhitelist: ['ls'], commandWhitelistVersion: 3 },
    }))
    render(<AiTab />)
    expect(screen.queryByText('ls')).toBeNull()
    expect(screen.queryByPlaceholderText(/输入命令前缀/)).toBeNull()
    expect(screen.getByText('启用长期记忆与自动沉淀')).toBeTruthy()
  })

  it('writes memory toggles immediately', async () => {
    // v0.94.0:记忆模型是硬前置;预置路由后开关才可用。
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { memoryProvider: 'deepseek-official', memoryModel: 'deepseek-chat' },
    }))
    render(<AiTab />)
    // v0.92.0 起 memoryEnabled 默认 false,点击后变 true → 写入 localStorage。
    fireEvent.click(screen.getByText('启用长期记忆与自动沉淀'))
    const stored = () => JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? '{}') as {
      settings: { memoryEnabled: boolean }
    }
    expect(stored().settings.memoryEnabled).toBe(true)
    // 上下文预算/迭代步数/压缩阈值由 dsh harness 接管,AI tab 不再出现
    expect(screen.queryByLabelText(/上下文预算/)).toBeNull()
    expect(screen.queryByLabelText(/最大工具迭代步数/)).toBeNull()
    expect(screen.queryByLabelText(/压缩触发阈值/)).toBeNull()
  })

  it('disables memory toggles until the memory model is configured (v0.94.0)', async () => {
    localStorage.clear()
    render(<AiTab />)
    const inputOf = (text: string) => {
      const label = screen.getByText(text).closest('label')
      expect(label).not.toBeNull()
      return label!.querySelector('input')!
    }
    // 未配置模型:长期记忆总开关禁用。
    // (「即使勾选也会被归一化强制归零」的兜底由 settings-services 的
    // normalizeAiSettings 硬门测试覆盖。)
    expect(inputOf('启用长期记忆与自动沉淀').disabled).toBe(true)
    expect(screen.queryByText('存档 tool 消息与工具调用')).toBeNull()
    expect(screen.queryByText('记忆写入需逐条确认')).toBeNull()
  })

  it('configures the memory model via the catalog dropdowns and syncs to the namespace', async () => {
    const update = vi.fn(() => Promise.resolve())
    const api = {
      settings: { update },
      llm: {
        models: vi.fn(async () => ({
          result: {
            ok: true as const,
            value: {
              groups: [
                {
                  id: 'deepseek-official', name: 'DeepSeek',
                  models: [
                    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
                    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
                  ],
                },
              ],
              failures: [],
            },
          },
        })),
      },
    } as unknown as IApiClient
    // 已有历史内存写入习惯的旧 localStorage(未配模型)不受影响。
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { memoryEnabled: true },
    }))
    render(<AiTab api={api} />)
    await act(async () => { await Promise.resolve() })
    // 未配置时「启用长期记忆」被归一化回 false 且禁用。
    expect(screen.getByText('启用长期记忆与自动沉淀').closest('label')!.querySelector('input')!.disabled).toBe(true)
    // 下拉选 provider + model
    fireEvent.change(screen.getByLabelText('记忆模型 provider'), { target: { value: 'deepseek-official' } })
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByLabelText('记忆模型 model'), { target: { value: 'deepseek-chat' } })
    await act(async () => { await Promise.resolve() })
    const stored = () => JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? '{}') as {
      settings: { memoryProvider: string; memoryModel: string }
    }
    expect(stored().settings.memoryProvider).toBe('deepseek-official')
    expect(stored().settings.memoryModel).toBe('deepseek-chat')
    expect(update).toHaveBeenCalledWith({
      ns: 'starhub-memory-context',
      patch: { memoryProvider: 'deepseek-official', memoryModel: 'deepseek-chat' },
    })
    // 配置后开关可用
    expect(screen.getByText('启用长期记忆与自动沉淀').closest('label')!.querySelector('input')!.disabled).toBe(false)
    fireEvent.click(screen.getByText('启用长期记忆与自动沉淀'))
    await act(async () => { await Promise.resolve() })
    expect(update).toHaveBeenCalledWith({ ns: 'starhub-memory-context', patch: { enabled: true, autoReview: true } })
  })

  it('manages memories: group by scope, edit with audit, two-step delete', async () => {
    const invoke = vi.fn((_cmd: string, _args?: unknown) => undefined)
    const restore = stubTauriInternals({
      ai_memory_list: () => [
        { id: 'm1', scope: 'user', content: '用户偏好', created_at: 0, updated_at: 0 },
        { id: 'm2', scope: 'global', content: '环境事实', created_at: 0, updated_at: 0 },
      ],
      ai_memory_update: (args) => { invoke('update', args) },
      ai_memory_delete: (args) => { invoke('delete', args) },
      audit_log: (args) => { invoke('audit', args) },
    })
    try {
      render(<AiTab />)
      fireEvent.click(screen.getByText('管理记忆'))
      expect(await screen.findByText('USER — 用户画像')).toBeTruthy()
      expect(screen.getByText('GLOBAL — 环境与经验')).toBeTruthy()
      // 编辑
      fireEvent.click(screen.getAllByLabelText('编辑')[0]!)
      fireEvent.change(screen.getByDisplayValue('用户偏好'), { target: { value: '新偏好' } })
      fireEvent.click(within(screen.getByRole('dialog', { name: '长期记忆管理' })).getByText('保存'))
      await act(async () => { await Promise.resolve() })
      expect(invoke).toHaveBeenCalledWith('update', { id: 'm1', content: '新偏好' })
      expect(invoke).toHaveBeenCalledWith('audit', expect.objectContaining({ action: 'memory_update', target: 'user' }))
      // 两段删除
      fireEvent.click(screen.getAllByLabelText('删除')[1]!)
      expect(screen.getByText(/确认删除这条记忆/)).toBeTruthy()
      fireEvent.click(screen.getByText('删除'))
      await act(async () => { await Promise.resolve() })
      expect(invoke).toHaveBeenCalledWith('delete', { id: 'm2' })
      expect(invoke).toHaveBeenCalledWith('audit', expect.objectContaining({ action: 'memory_remove', target: 'global' }))
    } finally {
      restore()
    }
  })

  it('shows memory errors and rejects empty edits', async () => {
    const restore = stubTauriInternals({
      ai_memory_list: () => [{ id: 'm1', scope: 'user', content: '内容', created_at: 0, updated_at: 0 }],
      ai_memory_update: () => { throw new Error('容量超限') },
    })
    try {
      render(<AiTab />)
      fireEvent.click(screen.getByText('管理记忆'))
      const dialog = () => screen.getByRole('dialog', { name: '长期记忆管理' })
      fireEvent.click(await screen.findByLabelText('编辑'))
      const textarea = () => within(dialog()).getByRole('textbox')
      fireEvent.change(textarea(), { target: { value: '   ' } })
      fireEvent.click(within(dialog()).getByText('保存'))
      expect(await screen.findByText('记忆内容不能为空')).toBeTruthy()
      fireEvent.change(textarea(), { target: { value: '新内容' } })
      fireEvent.click(within(dialog()).getByText('保存'))
      expect(await screen.findByText('容量超限')).toBeTruthy()
    } finally {
      restore()
    }
  })
})
