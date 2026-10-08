/**
 * StarHub bridge compatibility layer (去 Tauri 化 M1;StarHub-local package).
 *
 * The nine StarHub plugins speak one host protocol over the `sdk-transport`
 * service: JSON-RPC methods `starhub/tool.execute` / `starhub/bind.asset` /
 * `starhub/open.asset` / `starhub/focus.tool` / `starhub/live.snapshot`. This
 * module implements that protocol against the Rust sidecar, so the plugins'
 * TypeScript surface stays byte-identical to what the retired Tauri host
 * answered.
 *
 * Method mapping (M1 command inventory, docs/去Tauri化-M1-命令映射清单.md):
 *
 * | bridge method | sidecar method | result |
 * |---|---|---|
 * | `starhub/tool.execute {sessionId,name,args}` | `name` with `args` (plus the injected `sessionId`) | model-readable text |
 * | `starhub/bind.asset {assetId,sessionId}` | `bind_asset_context` | `{ok,action:"bound"}` |
 * | `starhub/open.asset {assetId,tool?,sessionId}` | `starhub/open.asset` | `{ok,action}` |
 * | `starhub/focus.tool {assetId,tool,sessionId}` | `starhub/focus.tool` | `{ok,action}` |
 * | `starhub/live.snapshot` | `starhub/live.snapshot` | snapshot object |
 *
 * The sidecar reports tool results as `{ text }` (one shape for every domain);
 * the legacy host returned a bare string, so the text is unwrapped here — the
 * string is the model-facing contract and must not drift.
 *
 * @module @deepseek-ai/dsh-starhub-bridge/compat
 */

import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

/** Bridge method the `starhub-tools` plugin sends for every domain tool. */
export const TOOL_EXECUTE_METHOD = 'starhub/tool.execute'
/** Bridge method for binding a session to an asset without opening UI. */
export const BIND_ASSET_METHOD = 'starhub/bind.asset'
/** Bridge method for the open/focus workbench UI action (契约 §2.2). */
export const OPEN_ASSET_METHOD = 'starhub/open.asset'
/** Bridge method for focusing a specific tool panel (契约 §2.2). */
export const FOCUS_TOOL_METHOD = 'starhub/focus.tool'
/** Bridge method pulling the live snapshot for pre-step context (契约 §2.2). */
export const LIVE_SNAPSHOT_METHOD = 'starhub/live.snapshot'
/** Bridge method the approval answerer used; dsh's own approval UI replaces it. */
export const APPROVAL_REQUEST_METHOD = 'starhub/approval.request'

/**
 * Service name the nine StarHub plugins read for the host bridge.
 *
 * It is the private name the retired `sdk-jsonrpc-server` patch provided in
 * the Tauri composition; the bridge provides the same name in the standalone
 * composition so no plugin changes. Only one of the two may be loaded —
 * providing it twice fails loud at plugin load (duplicate service).
 */
export const BRIDGE_TRANSPORT_SERVICE = 'sdk-transport'

/** Service name for the inbound notification hub (`starhub/domain.event`, …). */
export const BRIDGE_NOTIFICATIONS_SERVICE = 'sdk-notifications'

/** Notification method the sidecar wraps every domain/bridge event in. */
const DOMAIN_EVENT_NOTIFICATION = 'starhub/domain-event'

/** Notification the bridge sends downstream to abort an in-flight exec. */
export const EXEC_ABORT_METHOD = 'starhub/exec.abort'

/** One inbound notification subscription (mirrors `SdkNotificationHub`). */
export interface NotificationHub {
  /**
   * Subscribe to one notification method.
   * @param method - notification method name (e.g. `starhub/domain.event`).
   * @param handler - invoked per notification with the normalized params.
   * @returns disposer removing the subscription.
   */
  subscribe(method: string, handler: (params: object) => void): () => void
}

/** Unwrap a sidecar tool result into the model-readable text string. */
export function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const text = (value as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  throw new Error('starhub host returned a non-string result')
}

/** Normalize an unknown thrown value to a message string. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bridge method → sidecar method for the non-tool linkage calls.
 *
 * `starhub/bind.asset` is the one renamed pair: the plugin-facing method is
 * the UI-action vocabulary, the sidecar method is the tool-surface name.
 */
const LINKAGE_METHODS: ReadonlyMap<string, string> = new Map([
  [BIND_ASSET_METHOD, 'bind_asset_context'],
  [OPEN_ASSET_METHOD, OPEN_ASSET_METHOD],
  [FOCUS_TOOL_METHOD, FOCUS_TOOL_METHOD],
  [LIVE_SNAPSHOT_METHOD, LIVE_SNAPSHOT_METHOD],
])

/**
 * Build the host-bridge peer the nine plugins consume.
 *
 * @param sidecar - live sidecar transport (JSON-RPC over the sidecar's stdio).
 * @returns a `JsonRpcTransportPeer` answering the StarHub bridge protocol.
 */
