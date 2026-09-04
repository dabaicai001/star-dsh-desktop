// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DEFAULT_TERMINAL_FONT, TERMINAL_ENCODINGS, TERMINAL_FONTS, normalizeTerminalSettings,
  loadTerminalSettings, saveTerminalSettings, terminalOptions, isTerminalFontPreset,
} from '../src/client/terminal/terminal-settings.ts'
import { SshSettingsTab } from '../src/client/settings/ssh.tsx'

afterEach(() => {
  cleanup()
  localStorage.removeItem('starhub.terminal.settings')
})

describe('terminal settings module', () => {
  it('applies defaults when storage is empty', () => {
    const s = loadTerminalSettings()
    expect(s.fontFamily).toBe(DEFAULT_TERMINAL_FONT)
    expect(s.fontSize).toBe(13)
    expect(s.encoding).toBe('utf-8')
    expect(s.cursorBlink).toBe(true)
  })

  it('normalizes missing/illegal fields back to defaults', () => {
    const s = normalizeTerminalSettings({ fontFamily: '', fontSize: 999, encoding: 'latin1' as never, cursorBlink: 'yes' as never })
    expect(s.fontFamily).toBe(DEFAULT_TERMINAL_FONT)
    expect(s.fontSize).toBe(64) // clamped to the legal range
    expect(s.encoding).toBe('utf-8')
    expect(s.cursorBlink).toBe(true)
  })

  it('clamps fontSize to the legal xterm range', () => {
    expect(normalizeTerminalSettings({ fontSize: 2 }).fontSize).toBe(6)
    expect(normalizeTerminalSettings({ fontSize: 128 }).fontSize).toBe(64)
  })

  it('round-trips a saved settings object', () => {
    saveTerminalSettings({ fontFamily: 'Fira Code', fontSize: 15, encoding: 'gbk', cursorBlink: false })
    const s = loadTerminalSettings()
    expect(s.fontFamily).toBe('Fira Code')
    expect(s.fontSize).toBe(15)
    expect(s.encoding).toBe('gbk')
    expect(s.cursorBlink).toBe(false)
  })

  it('exposes every supported encoding, font presets, and builds terminal options', () => {
    expect(TERMINAL_ENCODINGS).toContain('utf-8')
    expect(TERMINAL_ENCODINGS).toContain('gbk')
    expect(TERMINAL_FONTS.length).toBeGreaterThan(1)
    expect(TERMINAL_FONTS.some(option => option.value === DEFAULT_TERMINAL_FONT)).toBe(true)
    expect(isTerminalFontPreset(DEFAULT_TERMINAL_FONT)).toBe(true)
    expect(isTerminalFontPreset('Some Custom Mono')).toBe(false)
    const opts = terminalOptions({ fontFamily: 'Mono', fontSize: 14, encoding: 'utf-8', cursorBlink: false })
    expect(opts).toEqual({ fontFamily: 'Mono', fontSize: 14, cursorBlink: false })
  })
})

describe('SshSettingsTab', () => {
  it('renders the current settings into the form', () => {
    const jetbrains = TERMINAL_FONTS.find(option => option.label.includes('JetBrains Mono'))?.value ?? ''
    saveTerminalSettings({ fontFamily: jetbrains, fontSize: 16, encoding: 'big5', cursorBlink: false })
    render(<SshSettingsTab />)
    const combo = screen.getAllByRole('combobox')
    const font = combo[0] as HTMLSelectElement
    const encoding = combo[1] as HTMLSelectElement
    expect(font.value).toBe(jetbrains)
    expect((screen.getByDisplayValue('16') as HTMLInputElement).value).toBe('16')
    expect(encoding.value).toBe('big5')
  })

  it('persists edits on 保存 and reflects the saved value', () => {
    const consolas = TERMINAL_FONTS.find(option => option.label === 'Consolas')?.value ?? 'Consolas'
    render(<SshSettingsTab />)
    const combo = screen.getAllByRole('combobox')
    const font = combo[0] as HTMLSelectElement
    expect(font.value).toBe(DEFAULT_TERMINAL_FONT)
    fireEvent.change(font, { target: { value: consolas } })
    const size = screen.getByDisplayValue('13') as HTMLInputElement
    fireEvent.change(size, { target: { value: '14' } })
    fireEvent.click(screen.getByText('保存'))
    expect(screen.getByText('已保存。')).toBeTruthy()
    const s = loadTerminalSettings()
    expect(s.fontFamily).toBe(consolas)
    expect(s.fontSize).toBe(14)
  })

  it('flips cursorBlink via the checkbox', () => {
    render(<SshSettingsTab />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    fireEvent.click(screen.getByText('保存'))
    expect(loadTerminalSettings().cursorBlink).toBe(false)
  })
})
