/**
 * 主壳 MFA 验证卡(2026-08-24):承接 AI 域工具(connId `dsh:{assetId}:ssh`)
 * 建连时服务器的 keyboard-interactive 请求。
 *
 * 后端 `authenticate_keyboard_interactive` 广播两个事件:
 * - `ssh:kb-interactive:<sessionId>`:交互终端 / 测试连接按精确 id 订阅,各自弹窗;
 * - `ssh:kb-interactive`(通用):本卡订阅,仅接管 `dsh:` 前缀的 AI 域工具会话,
 *   避免与终端(assetId)或测试连接(test-*)重复弹窗。
 *
 * 应答经 `ssh_kb_response` 回传(带 sessionId),由后端 pending 通道恢复认证。
 *
 * 成功信号(2026-08-26):后端在**目标机认证完成、会话落库**后发
 * `ssh:mfa-connected:<sessionId>`——只有真正连上目标机(跳板机/堡垒机选机器
 * 只是中间态)才算连接成功。本卡订阅该事件展示「连接成功,会话可复用」反馈;
 * 前端独立弹窗 UI 待后续轮落地。
 *
 * @module StarHub 主壳 MFA 确认卡 (client)
 */
import { useEffect, useState } from 'react'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './MfaPromptCard.module.css'

/** 后端广播的 keyboard-interactive 请求负载(通用事件带 sessionId)。 */
export interface KbBroadcastEvent {
  sessionId: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
  autoFill: Array<string | null>
}

/** 后端「目标机已连接」精确信号:会话已落库可复用。 */
export interface MfaConnectedEvent {
  sessionId: string
}

/** AI 域工具会话前缀:只接管 `dsh:{assetId}:ssh` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/**
 * 渲染主壳 MFA 验证卡:订阅通用 `ssh:kb-interactive` 事件,仅处理 AI 域
 * 工具会话;用户输入 TOTP 后经 `ssh_kb_response` 回传后端。连接成功后再订阅
 * `ssh:mfa-connected:<sessionId>` 展示「目标机已连接」反馈。
 * @returns null 无请求时;否则一张居中验证卡。
 */
export function MfaPromptCard() {
  const [kbPrompt, setKbPrompt] = useState<KbBroadcastEvent | null>(null)
  const [kbAnswers, setKbAnswers] = useState<string[]>([])
  /** 已确认连接成功的会话 id(供「会话可复用」反馈)。 */
  const [connected, setConnected] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    let unlistenConnected: TauriUnlisten | undefined
    void tauriListen<KbBroadcastEvent>('ssh:kb-interactive', (event) => {
      if (disposed) return
      // 只接管 AI 域工具会话;交互终端 / 测试连接各自有精确事件 UI。
      if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setConnected(null)
      setKbAnswers(event.autoFill.map(value => value ?? ''))
      setKbPrompt(event)
      // 按精确 sessionId 订阅「目标机已连接」信号:后端在认证链(含目标机)
      // 全部完成、会话落库后发射。收到即进入连接成功态。
      void unlistenConnected?.()
      void tauriListen<MfaConnectedEvent>(`ssh:mfa-connected:${event.sessionId}`, () => {
        if (disposed) return
        setConnected(event.sessionId)
      }).then((off) => {
        if (disposed) void off()
        else unlistenConnected = off
      })
    }).then((off) => {
      if (disposed) void off()
      else unlisten = off
    })
    return () => {
      disposed = true
      void unlisten?.()
      void unlistenConnected?.()
    }
  }, [])

  if (kbPrompt === null) return null

  const submit = (): void => {
    void tauriInvoke('ssh_kb_response', { id: kbPrompt.sessionId, responses: kbAnswers }).catch(() => {})
    setKbAnswers([])
  }

  const connectedNow = connected !== null
  const hintPieces = kbPrompt.sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')

  // 关闭整张卡片:连接成功态点击「完成」后关掉,避免「连接成功」态无出口卡死。
  const closeCard = (): void => {
    setKbPrompt(null)
    setConnected(null)
    setKbAnswers([])
  }

  return (
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-label="MFA 验证">
      <section className={css.card}>
        <header className={css.head}>
          <span className={css.title}>MFA 验证</span>
          <span className={css.hint}>AI 连接 {hintPieces} 需要验证</span>
        </header>
        <div className={css.body}>
          {connectedNow ? (
            <div className={css.connected} role="status">
              连接成功,已登录目标机({hintPieces})。该会话可复用。
            </div>
          ) : (
            <>
              {kbPrompt.instructions !== '' && <div className={css.instructions}>{kbPrompt.instructions}</div>}
              {kbPrompt.prompts.map((prompt, index) => (
                <div className={css.field} key={`${index}-${prompt.prompt}`}>
                  <label className={css.label} htmlFor={`mfa-answer-${index}`}>
                    {prompt.prompt !== '' ? prompt.prompt : '一次性验证码'}
                  </label>
                  <input
                    id={`mfa-answer-${index}`}
                    className={css.input}
                    type={prompt.echo ? 'text' : 'password'}
                    value={kbAnswers[index] ?? ''}
                    autoFocus={index === 0}
                    onChange={(event) => {
                      const next = [...kbAnswers]
                      next[index] = event.target.value
                      setKbAnswers(next)
                    }}
                  />
                </div>
              ))}
              <span className={css.timeHint}>请在 360 秒内完成验证,超时连接将断开。</span>
            </>
          )}
        </div>
        <footer className={css.footer}>
          {connectedNow ? (
            <button type="button" className={css.submit} onClick={closeCard}>完成</button>
          ) : (
            <button type="button" className={css.submit} onClick={submit}>提交验证码</button>
          )}
        </footer>
      </section>
    </div>
  )
}