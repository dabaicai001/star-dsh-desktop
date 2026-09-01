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
import type { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createStarHubAssetSource, DOCKER_REFERENCE_TAG, STARHUB_ASSET_SOURCE } from './asset-source.ts'
import { createStarhubFileSource } from './file-source.ts'
import { createAskAiHandler, createOpenAssetHandler, subscribeHostEvents } from './host-events.ts'
import {
  createAiChatOverlay, createConnectionManagerOverlay, createStarHubAssets, createToolSelectionBridge,
  createToolsPanelOverlay, type RustAsset,
} from './store.ts'
import { createFileViewerBridge } from './file-viewer/state.ts'
import { FileViewerOverlay } from './file-viewer/FileViewerOverlay.tsx'
import { StarHubConnCard } from './conn/StarHubConnCard.tsx'
import { ExecDrawerButton } from './conn/ExecDrawerButton.tsx'
import { createExecRecordsBridge, subscribeSshExecEvents } from './conn/exec-records.ts'
import type { FileViewTarget } from './file-viewer/state.ts'
import { assetSubtitle, assetWindowUrl, type StarHubAsset } from './sections.ts'
import { bindAssetContext } from './tool-context.ts'
import { focusWindowByKey, openNewPage, tauriInvoke } from './tauri.ts'
import { ScreenshotButton } from './screenshot/ScreenshotButton.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'
import { StarHubFooterButton } from './StarHubFooterButton.tsx'
import { GitBranchPill } from './git/GitBranchPill.tsx'
import { FileTreeButton } from './file-tree/FileTreeButton.tsx'
import { createFileTreeBridge } from './file-tree/state.ts'
import { StarHubToolWorkspace, type StarHubToolWorkspaceInjected } from './StarHubToolWorkspace.tsx'
import { AboutTab } from './settings/about.tsx'
import { AndroidSettingsTab } from './settings/android.tsx'
import { SandboxSettingsTab } from './settings/sandbox.tsx'
import { SandboxUserActionBanner } from './sandbox/SandboxUserActionBanner.tsx'
import { AiTab } from './settings/ai.tsx'
import { AlertTab } from './settings/alert.tsx'
import { AuditTab } from './settings/audit.tsx'
import { PluginsTab } from './settings/plugins.tsx'
import { OpenConfigAction } from './settings/OpenConfigAction.tsx'
import { loadAiSettings } from './settings/aiSettings.ts'
import { syncMemoryEnabled } from './settings/memory-context.ts'

/**
 * Required services: the slot registry, the connection wire, the input-trigger
 * pipeline (for the `@` source) and the session/workspace/conversation services
 * (for `starhub://ask-ai`).
 */
