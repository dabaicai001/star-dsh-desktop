/**
 * 宿主桥测试替身(去 Tauri 化 M2):替代旧的 `window.__TAURI_INTERNALS__`
 * stub,服务 client-nav 全部 spec。
 *
 * - `stubHostBridge(handler)` 替换 globalThis.fetch(及 window.fetch,若存在),
 *   只应答 `POST /starhub/api/invoke`:读 body JSON 取 `{cmd, args}` 记入
 *   `hostBridgeCalls()`,handler resolve → `{ok:true,result}`(200),
 *   reject/throw → `{ok:false,error:message}`(200),URL 不匹配 → 404;
 * - `stubHostEvents()` 装一个假 EventSource,`emitHostEvent(event, payload)`
 *   同步派发 `data = JSON.stringify(payload)` 的原始通知,驱动生产代码
 *   (tauri.ts)按事件名注册的监听扇出;`hostEventListeners(event)` 回报该
 *   事件名上的监听数(替代旧 `plugin:event|listen` 断言)。
 *
 * 成对使用:afterEach/beforeEach 里 `restoreHostBridge()` +
 * `restoreHostEvents()`;每个用例最多装一次事件替身(重复装会断开上一轮
 * 生产代码已绑定的连接)。
 */

/** 一次宿主桥 invoke 调用记录(测试断言用)。 */
export interface HostBridgeCall {
  cmd: string
  args: Record<string, unknown>
}

/** stubHostBridge 安装的处理器:每个 POST /starhub/api/invoke 调用一次。 */
export type HostBridgeHandler = (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>

/** 假 SSE 连接的原始事件面(生产代码只读 data)。 */
interface HostEventRaw {
  data: string
  lastEventId: string
}

/** 假 EventSource 的监听签名。 */
type HostEventListener = (raw: HostEventRaw) => void

/**
 * fetch 替身可替换的全局面。
 *
 * `| undefined` 不能省:`exactOptionalPropertyTypes: true` 下 `fetch?: X` 表示
 * 「可以不存在,但存在就必须是 X」,而还原路径要把 `X | undefined` 的存盘值写回去。
 */
type FetchGlobal = { fetch?: typeof globalThis.fetch | undefined }

/** invoke 端点路径(生产代码 tauri.ts 的同源常量)。 */
const INVOKE_PATH = '/starhub/api/invoke'

let savedGlobalFetch: typeof globalThis.fetch | undefined
let savedWindowFetch: typeof globalThis.fetch | undefined
let windowHadFetch = false
let bridgeStubbed = false
let handler: HostBridgeHandler | null = null
const calls: HostBridgeCall[] = []

/** 记录值是否为普通对象(JSON 对象形态的 args)。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 构造 JSON 响应;无 Response 构造器时手搓生产代码只用到的 ok/status/json 面。 */
function jsonResponse(body: unknown, status: number): Response {
  const text = JSON.stringify(body)
  if (typeof Response === 'function') {
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) } as unknown as Response
}

/** fetch 替身:只应答 POST /starhub/api/invoke,其余请求 404。 */
async function bridgeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = (init?.method ?? 'GET').toUpperCase()
  if (handler === null || !url.endsWith(INVOKE_PATH) || method !== 'POST') {
    return jsonResponse({ ok: false, error: `host bridge stub: unmatched ${method} ${url}` }, 404)
  }
  const text = typeof init?.body === 'string' ? init.body : ''
  const parsed = JSON.parse(text) as { cmd?: unknown; args?: unknown }
  const cmd = typeof parsed.cmd === 'string' ? parsed.cmd : ''
  const args = isRecord(parsed.args) ? parsed.args : {}
  calls.push({ cmd, args })
  try {
    return jsonResponse({ ok: true, result: await handler(cmd, args) }, 200)
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 200)
  }
}

/**
 * 安装宿主桥 invoke 替身(替换 fetch),并重置调用记录表。
 * @param next - 每个 invoke 调用的处理器;resolve 值即命令结果,
 *   reject/throw 的消息即 `{ok:false,error}`。
 */
export function stubHostBridge(next: HostBridgeHandler): void {
  handler = next
  calls.length = 0
  bridgeStubbed = true
  // 先取两个面的原值再写入:jsdom 下 window 与 globalThis 是同一对象,
  // 写后再读只会读到替身本身。
  savedGlobalFetch = (globalThis as FetchGlobal).fetch
  savedWindowFetch = typeof window === 'undefined' ? undefined : (window as FetchGlobal).fetch
  windowHadFetch = typeof window !== 'undefined' && 'fetch' in (window as FetchGlobal)
  ;(globalThis as FetchGlobal).fetch = bridgeFetch as typeof globalThis.fetch
  if (typeof window !== 'undefined' && (window as FetchGlobal) !== (globalThis as FetchGlobal)) {
    ;(window as FetchGlobal).fetch = bridgeFetch as typeof globalThis.fetch
  }
}

/** 还原 fetch(globalThis 与 window 两个面),卸下处理器。 */
export function restoreHostBridge(): void {
  if (!bridgeStubbed) return
  bridgeStubbed = false
  handler = null
  const g = globalThis as FetchGlobal
  if (savedGlobalFetch !== undefined) g.fetch = savedGlobalFetch
  else Reflect.deleteProperty(g, 'fetch')
  if (typeof window !== 'undefined' && (window as FetchGlobal) !== g) {
    const w = window as FetchGlobal
    if (windowHadFetch) w.fetch = savedWindowFetch
    else Reflect.deleteProperty(w, 'fetch')
  }
}

