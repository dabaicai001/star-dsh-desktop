// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  foldFrame, formatToolArgs, settleApprovalItem, type ChatItem,
} from '../src/client/terminal/assistant-messages.ts'
import type { AssistantFrame, AssistantSessionEvent, AssistantStreamFrame } from '../src/client/terminal/assistant-service.ts'

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

  it('renders a failed turn as an error item, deduped by turn', () => {
    // turn/end reason.kind='error':回合失败(如提示拼装抛错)不产生任何消息
    // 事件,不渲染就是「发了没反应」;按 turn-N 去重(重放与实时帧各到一次)。
    const failed: AssistantSessionEvent = {
      type: 'turn/end',
      data: {
        turn: 1,
        reason: { kind: 'error', error: { message: 'prompt variable "{{cwd}}" has no value', code: 'UNKNOWN' } },
      },
    }
    const once = foldFrame([], { t: 'event', event: failed })
    expect(once).toEqual([{ kind: 'error', id: 'turn-1', message: 'prompt variable "{{cwd}}" has no value' }])
    expect(foldFrame(once, { t: 'event', event: failed })).toHaveLength(1)
    // 正常结束的回合不产生错误项。
    const completed: AssistantSessionEvent = { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }
    expect(foldFrame(once, { t: 'event', event: completed })).toBe(once)
  })

  it('ignores status/model/closed frames in the message list', () => {
    const items: ChatItem[] = []
    expect(foldFrame(items, { t: 'status', status: 'running' })).toBe(items)
    expect(foldFrame(items, { t: 'model', provider: 'deepseek', model: 'x' })).toBe(items)
    expect(foldFrame(items, { t: 'closed' })).toBe(items)
  })
})

/** 构造一条流式帧。 */
function streamFrame(frame: AssistantStreamFrame): AssistantFrame {
  return { t: 'stream', frame }
}

/** 一条文本增量 chunk 帧。 */
function textDelta(attemptId: string, text: string): AssistantFrame {
  return streamFrame({
    type: 'chunk',
    attemptId,
    revision: 1,
    index: 0,
    time: 1,
    chunk: { type: 'text-delta', index: 0, text },
  })
}

describe('assistant stream fold', () => {
  it('accumulates text deltas into one streaming bubble', () => {
    let items = foldFrame([], textDelta('a1', '你'))
    expect(items).toEqual([{ kind: 'assistant', id: 'stream-a1', text: '你', interrupted: false, streaming: true }])
    items = foldFrame(items, textDelta('a1', '好'))
    expect(items).toEqual([{ kind: 'assistant', id: 'stream-a1', text: '你好', interrupted: false, streaming: true }])
    // 不同 attempt(工具回合后的第二次尝试)各起一个气泡。
    items = foldFrame(items, textDelta('a2', '再见'))
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ id: 'stream-a2', text: '再见', streaming: true })
  })

  it('replaces the streaming bubble in place with the durable message', () => {
    let items = foldFrame([], { t: 'event', event: userEvent('m1', '看看磁盘') })
    items = foldFrame(items, textDelta('a1', '磁盘'))
    items = foldFrame(items, textDelta('a1', '还剩 50%'))
    // durable 消息(完整文本)到达:原位替换,不叠第二条、清流式标记。
    items = foldFrame(items, { t: 'event', event: assistantEvent('m9', '磁盘还剩 50%。') })
    expect(items).toEqual([
      { kind: 'user', id: 'm1', text: '看看磁盘' },
      { kind: 'assistant', id: 'm9', text: '磁盘还剩 50%。', interrupted: false },
    ])
  })

  it('keeps streamed text when the attempt ends without a durable message', () => {
    let items = foldFrame([], textDelta('a1', '半句话'))
    items = foldFrame(items, streamFrame({ type: 'end', attemptId: 'a1', revision: 9, index: 1, outcome: { kind: 'abandoned' } }))
    expect(items).toEqual([{ kind: 'assistant', id: 'stream-a1', text: '半句话', interrupted: false, streaming: false }])
  })

  it('ignores start frames and non-text chunks', () => {
    const items: ChatItem[] = []
    expect(foldFrame(items, streamFrame({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }))).toBe(items)
    expect(foldFrame(items, streamFrame({
      type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: '内心独白' },
    }))).toBe(items)
    expect(foldFrame(items, streamFrame({
      type: 'chunk', attemptId: 'a1', revision: 3, index: 0, time: 1,
      // 非文本 chunk(工具调用增量):客户端类型只建模 type/index/text,
      // 主机也从不发这种 chunk——只验证「非 text-delta 一律被忽略」。
      chunk: { type: 'tool-call-delta', index: 0 },
    }))).toBe(items)
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
