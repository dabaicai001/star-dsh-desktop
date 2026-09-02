// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { dshTerminalTheme } from '../src/client/terminal/terminal-theme.ts'

describe('dshTerminalTheme', () => {
  it('uses the DSH dark neutral surface when dark', () => {
    expect(dshTerminalTheme(true)).toEqual({
      background: '#1b1b1c', foreground: '#f9fafb',
      cursor: '#f9fafb', cursorAccent: '#1b1b1c',
    })
  })

  it('uses a near-white surface for the light theme', () => {
    const theme = dshTerminalTheme(false)
    expect(theme.background).toBe('#f5f6f7')
    expect(theme.foreground).toBe('#1f2329')
  })

  it('pins a cursor color instead of xterm’s white default so it stays visible on the near-white light surface', () => {
    const theme = dshTerminalTheme(false)
    // xterm defaults the block cursor to #ffffff (invisible on #f5f6f7); we override it.
    expect(theme.cursor).toBe('#1f2329')
    expect(theme.cursorAccent).toBe('#f5f6f7')
    expect(theme.cursor).not.toBe('#ffffff')
  })

  it('never returns the legacy cyber blue palette', () => {
    expect(dshTerminalTheme(true).background).not.toBe('#0b1220')
    expect(dshTerminalTheme(true).background).not.toBe('#101822')
  })
})
