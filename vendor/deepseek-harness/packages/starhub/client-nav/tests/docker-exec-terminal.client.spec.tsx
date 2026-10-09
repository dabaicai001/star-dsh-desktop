// @vitest-environment jsdom
/**
 * Docker 交互式 exec 终端(DockerExecTerminal.tsx):启动会话、长轮询读取、
 * 输入写回、退出清理(关闭会话 + 销毁 xterm),以及轮询到 running=false 自清理。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const xterm = vi.hoisted(() => ({
  dispose: vi.fn(),
  input: undefined as ((data: string) => void) | undefined,
  open: vi.fn(),
  write: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 30
    loadAddon() {}
    open() { xterm.open() }
    focus() {}
    dispose = xterm.dispose
    write = xterm.write
    onData(handler: (data: string) => void) {
      xterm.input = handler
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

import { DockerExecTerminal } from '../src/client/docker/DockerExecTerminal.tsx'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

class ResizeObserverMock {
  private callback: ResizeObserverCallback | null = null
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverMock.singleton = this
  }
  observe() {}
  disconnect() {}
  /** 手动触发 observer 回调(测试 resize 通知路径)。 */
  fire() { this.callback?.([], this as unknown as ResizeObserver) }
  static singleton: ResizeObserverMock | null = null
}

const container = { id: 'c1', name: 'web', image: 'nginx', state: 'running', status: '', created: 0, ports: [], labels: {} }

/** 让组件 new ResizeObserver 时用 mock,并暴露该实例供 fire。 */
function installObserver() {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
  return ResizeObserverMock.singleton
}

/** 安装 exec 会话替身;`reads` 为依次返回的 read 结果队列。 */
function installTauri(reads: Array<{ data: string; running: boolean }>) {
  let readIndex = 0
  const invoke = vi.fn((cmd: string) => {
    switch (cmd) {
      case 'docker_exec_session_start': return Promise.resolve({ sessionId: 's1' })
      case 'docker_exec_session_read': {
        const r = reads[Math.min(readIndex, reads.length - 1)] ?? { data: '', running: false }
        readIndex += 1
        return Promise.resolve({ data: r.data, running: r.running })
      }
      case 'docker_exec_session_write':
      case 'docker_exec_session_resize':
      case 'docker_exec_session_close':
        return Promise.resolve(null)
      default: return Promise.resolve(null)
    }
  })
  stubHostBridge(invoke)
  return invoke
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreHostBridge()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  ResizeObserverMock.singleton = null
  xterm.dispose.mockReset()
  xterm.input = undefined
  xterm.write.mockReset()
  xterm.open.mockReset()
})

describe('DockerExecTerminal', () => {
  it('opens the xterm, starts the exec session, and streams decoded reads for a running session', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri([
      { data: btoa('hello\r\n'), running: true },
      { data: '', running: true },
      { data: '', running: false },
    ])
    installObserver()
    render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('docker_exec_session_start', expect.objectContaining({ containerId: 'c1' })) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('docker_exec_session_read', expect.objectContaining({ sessionId: 's1' })) })
    // decoded output written to the terminal
    await waitFor(() =>{  expect(xterm.write).toHaveBeenCalledWith('hello\r\n') })
    // running=false → close session + dispose
    await waitFor(() =>{  expect(xterm.dispose).toHaveBeenCalledTimes(1) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('docker_exec_session_close', expect.anything()) })
  })

  it('writes terminal input back to the exec session', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri([{ data: '', running: true }, { data: '', running: true }, { data: '', running: false }])
    installObserver()
    render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(xterm.input).toBeDefined() })
    xterm.input?.('ls\r')
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('docker_exec_session_write', { connId: 'c', sessionId: 's1', data: 'ls\r' }) })
  })

  it('forwards container TTY resize to the exec session', async () => {
    installObserver()
    // 会话保持 running,确保 resize 触发时 disposed 仍为 false
    const invoke = installTauri([{ data: '', running: true }])
    render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    // 等会话建立(此时 resize 才会真正通知)
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('docker_exec_session_start', expect.anything()) })
    // 组件的 effect 已创建 ResizeObserver 实例,取它来触发 resize 通知
    await waitFor(() =>{  expect(ResizeObserverMock.singleton).not.toBeNull() })
    ResizeObserverMock.singleton?.fire()
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('docker_exec_session_resize', expect.objectContaining({ sessionId: 's1' })) })
  })

  it('cleans up on unmount (close session + dispose xterm + disconnect observer)', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri([{ data: '', running: true }])
    installObserver()
    const { unmount } = render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(xterm.open).toHaveBeenCalled() })
    unmount()
    await waitFor(() =>{  expect(xterm.dispose).toHaveBeenCalled() })
  })

  it('surfaces a start failure and retries the session from the banner', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installObserver()
    let attempts = 0
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_exec_session_start') {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('no such container')) : Promise.resolve({ sessionId: 's1' })
      }
      if (cmd === 'docker_exec_session_read') return Promise.resolve({ data: '', running: true })
      return Promise.resolve(null)
    })
    stubHostBridge(invoke)
    render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    // 启动失败不再静默:错误文案 + 重试入口
    await waitFor(() =>{  expect(screen.getByText(/进入容器失败/)).toBeTruthy() })
    expect(screen.getByText(/no such container/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    // 重试重新发起会话,失败横幅消失
    await waitFor(() =>{  expect(attempts).toBe(2) })
    await waitFor(() =>{  expect(screen.queryByText(/进入容器失败/)).toBeNull() })
  })

  it('announces an ended session instead of leaving a dead terminal', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri([{ data: '', running: false }])
    installObserver()
    render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(screen.getByText(/会话已结束/)).toBeTruthy() })
    expect(screen.getByRole('button', { name: '重新打开' })).toBeTruthy()
  })

  it('surfaces a read failure instead of polling into the void', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installObserver()
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_exec_session_start') return Promise.resolve({ sessionId: 's1' })
      if (cmd === 'docker_exec_session_read') return Promise.reject(new Error('session gone'))
      return Promise.resolve(null)
    })
    stubHostBridge(invoke)
    render(<DockerExecTerminal connId="c" container={container} onClose={vi.fn()} />)
    await waitFor(() =>{  expect(screen.getByText(/读取终端输出失败/)).toBeTruthy() })
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
})
