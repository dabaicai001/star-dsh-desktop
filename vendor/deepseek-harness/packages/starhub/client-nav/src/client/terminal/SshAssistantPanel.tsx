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
  fetchAssistantCatalog, openAssistant, promptAssistant, setAssistantModel,
  stopAssistant, submitAssistantApproval, subscribeAssistant,
  type AssistantApprovalOutcome, type AssistantCatalog, type AssistantConnCardFrame, type AssistantFrame,
  type AssistantModelOption, type AssistantProviderOption,
} from './assistant-service.ts'
import {
  foldFrame, formatToolArgs, settleApprovalItem, type ChatItem,
} from './assistant-messages.ts'
import { AssistantBastionTerminal } from './AssistantBastionTerminal.tsx'
import { tauriInvoke } from '../tauri.ts'
import css from './SshAssistantPanel.module.css'

/** 「执行 AI 命令」哨兵:非空即让后端继续执行,空串表示取消(与壳内连接卡同契约)。 */
const RUN_SENTINEL = '__run__'

/** 兜底超时(ms):点「执行 AI 命令」后后端未回 done 则复位按钮。 */
const RUN_FALLBACK_TIMEOUT_MS = 45_000

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
  const [connCard, setConnCard] = useState<AssistantConnCardFrame | null>(null)
  const [mfaAnswers, setMfaAnswers] = useState<string[]>([])
  const [bastionRunning, setBastionRunning] = useState(false)
  const [bastionError, setBastionError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const runTimerRef = useRef<number | null>(null)

  const clearRunTimer = useCallback((): void => {
    if (runTimerRef.current !== null) {
      window.clearTimeout(runTimerRef.current)
      runTimerRef.current = null
    }
  }, [])

  // 帧回调:折叠消息 + 跟踪状态/模型/关闭/连接验证卡。
  const onFrame = useCallback((frame: AssistantFrame) => {
    switch (frame.t) {
      case 'status':
        setStatus(frame.status)
        return
      case 'model':
        setModel({ provider: frame.provider, model: frame.model })
        return
      case 'closed':
        setClosed(true)
        return
      case 'kb-interactive':
        setConnCard(frame)
        setMfaAnswers(frame.autoFill.map(value => value ?? ''))
        return
      case 'mfa-connected':
      case 'bastion-select':
      case 'hostkey':
        setConnCard(frame)
        return
      case 'bastion-done':
        clearRunTimer()
        setBastionRunning(false)
        setConnCard(null)
        return
      case 'bastion-output':
        // 堡垒机终端自己订阅 ssh:bastion-output:<connId>(高频字节不走 React
        // 状态),这里无需处理。
        return
      default:
        setItems(prev => foldFrame(prev, frame))
    }
  }, [clearRunTimer])

  // 打开(或复用)助手并订阅流;卸载只退订,不销毁会话。
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    const boot = async (): Promise<void> => {
      try {
        const opened = await openAssistant({ sshSessionId, assetId, assetName })
        if (disposed) {
          // 竞态:面板已卸载(快速切走页签)。助手按 sshSessionId 幂等,下次
          // 进入复用同一会话——这里不能 close:那会毁掉即将被复用的会话,
          // 逼下次挂载重建(对话丢失、agent 泄漏)。本路径还没订阅,直接返回。
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
      clearRunTimer()
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

  /** 提交 MFA 验证码(后端 360s 内等待;成功后由 mfa-connected 帧翻到「已连接」)。 */
  const submitMfa = async (): Promise<void> => {
    if (connCard?.t !== 'kb-interactive') return
    try {
      await tauriInvoke('ssh_kb_response', { id: connCard.connId, responses: mfaAnswers })
    } catch {
      // 提交失败(会话已断):关卡,让用户重发提问。
      setConnCard(null)
    }
    setMfaAnswers([])
  }

  /** 关闭 MFA 卡(不打断后端等待,与壳内连接卡「取消」同语义)。 */
  const closeMfa = (): void => {
    setConnCard(null)
    setMfaAnswers([])
  }

  /** 主机密钥决策:信任并保存 / 仅本次 / 拒绝。 */
  const decideHostkey = async (allowed: boolean, persist: boolean): Promise<void> => {
    if (connCard?.t !== 'hostkey') return
    try {
      await tauriInvoke('ssh_hostkey_response', { id: connCard.connId, allowed, persist })
    } catch {
      // 应答失败:关卡,错误会经助手回合返回。
    }
    setConnCard(null)
  }

  /** 堡垒机:用户已选好机器,放行进入阶段2。 */
  const runBastion = async (): Promise<void> => {
    if (connCard?.t !== 'bastion-select') return
    setBastionRunning(true)
    setBastionError(null)
    // 兜底:后端超时未回 done 时复位按钮并提示(与壳内连接卡同口径)。
    clearRunTimer()
    runTimerRef.current = window.setTimeout(() => {
      setBastionRunning(false)
      setBastionError('后端未在限定时间内返回,可能已超时,请重试')
    }, RUN_FALLBACK_TIMEOUT_MS)
    try {
      await tauriInvoke('ssh_bastion_response', { id: connCard.connId, selection: RUN_SENTINEL })
    } catch {
      clearRunTimer()
      setBastionRunning(false)
      setBastionError('通知后端失败,请重试')
    }
  }

  /** 堡垒机:放弃选择(空串 = 取消)。 */
  const cancelBastion = async (): Promise<void> => {
    if (connCard?.t !== 'bastion-select') return
    clearRunTimer()
    setBastionRunning(false)
    try {
      await tauriInvoke('ssh_bastion_response', { id: connCard.connId, selection: '' })
    } catch {
      // 取消失败同样关卡:后端超时后自会断开。
    }
    setConnCard(null)
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
                {item.streaming === true && <span className={css.streamCaret}>▍</span>}
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
      {connCard !== null && (
        <div className={css.connCard} role="dialog" aria-modal="false">
          {connCard.t === 'kb-interactive' && (
            <>
              <p className={css.connTitle}>MFA 验证</p>
              <p className={css.connHint}>AI 连接 {assetName} 需要验证</p>
              {connCard.instructions !== '' && <p className={css.connInstructions}>{connCard.instructions}</p>}
              {connCard.prompts.map((prompt, index) => (
                <div className={css.connField} key={`${index}-${prompt.prompt}`}>
                  <label className={css.connLabel} htmlFor={`assistant-mfa-${index}`}>
                    {prompt.prompt !== '' ? prompt.prompt : '一次性验证码'}
                  </label>
                  <input
                    id={`assistant-mfa-${index}`}
                    className={css.connInput}
                    type={prompt.echo ? 'text' : 'password'}
                    value={mfaAnswers[index] ?? ''}
                    autoFocus={index === 0}
                    onChange={(event) => {
                      const next = [...mfaAnswers]
                      next[index] = event.target.value
                      setMfaAnswers(next)
                    }}
                  />
                </div>
              ))}
              <span className={css.connTimeHint}>请在 360 秒内完成验证,超时连接将断开。</span>
              <div className={css.connActions}>
                <button type="button" className={css.connCancel} onClick={closeMfa}>取消</button>
                <button type="button" className={css.connSubmit} onClick={() => void submitMfa()}>提交</button>
              </div>
            </>
          )}
          {connCard.t === 'mfa-connected' && (
            <>
              <p className={css.connTitle}>MFA 验证</p>
              <p className={css.connHint}>连接成功,已登录目标机({assetName})。该会话可复用。</p>
              <div className={css.connActions}>
                <button type="button" className={css.connSubmit} onClick={closeMfa}>完成</button>
              </div>
            </>
          )}
          {connCard.t === 'hostkey' && (
            <>
              <p className={css.connTitle}>是否信任此主机?</p>
              <p className={css.connHint}>
                {connCard.remote} · {connCard.keyType} · SHA256:{connCard.sha256}
              </p>
              <div className={css.connActions}>
                <button type="button" className={css.connCancel} onClick={() => void decideHostkey(false, false)}>拒绝</button>
                <button type="button" className={css.connSecondary} onClick={() => void decideHostkey(true, false)}>仅本次</button>
                <button type="button" className={css.connSubmit} onClick={() => void decideHostkey(true, true)}>信任并保存</button>
              </div>
            </>
          )}
          {connCard.t === 'bastion-select' && (
            <>
              <p className={css.connTitle}>堡垒机选择机器</p>
              <p className={css.connHint}>这是堡垒机真实终端,请像平时一样输入序号选择目标机器;选好后点击「执行 AI 命令」。</p>
              <AssistantBastionTerminal connId={connCard.connId} />
              {bastionError !== null && <span className={css.connError} role="alert">{bastionError}</span>}
              <div className={css.connActions}>
                <button type="button" className={css.connCancel} onClick={() => void cancelBastion()}>取消</button>
                <button
                  type="button"
                  className={css.connSubmit}
                  disabled={bastionRunning}
                  onClick={() => void runBastion()}
                >
                  {bastionRunning ? '执行中…' : '执行 AI 命令'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
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
