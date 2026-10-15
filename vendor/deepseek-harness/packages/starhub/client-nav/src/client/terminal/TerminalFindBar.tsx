/**
 * 终端查找条(Ctrl/⌘+F):浮在终端区域右上角的细条,显示命中计数并支持
 * 上一个 / 下一个循环跳转。匹配本身由调用方用缓冲区快照算出(见
 * `terminal-find.ts`),这里只负责输入与展示。
 *
 * @module StarHub terminal find bar (client)
 */
import { useEffect, useRef } from 'react'
import { IconChevronDownOutlineMedium, IconChevronUpOutlineMedium, IconCloseOutlineMedium, IconSearchOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TerminalFindBar.module.css'

/** 查找条属性。 */
export interface TerminalFindBarProps {
  /** 当前关键字。 */
  query: string
  /** 关键字变化。 */
  onQueryChange: (query: string) => void
  /** 命中总数。 */
  matchCount: number
  /** 当前命中下标(-1 表示无)。 */
  activeIndex: number
  /** 跳到上一个 / 下一个。 */
  onStep: (forward: boolean) => void
  /** 关闭查找。 */
  onClose: () => void
}

/**
 * 渲染终端查找条。
 * @param props - 关键字、命中状态与回调。
 * @returns 查找条浮层。
 */
export function TerminalFindBar({ query, onQueryChange, matchCount, activeIndex, onStep, onClose }: TerminalFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className={css.bar} role="search" aria-label="终端查找">
      <span className={css.mark} aria-hidden="true"><IconSearchOutlineMedium size={13} /></span>
      <input
        ref={inputRef}
        className={css.input}
        value={query}
        placeholder="在终端输出中查找"
        aria-label="查找内容"
        onChange={(event) => { onQueryChange(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onStep(!event.shiftKey)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <span className={css.count}>
        {query.trim() === '' ? '0/0' : `${matchCount === 0 ? 0 : activeIndex + 1}/${matchCount}`}
      </span>
      <button type="button" className={css.step} onClick={() => { onStep(false) }} title="上一个 (Shift+Enter)" aria-label="上一个匹配">
        <IconChevronUpOutlineMedium size={13} />
      </button>
      <button type="button" className={css.step} onClick={() => { onStep(true) }} title="下一个 (Enter)" aria-label="下一个匹配">
        <IconChevronDownOutlineMedium size={13} />
      </button>
      <button type="button" className={css.step} onClick={onClose} title="关闭查找 (Esc)" aria-label="关闭查找">
        <IconCloseOutlineMedium size={13} />
      </button>
    </div>
  )
}
