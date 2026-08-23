/**
 * 壳内状态纯逻辑:事实表(sections.ts)与选择桥/资产 holder(store.ts)。
 * Pins the per-asset route-prefix derivation (a PostgreSQL/Redis asset must
 * not inherit the database subcategory's /db/mysql prefix), the broker
 * subcategory归属(方案 2.1:终端含 Broker),the bridge's
 * generate-instanceId-once / clear-on-close semantics, and the asset holder's
 * refresh round-trip against a stubbed Tauri IPC surface.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assetWindowUrl, routeNameForAsset,
  routePrefixForAsset, STARHUB_SUBCATEGORIES,
  type StarHubAsset,
} from '../src/client/sections.ts'
import {
  createConnectionManagerOverlay, createStarHubAssets, createToolSelectionBridge,
} from '../src/client/store.ts'

/** 构造一个最小资产(只带匹配所需的字段)。 */
function asset(type: string, dbType?: string): StarHubAsset {
  return { id: `${type}-${dbType ?? 'x'}`, type, name: 'n', config: dbType === undefined ? {} : { dbType } }
}

/** 模拟未类型化的 IPC 拒绝(真实 Tauri 载荷可能是纯字符串而非 Error)。 */
function rawRejection(reason: string): Promise<never> {
  const reject = Promise.reject.bind(Promise)
  return reject(reason)
}

describe('routePrefixForAsset', () => {
  it('derives the prefix from the asset type, not the subcategory', () => {
    expect(routePrefixForAsset(asset('ssh'))).toBe('/ssh')
    expect(routePrefixForAsset(asset('docker'))).toBe('/docker')
    expect(routePrefixForAsset(asset('db', 'mysql'))).toBe('/db/mysql')
    expect(routePrefixForAsset(asset('db', 'postgresql'))).toBe('/db/postgresql')
    expect(routePrefixForAsset(asset('db', 'clickhouse'))).toBe('/db/clickhouse')
    expect(routePrefixForAsset(asset('db', 'redis'))).toBe('/db/redis')
    expect(routePrefixForAsset(asset('db', 'elasticsearch'))).toBe('/db/elasticsearch')
    expect(routePrefixForAsset(asset('db', 'kafka'))).toBe('/broker')
    expect(routePrefixForAsset(asset('db', 'nsq'))).toBe('/broker')
  })

  it('falls back to mysql for a non-string dbType', () => {
    expect(routeNameForAsset({ type: 'db', config: { dbType: 5 } })).toBe('db-mysql')
  })

  it('returns null for types without a function route', () => {
    expect(routePrefixForAsset(asset('local'))).toBeNull()
  })

  it('every subcategory-matched asset resolves a prefix (no dead rows)', () => {
    const samples = [
      asset('ssh'), asset('db', 'kafka'), asset('db', 'mysql'), asset('db', 'postgresql'),
      asset('db', 'clickhouse'), asset('db', 'redis'), asset('db', 'elasticsearch'), asset('docker'),
    ]
    for (const sub of STARHUB_SUBCATEGORIES) {
      for (const a of samples.filter(s => sub.matches(s))) {
        expect(routePrefixForAsset(a), `${sub.key} / ${routeNameForAsset(a)}`).not.toBeNull()
      }
    }
  })
})

describe('assetWindowUrl', () => {
  it('builds a /starhub-react window URL with an asset id and workbench hint', () => {
    expect(assetWindowUrl({ id: 'a1', type: 'ssh', name: 'n', config: {} }))
      .toBe('/starhub-react/index.html?asset=a1&workbench=ssh')
    expect(assetWindowUrl({ id: 'd1', type: 'docker', name: 'n', config: {} }))
      .toBe('/starhub-react/index.html?asset=d1&workbench=docker')
    expect(assetWindowUrl({ id: 'r1', type: 'db', name: 'n', config: { dbType: 'redis' } }))
      .toBe('/starhub-react/index.html?asset=r1&workbench=db-redis')
    expect(assetWindowUrl({ id: 'pg1', type: 'db', name: 'n', config: { dbType: 'postgresql' } }))
      .toBe('/starhub-react/index.html?asset=pg1&workbench=db-postgresql')
    expect(assetWindowUrl({ id: 'es1', type: 'db', name: 'n', config: { dbType: 'elasticsearch' } }))
      .toBe('/starhub-react/index.html?asset=es1&workbench=db-elasticsearch')
  })

  it('omits the workbench hint for types without a React workbench', () => {
    expect(assetWindowUrl({ id: 'l1', type: 'local', name: 'n', config: {} }))
      .toBe('/starhub-react/index.html?asset=l1')
  })
})

describe('STARHUB_SUBCATEGORIES', () => {
  it('puts broker under terminal and merges the five databases (plan §2.1)', () => {
    const terminal = STARHUB_SUBCATEGORIES.find(s => s.key === 'terminal')!
    const database = STARHUB_SUBCATEGORIES.find(s => s.key === 'database')!
    expect(terminal.matches(asset('db', 'kafka'))).toBe(true)
    expect(database.matches(asset('db', 'kafka'))).toBe(false)
    expect(database.matches(asset('db', 'redis'))).toBe(true)
    expect(terminal.matches(asset('ssh'))).toBe(true)
  })
})

