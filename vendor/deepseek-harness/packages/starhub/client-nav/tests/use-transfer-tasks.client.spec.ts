// @vitest-environment jsdom
/**
 * useTransferTasks(overlay 级传输任务投影):seed 反序、status 事件插入/更新、
 * 终态保留(不再 4s 自动清除)、任务级聚合进度、跨会话过滤、上传完成 nonce、
 * 清除终态的乐观更新 + 真源同步、监听器异步清理不泄漏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTransferTasks } from '../src/client/terminal/use-transfer-tasks.ts'
import type { TransferTask } from '../src/client/terminal/sftp-service.ts'
import {
  emitHostEvent, hostEventListeners, restoreHostBridge, restoreHostEvents, stubHostBridge, stubHostEvents,
} from './host-bridge.ts'

/** 宿主桥替身:seed 来自 sftp_list_transfers,事件订阅走共享 SSE 连接。 */
function installTauri(seed: TransferTask[] = []) {
  const invoke = vi.fn((command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'sftp_list_transfers') return Promise.resolve(seed)
    if (command === 'sftp_clear_transfers') return Promise.resolve(1)
    return Promise.resolve(null)
  })
  stubHostBridge(invoke)
  stubHostEvents()
  const emit = (event: string, payload: Record<string, unknown>): void => {
    act(() => { emitHostEvent(event, payload) })
  }
  const listenerCount = (event: string): number => hostEventListeners(event)
  return { invoke, emit, listenerCount }
}

function task(partial: Partial<TransferTask> & { id: string }): TransferTask {
  return {
    sessionId: 'ssh-1', direction: 'download', files: [], status: 'queued',
    totalBytes: 0, transferredBytes: 0, ...partial,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreHostBridge()
  restoreHostEvents()
})

