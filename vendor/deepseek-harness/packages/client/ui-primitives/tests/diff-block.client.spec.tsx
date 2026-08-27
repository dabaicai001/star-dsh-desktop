// @vitest-environment jsdom
// DiffBlock (two-column comparison): the before/after column heads, row-paired
// del/add cells aligned through the LCS pass, context rows pairing unchanged
// lines, spanning path headers and same-file second-hunk gaps, create/delete
// extremes with empty placeholder cells, the `+A -R · N file(s)` footer and
// its singular/plural (totals stay per SIDE, TUI parity), the height cap's
// expand control over the scroll cap, the empty-diffs null render, and the
// copy control writing the LEGACY prefixed diff text (pairing-independent) on
// both the accepted and the refused clipboard paths. writeClipboard's own
// return contract is pinned in terminal-block.spec.tsx (the shared return
// contract), so only its DOM consequence is asserted here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiffBlock, type DiffHunk } from '../src/index.ts'

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

/** Left-column cells as `{ state, text }`, in display order. */
function leftCells(container: HTMLElement): Array<{ state: string; text: string }> {
  return [...container.querySelectorAll('[data-col="left"]')]
    .map(cell => ({ state: cell.getAttribute('data-state') ?? '', text: cell.textContent ?? '' }))
}

/** Right-column cells as `{ state, text }`, in display order. */
function rightCells(container: HTMLElement): Array<{ state: string; text: string }> {
  return [...container.querySelectorAll('[data-col="right"]')]
    .map(cell => ({ state: cell.getAttribute('data-state') ?? '', text: cell.textContent ?? '' }))
}

/** Changed cells only (`del`/`add`), both columns concatenated. */
function changeCellTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-state="del"], [data-state="add"]')]
    .map(cell => cell.textContent ?? '')
}

describe('DiffBlock two-column structure', () => {
  it('draws the before/after column heads with marker prefixes', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'a.ts', oldText: 'old', newText: 'new' }]} />)
    expect(screen.getByText(/− 修改前/)).toBeTruthy()
    expect(screen.getByText(/\+ 修改后/)).toBeTruthy()
    // Both heads exist and the grid has exactly two head cells.
    expect(container.querySelectorAll('[class*="_colHead_"]').length).toBe(2)
  })

  it('aligns an edited line as a del/add pair on the SAME visual row', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'a.ts', oldText: 'const x = 1', newText: 'const x = 2' }]} />)
    const left = leftCells(container)
    const right = rightCells(container)
    expect(left.length).toBe(right.length)
    const index = left.findIndex(cell => cell.state === 'del')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(left[index]).toMatchObject({ state: 'del', text: 'const x = 1' })
    expect(right[index]).toMatchObject({ state: 'add', text: 'const x = 2' })
  })

  it('pairs surrounding context lines across the columns', () => {
    const { container } = render(
      <DiffBlock diffs={[{ path: 'a.ts', oldText: 'keep\nchanged\nend', newText: 'swap\nchanged\nend' }]} />,
    )
    const left = leftCells(container)
    const right = rightCells(container)
    // Row order: changed del|add first, then two paired context rows.
    expect(left[0]?.state).toBe('del')
    expect(right[0]?.state).toBe('add')
    expect(left[1]).toMatchObject({ state: 'context', text: 'changed' })
    expect(right[1]).toMatchObject({ state: 'context', text: 'changed' })
    expect(left[2]).toMatchObject({ state: 'context', text: 'end' })
    expect(right[2]).toMatchObject({ state: 'context', text: 'end' })
  })

  it('renders a create as added-only rows with empty left placeholders', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'notes/new.txt', oldText: null, newText: 'hello\nworld' }]} />)
    const left = leftCells(container)
    const right = rightCells(container)
    expect(changeCellTexts(container)).toEqual(['hello', 'world'])
    expect(changeCellTexts(container)).toEqual(right.filter(c => c.state === 'add').map(c => c.text))
    expect(left.every(cell => cell.state === 'empty' && cell.text === '')).toBe(true)
    expect(container.querySelectorAll('[data-state="del"]').length).toBe(0)
  })

  it('renders a full deletion as removed-only rows with no phantom added cell', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'gone.ts', oldText: 'a\nb', newText: '' }]} />)
    expect(container.querySelectorAll('[data-state="add"]').length).toBe(0)
    expect(leftCells(container).filter(c => c.state === 'del').map(c => c.text)).toEqual(['a', 'b'])
  })

  it('opens a same-file second hunk with a spanning gap instead of repeating the path', () => {
    const { container } = render(<DiffBlock diffs={[
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]} />)
    expect(container.querySelectorAll('[data-span="path"]').length).toBe(1)
    expect(container.querySelectorAll('[data-span="gap"]').length).toBe(1)
    expect(screen.getByText('⋯')).toBeTruthy()
  })

  it('opens each new file with its own spanning path header', () => {
    const { container } = render(<DiffBlock diffs={[
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'b.ts', oldText: 'p', newText: 'q' },
    ]} />)
    expect([...container.querySelectorAll('[data-span="path"]')].map(el => el.textContent)).toEqual(['a.ts', 'b.ts'])
  })

  it('treats a trailing newline as a terminator, not an extra blank line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'n.txt', oldText: null, newText: 'hello\n' }]} />)
    expect(changeCellTexts(container)).toEqual(['hello'])
    expect(screen.getByText('└ +1 -0 · 1 file')).toBeTruthy()
  })

  it('keeps a genuine interior blank line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x\n\ny' }]} />)
    expect(container.querySelectorAll('[data-state="add"]').length).toBe(3)
  })

  it('renders nothing for empty diffs', () => {
    const { container } = render(<DiffBlock diffs={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('DiffBlock footer', () => {
  it('counts added and removed lines and one file', () => {
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: 'a\nb', newText: 'c' }]} />)
    expect(screen.getByText('└ +1 -2 · 1 file')).toBeTruthy()
  })

  it('pluralizes the distinct-file count', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: null, newText: 'x' },
      { path: 'b.ts', oldText: null, newText: 'y' },
    ]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('└ +2 -0 · 2 files')).toBeTruthy()
  })
})

describe('DiffBlock height cap', () => {
  it('shows an expand control past the cap and lifts it when expanded', () => {
    // 12 added lines + empty placeholders + head row overflow the default cap.
    const newText = Array.from({ length: 20 }, (_v, i) => `line ${i + 1}`).join('\n')
    const { container } = render(
      <DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText }]} />,
    )
    const toggle = screen.getByRole('button', { name: /展开其余/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起差异' }).getAttribute('aria-expanded')).toBe('true')
    // Expanding does not remove or add data rows: all 20 added cells stay put.
    expect(container.querySelectorAll('[data-state="add"]').length).toBe(20)
  })

  it('shows no expand control at or under the cap', () => {
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} maxLines={16} />)
    expect(screen.queryByRole('button', { name: /展开其余|收起差异/ })).toBeNull()
  })
})

describe('DiffBlock copy', () => {
  it('copies the legacy prefixed diff text and flips the label on success', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'old', newText: 'new' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    render(<DiffBlock diffs={diffs} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    // Path header, del/add prefixes, and the same-file gap all reach the
    // clipboard exactly as the stacked layout emitted them.
    expect(writeText).toHaveBeenCalledWith('a.ts\n- old\n+ new\n⋯\n- p\n+ q')
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('keeps the label on a refused clipboard write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('ignores a second click while the copied label is showing', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制成功' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
