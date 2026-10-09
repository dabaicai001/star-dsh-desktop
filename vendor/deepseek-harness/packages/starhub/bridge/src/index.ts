/**
 * StarHub sidecar bridge(去 Tauri 化 M1;StarHub 本地包,不在上游)。
 *
 * 迁移后的 StarHub 工具面执行端点:本插件在 dsh Host 进程内 spawn Rust
 * sidecar,经 stdio JSON-RPC(换行分帧,与 `JsonRpcLineTransport` 逐字节对齐)
 * 把 sidecar 方法面暴露给模型。旧 Tauri 壳的 `src-tauri/src/harness` 应答方
 * 整体退役后,`starhub-tools` 等 9 个插件的 `starhub/tool.execute` 桥由本插件
 * 承接——兼容层见 `compat.ts` 的 {@link createBridgePeer},9 插件的 TS 侧
 * 零改动。
 *
 * 本插件提供两个宿主私有服务(与 sdk-jsonrpc-server 在 Tauri 组合里提供的
 * 同名,二选一;重复提供会在加载期 fail loud):
 * - `sdk-transport`:桥 peer(`starhub/tool.execute` / `bind.asset` /
 *   `open.asset` / `focus.tool` / `live.snapshot` → sidecar 方法);
 * - `sdk-notifications`:入站通知 hub(sidecar 的 `starhub/domain-event` 按
 *   内层 event 名分发给 domain-events / session-registry 等订阅者)。
 *
 * 另挂工作台 API(`/starhub/api/invoke` + `/starhub/api/events` SSE):React
 * 工作台在独立组合里没有 Tauri IPC,这两条路由是它的调用/事件面(见
 * `workbench.ts`)。M3 再挂直播/接管帧通道(`/starhub/live` upgrade,见
 * `live.ts`):sidecar 的本地 WS 经本路由中继给壳内面板。
 *
 * @module @deepseek-ai/dsh-starhub-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: declares the `webServer` service on Context (route registration).
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  BRIDGE_NOTIFICATIONS_SERVICE,
  BRIDGE_TRANSPORT_SERVICE,
  createBridgePeer,
  NotificationDispatcher,
} from './compat.ts'
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_SIDECAR_COMMAND,
  errorMessage,
  spawnSidecar,
} from './transport.ts'
import { liveUpgradeHandler, LIVE_UPGRADE_ROUTE } from './live.ts'
import { eventsHandler, invokeHandler } from './workbench.ts'

export const name = 'starhub-bridge'
export const inject = ['tools', 'webServer']

/**
 * 插件配置。sidecarCommand 是部署变化项(可执行路径随打包布局而变),
 * 按上游「No hardcoded tunables」规约走 Config;healthTimeoutMs 是启动期
 * 健康探针预算,sidecar 起不来时 fail loud,不让每个工具调用重复失败。
 */
export const Config: z<{ sidecarCommand?: string[]; healthTimeoutMs?: number }> = z.object({
  sidecarCommand: z.array(z.string()).default([...DEFAULT_SIDECAR_COMMAND]),
  healthTimeoutMs: z.number().min(1000).default(DEFAULT_HEALTH_TIMEOUT_MS),
})

/** apply 收到的已解析配置(可选字段,缺省见 DEFAULT_* 常量)。 */
export interface BridgeConfig {
  sidecarCommand?: string[]
  healthTimeoutMs?: number
}

/** 工具输出:模型可读文本(与 starhub-tools 的 TEXT_OUTPUT 同形)。 */
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

interface TextOutput {
  text: string
}

const renderText = (_args: never, value: TextOutput): { type: 'text'; text: string }[] => [
  { type: 'text', text: value.text },
]

const TEXT_OUTPUT = { schema: TEXT_OUTPUT_SCHEMA, render: renderText } as const

/**
 * 注册 bridge 的状态工具:探活 sidecar 并回报其方法面清单。
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param getTransport - live sidecar transport provider.
 */
