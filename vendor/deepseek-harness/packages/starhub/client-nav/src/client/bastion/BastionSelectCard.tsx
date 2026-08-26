/**
 * 堡垒机「选择机器」浮层(方案A/v0.95.6):承接 AI 域工具(connId `dsh:{assetId}:ssh`)
 * 经 pty 连接堡垒机后,登录壳呈现的「选择机器」交互菜单。
 *
 * 后端 `exec_via_bastion_pty` 广播 `ssh:bastion-select`(负载带 sessionId,菜单文本),
 * 本卡订阅并只接管 `dsh:` 前缀会话;用户选定目标机器后经 `ssh_bastion_response`
 * 回传后端,pending 通道恢复,后端把 AI 命令写入 pty 执行。
 *
 * 菜单文本已由后端剥离 ANSI 控制码;本卡把 GateShell 类「选择机器」菜单解析成
 * 可点击/可键盘上下翻页的条目列表,选中后回传对应行号,后端按 `:{行号}` 跳转。
 *
 * @module StarHub 堡垒机选机器浮层 (client)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import css from './BastionSelectCard.module.css'

/** 后端广播的堡垒机「选择机器」请求负载。 */
export interface BastionSelectEvent {
  sessionId: string
  menu: string
}

/** AI 域工具会话前缀:只接管 `dsh:` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/** 解析出的一行可选项:展示文本 + 提交给后端的跳转值。 */
interface MenuEntry {
  /** 带序号前缀的展示文本(如 「 3  10.0.1.20  db-prod」)。 */
  label: string
  /** 提交给后端的跳转值:优先取行首数字,无数字时用序号占位。 */
  value: string
}

/**
 * 从清洗后的菜单文本解析出可选条目。
 * GateShell 类菜单常见两种形态:
 *  - 行首数字 + 名称/地址(如 「1  web-01  10.0.1.5」),跳转写 `:1`;
 *  - 无编号的纯文本行(逐条目标),没法用冒号跳转时回退为普通输入。
 * 这里尽量提取行首数字作为 value;无数字时仍作为可点击项,value 用行序。
 */
function parseMenuEntries(menu: string): MenuEntry[] {
  const entries: MenuEntry[] = []
  for (const rawLine of menu.split('\n')) {
    const line = rawLine.replace(/\r/g, '').trimEnd()
    // 去掉常用装饰符前缀(如 » 、*、»、箭头等),留下真正内容。
    let text = line
      .replace(/^[\s>·•*▪●○■□►»→]+/, '')
      .replace(/[\s>·•*▪●○■□►»→]+$/, '')
      .trim()
    if (text === '') continue
    // 排除明显是提示/操作说明的行。
    if (/^(quit|move|search|jump|or|use|refresh|the|press|to|cursor|password|show)/i.test(text)) {
      continue
    }
    if (/^(退出|移动|搜索|跳转|请选择|请输入|密码)/.test(text)) {
      continue
    }
    // 提取行首数字作为跳转值。
    const numberMatch = text.match(/^\s*(\d{1,4})\s*/)
    const value = numberMatch !== null ? (numberMatch[1] ?? '') : ''
    // 展示时去掉行首纯数字,避免与序号混排影响可读性。
    if (numberMatch !== null) {
      text = text.slice((numberMatch[0] ?? '').length).trimStart()
    }
    const label = value !== '' ? `${value}  ${text}`.trim() : text
    entries.push({ label, value: value !== '' ? value : String(entries.length + 1) })
  }
  return entries
}

/**
 * 渲染堡垒机选机器浮层:订阅通用 `ssh:bastion-select` 事件,仅处理 AI 域
 * 工具会话;把菜单解析成可点击/方向键选择的列表,回车或点击选中即提交。
 * @returns null 无请求时;否则一张居中浮层。
 */
export function BastionSelectCard() {
  const [prompt, setPrompt] = useState<BastionSelectEvent | null>(null)
  const [selected, setSelected] = useState<number>(-1)
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: TauriUnlisten | undefined
    void tauriListen<BastionSelectEvent>('ssh:bastion-select', (event) => {
      if (disposed) return
      // 只接管 AI 域工具会话;交互终端/其它会话不在此弹浮层。
      if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
      setSelected(-1)
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

  // 每次 prompt 变化时把选中项滚进可视区。
  useEffect(() => {
    if (selected >= 0 && listRef.current !== null) {
      const el = listRef.current.children[selected] as HTMLElement | undefined
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [selected, prompt])

  const entries = useMemo(
    () => (prompt !== null ? parseMenuEntries(prompt.menu) : []),
    [prompt],
  )

  if (prompt === null) return null

  const submit = (value: string): void => {
    void tauriInvoke('ssh_bastion_response', { id: prompt.sessionId, selection: value }).catch(() => {})
    setPrompt(null)
    setSelected(-1)
  }

  const cancel = (): void => {
    void tauriInvoke('ssh_bastion_response', { id: prompt.sessionId, selection: '' }).catch(() => {})
    setPrompt(null)
    setSelected(-1)
  }

  const move = (delta: number): void => {
    if (entries.length === 0) return
    setSelected((prev) => {
      if (prev < 0) return delta > 0 ? 0 : entries.length - 1
      const next = prev + delta
      if (next < 0) return entries.length - 1
      if (next >= entries.length) return 0
      return next
    })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = selected >= 0 ? entries[selected] : entries[0]
      if (chosen !== undefined) submit(chosen.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
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
          {entries.length > 0 ? (
            <>
              <ul
                ref={listRef}
                className={css.menuList}
                role="listbox"
                tabIndex={0}
                onKeyDown={onKeyDown}
              >
                {entries.map((entry, index) => (
                  <li
                    key={`${index}-${entry.value}`}
                    className={selected === index ? css.menuItemSelected : css.menuItem}
                    role="option"
                    aria-selected={selected === index}
                    onClick={() => submit(entry.value)}
                    onMouseEnter={() => setSelected(index)}
                  >
                    {entry.label}
                  </li>
                ))}
              </ul>
              <span className={css.timeHint}>
                使用 ↑/↓ 或 j/k 上下选择,回车确认;超过 360 秒未选择连接将断开。
              </span>
            </>
          ) : (
            <>
              {prompt.menu.trim() !== '' && <pre className={css.menu}>{prompt.menu}</pre>}
              <span className={css.timeHint}>请在 360 秒内完成选择,超时连接将断开。</span>
            </>
          )}
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.cancel} onClick={cancel}>取消</button>
          <button
            type="button"
            className={css.submit}
            onClick={() => {
              const chosen = selected >= 0 ? entries[selected] : entries[0]
              if (chosen !== undefined) submit(chosen.value)
            }}
            disabled={entries.length === 0}
          >
            确认并继续
          </button>
        </footer>
      </section>
    </div>
  )
}
