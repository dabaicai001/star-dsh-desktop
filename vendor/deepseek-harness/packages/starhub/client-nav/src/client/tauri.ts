/**
 * StarHub client-nav 的宿主桥 IPC seam(去 Tauri 化 M2)。
 *
 * 桌面端不再是 Tauri 壳:React 工作台由 `starhub-bridge` 插件经同源 HTTP
 * 服务暴露同一套命令面——
 * - `POST /starhub/api/invoke`,body `{cmd, args}`,返回
 *   `{ok:true,result}` / `{ok:false,error}`(bridge 把 cmd 加成 `ui.<cmd>`
 *   前缀打给 sidecar);
 * - `GET /starhub/api/events` 是 SSE 流,每条通知以原始事件名作 SSE
 *   `event:` 字段,`data:` 是 JSON。
 *
 * 本文件是这一切换点,导出名与签名一个都没改,所以工作台全部 113 个调用点
 * 零改动:浏览器预览(无宿主可达)时 invoke reject、listen 退化为 no-op,
 * 与旧 Tauri internals 缺失时的降级语义一致。
 */

/** `POST /starhub/api/invoke` 的响应信封(bridge 插件契约)。 */
type InvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/** invoke 端点(同源,由 starhub-bridge 插件挂载)。 */
const INVOKE_URL = '/starhub/api/invoke'

/** SSE 事件流端点(同源;每条通知的 SSE event 字段即原始事件名)。 */
const EVENTS_URL = '/starhub/api/events'

/**
 * 调一条宿主桥命令(旧 Tauri IPC 的替换,签名不变)。
 * @param cmd - 命令名(bridge 会加 `ui.` 前缀打给 sidecar)。
 * @param args - 命令参数(camelCase 键);缺省时请求体不带 args 键。
 * @returns 命令结果。
 * @throws 响应为 `{ok:false,error}` 时以 error 消息 reject;非 2xx 响应
 *   (宿主桥未挂载/路由不存在)reject `host bridge unavailable (status)`。
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(INVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  })
  if (!response.ok) {
    throw new Error(`host bridge unavailable (${response.status})`)
  }
  const body = await response.json() as InvokeResponse
  if (!body.ok) throw new Error(body.error)
  return body.result as T
}

/** 事件名 → 该事件名的全部 handler(共享一条 SSE 连接的扇出表)。 */
const hostEventHandlers = new Map<string, Set<(payload: unknown) => void>>()

/** 已在该共享连接上 addEventListener 的事件名(重建连接时清空重绑)。 */
const hostEventBound = new Set<string>()

/** 共享 SSE 连接(首个订阅时惰性建立;连接关闭后由下次订阅重建)。 */
let hostEventSource: EventSource | null = null

/** 取得共享 SSE 连接;无 EventSource(裸浏览器预览)返回 null。 */
function ensureHostEventSource(): EventSource | null {
  if (typeof EventSource === 'undefined') return null
  if (hostEventSource !== null && hostEventSource.readyState !== EventSource.CLOSED) return hostEventSource
  hostEventSource = new EventSource(EVENTS_URL, { withCredentials: true })
  hostEventBound.clear()
  return hostEventSource
}

/** 把一条 SSE 通知的 JSON data 解析后扇出给该事件名的全部 handler。 */
function dispatchHostEvent(event: string, raw: MessageEvent<string>): void {
  let payload: unknown
  try {
    payload = JSON.parse(raw.data)
  } catch {
    return // 非 JSON 数据帧(心跳/注释帧)忽略
  }
  for (const handler of hostEventHandlers.get(event) ?? []) handler(payload)
}

/** Async disposer returned by an event subscription. */
export type TauriUnlisten = () => Promise<void>

/**
 * 订阅一条宿主事件(旧 Tauri event 插件 listen 的替换,签名不变):经共享
 * SSE 连接按事件名监听,解析 data 的 JSON 后扇出给该事件名的全部 handler。
 * @param event - 事件名(SSE `event:` 字段,如 `starhub://open-asset`)。
 * @param handler - 每条通知的 payload 回调,直到 dispose。
 * @returns disposer:把 handler 从扇出表移除(连接建立前调用同样生效);
 *   无 EventSource(裸浏览器预览)时为 no-op。
 */
