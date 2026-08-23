// @vitest-environment jsdom
/**
 * Settings 服务层(services.ts)与 AI 设置持久化桥(aiSettings.ts):
 * isTauriRuntime 守卫分支、命令转发参数、updater 的 plugin:updater|* 直调,
 * 以及 ai-v2 localStorage 的读/写/归一化(V3 白名单迁移)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiMemoryDelete, aiMemoryList, aiMemoryUpdate, checkForUpdates, clearAuditLogs,
  createAlertRule, deleteAlertRule, downloadAndInstall, fetchAlertRules, fetchAuditLogs,
  fetchAuditStats, fetchPluginMarket, installLocalPlugin, installPluginFromUrl, isTauriRuntime,
  listPlugins, logAudit, setPluginEnabled, shutdownDshRuntime, testAlertWebhook,
  uninstallPlugin, updateAlertRule,
} from '../src/client/settings/services.ts'
import {
  AI_STORAGE_KEY, loadAiSettings, normalizeAiSettings, saveAiSettings,
} from '../src/client/settings/aiSettings.ts'

/** jsdom 全局下的 Tauri IPC stub 挂载/卸载。 */
function stubTauriInternals(invoke: (cmd: string, args?: unknown) => Promise<unknown>): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke }
  return () => {
    if (prev === undefined) {
      delete w.__TAURI_INTERNALS__
    } else {
      w.__TAURI_INTERNALS__ = prev
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('isTauriRuntime', () => {
  it('detects the injected Tauri surface', () => {
    expect(isTauriRuntime()).toBe(false)
    const restore = stubTauriInternals(() => Promise.resolve(null))
    try {
      expect(isTauriRuntime()).toBe(true)
    } finally {
      restore()
    }
  })
})

describe('audit services', () => {
  it('logAudit forwards fields and is a no-op in preview', async () => {
    expect(await logAudit({ category: 'ai', action: 'memory_update', target: 'user' })).toBe(0)
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(7))
    const restore = stubTauriInternals(invoke)
    try {
      await expect(logAudit({ category: 'ai', action: 'memory_update', target: 'user', success: false }))
        .resolves.toBe(7)
      expect(invoke).toHaveBeenCalledWith('audit_log', {
        category: 'ai', action: 'memory_update', target: 'user',
        detail: null, sessionId: null, assetId: null, success: false,
      })
    } finally {
      restore()
    }
  })

  it('fetchAuditLogs forwards the fixed 200/0 pagination and filter', async () => {
    expect(await fetchAuditLogs({})).toEqual([])
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve([{ id: 1 }]))
    const restore = stubTauriInternals(invoke)
    try {
      const rows = await fetchAuditLogs({ categoryFilter: 'ssh' })
      expect(rows).toEqual([{ id: 1 }])
      expect(invoke).toHaveBeenCalledWith('audit_list', { limit: 200, offset: 0, categoryFilter: 'ssh' })
    } finally {
      restore()
    }
  })

  it('clearAuditLogs and fetchAuditStats degrade in preview and forward in desktop', async () => {
    expect(await clearAuditLogs()).toBe(0)
    expect(await fetchAuditStats()).toEqual([])
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'audit_clear') return Promise.resolve(3)
      if (cmd === 'audit_stats') return Promise.resolve([{ category: 'ssh' }])
      return Promise.resolve(null)
    })
    const restore = stubTauriInternals(invoke)
    try {
      await expect(clearAuditLogs()).resolves.toBe(3)
      await expect(fetchAuditStats()).resolves.toEqual([{ category: 'ssh' }])
    } finally {
      restore()
    }
  })
})

