// @vitest-environment jsdom
/**
 * Component tests for `ai/AiChatPanel.tsx`: no-session guidance, new-session
 * flow, live conversation rendering (nodes + streaming partial), send/stop/
 * load-older over the session face, and the gate states (loading/error).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT,
  type ConversationNode, type ConversationSnapshot, type ISessions, type IWorkspaces,
  type SessionFace, type SessionId, type SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { AiChatPanel } from '../src/client/ai/AiChatPanel.tsx'

afterEach(cleanup)

/** Minimal full conversation snapshot with defaults. */
function makeSnap(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: 's1' as SessionId,
    views: { get: () => undefined },
    chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'blank',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: true,
    lastAgentError: null,
    ...over,
  }
}

interface SessionDouble extends SessionFace {
  __set: (s: ConversationSnapshot) => void
  prompt: Mock<SessionFace['prompt']>
  cancel: Mock<SessionFace['cancel']>
  loadOlder: Mock<SessionFace['loadOlder']>
}

/** Build a live session face (observable snapshot + behaviour verbs). */
function makeSession(snapshot: ConversationSnapshot): SessionDouble {
  let current = snapshot
  const subs = new Set<() => void>()
  const face = {
    sessionId: 's1',
    projections: { faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
    getSnapshot: () => current,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    prompt: vi.fn<SessionFace['prompt']>().mockResolvedValue({ ok: true, value: { accepted: true } }),
    cancel: vi.fn<SessionFace['cancel']>().mockResolvedValue({ ok: true, value: { accepted: true } }),
    loadOlder: vi.fn<SessionFace['loadOlder']>().mockResolvedValue(undefined),
    rename: vi.fn(),
    command: vi.fn(),
    updateQueue: vi.fn(),
    readAttachment: vi.fn(),
  } as unknown as SessionDouble
  face.__set = (s: ConversationSnapshot) => { current = s; for (const fn of subs) fn() }
  return face
}

/** Build an ISessions with a selectable current session. */
function makeSessions(
  currentId: string | undefined,
  sessionFace: SessionFace | undefined,
  open: ReturnType<typeof vi.fn> = vi.fn(),
): ISessions {
  const current = currentId as SessionId | undefined
  const list = createSnapshotStore<SessionListState>({
    ids: current === undefined ? [] : [current],
    byId: {},
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  return {
    list,
    // The component reads `binding(id).session` — the SessionBinding wraps the
    // SessionFace in `{ sessionId, session, ctx }` (runtime sessions/service.ts).
    binding: (id: SessionId) => (sessionFace !== undefined && id === current
      ? { sessionId: current, session: sessionFace, ctx: {} as never }
      : undefined),
    open,
    clear: vi.fn(),
  } as unknown as ISessions
}

/** Build an IWorkspaces stub. */
function makeWorkspaces(recentWorkspaceId: string | undefined, connectWorkspace = vi.fn()): IWorkspaces {
  return { list: { getSnapshot: () => ({ recentWorkspaceId, ids: [], byId: {}, phase: 'ready', items: [] }) }, connectWorkspace } as unknown as IWorkspaces
}

describe('AiChatPanel', () => {
  it('shows no-session guidance when nothing is current', () => {
    const sessions = makeSessions(undefined, undefined)
    const workspaces = makeWorkspaces(undefined)
    render(<AiChatPanel sessions={sessions} workspaces={workspaces} onClose={vi.fn()} />)
    expect(screen.getByText('没有正在进行的 AI 会话')).toBeTruthy()
    expect(screen.getByText('新建会话')).toBeTruthy()
  })

  it('creates a session from the recent workspace when 新建会话 is pressed', () => {
    const connectWorkspace = vi.fn().mockResolvedValue('s1')
    const open = vi.fn()
    const sessions = makeSessions(undefined, undefined, open)
    const workspaces = makeWorkspaces('w1', connectWorkspace)
    render(<AiChatPanel sessions={sessions} workspaces={workspaces} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('新建会话'))
    expect(connectWorkspace).toHaveBeenCalledWith('w1')
    return vi.waitFor(() =>{  expect(open).toHaveBeenCalledWith('s1') })
  })

  it('does not connect when there is no recent workspace', () => {
    const connectWorkspace = vi.fn()
    const sessions = makeSessions(undefined, undefined)
    const workspaces = makeWorkspaces(undefined, connectWorkspace)
    render(<AiChatPanel sessions={sessions} workspaces={workspaces} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('新建会话'))
    expect(connectWorkspace).not.toHaveBeenCalled()
  })

  it('stays on the guidance when creating a new session fails', async () => {
    const connectWorkspace = vi.fn().mockRejectedValue(new Error('no workspace'))
    const sessions = makeSessions(undefined, undefined)
    const workspaces = makeWorkspaces('w1', connectWorkspace)
    render(<AiChatPanel sessions={sessions} workspaces={workspaces} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('新建会话'))
    await vi.waitFor(() =>{  expect(connectWorkspace).toHaveBeenCalledWith('w1') })
    expect(screen.getByText('没有正在进行的 AI 会话')).toBeTruthy()
  })

  it('renders the live conversation nodes for the current session', () => {
    const nodes: ConversationNode[] = [
      { kind: 'user', seq: 1, time: 0, content: [{ type: 'text', text: 'hi there' }], source: {} },
      { kind: 'assistant', seq: 2, time: 0, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'hello back' }] },
      {
        kind: 'tool-result', seq: 3, time: 0, callId: 'c', call: { name: 'bash', argsRaw: '{}' }, callTime: 0,
        content: [{ type: 'text', text: 'tool out' }], isError: false,
        callView: null, resultView: null, subCalls: [],
      },
    ]
    const face = makeSession(makeSnap({ nodes, blank: false }))
    const sessions = makeSessions('s1', face)
    const workspaces = makeWorkspaces(undefined)
    render(<AiChatPanel sessions={sessions} workspaces={workspaces} onClose={vi.fn()} />)
    expect(screen.getByText('hi there')).toBeTruthy()
    expect(screen.getByText('hello back')).toBeTruthy()
    expect(screen.getByText('tool out')).toBeTruthy()
  })

  it('renders an in-flight streaming partial underneath the settled nodes', () => {
    const face = makeSession(makeSnap({
      nodes: [{ kind: 'user', seq: 1, time: 0, content: [{ type: 'text', text: 'q' }], source: {} }],
      partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'streaming…' }] },
      running: true,
      blank: false,
    }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText('streaming…')).toBeTruthy()
    expect(screen.getByText('停止')).toBeTruthy()
  })

  it('sends a prompt over the session face on 发送 and moves on running', () => {
    const face = makeSession(makeSnap({ openState: 'open', blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: 'run a query' } })
    fireEvent.click(screen.getByText('发送'))
    expect(face.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'run a query' }], 'queue')
  })

  it('disables the send button while the draft is empty', () => {
    const face = makeSession(makeSnap({ blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect((screen.getByText<HTMLButtonElement>('发送')).disabled).toBe(true)
  })

  it('sends on Enter with a non-empty draft', () => {
    const face = makeSession(makeSnap({ blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: 'go' } })
    // bubbles: true — the onKeyDown handler lives on the wrapping .body div, so
    // a textarea key event must bubble to reach it.
    fireEvent.keyDown(screen.getByPlaceholderText(/输入消息/), { key: 'Enter', bubbles: true })
    expect(face.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'go' }], 'queue')
    expect(face.prompt).toHaveBeenCalledTimes(1)
  })

  it('stops the running turn when the stop button is pressed', () => {
    const face = makeSession(makeSnap({ running: true, blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('停止'))
    expect(face.cancel).toHaveBeenCalled()
  })

  it('loads older messages when 加载更早 is pressed', () => {
    const face = makeSession(makeSnap({ hasMore: true, loadingOlder: false, blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('加载更早'))
    expect(face.loadOlder).toHaveBeenCalled()
  })

  it('hides the composer while the window is loading', () => {
    const face = makeSession(makeSnap({ openState: 'loading' }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/输入消息/)).toBeNull()
  })

  it('shows the open-error and hides the composer on openState error', () => {
    const face = makeSession(makeSnap({ openState: 'error', openError: { message: 'boom' } } as Partial<ConversationSnapshot>))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText(/会话历史打开失败:boom/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/输入消息/)).toBeNull()
  })

  it('shows a prompt failure as an alert strip', () => {
    const face = makeSession(makeSnap({
      promptError: { op: 'send', error: { code: 'x', message: 'sendfailed', details: {} } },
      blank: false,
    } as unknown as Partial<ConversationSnapshot>))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('发送失败: sendfailed')).toBeTruthy()
  })

  it('renders tool-result errors in an error row', () => {
    const nodes: ConversationNode[] = [{
      kind: 'tool-result', seq: 4, time: 0, callId: 'c2', call: null, callTime: null,
      content: [], isError: true, error: { name: 'n', code: '1' },
      callView: null, resultView: null, subCalls: [],
    }]
    const face = makeSession(makeSnap({ nodes, blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText(/! c2/)).toBeTruthy()
  })

  it('renders error/notice/context node roles', () => {
    const nodes: ConversationNode[] = [
      { kind: 'turn-error', seq: 5, time: 0, turn: 1, step: 1, message: 'task failed' },
      { kind: 'turn-max-tokens', seq: 6, time: 0, turn: 1, step: 1 },
      { kind: 'context', seq: 7, time: 0, content: [{ type: 'text', text: 'ctx note' }], source: {}, provenance: { role: 'inject', label: 'ctx' }, form: null },
    ]
    const face = makeSession(makeSnap({ nodes, blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText('task failed')).toBeTruthy()
    expect(screen.getByText('已达输出上限')).toBeTruthy()
    expect(screen.getByText('ctx note')).toBeTruthy()
  })

  it('calls onClose when the close button is pressed', () => {
    const face = makeSession(makeSnap({ blank: false }))
    const sessions = makeSessions('s1', face)
    const onClose = vi.fn()
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={onClose} />)
    fireEvent.click(screen.getByText('关闭'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the cold-window guidance while keeping the composer', () => {
    const face = makeSession(makeSnap({ openState: 'cold' }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText(/会话尚未打开/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/输入消息/)).not.toBeNull()
  })

  it('shows the empty-conversation prompt when there are no messages and it is idle', () => {
    const face = makeSession(makeSnap({ openState: 'open', running: false, blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText(/还没有消息/)).toBeTruthy()
    expect(screen.getByText('空闲')).toBeTruthy()
  })

  it('prevents a second send while a prompt is in flight', () => {
    let resolvePrompt: (value: Awaited<ReturnType<SessionFace['prompt']>>) => void = () => {}
    const base = makeSession(makeSnap({ blank: false }))
    const promptMock = base.prompt
    promptMock.mockImplementation(() => new Promise((resolve) => { resolvePrompt = resolve }))
    const sessions = makeSessions('s1', base)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText(/输入消息/)
    fireEvent.change(input, { target: { value: 'go' } })
    // Two sends while pending: only one prompt call.
    fireEvent.keyDown(input, { key: 'Enter', bubbles: true })
    fireEvent.click(screen.getByText('发送'))
    expect(promptMock).toHaveBeenCalledTimes(1)
    resolvePrompt({ ok: true, value: { accepted: true } })
  })

  it('shows the loading case for the load-older button', () => {
    const face = makeSession(makeSnap({ hasMore: true, loadingOlder: true, blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText('加载中…')).toBeTruthy()
    expect((screen.getByText<HTMLButtonElement>('加载中…')).disabled).toBe(true)
  })

  it('does not send on Shift+Enter or other keys', () => {
    const face = makeSession(makeSnap({ blank: false }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText(/输入消息/)
    fireEvent.change(input, { target: { value: 'go' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, bubbles: true })
    fireEvent.keyDown(input, { key: 'a', bubbles: true })
    expect(face.prompt).not.toHaveBeenCalled()
  })

  it('renders the in-flight partial filtering non-text blocks', () => {
    const face = makeSession(makeSnap({
      nodes: [],
      partial: {
        turn: 1, step: 1,
        blocks: [
          { kind: 'text', text: 'real' },
          { kind: 'tool-call', callId: 'c', name: 'x', argsRaw: '{}' },
          { kind: 'text', text: '' },
        ],
      },
      running: true,
    }))
    const sessions = makeSessions('s1', face)
    render(<AiChatPanel sessions={sessions} workspaces={makeWorkspaces(undefined)} onClose={vi.fn()} />)
    expect(screen.getByText('real')).toBeTruthy()
  })
})
