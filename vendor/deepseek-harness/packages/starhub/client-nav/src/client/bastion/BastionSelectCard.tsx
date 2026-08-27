/**
 * 堡垒机「选择机器」浮层(方案A/v0.95.6,实时终端 v0.98.7):承接 AI 域工具
 * (connId `dsh:{assetId}:ssh`)经 pty 连接堡垒机后,登录壳呈现的「选择机器」
 * 交互。
 *
 * v0.98.7 起不再解析/过滤「选择机器」菜单——后端 `exec_via_bastion_pty` 把
 * pty 输出**原汁原味**流式广播到 `ssh:bastion-output:<sessionId>`,本卡内嵌一个
 * 真实 xterm 终端,用户像平时手动连堡垒机那样直接在终端里敲序号/上下翻选机器;
 * 键盘输入经 `ssh_write` 写回 pty。
 *
 * 用户选好机器后点「执行 AI 命令」,经 `ssh_bastion_response`(非空哨兵)触发
 * 后端阶段2(把 AI 命令写入同一 pty 并采集输出);「取消」传空串表示放弃。
 *
 * @module StarHub 堡垒机选机器浮层 (client)
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './BastionSelectCard.module.css'

/** 后端广播的堡垒机「选择机器」请求负载(打开浮层的触发信号)。 */
export interface BastionSelectEvent {
  sessionId: string
}

/** AI 域工具会话前缀:只接管 `dsh:` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/** 「执行 AI 命令」哨兵:非空即让后端继续执行,空串表示取消。 */
const RUN_SENTINEL = '__run__'

/**
 * 渲染堡垒机选机器浮层:订阅通用 `ssh:bastion-select` 事件,仅处理 AI 域
 * 工具会话;内嵌一个真实 xterm 终端,流式显示 pty 输出并回传键盘输入。
 * @returns null 无请求时;否则一张居中浮层。
 */
export function BastionSelectCard() {
  const [prompt, setPrompt] = useState<BastionSelectEvent | null>(null)
  const [running, setRunning] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<BastionSelectEvent>('ssh:bastion-select', (event) => {
      if (disposed) return
      // 只接管 AI 域工具会话;交互终端/其它会话不在此弹浮层。
      if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setRunning(false)
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

  // 每次浮层打开时新建 xterm,订阅 pty 输出并回传键盘输入。
  useEffect(() => {
    if (prompt === null) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#101822' },
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
    let unlistenDone: TauriUnlisten | undefined
    let resizeObserver: ResizeObserver | undefined
    const decoder = new TextDecoder()

    const input = term.onData((data) => {
      if (!disposed && prompt !== null) {
        void tauriInvoke('ssh_write', { id: prompt.sessionId, data }).catch(() => {})
      }
    })

    const resize = (): void => {
      addon.fit()
      if (!disposed && prompt !== null) {
        void tauriInvoke('ssh_resize', { id: prompt.sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
      }
    }

    void tauriListen<number[]>(`ssh:bastion-output:${prompt.sessionId}`, (bytes) => {
      if (disposed) return
      term.write(decoder.decode(new Uint8Array(bytes), { stream: true }))
    }).then((off) => {
      if (disposed) void off()
      else unlistenOutput = off
    })

    // 阶段2(执行 AI 命令)结束信号(成功/失败/超时都会触发):关闭浮层。
    // 后端 `exec_via_bastion_pty` 在阶段2 收尾统一 emit `ssh:bastion-done:<sessionId>`。
    void tauriListen<void>(`ssh:bastion-done:${prompt.sessionId}`, () => {
      if (disposed) return
      setPrompt(null)
      setRunning(false)
    }).then((off) => {
      if (disposed) void off()
      else unlistenDone = off
    })

    resizeObserver = new ResizeObserver(resize)
    if (hostRef.current !== null) resizeObserver.observe(hostRef.current)

    return () => {
      disposed = true
      input.dispose()
      resizeObserver?.disconnect()
      void unlistenOutput?.()
      void unlistenDone?.()
      const tail = decoder.decode()
      if (tail !== '') term.write(tail)
      term.dispose()
      termRef.current = null
    }
  }, [prompt])

  if (prompt === null) return null

  const submit = (value: string): void => {
    void tauriInvoke('ssh_bastion_response', { id: prompt.sessionId, selection: value }).catch(() => {})
    setPrompt(null)
    setRunning(false)
  }

  const runCommand = (): void => {
    setRunning(true)
    // 非空哨兵:后端恢复 exec_via_bastion_pty 阶段2,把 AI 命令写入 pty 执行。
    void tauriInvoke('ssh_bastion_response', { id: prompt.sessionId, selection: RUN_SENTINEL }).catch(() => {})
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
          <div ref={hostRef} className={css.terminal} aria-label="堡垒机终端" />
          <span className={css.timeHint}>
            这是堡垒机真实终端,请像平时一样输入序号选择目标机器;选好后点击「执行 AI 命令」。超过 360 秒未选择连接将断开。
          </span>
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.cancel} onClick={() => submit('')}>取消</button>
          <button
            type="button"
            className={css.submit}
            onClick={runCommand}
            disabled={running}
          >
            {running ? '执行中…' : '执行 AI 命令'}
          </button>
        </footer>
      </section>
    </div>
  )
}