describe('useTransferTasks', () => {
  it('seeds existing tasks on mount, newest first, including terminal ones', async () => {
    installTauri([
      task({ id: 'old', status: 'done' }),
      task({ id: 'new', status: 'running' }),
    ])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})
    expect(result.current.tasks.map(t => t.id)).toEqual(['new', 'old'])
    expect(result.current.activeCount).toBe(1)
  })

  it('inserts on status event, updates in place, retains terminal tasks (no auto-remove)', async () => {
    const t = installTauri([])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})

    act(() => {
      t.emit('sftp://transfer-status', {
        transferId: 't1', sessionId: 'ssh-1', direction: 'upload', status: 'running',
      })
    })
    act(() => {
      t.emit('sftp://transfer-status', {
        transferId: 't2', sessionId: 'ssh-1', direction: 'download', status: 'running',
      })
    })
    expect(result.current.tasks[0]?.status).toBe('running')

    // 更新其中一条(另一条走 map 的不匹配分支);error 缺省 → null
    act(() => {
      t.emit('sftp://transfer-status', {
        transferId: 't2', sessionId: 'ssh-1', direction: 'download', status: 'done',
      })
    })
    expect(result.current.tasks.find(x => x.id === 't2')?.status).toBe('done')
    expect(result.current.tasks.find(x => x.id === 't1')?.status).toBe('running')
    // 下载完成不自增 uploadDoneNonce
    expect(result.current.uploadDoneNonce).toBe(0)

    // done:原地更新且保留(旧实现 4 秒后自动删除,失败原因读不完)
    act(() => {
      t.emit('sftp://transfer-status', {
        transferId: 't1', sessionId: 'ssh-1', direction: 'upload', status: 'done',
      })
    })
    expect(result.current.tasks).toHaveLength(2)
    expect(result.current.tasks.find(x => x.id === 't1')?.status).toBe('done')
    // 上传完成 → nonce 自增(面板据此刷新目录)
    expect(result.current.uploadDoneNonce).toBe(1)
    expect(result.current.activeCount).toBe(0)
  })

  it('uses task-level aggregates from progress events (no per-file fallback jump)', async () => {
    const t = installTauri([
      task({
        id: 't1', status: 'running', totalBytes: 1000, transferredBytes: 0,
        files: [{ name: 'a.bin', size: 900, transferred: 0 }, { name: 'b.bin', size: 100, transferred: 0 }],
      }),
    ])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})

    // 文件级数字(50/100)不能盖掉任务级聚合(950/1000)
    act(() => {
      t.emit('sftp://transfer-progress', {
        transferId: 't1', sessionId: 'ssh-1', fileName: 'b.bin',
        transferred: 50, total: 100, taskTransferred: 950, taskTotal: 1000,
        direction: 'download',
      })
    })
    const cur = result.current.tasks[0]
    expect(cur?.transferredBytes).toBe(950)
    expect(cur?.totalBytes).toBe(1000)
    expect(cur?.files[1]?.transferred).toBe(50)
    expect(result.current.activeFiles.t1).toBe('b.bin')
  })

  it('ignores events from other sessions', async () => {
    const t = installTauri([])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})
    act(() => {
      t.emit('sftp://transfer-status', {
        transferId: 'x', sessionId: 'ssh-OTHER', direction: 'upload', status: 'running',
      })
      t.emit('sftp://transfer-progress', {
        transferId: 'x', sessionId: 'ssh-OTHER', fileName: 'f',
        transferred: 1, total: 2, taskTransferred: 1, taskTotal: 2, direction: 'upload',
      })
    })
    expect(result.current.tasks).toHaveLength(0)
  })

  it('clearFinished removes locally and syncs the Rust source of truth', async () => {
    const t = installTauri([
      task({ id: 'd1', status: 'done' }),
      task({ id: 'f1', status: 'failed', error: 'boom' }),
      task({ id: 'r1', status: 'running' }),
    ])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})

    // 单条删除:只删指定终态
    act(() => { result.current.clearFinished('d1') })
    expect(result.current.tasks.map(x => x.id)).toEqual(['r1', 'f1'])
    expect(t.invoke).toHaveBeenCalledWith('sftp_clear_transfers', { id: 'ssh-1', transferId: 'd1' })

    // 全清:终态全删,进行中的保留
    act(() => { result.current.clearFinished() })
    expect(result.current.tasks.map(x => x.id)).toEqual(['r1'])
    expect(t.invoke).toHaveBeenCalledWith('sftp_clear_transfers', { id: 'ssh-1' })
  })

  it('does not leak listeners when unmounted before registration resolves', async () => {
    const t = installTauri([])
    const { unmount } = renderHook(() => useTransferTasks('ssh-1'))
    // 立即卸载:tauriListen 的 listen promise 尚未 resolve;resolve 后应立即 off
    unmount()
    await act(async () => {})
    expect(t.listenerCount('sftp://transfer-status')).toBe(0)
    expect(t.listenerCount('sftp://transfer-progress')).toBe(0)
  })

  it('keeps the list empty when the initial seed fails (preview / session not ready)', async () => {
    const t = installTauri([])
    t.invoke.mockImplementation((command: string, _args?: Record<string, unknown>) => {
      if (command === 'sftp_list_transfers') return Promise.reject(new Error('no session'))
      return Promise.resolve(null)
    })
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})
    expect(result.current.tasks).toEqual([])
  })

  it('does not insert a task for a terminal status of an unknown id', async () => {
    const t = installTauri([])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})
    // 未知 id 直接收到终态(事件乱序/错过 queued):不插入占位任务
    act(() => {
      t.emit('sftp://transfer-status', {
        transferId: 'ghost', sessionId: 'ssh-1', direction: 'download', status: 'done',
      })
    })
    expect(result.current.tasks).toHaveLength(0)
  })

  it('computes speed from consecutive progress samples and clears it when not running', async () => {
    // 另放一条无关任务:进度事件只更新匹配项(覆盖 map 的不匹配分支)
    const t = installTauri([
      task({ id: 't1', status: 'running', totalBytes: 1000 }),
      task({ id: 't2', status: 'queued' }),
    ])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})

    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const emitProgress = (transferred: number, total = 1000): void => {
        t.emit('sftp://transfer-progress', {
          transferId: 't1', sessionId: 'ssh-1', fileName: 'a.bin',
          transferred, total, taskTransferred: transferred, taskTotal: total,
          direction: 'download',
        })
      }
      emitProgress(100) // 首个采样点:只有基准,无速度
      expect(result.current.speeds.t1).toBeUndefined()

      now += 0 // 同毫秒:dt = 0,不算速度(防除零)
      emitProgress(200)
      expect(result.current.speeds.t1).toBeUndefined()

      now += 1000 // 1 秒后又推进 200 字节 → 200 B/s
      emitProgress(400)
      expect(result.current.speeds.t1).toBe(200)

      // taskTotal 为 0(未知总量):保留 seed 的 totalBytes
      emitProgress(500, 0)
      expect(result.current.tasks.find(x => x.id === 't1')?.totalBytes).toBe(1000)

      // 非运行状态(暂停):清采样与速度
      act(() => {
        t.emit('sftp://transfer-status', {
          transferId: 't1', sessionId: 'ssh-1', direction: 'download', status: 'paused',
        })
      })
      expect(result.current.speeds.t1).toBe(0)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('re-seeds from Rust when clear fails; keeps local projection when reseed also fails', async () => {
    const t = installTauri([task({ id: 'd1', status: 'done' }), task({ id: 'r1', status: 'running' })])
    const { result } = renderHook(() => useTransferTasks('ssh-1'))
    await act(async () => {})
    expect(result.current.tasks).toHaveLength(2)

    // 真源清除失败 → 重 seed 对齐(本地乐观删除被纠正回来)
    t.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'sftp_clear_transfers') return Promise.reject(new Error('channel dead'))
      if (command === 'sftp_list_transfers') {
        void args
        return Promise.resolve([task({ id: 'd1', status: 'done' }), task({ id: 'r1', status: 'running' })])
      }
      return Promise.resolve(null)
    })
    act(() => { result.current.clearFinished('d1') })
    await act(async () => {})
    await act(async () => {})
    expect(result.current.tasks.map(x => x.id)).toEqual(['r1', 'd1'])

    // 重 seed 也失败 → 保持本地投影(不抛错)
    t.invoke.mockImplementation((command: string, _args?: Record<string, unknown>) => {
      if (command === 'sftp_clear_transfers') return Promise.reject(new Error('channel dead'))
      if (command === 'sftp_list_transfers') return Promise.reject(new Error('still dead'))
      return Promise.resolve(null)
    })
    act(() => { result.current.clearFinished('d1') })
    await act(async () => {})
    await act(async () => {})
    expect(result.current.tasks.map(x => x.id)).toEqual(['r1'])
  })
})
