/**
 * 主壳 AI 连接卡(整体重构 v0.99.0):合并 MFA 验证卡(MfaPromptCard)与堡垒机
 * 「选择机器」浮层(BastionSelectCard)为**一张**统一连接卡。
 *
 * 关键修复:结束信号(ssh:bastion-done / ssh:mfa-connected)改为**组件级监听**,
 * 不再挂在浮层重挂载的 effect 上——此前 BastionSelectCard 的 done 监听挂在
 * `useEffect([prompt])`,prompt 引用一变旧监听先 unlisten、新监听异步注册,
 * 期间到达的 done 事件静默丢失,表现为「命令已执行但按钮卡在『执行中…』、
 * 浮层不关闭」。同时 `ssh_bastion_response` 失败不再被静默吞掉,并加了兜底
 * 超时复位,任何情况按钮都有出口。
 *
 * 订阅(全部带 sessionId 匹配,只接管 `dsh:` 前缀的 AI 域工具会话):
 * - `ssh:kb-interactive`(通用):MFA/2FA 验证码输入
 * - `ssh:bastion-select`(通用):堡垒机选机器(内嵌真实 xterm 实时终端)
 * - `ssh:bastion-done`(通用):选机器/执行阶段结束(成功/失败/超时都发),关闭浮层
 * - `ssh:mfa-connected:<sessionId>`(精确):目标机认证完成反馈
 *
 * 同一时刻至多一张卡(互斥):新请求顶掉旧卡。
 *
 * @module StarHub 主壳 AI 连接卡 (client)
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useTerminalTheme } from '../terminal/terminal-theme.ts'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './StarHubConnCard.module.css'

/** 后端广播的 keyboard-interactive 请求(通用事件,带 sessionId)。 */
interface KbBroadcastEvent {
  sessionId: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
  autoFill: Array<string | null>
}

/** 后端广播的堡垒机「选择机器」请求(通用事件,带 sessionId)。 */
interface BastionSelectEvent {
  sessionId: string
}

/** 后端广播的堡垒机阶段结束信号(通用事件,payload 带 sessionId)。 */
interface BastionDoneEvent {
  sessionId: string
}

/** AI 域工具会话前缀:只接管 `dsh:{assetId}:ssh` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/** 「执行 AI 命令」哨兵:非空即让后端继续执行,空串表示取消。 */
const RUN_SENTINEL = '__run__'

/** 兜底超时(ms):点「执行 AI 命令」后后端未回 done 则复位按钮并提示,
 *  避免事件丢失时按钮永久卡在「执行中…」。45s > 后端 exec 默认 30s 超时。 */
const RUN_FALLBACK_TIMEOUT_MS = 45_000

/** 连接卡状态:同一时刻至多一个阶段。 */
type ConnCardState =
  | { kind: 'mfa'; sessionId: string; prompt: KbBroadcastEvent; connected: boolean }
  | { kind: 'bastion'; sessionId: string; running: boolean; error?: string }
  | null

/**
 * 渲染主壳 AI 连接卡:组件级订阅请求/结束信号,按阶段渲染 MFA 验证表单或
 * 堡垒机实时终端。
 * @returns null 无请求时;否则一张居中连接卡。
 */