/**
 * 取得当前替身记录到的全部 invoke 调用(副本,按调用顺序)。
 * @returns `{cmd, args}` 记录表;缺省 args 的命令记为 `{}`(线上请求体
 *   同样不带 args 键)。
 */
export function hostBridgeCalls(): HostBridgeCall[] {
  return calls.map(call => ({ cmd: call.cmd, args: call.args }))
}

/** EventSource 替身可替换的全局面(同 FetchGlobal 的 `| undefined` 理由)。 */
type EventSourceGlobal = { EventSource?: typeof globalThis.EventSource | undefined }

/** 假 SSE 连接:记录 addEventListener 的监听,close() 后 readyState 置 CLOSED。 */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly url: string
  readonly withCredentials: boolean
  readyState = FakeEventSource.OPEN

  private readonly listeners = new Map<string, Set<HostEventListener>>()

  constructor(url: string | URL, init?: { withCredentials?: boolean }) {
    this.url = typeof url === 'string' ? url : url.toString()
    this.withCredentials = init?.withCredentials === true
    fakeSources.push(this)
  }

  addEventListener(name: string, fn: HostEventListener): void {
    let set = this.listeners.get(name)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(fn)
  }

  removeEventListener(name: string, fn: HostEventListener): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }

  /** 测试替身内部:该事件名上已注册的监听数。 */
  listenerCount(name: string): number {
    return this.listeners.get(name)?.size ?? 0
  }

  /** 测试替身内部:向该事件名的全部监听同步派发一条原始通知。 */
  emit(name: string, raw: HostEventRaw): void {
    for (const fn of this.listeners.get(name) ?? []) fn(raw)
  }
}

/** 当前替身会话内生产代码创建的假连接(重建后旧连接即断开)。 */
let fakeSources: FakeEventSource[] = []
let savedGlobalEventSource: typeof globalThis.EventSource | undefined
let savedWindowEventSource: typeof globalThis.EventSource | undefined
let windowHadEventSource = false
let eventsStubbed = false

/** 关闭并清空当前替身会话的全部假连接。 */
function closeFakeSources(): void {
  for (const source of fakeSources) source.close()
  fakeSources = []
}

/**
 * 安装假 EventSource(替换 globalThis.EventSource 与 window.EventSource,
 * 若存在),并断开上一轮替身会话的连接。
 */
export function stubHostEvents(): void {
  closeFakeSources()
  eventsStubbed = true
  // 同 stubHostBridge:先取原值再写入(window 与 globalThis 可能同一对象)。
  savedGlobalEventSource = (globalThis as EventSourceGlobal).EventSource
  savedWindowEventSource = typeof window === 'undefined' ? undefined : (window as EventSourceGlobal).EventSource
  windowHadEventSource = typeof window !== 'undefined' && 'EventSource' in (window as EventSourceGlobal)
  ;(globalThis as EventSourceGlobal).EventSource = FakeEventSource as unknown as typeof globalThis.EventSource
  if (typeof window !== 'undefined' && (window as EventSourceGlobal) !== (globalThis as EventSourceGlobal)) {
    ;(window as EventSourceGlobal).EventSource = FakeEventSource as unknown as typeof globalThis.EventSource
  }
}

/** 还原 EventSource 全局面,断开并清空全部假连接。 */
export function restoreHostEvents(): void {
  if (!eventsStubbed) return
  eventsStubbed = false
  closeFakeSources()
  const g = globalThis as EventSourceGlobal
  if (savedGlobalEventSource !== undefined) g.EventSource = savedGlobalEventSource
  else Reflect.deleteProperty(g, 'EventSource')
  if (typeof window !== 'undefined' && (window as EventSourceGlobal) !== g) {
    const w = window as EventSourceGlobal
    if (windowHadEventSource) w.EventSource = savedWindowEventSource
    else Reflect.deleteProperty(w, 'EventSource')
  }
}

/**
 * 经假 SSE 连接同步派发一条宿主事件:对生产代码在该事件名上注册的全部
 * 监听,以 `data = JSON.stringify(payload)`、`lastEventId = ''` 的原始
 * 通知触发(tauri.ts 解析 JSON 后扇出给 handler)。
 * @param event - 事件名(SSE `event:` 字段)。
 * @param payload - 事件负载(JSON 序列化后经 data 传递)。
 */
export function emitHostEvent(event: string, payload: unknown): void {
  const raw: HostEventRaw = { data: JSON.stringify(payload), lastEventId: '' }
  for (const source of fakeSources) source.emit(event, raw)
}

/**
 * 当前假连接上某事件名已注册的监听数——替代旧 `plugin:event|listen`
 * 断言:生产代码订阅即在该事件名上 addEventListener(等待订阅就绪后再
 * emit,避免事件早于订阅到达)。
 * @param event - 事件名。
 * @returns 监听数;未装事件替身或未订阅时为 0。
 */
export function hostEventListeners(event: string): number {
  let count = 0
  for (const source of fakeSources) count += source.listenerCount(event)
  return count
}
