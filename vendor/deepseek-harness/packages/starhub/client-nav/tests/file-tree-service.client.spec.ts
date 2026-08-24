// @vitest-environment jsdom
/**
 * file-tree-service:目录树服务对 Tauri 命令的封装——local_list_directory /
 * local_stat_path 的参数与返回透传、浏览器预览(无 __TAURI_INTERNALS__)时
 * 的 reject。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { listLocalDirectory, statLocalPath } from '../src/client/file-tree/file-tree-service.ts'

afterEach(() => {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('file-tree-service', () => {
  it('listLocalDirectory invokes local_list_directory with the path and returns entries', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} })
        if (cmd === 'local_list_directory') {
          return Promise.resolve([
            { name: 'src', path: 'C:\\ws\\p\\src', kind: 'directory', size: 0, modifiedAt: 1, readonly: false, hidden: false },
            { name: 'main.ts', path: 'C:\\ws\\p\\main.ts', kind: 'file', size: 42, modifiedAt: 2, readonly: false, hidden: false },
          ])
        }
        return Promise.reject(new Error(`unexpected: ${cmd}`))
      },
    }
    const entries = await listLocalDirectory('C:\\ws\\p')
    expect(calls).toEqual([{ cmd: 'local_list_directory', args: { path: 'C:\\ws\\p' } }])
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ name: 'main.ts', kind: 'file', size: 42 })
  })

  it('statLocalPath invokes local_stat_path and returns the info', async () => {
    const calls: string[] = []
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push(cmd)
        void args
        if (cmd === 'local_stat_path') {
          return Promise.resolve({ path: 'C:\\ws\\p\\a.ts', name: 'a.ts', kind: 'file', size: 10, modifiedAt: null, readonly: true })
        }
        return Promise.reject(new Error(`unexpected: ${cmd}`))
      },
    }
    const info = await statLocalPath('C:\\ws\\p\\a.ts')
    expect(calls).toEqual(['local_stat_path'])
    expect(info).toMatchObject({ name: 'a.ts', kind: 'file', readonly: true })
  })

  it('rejects without Tauri internals (browser preview)', async () => {
    await expect(listLocalDirectory('C:\\ws\\p')).rejects.toThrow(/Tauri IPC unavailable/)
    await expect(statLocalPath('C:\\ws\\p\\a.ts')).rejects.toThrow(/Tauri IPC unavailable/)
  })
})