export function StarHubConnCard() {
  const [state, setState] = useState<ConnCardState>(null)
  const [mfaAnswers, setMfaAnswers] = useState<string[]>([])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const { theme, termRef } = useTerminalTheme()
  const runTimerRef = useRef<number | null>(null)

  const clearRunTimer = (): void => {
    if (runTimerRef.current !== null) {
      window.clearTimeout(runTimerRef.current)
      runTimerRef.current = null
    }
  }

  // 组件级监听(只注册一次):请求与结束信号都不随浮层重挂载丢失。
  useEffect(() => {
    let disposed = false
    const offs: TauriUnlisten[] = []
    const watch = (p: Promise<TauriUnlisten>): void => {
      void p.then((off) => {
        if (disposed) void off()
        else offs.push(off)
      })
    }

    watch(tauriListen<KbBroadcastEvent>('ssh:kb-interactive', (event) => {
      if (disposed || !event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setMfaAnswers(event.autoFill.map(value => value ?? ''))
      setState({ kind: 'mfa', sessionId: event.sessionId, prompt: event, connected: false })
    }))

    watch(tauriListen<BastionSelectEvent>('ssh:bastion-select', (event) => {
      if (disposed || !event.sessionId.startsWith(AI_CONN_PREFIX)) return
      clearRunTimer()
      setState({ kind: 'bastion', sessionId: event.sessionId, running: false })
    }))

    // 阶段结束信号(成功/失败/超时都发):匹配当前卡即关闭。
    watch(tauriListen<BastionDoneEvent>('ssh:bastion-done', (event) => {
      if (disposed) return
      clearRunTimer()
      setState(prev => (prev !== null && prev.sessionId === event.sessionId) ? null : prev)
    }))

    return () => {
      disposed = true
      for (const off of offs) void off()
      clearRunTimer()
    }
  }, [])

  // MFA 目标机连接成功反馈(精确事件,按当前 mfa 卡 sessionId 订阅)。
  const mfaSessionId = state?.kind === 'mfa' ? state.sessionId : null
  useEffect(() => {
    if (mfaSessionId === null) return
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<void>(`ssh:mfa-connected:${mfaSessionId}`, () => {
      if (disposed) return
      setState(prev => (prev?.kind === 'mfa' && prev.sessionId === mfaSessionId)
        ? { ...prev, connected: true }
        : prev)
    }).then((off) => {
      if (disposed) void off()
      else unlisten = off
    })
    return () => {
      disposed = true
      void unlisten?.()
    }
  }, [mfaSessionId])

  // 堡垒机实时终端:每次浮层打开时新建 xterm,订阅 pty 输出并回传键盘输入。
  const bastionSessionId = state?.kind === 'bastion' ? state.sessionId : null
  useEffect(() => {
    if (bastionSessionId === null) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SF Mono, JetBrains Mono, Fira Code, Consolas, Courier, PingFang SC, Microsoft YaHei',
      fontSize: 13,
      theme,
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    termRef.current = term
    if (hostRef.current !== null) {
      term.open(hostRef.current)
      addon.fit()
    }
    term.focus()

    let disposed = false
    let unlistenOutput: TauriUnlisten | undefined
    let resizeObserver: ResizeObserver | undefined
    const decoder = new TextDecoder()

    const input = term.onData((data) => {
      if (!disposed) {
        void tauriInvoke('ssh_write', { id: bastionSessionId, data }).catch(() => {})
      }
    })

    const resize = (): void => {
      addon.fit()
      if (!disposed) {
        void tauriInvoke('ssh_resize', { id: bastionSessionId, cols: term.cols, rows: term.rows }).catch(() => {})
      }
    }

    void tauriListen<number[]>(`ssh:bastion-output:${bastionSessionId}`, (bytes) => {
      if (disposed) return
      term.write(decoder.decode(new Uint8Array(bytes), { stream: true }))
    }).then((off) => {
      if (disposed) void off()
      else unlistenOutput = off
    })

    resizeObserver = new ResizeObserver(resize)
    if (hostRef.current !== null) resizeObserver.observe(hostRef.current)

    return () => {
      disposed = true
      input.dispose()
      resizeObserver?.disconnect()
      void unlistenOutput?.()
      const tail = decoder.decode()
      if (tail !== '') term.write(tail)
      term.dispose()
      termRef.current = null
    }
  }, [bastionSessionId])

  if (state === null) return null

  // —— 堡垒机选机器 / 执行阶段 ——
  if (state.kind === 'bastion') {
    const cancel = (): void => {
      // 空串 = 用户放弃,后端按取消处理。
      void tauriInvoke('ssh_bastion_response', { id: state.sessionId, selection: '' }).catch(() => {})
      clearRunTimer()
      setState(null)
    }

    const runCommand = (): void => {
      // exactOptionalPropertyTypes:不显式写 error: undefined,清除旧错误用展开覆盖。
      setState(prev => (prev !== null && prev.kind === 'bastion') ? { ...prev, running: true } : prev)
      // 兜底:后端超时未回 done 时复位按钮并提示,避免「执行中…」永久卡死。
      clearRunTimer()
      runTimerRef.current = window.setTimeout(() => {
        setState(prev => (prev?.kind === 'bastion' && prev.running)
          ? { ...prev, running: false, error: '后端未在限定时间内返回,可能已超时,请重试' }
          : prev)
      }, RUN_FALLBACK_TIMEOUT_MS)
      void tauriInvoke('ssh_bastion_response', { id: state.sessionId, selection: RUN_SENTINEL })
        .catch(() => {
          clearRunTimer()
          setState(prev => (prev?.kind === 'bastion')
            ? { ...prev, running: false, error: '通知后端失败,请重试' }
            : prev)
        })
    }

    const assetName = state.sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')
    return (
      <div className={css.backdrop} role="dialog" aria-modal="true" aria-label="堡垒机选择机器">
        <section className={css.card}>
          <header className={css.head}>
            <span className={css.title}>堡垒机选择机器</span>
            <span className={css.hint}>AI 连接 {assetName} 需选择目标机器</span>
          </header>
          <div className={css.body}>
            <div ref={hostRef} className={css.terminal} aria-label="堡垒机终端" />
            <span className={css.timeHint}>
              这是堡垒机真实终端,请像平时一样输入序号选择目标机器;选好后点击「执行 AI 命令」。超过 360 秒未选择连接将断开。
            </span>
            {state.error !== undefined && (
              <span className={css.error} role="alert">{state.error}</span>
            )}
          </div>
          <footer className={css.footer}>
            <button type="button" className={css.cancel} onClick={cancel}>取消</button>
            <button
              type="button"
              className={css.submit}
              onClick={runCommand}
              disabled={state.running}
            >
              {state.running ? '执行中…' : '执行 AI 命令'}
            </button>
          </footer>
        </section>
      </div>
    )
  }

  // —— MFA / 2FA 验证阶段 ——
  const submitMfa = (): void => {
    void tauriInvoke('ssh_kb_response', { id: state.sessionId, responses: mfaAnswers })
      .catch(() => { setState(null) })
    setMfaAnswers([])
  }

  const closeMfa = (): void => {
    setState(null)
    setMfaAnswers([])
  }

  const assetName = state.sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')
  return (
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-label="MFA 验证">
      <section className={css.card}>
        <header className={css.head}>
          <span className={css.title}>MFA 验证</span>
          <span className={css.hint}>AI 连接 {assetName} 需要验证</span>
        </header>
        <div className={css.body}>
          {state.connected ? (
            <div className={css.connected} role="status">
              连接成功,已登录目标机({assetName})。该会话可复用。
            </div>
          ) : (
            <>
              {state.prompt.instructions !== '' && (
                <div className={css.instructions}>{state.prompt.instructions}</div>
              )}
              {state.prompt.prompts.map((prompt, index) => (
                <div className={css.field} key={`${index}-${prompt.prompt}`}>
                  <label className={css.label} htmlFor={`mfa-answer-${index}`}>
                    {prompt.prompt !== '' ? prompt.prompt : '一次性验证码'}
                  </label>
                  <input
                    id={`mfa-answer-${index}`}
                    className={css.input}
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
              <span className={css.timeHint}>请在 360 秒内完成验证,超时连接将断开。</span>
            </>
          )}
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.cancel} onClick={closeMfa}>取消</button>
          {state.connected ? (
            <button type="button" className={css.submit} onClick={closeMfa}>完成</button>
          ) : (
            <button type="button" className={css.submit} onClick={submitMfa}>提交</button>
          )}
        </footer>
      </section>
    </div>
  )
}
