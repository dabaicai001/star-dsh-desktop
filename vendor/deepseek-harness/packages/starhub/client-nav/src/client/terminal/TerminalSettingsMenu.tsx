/**
 * 终端设置浮层(终端工具栏「设置」按钮):字体、字号、光标闪烁、编码、回滚
 * 行数。改动经 `updateTerminalSettings` 写回 localStorage 并通知订阅者,
 * 终端实例即时应用(字号/字体/光标立即生效,编码影响后续解码)。
 *
 * @module StarHub terminal settings menu (client)
 */
import { useEffect, useRef } from 'react'
import { IconCloseOutlineMedium, IconSlidersTwoOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  isTerminalFontPreset, TERMINAL_ENCODINGS, TERMINAL_FONTS, updateTerminalSettings,
  type TerminalSettings,
} from './terminal-settings.ts'
import css from './TerminalSettingsMenu.module.css'

/** 回滚行数可选值。 */
const SCROLLBACK_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '1,000 行', value: 1000 },
  { label: '5,000 行(默认)', value: 5000 },
  { label: '20,000 行', value: 20000 },
  { label: '50,000 行', value: 50000 },
]

/** 设置浮层属性。 */
export interface TerminalSettingsMenuProps {
  /** 当前设置。 */
  settings: TerminalSettings
  /** 关闭浮层。 */
  onClose: () => void
}

/**
 * 渲染终端设置浮层。
 * @param props - 当前设置与关闭回调。
 * @returns 设置浮层。
 */
export function TerminalSettingsMenu({ settings, onClose }: TerminalSettingsMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击浮层外部 / Esc 关闭。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className={css.root} ref={rootRef} role="dialog" aria-label="终端设置">
      <header className={css.head}>
        <span className={css.mark} aria-hidden="true"><IconSlidersTwoOutlineMedium size={13} /></span>
        <span className={css.title}>终端设置</span>
        <button type="button" className={css.close} onClick={onClose} title="关闭" aria-label="关闭终端设置">
          <IconCloseOutlineMedium size={13} />
        </button>
      </header>
      <div className={css.body}>
        <label className={css.row}>
          <span className={css.label}>字体</span>
          <select
            className={css.select}
            value={isTerminalFontPreset(settings.fontFamily) ? settings.fontFamily : ''}
            onChange={(event) => { updateTerminalSettings({ fontFamily: event.target.value }) }}
          >
            {!isTerminalFontPreset(settings.fontFamily) && <option value="">当前:{settings.fontFamily}</option>}
            {TERMINAL_FONTS.map(font => <option key={font.value} value={font.value}>{font.label}</option>)}
          </select>
        </label>
        <label className={css.row}>
          <span className={css.label}>字号</span>
          <span className={css.inline}>
            <input
              className={css.range}
              type="range" min={10} max={22} step={1}
              value={settings.fontSize}
              aria-label="终端字号"
              onChange={(event) => { updateTerminalSettings({ fontSize: Number(event.target.value) }) }}
            />
            <span className={css.value}>{settings.fontSize}px</span>
          </span>
        </label>
        <label className={css.row}>
          <span className={css.label}>光标闪烁</span>
          <input
            className={css.check}
            type="checkbox"
            checked={settings.cursorBlink}
            onChange={(event) => { updateTerminalSettings({ cursorBlink: event.target.checked }) }}
          />
        </label>
        <label className={css.row}>
          <span className={css.label}>编码</span>
          <select
            className={css.select}
            value={settings.encoding}
            onChange={(event) => { updateTerminalSettings({ encoding: event.target.value as TerminalSettings['encoding'] }) }}
          >
            {TERMINAL_ENCODINGS.map(encoding => <option key={encoding} value={encoding}>{encoding}</option>)}
          </select>
        </label>
        <label className={css.row}>
          <span className={css.label}>回滚行数</span>
          <select
            className={css.select}
            value={settings.scrollback}
            onChange={(event) => { updateTerminalSettings({ scrollback: Number(event.target.value) }) }}
          >
            {SCROLLBACK_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <footer className={css.foot}>修改立即生效,并随设置页一起持久化。</footer>
    </div>
  )
}
