/**
 * SSH AI 助手面板:终端页第三个页签,操作已连接的服务器。
 *
 * 形态与 SFTP 侧栏同构(overlay 的 sidePanel 槽)。面板本身无状态权威——
 * 打开(或复用)助手会话后订阅 SSE 流,消息列表由 {@link foldFrame} 从
 * durable log 事件折叠;切走页签只退订,会话由 overlay 卸载时销毁。
 *
 * 模型路由默认取 dsh 设置里的部署默认(助手因此复用同一套模型连接),
 * 顶部选择器可临时切换(仅本助手后续请求生效)。
 *
 * @module StarHub SSH assistant panel (client)
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { IconSendOutlineMedium, IconSparkleMedium, IconStopFillMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  closeAssistant, fetchAssistantCatalog, openAssistant, promptAssistant, setAssistantModel,
  stopAssistant, submitAssistantApproval, subscribeAssistant,
  type AssistantApprovalOutcome, type AssistantCatalog, type AssistantFrame, type AssistantModelOption,
  type AssistantProviderOption,
} from './assistant-service.ts'
import {
  foldFrame, formatToolArgs, settleApprovalItem, type ChatItem,
} from './assistant-messages.ts'
import css from './SshAssistantPanel.module.css'

/** 面板属性:终端会话 id 与绑定资产身份。 */
export interface SshAssistantPanelProps {
  sshSessionId: string
  assetId: string
  assetName: string
  /** 助手打开后回传 assistantId(overlay 据此在卸载时销毁会话)。 */
  onOpened?: (assistantId: string | null) => void
}

