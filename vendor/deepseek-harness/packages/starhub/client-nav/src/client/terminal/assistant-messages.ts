/**
 * SSH AI 助手面板的消息折叠(纯函数):把 SSE 帧流折叠成可渲染的聊天项。
 *
 * 会话事件从助手会话的 durable log 原样转发,折叠按消息/call id 幂等——
 * 重放(晚到的客户端)与实时帧重复到达同一事件时不会产生第二份。
 * 非用户来源的 user 消息(工具上下文/活性上下文注入)不渲染。
 *
 * @module StarHub SSH assistant message fold (client)
 */

import type { AssistantApprovalOutcome, AssistantFrame, AssistantSessionEvent } from './assistant-service.ts'

/** 一条可渲染的聊天项。 */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; interrupted: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; output: string | null; isError: boolean }
  | {
    kind: 'approval'
    requestId: string
    toolName: string
    reason: string | null
    settled: AssistantApprovalOutcome | null
  }
  | { kind: 'error'; id: string; message: string }

/** 从消息 content 块数组中取出文本(非文本块忽略)。 */
function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    }
  }
  return parts.join('')
}

/** 会话事件 data 的窄读取。 */
function dataRecord(event: AssistantSessionEvent): Record<string, unknown> {
  return event.data
}

/** tool/call 参数字符串的展示形态(合法 JSON 美化,原样透传非法值)。 */
export function formatToolArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

/** 按 id  upsert 一条聊天项。 */
function upsert(items: ChatItem[], next: ChatItem, key: (item: ChatItem) => string | null): ChatItem[] {
  const nextKey = key(next)
  if (nextKey !== null) {
    const index = items.findIndex(item => key(item) === nextKey)
    if (index >= 0) {
      const merged = [...items]
      merged[index] = next
      return merged
    }
  }
  return [...items, next]
}

/** 聊天项的稳定键(同源事件去重/更新用)。 */
function itemKey(item: ChatItem): string | null {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'error':
      return item.id
    case 'tool':
      return item.id
    case 'approval':
      return item.requestId
  }
}

/**
 * 折叠一条会话事件。
 * @param items - 当前聊天项列表。
 * @param event - 转发的会话事件。
 * @returns 新列表(无变化时原引用)。
 */
export function foldSessionEvent(items: ChatItem[], event: AssistantSessionEvent): ChatItem[] {
  const data = dataRecord(event)
  switch (event.type) {
    case 'user/message': {
      const source = data.source as Record<string, unknown> | undefined
      // 只渲染用户本人的输入;插件注入的上下文消息(kind 非 user)不进面板。
      if (source?.kind !== 'user') return items
      const text = textOfBlocks(data.content)
      if (text === '') return items
      return upsert(items, { kind: 'user', id: String(data.id), text }, itemKey)
    }
    case 'assistant/message': {
      const message = data.message as Record<string, unknown> | undefined
      if (message === undefined) return items
      const text = textOfBlocks(message.content)
      if (text === '') return items
      return upsert(
        items,
        {
          kind: 'assistant',
          id: String(message.id),
          text,
          interrupted: data.interrupted === true,
        },
        itemKey,
      )
    }
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const args = typeof data.arguments === 'string' ? data.arguments : ''
      return upsert(items, { kind: 'tool', id: String(data.callId), name, args, output: null, isError: false }, itemKey)
    }
    case 'tool/result': {
      const message = data.message as Record<string, unknown> | undefined
      if (message === undefined) return items
      const callId = String(message.toolCallId)
      const output = textOfBlocks(message.content)
      const isError = message.isError === true || data.error !== undefined
      const index = items.findIndex(item => item.kind === 'tool' && item.id === callId)
      if (index < 0) {
        // 结果先于调用到达(重放截断):补一条只有输出的工具项。
        return [...items, { kind: 'tool', id: callId, name: 'tool', args: '', output, isError }]
      }
      const current = items[index]
      if (current === undefined || current.kind !== 'tool') return items
      const merged = [...items]
      merged[index] = { ...current, output, isError }
      return merged
    }
    default:
      return items
  }
}

/**
 * 折叠一条 SSE 帧。
 * @param items - 当前聊天项列表。
 * @param frame - 流帧。
 * @returns 新列表(无变化时原引用)。
 */
export function foldFrame(items: ChatItem[], frame: AssistantFrame): ChatItem[] {
  switch (frame.t) {
    case 'event':
      return foldSessionEvent(items, frame.event)
    case 'approval':
      return upsert(
        items,
        {
          kind: 'approval',
          requestId: frame.requestId,
          toolName: frame.toolName,
          reason: frame.reason ?? null,
          settled: null,
        },
        itemKey,
      )
    case 'error':
      return [...items, { kind: 'error', id: `error-${String(items.length)}`, message: frame.message }]
    default:
      return items
  }
}

/** 把一条审批项标记为已结算。 */
export function settleApprovalItem(
  items: ChatItem[],
  requestId: string,
  outcome: AssistantApprovalOutcome,
): ChatItem[] {
  return items.map(item =>
    item.kind === 'approval' && item.requestId === requestId ? { ...item, settled: outcome } : item,
  )
}
