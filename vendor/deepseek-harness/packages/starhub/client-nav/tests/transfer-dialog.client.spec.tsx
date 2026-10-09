// @vitest-environment jsdom
/**
 * TransferDialog(SFTP 传输任务弹框):任务级进度条/速度/ETA、按状态渲染操作
 * (运行:暂停+取消;暂停:继续+取消;失败/取消:重试+删除;完成:删除,无「取消」)、
 * 失败原因完整展示+复制、限速动态设置、逐文件明细展开、头部全部暂停/清除已完成、
 * 空态与关闭。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TransferDialog } from '../src/client/terminal/TransferDialog.tsx'
import type { TransferTasksApi } from '../src/client/terminal/use-transfer-tasks.ts'
import type { TransferTask } from '../src/client/terminal/sftp-service.ts'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

function task(partial: Partial<TransferTask> & { id: string }): TransferTask {
  return {
    sessionId: 'ssh-1', direction: 'download', files: [], status: 'queued',
    totalBytes: 0, transferredBytes: 0, ...partial,
  }
}

/** 宿主桥 invoke 替身:记录调用,动作类命令一律成功。 */
function installTauri() {
  const invoke = vi.fn((_command: string, _args?: Record<string, unknown>) => Promise.resolve(null))
  stubHostBridge(invoke)
  return { invoke }
}

function apiFor(tasks: TransferTask[], extra: Partial<TransferTasksApi> = {}): TransferTasksApi {
  return {
    tasks,
    activeCount: tasks.filter(t => !['done', 'failed', 'cancelled'].includes(t.status)).length,
    speeds: {},
    activeFiles: {},
    uploadDoneNonce: 0,
    clearFinished: vi.fn(),
    ...extra,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreHostBridge()
})

