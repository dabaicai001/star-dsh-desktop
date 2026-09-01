// @vitest-environment jsdom
/**
 * ES 服务层(es-service.ts):命令转发参数、预览模式拒绝,以及纯函数
 * indexRowOf / healthColor / fieldTypeColor 的边界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  esClusterHealth, esConnect, esCount, esCreateIndex, esDeleteIndex, esDisconnect,
  esGetSettings, esGetMapping, esListIndices, esSearch, fieldTypeColor, healthColor, indexRowOf,
} from '../src/client/es/es-service.ts'

/** Install a Tauri IPC stub; returns a restore callback. */
function stubInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke: handler }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** Recording invoke helper with ES-shaped responses. */
function recordingInvoke() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  const invokeFn = (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    switch (cmd) {
      case 'db_es_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 9200, clusterName: 'n', version: '8' })
      case 'db_es_disconnect': return Promise.resolve(null)
      case 'db_es_cluster_health': return Promise.resolve({ clusterName: 'n', status: 'green', numberOfNodes: 1, numberOfDataNodes: 1, activePrimaryShards: 1, activeShards: 1, activeShardsPercent: 100 })
      case 'db_es_list_indices': return Promise.resolve([])
      case 'db_es_get_index_mapping': return Promise.resolve({ indexName: 'idx', fields: [] })
      case 'db_es_get_index_settings': return Promise.resolve({})
      case 'db_es_create_index': return Promise.resolve({ acknowledged: true })
      case 'db_es_delete_index': return Promise.resolve({ acknowledged: true })
      case 'db_es_search': return Promise.resolve({ took: 1, timedOut: false, totalHits: 0, maxScore: null, hits: [], aggregations: {} })
      case 'db_es_count': return Promise.resolve({ count: 3 })
      default: return Promise.resolve(null)
    }
  }
  return { call: invokeFn, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('es service commands', () => {
  it('forwards connection lifecycle and read commands with the right args', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      const conn = await esConnect({ host: 'h', port: 9200, useSSL: false })
      expect(calls[0]).toEqual(['db_es_connect', { params: { host: 'h', port: 9200, useSSL: false } }])
      expect(conn.connId).toBe('c1')

      await esDisconnect('c1')
      expect(calls[1]).toEqual(['db_es_disconnect', { connId: 'c1' }])

      await esClusterHealth('c1')
      expect(calls[2]).toEqual(['db_es_cluster_health', { connId: 'c1' }])

      await esListIndices('c1')
      expect(calls[3]).toEqual(['db_es_list_indices', { connId: 'c1' }])

      await esGetMapping('c1', 'idx')
      expect(calls[4]).toEqual(['db_es_get_index_mapping', { connId: 'c1', index: 'idx' }])

      await esGetSettings('c1', 'idx')
      expect(calls[5]).toEqual(['db_es_get_index_settings', { connId: 'c1', index: 'idx' }])
    } finally {
      restore()
    }
  })

  it('forwards create/delete/search/count with optional args', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await esCreateIndex('c1', 'idx', { properties: {} }, { number_of_shards: 1 })
      expect(calls[0]).toEqual(['db_es_create_index', { connId: 'c1', index: 'idx', mappings: { properties: {} }, settings: { number_of_shards: 1 } }])

      await esDeleteIndex('c1', 'idx')
      expect(calls[1]).toEqual(['db_es_delete_index', { connId: 'c1', index: 'idx' }])

      await esSearch('c1', 'idx', { query: {} }, 0, 20)
      expect(calls[2]).toEqual(['db_es_search', { connId: 'c1', index: 'idx', body: { query: {} }, from: 0, size: 20 }])

      const count = await esCount('c1', 'idx', { query: {} })
      expect(calls[3]).toEqual(['db_es_count', { connId: 'c1', index: 'idx', body: { query: {} } }])
      expect(count.count).toBe(3)
    } finally {
      restore()
    }
  })

  it('rejects in browser preview when no Tauri internals are present', async () => {
    await expect(esConnect({ host: 'h', port: 9200 })).rejects.toThrow('Tauri IPC unavailable')
  })
})

describe('indexRowOf', () => {
  it('parses an object row into an EsIndexInfo with defaults', () => {
    const row = indexRowOf({ name: 'idx', docsCount: 5, storeSize: '1kb', health: 'green', status: 'open', primaryShards: 2, replicaShards: 1 })
    expect(row).toEqual({ name: 'idx', docsCount: 5, storeSize: '1kb', health: 'green', status: 'open', primaryShards: 2, replicaShards: 1 })
  })

  it('normalizes a bare string and missing numeric fields', () => {
    const s = indexRowOf('idx')
    expect(s.docsCount).toBe(0)
    expect(s.storeSize).toBe('-')
    // Missing non-string numerics default.
    const partial = indexRowOf({ name: 'x', docsCount: 3 })
    expect(partial.primaryShards).toBe(0)
    expect(partial.health).toBe('unknown')
  })

  it('handles a non-object row as an empty name row', () => {
    const row = indexRowOf(null)
    expect(row.name).toBe('')
  })
})

describe('healthColor', () => {
  it('maps health to DSH state tokens (green/yellow/red) and a muted fallback', () => {
    expect(healthColor('green')).toBe('var(--dsw-alias-state-success-primary)')
    expect(healthColor('yellow')).toBe('var(--dsw-alias-state-warn-primary)')
    expect(healthColor('red')).toBe('var(--dsw-alias-state-error-primary)')
    expect(healthColor('unknown')).toBe('var(--dsw-alias-label-tertiary)')
  })
})

describe('fieldTypeColor', () => {
  it('maps field types to DSH alias/static tokens and falls back', () => {
    expect(fieldTypeColor('text')).toBe('var(--dsw-alias-state-business-primary)')
    expect(fieldTypeColor('keyword')).toBe('var(--dsw-alias-state-success-primary)')
    expect(fieldTypeColor('long')).toBe('var(--dsw-alias-state-warn-primary)')
    expect(fieldTypeColor('date')).toBe('var(--dsw-static-deepseek-400)')
    expect(fieldTypeColor('boolean')).toBe('var(--dsw-alias-label-tertiary)')
    expect(fieldTypeColor('nested')).toBe('var(--dsw-static-blue-450)')
    expect(fieldTypeColor('weird')).toBe('var(--dsw-alias-label-tertiary)')
  })
})
