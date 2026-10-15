/**
 * 终端查找(terminal-find.ts):缓冲区命中扫描(大小写不敏感、行内多处、
 * 空关键字)与循环步进。
 */
import { describe, expect, it } from 'vitest'
import { findMatches, stepMatchIndex } from '../src/client/terminal/terminal-find.ts'

describe('findMatches', () => {
  it('returns nothing for a blank query', () => {
    expect(findMatches(['hello'], '')).toEqual([])
    expect(findMatches(['hello'], '   ')).toEqual([])
  })

  it('finds every occurrence across lines, case-insensitively', () => {
    const matches = findMatches(['Hello world', 'say HELLO again', 'nothing'], 'hello')
    expect(matches).toEqual([
      { row: 0, col: 0, length: 5 },
      { row: 1, col: 4, length: 5 },
    ])
  })

  it('finds multiple hits inside one line', () => {
    expect(findMatches(['ab ab ab'], 'ab')).toEqual([
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 3, length: 2 },
      { row: 0, col: 6, length: 2 },
    ])
  })

  it('tolerates undefined lines in the buffer snapshot', () => {
    expect(findMatches(['ok', undefined as unknown as string], 'ok')).toEqual([{ row: 0, col: 0, length: 2 }])
  })
})

describe('stepMatchIndex', () => {
  it('cycles forward and backward', () => {
    expect(stepMatchIndex(3, 0, true)).toBe(1)
    expect(stepMatchIndex(3, 2, true)).toBe(0)
    expect(stepMatchIndex(3, 0, false)).toBe(2)
    expect(stepMatchIndex(3, 2, false)).toBe(1)
  })

  it('starts at the first hit when stepping forward from nothing', () => {
    expect(stepMatchIndex(3, -1, true)).toBe(0)
    expect(stepMatchIndex(3, -1, false)).toBe(2)
  })

  it('reports no hit when there are no matches', () => {
    expect(stepMatchIndex(0, -1, true)).toBe(-1)
    expect(stepMatchIndex(0, 0, false)).toBe(-1)
  })
})
