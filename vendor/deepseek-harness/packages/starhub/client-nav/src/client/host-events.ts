/**
 * Tauri 宿主事件监听(契约 §3 / §6.2-6.3):`starhub://open-asset`(AI 打开/
 * 聚焦资产窗口)与 `starhub://ask-ai`(面板「问 AI」prefill 壳内会话)。
 * 事件由 Rust 主进程 emit_to("main") 投递;本模块把 payload 翻译成壳内
 * openAssetPage / 会话聚焦 + composer prefill,经 ctx.effect 注册、dispose
 * 卸载(HMR 安全)。
 */
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import { tauriListen, type TauriUnlisten } from './tauri.ts'
import type { StarHubAsset } from './sections.ts'
import type { StarHubAssets, ToolSelectionBridge } from './store.ts'
import { bindAssetContext } from './tool-context.ts'

/** `starhub://open-asset` payload(契约 §3):tool 缺省 auto,action 由 Rust 注册表预判。 */
export interface OpenAssetPayload {
  readonly assetId: string
  readonly tool?: string
  readonly action: 'open' | 'focus'
}

/** `starhub://ask-ai` payload(契约 §3):assetId/assetName 可选。 */
export interface AskAiPayload {
  readonly text: string
  readonly assetId?: string
  readonly assetName?: string
}

/** open-asset 处理器依赖:资产快照 + 开窗回调 + 聚焦实现。 */
export interface OpenAssetDeps {
  assets: StarHubAssets
  /** 打开资产操作页(按资产类型路由,一律新开独立窗口)。 */
  openAssetPage: (asset: StarHubAsset) => void
  /** 按 key 聚焦已开的 webview 窗口;找不到/不可聚焦返回 false(可注入以便测试)。 */
  focusWindow: (key: string) => Promise<boolean>
}

/**
 * Create the `starhub://open-asset` handler: focus the asset's keyed webview
 * window when the shell already has one, else open the asset page(契约 §6.2)。
 * @param deps - asset snapshot, open/focus faces.
 * @returns the event payload handler.
 */
export function createOpenAssetHandler(deps: OpenAssetDeps): (payload: OpenAssetPayload) => void {
  return (payload) => {
    const asset = deps.assets.source.getSnapshot().assets.find(a => a.id === payload.assetId)
    if (asset === undefined) {
      // 快照里没有该资产(可能列表尚未拉取):触发一次刷新并丢弃本请求——
      // Rust 侧 fire-and-forget,后续 focus 会重试,不因缺失资产误开窗口。
      deps.assets.refresh()
      return
    }
    if (payload.action === 'focus') {
      void deps.focusWindow(payload.assetId).then((focused) => {
        if (!focused) deps.openAssetPage(asset)
      })
      return
    }
    deps.openAssetPage(asset)
  }
}

/** ask-ai 处理器依赖:settings 面 + 选择桥 + 会话/工作区/会话输入服务。 */
export interface AskAiDeps {
  api: IApiClient
  selection: ToolSelectionBridge
  sessions: ISessions
  workspaces: IWorkspaces
  /** 会话输入注册表;ui-conversation 未装载时为 undefined(prefill 退化为仅聚焦)。 */
  conversation: IConversation | undefined
}

/**
 * Create the `starhub://ask-ai` handler: focus the current shell session
 * (or connect/create a workspace blank session) and prefill its composer
 * with the panel's text; an asset reference in the payload light-binds the
 * tool context on the same settings channel as the `@` pick (契约 §6.3).
 * @param deps - settings face, selection bridge and session services.
 * @returns the event payload handler.
 */
export function createAskAiHandler(deps: AskAiDeps): (payload: AskAiPayload) => void {
  return (payload) => {
    if (payload.assetId !== undefined) {
      // 取当前会话 id 作作用域:host 侧 tool-context 只对触发绑定(ask-ai)
      // 的会话注入,避免全局粘性扩散到普通对话。
      const current = deps.sessions.list.getSnapshot().current
      bindAssetContext(deps.api, deps.selection.source.getSnapshot(), {
        id: payload.assetId,
        name: payload.assetName ?? '',
      }, current ?? '')
    }
    void routeAskAi(payload.text, deps.sessions, deps.workspaces, deps.conversation)
  }
}

/** 聚焦(或新建)会话并 prefill composer;失败只记日志,不打断面板。 */
async function routeAskAi(
  text: string,
  sessions: ISessions,
  workspaces: IWorkspaces,
  conversation: IConversation | undefined,
): Promise<void> {
  const current = sessions.list.getSnapshot().current
  if (current !== undefined) {
    // 优先聚焦已有会话:先写 draft 再重新选中(open 幂等)。
    setDraft(sessions, conversation, current, text)
    sessions.open(current)
    return
  }
  const target = workspaces.list.getSnapshot().recentWorkspaceId
  if (target === undefined) {
    // 没有任何工作区:清空选择落到新建会话视图,由用户自行开始。
    sessions.clear()
    return
  }
  try {
    // connectWorkspace 的解析保证:返回的 id 已在 list 且 binding 可同步
    // 解析——先写 draft 再 open,新会话的 composer 在打开前就拿到文本。
    const sessionId = await workspaces.connectWorkspace(target)
    setDraft(sessions, conversation, sessionId, text)
    sessions.open(sessionId)
  } catch (error) {
    console.warn('starhub://ask-ai 新建会话失败:', error)
  }
}

/**
 * 聚焦(或新建)壳内 AI 会话,不携带 prefill 文本——右侧工作区列的
 * 「AI 助手」入口用;与 ask-ai 共享同一聚焦逻辑(空文本 = 只聚焦不预填)。
 * @param sessions - 会话列表服务。
 * @param workspaces - 工作区服务。
 * @param conversation - 会话输入注册表;未装载时退化为仅聚焦。
 */
export function focusShellConversation(
  sessions: ISessions,
  workspaces: IWorkspaces,
  conversation: IConversation | undefined,
): void {
  void routeAskAi('', sessions, workspaces, conversation)
}

/** 把文本写进目标会话的 composer(binding 按需物化 scope;无输入服务则跳过)。 */
function setDraft(
  sessions: ISessions,
  conversation: IConversation | undefined,
  sessionId: SessionId,
  text: string,
): void {
  if (conversation === undefined) return
  const binding = sessions.binding(sessionId)
  if (binding === undefined) return
  conversation.input.for(binding.ctx).setDraft(text)
}

/**
 * Subscribe both host events; the returned disposer unlistens from the Tauri
 * event plugin (also covers the async listen race: an unlisten resolving
 * after disposal is invoked immediately).
 * @param handlers - the two payload handlers.
 * @returns the disposer (wire via ctx.effect for HMR-safe teardown).
 */
export function subscribeHostEvents(handlers: {
  onOpenAsset: (payload: OpenAssetPayload) => void
  onAskAi: (payload: AskAiPayload) => void
}): () => void {
  let disposed = false
  const offs: TauriUnlisten[] = []
  void tauriListen<OpenAssetPayload>('starhub://open-asset', handlers.onOpenAsset).then((off) => {
    if (disposed) void off()
    else offs.push(off)
  })
  void tauriListen<AskAiPayload>('starhub://ask-ai', handlers.onAskAi).then((off) => {
    if (disposed) void off()
    else offs.push(off)
  })
  return () => {
    disposed = true
    for (const off of offs) void off()
  }
}