/** 助手生命周期状态。 */
type PanelPhase =
  | { kind: 'opening' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

/**
 * 渲染 AI 助手面板。
 * @param props - 终端会话 id 与资产身份。
 * @returns 面板元素。
 */
export function SshAssistantPanel({ sshSessionId, assetId, assetName, onOpened }: SshAssistantPanelProps) {
  const [phase, setPhase] = useState<PanelPhase>({ kind: 'opening' })
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [status, setStatus] = useState<'idle' | 'running'>('idle')
  const [model, setModel] = useState<{ provider: string; model: string } | null>(null)
  const [catalog, setCatalog] = useState<AssistantCatalog | null>(null)
  const [draft, setDraft] = useState('')
  const [closed, setClosed] = useState(false)
  const [dropped, setDropped] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 帧回调:折叠消息 + 跟踪状态/模型/关闭。
  const onFrame = useCallback((frame: AssistantFrame) => {
    if (frame.t === 'status') setStatus(frame.status)
    else if (frame.t === 'model') setModel({ provider: frame.provider, model: frame.model })
    else if (frame.t === 'closed') setClosed(true)
    else setItems(prev => foldFrame(prev, frame))
  }, [])

  // 打开(或复用)助手并订阅流;卸载只退订,不销毁会话。
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    const boot = async (): Promise<void> => {
      try {
        const opened = await openAssistant({ sshSessionId, assetId, assetName })
        if (disposed) {
          // 竞态:面板已卸载(快速切走页签)——助手按 sshSessionId 幂等,
          // 下次进入复用同一会话,这里只需确保不留下孤儿订阅。
          void closeAssistant(opened.assistantId).catch(() => undefined)
          return
        }
        setAssistantId(opened.assistantId)
        setModel({ provider: opened.provider, model: opened.model })
        onOpened?.(opened.assistantId)
        setPhase({ kind: 'ready' })
        void fetchAssistantCatalog()
          .then((next) => { if (!disposed) setCatalog(next) })
          .catch(() => undefined)
        unsubscribe = subscribeAssistant(opened.assistantId, {
          onFrame,
          onDrop: () => { if (!disposed) setDropped(true) },
        })
      } catch (error) {
        if (!disposed) {
          setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void boot()
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [sshSessionId, assetId, assetName, onFrame])

  // 贴底跟随:新消息到达且用户本就贴近底部时滚到底。
  useEffect(() => {
    const node = listRef.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
  }, [items])

  /** 发送一条提问。 */
  const submitDraft = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || assistantId === null) return
    setDraft('')
    try {
      await promptAssistant(assistantId, text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setItems(prev => [...prev, { kind: 'error', id: `send-${String(prev.length)}`, message }])
      setDraft(text)
    }
  }, [assistantId, draft])

  /** 结算审批。 */
  const decide = async (requestId: string, outcome: AssistantApprovalOutcome): Promise<void> => {
    if (assistantId === null) return
    setItems(prev => settleApprovalItem(prev, requestId, outcome))
    try {
      await submitAssistantApproval(assistantId, requestId, outcome)
    } catch {
      // 结算失败(请求已过期):状态由下一次重放/帧纠正,不额外报错。
    }
  }

  /** 切换模型路由。 */
  const chooseProvider = async (event: ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const provider = event.target.value
    const row = catalog?.providers.find(entry => entry.provider === provider)
    const first = row?.models[0]
    if (assistantId === null || row === undefined || first === undefined) return
    try {
      await setAssistantModel(assistantId, provider, first.id)
    } catch {
      // 切换失败:保持原路由(下一帧会把生效值带回来)。
    }
  }

  /** 切换模型。 */
  const chooseModel = async (event: ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const next = event.target.value
    if (assistantId === null || model === null) return
    try {
      await setAssistantModel(assistantId, model.provider, next)
    } catch {
      // 同上。
    }
  }

  if (phase.kind === 'opening') {
    return (
      <div className={css.panel}>
        <div className={css.centered} role="status">正在打开 AI 助手…</div>
      </div>
    )
  }
  if (phase.kind === 'failed') {
    return (
      <div className={css.panel}>
        <div className={css.centered} role="alert">
          <p className={css.failedText}>AI 助手打开失败</p>
          <p className={css.failedDetail}>{phase.message}</p>
          <button type="button" className={css.retryButton} onClick={() =>{  setPhase({ kind: 'opening' }) }}>
            重试
          </button>
        </div>
      </div>
    )
  }

  const providers = catalog?.providers ?? []
  const currentProvider: AssistantProviderOption | undefined =
    providers.find(entry => entry.provider === model?.provider)
  const models: readonly AssistantModelOption[] = currentProvider?.models ?? []
  const running = status === 'running'

  return (
    <div className={css.panel}>
      <header className={css.head}>
        <span className={css.headTitle}>
          <IconSparkleMedium size={13} />
          AI 助手
        </span>
        <span className={css.headHint}>{assetName}</span>
        <span className={css.spacer} />
        {providers.length > 0 && (
          <label className={css.modelPick}>
            <select
              className={css.modelSelect}
              value={model?.provider ?? ''}
              onChange={event => void chooseProvider(event)}
              aria-label="选择模型提供方"
            >
              {providers.map(entry => (
                <option key={entry.provider} value={entry.provider}>{entry.displayName}</option>
              ))}
            </select>
            <select
              className={css.modelSelect}
              value={model?.model ?? ''}
              onChange={event => void chooseModel(event)}
              aria-label="选择模型"
            >
              {models.length === 0 && <option value="">(无可用模型)</option>}
              {models.map(entry => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
        )}
        <span className={running ? css.statusRunning : css.statusIdle} aria-hidden="true" />
      </header>
      <div className={css.list} ref={listRef}>
        {items.length === 0 && !closed && (
          <div className={css.empty}>
            <p>问点什么,或交给它一个任务。</p>
            <p className={css.emptyHint}>
              助手通过本资产的执行会话运行命令(与终端互不干扰);只读命令自动执行,写/风险命令会弹出确认。
            </p>
          </div>
        )}
        {items.map((item, index) => (
          <div key={`${item.kind}-${String(index)}`} className={css[item.kind]}>
            {item.kind === 'user' && <p className={css.userText}>{item.text}</p>}
            {item.kind === 'assistant' && (
              <p className={css.assistantText}>
                {item.text}
                {item.interrupted && <span className={css.interrupted}>（已中断）</span>}
              </p>
            )}
            {item.kind === 'tool' && (
              <div className={css.toolCard}>
                <div className={css.toolHead}>
                  <code className={css.toolName}>{item.name}</code>
                  {item.isError && <span className={css.toolError}>失败</span>}
                </div>
                {item.args !== '' && (
                  <details className={css.toolArgs}>
                    <summary>参数</summary>
                    <pre>{formatToolArgs(item.args)}</pre>
                  </details>
                )}
                {item.output !== null && <pre className={css.toolOutput}>{item.output}</pre>}
              </div>
            )}
            {item.kind === 'approval' && (
              <div className={css.approvalCard}>
                <p className={css.approvalTitle}>
                  确认执行 <code>{item.toolName}</code>
                </p>
                {item.reason !== null && <p className={css.approvalReason}>{item.reason}</p>}
                {item.settled === null
                  ? (
                    <div className={css.approvalActions}>
                      <button
                        type="button"
                        className={css.approvalAllow}
                        onClick={() => void decide(item.requestId, 'allowed-once')}
                      >
                        允许一次
                      </button>
                      <button
                        type="button"
                        className={css.approvalReject}
                        onClick={() => void decide(item.requestId, 'rejected')}
                      >
                        拒绝
                      </button>
                    </div>
                  )
                  : (
                    <p className={css.approvalSettled}>
                      {item.settled === 'allowed-once' ? '已允许' : '已拒绝'}
                    </p>
                  )}
              </div>
            )}
            {item.kind === 'error' && <p className={css.errorText}>{item.message}</p>}
          </div>
        ))}
        {closed && <div className={css.closed}>会话已关闭</div>}
        {dropped && !closed && <div className={css.dropped}>连接中断,重新打开本页签可恢复</div>}
      </div>
      <form
        className={css.composer}
        onSubmit={(event) => {
          event.preventDefault()
          void submitDraft()
        }}
      >
        <textarea
          className={css.input}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            // Enter 发送,Shift+Enter 换行。
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submitDraft()
            }
          }}
          placeholder={running ? '助手执行中,可继续输入(排队)…' : '输入指令或问题(Enter 发送)'}
          rows={2}
          disabled={closed}
          aria-label="AI 助手输入框"
        />
        {running
          ? (
            <button
              type="button"
              className={css.stopButton}
              onClick={() => { if (assistantId !== null) void stopAssistant(assistantId) }}
              title="停止当前回合"
              aria-label="停止"
            >
              <IconStopFillMedium size={14} />
            </button>
          )
          : (
            <button
              type="submit"
              className={css.sendButton}
              disabled={draft.trim() === '' || closed}
              title="发送"
              aria-label="发送"
            >
              <IconSendOutlineMedium size={14} />
            </button>
          )}
      </form>
    </div>
  )
}
