/**
 * Browser StarHub navigation plugin(方案 P1,重构版):侧栏「工具」大类/子类
 * 导航 + shell.overlay(连接对话框)+ 右侧工具工作区列 + dsh
 * 设置面板的 StarHub 分区。
 *
 * 状态拆分:nav store(root scope,仅大类展开态)挂在 sidebar.navigation
 * 上;资产列表、「当前子类 + 当前资产」与连接对话框开关由
 * apply 持有的三份裸 source 承载,经各注册的 inject hooks 舱位下发、经
 * 注入回调写入——one-handle-one-scope 约束(共享 handle 跨 scope 挂载抛错)
 * 与 session-maybe 无会话分支不下发注册侧 store 这两条规定,把共享状态都
 * 推到了 hooks 舱位范式(同 ui-agent-preset controller)。
 *
 * 资产实例操作页不再用整幅 overlay 盖住 dsh 主壳:点击资产行经
 * openNewPage(tauri.ts)在桌面端开独立 webview 窗口(label 走
 * capability 的 starhub-* glob,embed 页在新窗口里保有 IPC 授权),
 * 浏览器预览退化为新标签页。选择桥仍记录当前资产(instanceId/
 * routePrefix),供工具上下文(AI 注入)同步使用。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { JSX } from 'react'
// Type-only: the SlotMap rows of the target slots must be in the program for
// the register calls to type (declared by the slots' owning packages).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the connection service merge (ctx.get('connection') typing).
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createStarHubAssetSource } from './asset-source.ts'
import { createStarhubFileSource } from './file-source.ts'
import { createAskAiHandler, createOpenAssetHandler, subscribeHostEvents } from './host-events.ts'
import {
  createAiChatOverlay, createConnectionManagerOverlay, createStarHubAssets, createStarHubNavStore, createToolSelectionBridge,
} from './store.ts'
import { createFileViewerBridge } from './file-viewer/state.ts'
import { FileViewerOverlay } from './file-viewer/FileViewerOverlay.tsx'
import { MfaPromptCard } from './mfa/MfaPromptCard.tsx'
import type { StarHubFileViewerFace } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assetWindowUrl, type StarHubAsset } from './sections.ts'
import { focusWindowByKey, openNewPage, tauriInvoke } from './tauri.ts'
import { ScreenshotButton } from './screenshot/ScreenshotButton.tsx'
import { StarHubNav } from './StarHubNav.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'
import { GitBranchPill } from './git/GitBranchPill.tsx'
import { FileTreeButton } from './file-tree/FileTreeButton.tsx'
import { createFileTreeBridge } from './file-tree/state.ts'
import { StarHubToolWorkspace } from './StarHubToolWorkspace.tsx'
import { AboutTab } from './settings/about.tsx'
import { AiTab } from './settings/ai.tsx'
import { AlertTab } from './settings/alert.tsx'
import { AuditTab } from './settings/audit.tsx'
import { PluginsTab } from './settings/plugins.tsx'
import { loadAiSettings } from './settings/aiSettings.ts'
import { syncMemoryEnabled } from './settings/memory-context.ts'

/**
 * Required services: the slot registry, the layout panel-action face, the
 * connection wire, the input-trigger pipeline (for the `@` source) and the
 * session/workspace/conversation services (for `starhub://ask-ai`).
 */
export const inject = ['slots', 'layout', 'connection', 'inputTriggers', 'sessions', 'workspaces', 'conversation']

