// @vitest-environment jsdom
/**
 * Settings 服务层(services.ts):isTauriRuntime 守卫分支、命令转发参数;
 * 自更新归 Electron 壳(checkForUpdates 恒无更新、downloadAndInstall 无动作)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkForUpdates, clearAuditLogs,
  createAlertRule, deleteAlertRule, downloadAndInstall, fetchAlertRules, fetchAuditLogs,
  fetchAuditStats, isTauriRuntime,
  testAlertWebhook,
  updateAlertRule,
} from '../src/client/settings/services.ts'
import {
  hostBridgeCalls, restoreHostBridge, stubHostBridge,
} from './host-bridge.ts'

/** 安装宿主桥 invoke 替身;返回还原回调。 */
function stubTauriInternals(invoke: (cmd: string, args?: unknown) => Promise<unknown>): () => void {
  stubHostBridge(invoke)
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

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  restoreHostBridge()
})

describe('isTauriRuntime', () => {
  it('detects the host bridge; false while fetch is absent', () => {
    expect(isTauriRuntime()).toBe(true)
    // 移除 fetch = 无宿主可达(裸浏览器预览)
    const original = globalThis.fetch
    Reflect.deleteProperty(globalThis, 'fetch')
    try {
      expect(isTauriRuntime()).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('audit services', () => {
  it('fetchAuditLogs forwards the fixed 200/0 pagination and filter', async () => {
    await withoutHostBridge(async () => { expect(await fetchAuditLogs({})).toEqual([]) })
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
    await withoutHostBridge(async () => {
      expect(await clearAuditLogs()).toBe(0)
      expect(await fetchAuditStats()).toEqual([])
    })
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
    await withoutHostBridge(async () => {
      const rule = await createAlertRule({ name: 'r', category: 'ssh', metric: 'ssh.error_count', operator: '>', threshold: 1 })
      expect(rule.id).toMatch(/^browser-/)
      expect(rule.enabled).toBe(true)
      expect(rule.duration_sec).toBe(0)
      expect(rule.cooldown_sec).toBe(300)
      expect(rule.created_at).toBeGreaterThan(0)
    })
  })

  it('update/delete/test/fetch/list degrade or throw in preview and forward in desktop', async () => {
    await withoutHostBridge(async () => {
      await expect(updateAlertRule('x', {} as never)).rejects.toThrow('桌面端')
      await expect(deleteAlertRule('x')).resolves.toBeUndefined()
      await expect(testAlertWebhook('http://x')).rejects.toThrow('桌面端')
      expect(await fetchAlertRules()).toEqual([])
    })
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
  it('reports no update — self-update moved to the Electron shell', async () => {
    await expect(checkForUpdates()).resolves.toEqual({ available: false })
    await expect(downloadAndInstall()).resolves.toBeUndefined()
  })

  it('makes no bridge calls — self-update belongs to the Electron shell', async () => {
    stubHostBridge(vi.fn((..._args: unknown[]) => Promise.resolve(null)))
    await expect(checkForUpdates()).resolves.toEqual({ available: false })
    await expect(downloadAndInstall()).resolves.toBeUndefined()
    expect(hostBridgeCalls()).toEqual([])
  })
})
