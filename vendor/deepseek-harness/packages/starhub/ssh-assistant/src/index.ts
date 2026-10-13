/**
 * StarHub SSH AI assistant (去 Tauri 化 M4 之后的新宿主插件;StarHub-local,
 * 不在上游)。
 *
 * 每个 SSH 终端页对应一个 **agent 作用域会话**:`ctx.agents.create()` 建根
 * Agent,模型路由取部署默认(`agentDefaultModel`——用户在 dsh 设置里配的
 * provider/key/model,助手 therefore 复用同一套模型连接,面板可临时切换),
 * creation window 里把工具面 `restrict` 到本资产的 SSH/SFTP 8 个工具并经
 * 桥 `starhub/bind.asset` 绑定资产(sidecar 的 `resolve_asset_id` 因此自动
 * 路由,`ensure_ssh_session` 复用该资产已有的 AI exec 连接)。
 *
 * 会话打上 StarHub 自有的本地 cwd(Config `sessionCwd`):没有 cwd 的会话
 * 拼不出系统提示的 {{cwd}} 段(回合在第 1 步静默失败、面板无响应),且被
 * dsh 会话列表按 not-found 拒绝;打开后经 sessionTitle 服务把显示名钉成
 * 服务器名(纯资产名,user 来源同时压住自动标题)。
 *
 * 面板(壳内工作台 React 应用,无 dsh client runtime)经同源
 * `/starhub/api/assistant/*` 路由驱动:open/prompt/stop/close/model/approval
 * + SSE 流(`session/event` 按会话过滤转发,事件源渲染与 dsh GUI 同范式)。
 *
 * 审批:助手会话的 `approval/request` 由本插件 prepend 承接——经 SSE 推给
 * 面板、面板 POST 决策;面板没在流上时交回链尾(壳内审批 UI 不受影响)。
 * 风险分级仍归 starhub-approval-bridge 的风险门(只读放行、写/风险 ask)。
 *
 * @module @deepseek-ai/dsh-starhub-ssh-assistant
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: declares the `sessionTitle` service on Context (assistant 标题钉名)。
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only: declares the `webServer` service on Context (route registration)
// and the `llm` service (model catalog for the panel picker).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { AssistantRegistry } from './registry.ts'
import {
  ASSISTANT_ROUTES,
  activeConnsHandler,
  approvalHandler,
  closeHandler,
  modelHandler,
  modelsHandler,
  openHandler,
  promptHandler,
  stopHandler,
  streamHandler,
  type AssistantRouteDeps,
  type ModelCatalog,
  type ModelCatalogProvider,
} from './routes.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-ssh-assistant'

/** Declared dependencies: agent registry, web server routes, tool registry, LLM catalog. */
export const inject = ['agents', 'webServer', 'tools', 'llm']

/** Bridge method that binds an agent session to a StarHub asset. */
const BIND_ASSET_METHOD = 'starhub/bind.asset'

/** Private host service names resolved through `ctx.get` (not declared merges). */
const SDK_TRANSPORT_SERVICE = 'sdk-transport'
const SDK_NOTIFICATIONS_SERVICE = 'sdk-notifications'
const AGENT_DEFAULT_MODEL_SERVICE = 'agentDefaultModel'
const SESSION_TITLE_SERVICE = 'sessionTitle'

/** 助手会话的默认本地 cwd:StarHub 自有目录,不属于任何 workspace。 */
const DEFAULT_SESSION_CWD = join(homedir(), '.starhub', 'ssh-assistant')

/**
 * 插件配置。sessionCwd 是助手会话打上的本地工作目录(部署变化项,按上游
 * 「No hardcoded tunables」规约走 Config):没有 cwd 的会话拼不出系统提示的
 * {{cwd}} 段——回合在第 1 步静默失败(面板无响应),且被会话列表按
 * not-found 拒绝。
 */
export const Config: z<{ sessionCwd?: string }> = z.object({
  sessionCwd: z.string().default(DEFAULT_SESSION_CWD),
})

/** apply 收到的已解析配置(可选字段,缺省见 DEFAULT_SESSION_CWD)。 */
export interface AssistantConfig {
  sessionCwd?: string
}

/**
 * 注册插件:建助手注册表、挂会话事件/状态/模型/审批四个监听,并注册
 * `/starhub/api/assistant/*` 路由;插件卸载时全部助手会话随之销毁。
 *
 * @param ctx - plugin context carrying the agent, webServer, and tools services.
 * @param config - resolved plugin config (cordis.yml / defaults).
 */
