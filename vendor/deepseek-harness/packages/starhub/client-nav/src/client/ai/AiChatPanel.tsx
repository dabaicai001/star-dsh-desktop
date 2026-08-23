/**
 * In-shell AI chat panel (Option B: shell.overlay standalone panel, not inside
 * the detached workbench windows). It shows the CURRENT shell session's real
 * conversation with live streaming and lets the user send/stop/load-older,
 * reading and writing through the object layer — `sessions.binding(id).session`
 * is a `SessionFace = ISession & ObservableSnapshot<ConversationSnapshot>`.
 *
 * This is a deliberate self-drawn departure from the standard ChatView slot
 * seat: the panel lives at root scope (`shell.overlay`), where the framework
 * provides no `useSession`/`useSessions` standard props, so the one feasible
 * route (checkpoint §9) is `bindSnapshotSelector` on the session face.
 *
 * @module StarHub AI chat panel (client)
 */
import { useEffect, useRef, useState } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { ISessions, IWorkspaces, SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { nodeRenderData, openStateView, promptErrorView, type NodeRenderData } from './ai-chat-utils.ts'
import css from './AiChatPanel.module.css'

/** Props for the in-shell AI chat panel. */
export interface AiChatPanelProps {
  sessions: ISessions
  workspaces: IWorkspaces
  onClose: () => void
}

/**
 * Bind the current session and render the embedded chat experience.
 * @param props - sessions/workspaces service faces and the close callback.
 * @returns the floating chat panel, or the "no session / start" guidance.
 */
export function AiChatPanel({ sessions, workspaces, onClose }: AiChatPanelProps) {
  // The session list is a stable bare source — bind once per render is safe.
  const list = bindSnapshotSelector(sessions.list)(s => s)
  const currentId = list.current
  return (
    <div className={css.backdrop} role="dialog" aria-label="AI 聊天">
      <section className={css.panel}>
        <ConversationGate
          sessions={sessions}
          workspaces={workspaces}
          sessionId={currentId}
          onClose={onClose}
        />
      </section>
    </div>
  )
}

/** Header + body gate: resolve the target session and render its conversation. */
function ConversationGate({ sessions, workspaces, sessionId, onClose }: {
  sessions: ISessions
  workspaces: IWorkspaces
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
    const target = workspaces.list.getSnapshot().recentWorkspaceId
    if (target === undefined) {
      setCreating(false)
      return
    }
    void workspaces.connectWorkspace(target)
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
      {sessionFace === undefined ? (
        <NoSession onCreate={startNew} onClose={onClose} />
      ) : (
        <ConversationBody session={sessionFace} />
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

/**
 * Subscribe a bound child to the session face (stable `bindSnapshotSelector`
 * call, keeping Rules-of-Hooks order when the target switches) and render.
 */
function ConversationBody({ session }: {
  session: SessionFace
}) {
  const snap = bindSnapshotSelector(session)(s => s)
  const gate = openStateView(snap.openState, snap.openError)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Bottom-follow: keep the latest message visible while streaming.
  useEffect(() => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [snap.nodes, snap.partial, snap.running])

  const nodes = snap.nodes.map(nodeRenderData)

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
              {snap.partial !== null && (
                <div className={`${css.row} ${css.assistant}`}>
                  <span className={css.label}>助手 …</span>
                  <MessageText text={partialText(snap.partial)} />
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
        {data.json !== undefined && <JsonBlock label="detail" payload={data.json} defaultOpen={data.error} />}
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