export function createBridgePeer(sidecar: JsonRpcTransportPeer): JsonRpcTransportPeer {
  return {
    async request(method: string, params: object): Promise<unknown> {
      const record = (params ?? {}) as Record<string, unknown>
      switch (method) {
        case TOOL_EXECUTE_METHOD: {
          const name = typeof record.name === 'string' ? record.name : ''
          if (name === '') throw new Error(`${TOOL_EXECUTE_METHOD} 缺少 name`)
          // 兼容层核心:方法名 = 工具名,参数原样直调 sidecar。
          // sessionId 从桥信封注入参数:sidecar 的资产解析(显式 assetId 优先,
          // 否则沿会话绑定 / subagent 父链)读的就是它——旧宿主是用信封里的
          // session_id 直接解析,不经过工具参数。
          const args = {
            ...(typeof record.args === 'object' && record.args !== null ? record.args : {}),
            ...(typeof record.sessionId === 'string' && record.sessionId !== ''
              ? { sessionId: record.sessionId }
              : {}),
          } as object
          return toolResultText(await sidecar.request(name, args))
        }
        default: {
          // 联动四方法:bind.asset 改名 bind_asset_context,其余同名直调。
          const sidecarMethod = LINKAGE_METHODS.get(method)
          if (sidecarMethod !== undefined) return sidecar.request(sidecarMethod, params)
          if (method === APPROVAL_REQUEST_METHOD) {
            // 审批应答由 dsh 自己的 approval UI 承担(answerer: false 的组合不会
            // 走到这里);真被调用说明组合配错, fail loud 而不是假应答。
            throw new Error(
              'starhub-bridge does not answer starhub/approval.request; '
              + 'compose starhub-approval-bridge with answerer: false',
            )
          }
          throw new Error(`unknown StarHub bridge method: ${method}`)
        }
      }
    },
    notify(method: string, params?: object): void {
      if (method === EXEC_ABORT_METHOD) {
        // 停止生成:把中断信号下行给 sidecar(通知形态,不等应答)。
        sidecar.notify(EXEC_ABORT_METHOD, params ?? {})
        return
      }
      // 其余出站通知在旧宿主里是 Rust → dsh 方向,插件从不发送。
    },
  }
}

/** Minimal transport surface the dispatcher needs to observe notifications. */
export interface NotificationCapableTransport {
  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and params.
   */
  onNotification(handler: (method: string, params: object) => void): void
}

/**
 * Fan the sidecar's wrapped event notifications out to plugin subscriptions.
 *
 * The sidecar emits every event as one `starhub/domain-event` notification
 * carrying `{ event, payload }`; subscribers key on the inner `event` name
 * (`starhub/domain.event`, `starhub/registry.sync`, `ssh:exec-done`, …), which
 * is exactly the method name the retired host used.
 */
export class NotificationDispatcher implements NotificationHub {
  private readonly handlers = new Map<string, Set<(params: object) => void>>()
  private wildcards: Set<(event: string, params: object) => void> | undefined

  /** Dispatch one sidecar notification to its subscribers. */
  dispatch(method: string, params: unknown): void {
    const payload = (typeof params === 'object' && params !== null ? params : {}) as object
    const subscribers = this.handlers.get(method)
    if (subscribers !== undefined) {
      for (const handler of [...subscribers]) {
        this.invoke(() => { handler(payload) }, method)
      }
    }
    if (this.wildcards !== undefined) {
      for (const broadcast of [...this.wildcards]) {
        this.invoke(() => { broadcast(method, payload) }, method)
      }
    }
  }

  /** Run one subscriber, isolating its failure from the other subscribers. */
  private invoke(handler: () => void, method: string): void {
    try {
      handler()
    } catch (error) {
      console.error(`starhub-bridge: notification handler for ${method} failed: ${message(error)}`)
    }
  }

  /** @inheritdoc */
  subscribe(method: string, handler: (params: object) => void): () => void {
    let subscribers = this.handlers.get(method)
    if (subscribers === undefined) {
      subscribers = new Set()
      this.handlers.set(method, subscribers)
    }
    subscribers.add(handler)
    return () => {
      subscribers?.delete(handler)
      if (subscribers !== undefined && subscribers.size === 0) this.handlers.delete(method)
    }
  }

  /**
   * Subscribe to every notification (used by the workbench SSE stream, which
   * forwards events under their original names instead of filtering them).
   * @param broadcast - invoked per notification with the event name and params.
   * @returns disposer removing the subscription.
   */
  subscribeAll(broadcast: (event: string, params: object) => void): () => void {
    let subscribers = this.wildcards
    if (subscribers === undefined) {
      subscribers = new Set()
      this.wildcards = subscribers
    }
    subscribers.add(broadcast)
    return () => {
      subscribers?.delete(broadcast)
      if (subscribers !== undefined && subscribers.size === 0) this.wildcards = undefined
    }
  }

  /**
   * Install the dispatcher on a sidecar transport's notification channel.
   * @param sidecar - transport whose notifications carry `{event, payload}`.
   */
  attach(sidecar: NotificationCapableTransport): void {
    sidecar.onNotification((method: string, params: object) => {
      if (method !== DOMAIN_EVENT_NOTIFICATION) return
      const record = params as Record<string, unknown>
      const event = record.event
      if (typeof event !== 'string' || event === '') return
      this.dispatch(event, record.payload)
    })
  }
}
