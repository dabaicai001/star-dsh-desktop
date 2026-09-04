// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { dshTerminalTheme } from '../src/client/terminal/terminal-theme.ts'

describe('dshTerminalTheme', () => {
  it('uses the DSH dark neutral surface when dark', () => {
    expect(dshTerminalTheme(true)).toEqual({
      background: '#1b1b1c', foreground: '#f9fafb',
      cursor: '#f9fafb', cursorAccent: '#1b1b1c',
      selectionBackground: 'rgba(125, 162, 230, 0.38)', selectionForeground: '#f9fafb',
      selectionInactiveBackground: 'rgba(125, 162, 230, 0.22)',
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

  it('uses a dark high-contrast selection on the light surface and a translucent blue on dark', () => {
    const light = dshTerminalTheme(false)
    // The default pale-blue reads as a wash on the near-white surface and makes
    // copied text hard to read; pin a dark selection so selected text is legible.
    expect(light.selectionBackground).toMatch(/rgba\(31, 35, 41/)
    expect(light.selectionForeground).toBe('#f5f6f7')
    const dark = dshTerminalTheme(true)
    expect(dark.selectionBackground).toContain('0.38')
    expect(dark.selectionForeground).toBe('#f9fafb')
    expect(dark.selectionBackground).not.toBe(light.selectionBackground)
  })

  it('never returns the legacy cyber blue palette', () => {
    expect(dshTerminalTheme(true).background).not.toBe('#0b1220')
    expect(dshTerminalTheme(true).background).not.toBe('#101822')
  })
})
