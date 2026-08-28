// @vitest-environment jsdom
/**
 * Redis 服务层(redis-service.ts):命令转发参数、预览模式拒绝、redisQuote 纯函数
 * 边界,以及 redisScanAccumulate 连续分页(游标归零/单批上限/续传去重/页数熔断)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  redisConnect, redisDBSize, redisDel, redisDisconnect, redisExecute, redisFlushDB,
  redisGetValue, redisInfo, redisQuote, redisRename, redisScan, redisScanAccumulate,
  redisSelect, redisSet, type RedisScanResult,
} from '../src/client/redis/redis-service.ts'

/** 安装 Tauri IPC stub,记录 invoke 调用并返回预设结果;返回还原原状态的回调。 */
function stubInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke: handler }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** 记录命令与参数的 invoke helper。 */
function recordingInvoke() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  const invokeFn = (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    switch (cmd) {
      case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      case 'db_redis_disconnect': return Promise.resolve(null)
      case 'db_redis_select': return Promise.resolve(null)
      case 'db_redis_db_size': return Promise.resolve({ size: 42 })
      case 'db_redis_scan': return Promise.resolve({ keys: [{ key: 'a', type: 'string', ttl: -1 }], cursor: 0, total: 1 })
      case 'db_redis_get_value': return Promise.resolve({ key: 'k', type: 'string', value: 'v', ttl: -1 })
      case 'db_redis_del': return Promise.resolve({ deleted: 1 })
      case 'db_redis_rename': return Promise.resolve(null)
      case 'db_redis_set': return Promise.resolve(null)
      case 'db_redis_execute': return Promise.resolve({ result: 'OK', durationMs: 1 })
      case 'db_redis_flush_db': return Promise.resolve(null)
      case 'db_redis_info': return Promise.resolve('INFO...')
      default: return Promise.resolve(null)
    }
  }
  return { call: invokeFn, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('redis service commands', () => {
  it('forwards connection lifecycle and DB commands with the right args', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await redisConnect({ host: 'h', port: 6379, password: 'p', db: 2, ssl: true })
      expect(calls[0]).toEqual(['db_redis_connect', { params: { host: 'h', port: 6379, password: 'p', db: 2, ssl: true } }])

      await redisDisconnect('c1')
      expect(calls[1]).toEqual(['db_redis_disconnect', { connId: 'c1' }])

      await redisSelect('c1', 3)
      expect(calls[2]).toEqual(['db_redis_select', { connId: 'c1', db: 3 }])

      const size = await redisDBSize('c1')
      expect(calls[3]).toEqual(['db_redis_db_size', { connId: 'c1' }])
      expect(size.size).toBe(42)
    } finally {
      restore()
    }
  })

  it('forwards scan with cursor/match defaults and count', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await redisScan('c1', 0, 'user:*', 100)
      expect(calls[0]).toEqual(['db_redis_scan', { connId: 'c1', cursor: 0, matchPattern: 'user:*', count: 100 }])

      // cursor 缺省 → 0;match 缺省 → undefined
      await redisScan('c1')
      expect(calls[1]).toEqual(['db_redis_scan', { connId: 'c1', cursor: 0, matchPattern: undefined, count: undefined }])
    } finally {
      restore()
    }
  })

  it('forwards value read/write/delete/rename/execute/flush/info commands', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      const val = await redisGetValue('c1', 'k')
      expect(calls[0]).toEqual(['db_redis_get_value', { connId: 'c1', key: 'k' }])
      expect(val.type).toBe('string')

      await redisDel('c1', ['a', 'b'])
      expect(calls[1]).toEqual(['db_redis_del', { connId: 'c1', keys: ['a', 'b'] }])

      await redisRename('c1', 'old', 'new')
      expect(calls[2]).toEqual(['db_redis_rename', { connId: 'c1', oldKey: 'old', newKey: 'new' }])

      await redisSet('c1', 'k', 'v', 60)
      expect(calls[3]).toEqual(['db_redis_set', { connId: 'c1', key: 'k', value: 'v', expiration: 60 }])

      // expiration 缺省 → undefined
      await redisSet('c1', 'k', 'v')
      expect(calls[4]).toEqual(['db_redis_set', { connId: 'c1', key: 'k', value: 'v', expiration: undefined }])

      await redisExecute('c1', 'GET k')
      expect(calls[5]).toEqual(['db_redis_execute', { connId: 'c1', command: 'GET k' }])

      await redisFlushDB('c1')
      expect(calls[6]).toEqual(['db_redis_flush_db', { connId: 'c1' }])

      await redisInfo('c1')
      expect(calls[7]).toEqual(['db_redis_info', { connId: 'c1', section: undefined }])

      await redisInfo('c1', 'memory')
      expect(calls[8]).toEqual(['db_redis_info', { connId: 'c1', section: 'memory' }])
    } finally {
      restore()
    }
  })

  it('rejects in browser preview when no Tauri internals are present', async () => {
    await expect(redisConnect({ host: 'h', port: 6379 })).rejects.toThrow('Tauri IPC unavailable')
  })
})

