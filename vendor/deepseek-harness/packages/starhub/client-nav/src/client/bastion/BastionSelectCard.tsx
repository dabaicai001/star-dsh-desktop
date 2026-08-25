/**
 * 堡垒机「选择机器」浮层(方案A/v0.95.6):承接 AI 域工具(connId `dsh:{assetId}:ssh`)
 * 经 pty 连接堡垒机后,登录壳呈现的「选择机器」交互菜单。
 *
 * 后端 `exec_via_bastion_pty` 广播 `ssh:bastion-select`(负载带 sessionId,菜单文本),
 * 本卡订阅并只接管 `dsh:` 前缀会话;用户输入目标机器项后经 `ssh_bastion_response`
 * 回传后端,pending 通道恢复,随后后端把 AI 命令写入同一 pty 执行。
 *
 * @module StarHub 堡垒机选机器浮层 (client)
 */
import { useEffect, useState } from 'react'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './BastionSelectCard.module.css'

/** 后端广播的堡垒机「选择机器」请求负载。 */
export interface BastionSelectEvent {
  sessionId: string
  menu: string
}

/** AI 域工具会话前缀:只接管 `dsh:` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/**
 * 渲染堡垒机选机器浮层:订阅通用 `ssh:bastion-select` 事件,仅处理 AI 域
 * 工具会话;显示堡垒机菜单,用户输入目标机器项后提交。
 * @returns null 无请求时;否则一张居中浮层。
 */
export function BastionSelectCard() {
  const [prompt, setPrompt] = useState<BastionSelectEvent | null>(null)
  const [selection, setSelection] = useState('')

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<BastionSelectEvent>('ssh:bastion-select', (event) => {
      if (disposed) return
      // 只接管 AI 域工具会话;交互终端/其它会话不在此弹浮层。
      if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setSelection('')
      setPrompt(event)
    }).then((off) => {
      if (disposed) void off()
      else unlisten = off
    })
    return () => {
      disposed = true
      void unlisten?.()
    }
  }, [])

  if (prompt === null) return null

  const submit = (): void => {
    void tauriInvoke('ssh_bastion_response', { id: prompt.sessionId, selection }).catch(() => {})
    setPrompt(null)
    setSelection('')
  }

  const cancel = (): void => {
    void tauriInvoke('ssh_bastion_response', { id: prompt.sessionId, selection: '' }).catch(() => {})
    setPrompt(null)
    setSelection('')
  }

  return (
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-label="堡垒机选择机器">
      <section className={css.card}>
        <header className={css.head}>
          <span className={css.title}>堡垒机选择机器</span>
          <span className={css.hint}>
            AI 连接 {prompt.sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')} 需选择目标机器
          </span>
        </header>
        <div className={css.body}>
          {prompt.menu.trim() !== '' && (
            <pre className={css.menu}>{prompt.menu}</pre>
          )}
          <div className={css.field}>
            <label className={css.label} htmlFor="bastion-selection">
              目标机器（输入菜单中的序号或名称）
            </label>
            <input
              id="bastion-selection"
              className={css.input}
              value={selection}
              autoFocus
              placeholder="例如 3"
              onChange={(event) => setSelection(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
          </div>
          <span className={css.timeHint}>请在 360 秒内完成选择,超时连接将断开。</span>
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.cancel} onClick={cancel}>取消</button>
          <button type="button" className={css.submit} onClick={submit} disabled={selection.trim() === ''}>
            确认并继续
          </button>
        </footer>
      </section>
    </div>
  )
}
