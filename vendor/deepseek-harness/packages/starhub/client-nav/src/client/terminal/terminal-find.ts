/**
 * 终端内查找:在 xterm 的缓冲区行里定位关键字。
 *
 * xterm 6 未引入官方 search addon,这里用缓冲区快照自己扫:命中后由调用方
 * `term.select(row, col, length)` 高亮 + `term.scrollToLine(row)` 跳到可见
 * 区。纯函数与 xterm 解耦,便于单测。
 *
 * @module StarHub terminal find (client)
 */

/** 一处命中:缓冲区行号 + 行内列 + 长度。 */
export interface FindMatch {
  row: number
  col: number
  length: number
}

/**
 * 在缓冲区行里找出所有命中(大小写不敏感,行内可多处命中)。
 * @param lines - 缓冲区行文本(下标即行号)。
 * @param query - 关键字(空白关键字返回空)。
 * @returns 按行号升序的命中列表。
 */
export function findMatches(lines: readonly string[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const matches: FindMatch[] = []
  for (let row = 0; row < lines.length; row += 1) {
    const line = (lines[row] ?? '').toLowerCase()
    let from = 0
    for (;;) {
      const col = line.indexOf(needle, from)
      if (col === -1) break
      matches.push({ row, col, length: needle.length })
      from = col + needle.length
      if (matches.length >= 1000) return matches
    }
  }
  return matches
}

/**
 * 下一个命中的下标(循环)。
 * @param count - 命中总数。
 * @param current - 当前下标(-1 表示尚无)。
 * @param forward - true 下一个,false 上一个。
 * @returns 新下标;无命中时 -1。
 */
export function stepMatchIndex(count: number, current: number, forward: boolean): number {
  if (count <= 0) return -1
  const base = current < 0 ? (forward ? -1 : 0) : current
  return forward ? (base + 1) % count : (base - 1 + count) % count
}
