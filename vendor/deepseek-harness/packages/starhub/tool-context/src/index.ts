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
  /** 当前子类 key(terminal / database / docker);空 = 未选中。 */
  subcategory?: string
  /** 当前选中资产的 id;空 = 未选中资产。 */
  assetId?: string
  /** 当前选中资产的显示名。 */
  assetName?: string
  /** 子类段路由前缀(如 /ssh),供 AI 建议打开时拼实例 URL。 */
  routePrefix?: string
}

/** Schemastery validation for the namespace value. */
export const ToolContextSchema: z<StarHubToolContextValue> = z.object({
  subcategory: z.string(),
  assetId: z.string(),
  assetName: z.string(),
  routePrefix: z.string(),
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
    { signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const value = scope.get()
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
