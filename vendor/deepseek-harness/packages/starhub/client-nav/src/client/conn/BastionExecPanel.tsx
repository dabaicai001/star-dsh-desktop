/**
 * SSH 命令执行迷你面板(v0.99.0):所有 ssh_exec(普通 SSH 资产 + 堡垒机首次/
 * 复用路径)完成后,后端广播 `ssh:exec-done`(通用事件,payload 带 sessionId),
 * 本组件在右下角为**每个会话连接**(sessionId)展示一个面板(可同时多个),
 * 显示该连接最近一次命令的简要输出;面板可折叠/展开/关闭,可按住头部
 * 上下拖动(在堆叠中调换顺序)。
 *
 * 组件级监听(只注册一次),不随任何浮层重挂载丢失;只接管 `dsh:` 前缀的
 * AI 域工具会话,与 StarHubConnCard 的请求/结束信号同模式。
 *
 * @module StarHub SSH 命令执行面板 (client)
 */
import { useEffect, useRef, useState } from 'react'
import { tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './BastionExecPanel.module.css'

/** 后端广播的 SSH 命令执行完成事件(通用事件,带 sessionId)。 */
export interface BastionExecEvent {
  sessionId: string
  command: string
  output: string
}

/** AI 域工具会话前缀:只接管 `dsh:{assetId}:ssh` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/** 输出预览最大行数:超出折叠,避免面板过高。 */
const MAX_PREVIEW_LINES = 12

/** 单个面板的 props。 */
interface ExecPanelProps {
  sessionId: string
  event: BastionExecEvent
  /** 面板 DOM ref,供拖拽重排计算鼠标落在哪个面板上。 */
  panelRef: (el: HTMLDivElement | null) => void
  onClose: (sessionId: string) => void
  onDragStart: (sessionId: string, y: number) => void
  onDragMove: (sessionId: string, y: number) => void
  onDragEnd: () => void
}

/** 单块面板:独立折叠/关闭状态,头部空白处可上下拖动(重排)。 */
function ExecPanel({ sessionId, event, panelRef, onClose, onDragStart, onDragMove, onDragEnd }: ExecPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const assetName = sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')
  const lines = event.output.split('\n')
  const preview = lines.length > MAX_PREVIEW_LINES
    ? `${lines.slice(0, MAX_PREVIEW_LINES).join('\n')}\n… (共 ${lines.length} 行)`
    : event.output

  const onHeadPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if ((e.target as HTMLElement).closest('button') !== null) return
    onDragStart(sessionId, e.clientY)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  return (
    <div ref={panelRef} className={css.panel} role="region" aria-label={`SSH 命令输出 ${assetName}`}>
      <header
        className={css.head}
        onPointerDown={onHeadPointerDown}
        onPointerMove={(e) => onDragMove(sessionId, e.clientY)}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        title="按住空白处上下拖动调整位置"
      >
        <button
          type="button"
          className={css.toggle}
          onClick={() => setCollapsed(v => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className={css.title}>SSH 命令执行</span>
        <span className={css.hint}>{assetName}</span>
        <button
          type="button"
          className={css.close}
          aria-label={`关闭 ${assetName} 输出面板`}
          onClick={() => onClose(sessionId)}
        >
          ×
        </button>
      </header>
      {!collapsed && (
        <div className={css.body}>
          <code className={css.command}>$ {event.command}</code>
          <pre className={css.output}>{preview}</pre>
        </div>
      )}
    </div>
  )
}

/**
 * 渲染 SSH 命令执行迷你面板组:订阅通用 `ssh:exec-done`,每个 sessionId 一块
 * 面板,右下角垂直堆叠(可折叠/关闭/拖动重排)。
 * @returns null 无任何命令时;否则右下角面板组。
 */
export function BastionExecPanel() {
  /** sessionId → 最近一次命令事件。 */
  const [events, setEvents] = useState<Record<string, BastionExecEvent>>({})
  /** 堆叠顺序(sessionId,最近更新的排最前)。 */
  const [order, setOrder] = useState<string[]>([])
  const panelsRef = useRef<Record<string, HTMLDivElement | null>>({})
  const dragRef = useRef<{ sessionId: string; index: number } | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<BastionExecEvent>('ssh:exec-done', (event) => {
      if (disposed || !event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setEvents(prev => ({ ...prev, [event.sessionId]: event }))
      // 最近更新的面板置顶。
      setOrder(prev => [event.sessionId, ...prev.filter(id => id !== event.sessionId)])
    }).then((off) => {
      if (disposed) void off()
      else unlisten = off
    })
    return () => {
      disposed = true
      void unlisten?.()
    }
  }, [])

  const closePanel = (sessionId: string): void => {
    setEvents(prev => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setOrder(prev => prev.filter(id => id !== sessionId))
  }

  const onDragStart = (sessionId: string, _y: number): void => {
    dragRef.current = { sessionId, index: order.indexOf(sessionId) }
  }

  const onDragMove = (_sessionId: string, y: number): void => {
    const drag = dragRef.current
    if (drag === null) return
    // 鼠标进入别的面板区域即交换位置(拖拽重排)。
    let target = -1
    for (let i = 0; i < order.length; i++) {
      if (i === drag.index) continue
      const id = order[i]
      if (id === undefined) continue
      const el = panelsRef.current[id]
      if (el === null || el === undefined) continue
      const rect = el.getBoundingClientRect()
      if (y >= rect.top && y <= rect.bottom) {
        target = i
        break
      }
    }
    if (target === -1) return
    const next = [...order]
    const moved = next.splice(drag.index, 1)[0]
    if (moved === undefined) return
    next.splice(target, 0, moved)
    dragRef.current = { sessionId: drag.sessionId, index: target }
    setOrder(next)
  }

  const onDragEnd = (): void => {
    dragRef.current = null
  }

  if (order.length === 0) return null

  return (
    <div className={css.stack} role="region" aria-label="SSH 命令输出面板">
      {order.map(sessionId => {
        const event = events[sessionId]
        if (event === undefined) return null
        return (
          <ExecPanel
            key={sessionId}
            sessionId={sessionId}
            event={event}
            panelRef={(el) => { panelsRef.current[sessionId] = el }}
            onClose={closePanel}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
          />
        )
      })}
    </div>
  )
}
