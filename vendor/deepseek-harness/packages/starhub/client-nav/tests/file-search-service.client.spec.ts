// @vitest-environment jsdom
/**
 * file-search-service:搜索服务对 Tauri `local_search_files` 的封装——参数
 * 透传(root/query/mode)、返回命中列表、浏览器预览(无 Tauri IPC)reject。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { searchLocalFiles } from '../src/client/file-tree/file-search-service.ts'

afterEach(() => {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('searchLocalFiles', () => {
  it('invokes local_search_files with root/query/mode and returns hits', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} })
        if (cmd === 'local_search_files') {
          return Promise.resolve([
            { path: 'C:\\ws\\p\\src\\app.ts', name: 'app.ts', kind: 'file', size: 42, modifiedAt: 1, line: 3, snippet: 'export const TOKEN' },
          ])
        }
        return Promise.reject(new Error(`unexpected: ${cmd}`))
      },
    }
    const hits = await searchLocalFiles('C:\\ws\\p', 'TOKEN', 'content')
    expect(calls).toEqual([{ cmd: 'local_search_files', args: { root: 'C:\\ws\\p', query: 'TOKEN', mode: 'content' } }])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ name: 'app.ts', line: 3, snippet: 'export const TOKEN' })
  })

  it('passes the name mode through', async () => {
    const calls: Array<{ args: Record<string, unknown> }> = []
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd !== 'local_search_files') return Promise.reject(new Error(`unexpected: ${cmd}`))
        calls.push({ args: args ?? {} })
        return Promise.resolve([])
      },
    }
    await searchLocalFiles('C:\\ws\\p', 'app', 'name')
    expect(calls).toEqual([{ args: { root: 'C:\\ws\\p', query: 'app', mode: 'name' } }])
  })

  it('rejects without Tauri internals (browser preview)', async () => {
    await expect(searchLocalFiles('C:\\ws\\p', 'x', 'name')).rejects.toThrow(/Tauri IPC unavailable/)
  })
})