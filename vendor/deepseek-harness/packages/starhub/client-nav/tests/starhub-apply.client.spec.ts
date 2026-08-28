// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply,rc.2 适配后):各槽位注册的槽名、组件与注入面
 * (工具面板桥 / 连接对话框桥 / 文件查看窗 / git 分支胶囊 / 截图按钮附件)
 * 与工具树子类选中语义(selectSubcategory 写选择桥,不再联动布局开关)。
 * rc.2 注册面(v0.100.0 起右下角 BastionExecPanel 浮层席位移除):
 * `sidebar.footer.action`(工具入口)+ `shell.overlay`×3(overlay / 文件查看 /
 * AI 连接卡 / 工具面板→共 4 席之一无独立浮层)+ `conversation.session.
 * header.actions`×3(git / 文件树 / 执行)+ `conversation.input.left`(截图)
 * + `settings.section`×5。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin, inject as injectList } from '../src/client/index.ts'
import { StarHubFooterButton } from '../src/client/StarHubFooterButton.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { GitBranchPill } from '../src/client/git/GitBranchPill.tsx'
import { FileTreeButton } from '../src/client/file-tree/FileTreeButton.tsx'
import { ExecDrawerButton } from '../src/client/conn/ExecDrawerButton.tsx'
import { FileViewerOverlay } from '../src/client/file-viewer/FileViewerOverlay.tsx'
import { StarHubConnCard } from '../src/client/conn/StarHubConnCard.tsx'
import { ScreenshotButton } from '../src/client/screenshot/ScreenshotButton.tsx'
import { STARHUB_ASSET_SOURCE } from '../src/client/asset-source.ts'
import { STARHUB_FILE_SOURCE } from '../src/client/file-source.ts'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { AuditTab } from '../src/client/settings/audit.tsx'
import { PluginsTab } from '../src/client/settings/plugins.tsx'
import { OpenConfigAction } from '../src/client/settings/OpenConfigAction.tsx'
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
  store?: { create: () => unknown }
  inject: () => Record<string, unknown>
}

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get/effect 打桩。 */
function fakeContext() {
  const register = vi.fn((_options: RegisterOptions, _component: unknown) => () => {})
  const inject = vi.fn((_name: string, fn: () => unknown) => fn())
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
          list: {
            getSnapshot: () => ({ current: undefined, ids: [], byId: {} }),
            // exec-records 会话跟踪(apply 层)订阅 list;返回 disposer,与
            // runtime/client-apply.client.spec.ts 的 sessions mock 同形态。
            subscribe: () => () => {},
          },
          open: vi.fn(), clear: vi.fn(), binding: vi.fn(() => undefined),
        }
      case 'workspaces':
        return { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } }
      case 'conversation':
        return {
          createDraftImages: vi.fn(() => []),
          releaseDraftImages: vi.fn(),
          input: { for: vi.fn(() => ({ setDraft: vi.fn(), addImages: vi.fn(() => true) })) },
        }
      default:
        return undefined
    }
  })
  const provided: Record<string, unknown> = {}
  const provide = vi.fn((name: string, value: unknown) => { provided[name] = value })
  const ctx = {
    slots: { inject, register },
    get,
    effect,
    provide,
  } as unknown as Context
  return { ctx, register, inject, get, registerSource, effects, provide, provided }
}

