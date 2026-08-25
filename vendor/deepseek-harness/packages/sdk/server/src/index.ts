/**
 * SDK-facing JSON-RPC plugin over stdio. An external `cordis.yml` decides
 * whether to load it; see the single-executable Agent Note and package README.
 * Stdout is reserved for protocol frames, so the tree must not load a stdout logger.
 * This plugin answers `shutdown`, disposes the complete root runtime, and exits 0; the app bin
 * owns EOF and signal exits. Keep named plugin exports with no default export so
 * Loader `unwrapExports` preserves `name`, `inject`, `Config`, and `apply`.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from './server.ts'
import { SdkNotificationDispatcher } from './notifications.ts'

export * from './server.ts'
export * from './notifications.ts'

export const name = 'sdk-jsonrpc-server'
// Only the agent factory is required; initialize reads the optional LLM seam with ctx.get().
export const inject = ['agents']

/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})

/**
 * Serve SDK requests over the configured streams. Effect disposal shuts down
 * SDK-created agents and closes the transport. A `shutdown` response is flushed
 * before the root runtime is disposed and the process exits 0; the app bin
 * owns root-context disposal for EOF and signals.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Cordis applies the schema default before invoking the plugin.
  const resolvedConfig = config as JsonRpcConfig & { maxTokensAsSuccess: boolean }
  // Protocol shutdown owns the complete runtime process, so it must await the
  // root lifecycle (including persistence) before exiting.
  const rootFiber = ctx.root.fiber
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- production exit wiring; tests always inject the runtime hooks */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  // StarHub 本地补丁(P1-4,不在上游):把 stdio transport 以可选服务形式
  // 暴露给同组合内的 starhub-tools 插件,使工具执行可经 SDK 双向 request
  // (server→client,方法 starhub/tool.execute)桥回宿主进程。该服务名不走
  // Context 接口声明合并(宿主私有协议),消费方用 ctx.get('sdk-transport')
  // 读取并自行窄化;provide 的生命周期跟随本插件 fiber,卸载即摘除。
  ctx.provide('sdk-transport', transport)
  // StarHub 本地补丁(联动契约 §0/§2.1,不在上游):把入站 notification(无 id
  // 帧)按 method 名多路分发给订阅插件,以 `sdk-notifications` 可选服务暴露
  // (subscribe(method, handler) => disposer)。与 sdk-transport 同为宿主私有
  // 服务,不走 Context 接口声明合并,消费方 ctx.get 后自行窄化;未订阅的
  // 方法静默忽略,订阅者异常被隔离,均不打断 transport 的读循环。
  const notifications = new SdkNotificationDispatcher()
  ctx.provide('sdk-notifications', notifications)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  })

  // Share one exit task so racing shutdown requests cannot dispose the root or
  // exit the process more than once.
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    // `initialize` is the SDK's readiness boundary. This plugin can activate
    // before async sibling Loader entries (for example an MCP client's initial
    // tool discovery), so do not advertise a ready runtime until the complete
    // current tree has settled. A hand-built context without Loader remains
    // immediately usable.
    if (method === 'initialize') await ctx.get('loader')?.await()
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes, disposes, and exits.
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  transport.onNotification((method, params) => {
    notifications.dispatch(method, params)
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}