// T is the subscription payload type, used exactly once in the handler
// signature — inherent to a listen API, so the single-use heuristic of
// no-unnecessary-type-parameters is a false positive here.
// eslint-disable-next-line typescript/no-unnecessary-type-parameters
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<TauriUnlisten> {
  const source = ensureHostEventSource()
  if (source === null) return () => Promise.resolve()
  let handlers = hostEventHandlers.get(event)
  if (handlers === undefined) {
    handlers = new Set()
    hostEventHandlers.set(event, handlers)
  }
  const wrapped = (payload: unknown): void => { handler(payload as T) }
  handlers.add(wrapped)
  const listener = (raw: MessageEvent): void => { dispatchHostEvent(event, raw as MessageEvent<string>) }
  if (!hostEventBound.has(event)) {
    hostEventBound.add(event)
    source.addEventListener(event, listener)
  }
  return async () => {
    handlers.delete(wrapped)
    // 该事件名最后一个 handler 退订:同步摘掉共享连接上的监听,订阅计数归零。
    if (handlers.size === 0 && hostEventBound.delete(event)) {
      source.removeEventListener(event, listener)
    }
  }
}

/**
 * Window-label prefix for one keyed StarHub page (`starhub-page-<key>-`).
 * The key (asset id for asset pages) lets a focus request identify an
 * already-opened page; kept for call-site compatibility after the Tauri
 * webview windows retired.
 * @param key - stable page identity (e.g. the asset id).
 * @returns the label prefix; the full label appends a timestamp.
 */
export function starhubPageLabelPrefix(key: string): string {
  return `starhub-page-${key}-`
}

/**
 * 壳内工作台页宿主(去 Tauri 化 M2 第 6 步):装了宿主就把「开新窗口」改为
 * 「开主壳内的面板页」(见 `workbench-panel.ts` / `StarHubWorkbenchPanel.tsx`);
 * 没装(浏览器预览 / 单测)时保持 `window.open` 的老行为。
 * 由 client-nav 的 apply 经 `installWorkbenchPageHost` 安装、`ctx.effect`
 * 卸载时摘除(HMR 安全)。
 */
export type WorkbenchPageHost = (path: string, title: string, key: string) => void

let workbenchPageHost: WorkbenchPageHost | null = null

/**
 * Install (or clear) the in-shell workbench page host.
 * @param host - the host that opens a panel page; null restores the
 *   `window.open` fallback (preview / tests).
 */
export function installWorkbenchPageHost(host: WorkbenchPageHost | null): void {
  workbenchPageHost = host
}

/**
 * Open a StarHub page: in the dsh desktop shell the standalone React
 * workbench lives in an in-shell main panel (one tab per asset instance), so
 * the installed host opens/activates a panel page instead of a new window.
 * Without a host (browser preview) it falls back to a same-origin new tab.
 * @param path - same-origin page path (absolute path, not full URL).
 * @param title - page title (asset name; the panel tab label).
 * @param key - stable page identity (asset id); an already-open key focuses
 *   the existing page instead of opening a second one.
 * @returns after the page has been opened (or focused).
 * @throws when no host is installed and window.open is intercepted (popup
 *   blocked) — a failed open must surface, not quietly do nothing.
 */
export async function openNewPage(path: string, title = '', key = ''): Promise<void> {
  if (workbenchPageHost !== null) {
    workbenchPageHost(path, title, key)
    return
  }
  const opened = window.open(new URL(path, window.location.origin), '_blank', 'noopener')
  if (opened === null) {
    throw new Error('window.open intercepted (popup blocked)')
  }
}

/**
 * Focus an already-opened keyed StarHub page, best-effort: broadcasts the
 * page key on the same-origin `starhub-focus` channel, where the opened
 * page raises itself. Any failure (no BroadcastChannel, broadcast error)
 * reports false so the caller falls back to opening the page.
 * @param key - the page identity embedded at open time (asset id).
 * @returns true when the focus broadcast was posted; false in preview, or
 *   when the broadcast fails.
 */
export async function focusWindowByKey(key: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return false
  try {
    const channel = new BroadcastChannel('starhub-focus')
    channel.postMessage({ key })
    channel.close()
    return true
  } catch {
    // 广播失败(如通道被占用):按「无可聚焦页面」处理,由调用方回退打开页面。
    return false
  }
}

/**
 * Whether a host bridge is reachable (the de-Tauri replacement for the old
 * `__TAURI_INTERNALS__` presence check): the workbench always runs inside a
 * browser-like realm with fetch, so this reports whether the host bridge
 * HTTP surface can be reached at all.
 * @returns true when running inside a host with fetch available.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && typeof fetch === 'function'
}