export const inject = ['slots', 'connection', 'inputTriggers', 'sessions', 'workspaces', 'conversation']

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
  const assets = createStarHubAssets()
  const selection = createToolSelectionBridge()
  const connectionManager = createConnectionManagerOverlay()
  const aiChat = createAiChatOverlay()
  // 工具面板(侧栏底部入口 → shell.overlay):footer 按钮写 open,overlay 席位读渲染。
  const toolsPanel = createToolsPanelOverlay()
  // 壳内文件查看窗(2026-08-21):viewFile 回调经 starhubFileViewer 服务写入,
  // shell.overlay 席位渲染;服务面类型定义在 ui-conversation contract。
  const fileViewer = createFileViewerBridge()
  // 会话文件树视图开关(2026-08-24):头部按钮(header.actions)写,
  // 右侧工作区列(details.workspace)读——同一裸 source 桥范式。
  const fileTree = createFileTreeBridge()
  // SSH 执行记录桥(v0.100.0,v0.100.1 会话隔离):ssh:exec-done 事件在
  // apply 层订阅(下方 ctx.effect),记录打上「当时活跃会话」标记;头部
  // 「执行」按钮与工具抽屉的执行记录视图只展示当前会话的条目。
  const execRecords = createExecRecordsBridge()
  // ssh:exec-done 通用事件订阅:插件生命周期常驻(ctx.effect 卸载时反注册),
  // 不随头部按钮/工具抽屉的开合与重挂载丢失;dsh: 以外的会话由 note 忽略。
  ctx.effect(
    () => subscribeSshExecEvents(execRecords.note),
    'starhub: ssh exec-done events',
  )
  ctx.provide('starhubFileViewer', {
    open: (target) => { fileViewer.open(target) },
  } satisfies { open: (target: FileViewTarget) => void })
  // 服务面:注入数组已声明依赖,读取必然非空;conversation 在预填时退化处理。
  const connection = ctx.get('connection') as ConnectionHandle
  // 「启用长期记忆」初始同步:host 侧 memory-context 插件的 namespace 未写过
  // 视为开启;若用户此前关过(localStorage false),启动时补写一次关闭态。
  syncMemoryEnabled(connection.api, loadAiSettings().memoryEnabled)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  // inject 声明了 required 'conversation',加载后必然存在(cordis ctx.get 返回可空)。
  const conversation = ctx.get('conversation') as unknown as ConversationController
  // 执行记录按会话隔离(2026-08-27):把「当前活跃会话」喂给 execRecords 桥,
  // 「执行」角标、抽屉列表与「清空」都只作用于本会话,跨会话不再共用;
  // 首次同步立即写一次(不依赖切换事件才初始化)。
  ctx.effect(() => {
    const sync = () => { execRecords.setConversation(sessions.list.getSnapshot().current) }
    sync()
    return sessions.list.subscribe(sync)
  }, 'starhub: exec records follow current session')
  // StarHub 工作台遵循 dsh 设计理念:不再注入自有主题 token(旧 --dsw-accent /
  // --dsw-font-mono / --dsw-shadow-popover 等历史令牌),统一消费 ui-theme 的
  // --dsw-alias-* 语义别名,深浅色由 dsh 主题所有者(ui-theme)处理。
  /** 打开资产实例操作页:记录选择桥(供 AI 工具上下文)后一律开「React 独立
   *  程序窗口」(openNewPage → /starhub-react/index.html?asset=…)。所有类型
   *  (SSH / 数据库 / Docker / Redis)统一走独立 React 窗口,不再以壳内
   *  overlay 弹框呈现,也不再回落 Vue embed。窗口 label 携带资产 id 供
   *  starhub://open-asset 的 focus 复用。 */
  const openAssetPage = (asset: StarHubAsset): void => {
    selection.openAsset(asset)
    // 独立工作台窗口不跑 ui-theme 插件树:把主壳当前解析主题(dark)经 `dark` 参数
    // 传入,窗口据此切换深浅色 token(跟随 DSH 主题,而非固定深色)。
    const baseUrl = assetWindowUrl(asset)
    let url = baseUrl
    if (typeof document !== 'undefined') {
      const dark = document.body.hasAttribute('data-ds-dark-theme')
      url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}dark=${dark ? '1' : '0'}`
    }
    openNewPage(url, asset.name, asset.id)
      // 开窗失败(如 IPC 未授权)打日志,不阻断主壳交互
      .catch((e: unknown) => { console.error('打开资产页面失败:', e) })
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'starhub-tools',
    order: 10,
    label: 'StarHub 工具',
    inject: () => ({
      // 打开工具面板(shell.overlay 席位承载的 StarHubToolWorkspace)。
      openTools: () =>{  toolsPanel.open() },
    }),
  }, StarHubFooterButton))
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
  // 主壳 AI 连接卡(v0.99.0 整体重构):合并 MFA 验证卡与堡垒机选机器浮层为
  // 一张统一连接卡。组件级监听请求/结束信号(ssh:kb-interactive /
  // ssh:bastion-select / ssh:bastion-done),不随浮层重挂载丢失,修复「命令
  // 已执行但按钮卡住/浮层不关」;同一时刻至多一张卡(互斥)。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-conn-card',
    order: 115,
    label: 'StarHub ConnCard',
  }, StarHubConnCard))
  // 沙箱桌面「请求人工介入」常驻横幅(desktop_request_user_action):无待答
  // 请求时渲染 null;事件订阅在组件内部(HMR/卸载自动退订)。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-sandbox-user-action',
    order: 120,
    label: 'StarHub Sandbox UserAction',
  }, SandboxUserActionBanner))
  const workspaceInject = (): StarHubToolWorkspaceInjected => ({
    openAsset: openAssetPage,
    refreshAssets: assets.refresh,
    openConnectionManager: connectionManager.open,
    // 文件树视图:面板内「文件树」开关(关闭回到资产列表)。
    closeFileTree: fileTree.close,
    // 执行记录视图(v0.100.0):头部「执行」按钮的开关与清空(关闭回到资产列表)。
    closeExecView: execRecords.closeView,
    clearExecRecords: execRecords.clear,
    // 行内「断开连接」(v0.100.1):先移除记录(UI 即时消失),再异步断开
    // 后端 SSH 连接;断开失败仅记日志——连接可能已自行断开,记录照样不显示。
    disconnectExecSession: (sessionId: string) => {
      execRecords.removeSession(sessionId)
      tauriInvoke('ssh_disconnect', { id: sessionId }).catch((e: unknown) => {
        console.error('关闭 SSH 连接失败:', sessionId, e)
      })
    },
    // 关闭工具面板(footer 入口再点或面板右上角 ×,或点遮罩空白)。
    // 一并复位文件树视图:面板已关,若 fileTree.open 仍为 true,下回点会话
    // 头部「文件」胶囊会走到 closeFileTree 而非 openFileTree,看起来没反应。
    closeTools: () => {
      // 一并复位两个视图开关:面板已关,若残留 true,下回点「文件/执行」
      // 胶囊会走到 close 分支而非打开,看起来没反应。
      fileTree.close()
      execRecords.closeView()
      toolsPanel.close()
    },
    // 选中一个子类:写入选择桥,面板展开该子类的资产列表。
    selectSubcategory: (key: string) => { selection.selectSubcategory(key) },
    // 文件树右键「引用文件/文件夹」:把 `@名称 (路径)` 追加进当前会话对话框。
    insertFileReference: (text: string) => {
      const current = sessions.list.getSnapshot().current
      if (current === undefined) return
      const binding = sessions.binding(current)
      if (binding === undefined) return
      const input = conversation.input.for(binding.ctx)
      input.setDraft(input.state.getSnapshot().draft + text)
    },
    // 资产行右键「引用到当前对话框」(v0.103.0):与 `@` 资产 source pick 同语义——
    // 先轻绑定资产上下文(starhub-tool-context settings,会话级),再把引用 chip
    // 插到草稿末尾(insertReference 走输入机,chip 由 starhub-asset codec 在提交时
    // 序列化为模型可读文本);输入机忙碌(非 plain/claimed 或 draftRev CAS 失败)
    // 时退化为纯文本追加,与文件引用一致。无当前会话时静默不动作(同文件引用)。
    insertAssetReference: (asset: RustAsset) => {
      const current = sessions.list.getSnapshot().current
      if (current === undefined) return
      const binding = sessions.binding(current)
      if (binding === undefined) return
      bindAssetContext(connection.api, selection.source.getSnapshot(), asset, current)
      const sub = assetSubtitle(asset)
      // Docker 资产带 [Docker] 删除保护标注(与 pick 候选/引用文本一致)。
      const dockerMark = asset.type === 'docker' ? ` ${DOCKER_REFERENCE_TAG}` : ''
      const label = `${sub === '' ? asset.name : `${asset.name} (${sub})`}${dockerMark}`
      const input = conversation.input.for(binding.ctx)
      const snapshot = input.state.getSnapshot()
      const inserted = input.insertReference(
        {
          source: STARHUB_ASSET_SOURCE,
          ref: asset.id,
          label,
          clipboardText: `@${asset.name}`,
        },
        { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev },
      )
      if (!inserted) input.setDraft(`${snapshot.draft}@${label} `)
    },
    hooks: {
      selection: selection.source,
      assets: assets.source,
      fileTree: fileTree.source,
      toolsPanel: toolsPanel.source,
      execRecords: execRecords.source,
    },
  })
  // 工具面板(rc.2 适配):`workspace`/`details.workspace` 槽在 rc.2 已不存在,
  // 改挂 shell.overlay,由侧栏底部「工具」入口(footer.action → toolsPanel 桥)开。
  // shell.overlay 是 list 槽、root scope:不开注册侧 store,全部经 hooks 舱位下发。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-tools-panel',
    order: 105,
    label: 'StarHub 工具面板',
    inject: workspaceInject,
  }, StarHubToolWorkspace))
  // 右下角 BastionExecPanel 浮层席位已在 v0.100.0 移除:静默执行记录改由
  // 头部「执行」按钮 + 工具抽屉的执行记录视图承载(见 header.actions 的
  // starhub-exec-drawer 席位与 StarHubToolWorkspace 的 exec 分支)。
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
  // 会话头部「文件树」按钮(2026-08-24):分支胶囊旁,点击打开工具抽屉
  // (shell.overlay 承载的 StarHubToolWorkspace)并切到项目文件目录树视图;
  // 再次点击切回资产列表。文件树本体渲染在工具抽屉内,故打开的是 toolsPanel
  // 而非 rc.2 的 details 列(details 列由 ui-conversation 独占展示工具调用)。
  // v0.100.0:打开文件树时顺带退出执行记录视图(两个视图互斥,避免双 open
  // 状态下抽屉展示分支与按钮开合态不一致)。
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'starhub-file-tree',
    order: 40,
    label: 'StarHub 文件树',
    inject: () => ({
      openFileTree: () => {
        fileTree.open()
        execRecords.closeView()
        toolsPanel.open()
      },
      closeFileTree: fileTree.close,
      hooks: { fileTree: fileTree.source },
    }),
  }, FileTreeButton))
  // 会话头部「执行」按钮(v0.100.0):「文件」胶囊旁,点击打开工具抽屉并切到
  // 「SSH 执行记录」视图(ai 静默执行的 ssh_exec 完成记录,行点击展开/收起,
  // 多条纵向滚动);再次点击返回资产列表。数据由 apply 层的 execRecords 桥
  // 常驻订阅 ssh:exec-done 累积,按钮只是开关。
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'starhub-exec-drawer',
    order: 45,
    label: 'StarHub 执行',
    inject: () => ({
      openExecView: () => {
        execRecords.openView()
        fileTree.close()
        toolsPanel.open()
      },
      closeExecView: execRecords.closeView,
      hooks: { execRecords: execRecords.source },
    }),
  }, ExecDrawerButton))
  // AI 对话输入框截图(2026-08-23):工具行「剪刀」按钮 → 区域截图(遮罩框选),
  // 确认后结果作为图片附件进当前会话输入(与粘贴/拖拽同一管线)。
  // 浏览器预览(无 Tauri IPC)下 invoke 拒绝,按钮点击打日志不弹窗。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'starhub-screenshot',
    order: 10,
    label: 'StarHub 截图',
    inject: () => ({
      // rc.2 附件管线:createDraftImages 注册 draft → input shell addImages 挂进输入。
      // 无当前会话(session-maybe 空态)时 shell 不存在,addImages 置 undefined(按钮仍可截图,
      // 结果无处挂载时静默丢弃)。
      addImages: (files: readonly File[]): string | null => {
        const current = sessions.list.getSnapshot().current
        if (current === undefined) return null
        const binding = sessions.binding(current)
        if (binding === undefined) return null
        try {
          const images = conversation.createDraftImages(files)
          if (!conversation.input.for(binding.ctx).addImages(images.map(image => image.id))) {
            conversation.releaseDraftImages(images)
          }
          return null
        } catch (error: unknown) {
          return error instanceof Error ? error.message : String(error)
        }
      },
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
  // 设置融入底部设置齿轮:dsh 设置面板侧栏的 StarHub 分区(平铺,rc.2 上游
  // SettingsSectionRow 只支持 id/order/label,无分组字段——5 个 tab 直接
  // 以平铺 section 呈现;order 30 起排在通用(0)/模型(10)/插件(15)/
  // Agent 预设(20)之后)。
  const starhubTabs: ReadonlyArray<{
    id: string
    order: number
    label: string
    component: () => JSX.Element
  }> = [
    { id: 'starhub-ai', order: 30, label: 'AI 助手', component: () => createElement(AiTab, { api: connection.api }) },
    { id: 'starhub-plugins', order: 31, label: '插件市场', component: PluginsTab },
    { id: 'starhub-audit', order: 32, label: '审计日志', component: AuditTab },
    { id: 'starhub-alert', order: 33, label: '告警规则', component: AlertTab },
    { id: 'starhub-sandbox', order: 34, label: '沙箱平台', component: SandboxSettingsTab },
    { id: 'starhub-android', order: 35, label: 'Android 设备', component: AndroidSettingsTab },
    { id: 'starhub-about', order: 36, label: '关于', component: AboutTab },
  ]
  for (const tab of starhubTabs) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: tab.id,
      order: tab.order,
      label: tab.label,
    }, tab.component))
  }
  // 设置「打开配置文件」(壳内编辑,插件形式):dsh 上游默认把配置文件交原生
  // 打开器(外跳);这里由 StarHub 注册 settings.action(先于上游 order,
  // 用 order -1 置顶),读取 settings.yaml 路径后经 starhubFileViewer 在壳内
  // 打开(支持编辑保存)。仅桌面端(Tauri IPC)可用;浏览器预览静默降级。
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'starhub-open-config',
    order: -1,
    inject: () => ({
      openInShell: (target) => { fileViewer.open(target) },
      sessionId: sessions.list.getSnapshot().current,
    }),
  }, OpenConfigAction))
}