export function registerStatusTool(ctx: Context, getTransport: () => JsonRpcTransportPeer): void {
  ctx.tools.register(defineTool({
    name: 'starhub_sidecar_status',
    description:
      'Report the StarHub sidecar bridge health: process liveness plus the live JSON-RPC method inventory. Use it to diagnose tool unavailability before retrying a domain tool.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const transport = getTransport()
      const [ping, capabilities] = await Promise.all([
        transport.request('ping', {}),
        transport.request('starhub/capabilities', {}),
      ])
      const methods = extractMethods(capabilities)
      const protocol = extractProtocol(ping)
      return {
        text: `StarHub sidecar bridge: alive (protocol ${protocol}); ${String(methods.length)} method(s) registered${methods.length > 0 ? `: ${methods.join(', ')}` : ''}`,
      }
    },
  }))
}

/** Pull the `methods` array out of a capabilities result, tolerating drift. */
function extractMethods(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  const methods = (value as Record<string, unknown>).methods
  if (!Array.isArray(methods)) return []
  return methods.filter((entry): entry is string => typeof entry === 'string')
}

/** Pull the protocol string out of a ping result, tolerating drift. */
function extractProtocol(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'unknown'
  const protocol = (value as Record<string, unknown>).protocol
  return typeof protocol === 'string' ? protocol : 'unknown'
}

/**
 * 插件装配:spawn sidecar(健康探针失败即加载失败),提供桥 peer 与通知 hub,
 * 注册状态工具与工作台 API,dispose 时收进程。
 *
 * @param ctx - plugin context carrying the tool and webServer registries.
 * @param config - resolved plugin config (cordis.yml / defaults).
 */
export async function apply(ctx: Context, config: BridgeConfig = {}): Promise<void> {
  const command = config.sidecarCommand ?? [...DEFAULT_SIDECAR_COMMAND]
  const healthTimeoutMs = config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS

  const handle = await spawnSidecar(command, healthTimeoutMs)
  const sidecar = handle.transport
  // 通知出口:sidecar 的 `starhub/domain-event`(内层 {event, payload})按事件名
  // 分发给订阅插件(domain-events / session-registry / 直播面板)。
  const notifications = new NotificationDispatcher()
  notifications.attach(sidecar)
  // 桥 peer:9 个 StarHub 插件经 `sdk-transport` 读到的就是它(协议不变)。
  const peer = createBridgePeer(sidecar)
  ctx.provide(BRIDGE_TRANSPORT_SERVICE, peer)
  ctx.provide(BRIDGE_NOTIFICATIONS_SERVICE, notifications)
  registerStatusTool(ctx, () => sidecar)
  // 工作台 API(React 工作台的调用/事件面;独立组合里没有 Tauri IPC)。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/starhub/api/invoke',
      handler: invokeHandler(sidecar),
    }),
    'starhub-bridge: /starhub/api/invoke route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/starhub/api/events',
      handler: eventsHandler(broadcast => notifications.subscribeAll(broadcast)),
    }),
    'starhub-bridge: /starhub/api/events SSE route',
  )
  // 直播/接管帧通道(M3):把 sidecar 的本地 WS 以带鉴权的 path 暴露给壳内面板。
  // 端点每次连接现取(sidecar 可能在本插件之后才绑端口),令牌由面板经
  // `ui.live_open` 领取、sidecar 在握手中一次性消费。
  const liveLog = (message: string): void => {
    ctx.logger('starhub-bridge').warn(message)
  }
  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade({
        path: LIVE_UPGRADE_ROUTE,
        handler: liveUpgradeHandler(async () => {
          try {
            const endpoint = await sidecar.request('starhub/live.endpoint', {})
            const url = (endpoint as { endpoint?: unknown } | null)?.endpoint
            return typeof url === 'string' && url !== '' ? url : null
          } catch {
            return null
          }
        }, liveLog),
      }),
    'starhub-bridge: /starhub/live upgrade route',
  )
  ctx.effect(() => async () => {
    try {
      await handle.dispose()
    } catch (error) {
      ctx.logger('starhub-bridge').warn(`sidecar dispose failed: ${errorMessage(error)}`)
    }
  })
}
