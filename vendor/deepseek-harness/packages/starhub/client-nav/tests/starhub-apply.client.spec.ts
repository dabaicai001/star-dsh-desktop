// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply,rc.2 适配后):各槽位注册的槽名、组件与注入面
 * (工具面板桥 / 连接对话框桥 / 执行记录抽屉 / 截图按钮附件 / 壳内工作台面板)
 * 与工具树子类选中语义(selectSubcategory 写选择桥,不再联动布局开关)。
 * rc.2 注册面(v0.100.0 起右下角 BastionExecPanel 浮层席位移除;
 * v0.121.8 起文件树/文件查看/@ 文件源随「文件功能」移除;v0.123.1 起
 * 「插件市场」「AI 助手」tab 移除——前者由壳内首页「插件」面板接管,后者
 * (长期记忆)整条栈退场;v0.123.2 起「工具」入口从 sidebar.footer.action +
 * shell.overlay 浮层迁到 sidebar.panellist 行 + main 主面板;去 Tauri 化 M2
 * 第 6 步起资产实例操作页从独立 webview 窗口改为壳内工作台主面板——第二个
 * keyed main 槽;去 Tauri 化 M3 起直播/接管线从独立直播窗口改为壳内直播主
 * 面板——第三个 keyed main 槽;v0.130.0 起直播行/git 分支胶囊/审计日志/
 * 告警规则/沙箱平台/关于 tab 移除——直播面板保留 keyed main 槽(不占侧栏行,
 * AI 触发直播时自动接管);v0.132.0 起沙箱桌面域整体退役(工作面板 + 请求介入
 * 横幅),且工作台/直播/执行记录三个页面关掉时一律回会话视图(不回工具列表):
 * `shell.overlay`×2(overlay / AI 连接卡)+ `sidebar.panellist`
 * ×1(工具行)+ `main`×3(工具面板 / 工作台面板 / 直播面板)+
 * `conversation.session.header.actions`×1(执行)+
 * `conversation.input.left`(截图)+ `settings.section`×2(Android / SSH)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin, inject as injectList } from '../src/client/index.ts'
import { ToolsPanelIcon } from '../src/client/ToolsPanelIcon.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { StarHubWorkbenchPanel } from '../src/client/StarHubWorkbenchPanel.tsx'
import { StarHubLivePanel } from '../src/client/live/StarHubLivePanel.tsx'
import { ExecDrawerButton } from '../src/client/conn/ExecDrawerButton.tsx'
import { StarHubConnCard } from '../src/client/conn/StarHubConnCard.tsx'
import { ScreenshotButton } from '../src/client/screenshot/ScreenshotButton.tsx'
import { AndroidSettingsTab } from '../src/client/settings/android.tsx'
import { SshSettingsTab } from '../src/client/settings/ssh.tsx'
import { STARHUB_ASSET_SOURCE } from '../src/client/asset-source.ts'
import { restoreHostBridge } from './host-bridge.ts'

afterEach(() => {
  vi.restoreAllMocks()
  restoreHostBridge()
})

/** Register-options face the client apply passes to slots.register, typed for the call log. */
interface RegisterOptions {
  name: string
  id?: string
  order?: number
  label?: string
  /** keyed 槽(main)的 entry key;list 槽注册不带。 */
  key?: string
  store?: { create: () => unknown }
  inject: () => Record<string, unknown>
}

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get/effect 打桩。 */
function fakeContext(overrides: { sessions?: unknown; conversation?: unknown; remote?: unknown; layout?: unknown } = {}) {
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

      case 'inputTriggers':
        return { registerSource }
      case 'layout':
        return overrides.layout ?? { selectPanel: vi.fn() }
      case 'sessions':
        return overrides.sessions ?? {
          list: {
            getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
            // exec-records 会话跟踪(apply 层)订阅 list;返回 disposer,与
            // runtime/client-apply.client.spec.ts 的 sessions mock 同形态。
            subscribe: () => () => {},
          },
          binding: vi.fn(() => undefined),
        }
      case 'uiWorkspace':
        return { openSession: vi.fn() }
      case 'workspaces':
        return { list: { getSnapshot: () => ({ items: [] }) } }
      case 'conversation':
        return overrides.conversation ?? {
          createDrafts: vi.fn(() => []),
          releaseDraftAttachments: vi.fn(),
          input: { for: vi.fn(() => ({ setDraft: vi.fn(), addAttachments: vi.fn(() => true) })) },
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
    // 0.1.6:apiproxy 撤除,settings 写入与类型化 RPC 走 ctx.remote(api-gateway)。
    remote: overrides.remote ?? { settings: { update: vi.fn(() => Promise.resolve({ ok: true, value: undefined })) } },
  } as unknown as Context
  return { ctx, register, inject, get, registerSource, effects, provide, provided }
}

