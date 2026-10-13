// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  foldFrame, formatToolArgs, settleApprovalItem, type ChatItem,
} from '../src/client/terminal/assistant-messages.ts'
import type { AssistantFrame, AssistantSessionEvent } from '../src/client/terminal/assistant-service.ts'

/** 构造一条 user/message 会话事件。 */
function userEvent(id: string, text: string, kind = 'user'): AssistantSessionEvent {
  return {
    type: 'user/message',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind } },
  }
}

/** 构造一条 assistant/message 会话事件。 */
function assistantEvent(id: string, text: string, interrupted = false): AssistantSessionEvent {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
      stream: [],
      ...(interrupted ? { interrupted: true } : {}),
    },
  }
}

/** 构造一条 tool/call 会话事件。 */
function toolCallEvent(callId: string, name: string, args: string): AssistantSessionEvent {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: args } }
}

/** 构造一条 tool/result 会话事件。 */
function toolResultEvent(callId: string, output: string, isError = false): AssistantSessionEvent {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `msg-${callId}`,
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text: output }],
        ...(isError ? { isError: true } : {}),
      },
    },
  }
}

describe('assistant message fold', () => {
  it('renders user input and skips injected context messages', () => {
    const items = foldFrame([], { t: 'event', event: userEvent('m1', '看看磁盘') })
    expect(items).toEqual([{ kind: 'user', id: 'm1', text: '看看磁盘' }])
    // 工具上下文/活性上下文注入(source.kind 非 user)不进面板。
    const injected = foldFrame(items, { t: 'event', event: userEvent('m2', 'StarHub live context…', 'dsh-starhub-live-context') })
    expect(injected).toBe(items)
  })

  it('renders assistant text with the interrupted marker', () => {
    let items = foldFrame([], { t: 'event', event: assistantEvent('a1', '正在执行') })
    items = foldFrame(items, { t: 'event', event: assistantEvent('a2', '已中断', true) })
    expect(items).toEqual([
      { kind: 'assistant', id: 'a1', text: '正在执行', interrupted: false },
      { kind: 'assistant', id: 'a2', text: '已中断', interrupted: true },
    ])
  })

  it('pairs tool results with their calls by callId', () => {
    let items = foldFrame([], { t: 'event', event: toolCallEvent('c1', 'ssh_exec', '{"command":"df -h"}') })
    items = foldFrame(items, { t: 'event', event: toolResultEvent('c1', '/dev/sda1 50G') })
    expect(items).toEqual([{
      kind: 'tool',
      id: 'c1',
      name: 'ssh_exec',
      args: '{"command":"df -h"}',
      output: '/dev/sda1 50G',
      isError: false,
    }])
  })

  it('marks failed tool results', () => {
    let items = foldFrame([], { t: 'event', event: toolCallEvent('c2', 'ssh_exec', '{}') })
    items = foldFrame(items, {
      t: 'event',
      event: {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: { id: 'm', role: 'tool', toolCallId: 'c2', content: [], isError: true },
          error: { name: 'Error', code: 'EXEC_FAILED' },
        },
      },
    })
    const item = items[0]
    expect(item?.kind === 'tool' && item.isError).toBe(true)
  })

  it('keeps a tool result that arrives before its call', () => {
    const items = foldFrame([], { t: 'event', event: toolResultEvent('c3', 'orphan output') })
    expect(items).toEqual([{
      kind: 'tool',
      id: 'c3',
      name: 'tool',
      args: '',
      output: 'orphan output',
      isError: false,
    }])
  })

  it('is idempotent for replayed events', () => {
    const once = foldFrame([], { t: 'event', event: toolCallEvent('c4', 'sftp_list', '{"path":"/tmp"}') })
    const twice = foldFrame(once, { t: 'event', event: toolCallEvent('c4', 'sftp_list', '{"path":"/tmp"}') })
    expect(twice).toHaveLength(1)
  })

  it('tracks approval cards and their settlement', () => {
    const frame: AssistantFrame = {
      t: 'approval',
      requestId: 'r1',
      toolName: 'ssh_exec',
      reason: '风险命令:reboot',
    }
    let items = foldFrame([], frame)
    expect(items).toEqual([{ kind: 'approval', requestId: 'r1', toolName: 'ssh_exec', reason: '风险命令:reboot', settled: null }])
    items = settleApprovalItem(items, 'r1', 'allowed-once')
    expect(items[0]).toMatchObject({ kind: 'approval', settled: 'allowed-once' })
  })

  it('surfaces stream error frames', () => {
    const items = foldFrame([], { t: 'error', message: '模型调用失败' })
    expect(items).toEqual([{ kind: 'error', id: 'error-0', message: '模型调用失败' }])
  })

  it('ignores status/model/closed frames in the message list', () => {
    const items: ChatItem[] = []
    expect(foldFrame(items, { t: 'status', status: 'running' })).toBe(items)
    expect(foldFrame(items, { t: 'model', provider: 'deepseek', model: 'x' })).toBe(items)
    expect(foldFrame(items, { t: 'closed' })).toBe(items)
  })
})

describe('formatToolArgs', () => {
  it('pretty-prints valid JSON', () => {
    expect(formatToolArgs('{"command":"ls"}')).toBe('{\n  "command": "ls"\n}')
  })

  it('passes through non-JSON verbatim', () => {
    expect(formatToolArgs('not json')).toBe('not json')
  })
})
