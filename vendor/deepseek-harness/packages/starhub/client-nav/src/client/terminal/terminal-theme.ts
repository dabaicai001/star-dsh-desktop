/**
 * DSH terminal color helper: the embedded xterm (SSH / Docker exec / bastion)
 * needs a concrete color object (xterm cannot consume CSS custom properties),
 * so this resolves the DS-design terminal palette from the document theme and
 * keeps it in sync as the appearance setting changes.
 */
import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Terminal } from '@xterm/xterm'

/** Terminal palette for one theme (DSH code-block surface + label foreground). */
export interface TerminalTheme {
  background: string
  foreground: string
  // xterm falls back to a white cursor when `cursor` is unset, which is invisible
  // on the near-white light surface. Pin the cursor per theme: the block takes
  // `cursor` and the glyph inside it takes `cursorAccent` (an inverted block uses
  // foreground for the cursor and background for the accent).
  cursor: string
  cursorAccent: string
}

/** Resolve the terminal palette. Dark = DSH neutral code surface; light = near-white surface. */
export function dshTerminalTheme(dark: boolean): TerminalTheme {
  return dark
    ? { background: '#1b1b1c', foreground: '#f9fafb', cursor: '#f9fafb', cursorAccent: '#1b1b1c' }  // neutral-bluish-900 / -50
    : { background: '#f5f6f7', foreground: '#1f2329', cursor: '#1f2329', cursorAccent: '#f5f6f7' }  // neutral-bluish-75 / near-black
}

/**
 * Reactive DSH dark flag + a ref to the current xterm instance. The ref lets a
 * terminal creation effect hand its instance over; whenever `dark` flips, the
 * hook re-applies `dshTerminalTheme` to the held instance (buffer preserved).
 * @returns the resolved theme, the dark flag, and the terminal ref.
 */
export function useTerminalTheme(): { theme: TerminalTheme; dark: boolean; termRef: MutableRefObject<Terminal | null> } {
  const [dark, setDark] = useState<boolean>(() => typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme'))
  const termRef = useRef<Terminal | null>(null)
  const theme = dshTerminalTheme(dark)

  useEffect(() => {
    const update = () => setDark(document.body.hasAttribute('data-ds-dark-theme'))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (term !== null && term.options !== undefined) term.options.theme = dshTerminalTheme(dark)
  }, [dark, termRef])

  return { theme, dark, termRef }
}
