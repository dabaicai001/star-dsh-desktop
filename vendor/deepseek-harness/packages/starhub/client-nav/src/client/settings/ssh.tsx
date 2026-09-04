/**
 * Settings SSH tab:终端显示设置(字体 / 字号 / 编码 / 光标闪烁)。
 *
 * 供 SSH 终端与 Docker exec 终端共同消费。保存经 `updateTerminalSettings`
 * 写 localStorage 并同步给已挂载终端,下一次打开(或已打开)的终端即按新值生效。
 */
import { useState } from 'react'
import {
  TERMINAL_ENCODINGS, TERMINAL_FONTS, isTerminalFontPreset,
  updateTerminalSettings, useTerminalSettings,
  type TerminalEncoding, type TerminalSettings,
} from '../terminal/terminal-settings.ts'
import s from './settings.module.css'

/** SSH 终端设置 tab 内容。 */
export function SshSettingsTab() {
  const settings = useTerminalSettings()
  const [draft, setDraft] = useState<TerminalSettings>(settings)
  const [saved, setSaved] = useState(false)

  const patch = (p: Partial<TerminalSettings>) => {
    setDraft(current => ({ ...current, ...p }))
    setSaved(false)
  }

  const onSave = () => {
    updateTerminalSettings(draft)
    setSaved(true)
  }

  return (
    <div className={s.panel}>
      <h3>SSH 终端</h3>
      <p className={s.hint}>
        设置 SSH 终端与 Docker exec 终端的显示参数。保存后立即生效;字体/编码等
        在下一个新会话打开时按新值创建。
      </p>
      <div className={s.formGrid}>
        <label className={s.formField}>
          <span className={s.fieldLabel}>字体</span>
          <select
            className={s.select}
            value={draft.fontFamily}
            onChange={event => patch({ fontFamily: event.target.value })}
          >
            {!isTerminalFontPreset(draft.fontFamily) && (
              <option value={draft.fontFamily}>当前(自定义):{draft.fontFamily}</option>
            )}
            {TERMINAL_FONTS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className={s.fieldHint}>下拉选择一个预设字体;字体在下一次打开终端时生效。</span>
        </label>
        <label className={s.formField}>
          <span className={s.fieldLabel}>字号(px)</span>
          <input
            className={s.input}
            type="number"
            min={6}
            max={64}
            step={1}
            value={draft.fontSize}
            onChange={event => patch({ fontSize: Number(event.target.value) })}
          />
        </label>
        <label className={s.formField}>
          <span className={s.fieldLabel}>编码</span>
          <select
            className={s.select}
            value={draft.encoding}
            onChange={event => patch({ encoding: event.target.value as TerminalEncoding })}
          >
            {TERMINAL_ENCODINGS.map(enc => (
              <option key={enc} value={enc}>{enc}</option>
            ))}
          </select>
        </label>
        <label className={s.checkboxRow}>
          <input
            type="checkbox"
            checked={draft.cursorBlink}
            onChange={event => patch({ cursorBlink: event.target.checked })}
          />
          光标闪烁
        </label>
      </div>
      <div>
        <button className={s.btnPrimary} onClick={onSave}>保存</button>
      </div>
      {saved && <div className={s.resultText}>已保存。</div>}
    </div>
  )
}
