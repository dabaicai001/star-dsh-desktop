// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SftpPanel } from '../src/client/terminal/SftpPanel.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const asset = {
  id: 'ssh-1', type: 'ssh', name: 'server', group_id: null,
  config: { host: '10.0.0.5', port: 22, username: 'deploy', password: 'secret' },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

/** Build a Tauri internals stub; `list` returns the directory listing for sftp_list. */
function installTauri(list: unknown) {
  const callbacks: Array<(event: unknown) => void> = []
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
    if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
    if (command === 'sftp_home_dir') return Promise.resolve('/home/deploy')
    if (command === 'sftp_list') {
      const path = (args?.path as string) ?? '/'
      return Promise.resolve(path === '/home/deploy' ? list : [])
    }
    if (command === 'sftp_list_transfers') return Promise.resolve([])
    return Promise.resolve(null)
  })
  ;(window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: typeof invoke
      transformCallback: (callback: (event: unknown) => void) => number
    }
  }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback) => {
      callbacks.push(callback)
      return callbacks.length
    },
  }
  return { invoke, callbacks }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('SftpPanel', () => {
  it('connects on the live session, lists the home dir, and navigates into a folder', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const { invoke } = installTauri([
      { name: 'docs', path: '/home/deploy/docs', isDir: true, size: 0, permissions: 0o755, modified: 0 },
      { name: 'README.md', path: '/home/deploy/README.md', isDir: false, size: 1234, permissions: 0o644, modified: 0 },
    ])

    render(<SftpPanel asset={asset} sessionId="ssh-1" sshConnected={true} />)

    // ensure_session on the shared terminal session (never re-auths)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_ensure_session', { id: 'ssh-1' }) })
    // lists /home/deploy then renders entries
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/home/deploy' }) })
    await waitFor(() =>{  expect(screen.getByText('docs')).toBeTruthy() })
    expect(screen.getByText('README.md')).toBeTruthy()
    // size formatted
    expect(screen.getByText('1.2 KB')).toBeTruthy()

    // click the directory row → navigates (loads the subdir)
    fireEvent.click(screen.getByText('docs'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/home/deploy/docs' }) })
  })

  it('shows a waiting state until the terminal connects', () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri([])
    render(<SftpPanel asset={asset} sessionId="ssh-1" sshConnected={false} />)
    expect(screen.getByText(/终端未连接/)).toBeTruthy()
  })

  it('uploads files dropped onto the panel and toggles the drop overlay', async () => {
    vi.useFakeTimers()
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const { invoke, callbacks } = installTauri([
      { name: 'README.md', path: '/home/deploy/README.md', isDir: false, size: 1234, permissions: 0o644, modified: 0 },
    ])
    render(<SftpPanel asset={asset} sessionId="ssh-1" sshConnected={true} />)
    // 连接 + 列目录的异步链经微任务刷出(伪时钟下用 advanceAsync(0) 一并 flush)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('README.md')).toBeTruthy()
    // handleChunk effect 在 path 变化时会重订阅;活跃的拖拽监听是最末一组:
    // 末尾 4 个 = drag-enter / drag-over / drag-drop / drag-leave。
    const base = callbacks.length - 4
    const emit = (off: number, event: string, payload: Record<string, unknown>) => {
      const cb = callbacks[base + off]
      if (cb === undefined) throw new Error(`no callback at ${base + off}`)
      act(() => { cb({ event, id: base + off, payload }) })
    }
    // drag-enter / drag-over → 覆盖层出现
    emit(0, 'tauri://drag-enter', { paths: ['C:/a.txt'], position: { x: 0, y: 0 } })
    emit(1, 'tauri://drag-over', { paths: ['C:/a.txt'], position: { x: 0, y: 0 } })
    expect(screen.getByText('松开以上传到当前目录')).toBeTruthy()
    // drag-leave → 覆盖层消失
    emit(3, 'tauri://drag-leave', {})
    expect(screen.queryByText('松开以上传到当前目录')).toBeNull()
    // drag-drop → 覆盖层消失 + 对当前目录发起上传(loadDir 的 2s 定时一并推进)
    emit(2, 'tauri://drag-drop', { paths: ['C:/a.txt'], position: { x: 0, y: 0 } })
    expect(screen.queryByText('松开以上传到当前目录')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(invoke).toHaveBeenCalledWith('sftp_start_upload', {
      id: 'ssh-1', localPaths: ['C:/a.txt'], remoteDir: '/home/deploy', speedLimit: 0,
    })
    vi.useRealTimers()
  })
})