export function apply(ctx: Context, config: AssistantConfig = {}): void {
  const sessionCwd = config.sessionCwd ?? DEFAULT_SESSION_CWD
  // 目录必须真实存在(dsh-session 校验);建不出来是配置错误,启动期 fail loud。
  mkdirSync(sessionCwd, { recursive: true })
  const registry = new AssistantRegistry({
    sessionCwd,
    createAgent: options => ctx.agents.create(options),
    getAgent: sessionId => ctx.agents.get(sessionId),
    renameSession: (sessionId, title) => {
      // 标题只影响列表展示:缺 sessionTitle 服务或会话已释放时降级为 warn,
      // 不打断助手打开(标题服务是 dsh-base 的常驻组成,正常组合不会缺)。
      const titles = ctx.get(SESSION_TITLE_SERVICE)
      const agent = ctx.agents.get(SessionId(sessionId))
      if (titles === undefined || agent === undefined) {
        ctx.logger(name).warn(`会话标题未设置(缺 sessionTitle 服务或会话已释放):${sessionId}`)
        return
      }
      try {
        titles.rename(agent.session, title)
      } catch (error) {
        ctx.logger(name).warn(
          `会话标题设置失败(${sessionId}):${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    bindAsset: async (assetId, sessionId) => {
      const transport = ctx.get(SDK_TRANSPORT_SERVICE) as JsonRpcTransportPeer | undefined
      if (transport === undefined) {
        throw new Error('starhub-ssh-assistant 需要 starhub-bridge(sdk-transport 服务)')
      }
      const result: unknown = await transport.request(BIND_ASSET_METHOD, { assetId, sessionId })
      const record = typeof result === 'object' && result !== null
        ? result as Record<string, unknown>
        : undefined
      if (record?.ok !== true || record.action !== 'bound') {
        throw new Error(`资产绑定失败:${assetId}`)
      }
    },
    defaultSelection: () => {
      const service = ctx.get(AGENT_DEFAULT_MODEL_SERVICE) as {
        currentSelection(): { provider: string; model: string }
      } | undefined
      if (service === undefined) return undefined
      const selection = service.currentSelection()
      return { provider: selection.provider, model: selection.model }
    },
    modelExists: async (provider, model) => {
      const models = await ctx.llm.listModels(provider)
      return models.some(entry => entry.id === model)
    },
    subscribeNotification: (method, handler) => {
      // 连接验证卡事件走 bridge 的通知 hub(sidecar 的 starhub/domain-event
      // 按内层事件名分发);缺失时返回 no-op 退订——助手仍可用,只是 MFA/堡垒机
      // 卡回落壳内连接卡(与插件未加载时同一体验)。
      const hub = ctx.get(SDK_NOTIFICATIONS_SERVICE) as {
        subscribe(method: string, handler: (params: object) => void): () => void
      } | undefined
      if (hub === undefined) return () => undefined
      return hub.subscribe(method, handler)
    },
  })

  // 会话事件流:助手会话的 durable log 原样转发给面板(用户/助手消息、
  // tool/call、tool/result、turn/step 边界),与 dsh GUI 的事件源渲染同范式。
  ctx.on('session/event', (session, event) => {
    registry.onSessionEvent(String(session.id), event)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    registry.onStatus(String(agent.session.id), status)
  })
  // 面板切换模型:替换本请求冻结的 call config(路由变更时丢掉过期的
  // reasoningEffort,让新模型解析自己的默认值)。
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    return registry.applyRequestConfig(String(agent.session.id), config)
  })
  // 审批:助手会话的 ask 先在面板里落卡;面板没在看(流已断)时交回链尾,
  // 壳内审批 UI 的行为不变。
  ctx.on('approval/request', async (req, next) => {
    const sessionId = String(req.agent.session.id)
    if (!registry.isAssistant(sessionId) || !registry.hasClients(sessionId)) return next()
    return registry.parkApproval(sessionId, {
      toolName: req.toolName,
      ...(req.callId === undefined ? {} : { callId: String(req.callId) }),
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    })
  }, { prepend: true })

  const listModels = async (): Promise<ModelCatalog> => {
    const providers: ModelCatalogProvider[] = []
    for (const info of ctx.llm.listProviders()) {
      let models: { id: string; name: string }[] = []
      try {
        models = (await ctx.llm.listModels(info.id)).map(model => ({ id: model.id, name: model.name }))
      } catch {
        // 路由列出了但模型目录读不到(适配器未就绪):给空列表,面板禁用该行。
        models = []
      }
      providers.push({ provider: info.id, displayName: info.name, models })
    }
    return { providers }
  }
  const deps: AssistantRouteDeps = { registry, listModels }

  const routes: ReadonlyArray<{
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }> = [
    { path: ASSISTANT_ROUTES.open, handler: openHandler(deps) },
    { path: ASSISTANT_ROUTES.prompt, handler: promptHandler(deps) },
    { path: ASSISTANT_ROUTES.stop, handler: stopHandler(deps) },
    { path: ASSISTANT_ROUTES.close, handler: closeHandler(deps) },
    { path: ASSISTANT_ROUTES.model, handler: modelHandler(deps) },
    { path: ASSISTANT_ROUTES.approval, handler: approvalHandler(deps) },
    { path: ASSISTANT_ROUTES.models, handler: modelsHandler(deps) },
    { path: ASSISTANT_ROUTES.activeConns, handler: activeConnsHandler(deps) },
    { path: ASSISTANT_ROUTES.stream, handler: streamHandler(deps) },
  ]
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: route.handler,
      }),
      `starhub-ssh-assistant: ${route.path} route`,
    )
  }
  ctx.effect(() => async () => {
    await registry.disposeAll()
  }, 'starhub-ssh-assistant: dispose assistants')
}
