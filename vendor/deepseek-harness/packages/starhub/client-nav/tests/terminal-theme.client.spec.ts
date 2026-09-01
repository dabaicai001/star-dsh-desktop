// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { dshTerminalTheme } from '../src/client/terminal/terminal-theme.ts'

describe('dshTerminalTheme', () => {
  it('uses the DSH dark neutral surface when dark', () => {
    expect(dshTerminalTheme(true)).toEqual({ background: '#1b1b1c', foreground: '#f9fafb' })
  })

  it('uses a near-white surface for the light theme', () => {
    const theme = dshTerminalTheme(false)
    expect(theme.background).toBe('#f5f6f7')
    expect(theme.foreground).toBe('#1f2329')
  })

  it('never returns the legacy cyber blue palette', () => {
    expect(dshTerminalTheme(true).background).not.toBe('#0b1220')
    expect(dshTerminalTheme(true).background).not.toBe('#101822')
  })
})
