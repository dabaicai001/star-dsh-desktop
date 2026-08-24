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

/** AI 域工具会话前缀:只接管 `dsh:{assetId}:ssh` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/**
 * 渲染主壳 MFA 验证卡:订阅通用 `ssh:kb-interactive` 事件,仅处理 AI 域
 * 工具会话;用户输入 TOTP 后经 `ssh_kb_response` 回传后端。
 * @returns null 无请求时;否则一张居中验证卡。
 */
export function MfaPromptCard() {
  const [kbPrompt, setKbPrompt] = useState<KbBroadcastEvent | null>(null)
  const [kbAnswers, setKbAnswers] = useState<string[]>([])

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<KbBroadcastEvent>('ssh:kb-interactive', (event) => {
      if (disposed) return
      // 只接管 AI 域工具会话;交互终端 / 测试连接各自有精确事件 UI。
      if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setKbAnswers(event.autoFill.map(value => value ?? ''))
      setKbPrompt(event)
    }).then((off) => {
      if (disposed) void off()
      else unlisten = off
    })
    return () => {
      disposed = true
      void unlisten?.()
    }
  }, [])

  if (kbPrompt === null) return null

  const submit = (): void => {
    void tauriInvoke('ssh_kb_response', { id: kbPrompt.sessionId, responses: kbAnswers }).catch(() => {})
    setKbPrompt(null)
    setKbAnswers([])
  }

  return (
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-label="MFA 验证">
      <section className={css.card}>
        <header className={css.head}>
          <span className={css.title}>MFA 验证</span>
          <span className={css.hint}>AI 连接 {kbPrompt.sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')} 需要验证</span>
        </header>
        <div className={css.body}>
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
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.submit} onClick={submit}>提交验证码</button>
        </footer>
      </section>
    </div>
  )
}