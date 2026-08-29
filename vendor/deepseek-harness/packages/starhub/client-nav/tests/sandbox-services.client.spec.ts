// @vitest-environment jsdom
/**
 * 沙箱桌面前端服务(sandbox/services.ts):Tauri 命令名/参数契约、
 * Docker 资产过滤、noVNC URL 参数、fileSrc 预览降级。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deleteSandboxTemplate, fetchReplayFrames, fetchSandboxOverview, fileSrc,
  listDockerAssets, novncUrl, onUserActionRequest, replyUserAction,
  sandboxLifecycle, setSandboxPlatform, setTakeover, upsertSandboxTemplate,
} from '../src/client/sandbox/services.ts'

afterEach(() => {
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

/** 挂一个记录调用的 invoke stub,返回 invoke 的 mock。 */
function stubInvoke(result: unknown = null) {
  const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(result))
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  w.__TAURI_INTERNALS__ = { invoke }
  return invoke
}

describe('sandbox services', () => {
  it('fetchSandboxOverview calls desktop_ui_overview', async () => {
    const invoke = stubInvoke({ instances: [], templates: [], platformAssetId: null })
    await expect(fetchSandboxOverview()).resolves.toEqual({ instances: [], templates: [], platformAssetId: null })
    expect(invoke).toHaveBeenCalledWith('desktop_ui_overview', undefined)
  })

  it('setSandboxPlatform passes null for 本机默认 and id otherwise', async () => {
    const invoke = stubInvoke()
    await setSandboxPlatform(null)
    await setSandboxPlatform('asset-1')
    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_ui_set_platform', { assetId: null })
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_ui_set_platform', { assetId: 'asset-1' })
  })

  it('template CRUD wrappers pass name/recipe', async () => {
    const invoke = stubInvoke()
    await upsertSandboxTemplate('t1', 'name = "t1"')
    await deleteSandboxTemplate('t1')
    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_ui_upsert_template', { name: 't1', recipeToml: 'name = "t1"' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_ui_delete_template', { name: 't1' })
  })

  it('fetchReplayFrames unwraps the frames array', async () => {
    const invoke = stubInvoke({ frames: [{ action: 'click', shotPath: null, createdAt: 1 }] })
    await expect(fetchReplayFrames('sb-1')).resolves.toEqual([{ action: 'click', shotPath: null, createdAt: 1 }])
    expect(invoke).toHaveBeenCalledWith('desktop_ui_replay_frames', { sandboxId: 'sb-1' })
  })

  it('sandboxLifecycle / setTakeover / replyUserAction map to their commands', async () => {
    const invoke = stubInvoke()
    await sandboxLifecycle('sb-1', 'destroy')
    await setTakeover('c-1', true)
    await replyUserAction('r-1', false)
    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_ui_lifecycle', { sandboxId: 'sb-1', action: 'destroy' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_set_takeover', { containerId: 'c-1', active: true })
    expect(invoke).toHaveBeenNthCalledWith(3, 'desktop_user_action_reply', { requestId: 'r-1', done: false })
  })

  it('onUserActionRequest subscribes to starhub://desktop-user-action', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: unknown } }
    const invoke = vi.fn((cmd: string) => Promise.resolve(cmd === 'plugin:event|listen' ? 7 : null))
    const transformCallback = vi.fn(() => 3)
    w.__TAURI_INTERNALS__ = { invoke, transformCallback }
    await onUserActionRequest(() => {})
    expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
      event: 'starhub://desktop-user-action',
      target: { kind: 'Any' },
      handler: 3,
    })
  })

  it('listDockerAssets filters to docker assets only', async () => {
    stubInvoke([
      { id: 'a1', type: 'docker', name: '本地' },
      { id: 'a2', type: 'ssh', name: '服务器' },
      { id: 'a3', type: 'docker', name: '远程 Docker' },
    ])
    await expect(listDockerAssets()).resolves.toEqual([
      { id: 'a1', name: '本地' },
      { id: 'a3', name: '远程 Docker' },
    ])
  })

  it('novncUrl sets view_only only in watch mode', () => {
    expect(novncUrl(6080, true)).toBe('http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&view_only=1')
    expect(novncUrl(6080, false)).toBe('http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale')
  })

  it('fileSrc uses convertFileSrc when injected, empty string in preview', () => {
    expect(fileSrc('/tmp/a.png')).toBe('')
    const w = window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc: (p: string) => string } }
    w.__TAURI_INTERNALS__ = { convertFileSrc: (p: string) => `asset://${p}` }
    expect(fileSrc('/tmp/a.png')).toBe('asset:///tmp/a.png')
  })
})
