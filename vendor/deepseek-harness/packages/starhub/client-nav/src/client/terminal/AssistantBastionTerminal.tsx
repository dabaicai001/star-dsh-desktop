/**
 * 助手面板内的堡垒机实时终端:AI exec 连接走堡垒机时,阶段1「选机器」的
 * pty 输出经 `ssh:bastion-output:<connId>` 流式到达,键盘输入经 `ssh_write`
 * 回传;用户选好机器后由面板点「执行 AI 命令」(哨兵 `__run__`)进入阶段2。
 *
 * 与主壳连接卡(StarHubConnCard)同一套事件/命令契约,只是承载物在助手面板里。
 *
 * @module StarHub 助手面板堡垒机终端 (client)
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import { useTerminalTheme } from './terminal-theme.ts'

/** 组件属性。 */
export interface AssistantBastionTerminalProps {
  /** AI exec 连接 id(`dsh:<assetId>:ssh`)。 */
  connId: string
}

/**
 * 渲染堡垒机实时终端。
 * @param props - AI exec 连接 id。
 * @returns 终端宿主元素。
 */
export function AssistantBastionTerminal({ connId }: AssistantBastionTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const { theme, termRef } = useTerminalTheme()

  useEffect(() => {
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
    const decoder = new TextDecoder()

    const input = term.onData((data) => {
      if (!disposed) {
        void tauriInvoke('ssh_write', { id: connId, data }).catch(() => {})
      }
    })

    const resize = (): void => {
      addon.fit()
      if (!disposed) {
        void tauriInvoke('ssh_resize', { id: connId, cols: term.cols, rows: term.rows }).catch(() => {})
      }
    }

    void tauriListen<number[]>(`ssh:bastion-output:${connId}`, (bytes) => {
      if (disposed) return
      term.write(decoder.decode(new Uint8Array(bytes), { stream: true }))
    }).then((off) => {
      if (disposed) void off()
      else unlistenOutput = off
    })

    const resizeObserver = new ResizeObserver(resize)
    if (hostRef.current !== null) resizeObserver.observe(hostRef.current)

    return () => {
      disposed = true
      input.dispose()
      resizeObserver.disconnect()
      void unlistenOutput?.()
      const tail = decoder.decode()
      if (tail !== '') term.write(tail)
      term.dispose()
      termRef.current = null
    }
  }, [connId, theme, termRef])

  return <div ref={hostRef} className="starhub-assistant-bastion" aria-label="堡垒机终端" />
}
