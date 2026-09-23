// @vitest-environment jsdom
/**
 * Settings 服务层(services.ts):isTauriRuntime 守卫分支、命令转发参数、
 * updater 的 plugin:updater|* 直调。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkForUpdates, clearAuditLogs,
  createAlertRule, deleteAlertRule, downloadAndInstall, fetchAlertRules, fetchAuditLogs,
  fetchAuditStats, isTauriRuntime,
  testAlertWebhook,
  updateAlertRule,
} from '../src/client/settings/services.ts'

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
