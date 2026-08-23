/**
 * StarHub 原生 SSH 命令广播对话框(需求 6 React 化,broadcast 子集)。
 *
 * 从 Vue `src/components/ssh/BroadcastDialog.vue` 移植:列出所有已连接的 SSH
 * 会话,用户勾选目标 + 输入命令,提交后由调用方经 `ssh_write` 逐会话发送
 * `command\n`。作为纯受控弹层:props 收会话列表,`onClose`/`onSubmit` 回调
 * 返回结果,无副作用,便于 100% 覆盖测试。
 *
 * @module StarHub SSH broadcast dialog (client)
 */

import { useMemo, useState } from 'react'
import css from './BroadcastDialog.module.css'

/** 一个可广播的目标 SSH 会话。 */
export interface BroadcastSession {
  sessionId: string
  title: string
  host: string
}

/** 广播提交结果。 */
export interface BroadcastResult {
  command: string
  sessionIds: string[]
}

/**
 * Render the broadcast dialog: session multi-select + command input.
 * @param props.sessions - connected SSH sessions available as broadcast targets.
 * @param props.onSubmit - invoked with the command and selected session ids.
 * @param props.onClose - invoked on cancel / close / Escape.
 * @returns the dialog overlay (empty render when there are no sessions).
 */
export function BroadcastDialog({
  sessions, onSubmit, onClose,
}: { sessions: BroadcastSession[]; onSubmit: (result: BroadcastResult) => void; onClose: () => void }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(sessions.map(s => s.sessionId)))
  const [command, setCommand] = useState('')

  const allSelected = useMemo(
    () => sessions.length > 0 && selectedIds.size === sessions.length,
    [sessions.length, selectedIds.size],
  )
  const noneSelected = selectedIds.size === 0
  const canSubmit = command.trim() !== '' && !noneSelected

  const toggleSession = (sessionId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const selectAll = (): void =>{  setSelectedIds(new Set(sessions.map(s => s.sessionId))) }
  const deselectAll = (): void =>{  setSelectedIds(new Set()) }

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit({ command: command.trim(), sessionIds: [...selectedIds] })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') onClose()
  }

  if (sessions.length === 0) return null
  return (
    <div className={css.backdrop} onMouseDown={onClose}>
      <div className={css.panel} onMouseDown={(e) =>{  e.stopPropagation() }} role="dialog" aria-label="命令广播">
        <header className={css.header}>
          <div>
            <div className={css.title}>命令广播</div>
            <div className={css.subtitle}>已选 {selectedIds.size} / {sessions.length}</div>
          </div>
          <button type="button" className={css.closeBtn} onClick={onClose} title="关闭">✕</button>
        </header>
        <div className={css.body}>
          <div className={css.selectActions}>
            <button type="button" className={css.smallBtn} onClick={selectAll}>全选</button>
            <button type="button" className={css.smallBtn} onClick={deselectAll}>全不选</button>
            {allSelected && <span className={css.hint}>已全选</span>}
          </div>
          <div className={css.sessionList}>
            {sessions.map(s => (
              <button
                key={s.sessionId}
                type="button"
                className={`${css.sessionRow} ${selectedIds.has(s.sessionId) ? css.sessionSelected : ''}`}
                onClick={() =>{  toggleSession(s.sessionId) }}
              >
                <span className={css.checkbox}>{selectedIds.has(s.sessionId) ? '☑' : '☐'}</span>
                <span className={css.sessionInfo}>
                  <span className={css.sessionTitle}>{s.title}</span>
                  <span className={css.sessionHost}>{s.host}</span>
                </span>
              </button>
            ))}
          </div>
          <input
            className={css.commandInput}
            value={command}
            onChange={(e) =>{  setCommand(e.target.value) }}
            onKeyDown={onKeyDown}
            placeholder="输入要广播执行的命令…"
            aria-label="广播命令"
          />
          <div className={css.warning}>⚠ 该命令将同时对所选所有会话执行,请确认无破坏性操作。</div>
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.secondaryBtn} onClick={onClose}>取消</button>
          <button type="button" className={css.primaryBtn} disabled={!canSubmit} onClick={submit}>广播 ({selectedIds.size})</button>
        </footer>
      </div>
    </div>
  )
}

export default BroadcastDialog