describe('createToolSelectionBridge', () => {
  it('openAsset derives the per-asset prefix and generates the instance id once', () => {
    const bridge = createToolSelectionBridge()
    bridge.selectSubcategory('database')
    const pg = { ...asset('db', 'postgresql'), id: 'pg1' }
    bridge.openAsset(pg)
    const sel = bridge.source.getSnapshot()
    expect(sel.subcategory).toBe('database')
    expect(sel.assetId).toBe('pg1')
    expect(sel.routePrefix).toBe('/db/postgresql')
    expect(sel.instanceId).toMatch(/^pg1__\d+$/)
  })

  it('closeAsset clears the instance but keeps the subcategory', () => {
    const bridge = createToolSelectionBridge()
    bridge.selectSubcategory('terminal')
    bridge.openAsset({ ...asset('ssh'), id: 's1' })
    bridge.closeAsset()
    const sel = bridge.source.getSnapshot()
    expect(sel.subcategory).toBe('terminal')
    expect(sel.assetId).toBeNull()
    expect(sel.instanceId).toBeNull()
    expect(sel.routePrefix).toBeNull()
  })

  it('openAsset is a no-op for route-less asset types', () => {
    const bridge = createToolSelectionBridge()
    bridge.openAsset({ ...asset('local'), id: 'l1' })
    expect(bridge.source.getSnapshot().assetId).toBeNull()
  })
})

/** jsdom 全局下的 Tauri IPC stub 挂载/卸载。 */
function stubTauriInternals(invoke: (cmd: string) => Promise<unknown>): () => void {
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

describe('createStarHubAssets', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refresh populates the asset list from get_assets', async () => {
    const list = [{ ...asset('ssh'), id: 's1' }]
    const restore = stubTauriInternals((cmd) => {
      expect(cmd).toBe('get_assets')
      return Promise.resolve(list)
    })
    try {
      const holder = createStarHubAssets()
      holder.refresh()
      expect(holder.source.getSnapshot().loading).toBe(true)
      await vi.waitFor(() =>{  expect(holder.source.getSnapshot().loading).toBe(false) })
      const snap = holder.source.getSnapshot()
      expect(snap.assets).toEqual(list)
      expect(snap.error).toBeNull()
    } finally {
      restore()
    }
  })

  it('refresh surfaces IPC failures as the error field', async () => {
    const restore = stubTauriInternals(() => Promise.reject(new Error('boom')))
    try {
      const holder = createStarHubAssets()
      holder.refresh()
      await vi.waitFor(() =>{  expect(holder.source.getSnapshot().loading).toBe(false) })
      expect(holder.source.getSnapshot().error).toBe('boom')
    } finally {
      restore()
    }
  })

  it('stringifies non-Error rejections into the error field', async () => {
    const restore = stubTauriInternals(() => rawRejection('raw'))
    try {
      const holder = createStarHubAssets()
      holder.refresh()
      await vi.waitFor(() =>{  expect(holder.source.getSnapshot().loading).toBe(false) })
      expect(holder.source.getSnapshot().error).toBe('raw')
    } finally {
      restore()
    }
  })

  it('ignores refresh calls while a fetch is in flight', async () => {
    let resolveFetch: (list: unknown[]) => void = () => {}
    const restore = stubTauriInternals(() => new Promise((resolve) => { resolveFetch = resolve }))
    try {
      const holder = createStarHubAssets()
      holder.refresh()
      holder.refresh()
      expect(holder.source.getSnapshot().loading).toBe(true)
      resolveFetch([{ id: 'a1', type: 'ssh', name: 'n', config: {} }])
      await vi.waitFor(() =>{  expect(holder.source.getSnapshot().loading).toBe(false) })
      expect(holder.source.getSnapshot().assets).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('refresh without Tauri internals falls into the preview state (no request, no error)', async () => {
    const holder = createStarHubAssets()
    holder.refresh()
    const snap = holder.source.getSnapshot()
    expect(snap.loading).toBe(false)
    expect(snap.error).toBeNull()
    expect(snap.preview).toBe(true)
  })

  it('a successful refresh clears the preview flag', async () => {
    const holder = createStarHubAssets()
    holder.refresh()
    expect(holder.source.getSnapshot().preview).toBe(true)
    const restore = stubTauriInternals(() => Promise.resolve([]))
    try {
      holder.refresh()
      await vi.waitFor(() =>{  expect(holder.source.getSnapshot().loading).toBe(false) })
      expect(holder.source.getSnapshot().preview).toBe(false)
    } finally {
      restore()
    }
  })
})

describe('createConnectionManagerOverlay', () => {
  it('toggles the open flag through open/close and carries the edit target', () => {
    const overlay = createConnectionManagerOverlay()
    expect(overlay.source.getSnapshot()).toEqual({ open: false, asset: null })
    overlay.open()
    expect(overlay.source.getSnapshot()).toEqual({ open: true, asset: null })
    const target = {
      id: 'a1', type: 'ssh', name: 'web-1', group_id: null, config: { host: 'h' },
      key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
    }
    overlay.open(target)
    expect(overlay.source.getSnapshot()).toEqual({ open: true, asset: target })
    overlay.close()
    expect(overlay.source.getSnapshot()).toEqual({ open: false, asset: null })
  })
})
