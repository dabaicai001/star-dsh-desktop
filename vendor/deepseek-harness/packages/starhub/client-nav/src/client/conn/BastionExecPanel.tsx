/**
 * 堡垒机静默执行迷你面板(功能② v0.99.0):复用路径下 AI 命令直接写入已选
 * 机器的 pty 通道,不再弹「选机器」浮层,用户看不到命令输出。本面板订阅
 * 后端广播的 `ssh:bastion-exec`(通用事件,payload 带 sessionId),在右下角
 * 展示**最近一次**堡垒机命令的简要输出,可折叠/展开/关闭。
 *
 * 组件级监听(只注册一次),不随任何浮层重挂载丢失;只接管 `dsh:` 前缀的
 * AI 域工具会话,与 StarHubConnCard 的请求/结束信号同模式。
 *
 * @module StarHub 堡垒机静默执行面板 (client)
 */
import { useEffect, useState } from 'react'
import { tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './BastionExecPanel.module.css'

/** 后端广播的堡垒机静默执行完成事件(通用事件,带 sessionId)。 */
export interface BastionExecEvent {
  sessionId: string
  command: string
  output: string
}

/** AI 域工具会话前缀:只接管 `dsh:{assetId}:ssh` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/** 输出预览最大行数:超出折叠,避免面板过高。 */
const MAX_PREVIEW_LINES = 12

/**
 * 渲染堡垒机静默执行迷你面板:订阅通用 `ssh:bastion-exec`,最近一次命令
 * 输出常驻右下角(可折叠/关闭)。
 * @returns null 无最近命令时;否则一张右下角可折叠面板。
 */
export function BastionExecPanel() {
  const [latest, setLatest] = useState<BastionExecEvent | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<BastionExecEvent>('ssh:bastion-exec', (event) => {
      if (disposed || !event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setLatest(event)
      setCollapsed(false)
    }).then((off) => {
      if (disposed) void off()
      else unlisten = off
    })
    return () => {
      disposed = true
      void unlisten?.()
    }
  }, [])

  if (latest === null) return null

  const assetName = latest.sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')
  const lines = latest.output.split('\n')
  const preview = lines.length > MAX_PREVIEW_LINES
    ? `${lines.slice(0, MAX_PREVIEW_LINES).join('\n')}\n… (共 ${lines.length} 行)`
    : latest.output

  return (
    <div className={css.panel} role="region" aria-label="堡垒机命令输出">
      <header className={css.head}>
        <button
          type="button"
          className={css.toggle}
          onClick={() => setCollapsed(v => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className={css.title}>堡垒机静默执行</span>
        <span className={css.hint}>{assetName}</span>
        <button
          type="button"
          className={css.close}
          aria-label="关闭输出面板"
          onClick={() => setLatest(null)}
        >
          ×
        </button>
      </header>
      {!collapsed && (
        <div className={css.body}>
          <code className={css.command}>$ {latest.command}</code>
          <pre className={css.output}>{preview}</pre>
        </div>
      )}
    </div>
  )
}
