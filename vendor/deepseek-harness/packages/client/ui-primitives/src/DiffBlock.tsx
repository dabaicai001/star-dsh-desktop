// DiffBlock: the inline-diff surface for a file mutation (write/edit). The
// change draws as a TWO-COLUMN comparison: the left column shows the before
// (`-`, error tint), the right column shows the after (`+`, success tint),
// aligned row-by-row through a longest-common-subsequence pass so an edited
// region reads as removed/added cells in the same visual row. One scroller
// owns both columns: vertical scrolling moves them together by construction,
// and horizontal overflow of either column scrolls the whole sheet. File
// headers and same-file hunk gaps span both columns; the `└ +A -R · N
// file(s)` footer keeps counting every line each SIDE contributes (unchanged
// totals from the stacked layout, still distinct-path based), and the copy
// control emits the legacy prefixed diff text regardless of pairing — pairing
// is presentation only. Colors resolve through --dsw-* tokens (tints via
// color-mix); geometry mirrors CodeBlock/TerminalBlock.

import { Fragment, useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { writeClipboard } from './clipboard.ts'
import css from './DiffBlock.module.css'

/**
 * Visible paired rows before the collapsed sheet caps its height behind the
 * expand control (the split layout scrolls instead of slicing rows away), so a
 * diff card and a terminal card fold at the same place.
 */
export const DEFAULT_DIFF_MAX_LINES = 16

/** Row height in px backing --dsl-diff-line-height (kept in step with the CSS). */
const SPLIT_LINE_HEIGHT_PX = 22

/**
 * Upper bound on the LCS table's cells. Beyond it the sides stop pairing (all
 * removed lines stack over all added lines) rather than allocating a huge
 * table — a pathological full-file rewrite renders coarse but stays responsive.
 */
const ALIGN_TABLE_CELL_CAP = 250_000

/**
 * One file's change, in the shape {@link DiffBlock} draws. Structurally the
 * render-intent contract's `FileDiff`, redeclared here so this primitive stays
 * free of the tool contract (the terminal card's decoupling, applied to diffs).
 */
export interface DiffHunk {
  /** The changed file's path, drawn verbatim as the hunk's header (the tool's model-facing path). */
  path: string
  /** Prior content, or `null` for a new file / an overwrite (nothing on the removed side). */
  oldText: string | null
  /** Content after the change (the added side). */
  newText: string
}

export interface DiffBlockProps {
  /** One entry per applied hunk, in file order; empty renders nothing. */
  diffs: DiffHunk[]
  /**
   * Height cap in paired rows before the collapsed sheet scrolls behind the
   * expand control (default {@link DEFAULT_DIFF_MAX_LINES}); expanding lifts
   * the cap instead of revealing sliced-away rows.
   */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Legacy stacked row (path/del/add/gap) used ONLY for the footer counts and the copied text. */
interface StackRow {
  kind: 'path' | 'del' | 'add' | 'gap'
  text: string
}

/** A displayed column cell; `null` draws the empty placeholder opposite a real cell. */
type SideCell = { kind: 'del' | 'add' | 'context'; text: string } | null

/** One rendered split row: spanning chrome, or one aligned left/right pair. */
type SplitRow =
  | { span: { kind: 'path' | 'gap'; text: string } }
  | { left: SideCell; right: SideCell }

/* v8 ignore next 3 -- closed-union backstop; only reached if a row kind is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable diff row kind: ${String(value)}`)
}

/**
 * Split a side's text into its content lines. Empty text is zero lines (a full
 * deletion's `newText` or a create's absent `oldText` side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line —
 * the same terminator rule TerminalBlock applies to command output. An interior
 * blank line (a genuine `\n\n`) survives.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** Context cell helpers keeping the pair constructors terse. */
const ctx = (text: string): NonNullable<SideCell> => ({ kind: 'context', text })

/**
 * Fold each ADJACENT pure-removed run followed by a pure-added run into
 * positionally paired rows (min length; leftovers keep their stack order).
 * The LCS walk alone emits classic diffs — every removed line above every
 * added line — which reads a one-line replacement as two disjoint blocks; the
 * fold puts the edited lines side by side so the comparison sheet reads like
 * before | after. Purely presentational: footer totals and copied text come
 * from {@link buildStackRows} and are unaffected.
 */
function zipAdjacentDelAddRuns(rows: readonly SplitRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]!
    if ('span' in row || row.left === null || row.right !== null) {
      out.push(row)
      index++
      continue
    }
    const dels: Array<{ left: SideCell; right: SideCell }> = []
    while (index < rows.length) {
      const candidate = rows[index]
      if (candidate === undefined || 'span' in candidate || candidate.left === null || candidate.right !== null) break
      dels.push(candidate)
      index++
    }
    const adds: Array<{ left: SideCell; right: SideCell }> = []
    while (index < rows.length) {
      const candidate = rows[index]
      if (candidate === undefined || 'span' in candidate || candidate.right === null || candidate.left !== null) break
      adds.push(candidate)
      index++
    }
    if (adds.length === 0) {
      out.push(...dels)
      continue
    }
    const paired = Math.min(dels.length, adds.length)
    for (let k = 0; k < paired; k++) out.push({ left: dels[k]!.left, right: adds[k]!.right })
    out.push(...dels.slice(paired))
    out.push(...adds.slice(paired))
  }
  return out
}