/**
 * Client plugin body: one root-scope store handle (sidebar) plus the
 * apply-owned selection bridge, asset-list holder, and connection-dialog
 * holder across the registrations — the sidebar navigation, the overlay
 * dialog layer, the two tool-workspace column seats (`workspace` for the
 * no-session state, `details.workspace` inside the session details
 * panel), and the dsh settings dialog's StarHub section. All ride
 * slots.inject, so each waits on its slot declaration and plugin unload
 * removes the contribution.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const navStore = createStarHubNavStore()
  const assets = createStarHubAssets()
  const selection = createToolSelectionBridge()
  const connectionManager = createConnectionManagerOverlay()
  const aiChat = createAiChatOverlay()
  // 壳内文件查看窗(2026-08-21):viewFile 回调经 starhubFileViewer 服务写入,
  // shell.overlay 席位渲染;服务面类型定义在 ui-conversation contract。
  const fileViewer = createFileViewerBridge()
  // 会话文件树视图开关(2026-08-24):头部按钮(header.actions)写,
  // 右侧工作区列(details.workspace)读——同一裸 source 桥范式。
  const fileTree = createFileTreeBridge()
  ctx.provide('starhubFileViewer', {
    open: (target) => { fileViewer.open(target) },
  } satisfies StarHubFileViewerFace)
  // 服务面:注入数组已声明依赖,读取必然非空;conversation 在预填时退化处理。
  const connection = ctx.get('connection') as ConnectionHandle
  // 「启用长期记忆」初始同步:host 侧 memory-context 插件的 namespace 未写过
  // 视为开启;若用户此前关过(localStorage false),启动时补写一次关闭态。
  syncMemoryEnabled(connection.api, loadAiSettings().memoryEnabled)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  // inject 声明了 required 'conversation',加载后必然存在(cordis ctx.get 返回可空)。
  const conversation = ctx.get('conversation') as IConversation
  // StarHub 工作台的历史令牌(--dsw-accent / --dsw-font-mono / --dsw-shadow-popover
  // 等)不在 dsh 令牌表内:经主题覆盖层注入,深浅色各一值,presenter 写到 body
  // 内联样式;独立 React 窗口无插件树,同值声明在 window-shell.css。
  const theme = ctx.get('theme')
  if (theme !== undefined) {
    const mono = "'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, monospace"
    ctx.effect(() => theme.overrideTokens('starhub', {
      '--dsw-accent': { light: '#1296a0', dark: '#5dd6d6' },
      '--dsw-accent-soft': { light: 'rgba(18, 150, 160, 0.12)', dark: 'rgba(93, 214, 214, 0.15)' },
      '--dsw-accent-weak': { light: 'rgba(18, 150, 160, 0.12)', dark: 'rgba(93, 214, 214, 0.15)' },
      '--dsw-alias-interactive-accent': { light: '#1296a0', dark: '#5dd6d6' },
      '--dsw-font-mono': { light: mono, dark: mono },
      '--dsw-shadow-popover': { light: '0 6px 24px rgba(0, 0, 0, 0.12)', dark: '0 6px 24px rgba(0, 0, 0, 0.35)' },
    }))
  }
  /** 打开资产实例操作页:记录选择桥(供 AI 工具上下文)后一律开「React 独立
   *  程序窗口」(openNewPage → /starhub-react/index.html?asset=…)。所有类型
   *  (SSH / 数据库 / Docker / Redis)统一走独立 React 窗口,不再以壳内
   *  overlay 弹框呈现,也不再回落 Vue embed。窗口 label 携带资产 id 供
   *  starhub://open-asset 的 focus 复用。 */
  const openAssetPage = (asset: StarHubAsset): void => {
    selection.openAsset(asset)
    openNewPage(assetWindowUrl(asset), asset.name, asset.id)
      // 开窗失败(如 IPC 未授权)打日志,不阻断主壳交互
      .catch((e: unknown) => { console.error('打开资产页面失败:', e) })
  }
  ctx.slots.inject('sidebar.navigation', () => ctx.slots.register({
    name: 'sidebar.navigation',
    id: 'starhub-nav',
    order: 20,
    label: 'StarHub',
    store: navStore,
    inject: () => ({
      // 子类点击:切到不同子类只换内容、保证右侧工作区列打开;重复点击
      // 当前子类才 toggle 收起(修:切子类误收起右侧栏)。
      selectSubcategory: (key: string) => {
        const same = selection.source.getSnapshot().subcategory === key
        selection.selectSubcategory(key)
        if (same) ctx.layout.toggleDetails()
        else ctx.layout.openDetails()
      },
      hooks: { selection: selection.source },
    }),
  }, StarHubNav))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-overlay',
    order: 100,
    label: 'StarHub',
    inject: () => ({
      openConnectionManager: () =>{  connectionManager.open() },
      closeConnectionManager: connectionManager.close,
      closeAiChat: aiChat.close,
      refreshAssets: assets.refresh,
      sessions,
      workspaces,
      hooks: {
        connectionManager: connectionManager.source,
        aiChat: aiChat.source,
      },
    }),
  }, StarHubOverlay))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-file-viewer',
    order: 110,
    label: 'StarHub FileViewer',
    inject: () => ({
      closeViewer: fileViewer.close,
      hooks: { fileViewer: fileViewer.source },
    }),
  }, FileViewerOverlay))
  // 主壳 MFA 验证卡(2026-08-24):AI 域工具建连遇到 keyboard-interactive 时
  // 弹出 TOTP 输入;只接管 dsh: 前缀会话,与交互终端精确事件互补。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-mfa-card',
    order: 115,
    label: 'StarHub MFA',
  }, MfaPromptCard))
  const workspaceInject = () => ({
    // The connection wire face for syncing the current tool context to
    // host settings (Path B plan 4.3).
    api: connection.api,
    openAsset: openAssetPage,
    refreshAssets: assets.refresh,
    openConnectionManager: connectionManager.open,
    // 右侧栏「AI 助手」:打开壳内 AI 聊天面板(shell.overlay 承载)。
    openAiAssistant: () =>{  aiChat.open() },
    // 文件树视图:头部按钮打开后,工作区列切为目录树;「返回资产列表」关闭。
    closeFileTree: fileTree.close,
    // 文件树右键「引用文件/文件夹」:把 `@名称 (路径)` 追加进当前会话对话框。
    insertFileReference: (text: string) => {
      const current = sessions.list.getSnapshot().current
      if (current === undefined) return
      const binding = sessions.binding(current)
      if (binding === undefined) return
      const input = conversation.input.for(binding.ctx)
      input.setDraft(input.state.getSnapshot().draft + text)
    },
    hooks: {
      selection: selection.source,
      assets: assets.source,
      fileTree: fileTree.source,
    },
  })
  // 两座工作区席位都不声明注册侧 store:session-maybe 无会话分支不下发
  // useStore,资产/选择状态全部由上面的 hooks 舱位供给。
  ctx.slots.inject('workspace', () => ctx.slots.register({
    name: 'workspace',
    inject: workspaceInject,
  }, StarHubToolWorkspace))
  ctx.slots.inject('details.workspace', () => ctx.slots.register({
    name: 'details.workspace',
    inject: workspaceInject,
  }, StarHubToolWorkspace))
  // 契约 §6.1:`@` 资产 source(ui-input-trigger 流水线);pick 轻绑定上下文,
  // 不切窗口。ctx.effect 保证 HMR 卸载时反注册 source。
  ctx.effect(
    () => inputTriggers.registerSource(createStarHubAssetSource({ api: connection.api, assets, selection })),
    'starhub: @ asset source',
  )
  // `@` 文件 source(2026-08-24):与资产 source 同 trigger 并行,候选来自当前
  // 会话工作区目录树;pick 产物 `@文件名 (路径)` 与文件树右键引用一致。
  ctx.effect(
    () => inputTriggers.registerSource(createStarhubFileSource({ sessions })),
    'starhub: @ file source',
  )
  // 会话头部「git 分支胶囊」(2026-08-21):会话 cwd 下的分支展示 + 搜索/切换
  // 分支 + commit/push;非 git 工作区与浏览器预览(无 Tauri IPC)不渲染。
  // order 30:排在 ui-jobs 后台任务(20)之后、utilities 之前。
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'starhub-git-branch',
    order: 30,
    label: 'StarHub Git',
  }, GitBranchPill))
  // 会话头部「文件树」按钮(2026-08-24):分支胶囊旁,点击打开右侧详情列并
  // 切到项目文件目录树视图;再次点击切回资产列表。order 40:紧跟分支胶囊。
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'starhub-file-tree',
    order: 40,
    label: 'StarHub 文件树',
    inject: () => ({
      openFileTree: () => {
        fileTree.open()
        ctx.layout.openDetails()
      },
      closeFileTree: fileTree.close,
      hooks: { fileTree: fileTree.source },
    }),
  }, FileTreeButton))
  // AI 对话输入框截图(2026-08-23):工具行「剪刀」按钮 → 区域截图(遮罩框选),
  // 确认后结果作为图片附件进当前会话输入(与粘贴/拖拽同一管线)。
  // 浏览器预览(无 Tauri IPC)下 invoke 拒绝,按钮点击打日志不弹窗。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'starhub-screenshot',
    order: 10,
    label: 'StarHub 截图',
    inject: () => ({
      createDraftImages: (files: readonly File[]) => conversation.createDraftImages(files),
      startRegion: () => tauriInvoke<void>('screenshot_begin_region'),
    }),
  }, ScreenshotButton))
  // 契约 §6.2-6.3:监听 Tauri 宿主事件(open-asset / ask-ai);订阅经
  // ctx.effect 注册,dispose 卸载监听(HMR 安全)。
  ctx.effect(() => subscribeHostEvents({
    onOpenAsset: createOpenAssetHandler({
      assets,
      openAssetPage,
      focusWindow: focusWindowByKey,
    }),
    onAskAi: createAskAiHandler({
      api: connection.api,
      selection,
      sessions,
      workspaces,
      conversation,
    }),
  }), 'starhub: tauri host events')
  // 设置融入底部设置齿轮:dsh 设置面板侧栏的 StarHub 可展开分组(点击
  // 分组头展开/收起,点子项右侧直渲对应 tab——两列,无内部嵌套列)。
  // group='starhub' 由 ui-settings-general 的 SettingsRoot 渲染为折叠分组;
  // 5 个子 section 分别直渲 AI/插件/审计/告警/关于。order 30 起排在
  // 通用(0)/模型(10)/插件(15)/Agent 预设(20)之后。
  const starhubTabs: ReadonlyArray<{
    id: string
    order: number
    label: string
    component: () => JSX.Element
  }> = [
    { id: 'starhub-ai', order: 30, label: 'AI 助手', component: () => createElement(AiTab, { api: connection.api }) },
    { id: 'starhub-plugins', order: 31, label: '插件', component: PluginsTab },
    { id: 'starhub-audit', order: 32, label: '审计日志', component: AuditTab },
    { id: 'starhub-alert', order: 33, label: '告警规则', component: AlertTab },
    { id: 'starhub-about', order: 34, label: '关于', component: AboutTab },
  ]
  for (const tab of starhubTabs) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: tab.id,
      order: tab.order,
      label: tab.label,
      group: 'starhub',
      groupLabel: 'StarHub',
    }, tab.component))
  }
}
