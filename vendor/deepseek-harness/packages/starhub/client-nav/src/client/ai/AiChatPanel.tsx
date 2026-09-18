/**
 * In-shell AI chat panel (Option B: shell.overlay standalone panel, not inside
 * the detached workbench windows). It shows the CURRENT shell session's real
 * conversation with live streaming and lets the user send/stop/load-older,
 * reading and writing through the object layer — `sessions.binding(id).session`
 * is a `SessionFace = ISession & ObservableSnapshot<SessionSnapshot>`.
 *
 * This is a deliberate self-drawn departure from the standard ChatView slot
 * seat: the panel lives at root scope (`shell.overlay`), where the framework
 * provides no `useSession`/`useSessions` standard props, so the one feasible
 * route (checkpoint §9) is `bindSnapshotSelector` on the session face.
 *
 * 0.1.6 起会话的会话节点/流式片段不再挂在 SessionSnapshot 上,改由 ui-chat
 * 的 Chat target 发布;本面板经注入的 `chatOf` 读其 legacy 投影(nodes +
 * partial),生命周期面板字段(running / openState / hasMore …)仍读
 * Session 自身快照。
 *
 * @module StarHub AI chat panel (client)
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  ConversationNode, ISessions, IWorkspaces, PartialAssistant, SessionFace, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { nodeRenderData, openStateView, promptErrorView, type NodeRenderData } from './ai-chat-utils.ts'
import css from './AiChatPanel.module.css'

/** 面板消费的 Chat legacy 投影(nodes + 流式 partial)。 */
export interface AiChatSlice {
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
}

/** 裸 observable 源(uSES 形状),由注入侧的 uiConversation Chat target 适配而来。 */
export interface AiChatSource {
  getSnapshot: () => AiChatSlice
  subscribe: (fn: () => void) => () => void
}

/** Props for the in-shell AI chat panel. */
export interface AiChatPanelProps {
  sessions: ISessions
  workspaces: IWorkspaces
  /** 会话 → Chat legacy 投影源;会话未绑定或 Chat target 未装载时为 undefined。 */
  chatOf: (sessionId: SessionId) => AiChatSource | undefined
  onClose: () => void
}

/** rc2 ui-primitives MessageText 的本地替身(0.1.6 删除):字面文本块。 */
function MessageText({ text }: { text: string }) {
  return <div className={css.messageText}>{text}</div>
}

/**
 * Bind the current session and render the embedded chat experience.
 * @param props - sessions/workspaces service faces, chat source and the close callback.
 * @returns the floating chat panel, or the "no session / start" guidance.
 */
export function AiChatPanel({ sessions, workspaces, chatOf, onClose }: AiChatPanelProps) {
  // The session list is a stable bare source; subscribe with the built-in
  // uSES hook (react is a baseline external — shell-side web-react glue is
  // not importable from a dynamic client plugin).
  const list = useSyncExternalStore(
    (fn) => sessions.list.subscribe(fn),
    () => sessions.list.getSnapshot(),
  )
  const currentId = list.current
  return (
    <div className={css.backdrop} role="dialog" aria-label="AI 聊天">
      <section className={css.panel}>
        <ConversationGate
          sessions={sessions}
          workspaces={workspaces}
          chatOf={chatOf}
          sessionId={currentId}
          onClose={onClose}
        />
      </section>
    </div>
  )
}

/** Header + body gate: resolve the target session and render its conversation. */
function ConversationGate({ sessions, workspaces, chatOf, sessionId, onClose }: {
  sessions: ISessions
  workspaces: IWorkspaces
  chatOf: (sessionId: SessionId) => AiChatSource | undefined
  sessionId: SessionId | undefined
  onClose: () => void
}) {
  const [creating, setCreating] = useState(false)
  // binding() returns the SessionBinding (sessionId + SessionFace + ctx); the
  // conversation body only needs the live SessionFace read/write face.
  const sessionFace = sessionId === undefined ? undefined : sessions.binding(sessionId)?.session

  const startNew = (): void => {
    /* v8 ignore next -- reentry guard: the 新建会话 buttons are disabled while creating, so startNew cannot be re-entered from the UI */
    if (creating) return
    setCreating(true)
    // 0.1.6 起 IWorkspaces 不再有 recentWorkspaceId / connectWorkspace:
    // 「最近工作区」取列表首项(Host 侧按近用排序),新建走 sessions.create。
    const target = workspaces.list.getSnapshot().items[0]?.workspaceId
    if (target === undefined) {
      setCreating(false)
      return
    }
    void sessions.create({ workspaceId: target })
      .then((id) => { sessions.open(id) })
      .catch(() => { /* leave the guidance state; user can retry */ })
      .finally(() => { setCreating(false) })
  }

  return (
    <>
      <header className={css.header}>
        <span className={css.title}>AI 聊天</span>
        <span className={css.sub}>{sessionId === undefined ? '无活动会话' : '当前会话 · 实时'}</span>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
      </header>
      {sessionFace === undefined || sessionId === undefined ? (
        <NoSession onCreate={startNew} onClose={onClose} />
      ) : (
        <ConversationBody session={sessionFace} sessionId={sessionId} chatOf={chatOf} />
      )}
    </>
  )
}

