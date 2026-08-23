// @vitest-environment jsdom
/**
 * sqlHistory(需求 5 React 化,批次 5):loadHistory / saveHistory / addHistory /
 * clearHistory 的 localStorage 持久化契约(键 starhub.sqlHistory,上限 1000,
 * 最新在前;损坏/缺键容错)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addHistory, clearHistory, loadHistory, saveHistory } from '../src/client/sqlHistory.ts'

const KEY = 'starhub.sqlHistory'

function seed(entries: unknown): void {
  localStorage.setItem(KEY, JSON.stringify(entries))
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('sqlHistory', () => {
  it('loads an empty array when nothing is stored', () => {
    expect(loadHistory()).toEqual([])
  })

  it('loads stored entries', () => {
    seed([{ sql: 'SELECT 1', db: 'app', time: 10 }])
    expect(loadHistory()).toEqual([{ sql: 'SELECT 1', db: 'app', time: 10 }])
  })

  it('returns an empty array for corrupt JSON or non-array payload', () => {
    localStorage.setItem(KEY, 'not json')
    expect(loadHistory()).toEqual([])
    seed({ sql: 'SELECT 1' })
    expect(loadHistory()).toEqual([])
  })

  it('saveHistory persists entries and truncates beyond MAX', () => {
    const entries = Array.from({ length: 1005 }, (_, i) => ({ sql: `S${i}`, db: '', time: i }))
    saveHistory(entries)
    const loaded = loadHistory()
    expect(loaded.length).toBe(1000)
    expect(loaded[0]?.sql).toBe('S0')
  })

  it('addHistory prepends and persists', () => {
    seed([{ sql: 'OLD', db: 'a', time: 1 }])
    const next = addHistory('NEW', 'b')
    expect(next.length).toBe(2)
    expect(next[0]?.sql).toBe('NEW')
    expect(next[0]?.db).toBe('b')
    expect(loadHistory()[0]?.sql).toBe('NEW')
  })

  it('clearHistory removes the stored key', () => {
    seed([{ sql: 'SELECT 1', db: '', time: 1 }])
    clearHistory()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(loadHistory()).toEqual([])
  })

  it('swallows localStorage failures in save/load/clear', () => {
    const boom = vi.fn(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    expect(loadHistory()).toEqual([])
    // saveHistory / clearHistory return void; a thrown storage error fails the test.
    saveHistory([{ sql: 'S', db: '', time: 1 }])
    const timeMatcher: unknown = expect.any(Number)
    expect(addHistory('S', '')).toEqual([{ sql: 'S', db: '', time: timeMatcher }])
    clearHistory()
  })
})