describe('alert services', () => {
  it('createAlertRule returns a browser mock in preview', async () => {
    const rule = await createAlertRule({ name: 'r', category: 'ssh', metric: 'ssh.error_count', operator: '>', threshold: 1 })
    expect(rule.id).toMatch(/^browser-/)
    expect(rule.enabled).toBe(true)
    expect(rule.duration_sec).toBe(0)
    expect(rule.cooldown_sec).toBe(300)
    expect(rule.created_at).toBeGreaterThan(0)
  })

  it('update/delete/test/fetch/list degrade or throw in preview and forward in desktop', async () => {
    await expect(updateAlertRule('x', {} as never)).rejects.toThrow('桌面端')
    await expect(deleteAlertRule('x')).resolves.toBeUndefined()
    await expect(testAlertWebhook('http://x')).rejects.toThrow('桌面端')
    expect(await fetchAlertRules()).toEqual([])

    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'alert_update') return Promise.resolve({ id: 'x' })
      if (cmd === 'alert_delete') return Promise.resolve(null)
      if (cmd === 'alert_test_webhook') return Promise.resolve('✓ ok')
      if (cmd === 'alert_list') return Promise.resolve([{ id: 'x' }])
      if (cmd === 'alert_create') return Promise.resolve({ id: 'x' })
      return Promise.resolve(null)
    })
    const restore = stubTauriInternals(invoke)
    try {
      await expect(updateAlertRule('x', {} as never)).resolves.toEqual({ id: 'x' })
      await deleteAlertRule('x')
      await expect(testAlertWebhook('http://x')).resolves.toBe('✓ ok')
      await expect(fetchAlertRules()).resolves.toEqual([{ id: 'x' }])
      await createAlertRule({ name: 'r', category: 'ssh', metric: 'm', operator: '>', threshold: 1 })
    } finally {
      restore()
    }
  })
})

describe('plugin services', () => {
  it('degrades in preview and forwards commands in desktop', async () => {
    expect(await listPlugins()).toEqual([])
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'dsh_plugin_list') return Promise.resolve([{ id: 'p1' }])
      if (cmd === 'dsh_plugin_install_local') return Promise.resolve({ id: 'p1' })
      if (cmd === 'dsh_plugin_install_url') return Promise.resolve({ id: 'p1' })
      if (cmd === 'dsh_plugin_set_enabled') return Promise.resolve(null)
      if (cmd === 'dsh_plugin_uninstall') return Promise.resolve(null)
      if (cmd === 'dsh_plugin_market_fetch') return Promise.resolve({ stale: false, categories: [] })
      if (cmd === 'dsh_shutdown') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    const restore = stubTauriInternals(invoke)
    try {
      await expect(listPlugins()).resolves.toEqual([{ id: 'p1' }])
      await expect(installLocalPlugin('C:/p')).resolves.toEqual({ id: 'p1' })
      await expect(installPluginFromUrl('https://x')).resolves.toEqual({ id: 'p1' })
      await setPluginEnabled('p1', true)
      await uninstallPlugin('p1')
      await expect(fetchPluginMarket(true)).resolves.toEqual({ stale: false, categories: [] })
      await shutdownDshRuntime()
      expect(invoke.mock.calls.map(c => c[0])).toEqual([
        'dsh_plugin_list', 'dsh_plugin_install_local', 'dsh_plugin_install_url',
        'dsh_plugin_set_enabled', 'dsh_plugin_uninstall', 'dsh_plugin_market_fetch', 'dsh_shutdown',
      ])
    } finally {
      restore()
    }
  })
})

