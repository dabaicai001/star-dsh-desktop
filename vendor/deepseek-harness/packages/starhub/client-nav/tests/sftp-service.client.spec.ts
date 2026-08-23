// @vitest-environment jsdom
/**
 * SFTP 服务层(sftp-service.ts):全部命令经 `__TAURI_INTERNALS__.invoke` 转发
 * 参数并透传结果/拒绝,以及 joinPath / parentPath / formatSize 纯函数边界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatSize, joinPath, parentPath, sftpCancelTransfer, sftpEnsureSession,
  sftpList, sftpListTransfers, sftpMkdir, sftpPauseTransfer, sftpRemove,
  sftpRename, sftpResumeTransfer, sftpRetryTransfer, sftpStartDownload,
  sftpStartUpload, sftpStat,
} from '../src/client/terminal/sftp-service.ts'

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
      case 'sftp_list': return Promise.resolve([{ name: 'a', path: '/a', isDir: true, size: 0, permissions: 0o755 }])
      case 'sftp_stat': return Promise.resolve({ name: 'a', path: '/a', isDir: false, size: 1, permissions: 0o644 })
      case 'sftp_remove': return Promise.resolve(null)
      case 'sftp_mkdir': return Promise.resolve(null)
      case 'sftp_rename': return Promise.resolve(null)
      case 'sftp_ensure_session': return Promise.resolve({ mode: 'subsystem', server_path: '/usr/lib/sftp-server' })
      case 'sftp_start_upload': return Promise.resolve('t1')
      case 'sftp_start_download': return Promise.resolve('t2')
      case 'sftp_cancel_transfer': return Promise.resolve(null)
      case 'sftp_pause_transfer': return Promise.resolve(null)
      case 'sftp_resume_transfer': return Promise.resolve(null)
      case 'sftp_retry_transfer': return Promise.resolve('t3')
      case 'sftp_list_transfers': return Promise.resolve([])
      default: return Promise.resolve(null)
    }
  }
  return { call: invokeFn, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('sftp service commands', () => {
  it('forwards list/stat/remove/mkdir/rename with the session id and path args', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await sftpList('s1', '/tmp')
      expect(calls[0]).toEqual(['sftp_list', { id: 's1', path: '/tmp' }])

      const entry = await sftpStat('s1', '/tmp/a')
      expect(calls[1]).toEqual(['sftp_stat', { id: 's1', path: '/tmp/a' }])
      expect(entry.isDir).toBe(false)

      await sftpRemove('s1', '/tmp/a')
      expect(calls[2]).toEqual(['sftp_remove', { id: 's1', path: '/tmp/a' }])

      await sftpMkdir('s1', '/tmp/new')
      expect(calls[3]).toEqual(['sftp_mkdir', { id: 's1', path: '/tmp/new' }])

      await sftpRename('s1', '/tmp/a', '/tmp/b')
      expect(calls[4]).toEqual(['sftp_rename', { id: 's1', from: '/tmp/a', to: '/tmp/b' }])
    } finally {
      restore()
    }
  })

  it('forwards ensure-session and transfer lifecycle commands', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      const launch = await sftpEnsureSession('s1')
      expect(calls[0]).toEqual(['sftp_ensure_session', { id: 's1' }])
      expect(launch?.mode).toBe('subsystem')

      const uploadId = await sftpStartUpload('s1', ['/local/a'], '/remote', 1024)
      expect(calls[1]).toEqual(['sftp_start_upload', { id: 's1', localPaths: ['/local/a'], remoteDir: '/remote', speedLimit: 1024 }])
      expect(uploadId).toBe('t1')

      // speedLimit 缺省 → 0
      await sftpStartUpload('s1', ['/local/b'], '/remote')
      expect(calls[2]).toEqual(['sftp_start_upload', { id: 's1', localPaths: ['/local/b'], remoteDir: '/remote', speedLimit: 0 }])

      await sftpStartDownload('s1', ['/remote/c'], '/local', 2048)
      expect(calls[3]).toEqual(['sftp_start_download', { id: 's1', remotePaths: ['/remote/c'], localDir: '/local', speedLimit: 2048 }])

      await sftpStartDownload('s1', ['/remote/d'], '/local')
      expect(calls[4]).toEqual(['sftp_start_download', { id: 's1', remotePaths: ['/remote/d'], localDir: '/local', speedLimit: 0 }])

      await sftpCancelTransfer('s1', 't1')
      expect(calls[5]).toEqual(['sftp_cancel_transfer', { id: 's1', transferId: 't1' }])

      await sftpPauseTransfer('s1', 't1')
      expect(calls[6]).toEqual(['sftp_pause_transfer', { id: 's1', transferId: 't1' }])

      await sftpResumeTransfer('s1', 't1')
      expect(calls[7]).toEqual(['sftp_resume_transfer', { id: 's1', transferId: 't1' }])

      const retried = await sftpRetryTransfer('s1', 't2')
      expect(calls[8]).toEqual(['sftp_retry_transfer', { id: 's1', transferId: 't2' }])
      expect(retried).toBe('t3')

      const transfers = await sftpListTransfers('s1')
      expect(calls[9]).toEqual(['sftp_list_transfers', { id: 's1' }])
      expect(transfers).toEqual([])
    } finally {
      restore()
    }
  })

  it('forwards invoke rejections as-is', async () => {
    const restore = stubInvoke(() => Promise.reject(new Error('sftp boom')))
    try {
      await expect(sftpList('s1', '/tmp')).rejects.toThrow('sftp boom')
    } finally {
      restore()
    }
  })

  it('rejects in browser preview without Tauri internals', async () => {
    await expect(sftpStat('s1', '/tmp')).rejects.toThrow('Tauri IPC unavailable')
  })
})

describe('joinPath', () => {
  it('joins against root and empty parents with a leading slash', () => {
    expect(joinPath('/', 'a')).toBe('/a')
    expect(joinPath('', 'a')).toBe('/a')
  })

  it('joins without doubling an existing trailing slash', () => {
    expect(joinPath('/home/', 'a')).toBe('/home/a')
  })

  it('joins with a single separator otherwise', () => {
    expect(joinPath('/home', 'a')).toBe('/home/a')
  })
})

describe('parentPath', () => {
  it('keeps root and empty paths as root', () => {
    expect(parentPath('/')).toBe('/')
    expect(parentPath('')).toBe('/')
  })

  it('returns root when no separator or only a leading slash exists', () => {
    expect(parentPath('a')).toBe('/')
    expect(parentPath('/a')).toBe('/')
  })

  it('slices the parent directory for nested paths', () => {
    expect(parentPath('/a/b')).toBe('/a')
    expect(parentPath('/a/b/')).toBe('/a/b')
  })
})

describe('formatSize', () => {
  it('formats zero as a plain byte count', () => {
    expect(formatSize(0)).toBe('0 B')
  })

  it('formats sub-KB sizes without decimals', () => {
    expect(formatSize(1)).toBe('1 B')
    expect(formatSize(999)).toBe('999 B')
  })

  it('formats KB/MB/GB/TB with one decimal', () => {
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
    expect(formatSize(3 * 1024 * 1024 * 1024 * 1024)).toBe('3.0 TB')
  })
})
