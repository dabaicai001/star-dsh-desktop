// @vitest-environment jsdom
/**
 * Docker 服务层(docker-service.ts)与工作台纯辅助(toDockerConnectParams /
 * countContainers / formatAge):命令转发参数、预览模式拒绝,以及纯函数边界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  daemonLabel, decodeExecOutput, dockerConnect, dockerContainerLogs, dockerContainerStats,
  dockerDisconnect, dockerExec, dockerExecSessionClose, dockerExecSessionRead,
  dockerExecSessionResize, dockerExecSessionStart, dockerExecSessionWrite, dockerInspectContainer,
  dockerListContainers, dockerListImages, dockerPruneImages, dockerPullImage, dockerRemoveContainer,
  dockerRemoveImage, dockerRestartContainer, dockerStartContainer, dockerStopContainer, dockerTest,
  formatBytes,
} from '../src/client/docker/docker-service.ts'
import { countContainers, formatAge, toDockerConnectParams } from '../src/client/docker/DockerWorkbench.tsx'

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
      case 'docker_connect': return Promise.resolve({ connId: 'c1', host: 'h' })
      case 'docker_test': return Promise.resolve({ ok: true, message: 'OK' })
      case 'docker_list_containers': return Promise.resolve([{ id: 'x', name: 'c', image: 'i', state: 'running', status: 'Up', created: 0, ports: [], labels: {} }])
      case 'docker_list_images': return Promise.resolve([{ id: 'img1', tags: ['n:latest'], size: 10, created: 0 }])
      case 'docker_inspect_container': return Promise.resolve({ Id: 'x' })
      case 'docker_exec': return Promise.resolve({ stdout: 'out', stderr: '', exitCode: 0 })
      case 'docker_exec_session_start': return Promise.resolve({ sessionId: 's1' })
      case 'docker_exec_session_read': return Promise.resolve({ data: '', running: true })
      case 'docker_pull_image': return Promise.resolve({ result: 'ok' })
      default: return Promise.resolve(null)
    }
  }
  return { call: invokeFn, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('docker service commands', () => {
  it('forwards connect/test/disconnect and lifecycle commands with the right args', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await dockerConnect({ transport: 'socket', socketPath: '/run/docker.sock' })
      expect(calls[0]).toEqual(['docker_connect', { params: { transport: 'socket', socketPath: '/run/docker.sock' } }])

      await dockerTest({ transport: 'tcp', host: 'h' })
      expect(calls[1]).toEqual(['docker_test', { params: { transport: 'tcp', host: 'h' } }])

      await dockerDisconnect('c1')
      expect(calls[2]).toEqual(['docker_disconnect', { connId: 'c1' }])

      await dockerStartContainer('c1', 'x')
      expect(calls[3]).toEqual(['docker_start_container', { connId: 'c1', containerId: 'x' }])

      await dockerStopContainer('c1', 'x', 5)
      expect(calls[4]).toEqual(['docker_stop_container', { connId: 'c1', containerId: 'x', timeout: 5 }])

      await dockerRestartContainer('c1', 'x')
      expect(calls[5]).toEqual(['docker_restart_container', { connId: 'c1', containerId: 'x', timeout: undefined }])

      await dockerRemoveContainer('c1', 'x', true)
      expect(calls[6]).toEqual(['docker_remove_container', { connId: 'c1', containerId: 'x', force: true }])

      await dockerContainerLogs('c1', 'x', '200')
      expect(calls[7]).toEqual(['docker_container_logs', { connId: 'c1', containerId: 'x', tail: '200' }])

      await dockerContainerStats('c1', 'x')
      expect(calls[8]).toEqual(['docker_container_stats', { connId: 'c1', containerId: 'x' }])
    } finally {
      restore()
    }
  })

  it('forwards image list/pull/remove/prune and exec commands', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await dockerListContainers('c1', true)
      expect(calls[0]).toEqual(['docker_list_containers', { connId: 'c1', all: true }])

      await dockerInspectContainer('c1', 'x')
      expect(calls[1]).toEqual(['docker_inspect_container', { connId: 'c1', containerId: 'x' }])

      await dockerListImages('c1', false)
      expect(calls[2]).toEqual(['docker_list_images', { connId: 'c1', all: false }])

      await dockerPullImage('c1', 'nginx')
      expect(calls[3]).toEqual(['docker_pull_image', { connId: 'c1', imageName: 'nginx' }])

      await dockerRemoveImage('c1', 'img1')
      expect(calls[4]).toEqual(['docker_remove_image', { connId: 'c1', imageId: 'img1', force: undefined }])

      await dockerPruneImages('c1')
      expect(calls[5]).toEqual(['docker_prune_images', { connId: 'c1' }])

      await dockerExec('c1', 'x', ['ls'], { workdir: '/', timeoutSec: 3 })
      expect(calls[6]).toEqual(['docker_exec', { connId: 'c1', containerId: 'x', command: ['ls'], workdir: '/', timeoutSec: 3 }])

      await dockerExec('c1', 'x', ['pwd'])
      expect(calls[7]).toEqual(['docker_exec', { connId: 'c1', containerId: 'x', command: ['pwd'] }])
    } finally {
      restore()
    }
  })

  it('forwards exec session start/read/write/resize/close with defaults', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await dockerExecSessionStart('c1', 'x')
      expect(calls[0]).toEqual(['docker_exec_session_start', { connId: 'c1', containerId: 'x', cols: 120, rows: 30 }])

      await dockerExecSessionRead('c1', 's1', 1000)
      expect(calls[1]).toEqual(['docker_exec_session_read', { connId: 'c1', sessionId: 's1', waitMs: 1000 }])

      await dockerExecSessionWrite('c1', 's1', 'abc')
      expect(calls[2]).toEqual(['docker_exec_session_write', { connId: 'c1', sessionId: 's1', data: 'abc' }])

      await dockerExecSessionResize('c1', 's1', 80, 24)
      expect(calls[3]).toEqual(['docker_exec_session_resize', { connId: 'c1', sessionId: 's1', cols: 80, rows: 24 }])

      await dockerExecSessionClose('c1', 's1')
      expect(calls[4]).toEqual(['docker_exec_session_close', { connId: 'c1', sessionId: 's1' }])
    } finally {
      restore()
    }
  })

  it('rejects in browser preview when no Tauri internals are present', async () => {
    await expect(dockerConnect({ transport: 'socket' })).rejects.toThrow('Tauri IPC unavailable')
  })
})

describe('pure helpers', () => {
  it('daemonLabel falls back to docker', () => {
    expect(daemonLabel('')).toBe('docker')
    expect(daemonLabel('unix:///var/run/docker.sock')).toBe('unix:///var/run/docker.sock')
  })

  it('formatBytes handles zero, units, and fractional numbers', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
    expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe('2.0 TB')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('decodeExecOutput decodes base64 and falls back to raw on failure', () => {
    const text = 'hello'
    expect(decodeExecOutput(btoa(text))).toBe(text)
    expect(decodeExecOutput('!!not-base64!!')).toBe('!!not-base64!!')
  })

  // toDockerConnectParams 是 async(ssh 传输分支要查资产/主机密钥),socket/tcp 分支同步可 await。
  it('toDockerConnectParams maps socket and tcp configs', async () => {
    await expect(toDockerConnectParams({ dockerTransport: 'socket', socketPath: '/run/custom.sock' }))
      .resolves.toEqual({ transport: 'socket', socketPath: '/run/custom.sock' })
    await expect(toDockerConnectParams({ dockerTransport: 'tcp', remoteHost: 'tcp://10.0.0.9:2375' }))
      .resolves.toEqual({ transport: 'tcp', host: 'tcp://10.0.0.9:2375' })
    // tcp 但 remoteHost 缺省/非字符串 → host 空串(触发 workbench 配置不完整提示)
    await expect(toDockerConnectParams({ dockerTransport: 'tcp' }))
      .resolves.toEqual({ transport: 'tcp', host: '' })
    // 缺省退化为 socket + 默认路径
    await expect(toDockerConnectParams({})).resolves.toEqual({ transport: 'socket', socketPath: '/var/run/docker.sock' })
  })

  it('countContainers derives dashboard counts by state', () => {
    const eq = (state: string) => ({ id: state, name: state, image: 'i', state, status: '', created: 0, ports: [], labels: {} })
    const counts = countContainers([eq('running'), eq('paused'), eq('exited'), eq('running')], 7)
    expect(counts).toEqual({ total: 4, running: 2, stopped: 1, paused: 1, images: 7 })
  })

  it('formatAge renders relative time from a unix epoch', () => {
    const now = Date.now() / 1000
    expect(formatAge(now + 5)).toBe('刚刚')
    expect(formatAge(now - 30)).toBe('0 分钟前')
    expect(formatAge(now - 30 * 60)).toBe('30 分钟前')
    expect(formatAge(now - 60 * 60)).toBe('1 小时前')
    expect(formatAge(now - 25 * 60 * 60)).toBe('1 天前')
    expect(formatAge(now - 2 * 24 * 60 * 60)).toBe('2 天前')
  })
})