describe('updater services', () => {
  it('degrades to no-update in preview', async () => {
    await expect(checkForUpdates()).resolves.toEqual({ available: false })
    await expect(downloadAndInstall()).resolves.toBeUndefined()
  })

  it('checkForUpdates maps the metadata and downloadAndInstall drives the plugin commands', async () => {
    const invoke = vi.fn((cmd: string, _args?: unknown) => {
      if (cmd === 'plugin:updater|check') return Promise.resolve({ rid: 1, version: '9.9.9', date: '2026-01-01', body: 'b' })
      if (cmd === 'plugin:updater|download_and_install') return Promise.resolve(null)
      if (cmd === 'plugin:process|restart') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: unknown; transformCallback: unknown } }
    const restore = stubTauriInternals(invoke)
    w.__TAURI_INTERNALS__.transformCallback = () => 42
    try {
      await expect(checkForUpdates()).resolves.toEqual({
        available: true, version: '9.9.9', date: '2026-01-01', body: 'b',
      })
      await downloadAndInstall()
      expect(invoke.mock.calls.map(c => c[0])).toEqual([
        'plugin:updater|check', 'plugin:updater|check', 'plugin:updater|download_and_install', 'plugin:process|restart',
      ])
      const downloadArgs = invoke.mock.calls[2]![1]! as { onEvent: { toJSON: () => string }; rid: number }
      expect(downloadArgs.rid).toBe(1)
      expect(downloadArgs.onEvent.toJSON()).toBe('__CHANNEL__:42')
    } finally {
      restore()
    }
  })

  it('downloadAndInstall stops when the check finds no update', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    const restore = stubTauriInternals(invoke)
    try {
      await downloadAndInstall()
      expect(invoke).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})

describe('memory services', () => {
  it('degrades in preview and forwards in desktop', async () => {
    expect(await aiMemoryList()).toEqual([])
    await expect(aiMemoryUpdate('m1', 'c')).rejects.toThrow('桌面版')
    await expect(aiMemoryDelete('m1')).resolves.toBeUndefined()
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'ai_memory_list') return Promise.resolve([{ id: 'm1' }])
      if (cmd === 'ai_memory_update') return Promise.resolve({ id: 'm1' })
      if (cmd === 'ai_memory_delete') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    const restore = stubTauriInternals(invoke)
    try {
      await expect(aiMemoryList('user')).resolves.toEqual([{ id: 'm1' }])
      await expect(aiMemoryUpdate('m1', 'c')).resolves.toEqual({ id: 'm1' })
      await aiMemoryDelete('m1')
    } finally {
      restore()
    }
  })
})

describe('aiSettings persistence bridge', () => {
  it('returns defaults when nothing is stored', () => {
    const settings = loadAiSettings()
    // v0.92.0 起 memoryEnabled + memoryAutoReview 默认均为关闭;用户需在设置面板显式打开。
    expect(settings.memoryEnabled).toBe(false)
    expect(settings.memoryAutoReview).toBe(false)
    // 命令白名单已移除,随「统一走 deepseek-harness 权限体系」
    expect('commandWhitelist' in settings).toBe(false)
    // 上下文预算/迭代步数/压缩阈值由 dsh harness 接管,不参与读写
    expect('compactTriggerRatio' in settings).toBe(false)
  })

  it('drops legacy whitelist fields from stored data', () => {
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { commandWhitelist: ['ls'], commandWhitelistVersion: 3 },
    }))
    const settings = loadAiSettings()
    expect('commandWhitelist' in settings).toBe(false)
    expect('commandWhitelistVersion' in settings).toBe(false)
    // 无有效 memoryEnabled 时回落默认值 false(v0.92.0 起)
    expect(settings.memoryEnabled).toBe(false)
  })

  it('normalizes malformed fields back to defaults', () => {
    const settings = normalizeAiSettings({
      memoryStoreToolOutputs: 'yes' as never,
      memoryEnabled: false,
      memoryWriteNeedsConfirm: true,
      memoryAutoReview: false,
    })
    expect(settings.memoryStoreToolOutputs).toBe(false)
    expect(settings.memoryEnabled).toBe(false)
    expect(settings.memoryWriteNeedsConfirm).toBe(true)
    expect(settings.memoryAutoReview).toBe(false)
  })

  it('saveAiSettings replaces only the settings field and keeps the rest', () => {
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
      settings: { commandWhitelist: ['ls'], commandWhitelistVersion: 3 },
      agents: [{ id: 'a1' }],
      conversationSummaries: [{ id: 'c1' }],
    }))
    saveAiSettings(normalizeAiSettings({ memoryEnabled: false }))
    const stored = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? '{}') as {
      settings: { memoryEnabled: boolean; commandWhitelist?: string[] }
      agents: unknown[]
      conversationSummaries: unknown[]
    }
    expect(stored.settings.memoryEnabled).toBe(false)
    expect(stored.settings.commandWhitelist).toBeUndefined()
    expect(stored.agents).toEqual([{ id: 'a1' }])
    expect(stored.conversationSummaries).toEqual([{ id: 'c1' }])
  })

  it('handles corrupted storage gracefully', () => {
    localStorage.setItem(AI_STORAGE_KEY, '{broken')
    expect(loadAiSettings().memoryEnabled).toBe(false)
    localStorage.setItem(AI_STORAGE_KEY, '{broken')
    expect(() =>{  saveAiSettings(loadAiSettings()) }).not.toThrow()
  })
})
