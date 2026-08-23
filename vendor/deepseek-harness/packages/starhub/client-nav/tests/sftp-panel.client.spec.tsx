// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
})
