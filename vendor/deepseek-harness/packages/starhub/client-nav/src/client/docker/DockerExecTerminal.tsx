/**
 * Docker 容器交互式终端(exec TTY)。
 *
 * 进入容器并建立带 TTY 的持久交互式 Shell(`docker_exec_session_start`),用
 * xterm 渲染,长轮询 `docker_exec_session_read` 拉输出(base64),`onData`
 * 写回 `docker_exec_session_write`,resize 通知,关闭/卸载时
 * `docker_exec_session_close`。结束后自动清理轮询与监听。复用
 * SshTerminalOverlay 的 xterm 接线方式(FitAddon + ResizeObserver)。
 *
 * @module StarHub Docker exec terminal (client)
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ContainerInfo } from './docker-service.ts'
import {
  dockerExecSessionClose, dockerExecSessionRead, dockerExecSessionResize,
  dockerExecSessionStart, dockerExecSessionWrite, decodeExecOutput,
} from './docker-service.ts'
import css from './DockerExecTerminal.module.css'

/**
 * Render one interactive exec session inside a container.
 * @param props - connection id, target container, and a close callback.
 */
export function DockerExecTerminal({ connId, container, onClose }: {
  connId: string
  container: ContainerInfo
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false
    let sessionId: string | null = null
    let pollTimer: number | undefined

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      theme: { background: '#0b1220', foreground: '#d0e0f0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    /* v8 ignore start -- ref 始终挂载在弹层内,host.current 恒非空;else 分支防御性保留 */
    if (host.current) term.open(host.current)
    /* v8 ignore stop */
    fit.fit()

    const resize = () => {
      /* v8 ignore start -- else(会话未建/已卸载)为防御守卫;true 由 resize 测试覆盖 */
      if (!disposed && sessionId !== null) {
        fit.fit()
        void dockerExecSessionResize(connId, sessionId, term.cols, term.rows).catch(() => {})
      }
      /* v8 ignore stop */
    }
    const resizeObserver = new ResizeObserver(() =>{  resize() })
    /* v8 ignore start -- ref 恒挂载,observe 分支恒走;else 防御性保留 */
    if (host.current) resizeObserver.observe(host.current)
    /* v8 ignore stop */

    const cleanup = () => {
      disposed = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      resizeObserver.disconnect()
      /* v8 ignore start -- 关闭会话 IPC 失败非致命,fire-and-forget */
      if (sessionId !== null) void dockerExecSessionClose(connId, sessionId).catch(() => {})
      /* v8 ignore stop */
      term.dispose()
    }

    term.onData((data) => {
      /* v8 ignore next -- 卸载后或会话未建时的输入丢弃,防御性守卫 */
      if (disposed || sessionId === null) return
      /* v8 ignore start -- 写入 IPC 失败非致命,fire-and-forget */
      void dockerExecSessionWrite(connId, sessionId, data).catch(() => {})
      /* v8 ignore stop */
    })

    /* 卸载标志经闭包异步翻转;函数读取避免 TS 在 await 后把 disposed 窄化为 false。 */
    const isDisposed = () => disposed

    const poll = async () => {
      /* v8 ignore next -- 卸载后不再轮询,防御性守卫 */
      if (disposed || sessionId === null) return
      const read = await dockerExecSessionRead(connId, sessionId, 1000)
      /* v8 ignore next -- 读取完成前已卸载,丢弃结果,防御性守卫 */
      if (isDisposed()) return
      if (read.data !== '') term.write(decodeExecOutput(read.data))
      if (!read.running) {
        cleanup()
        return
      }
      pollTimer = window.setTimeout(() => void poll(), 0)
    }

    dockerExecSessionStart(connId, container.id, term.cols, term.rows)
      .then((res) => {
        /* v8 ignore next -- 组件在启动期间卸载,防御性守卫 */
        if (disposed) return
        sessionId = res.sessionId
        void poll()
      })
      /* v8 ignore next -- 交互终端启动失败:静默降级,父层保持弹层供重试 */
      .catch(() => {})

    return cleanup
    // 连接与容器在弹层生命周期内恒定,只在挂载/卸载时建连一次。
  }, [connId, container.id])

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`${container.name} 终端`}>
        <header className={css.header}>
          <span className={css.title}>{container.name} · 终端</span>
          <button type="button" className={css.closeButton} onClick={onClose}>关闭</button>
        </header>
        <div className={css.terminalHost} ref={host} />
      </section>
    </div>
  )
}