describe('TransferDialog', () => {
  it('renders the empty state and closes via header button and backdrop', () => {
    installTauri()
    const onClose = vi.fn()
    render(<TransferDialog sessionId="ssh-1" api={apiFor([])} onClose={onClose} />)
    expect(screen.getByText('暂无传输任务')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭传输任务' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders aggregate progress, speed and eta for a running task', () => {
    installTauri()
    const api = apiFor([
      task({
        id: 't1', status: 'running', direction: 'upload',
        files: [{ name: 'a.bin', size: 1000, transferred: 500 }],
        totalBytes: 1000, transferredBytes: 500,
      }),
      // 无速度采样、当前文件名为空串:不渲染速度/当前文件行
      task({ id: 't2', status: 'running', totalBytes: 100, transferredBytes: 10 }),
    ], { speeds: { t1: 1024 * 100 }, activeFiles: { t1: 'a.bin', t2: '' } })
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    expect(screen.getByText('a.bin')).toBeTruthy()
    expect(screen.getAllByText('传输中')).toHaveLength(2)
    expect(screen.getByText(/50%/)).toBeTruthy()
    expect(screen.getByText('100.0 KB/s')).toBeTruthy()
    // 剩余 500 B @ 100KB/s → 向上取整 1s
    expect(screen.getByText(/剩 1s/)).toBeTruthy()
    expect(screen.getByText(/当前:a\.bin/)).toBeTruthy()
    // 运行中:每行都有行内暂停 + 取消(精确匹配,排除头部「全部暂停」)
    expect(screen.getAllByRole('button', { name: '暂停' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '取消' })).toHaveLength(2)
  })

  it('pauses / resumes / cancels through the Rust commands', async () => {
    const { invoke } = installTauri()
    const api = apiFor([
      task({ id: 'run1', status: 'running' }),
      task({ id: 'p1', status: 'paused' }),
    ])
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('sftp_pause_transfer', { id: 'ssh-1', transferId: 'run1' }) })
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('sftp_resume_transfer', { id: 'ssh-1', transferId: 'p1' }) })
  })

  it('shows full error with copy and offers retry for BOTH failed and cancelled (contract fix)', async () => {
    const { invoke } = installTauri()
    const api = apiFor([
      task({ id: 'f1', status: 'failed', error: 'Permission denied (publickey)' }),
      task({ id: 'c1', status: 'cancelled' }),
    ])
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    expect(screen.getByText('Permission denied (publickey)')).toBeTruthy()
    const retries = screen.getAllByRole('button', { name: /重试/ })
    expect(retries).toHaveLength(2) // cancelled 也可重试(此前 Rust 只收 failed,点了必报错)
    fireEvent.click(retries[1] as HTMLElement)
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('sftp_retry_transfer', { id: 'ssh-1', transferId: 'c1' }) })
  })

  it('does not offer 取消 on done rows; download-done rows offer 打开目录', async () => {
    const { invoke } = installTauri()
    const api = apiFor([
      task({ id: 'd1', status: 'done', downloadLocalDir: 'D:\\dl' }),
    ])
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /打开目录/ }))
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('sftp_reveal_local', { path: 'D:\\dl' }) })
  })

  it('applies a live speed limit in KB/s', async () => {
    const { invoke } = installTauri()
    const api = apiFor([task({ id: 't1', status: 'running', speedLimit: 0 })])
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '512' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('sftp_set_speed_limit', { id: 'ssh-1', transferId: 't1', speedLimit: 512 * 1024 })
    })
  })

  it('expands per-file detail for multi-file tasks', () => {
    installTauri()
    const api = apiFor([
      task({
        id: 't1', status: 'running',
        files: [
          { name: 'dir/a.txt', size: 100, transferred: 100 },
          { name: 'dir/b.txt', size: 200, transferred: 50 },
        ],
        totalBytes: 300, transferredBytes: 150,
      }),
    ], { activeFiles: { t1: 'dir/b.txt' } })
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    expect(screen.queryByText('dir/a.txt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /明细\(2\)/ }))
    expect(screen.getByText('dir/a.txt')).toBeTruthy()
    expect(screen.getByText('dir/b.txt')).toBeTruthy()
  })

  it('header actions: 全部暂停 pauses actives; 清除已完成 delegates to the api', async () => {
    const { invoke } = installTauri()
    const clearFinished = vi.fn()
    const api = apiFor([
      task({ id: 'r1', status: 'running' }),
      task({ id: 'q1', status: 'queued' }),
      task({ id: 'd1', status: 'done' }),
    ], { clearFinished })
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '全部暂停' }))
    // running 与 queued 都暂停;done 不动
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('sftp_pause_transfer', { id: 'ssh-1', transferId: 'q1' }) })
    expect(invoke).toHaveBeenCalledWith('sftp_pause_transfer', { id: 'ssh-1', transferId: 'r1' })
    expect(invoke).not.toHaveBeenCalledWith('sftp_pause_transfer', { id: 'ssh-1', transferId: 'd1' })
    fireEvent.click(screen.getByRole('button', { name: '清除已完成' }))
    expect(clearFinished).toHaveBeenCalledWith()
  })

  it('names placeholder tasks by direction when the file list is empty', () => {
    installTauri()
    render(
      <TransferDialog sessionId="ssh-1" api={apiFor([
        task({ id: 'u1', status: 'queued', direction: 'upload' }),
        task({ id: 'd1', status: 'queued', direction: 'download' }),
      ])} onClose={() => {}} />,
    )
    expect(screen.getByText('上传任务')).toBeTruthy()
    expect(screen.getByText('下载任务')).toBeTruthy()
  })

  it('renders minute and hour scale eta', () => {
    installTauri()
    render(
      <TransferDialog sessionId="ssh-1" api={apiFor([
        // 剩 120_000 B @ 1000 B/s → 120s → 分钟级
        task({ id: 'm1', status: 'running', totalBytes: 121_000, transferredBytes: 1000 }),
        // 剩 5_000_000 B @ 1000 B/s → 5000s → 小时级(1h23m)
        task({ id: 'h1', status: 'running', totalBytes: 5_100_000, transferredBytes: 100_000 }),
      ], { speeds: { m1: 1000, h1: 1000 } })} onClose={() => {}} />,
    )
    expect(screen.getByText('剩 2m0s')).toBeTruthy()
    expect(screen.getByText('剩 1h23m')).toBeTruthy()
  })

  it('shows an error notice when an action fails (Error and non-Error)', async () => {
    const { invoke } = installTauri()
    render(<TransferDialog sessionId="ssh-1" api={apiFor([task({ id: 't1', status: 'running' })])} onClose={() => {}} />)
    invoke.mockRejectedValueOnce(new Error('channel dead'))
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() => { expect(screen.getByText('暂停失败: channel dead')).toBeTruthy() })
    invoke.mockRejectedValueOnce('weird')
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() => { expect(screen.getByText('暂停失败: weird')).toBeTruthy() })
  })

  it('gates concurrent actions while one is in flight', async () => {
    const { invoke } = installTauri()
    let release!: () => void
    invoke.mockImplementation((_command: string, _args?: Record<string, unknown>) => {
      if (_command === 'sftp_pause_transfer') return new Promise<null>((resolve) => { release = () => { resolve(null) } })
      return Promise.resolve(null)
    })
    render(<TransferDialog sessionId="ssh-1" api={apiFor([task({ id: 't1', status: 'running' })])} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停' })) // 进行中
    fireEvent.click(screen.getByRole('button', { name: '取消' })) // 被 busy 门挡掉
    expect(invoke).not.toHaveBeenCalledWith('sftp_cancel_transfer', expect.anything())
    release()
    await waitFor(() => { expect(screen.getByText('暂停成功')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '取消' })) // busy 已释放
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('sftp_cancel_transfer', { id: 'ssh-1', transferId: 't1' }) })
  })

  it('copies the error text from a failed row', async () => {
    installTauri()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<TransferDialog sessionId="ssh-1" api={apiFor([
      task({ id: 'f1', status: 'failed', error: 'disk full' }),
    ])} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '复制错误信息' }))
    expect(writeText).toHaveBeenCalledWith('disk full')
  })

  it('applies 0 (unlimited) when the draft is 0', async () => {
    const { invoke } = installTauri()
    render(<TransferDialog sessionId="ssh-1" api={apiFor([task({ id: 't1', status: 'paused' })])} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('sftp_set_speed_limit', { id: 'ssh-1', transferId: 't1', speedLimit: 0 })
    })
  })

  it('dismisses a single terminal row via 删除', () => {
    installTauri()
    const clearFinished = vi.fn()
    render(<TransferDialog sessionId="ssh-1" api={apiFor([task({ id: 'd1', status: 'done' })], { clearFinished })} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /删除/ }))
    expect(clearFinished).toHaveBeenCalledWith('d1')
  })

  it('expands and collapses detail; marks the current file when paused; zero-size files', () => {
    installTauri()
    const api = apiFor([
      task({
        id: 't1', status: 'paused',
        files: [
          { name: 'dir/a.txt', size: 0, transferred: 0 }, // 0/0 → 0%
          { name: 'dir/b.txt', size: 0, transferred: 5 }, // size 0 但有进度 → 100%
          { name: 'dir/c.txt', size: 200, transferred: 50 },
        ],
        totalBytes: 200, transferredBytes: 55,
      }),
    ], { activeFiles: { t1: 'dir/c.txt' } })
    render(<TransferDialog sessionId="ssh-1" api={api} onClose={() => {}} />)
    const toggle = screen.getByRole('button', { name: /明细\(3\)/ })
    fireEvent.click(toggle)
    expect(screen.getByText('dir/a.txt')).toBeTruthy()
    expect(screen.getByText('0% · 0 B / 0 B')).toBeTruthy()
    expect(screen.getByText('100% · 5 B / 0 B')).toBeTruthy()
    // 暂停态的当前文件高亮(activeFile 匹配且 status=paused)
    expect(screen.getByText('dir/c.txt').closest('div')?.className).toContain('fileRowCurrent')
    fireEvent.click(screen.getByRole('button', { name: '收起明细' }))
    expect(screen.queryByText('dir/a.txt')).toBeNull()
  })

  it('closes when the backdrop is clicked', () => {
    installTauri()
    const onClose = vi.fn()
    render(<TransferDialog sessionId="ssh-1" api={apiFor([])} onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog) // 对话框内部点击:stopPropagation,不关
    expect(onClose).not.toHaveBeenCalled()
    const backdrop = dialog.parentElement as HTMLElement
    fireEvent.click(backdrop) // 点遮罩:关
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
