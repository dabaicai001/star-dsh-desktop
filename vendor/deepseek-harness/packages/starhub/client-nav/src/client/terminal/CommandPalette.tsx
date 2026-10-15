/**
 * SSH 终端命令面板(Ctrl/⌘+K):把快捷命令、最近命令与终端操作收进一个可
 * 搜索的列表,键盘主导(↑↓ 选择、Enter 执行、Esc 关闭)。
 *
 * @module StarHub SSH terminal command palette (client)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronsUpDownOutlineMedium, IconCloseOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CommandPalette.module.css'

/** 面板里的一条可执行动作。 */
export interface PaletteAction {
  /** 稳定 id(同时用于 React key)。 */
  id: string
  /** 展示名。 */
  label: string
  /** 右侧补充说明(命令原文 / 快捷键)。 */
  hint?: string
  /** 分组标题(同名分组在面板里相邻展示)。 */
  group: string
  /** 执行动作(执行后面板关闭)。 */
  run: () => void
  /** 置灰(如未连接时禁用命令类动作)。 */
  disabled?: boolean
}

/** 命令面板属性。 */
export interface CommandPaletteProps {
  actions: readonly PaletteAction[]
  onClose: () => void
}

/**
 * 过滤并分组动作:匹配展示名 / 补充说明 / 分组名(大小写不敏感)。
 * @param actions - 全部动作。
 * @param query - 搜索词。
 * @returns 保持原顺序的分组列表。
 */
function filterActions(actions: readonly PaletteAction[], query: string): Array<{ group: string; items: PaletteAction[] }> {
  const needle = query.trim().toLowerCase()
  const groups: Array<{ group: string; items: PaletteAction[] }> = []
  for (const action of actions) {
    if (needle !== '') {
      const haystack = `${action.label} ${action.hint ?? ''} ${action.group}`.toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    const last = groups[groups.length - 1]
    if (last !== undefined && last.group === action.group) last.items.push(action)
    else groups.push({ group: action.group, items: [action] })
  }
  return groups
}

/**
 * 渲染命令面板。
 * @param props - 动作清单与关闭回调。
 * @returns 命令面板浮层。
 */
export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const groups = useMemo(() => filterActions(actions, query), [actions, query])
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups])
  const activeId = flat[active]?.id

  useEffect(() => { inputRef.current?.focus() }, [])
  // 搜索词变化后重置选中项,避免下标越界指向别的动作。
  useEffect(() => { setActive(0) }, [query])

  /**
   * 执行选中动作并关闭面板。
   * @param action - 目标动作。
   */
  const run = (action: PaletteAction): void => {
    if (action.disabled === true) return
    onClose()
    action.run()
  }

  return (
    <div
      className={css.backdrop}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section className={css.palette} role="dialog" aria-modal="true" aria-label="终端命令面板">
        <header className={css.head}>
          <span className={css.mark} aria-hidden="true"><IconChevronsUpDownOutlineMedium size={13} /></span>
          <input
            ref={inputRef}
            className={css.input}
            value={query}
            placeholder="搜索命令或终端操作…"
            aria-label="搜索命令或终端操作"
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive(current => flat.length === 0 ? 0 : (current + 1) % flat.length)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive(current => flat.length === 0 ? 0 : (current - 1 + flat.length) % flat.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const action = flat[active]
                if (action !== undefined) run(action)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
          />
          <button type="button" className={css.close} onClick={onClose} title="关闭" aria-label="关闭命令面板">
            <IconCloseOutlineMedium size={14} />
          </button>
        </header>
        <div className={css.list}>
          {groups.map(group => (
            <div className={css.group} key={group.group}>
              <span className={css.groupTitle}>{group.group}</span>
              {group.items.map(action => (
                <button
                  key={action.id}
                  type="button"
                  className={action.id === activeId ? css.itemActive : css.item}
                  disabled={action.disabled === true}
                  onMouseEnter={() => { setActive(flat.indexOf(action)) }}
                  onClick={() => { run(action) }}
                >
                  <span className={css.itemLabel}>{action.label}</span>
                  {action.hint !== undefined && action.hint !== '' && <span className={css.itemHint}>{action.hint}</span>}
                </button>
              ))}
            </div>
          ))}
          {flat.length === 0 && <div className={css.empty}>没有匹配的命令</div>}
        </div>
        <footer className={css.foot}>
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </footer>
      </section>
    </div>
  )
}