describe('redisScanAccumulate', () => {
  /** 造一个按页返回的假 SCAN:每页返回 [cursor, cursor+count),下一游标前移 count-overlap。 */
  function fakeScanPages(totalKeys: number, perPage: number, overlap = 0) {
    let pages = 0
    const scan = async (cursor: number, _match?: string, count = 100): Promise<RedisScanResult> => {
      pages += 1
      const next = Math.min(totalKeys, cursor + count)
      const keys = []
      for (let i = cursor; i < next; i++) keys.push({ key: `k${i}`, type: 'string', ttl: -1 })
      const advance = count - overlap
      return { keys, cursor: next >= totalKeys ? 0 : cursor + advance, total: totalKeys }
    }
    return { scan, pages: () => pages }
  }

  it('loops until the cursor returns to 0, accumulating every key', async () => {
    const { scan, pages } = fakeScanPages(1250, 500)
    const result = await redisScanAccumulate(scan, 0, undefined, [], 10_000, 500)
    expect(result.keys).toHaveLength(1250)
    expect(result.keys[0]?.key).toBe('k0')
    expect(result.keys[1249]?.key).toBe('k1249')
    expect(result.cursor).toBe(0)
    expect(result.complete).toBe(true)
    expect(pages()).toBe(3)
  })

  it('stops at the batch limit and reports an incomplete state for 加载更多', async () => {
    const { scan, pages } = fakeScanPages(2500, 500)
    const result = await redisScanAccumulate(scan, 0, undefined, [], 1000, 500)
    expect(result.keys).toHaveLength(1000)
    expect(result.complete).toBe(false)
    expect(result.cursor).toBe(1000)
    expect(pages()).toBe(2)
  })

  it('continues from a stored cursor, keeping existing keys', async () => {
    const { scan, pages } = fakeScanPages(1500, 500)
    const first = await redisScanAccumulate(scan, 0, undefined, [], 500, 500)
    expect(first.keys).toHaveLength(500)
    expect(first.complete).toBe(false)
    expect(first.cursor).toBe(500)
    // 续传:existing 传入首段结果,累计到 1500 且游标归零。
    const second = await redisScanAccumulate(scan, first.cursor, undefined, first.keys, 1500, 500)
    expect(second.keys).toHaveLength(1500)
    expect(second.complete).toBe(true)
    expect(pages()).toBe(3)
  })

  it('deduplicates overlapping pages when SCAN revisits keys', async () => {
    // 每页与上一页重叠 100 个 key(模拟 SCAN 偶发重复)。
    const { scan } = fakeScanPages(1000, 500, 100)
    const result = await redisScanAccumulate(scan, 0, undefined, [], 10_000, 500)
    expect(result.keys).toHaveLength(1000)
    expect(new Set(result.keys.map(k => k.key)).size).toBe(1000)
    expect(result.complete).toBe(true)
  })

  it('passes the MATCH pattern and page hint through to every page', async () => {
    const seen: Array<[number, string | undefined, number]> = []
    const scan = async (cursor: number, match?: string, count?: number): Promise<RedisScanResult> => {
      seen.push([cursor, match, count ?? 0])
      return { keys: cursor === 0 ? [{ key: 'user:1', type: 'string', ttl: -1 }] : [], cursor: 0 }
    }
    await redisScanAccumulate(scan, 0, 'user:*', [], 10_000, 800)
    expect(seen[0]).toEqual([0, 'user:*', 800])
  })

  it('stops after the page cap to avoid cursor loops', async () => {
    // 游标永不归零(每次返回 cursor=1):页数熔断,结果保持 incomplete。
    const scan = async (cursor: number): Promise<RedisScanResult> => ({
      keys: cursor === 0 ? [{ key: 'k', type: 'string', ttl: -1 }] : [],
      cursor: 1,
    })
    const result = await redisScanAccumulate(scan, 0, undefined, [], 10_000, 500, 3)
    expect(result.keys).toHaveLength(1)
    expect(result.complete).toBe(false)
    expect(result.cursor).toBe(1)
  })
})

describe('redisQuote', () => {
  it('passes through safe tokens and quotes/escapes unsafe ones', () => {
    expect(redisQuote('abc-_.:@123')).toBe('abc-_.:@123')
    expect(redisQuote('has space')).toBe('"has space"')
    expect(redisQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})
