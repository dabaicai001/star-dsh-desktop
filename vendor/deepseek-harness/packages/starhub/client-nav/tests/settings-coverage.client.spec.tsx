// @vitest-environment jsdom
/**
 * Settings 迁移的覆盖率补充:补齐 services / aiSettings / about / audit /
 * alert / plugins / ai 各文件中首次测试未触达的分支(错误路径、次要 UI
 * 分支、弹窗交互、白名单边界等),配合 settings-services / settings-tabs
 * 两个主规格把 client-nav 包推到 per-file 100%。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { AuditTab, formatAuditDetail } from '../src/client/settings/audit.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { PluginsTab } from '../src/client/settings/plugins.tsx'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AiTab } from '../src/client/settings/ai.tsx'
import {
  checkForUpdates, logAudit,
} from '../src/client/settings/services.ts'
import { AI_STORAGE_KEY, loadAiSettings, normalizeAiSettings, saveAiSettings, type AiSettings } from '../src/client/settings/aiSettings.ts'

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
  it('logAudit passes through detail/session/asset fields and nulls the absent ones', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(1))
    const restore = stubTauriInternals({ audit_log: args => invoke(args) })
    try {
      await logAudit({
        category: 'db', action: 'run', target: 't', detail: { sql: 'SELECT 1' },
        sessionId: 's1', assetId: 'a1',
      })
      expect(invoke).toHaveBeenLastCalledWith({
        category: 'db', action: 'run', target: 't', detail: { sql: 'SELECT 1' },
        sessionId: 's1', assetId: 'a1', success: true,
      })
      // 缺省字段 → ?? null 落空值
      await logAudit({ category: 'ai', action: 'x' })
      expect(invoke).toHaveBeenLastCalledWith({
        category: 'ai', action: 'x', target: null, detail: null,
        sessionId: null, assetId: null, success: true,
      })
    } finally {
      restore()
    }
  })

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

describe('aiSettings extra branches', () => {
  it('recovers non-boolean memory flags and drops whitelist fields', () => {
    const legacyRaw = {
      commandWhitelist: 'nope',
      commandWhitelistVersion: 3,
      memoryEnabled: 'x',
      memoryWriteNeedsConfirm: 'x',
      memoryAutoReview: 'x',
    } as unknown as Partial<AiSettings>
    const settings = normalizeAiSettings(legacyRaw)
    expect('commandWhitelist' in settings).toBe(false)
    expect('commandWhitelistVersion' in settings).toBe(false)
    expect(settings.memoryEnabled).toBe(false)
    expect(settings.memoryWriteNeedsConfirm).toBe(false)
    expect(settings.memoryAutoReview).toBe(false)
  })

  it('saveAiSettings survives a missing store key', () => {
    expect(() =>{  saveAiSettings(loadAiSettings()) }).not.toThrow()
    const stored = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? '{}') as { settings: { memoryEnabled: boolean } }
    // v0.92.0 起 memoryEnabled 默认 false。
    expect(stored.settings.memoryEnabled).toBe(false)
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

describe('plugins extra branches', () => {
  it('covers URL-install string failure and market search with no matches', async () => {
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [],
      dsh_plugin_market_fetch: () => ({
        stale: false,
        categories: [{ name: '工具', plugins: [{ name: 'A', url: 'https://x/a', description: 'a' }] }],
      }),
      dsh_plugin_install_url: () => { throw 'raw url failure' },
    })
    try {
      render(<PluginsTab />)
      fireEvent.change(await screen.findByPlaceholderText(/GitHub 仓库 URL/), { target: { value: 'https://x/a' } })
      fireEvent.click(screen.getByText('URL 安装'))
      expect(await screen.findByText('raw url failure')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('搜索插件…'), { target: { value: 'zzz' } })
      expect(await screen.findByText('暂无市场插件。')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('covers URL-install Error path and zip/array import', async () => {
    const installLocal = vi.fn((..._args: unknown[]) => ({ id: 'p9', name: 'zip', version: '1', source: { kind: 'local-zip' }, entry: 'i.js', enabled: false }))
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_install_url: () => { throw new Error('url install failed') },
      'plugin:dialog|open': () => ['C:/plugins/x.zip'],
      dsh_plugin_install_local: args => installLocal(args),
    })
    try {
      render(<PluginsTab />)
      // URL 安装的 Error 路径
      fireEvent.change(await screen.findByPlaceholderText(/GitHub 仓库 URL/), { target: { value: 'https://x/e' } })
      fireEvent.click(screen.getByText('URL 安装'))
      expect(await screen.findByText('url install failed')).toBeTruthy()
      // Zip 导入(对话框返回数组)
      fireEvent.click(screen.getByText('导入 Zip'))
      await vi.waitFor(() =>{  expect(installLocal).toHaveBeenCalledWith({ path: 'C:/plugins/x.zip' }) })
    } finally {
      restore()
    }
  })

  it('ignores empty URL install and null local pick in preview', async () => {
    render(<PluginsTab />)
    await screen.findByText('安装插件')
    fireEvent.click(screen.getByText('URL 安装')) // 空 URL → 按钮禁用,点击无效果
    fireEvent.keyDown(screen.getByPlaceholderText(/GitHub 仓库 URL/), { key: 'Enter' }) // 空 URL Enter → 守卫返回
    fireEvent.keyDown(screen.getByPlaceholderText(/GitHub 仓库 URL/), { key: 'a' }) // 非 Enter 键忽略
    fireEvent.click(screen.getByText('导入目录')) // 预览无对话框 → null → 忽略
    expect(screen.queryByText(/raw/)).toBeNull()
  })

  it('covers market install, market refresh and fixture extras', async () => {
    const installUrl = vi.fn((..._args: unknown[]) => ({ id: 'fresh', name: 'Fresh', version: '1', source: { kind: 'url' }, entry: 'i.js', enabled: false }))
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [
        { id: 'p1', name: 'has-meta', version: '1', license: 'MIT', description: 'desc', source: { kind: 'market' }, entry: 'i.js', enabled: false },
      ],
      dsh_plugin_market_fetch: () => ({
        stale: false,
        categories: [{ name: '工具', plugins: [{ name: 'Fresh', url: 'https://x/fresh', description: 'new', stars: 3, npm: 'fresh' }] }],
      }),
      dsh_plugin_install_url: args => installUrl(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      // 市场卡片元信息(npm / stars)
      expect(await screen.findByText('npm: fresh')).toBeTruthy()
      expect(screen.getByText('★ 3')).toBeTruthy()
      // 市场安装(Fresh 未装 → 走 onInstallUrlFromMarket)
      fireEvent.click(screen.getByText('安装'))
      await vi.waitFor(() =>{  expect(installUrl).toHaveBeenCalledWith({ url: 'https://x/fresh' }) })
      // 市场刷新按钮
      fireEvent.click(screen.getByText('刷新'))
      await act(async () => { await Promise.resolve() })
    } finally {
      restore()
    }
  })

  it('surfaces market install failures (Error and string)', async () => {
    let installCalls = 0
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [],
      dsh_plugin_market_fetch: () => ({
        stale: false,
        categories: [{ name: '工具', plugins: [{ name: 'A', url: 'https://x/a', description: 'a' }] }],
      }),
      dsh_plugin_install_url: () => {
        installCalls += 1
        if (installCalls === 1) throw new Error('market boom')
        throw 'market raw'
      },
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByText('安装'))
      expect(await screen.findByText('market boom')).toBeTruthy()
      fireEvent.click(screen.getByText('安装'))
      expect(await screen.findByText('market raw')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('covers empty-array dialog, import string failure and shutdown failure', async () => {
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_install_local: () => { throw 'import raw' },
      'plugin:dialog|open': () => [],
      dsh_shutdown: () => { throw new Error('runtime not running') },
    })
    try {
      render(<PluginsTab />)
      await screen.findByText('安装插件')
      // 空数组对话框 → 导入忽略
      fireEvent.click(screen.getByText('导入 Zip'))
      await act(async () => { await Promise.resolve() })
      expect(screen.queryByText('import raw')).toBeNull()
    } finally {
      restore()
    }
  })

  it('covers import Error and string failures', async () => {
    let releaseImport: ((error: unknown) => void) | null = null
    let installCalls = 0
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      'plugin:dialog|open': () => 'C:/p.zip',
      dsh_plugin_install_local: () => {
        installCalls += 1
        if (installCalls === 1) {
          return new Promise((_resolve, reject) => {
            releaseImport = reject
          })
        }
        throw 'import raw'
      },
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      await screen.findByText('安装插件')
      fireEvent.click(screen.getByText('导入 Zip'))
      await vi.waitFor(() =>{  expect(releaseImport).not.toBeNull() })
      releaseImport!(new Error('import boom')) // Error 路径
      expect(await screen.findByText('import boom')).toBeTruthy()
      fireEvent.click(screen.getByText('导入 Zip'))
      expect(await screen.findByText('import raw')).toBeTruthy() // String 路径
    } finally {
      restore()
    }
  })

  it('silently ignores installed-list failures (markers only)', async () => {
    const restore = stubTauriInternals({
      dsh_plugin_list: () => { throw 'list raw failure' },
      dsh_plugin_market_fetch: () => ({
        stale: false,
        categories: [{ name: '工具', plugins: [{ name: 'A', url: 'https://x/a', description: 'a' }] }],
      }),
    })
    try {
      render(<PluginsTab />)
      // 列表失败不打扰:市场仍渲染,无错误文案
      expect(await screen.findByText('A')).toBeTruthy()
      expect(screen.queryByText('list raw failure')).toBeNull()
    } finally {
      restore()
    }
  })
})

describe('ai extra branches', () => {
  it('covers asset-scope labels, all memory toggles and string failures (whitelist removed)', async () => {
    const restore = stubTauriInternals({
      ai_memory_list: () => [
        { id: 'm1', scope: 'asset:abc', content: 'A'.repeat(2400), created_at: 0, updated_at: 0 },
        { id: 'm2', scope: 'asset:xyz', content: 'b', created_at: 0, updated_at: 0 },
      ],
      ai_memory_update: () => { throw 'raw save failure' },
      ai_memory_delete: () => { throw 'raw delete failure' },
    })
    try {
      render(<AiTab />)
      // 白名单已移除:不再出现输入框与保存反馈
      expect(screen.queryByPlaceholderText(/输入命令前缀/)).toBeNull()
      // 四个记忆开关
      fireEvent.click(screen.getByText('存档 tool 消息与工具调用'))
      fireEvent.click(screen.getByText('记忆写入需逐条确认'))
      // v0.92.0 起「自动沉淀记忆」默认 false,点击后变 true。
      fireEvent.click(screen.getByText('自动沉淀记忆'))
      const stored = () => JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? '{}') as {
        settings: { memoryStoreToolOutputs: boolean; memoryWriteNeedsConfirm: boolean; memoryAutoReview: boolean }
      }
      expect(stored().settings.memoryStoreToolOutputs).toBe(true)
      expect(stored().settings.memoryWriteNeedsConfirm).toBe(true)
      expect(stored().settings.memoryAutoReview).toBe(true)
      // 记忆管理:asset scope 分组 + 超容量标红 + 编辑/删除字符串失败
      fireEvent.click(screen.getByText('管理记忆'))
      expect(await screen.findByText('ASSET — abc')).toBeTruthy()
      expect(screen.getByText('ASSET — xyz')).toBeTruthy()
      expect(screen.getByText(/2400\/1375 字符/)).toBeTruthy()
      fireEvent.click(screen.getAllByLabelText('编辑')[0]!)
      fireEvent.change(within(screen.getByRole('dialog', { name: '长期记忆管理' })).getByRole('textbox'), { target: { value: '新内容' } })
      fireEvent.click(within(screen.getByRole('dialog', { name: '长期记忆管理' })).getByText('保存'))
      expect(await screen.findByText('raw save failure')).toBeTruthy()
      // 两段删除:取消后再删(字符串失败)
      fireEvent.click(screen.getAllByLabelText('删除')[0]!)
      fireEvent.click(screen.getAllByText('取消')[1]!) // 删除确认行的取消
      expect(screen.queryByText(/确认删除这条记忆/)).toBeNull()
      fireEvent.click(screen.getAllByLabelText('删除')[0]!)
      fireEvent.click(screen.getByText('删除'))
      expect(await screen.findByText('raw delete failure')).toBeTruthy()
      // 弹窗:刷新 / 关闭 / backdrop
      fireEvent.click(screen.getByLabelText('刷新'))
      await act(async () => { await Promise.resolve() })
      fireEvent.mouseDown(screen.getByRole('dialog', { name: '长期记忆管理' }))
      expect(screen.getByRole('dialog', { name: '长期记忆管理' })).toBeTruthy() // panel 阻止冒泡
      fireEvent.mouseDown(screen.getByRole('dialog', { name: '长期记忆管理' }).parentElement!)
      expect(screen.queryByRole('dialog', { name: '长期记忆管理' })).toBeNull()
    } finally {
      restore()
    }
  })

  it('labels folder-scope memories with the workspace basename', async () => {
    const restore = stubTauriInternals({
      ai_memory_list: () => [
        { id: 'm1', scope: 'folder:E:\\ws\\starhub', content: 'x', created_at: 0, updated_at: 0 },
      ],
    })
    try {
      render(<AiTab />)
      fireEvent.click(screen.getByText('管理记忆'))
      expect(await screen.findByText('工作区 — starhub(E:\\ws\\starhub)')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('syncs both memory toggles to the host namespace when an api is present', async () => {
    const update = vi.fn<(request: unknown) => Promise<void>>(() => Promise.resolve())
    const api = { settings: { update } } as unknown as IApiClient
    render(<AiTab api={api} />)
    await act(async () => { await Promise.resolve() })
    // 挂载时把 localStorage 里的两个开关(v0.92.0 起默认 false)补齐到 host namespace。
    expect(update).toHaveBeenCalledWith({ ns: 'starhub-memory-context', patch: { enabled: false } })
    expect(update).toHaveBeenCalledWith({ ns: 'starhub-memory-context', patch: { autoReview: false } })
    fireEvent.click(screen.getByText('启用长期记忆'))
    await act(async () => { await Promise.resolve() })
    expect(update).toHaveBeenCalledWith({ ns: 'starhub-memory-context', patch: { enabled: true } })
  })

  it('keeps rendering when the host namespace sync rejects (legacy runtime)', async () => {
    const update = vi.fn<(request: unknown) => Promise<void>>(() => Promise.reject(new Error('unknown namespace')))
    const api = { settings: { update } } as unknown as IApiClient
    render(<AiTab api={api} />)
    await act(async () => { await Promise.resolve() })
    expect(update).toHaveBeenCalled()
    // 同步失败静默:开关仍以 localStorage 为准,设置页正常渲染。
    expect(screen.getByText('记忆与上下文')).toBeTruthy()
  })

  it('shows memory load failures (Error then string via refresh)', async () => {
    let listCalls = 0
    const restore = stubTauriInternals({
      ai_memory_list: () => {
        listCalls += 1
        if (listCalls === 1) throw new Error('list boom')
        throw 'list raw'
      },
    })
    try {
      render(<AiTab />)
      fireEvent.click(screen.getByText('管理记忆'))
      expect(await screen.findByText('list boom')).toBeTruthy()
      fireEvent.click(screen.getByLabelText('刷新'))
      expect(await screen.findByText('list raw')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('covers Error-path memory failures, dialog close and edit cancel', async () => {
    const restore = stubTauriInternals({
      ai_memory_list: () => [{ id: 'm1', scope: 'user', content: 'c', created_at: 0, updated_at: 0 }],
      ai_memory_update: () => { throw new Error('save boom') },
      ai_memory_delete: () => { throw new Error('delete boom') },
    })
    try {
      render(<AiTab />)
      // 记忆编辑 Error 失败 + 编辑态取消
      fireEvent.click(screen.getByText('管理记忆'))
      fireEvent.click(await screen.findByLabelText('编辑'))
      const dialog = () => screen.getByRole('dialog', { name: '长期记忆管理' })
      fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: '新内容' } })
      fireEvent.click(within(dialog()).getByText('保存'))
      expect(await screen.findByText('save boom')).toBeTruthy()
      fireEvent.click(within(dialog()).getByText('取消')) // 退出编辑态
      expect(within(dialog()).queryByRole('textbox')).toBeNull()
      // 删除 Error 失败
      fireEvent.click(screen.getAllByLabelText('删除')[0]!)
      fireEvent.click(screen.getByText('删除'))
      expect(await screen.findByText('delete boom')).toBeTruthy()
      // 关闭按钮关弹窗
      fireEvent.click(screen.getByLabelText('关闭'))
      expect(screen.queryByRole('dialog', { name: '长期记忆管理' })).toBeNull()
    } finally {
      restore()
    }
  })
})
