// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply)与 invariant 伴生注册:十一个席位注册的槽名、
 * 组件、inject 面(选择桥 / 资产源 / 连接对话框桥 / 文件查看窗 / git 分支
 * 胶囊)与侧栏点击的布局联动(切换子类 openDetails 不收起、重复点击同一
 * 子类 toggle),以及 invariant 伴生的包名注册。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin, inject as injectList } from '../src/client/index.ts'
import { StarHubNav } from '../src/client/StarHubNav.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { GitBranchPill } from '../src/client/git/GitBranchPill.tsx'
import { FileTreeButton } from '../src/client/file-tree/FileTreeButton.tsx'
import { FileViewerOverlay } from '../src/client/file-viewer/FileViewerOverlay.tsx'
import { MfaPromptCard } from '../src/client/mfa/MfaPromptCard.tsx'
import { ScreenshotButton } from '../src/client/screenshot/ScreenshotButton.tsx'
import { STARHUB_ASSET_SOURCE } from '../src/client/asset-source.ts'
import { STARHUB_FILE_SOURCE } from '../src/client/file-source.ts'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { AuditTab } from '../src/client/settings/audit.tsx'
import { PluginsTab } from '../src/client/settings/plugins.tsx'
import { apply as applyInvariant } from '../src/invariant.ts'

