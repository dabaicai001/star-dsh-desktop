/**
 * StarHub sidecar bridge(去 Tauri 化 M1;StarHub 本地包,不在上游)。
 *
 * 迁移后的 StarHub 工具面执行端点:本插件在 dsh Host 进程内 spawn Go /
 * Rust 两个 sidecar,经 stdio JSON-RPC(换行分帧,与 `JsonRpcLineTransport`
 * 逐字节对齐)把 sidecar 方法面暴露给模型。旧 Tauri 壳的
 * `src-tauri/src/harness` 应答方整体退役后,`starhub-tools` 的
 * `starhub/tool.execute` 桥由本插件承接(兼容层在 M1 后续提交落地,
 * 9 插件 TS 侧零改动)。
 *
 * 本提交(M1 垂直切片):进程生命周期 + 健康探针 + 一个状态工具
 * (`starhub_sidecar_status`),把「spawn → JSON-RPC → dsh 工具」全链路
 * 打通并测试;域工具(ssh/db/browser/…)按 `docs/去Tauri化-M1-命令映射清单.md`
 * 的顺序逐个平移进来。
 *
 * @module @deepseek-ai/dsh-starhub-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_HEALTH_TIMEOUT_MS, DEFAULT_SIDECAR_COMMAND, errorMessage, spawnSidecar } from './transport.ts'

export const name = 'starhub-bridge'
export const inject = ['tools']

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
        transport.request('starhub_list_capabilities', {}),
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
 * 插件装配:spawn sidecar(健康探针失败即加载失败),注册状态工具,
 * dispose 时收进程。
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved plugin config (cordis.yml / defaults).
 */
export async function apply(ctx: Context, config: BridgeConfig = {}): Promise<void> {
  const command = config.sidecarCommand ?? [...DEFAULT_SIDECAR_COMMAND]
  const healthTimeoutMs = config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS

  const handle = await spawnSidecar(command, healthTimeoutMs)
  // Notifications from the sidecar (domain events, exec progress) arrive
  // here once the domains are extracted; the transport requires a handler
  // to be installed, and dropping them is the correct M1 behavior.
  const transport = handle.transport
  transport.onNotification((_method: string, _params: object) => {})
  registerStatusTool(ctx, () => transport)
  ctx.effect(() => async () => {
    try {
      await handle.dispose()
    } catch (error) {
      ctx.logger('starhub-bridge').warn(`sidecar dispose failed: ${errorMessage(error)}`)
    }
  })
}
