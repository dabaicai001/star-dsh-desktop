/**
 * StarHub tool context(方案第 4 章 4.3):把「当前 StarHub 工具 + 资产」注入
 * 每个 agent 请求的上下文。
 *
 * 数据流:client-nav(浏览器壳)在用户选择子类/资产时,经 settings 通道
 * (`settings.update`)写入 `starhub-tool-context` namespace(当前子类、
 * 资产 id、资产名、路由前缀);本插件(host)在 `agent/pre-step` 时读取该
 * namespace,有选中工具则注入一条 plugin 来源的 user message,让模型
 * 感知「用户当前在哪个 StarHub 工具、哪个连接上」。
 *
 * 无选中工具/无数据时注入为空(no-op):不打扰正常对话。
 *
 * @module @deepseek-ai/dsh-starhub-tool-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-tool-context'

/** The agent registry and settings service. */
export const inject = ['agents', 'settings']

/** Settings namespace holding the current StarHub tool selection. */
export const TOOL_CONTEXT_NAMESPACE = 'starhub-tool-context'

/** Schema-validated shape written by client-nav. */
export interface StarHubToolContextValue {
  /** 触发本次绑定的会话 id;仅该会话在 pre-step 时注入(会话级作用域)。 */
  sessionId?: string
  /** 当前子类 key(terminal / database / docker);空 = 未选中。 */
  subcategory?: string
  /** 当前选中资产的 id;空 = 未选中资产。 */
  assetId?: string
  /** 当前选中资产的显示名。 */
  assetName?: string
  /** 子类段路由前缀(如 /ssh),供 AI 建议打开时拼实例 URL。 */
  routePrefix?: string
  /** 资产大类 id(db / ssh / docker / local);空 = 未标注。 */
  assetType?: string
  /** 数据库子类型(redis / mysql / clickhouse / …);非 DB 资产缺省。 */
  dbType?: string
}

/** Schemastery validation for the namespace value. */
export const ToolContextSchema: z<StarHubToolContextValue> = z.object({
  sessionId: z.string(),
  subcategory: z.string(),
  assetId: z.string(),
  assetName: z.string(),
  routePrefix: z.string(),
  assetType: z.string(),
  dbType: z.string(),
})

/**
 * Render one injectable tool-context text from a non-empty selection.
 * @param value - the current StarHub tool selection (namespace value).
 * @returns the injectable text, or null when neither tool nor asset is selected.
 */
export function renderToolContext(value: StarHubToolContextValue): string | null {
  const tool = value.subcategory ?? ''
  const asset = value.assetName ?? value.assetId ?? ''
  if (tool === '' && asset === '') return null
  const lines = [
    'Current StarHub tool context:',
    `- Tool: ${tool === '' ? 'none' : tool}`,
    `- Asset: ${asset === '' ? 'none' : asset}`,
    ...(value.routePrefix !== undefined && value.routePrefix !== ''
      ? [`- Route: ${value.routePrefix}`]
      : []),
  ]
  // 资产类型提示:让模型准确选择工具族(DB 资产绝不调 SSH 工具)。
  if ((value.assetType !== undefined && value.assetType !== '') || (value.dbType !== undefined && value.dbType !== '')) {
    const assetType = value.assetType ?? ''
    const dbType = value.dbType ?? ''
    lines.push(`- Asset type: ${dbType !== '' ? `database (${dbType})` : assetType}`)
  }
  const toolHint = toolHintFor(value)
  if (toolHint !== null) {
    lines.push(toolHint)
  }
  // Docker 资产硬约束(死规定):任何删除类操作必须先征得用户明确确认。
  // 与 @ 引用标注、approval-bridge 风险门三层一致,不允许模型自行删除。
  if (tool === 'docker') {
    lines.push(
      '- Docker delete guard (hard rule): never run destructive Docker commands '
      + '(rm/rmi/prune — container, image, volume, network, system —, compose down/rm, '
      + 'stack/service/config/secret/plugin rm). If deletion is truly required, ask the '
      + 'user for explicit confirmation and only proceed after approval.',
    )
  }
  return lines.join('\n')
}

/** 按资产类型给出「该用什么工具族」的一行提示(DB 资产明确禁止 SSH 工具)。 */
function toolHintFor(value: StarHubToolContextValue): string | null {
  const dbType = value.dbType ?? ''
  const assetType = value.assetType ?? ''
  if (dbType !== '') {
    if (dbType === 'redis') return '- Preferred tool: redis_exec (Redis commands) — NOT ssh_exec/sftp_*.'
    if (dbType === 'elasticsearch') return '- Preferred tool: es_* (Elasticsearch) — NOT ssh_exec/sftp_*.'
    return '- Preferred tool: db_query (SQL) — NOT ssh_exec/sftp_*.'
  }
  if (assetType === 'db') return '- Preferred tool: db_query (SQL) — NOT ssh_exec/sftp_*.'
  return null
}

/**
 * Register the plugin: declare the settings namespace once and inject the
 * current StarHub tool context on every agent pre-step.
 * @param ctx - plugin context; the listener is disposed with it.
 */
export function apply(ctx: Context): void {
  const ns: SettingsNamespace = settingsNamespace(TOOL_CONTEXT_NAMESPACE)
  // Declare the namespace once; the pre-step listener reads it per request.
  const scope = ctx.settings.register(ns, ToolContextSchema)

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const value = scope.get()
    // 会话级作用域:仅当本次触发绑定的会话(agent.session.id)与 namespace
    // 里记录的 sessionId 一致时才注入;普通对话/其他会话不注入,避免全局粘性
    // 让每条对话都带上 starhub-tool-context 上下文。
    if (value.sessionId === undefined || value.sessionId !== agent.session.id) return decision
    const text = renderToolContext(value)
    if (text === null) return decision
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