/** 按 main keyed 槽的 key 找注册配置(索引会随新槽插入而漂移,不写死下标)。 */
function mainByKey(register: ReturnType<typeof fakeContext>['register'], key: string): RegisterOptions {
  const call = register.mock.calls.find(
    (entry) => (entry[0] as RegisterOptions).name === 'main' && (entry[0] as RegisterOptions).key === key,
  )
  if (call === undefined) throw new Error(`no main slot registered for ${key}`)
  return call[0] as RegisterOptions
}

describe('client-nav apply (rc.2)', () => {
  it('node half apply is a no-op', () => {
    expect(() =>{  applyHost() }).not.toThrow()
  })

  it('registers the rc.2 slots with their components in order', () => {
    const { ctx, inject, register } = fakeContext()
    applyPlugin(ctx)
    expect(inject.mock.calls.map(c => c[0])).toEqual([
      'shell.overlay', 'shell.overlay',
      'sidebar.panellist', 'main', 'main', 'main',
      'conversation.session.header.actions',
      'conversation.input.left',
      'settings.section', 'settings.section',
    ])
    const components = register.mock.calls.map(c => c[1])
    expect(components).toEqual([
      StarHubOverlay, StarHubConnCard,
      ToolsPanelIcon, StarHubToolWorkspace, StarHubWorkbenchPanel, StarHubLivePanel,
      ExecDrawerButton,
      ScreenshotButton,
      AndroidSettingsTab, SshSettingsTab,
    ])
  })

  it('live panel rides a keyed main slot with no panellist row (v0.130.0: row removed)', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    // v0.130.0:直播侧栏行移除(空壳白屏 + 无会话态);面板保留 keyed main 槽,
    // 由 Android 面板「直播」按钮 / android_ui_open_live 拉起(与工作台面板同
    // 形态:keyed main 不占侧栏行)。侧栏行只剩「工具」一条。
    const rows = register.mock.calls.filter(c => (c[0] as RegisterOptions).name === 'sidebar.panellist')
    expect(rows).toHaveLength(1)
    expect((rows[0]![0] as RegisterOptions).id).toBe('starhub-tools')
    // main keyed 槽仍在:契约要求同 id 注册,否则 layout.selectPanel 抛错。
    const mainConfig = mainByKey(register, 'starhub-live')
    expect(mainConfig.name).toBe('main')
    expect(mainConfig.key).toBe('starhub-live')
  })

  it('live panel inject exposes the channel writes the component drives', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const liveConfig = mainByKey(register, 'starhub-live')
    const injected = liveConfig.inject() as unknown as {
      activateChannel: (channel: string) => void
      closeChannel: (channel: string) => void
      setStatus: (status: string) => void
      setMeta: (meta: Record<string, unknown>) => void
      setTakeover: (takeover: boolean) => void
      hooks: { live: { getSnapshot: () => { channels: unknown[]; activeChannel: string | null } } }
    }
    expect(injected.hooks.live.getSnapshot().channels).toEqual([])
    injected.setStatus('connecting')
    expect(injected.hooks.live.getSnapshot()).toMatchObject({ status: 'connecting' })
    injected.setMeta({ mode: 'scrcpy', width: 1080, height: 2400 })
    expect(injected.hooks.live.getSnapshot()).toMatchObject({ mode: 'scrcpy', width: 1080 })
    injected.setTakeover(true)
    expect(injected.hooks.live.getSnapshot()).toMatchObject({ takeover: true })
  })

  it('tools entry rides the panellist row above the main panel it selects', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    // panellist 行:紧随「插件」(order 0)之下,侧栏拥有按钮/标签/选中态。
    // 按下标取会被前面的 overlay 席位增减带偏,按 id 找。
    const rowConfig = register.mock.calls
      .find(c => (c[0] as RegisterOptions).id === 'starhub-tools')![0] as RegisterOptions
    expect(rowConfig.name).toBe('sidebar.panellist')
    expect(rowConfig.id).toBe('starhub-tools')
    expect(rowConfig.order).toBe(1)
    // v0.133.0:标签带品牌名,与「插件」「自动化任务」并排时分得清是谁的工具
    expect(rowConfig.label).toBe('StarHub 工具')
    // main keyed 槽:契约要求同 id 注册,否则 layout.selectPanel 抛错。
    const mainConfig = mainByKey(register, 'starhub-tools') as RegisterOptions
    expect(mainConfig.name).toBe('main')
    expect(mainConfig.key).toBe('starhub-tools')
  })

  it('exec drawer switches to the tools main panel; × returns to the session', () => {
    const selectPanel = vi.fn()
    const { ctx, register } = fakeContext({ layout: { selectPanel } })
    applyPlugin(ctx)
    const mainConfig = mainByKey(register, 'starhub-tools')
    const mainInjected = mainConfig.inject() as { closeTools: () => void }
    // 工具面板 × = 回会话视图(null = 默认 conversation 面板)。
    mainInjected.closeTools()
    expect(selectPanel).toHaveBeenCalledWith(null)
    // 执行 按钮:打开执行记录视图并切到工具面板。
    const execConfig = register.mock.calls.find(c => (c[0] as RegisterOptions).id === 'starhub-exec-drawer')![0]
    const execInjected = execConfig.inject() as { openExecView: () => void }
    execInjected.openExecView()
    expect(selectPanel).toHaveBeenCalledTimes(2)
    expect(selectPanel).toHaveBeenLastCalledWith('starhub-tools')
  })

  it('exec drawer pill opens and closes the records view', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const execConfig = register.mock.calls.find(c => (c[0] as RegisterOptions).id === 'starhub-exec-drawer')![0] as RegisterOptions
    const execInjected = execConfig.inject() as unknown as {
      openExecView: () => void
      closeExecView: () => void
      hooks: { execRecords: { getSnapshot: () => { viewOpen: boolean; records: unknown[] } } }
    }
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
    execInjected.openExecView()
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(true)
    // 关闭执行视图(面板内的视图开关复位)
    execInjected.closeExecView()
    expect(execInjected.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
  })

  it('tools panel inject selects a subcategory through the selection bridge', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const panelConfig = mainByKey(register, 'starhub-tools')
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
    const overlayConfig = register.mock.calls.find(c => (c[0] as RegisterOptions).id === 'starhub-overlay')![0]
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

  it('opens every asset page in the in-shell workbench panel (no new window)', () => {
    const selectPanel = vi.fn()
    const { ctx, register } = fakeContext({ layout: { selectPanel } })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({}) as Window)
    try {
      applyPlugin(ctx)
      const panel = mainByKey(register, 'starhub-tools').inject() as { openAsset: (asset: unknown) => void }
      const esAsset = {
        id: 'es1', type: 'db', name: 'es-1', group_id: null,
        config: { dbType: 'elasticsearch', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      panel.openAsset(esAsset)
      // M2 第 6 步:不再新开窗口/标签页,而是壳内工作台面板的一页。
      expect(openSpy).not.toHaveBeenCalled()
      expect(selectPanel).toHaveBeenCalledWith('starhub-workbench')
      const workbenchConfig = mainByKey(register, 'starhub-workbench') as RegisterOptions
      const injected = workbenchConfig.inject() as {
        hooks: {
          workbench: {
            getSnapshot: () => { pages: Array<{ key: string; title: string; url: string }>; activeKey: string | null }
          }
        }
      }
      const state = injected.hooks.workbench.getSnapshot()
      expect(state.pages.map((page) => page.key)).toEqual(['es1'])
      expect(state.activeKey).toBe('es1')
      expect(state.pages[0]?.url).toContain('starhub-react/index.html?asset=es1')

      // 关掉最后一页:面板让回**会话视图**(v0.132.0:不再回退工具列表)。
      const closePage = injected as unknown as { closePage: (key: string) => void }
      closePage.closePage('es1')
      expect(injected.hooks.workbench.getSnapshot().pages).toEqual([])
      expect(selectPanel).toHaveBeenLastCalledWith(null)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('registers the @ asset input source', () => {
    const { ctx, registerSource } = fakeContext()
    applyPlugin(ctx)
    const sources = registerSource.mock.calls.map(c => c[0])
    expect(sources).toHaveLength(1)
    // rc.2 InputTriggerSource 以 name 标识 source(无顶层 id 字段)。
    expect(sources[0]).toMatchObject({ name: STARHUB_ASSET_SOURCE })
  })

  // 资产右键「引用到当前对话框」(v0.103.0):apply 层注入面 insertAssetReference
  // 的装配语义——轻绑定 settings 上下文 + 引用 chip 插入草稿末尾。
  const refAsset = {
    id: 'a1', type: 'ssh', name: 'prod-server', group_id: null,
    config: { host: '10.0.0.5', username: 'deploy' },
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }

  function referenceContext(inputStub: { insertReference: ReturnType<typeof vi.fn>; setDraft: ReturnType<typeof vi.fn> }) {
    const settingsUpdate = vi.fn(() => Promise.resolve({ result: { ok: true } }))
    const input = {
      ...inputStub,
      addImages: vi.fn(() => true),
      state: { getSnapshot: () => ({ draft: '查一下 ', draftRev: 3 }) },
    }
    const harness = fakeContext({
      remote: { settings: { update: settingsUpdate } },
      sessions: {
        list: {
          // 0.1.7:当前会话 = mainView 保留的会话(currentSessionId 推导)。
          getSnapshot: () => ({
            ids: ['s1'],
            byId: { s1: { retainedBy: { mainView: 1 } } },
            phase: 'ready',
            projectionsBySession: {},
          }),
          subscribe: () => () => {},
        },
        binding: vi.fn(() => ({ ctx: {} })),
      },
      conversation: {
        createDrafts: vi.fn(() => []),
        releaseDraftAttachments: vi.fn(),
        input: { for: vi.fn(() => input) },
      },
    })
    return { ...harness, settingsUpdate }
  }

  it('tools panel inject references an asset into the current conversation (chip + light binding)', () => {
    const insertReference = vi.fn(() => true)
    const setDraft = vi.fn()
    const { ctx, register, settingsUpdate } = referenceContext({ insertReference, setDraft })
    applyPlugin(ctx)
    const panel = mainByKey(register, 'starhub-tools').inject() as { insertAssetReference: (asset: unknown) => void }
    panel.insertAssetReference(refAsset)
    // 轻绑定:starhub-tool-context settings patch 带会话 id 与资产(与 @ pick 同通道)
    expect(settingsUpdate).toHaveBeenCalledWith(
      'starhub-tool-context',
      expect.objectContaining({ sessionId: 's1', assetId: 'a1', assetName: 'prod-server' }),
      undefined,
    )
    // chip 插在草稿末尾(span 从 draft 末起,带 pick 时刻 draftRev)
    expect(insertReference).toHaveBeenCalledWith(
      { source: STARHUB_ASSET_SOURCE, ref: 'a1', label: 'prod-server (deploy@10.0.0.5)', clipboardText: '@prod-server' },
      { start: 4, end: 4, draftRev: 3 },
    )
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('falls back to plain-text append when the input machine refuses the chip', () => {
    const insertReference = vi.fn(() => false)
    const setDraft = vi.fn()
    const { ctx, register } = referenceContext({ insertReference, setDraft })
    applyPlugin(ctx)
    const panel = mainByKey(register, 'starhub-tools').inject() as { insertAssetReference: (asset: unknown) => void }
    // Docker 资产:纯文本回退同样带 [Docker] 删除保护标注
    panel.insertAssetReference({ ...refAsset, id: 'd1', type: 'docker', name: 'local-docker', config: {} })
    expect(setDraft).toHaveBeenCalledWith('查一下 @local-docker [Docker] ')
  })

  it('no-ops the asset reference when no session is current', () => {
    const settingsUpdate = vi.fn(() => Promise.resolve({ result: { ok: true } }))
    const { ctx, register } = fakeContext({
      remote: { settings: { update: settingsUpdate } },
    })
    applyPlugin(ctx)
    // apply 启动期的记忆开关初始同步也会写一次 settings,先清掉再断言本路径不写
    settingsUpdate.mockClear()
    const panel = mainByKey(register, 'starhub-tools').inject() as { insertAssetReference: (asset: unknown) => void }
    panel.insertAssetReference(refAsset)
    expect(settingsUpdate).not.toHaveBeenCalled()
  })


  it('inject list declares the required services', () => {
    expect(injectList).toContain('slots')
    expect(injectList).toContain('connection')
    expect(injectList).toContain('inputTriggers')
    expect(injectList).toContain('sessions')
    expect(injectList).toContain('workspaces')
    expect(injectList).toContain('conversation')
    expect(injectList).toContain('remote')
    // 0.1.7:ask-ai 的会话聚焦走 view owner 的导航面(uiWorkspace.openSession)。
    expect(injectList).toContain('uiWorkspace')
    // 0.1.6 Typert gateway:每个 Remote 命名空间是独立 service,
    // ctx.remote.<ns> 要求 fiber 声明点号全名,否则 apply 抛
    // "cannot get property … without inject"(v0.121.7 启动事故)。
    expect(injectList).toContain('remote.settings')
    // v0.123.2:工具面板迁主面板,入口/执行 跳转走 ui-layout 的 layout 服务。
    expect(injectList).toContain('layout')
  })
})