/**
 * LCS-align the two sides into paired rows. Shared head/tail lines become
 * context pairs without entering the table; only the differing middle does.
 * When that middle exceeds the allocation cap the fallback stacks every
 * removed line above every added line (no fabricated pairings).
 */
function pairSides(oldLines: readonly string[], newLines: readonly string[]): SplitRow[] {
  const rows: SplitRow[] = []
  let start = 0
  const minSide = Math.min(oldLines.length, newLines.length)
  while (start < minSide && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  const emitContextPairs = (from: number, until: number, side: 'head' | 'tail'): void => {
    for (let index = from; index < until; index++) {
      // Head indexes both sides from the top; tail walks back symmetrically.
      const oldIndex = side === 'head' ? index : endOld + (index - start)
      const newIndex = side === 'head' ? index : endNew + (index - start)
      rows.push({ left: ctx(oldLines[oldIndex]!), right: ctx(newLines[newIndex]!) })
    }
  }
  emitContextPairs(0, start, 'head')

  const midOld = oldLines.slice(start, endOld)
  const midNew = newLines.slice(start, endNew)
  const delRow = (text: string): SplitRow => ({ left: { kind: 'del', text }, right: null })
  const addRow = (text: string): SplitRow => ({ left: null, right: { kind: 'add', text } })
  const midRows: SplitRow[] = []
  if (midOld.length === 0) {
    for (const text of midNew) midRows.push(addRow(text))
  } else if (midNew.length === 0 || midOld.length * midNew.length > ALIGN_TABLE_CELL_CAP) {
    for (const text of midOld) midRows.push(delRow(text))
    for (const text of midNew) midRows.push(addRow(text))
  } else {
    const width = midNew.length
    // Lengths of common subsequences of midOld[i..] × midNew[j..]; row-major.
    // Reads assert non-null: every looked-up cell was written earlier this pass.
    const table = new Int32Array((midOld.length + 1) * (width + 1))
    for (let i = midOld.length - 1; i >= 0; i--) {
      for (let j = width - 1; j >= 0; j--) {
        const diagonal = table[(i + 1) * (width + 1) + j + 1]!
        table[i * (width + 1) + j] = midOld[i] === midNew[j]
          ? diagonal + 1
          : Math.max(table[(i + 1) * (width + 1) + j]!, table[i * (width + 1) + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < midOld.length && j < width) {
      if (midOld[i] === midNew[j]) {
        midRows.push({ left: ctx(midOld[i]!), right: ctx(midNew[j]!) })
        i++
        j++
      } else if (table[(i + 1) * (width + 1) + j]! >= table[i * (width + 1) + j + 1]!) {
        midRows.push(delRow(midOld[i]!))
        i++
      } else {
        midRows.push(addRow(midNew[j]!))
        j++
      }
    }
    while (i < midOld.length) { midRows.push(delRow(midOld[i]!)); i++ }
    while (j < width) { midRows.push(addRow(midNew[j]!)); j++ }
  }
  // Fold replacement-style edits into side-by-side pairs.
  rows.push(...zipAdjacentDelAddRuns(midRows))

  // The trimmed tails have equal length by construction; pair them in order.
  for (let offset = 0; offset < oldLines.length - endOld; offset++) {
    rows.push({ left: ctx(oldLines[endOld + offset]!), right: ctx(newLines[endNew + offset]!) })
  }
  return rows
}

/**
 * Flatten the hunks into split display rows: a spanning path header opens each
 * new file; a same-file second hunk (a scattered edit) opens with a `⋯` gap
 * instead of repeating the path.
 */
function buildSplitRows(diffs: readonly DiffHunk[]): SplitRow[] {
  const rows: SplitRow[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    rows.push(prevPath === diff.path
      ? { span: { kind: 'gap', text: '⋯' } }
      : { span: { kind: 'path', text: diff.path } })
    prevPath = diff.path
    const oldSide = diff.oldText === null ? [] : contentLines(diff.oldText)
    rows.push(...pairSides(oldSide, contentLines(diff.newText)))
  }
  return rows
}

/**
 * Flatten the hunks into the LEGACY stacked rows plus the footer counts — kept
 * verbatim from the stacked layout so the copied text and the `+A -R · N
 * files` summary stay byte-identical across front ends (TUI parity). Every
 * old-side line counts toward `removed` and every new-side line toward
 * `added`; the file count is of DISTINCT paths.
 */
function buildStackRows(diffs: readonly DiffHunk[]): { rows: StackRow[]; added: number; removed: number; files: number } {
  const rows: StackRow[] = []
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  let prevPath: string | undefined
  for (const diff of diffs) {
    paths.add(diff.path)
    if (diff.path !== prevPath) rows.push({ kind: 'path', text: diff.path })
    else rows.push({ kind: 'gap', text: '⋯' })
    prevPath = diff.path
    if (diff.oldText !== null) {
      for (const line of contentLines(diff.oldText)) {
        rows.push({ kind: 'del', text: line })
        removed++
      }
    }
    for (const line of contentLines(diff.newText)) {
      rows.push({ kind: 'add', text: line })
      added++
    }
  }
  return { rows, added, removed, files: paths.size }
}

/**
 * The diff text a reader copies: each row's `-`/`+`/path/gap prefix and its
 * content, exactly what the card shows (legacy format, pairing-independent).
 */
function copyText(rows: readonly StackRow[]): string {
  return rows.map((row) => {
    switch (row.kind) {
      case 'del': return `- ${row.text}`
      case 'add': return `+ ${row.text}`
      case 'path': return row.text
      case 'gap': return row.text
      /* v8 ignore next -- closed-union backstop; only reached if a row kind is forged */
      default: return assertNever(row.kind)
    }
  }).join('\n')
}

/** Class for one column cell (tint + marker derive from the state). */
function cellClass(cell: SideCell): string | undefined {
  if (cell === null || cell.kind === 'context') return undefined
  return cell.kind === 'del' ? css.del : css.add
}

/**
 * Render a file mutation as a two-column before/after comparison.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, maxLines = DEFAULT_DIFF_MAX_LINES, className }: DiffBlockProps) {
  const splitRows = useMemo(() => buildSplitRows(diffs), [diffs])
  const { rows, added, removed, files } = useMemo(() => buildStackRows(diffs), [diffs])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(rows)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, rows])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (splitRows.length === 0) return null

  // The sticky column-head row occupies one visual slot inside the capped
  // sheet; expanding lifts the cap instead of slicing rows away.
  const dataRowSlots = Math.max(1, maxLines - 1)
  const hidden = Math.max(0, splitRows.length - dataRowSlots)
  const capped = hidden > 0 && !expanded

  return (
    <div className={clsx(css.block, className)} data-diff="">
      <button type="button" className={css.copyButton} onClick={onCopy}>
        {copied ? '复制成功' : '复制'}
      </button>
      <div className={css.body}>
        <div
          className={css.scroller}
          style={capped ? { maxHeight: `${maxLines * SPLIT_LINE_HEIGHT_PX}px` } : undefined}
        >
          <div className={css.grid}>
            <div className={clsx(css.cell, css.colHead, css.headDel)}>− 修改前</div>
            <div className={clsx(css.cell, css.colHead, css.headAdd)}>+ 修改后</div>
            {splitRows.map((row, index) => ('span' in row ? (
              <div
                key={index}
                className={clsx(css.spanRow, row.span.kind === 'path' ? css.path : css.gap)}
                data-span={row.span.kind}
              >
                {row.span.text}
              </div>
            ) : (
              <Fragment key={index}>
                <div data-col="left" data-state={row.left === null ? 'empty' : row.left.kind} className={clsx(css.cell, cellClass(row.left))}>
                  {row.left === null ? '' : row.left.text}
                </div>
                <div data-col="right" data-state={row.right === null ? 'empty' : row.right.kind} className={clsx(css.cell, cellClass(row.right))}>
                  {row.right === null ? '' : row.right.text}
                </div>
              </Fragment>
            )))}
          </div>
        </div>
        {hidden > 0 && (
          <button
            type="button"
            className={css.expand}
            aria-expanded={expanded}
            aria-label={expanded ? '收起差异' : `展开其余 ${hidden} 行差异`}
            onClick={onToggle}
          >
            {expanded ? '收起' : `… 其余 ${hidden} 行`}
          </button>
        )}
      </div>
      <div className={css.footer}>└ +{added} -{removed} · {files} file{files === 1 ? '' : 's'}</div>
    </div>
  )
}