afterEach(() => {
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

/** Register-options face the client apply passes to slots.register, typed for the call log. */
interface RegisterOptions {
  name: string
  id?: string
  order?: number
  label?: string
  group?: string
  groupLabel?: string
  store?: { create: () => unknown }
  inject: () => RegisterInjected
}

/** Snapshot of the asset-list source the tests drive through hooks.assets. */
interface AssetListSnapshot {
  assets: readonly unknown[]
  loading: boolean
  error: unknown
  preview: boolean
}

/** Injected face the registrations return, covering every member the tests probe. */
interface RegisterInjected {
  selectSubcategory: (key: string) => void
  openConnectionManager: () => void
  closeConnectionManager: () => void
  refreshAssets: () => void
  openAiAssistant: () => void
  openAsset: (asset: unknown) => void
  api: { settings: { update: () => Promise<unknown> } }
  closeFileTree: () => void
  insertFileReference: (text: string) => void
  openFileTree: () => void
  hooks: {
    selection: { getSnapshot: () => { subcategory: string | null } }
    connectionManager: { getSnapshot: () => { open: boolean; asset: null } }
    assets: {
      getSnapshot: () => AssetListSnapshot
      set: (state: AssetListSnapshot) => void
    }
    fileTree: {
      getSnapshot: () => { open: boolean }
      set: (state: { open: boolean }) => void
    }
    sshTerminal: undefined
    dbWorkbench: undefined
    dockerWorkbench: undefined
    redisWorkbench: undefined
  }
}

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get/effect 打桩。 */
function fakeContext() {
  const register = vi.fn((_options: RegisterOptions, _component: unknown) => () => {})
  const inject = vi.fn((_name: string, fn: () => unknown) => fn())
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  const toggleDetails = vi.fn()
  const registerSource = vi.fn((_src: unknown) => () => {})
  const effects: Array<() => (() => void) | undefined> = []
  const effect = vi.fn((fn: () => unknown) => {
    const disposer = fn() as () => (() => void) | undefined
    effects.push(disposer)
    return disposer
  })
  const get = vi.fn((name: string) => {
    switch (name) {
      case 'connection':
        return { api: { settings: { update: vi.fn(() => Promise.resolve({ result: { ok: true } })) } } }
      case 'inputTriggers':
        return { registerSource }
      case 'sessions':
        return {
          list: { getSnapshot: () => ({ current: undefined, ids: [], byId: {} }) },
          open: vi.fn(), clear: vi.fn(), binding: vi.fn(() => undefined),
        }
      case 'workspaces':
        return { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } }
      case 'conversation':
        return { input: { for: vi.fn(() => ({ setDraft: vi.fn() })) } }
      default:
        return undefined
    }
  })
  const provided: Record<string, unknown> = {}
  const provide = vi.fn((name: string, value: unknown) => { provided[name] = value })
  const ctx = {
    slots: { inject, register },
    layout: { openDetails, closeDetails, toggleDetails },
    get,
    effect,
    provide,
  } as unknown as Context
  return {
    ctx, register, inject, openDetails, closeDetails, toggleDetails, get,
    registerSource, effects, provide, provided,
  }
}

describe('client-nav apply', () => {
  it('node half apply is a no-op', () => {
    expect(() =>{  applyHost() }).not.toThrow()
  })

  it('registers the fourteen slots with their components in order', () => {
    const { ctx, inject, register } = fakeContext()
    applyPlugin(ctx)
    expect(inject.mock.calls.map(c => c[0])).toEqual([
      'sidebar.navigation', 'shell.overlay', 'shell.overlay', 'shell.overlay', 'workspace', 'details.workspace',
      'conversation.session.header.actions', 'conversation.session.header.actions', 'conversation.input.left',
      'settings.section', 'settings.section', 'settings.section', 'settings.section', 'settings.section',
    ])
    const components = register.mock.calls.map(c => c[1])
    expect(components).toEqual([
      StarHubNav, StarHubOverlay, FileViewerOverlay, MfaPromptCard, StarHubToolWorkspace, StarHubToolWorkspace,
      GitBranchPill, FileTreeButton, ScreenshotButton,
      // AiTab 经 () => createElement(AiTab, { api }) 包装(传入 settings RPC 面),
      // 不再是裸引用,按函数断言。
      expect.any(Function), PluginsTab, AuditTab, AlertTab, AboutTab,
    ])
  })

  it('sidebar inject opens the details panel when switching subcategory (never collapses)', () => {
    const { ctx, register, openDetails, toggleDetails } = fakeContext()
    applyPlugin(ctx)
    const navConfig = register.mock.calls[0]![0]
    const injected = navConfig.inject()
    expect(typeof navConfig.store?.create).toBe('function')
    injected.selectSubcategory('terminal')
    expect(openDetails).toHaveBeenCalledTimes(1)
    expect(toggleDetails).not.toHaveBeenCalled()
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('terminal')
    // 切到另一个子类:仍只 open,不 toggle(修:终端→数据库误收起)
    injected.selectSubcategory('database')
    expect(openDetails).toHaveBeenCalledTimes(2)
    expect(toggleDetails).not.toHaveBeenCalled()
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('database')
  })

  it('sidebar inject toggles the details panel only on re-clicking the active subcategory', () => {
    const { ctx, register, openDetails, toggleDetails } = fakeContext()
    applyPlugin(ctx)
    const injected = register.mock.calls[0]![0].inject()
    injected.selectSubcategory('terminal')
    injected.selectSubcategory('terminal')
    expect(openDetails).toHaveBeenCalledTimes(1)
    expect(toggleDetails).toHaveBeenCalledTimes(1)
  })

  it('overlay inject exposes the connection-dialog bridge face', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const overlayConfig = register.mock.calls[1]![0]
    const injected = overlayConfig.inject()
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.closeConnectionManager).toBeTypeOf('function')
    expect(injected.refreshAssets).toBeTypeOf('function')
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: false, asset: null })
    // 打开回调真的打开桥(覆盖箭头函数体)
    injected.openConnectionManager()
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: true, asset: null })
  })

  it('opens every asset page in a React window (preview: new tab), no shell overlay hooks', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[4]![0].inject()
      const overlay = register.mock.calls[1]![0].inject()
      // 壳内 overlay 不再承载 SSH/DB/Docker/Redis 工作台桥
      expect(overlay.hooks.sshTerminal).toBeUndefined()
      expect(overlay.hooks.dbWorkbench).toBeUndefined()
      expect(overlay.hooks.dockerWorkbench).toBeUndefined()
      expect(overlay.hooks.redisWorkbench).toBeUndefined()
      // ES 资产 → 一律开 React 窗口
      const esAsset = {
        id: 'es1', type: 'db', name: 'es-1', group_id: null,
        config: { dbType: 'elasticsearch', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.openAsset(esAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('starhub-react/index.html?asset=es1')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('opens SSH assets in a React window (preview: new tab), not a shell modal', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[4]![0].inject()
      const fullAsset = {
        id: 'a1', type: 'ssh', name: 'web-1', group_id: null, config: { host: '1.1.1.1' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.openAsset(fullAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('starhub-react/index.html?asset=a1&workbench=ssh')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('opens DB assets in a React window (preview: new tab), not a shell modal', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[4]![0].inject()
      const dbAsset = {
        id: 'pg1', type: 'db', name: 'prod-db', group_id: null,
        config: { dbType: 'postgresql', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.openAsset(dbAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('starhub-react/index.html?asset=pg1&workbench=db-postgresql')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('logs when opening a non-native asset window fails (IPC rejection)', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('not allowed')) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { ctx, register } = fakeContext()
      applyPlugin(ctx)
      const injected = register.mock.calls[4]![0].inject()
      const esAsset = {
        id: 'es1', type: 'db', name: 'es-1', group_id: null,
        config: { dbType: 'elasticsearch', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.hooks.assets.set({ assets: [esAsset], loading: false, error: null, preview: false })
      injected.openAsset(esAsset)
      await vi.waitFor(() =>{  expect(errorSpy).toHaveBeenCalledWith('打开资产页面失败:', expect.any(Error)) })
    } finally {
      delete w.__TAURI_INTERNALS__
      errorSpy.mockRestore()
    }
  })

  it('opens Docker assets in a React window (preview: new tab), not a shell modal', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[4]![0].inject()
      const dockerAsset = {
        id: 'd1', type: 'docker', name: 'docker-1', group_id: null,
        config: { dockerTransport: 'socket', socketPath: '/var/run/docker.sock' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.openAsset(dockerAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('starhub-react/index.html?asset=d1&workbench=docker')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('opens Redis assets in a React window (preview: new tab), not a shell modal', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[4]![0].inject()
      const redisAsset = {
        id: 'r1', type: 'db', name: 'redis-1', group_id: null,
        config: { dbType: 'redis', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.openAsset(redisAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('starhub-react/index.html?asset=r1&workbench=db-redis')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('logs when opening an asset page fails', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('not allowed')) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { ctx, register } = fakeContext()
      applyPlugin(ctx)
      const workspaceConfig = register.mock.calls[4]![0]
      const asset = {
        id: 'a1', type: 'ssh', name: 'web-1', group_id: null,
        config: { host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      workspaceConfig.inject().openAsset(asset)
      await vi.waitFor(() =>{  expect(errorSpy).toHaveBeenCalledWith('打开资产页面失败:', expect.any(Error)) })
    } finally {
      delete w.__TAURI_INTERNALS__
      errorSpy.mockRestore()
    }
  })

  it('workspace inject wires the api face, bridge callbacks and asset holder', () => {
    const { ctx, register, get } = fakeContext()
    applyPlugin(ctx)
    const workspaceConfig = register.mock.calls[4]![0]
    const injected = workspaceConfig.inject()
    expect(get).toHaveBeenCalledWith('connection')
    expect(injected.api.settings.update).toBeTypeOf('function')
    expect(injected.openAsset).toBeTypeOf('function')
    expect(injected.refreshAssets).toBeTypeOf('function')
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.hooks.assets.getSnapshot()).toHaveProperty('assets')
  })

  it('workspace inject exposes the file-tree hooks and reference insert face', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const workspaceConfig = register.mock.calls[4]![0]
    const injected = workspaceConfig.inject()
    expect(injected.hooks.fileTree.getSnapshot()).toEqual({ open: false })
    expect(injected.closeFileTree).toBeTypeOf('function')
    expect(injected.insertFileReference).toBeTypeOf('function')
    // 无会话/无 binding:insertFileReference 安静跳过(不抛错)。
    expect(() =>{  injected.insertFileReference('@x (p)') }).not.toThrow()
  })

  it('file-tree header action opens the fileTree bridge and the details panel', () => {
    const { ctx, register, openDetails } = fakeContext()
    applyPlugin(ctx)
    const config = register.mock.calls[7]![0]
    expect(config.name).toBe('conversation.session.header.actions')
    expect(config.order).toBe(40)
    expect(config.id).toBe('starhub-file-tree')
    expect(register.mock.calls[7]![1]).toBe(FileTreeButton)
    const injected = config.inject()
    expect(injected.hooks.fileTree.getSnapshot()).toEqual({ open: false })
    injected.openFileTree()
    expect(injected.hooks.fileTree.getSnapshot()).toEqual({ open: true })
    expect(openDetails).toHaveBeenCalledTimes(1)
    injected.closeFileTree()
    expect(injected.hooks.fileTree.getSnapshot()).toEqual({ open: false })
  })

  it('workspace openAiAssistant opens the shell AI chat bridge without throwing', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const injected = register.mock.calls[4]![0].inject()
    // 打开 AI 聊天面板桥(set snapshot);不抛错即覆盖该注入箭头。
    expect(() => { injected.openAiAssistant() }).not.toThrow()
  })

  it('registers the five starhub settings sections under the starhub group at orders 30-34', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const settingsConfigs = register.mock.calls.slice(9).map(c => c[0])
    expect(settingsConfigs.map(c => c.id)).toEqual([
      'starhub-ai', 'starhub-plugins', 'starhub-audit', 'starhub-alert', 'starhub-about',
    ])
    expect(settingsConfigs.map(c => c.order)).toEqual([30, 31, 32, 33, 34])
    for (const config of settingsConfigs) {
      expect(config.group).toBe('starhub')
      expect(config.groupLabel).toBe('StarHub')
      expect(config.name).toBe('settings.section')
    }
    // 组内子项不带前缀(分组头「StarHub」已承担归属标识)
    expect(settingsConfigs.map(c => c.label)).toEqual([
      'AI 助手', '插件', '审计日志', '告警规则', '关于',
    ])
  })

  it('declares the trigger pipeline and session services as required injects', () => {
    expect(injectList).toEqual([
      'slots', 'layout', 'connection', 'inputTriggers', 'sessions', 'workspaces', 'conversation',
    ])
  })

  it('registers the @ asset and file sources through ctx.effect and disposes them with the fiber', () => {
    const { ctx, registerSource } = fakeContext()
    applyPlugin(ctx)
    expect(registerSource).toHaveBeenCalledTimes(2)
    const assetSrc = registerSource.mock.calls[0]![0] as { trigger: string; name: string }
    expect(assetSrc.trigger).toBe('@')
    expect(assetSrc.name).toBe(STARHUB_ASSET_SOURCE)
    const fileSrc = registerSource.mock.calls[1]![0] as { trigger: string; name: string }
    expect(fileSrc.trigger).toBe('@')
    expect(fileSrc.name).toBe(STARHUB_FILE_SOURCE)
    // 注册经 ctx.effect:disposer 随 fiber 卸载反注册 source(HMR 安全)。
    expect(ctx.effect).toHaveBeenCalled()
  })

  it('subscribes host events through ctx.effect and unlistens on fiber disposal', async () => {
    // 完整 internals:让 tauriListen 真正注册,dispose 后可断言 unlisten 发生。
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: (cb: unknown) => number } }
    const invokes: string[] = []
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        invokes.push(cmd)
        if (cmd === 'plugin:event|listen') return Promise.resolve(7)
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null)
        return Promise.reject(new Error(`unexpected command: ${cmd}`))
      },
      transformCallback: () => 1,
    }
    try {
      const { ctx, effects } = fakeContext()
      // 先挂好 internals 再 apply(apply 内部立即调用 tauriListen)。
      applyPlugin(ctx)
      await vi.waitFor(() => {
        expect(invokes.filter(c => c === 'plugin:event|listen')).toHaveLength(2)
      })
      expect(invokes).toContain('plugin:event|listen')
      // HMR 卸载:执行全部 effect disposer,两个监听都被 unlisten。
      for (const dispose of effects) {
        const result = dispose()
        if (typeof result === 'function') result()
      }
      await vi.waitFor(() => {
        expect(invokes.filter(c => c === 'plugin:event|unlisten')).toHaveLength(2)
      })
    } finally {
      delete w.__TAURI_INTERNALS__
    }
  })
})

describe('invariant companion', () => {
  it('registers the package name with an installer', async () => {
    const register = vi.fn()
    const ctx = { invariants: { register } } as unknown as Context
    const disposer = vi.fn()
    register.mockReturnValue(disposer)
    const result = await applyInvariant(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-starhub-client-nav', expect.any(Function))
    expect(result).toBe(disposer)
    // 空 installer 本体会执行(无运行时 invariant 的占位)
    const installer = register.mock.calls[0]![1]! as () => void
    expect(() =>{  installer() }).not.toThrow()
  })
})