/** Guidance shown when there is no current shell session to follow. */
function NoSession({ onCreate, onClose }: { onCreate: () => void; onClose: () => void }) {
  return (
    <div className={css.empty}>
      <div className={css.emptyTitle}>没有正在进行的 AI 会话</div>
      <div>请先在 dsh 主壳开始一个会话,或创建一个新会话后回到本面板继续。</div>
      <div className={css.emptyActions}>
        <button type="button" className={css.newBtn} onClick={onCreate}>新建会话</button>
        <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}

const EMPTY_CHAT_SLICE: AiChatSlice = { nodes: [], partial: null }

/**
 * Subscribe a bound child to the session face (built-in uSES hook, keeping
 * Rules-of-Hooks order when the target switches) and render.
 */
function ConversationBody({ session, sessionId, chatOf }: {
  session: SessionFace
  sessionId: SessionId
  chatOf: (sessionId: SessionId) => AiChatSource | undefined
}) {
  const snap = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.getSnapshot(),
  )
  // Chat legacy 投影(nodes + partial)来自 uiConversation 的 Chat target;
  // 源身份按 sessionId 稳定(注入侧 WeakMap 缓存),useMemo 保住订阅闭包稳定。
  const chat = useMemo(() => chatOf(sessionId), [chatOf, sessionId])
  const chatSnap = useSyncExternalStore(
    useMemo(() => (fn: () => void) => chat?.subscribe(fn) ?? (() => {}), [chat]),
    () => chat?.getSnapshot() ?? EMPTY_CHAT_SLICE,
  )
  const gate = openStateView(snap.openState, snap.openError)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Bottom-follow: keep the latest message visible while streaming.
  useEffect(() => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [chatSnap.nodes, chatSnap.partial, snap.running])

  const nodes = chatSnap.nodes.map(nodeRenderData)

  const canSend = draft.trim() !== '' && !sending
  const send = (): void => {
    const text = draft.trim()
    /* v8 ignore next -- unreachable from the UI: the send button is disabled while the draft is blank or a prompt is in flight */
    if (text === '' || sending) return
    setSending(true)
    setDraft('')
    void session.prompt([{ type: 'text', text }], 'queue').finally(() => { setSending(false) })
  }
  const stop = (): void => { void session.cancel() }
  const loadOlder = (): void => { void session.loadOlder() }
  const promptErr = promptErrorView(snap.promptError)

  return (
    <>
      <div className={css.body}>
        {gate.error ? (
          <div className={css.error}>会话历史打开失败:{gate.errorText}</div>
        ) : snap.openState === 'cold' ? (
          <div className={css.empty}>会话尚未打开,请先在主壳选中该会话。</div>
        ) : (
          <>
            <div className={css.meta}>
              <span>{snap.running ? '● 运行中' : '空闲'}</span>
              {snap.hasMore && (
                <button type="button" className={css.linkBtn} onClick={loadOlder} disabled={snap.loadingOlder}>
                  {snap.loadingOlder ? '加载中…' : '加载更早'}
                </button>
              )}
            </div>
            <div className={css.list} ref={listRef}>
              {nodes.length === 0 && ! snap.running && (
                <div className={css.empty}>还没有消息,输入下方内容开始对话。</div>
              )}
              {nodes.map(n => <MessageRow key={n.key} data={n} />)}
              {chatSnap.partial !== null && (
                <div className={`${css.row} ${css.assistant}`}>
                  <span className={css.label}>助手 …</span>
                  <MessageText text={partialText(chatSnap.partial)} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {promptErr.text !== '' && <div className={css.error} role="alert">{promptErr.text}</div>}
      {!gate.error && !gate.loading && (
        <div className={css.composer} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}>
          <textarea
            className={css.input}
            value={draft}
            onChange={(e) =>{  setDraft(e.target.value) }}
            placeholder="输入消息,Enter 发送,Shift+Enter 换行"
            rows={2}
          />
          {snap.running ? (
            <button type="button" className={css.stopBtn} onClick={stop}>停止</button>
          ) : (
            <button type="button" className={css.sendBtn} onClick={send} disabled={!canSend}>发送</button>
          )}
        </div>
      )}
    </>
  )
}

/** Readable text of the in-flight partial assistant output. */
function partialText(partial: { blocks: readonly { kind: string; text?: string }[] } | null | undefined): string {
  /* v8 ignore next -- the render guard only calls partialText with a non-null partial, so the null/undefined arm is unreachable */
  if (partial === null || partial === undefined) return ''
  const parts: string[] = []
  for (const b of partial.blocks) {
    if ((b.kind === 'text' || b.kind === 'reasoning') && typeof b.text === 'string' && b.text !== '') {
      parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** Render one normalized message node by role. */
function MessageRow({ data }: { data: NodeRenderData }) {
  if (data.role === 'user') {
    return (
      <div className={`${css.row} ${css.user}`}>
        <span className={css.label}>{data.label}</span>
        <MessageText text={data.text} />
      </div>
    )
  }
  if (data.role === 'assistant') {
    return (
      <div className={`${css.row} ${css.assistant}`}>
        <span className={css.label}>{data.label}</span>
        <MessageText text={data.text} />
      </div>
    )
  }
  if (data.role === 'tool') {
    return (
      <div className={`${css.row} ${css.tool} ${data.error ? css.errorRow : ''}`}>
        <span className={css.label}>{data.error ? '! ' : ''}{data.label}</span>
        {data.text !== '' && <MessageText text={data.text} />}
        {data.json !== undefined && (
          <JsonBlock
            label="detail" payload={data.json} defaultOpen={data.error}
            truncatedLabel={(total) => `… 已截断,共 ${total} 字符`}
          />
        )}
      </div>
    )
  }
  if (data.role === 'error') {
    return <div className={`${css.row} ${css.tool} ${css.errorRow}`}><span className={css.label}>! {data.label}</span><MessageText text={data.text} /></div>
  }
  return (
    <div className={`${css.row} ${css.notice}`}><span className={css.label}>{data.label}</span>{data.text !== '' && <MessageText text={data.text} />}</div>
  )
}
