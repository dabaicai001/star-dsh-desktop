/**
 * SSH AI 助手的宿主桥客户端(与 tauri.ts 同一套同源 HTTP/SSE 桥)。
 *
 * 助手面板是壳内工作台的普通 React 应用(没有 dsh client runtime),所有交互
 * 走 `/starhub/api/assistant/*`:POST 路由用 `{ok, result|error}` 信封,SSE
 * 流按帧 `t` 判别式折叠进消息列表。会话事件(user/message、assistant/message、
 * tool/call、tool/result)从助手会话的 durable log 原样转发——与 dsh GUI 的
 * 事件源渲染同范式,面板不自己造第二份真相。
 *
 * @module StarHub SSH assistant service (client)
 */

/** 助手路由前缀(与宿主插件 routes.ts 一致)。 */
const ASSISTANT_API = '/starhub/api/assistant'

/** invoke 路由的响应信封(bridge 契约)。 */
type InvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/** 模型目录里的一個模型行。 */
export interface AssistantModelOption {
  id: string
  name: string
}

/** 模型目录里的一个 provider 行。 */
export interface AssistantProviderOption {
  provider: string
  displayName: string
  models: AssistantModelOption[]
}

/** 面板模型选择器的目录。 */
export interface AssistantCatalog {
  providers: AssistantProviderOption[]
}

/** open 路由结果。 */
export interface AssistantOpenResult {
  assistantId: string
  provider: string
  model: string
  reused: boolean
}

/** 助手会话事件(durable log 转发的窄形状)。 */
export interface AssistantSessionEvent {
  type: string
  data: Record<string, unknown>
}

/** SSE 流上的一条帧(与宿主 frames.ts 逐字对齐)。 */
export type AssistantFrame =
  | { t: 'status'; status: 'idle' | 'running' }
  | { t: 'event'; event: AssistantSessionEvent }
  | { t: 'approval'; requestId: string; toolName: string; callId?: string; reason?: string }
  | { t: 'model'; provider: string; model: string }
  | { t: 'closed' }
  | { t: 'error'; message: string }

/** 面板可提交的审批结论。 */
export type AssistantApprovalOutcome = 'allowed-once' | 'rejected'

/** 解析 invoke 信封:非 2xx 或 ok:false 一律 reject(与 tauriInvoke 同语义)。 */
async function readEnvelope(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`host bridge unavailable (${response.status})`)
  }
  const body = await response.json() as InvokeResponse
  if (!body.ok) throw new Error(body.error)
  return body.result
}

/** POST 一条助手命令。 */
async function postCommand(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${ASSISTANT_API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readEnvelope(response)
}

/**
 * 打开(或复用)一个终端页的助手会话。
 * @param input - 终端会话 id 与绑定资产身份。
 * @returns assistantId 与当前生效的模型路由。
 */
export async function openAssistant(input: {
  sshSessionId: string
  assetId: string
  assetName: string
}): Promise<AssistantOpenResult> {
  return await postCommand('open', input) as AssistantOpenResult
}

/**
 * 提交一条用户提问(排进助手的下一个回合)。
 * @param assistantId - 助手会话 id。
 * @param text - 提问文本。
 */
export async function promptAssistant(assistantId: string, text: string): Promise<void> {
  await postCommand('prompt', { assistantId, text })
}

/**
 * 中断助手当前回合(排队中的输入保留)。
 * @param assistantId - 助手会话 id。
 */
export async function stopAssistant(assistantId: string): Promise<void> {
  await postCommand('stop', { assistantId })
}

/**
 * 关闭助手会话(销毁 agent 与 session)。
 * @param assistantId - 助手会话 id。
 */
export async function closeAssistant(assistantId: string): Promise<void> {
  await postCommand('close', { assistantId })
}

/**
 * 切换助手的模型路由(后续请求生效)。
 * @param assistantId - 助手会话 id。
 * @param provider - provider 路由 key。
 * @param model - 模型 id。
 */
export async function setAssistantModel(
  assistantId: string,
  provider: string,
  model: string,
): Promise<void> {
  await postCommand('model', { assistantId, provider, model })
}

/**
 * 结算一个挂起的审批请求。
 * @param assistantId - 助手会话 id。
 * @param requestId - 审批请求 id。
 * @param outcome - 允许一次 / 拒绝。
 */
export async function submitAssistantApproval(
  assistantId: string,
  requestId: string,
  outcome: AssistantApprovalOutcome,
): Promise<void> {
  await postCommand('approval', { assistantId, requestId, outcome })
}

/** 拉取模型目录(面板选择器用)。 */
export async function fetchAssistantCatalog(): Promise<AssistantCatalog> {
  const response = await fetch(`${ASSISTANT_API}/models`)
  return await readEnvelope(response) as AssistantCatalog
}

/** 解析一条 SSE data 帧;非法payload返回 null(心跳/注释帧忽略)。 */
function parseFrame(raw: MessageEvent<string>): AssistantFrame | null {
  try {
    const value: unknown = JSON.parse(raw.data)
    if (typeof value !== 'object' || value === null) return null
    const frame = value as AssistantFrame
    return typeof frame.t === 'string' ? frame : null
  } catch {
    return null
  }
}

/**
 * 订阅助手 SSE 流。
 * @param assistantId - 助手会话 id。
 * @param handlers - 帧回调与流中断回调(浏览器重连失败/响应非 SSE 时触发)。
 * @returns 退订函数(关闭 EventSource)。
 */
export function subscribeAssistant(
  assistantId: string,
  handlers: { onFrame: (frame: AssistantFrame) => void; onDrop: () => void },
): () => void {
  if (typeof EventSource === 'undefined') {
    handlers.onDrop()
    return () => undefined
  }
  const source = new EventSource(`${ASSISTANT_API}/stream?assistantId=${encodeURIComponent(assistantId)}`, {
    withCredentials: true,
  })
  const listener = (raw: MessageEvent): void => {
    const frame = parseFrame(raw as MessageEvent<string>)
    if (frame !== null) handlers.onFrame(frame)
  }
  source.addEventListener('starhub-assistant', listener)
  source.addEventListener('error', () => {
    // EventSource 会自行重连;只有彻底关闭(路由 404/会话已销毁)才需要
    // 告知面板,由面板展示重开入口。
    if (source.readyState === EventSource.CLOSED) handlers.onDrop()
  })
  return () => {
    source.removeEventListener('starhub-assistant', listener)
    source.close()
  }
}