describe('client-nav apply (rc.2)', () => {
  it('node half apply is a no-op', () => {
    expect(() =>{  applyHost() }).not.toThrow()
  })

  it('registers the rc.2 slots with their components in order', () => {
    const { ctx, inject, register } = fakeContext()
    applyPlugin(ctx)
    expect(inject.mock.calls.map(c => c[0])).toEqual([
      'sidebar.footer.action',
      'shell.overlay', 'shell.overlay', 'shell.overlay', 'shell.overlay',
      'conversation.session.header.actions', 'conversation.session.header.actions',
      'conversation.session.header.actions',
      'conversation.input.left',
      'settings.section', 'settings.section', 'settings.section', 'settings.section', 'settings.section',
      'settings.action',
    ])
    const components = register.mock.calls.map(c => c[1])
    expect(components).toEqual([
      StarHubFooterButton,
      StarHubOverlay, FileViewerOverlay, StarHubConnCard, StarHubToolWorkspace,
      GitBranchPill, FileTreeButton, ExecDrawerButton,
      ScreenshotButton,
      // AiTab 经 () => createElement(AiTab, { api }) 包装,按函数断言。
      expect.any(Function), PluginsTab, AuditTab, AlertTab, AboutTab,
      OpenConfigAction,
    ])
  })

  it('footer inject opens the tools panel bridge', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const footerConfig = register.mock.calls[0]![0]
    const injected = footerConfig.inject() as { openTools: () => void }
    expect(injected.openTools).toBeTypeOf('function')
    // toolsPanel 快照桥挂在工具面板(workspace)槽的 inject hooks 舱位,footer 只负责打开。
    const panelConfig = register.mock.calls[4]![0]
    const panelInjected = panelConfig.inject() as {
      openTools?: never
      hooks: { toolsPanel: { getSnapshot: () => { open: boolean } } }
    }
    expect(panelInjected.hooks.toolsPanel.getSnapshot()).toEqual({ open: false })
    injected.openTools()
    expect(panelInjected.hooks.toolsPanel.getSnapshot()).toEqual({ open: true })
  })

  it('exec drawer and file-tree pills switch views exclusively', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const execConfig = register.mock.calls.find(c => (c[0] as RegisterOptions).id === 'starhub-exec-drawer')![0] as RegisterOptions
    const execInjected = execConfig.inject() as unknown as {
      openExecView: () => void
      closeExecView: () => void
      hooks: { execRecords: { getSnapshot: () => { viewOpen: boolean; records: unknown[] } } }
    }
    const fileConfig = register.mock.calls.find(c => (c[0] as RegisterOptions).id === 'starhub-file-tree')![0] as RegisterOptions
    const fileInjected = fileConfig.inject() as unknown as {
      openFileTree: () => void
      hooks: { fileTree: { getSnapshot: () => { open: boolean } } }
    }
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
    execInjected.openExecView()
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(true)
    // 打开文件树 → 执行视图被复位(双 open 状态不允许)
    fileInjected.openFileTree()
    expect(fileInjected.hooks.fileTree.getSnapshot().open).toBe(true)
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
    // 关闭执行视图回到资产列表
    execInjected.openExecView()
    execInjected.closeExecView()
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
  })

  it('tools panel inject selects a subcategory through the selection bridge', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const panelConfig = register.mock.calls[4]![0]
    const injected = panelConfig.inject() as {
      selectSubcategory: (key: string) => void
      hooks: { selection: { getSnapshot: () => { subcategory: string | null } } }
    }
    expect(injected.selectSubcategory).toBeTypeOf('function')
    injected.selectSubcategory('database')
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('database')
  })

  it('overlay inject exposes the connection-dialog bridge face', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const overlayConfig = register.mock.calls[1]![0]
    const injected = overlayConfig.inject() as {
      openConnectionManager: () => void
      closeConnectionManager: () => void
      refreshAssets: () => void
      hooks: { connectionManager: { getSnapshot: () => { open: boolean; asset: null } } }
    }
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.closeConnectionManager).toBeTypeOf('function')
    expect(injected.refreshAssets).toBeTypeOf('function')
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: false, asset: null })
    injected.openConnectionManager()
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: true, asset: null })
  })

  it('tools panel inject closes the panel through the bridge', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const panelConfig = register.mock.calls[4]![0]
    const injected = panelConfig.inject() as { closeTools: () => void; hooks: { toolsPanel: { getSnapshot: () => { open: boolean } } } }
    injected.closeTools()
    expect(injected.hooks.toolsPanel.getSnapshot()).toEqual({ open: false })
  })

  it('opens every asset page in a React window (preview: new tab), no shell overlay hooks', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const panel = register.mock.calls[4]![0].inject() as { openAsset: (asset: unknown) => void }
      const esAsset = {
        id: 'es1', type: 'db', name: 'es-1', group_id: null,
        config: { dbType: 'elasticsearch', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      panel.openAsset(esAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('starhub-react/index.html?asset=es1')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('registers the @ asset and @ file input sources', () => {
    const { ctx, registerSource } = fakeContext()
    applyPlugin(ctx)
    const sources = registerSource.mock.calls.map(c => c[0])
    expect(sources).toHaveLength(2)
    // rc.2 InputTriggerSource 以 name 标识 source(无顶层 id 字段)。
    expect(sources[0]).toMatchObject({ name: STARHUB_ASSET_SOURCE })
    expect(sources[1]).toMatchObject({ name: STARHUB_FILE_SOURCE })
  })

  it('provides the starhubFileViewer service', () => {
    const { ctx, provided } = fakeContext()
    applyPlugin(ctx)
    const face = provided.starhubFileViewer as { open?: unknown } | undefined
    expect(typeof face?.open).toBe('function')
  })

  it('invariant registers the package name', async () => {
    const register = vi.fn(() => () => {})
    const invariantCtx = { invariants: { register } } as unknown as Context
    await applyInvariant(invariantCtx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-starhub-client-nav', expect.any(Function))
  })

  it('inject list declares the required services', () => {
    expect(injectList).toContain('slots')
    expect(injectList).toContain('connection')
    expect(injectList).toContain('inputTriggers')
    expect(injectList).toContain('sessions')
    expect(injectList).toContain('workspaces')
    expect(injectList).toContain('conversation')
  })
})