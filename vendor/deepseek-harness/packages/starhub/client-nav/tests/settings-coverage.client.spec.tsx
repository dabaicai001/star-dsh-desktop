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
import { PluginsTab, ConfirmActionDialog } from '../src/client/settings/plugins.tsx'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AiTab } from '../src/client/settings/ai.tsx'
import {
  checkForUpdates, logAudit, type DshPluginInfo,
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

/** 空模型目录响应(llm.models 桩)。 */
function mkEmptyCatalog() {
  return { result: { ok: true as const, value: { groups: [], failures: [] } } }
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
  it('recovers non-boolean memory flags and drops retired fields', () => {
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
    expect('memoryWriteNeedsConfirm' in settings).toBe(false)
    expect('memoryAutoReview' in settings).toBe(false)
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
      // 市场刷新按钮(已装段 + 市场段各有一个「刷新」,取最后一个即市场)
      fireEvent.click(screen.getAllByText('刷新').at(-1)!)
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

  it('surfaces installed-list failures in the list section while the market still renders', async () => {
    const restore = stubTauriInternals({
      dsh_plugin_list: () => { throw 'list raw failure' },
      dsh_plugin_market_fetch: () => ({
        stale: false,
        categories: [{ name: '工具', plugins: [{ name: 'A', url: 'https://x/a', description: 'a' }] }],
      }),
    })
    try {
      render(<PluginsTab />)
      // 列表失败在已装段露出,市场仍渲染,不崩
      expect(await screen.findByText('list raw failure')).toBeTruthy()
      expect(screen.getByText('A')).toBeTruthy()
      expect(screen.getByText('暂无已安装插件。')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('ai extra branches', () => {
  it('covers asset-scope labels, all memory toggles and string failures (whitelist removed)', async () => {
    // v0.94.0:预置记忆模型路由,两个记忆功能开关才能勾选。
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { memoryProvider: 'deepseek-official', memoryModel: 'deepseek-chat' },
    }))
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
      // 已退役开关不再渲染
      expect(screen.queryByText('存档 tool 消息与工具调用')).toBeNull()
      expect(screen.queryByText('记忆写入需逐条确认')).toBeNull()
      // 长期记忆总开关:点击变 true(自动沉淀同值)。
      fireEvent.click(screen.getByText('启用长期记忆与自动沉淀'))
      const stored = () => JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? '{}') as {
        settings: { memoryEnabled: boolean }
      }
      expect(stored().settings.memoryEnabled).toBe(true)
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

  it('syncs the memory toggle to the host namespace when an api is present', async () => {
    const update = vi.fn<(request: unknown) => Promise<void>>(() => Promise.resolve())
    const api = {
      settings: { update },
      llm: { models: vi.fn(async () => mkEmptyCatalog()) },
    } as unknown as IApiClient
    // v0.94.0:预置路由,「启用长期记忆」才能被勾选。
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { memoryProvider: 'deepseek-official', memoryModel: 'deepseek-chat' },
    }))
    render(<AiTab api={api} />)
    await act(async () => { await Promise.resolve() })
    // 挂载时把 localStorage 里的开关(v0.92.0 起默认 false)补齐到 host namespace;
    // v0.96.4 起 enabled 与 autoReview 同值下发。
    expect(update).toHaveBeenCalledWith({ ns: 'starhub-memory-context', patch: { enabled: false, autoReview: false } })
    expect(update).toHaveBeenCalledWith({
      ns: 'starhub-memory-context',
      patch: { memoryProvider: 'deepseek-official', memoryModel: 'deepseek-chat' },
    })
    fireEvent.click(screen.getByText('启用长期记忆与自动沉淀'))
    await act(async () => { await Promise.resolve() })
    expect(update).toHaveBeenCalledWith({ ns: 'starhub-memory-context', patch: { enabled: true, autoReview: true } })
  })

  it('keeps rendering when the host namespace sync rejects (legacy runtime)', async () => {
    const update = vi.fn<(request: unknown) => Promise<void>>(() => Promise.reject(new Error('unknown namespace')))
    const api = {
      settings: { update },
      llm: { models: vi.fn(async () => mkEmptyCatalog()) },
    } as unknown as IApiClient
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

describe('plugins installed list', () => {
  const ackKey = 'starhub.plugins.enable-acknowledged'

  /** 便捷构造一个已装插件记录(默认 url 来源、未启用、非内置)。 */
  function plugin(over: Partial<DshPluginInfo> = {}): DshPluginInfo {
    return {
      id: 'p1', name: 'P1', version: '1.0.0', source: { kind: 'url' },
      entry: 'index.js', enabled: false, ...over,
    }
  }

  it('renders installed cards with source labels and badges', async () => {
    const restore = stubTauriInternals({
      dsh_plugin_list: () => ([
        plugin({ id: 'market', name: 'MarketP', version: '1.0.0', source: { kind: 'market' }, enabled: true }),
        plugin({ id: 'url', name: 'UrlP', version: '2.0.0', description: 'desc' }),
        plugin({ id: 'dir', name: 'DirP', version: '3.0.0', source: { kind: 'local-dir' }, enabled: true, license: 'MIT', dshClient: true }),
        plugin({ id: 'zip', name: 'ZipP', version: '4.0.0', source: { kind: 'local-zip' } }),
        plugin({ id: 'builtin', name: 'BuiltinP', version: '5.0.0', source: { kind: 'builtin' }, enabled: true, builtin: true }),
        plugin({ id: 'other', name: 'OtherP', version: '6.0.0', source: { kind: 'weird' }, missing: true }),
      ]),
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
    })
    try {
      render(<PluginsTab />)
      expect(await screen.findByText('MarketP')).toBeTruthy()
      expect(screen.getAllByText('已启用').length).toBe(3)
      expect(screen.getAllByText('已禁用').length).toBe(3)
      expect(screen.getByText('UI')).toBeTruthy() // dshClient 徽标
      expect(screen.getAllByText('内置').length).toBe(2) // 徽标 + 来源标签
      expect(screen.getByText('缺失')).toBeTruthy()
      expect(screen.getByText('v1.0.0')).toBeTruthy()
      expect(screen.getByText('MIT')).toBeTruthy()
      expect(screen.getByText('市场')).toBeTruthy()
      expect(screen.getByText('URL')).toBeTruthy()
      expect(screen.getByText('目录')).toBeTruthy()
      expect(screen.getByText('Zip')).toBeTruthy()
      expect(screen.getByText('weird')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('enables a plugin via the risk dialog after cancel, then confirm', async () => {
    const setEnabled = vi.fn((..._a: unknown[]) => null)
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_set_enabled: args => setEnabled(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      // 首次启用 → 风险确认(非 UI 类文案)
      fireEvent.click(await screen.findByLabelText('启用'))
      const dialog = () => screen.getByRole('dialog', { name: '启用插件' })
      expect(within(dialog()).getByText(/该插件来自第三方/)).toBeTruthy()
      // 取消 → 不启用、弹窗关闭
      fireEvent.click(within(dialog()).getByText('取消'))
      expect(screen.queryByRole('dialog', { name: '启用插件' })).toBeNull()
      expect(setEnabled).not.toHaveBeenCalled()
      // 再次开启 → 确认 → 启用并记 ack
      fireEvent.click(screen.getByLabelText('启用'))
      fireEvent.click(within(screen.getByRole('dialog', { name: '启用插件' })).getByText('启用'))
      await vi.waitFor(() =>{  expect(setEnabled).toHaveBeenCalledWith({ id: 'p1', enabled: true }) })
      expect(JSON.parse(localStorage.getItem(ackKey) ?? '[]')).toContain('p1')
    } finally {
      restore()
    }
  })

  it('enables a plugin directly when already acknowledged', async () => {
    localStorage.setItem(ackKey, JSON.stringify(['p1']))
    const setEnabled = vi.fn((..._a: unknown[]) => null)
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_set_enabled: args => setEnabled(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('启用'))
      expect(screen.queryByRole('dialog', { name: '启用插件' })).toBeNull()
      await vi.waitFor(() =>{  expect(setEnabled).toHaveBeenCalledWith({ id: 'p1', enabled: true }) })
    } finally {
      restore()
    }
  })

  it('disables an installed plugin', async () => {
    const setEnabled = vi.fn((..._a: unknown[]) => null)
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin({ enabled: true })],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_set_enabled: args => setEnabled(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('禁用'))
      await vi.waitFor(() =>{  expect(setEnabled).toHaveBeenCalledWith({ id: 'p1', enabled: false }) })
    } finally {
      restore()
    }
  })

  it('surfaces enable failures (Error then string)', async () => {
    localStorage.setItem(ackKey, JSON.stringify(['p1']))
    let calls = 0
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_set_enabled: () => {
        calls += 1
        if (calls === 1) throw new Error('enable boom')
        throw 'enable raw'
      },
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('启用'))
      expect(await screen.findByText('enable boom')).toBeTruthy()
      fireEvent.click(screen.getByLabelText('启用'))
      expect(await screen.findByText('enable raw')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows the dsh.client risk warning for a UI plugin', async () => {
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin({ dshClient: true })],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('启用'))
      expect(within(screen.getByRole('dialog', { name: '启用插件' })).getByText(/浏览器端 UI\(dsh\.client\)/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('uninstalls a plugin after confirm, cancels before', async () => {
    const uninstall = vi.fn((..._a: unknown[]) => null)
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_uninstall: args => uninstall(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('卸载'))
      const dialog = () => screen.getByRole('dialog', { name: '卸载插件' })
      expect(within(dialog()).getByText(/确定卸载插件「P1」/)).toBeTruthy()
      fireEvent.click(within(dialog()).getByText('取消'))
      expect(screen.queryByRole('dialog', { name: '卸载插件' })).toBeNull()
      expect(uninstall).not.toHaveBeenCalled()
      // 卸载按钮在 busy 时整体禁用;此处无 busy → 正常打开再确认
      fireEvent.click(screen.getByLabelText('卸载'))
      fireEvent.click(within(screen.getByRole('dialog', { name: '卸载插件' })).getByText('卸载'))
      await vi.waitFor(() =>{  expect(uninstall).toHaveBeenCalledWith({ id: 'p1' }) })
    } finally {
      restore()
    }
  })

  it('surfaces uninstall failures (Error then string)', async () => {
    let calls = 0
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_uninstall: () => {
        calls += 1
        if (calls === 1) throw new Error('uninstall boom')
        throw 'uninstall raw'
      },
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('卸载'))
      fireEvent.click(within(screen.getByRole('dialog', { name: '卸载插件' })).getByText('卸载'))
      expect(await screen.findByText('uninstall boom')).toBeTruthy()
      fireEvent.click(screen.getByLabelText('卸载'))
      fireEvent.click(within(screen.getByRole('dialog', { name: '卸载插件' })).getByText('卸载'))
      expect(await screen.findByText('uninstall raw')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('continues when the ack write fails', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    const setEnabled = vi.fn((..._a: unknown[]) => null)
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_set_enabled: args => setEnabled(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('启用'))
      fireEvent.click(within(screen.getByRole('dialog', { name: '启用插件' })).getByText('启用'))
      // ack 写入失败被吞掉,启用仍照常执行
      await vi.waitFor(() =>{  expect(setEnabled).toHaveBeenCalledWith({ id: 'p1', enabled: true }) })
    } finally {
      setItem.mockRestore()
      restore()
    }
  })

  it('ignores toggling a second plugin while another is busy', async () => {
    const setEnabled = vi.fn((args?: unknown) => {
      const id = (args as { id?: string } | undefined)?.id
      return id === 'A' ? new Promise(() => {}) : null
    })
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin({ id: 'A', name: 'A', enabled: true }), plugin({ id: 'B', name: 'B', enabled: true })],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
      dsh_plugin_set_enabled: args => setEnabled(args),
      dsh_shutdown: () => null,
    })
    try {
      render(<PluginsTab />)
      // 触发 A 的禁用,其后端命令永不 resolve → pluginBusyId 保持 'A'
      fireEvent.click((await screen.findAllByLabelText('禁用'))[0]!)
      // 再点 B 的禁用 → busy 守卫直接返回,不触发命令
      fireEvent.click(screen.getAllByLabelText('禁用')[1]!)
      await vi.waitFor(() =>{  expect(setEnabled).toHaveBeenCalledTimes(1) })
    } finally {
      restore()
    }
  })

  it('treats a corrupt ack record as unacknowledged (enables via the risk dialog)', async () => {
    localStorage.setItem(ackKey, 'not-json')
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [plugin()],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
    })
    try {
      render(<PluginsTab />)
      fireEvent.click(await screen.findByLabelText('启用'))
      expect(screen.getByRole('dialog', { name: '启用插件' })).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('refreshes the installed list from its section header', async () => {
    let listCalls = 0
    const restore = stubTauriInternals({
      dsh_plugin_list: () => { listCalls += 1; return [plugin()] },
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [] }),
    })
    try {
      render(<PluginsTab />)
      await screen.findByText('P1')
      // 已装段(第一个「刷新」)按钮触发重新拉取
      fireEvent.click(screen.getAllByText('刷新').at(0)!)
      await vi.waitFor(() =>{  expect(listCalls).toBeGreaterThanOrEqual(2) })
    } finally {
      restore()
    }
  })

  it('renders a non-danger confirm, closes on backdrop/close/cancel and stops panel mousedown', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmActionDialog title="确认" message="msg" confirmText="确定" onCancel={onCancel} onConfirm={onConfirm} />,
    )
    const dialog = screen.getByRole('dialog', { name: '确认' })
    const backdrop = dialog.parentElement as HTMLElement
    // 面板内 mousedown 阻止冒泡 → 不触发 backdrop 的 onCancel
    fireEvent.mouseDown(dialog)
    expect(onCancel).not.toHaveBeenCalled()
    // 确认按钮(non-danger → s.btn)
    fireEvent.click(within(dialog).getByText('确定'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // 取消 / 关闭按钮
    fireEvent.click(within(dialog).getByText('取消'))
    fireEvent.click(within(dialog).getByLabelText('关闭'))
    expect(onCancel).toHaveBeenCalledTimes(2)
    // backdrop mousedown → onCancel
    fireEvent.mouseDown(backdrop)
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  it('pages the market list and clamps an oversized page after a narrower search', async () => {
    const plugins = Array.from({ length: 7 }, (_, i) =>
      ({ name: `P${i}`, url: `https://x/p${i}`, description: 'd' }))
    const restore = stubTauriInternals({
      dsh_plugin_list: () => [],
      dsh_plugin_market_fetch: () => ({ stale: false, categories: [{ name: '工具', plugins }] }),
    })
    try {
      render(<PluginsTab />)
      expect(await screen.findByText('第 1 / 2 页 · 共 7 个插件')).toBeTruthy()
      fireEvent.click(screen.getByText('下一页'))
      expect(await screen.findByText('第 2 / 2 页 · 共 7 个插件')).toBeTruthy()
      fireEvent.click(screen.getByText('上一页'))
      expect(await screen.findByText('第 1 / 2 页 · 共 7 个插件')).toBeTruthy()
      // 回到第 2 页后搜索收窄到 1 页 → 页数收敛(覆盖 clamp + search 复位)
      fireEvent.click(screen.getByText('下一页'))
      expect(await screen.findByText('第 2 / 2 页 · 共 7 个插件')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('搜索插件…'), { target: { value: 'P0' } })
      expect(await screen.findByText('第 1 / 1 页 · 共 1 个插件')).toBeTruthy()
    } finally {
      restore()
    }
  })
})
