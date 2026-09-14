/**
 * Git 文本解析纯函数:porcelain v1 -z(未跟踪/暂存/未暂存混合、rename 原路径、
 * 中文与空格路径、畸形字段)、log pretty(多记录/refs 剥括号/空输出)、
 * diff 行分类(文件头先于增删判定)与超长截断。
 */
import { describe, expect, it } from 'vitest'
import {
  capDiff, classifyGitStatus, diffLineKind, GIT_LOG_PRETTY,
  parseGitLogPretty, parseGitStatusZ,
} from '../src/client/git/git-parse.ts'

describe('parseGitStatusZ', () => {
  it('parses untracked, staged, unstaged and mixed entries with spaces/CJK paths', () => {
    const raw = [
      '?? 新建 文件.md',
      'M  src/a.ts',
      ' M src/b.ts',
      'MM src/c.ts',
      'D  gone.ts',
    ].join('\0') + '\0'
    const entries = parseGitStatusZ(raw)
    expect(entries).toHaveLength(5)
    expect(entries[0]).toEqual({ x: '?', y: '?', path: '新建 文件.md' })
    expect(entries[1]).toEqual({ x: 'M', y: ' ', path: 'src/a.ts' })
    expect(entries[2]).toEqual({ x: ' ', y: 'M', path: 'src/b.ts' })
    expect(entries[3]).toEqual({ x: 'M', y: 'M', path: 'src/c.ts' })
    expect(entries[4]).toEqual({ x: 'D', y: ' ', path: 'gone.ts' })
  })

  it('takes the rename original path from the next NUL field', () => {
    const entries = parseGitStatusZ('R  new-name.ts\0old-name.ts\0 M other.ts\0')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ x: 'R', y: ' ', path: 'new-name.ts', origPath: 'old-name.ts' })
    expect(entries[1]).toEqual({ x: ' ', y: 'M', path: 'other.ts' })
  })

  it('keeps a worktree rename without an original path when the field is missing', () => {
    const entries = parseGitStatusZ(' R renamed.ts\0')
    expect(entries).toEqual([{ x: ' ', y: 'R', path: 'renamed.ts' }])
  })

  it('skips empty and malformed fields (missing space separator, too short)', () => {
    expect(parseGitStatusZ('')).toEqual([])
    expect(parseGitStatusZ('\0\0ab\0XY\0M src/x.ts')).toEqual([])
  })
})

describe('classifyGitStatus', () => {
  it('groups entries into staged / unstaged / untracked and skips ignored', () => {
    const entries = parseGitStatusZ(
      'M  staged.ts\0 M work.ts\0MM both.ts\0?? new.ts\0!! ignored.ts\0',
    )
    const groups = classifyGitStatus(entries)
    expect(groups.staged.map(e => e.path)).toEqual(['staged.ts', 'both.ts'])
    expect(groups.unstaged.map(e => e.path)).toEqual(['work.ts', 'both.ts'])
    expect(groups.untracked.map(e => e.path)).toEqual(['new.ts'])
  })

  it('classifies a worktree rename as unstaged only', () => {
    const groups = classifyGitStatus(parseGitStatusZ(' R renamed.ts\0old.ts\0'))
    expect(groups.unstaged).toHaveLength(1)
    expect(groups.staged).toHaveLength(0)
  })

  it('detects merge conflicts (UU/AA/DD) into the conflicts group', () => {
    const entries = parseGitStatusZ(
      'UU both-modified.ts\0AA both-added.ts\0DD both-deleted.ts\0AU added-by-us.ts\0UA added-by-them.ts\0UD deleted-by-us.ts\0DU deleted-by-them.ts\0',
    )
    const groups = classifyGitStatus(entries)
    expect(groups.conflicts).toHaveLength(7)
    expect(groups.conflicts.map(e => e.path)).toEqual([
      'both-modified.ts', 'both-added.ts', 'both-deleted.ts',
      'added-by-us.ts', 'added-by-them.ts', 'deleted-by-us.ts', 'deleted-by-them.ts',
    ])
    // 冲突文件不应再出现在 staged/unstaged 组
    expect(groups.staged).toHaveLength(0)
    expect(groups.unstaged).toHaveLength(0)
  })
})

describe('parseGitLogPretty', () => {
  it('uses the field/record separators matching GIT_LOG_PRETTY', () => {
    expect(GIT_LOG_PRETTY).toBe('%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%d%x1e')
  })

  it('parses records, strips the refs parens and keeps order', () => {
    const raw = [
      ' hash1\x1fh1\x1fAlice\x1f2026-09-10T01:02:03+08:00\x1ffeat: one\x1f (HEAD -> main, origin/main)',
      '',
      'hash2\x1fh2\x1fBob\x1f2026-09-09T00:00:00Z\x1ffix: two\x1f',
    ].join('\x1e')
    const entries = parseGitLogPretty(raw)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      hash: 'hash1', short: 'h1', author: 'Alice',
      date: '2026-09-10T01:02:03+08:00', subject: 'feat: one',
      refs: 'HEAD -> main, origin/main',
    })
    expect(entries[1]?.refs).toBe('')
  })

  it('returns an empty list for empty output and keeps an unparenthesized refs value', () => {
    expect(parseGitLogPretty('')).toEqual([])
    expect(parseGitLogPretty('h\x1fh\x1fA\x1f2026-01-01T00:00:00Z\x1fs\x1fHEAD')[0]?.refs).toBe('HEAD')
  })
})

describe('diffLineKind', () => {
  it('classifies hunk headers before +/- so file headers stay meta', () => {
    expect(diffLineKind('@@ -1,2 +1,3 @@')).toBe('hunk')
    expect(diffLineKind('--- a/x.ts')).toBe('meta')
    expect(diffLineKind('+++ b/x.ts')).toBe('meta')
    expect(diffLineKind('diff --git a/x.ts b/x.ts')).toBe('meta')
    expect(diffLineKind('index 1234567..89abcde 100644')).toBe('meta')
    expect(diffLineKind('\\ No newline at end of file')).toBe('meta')
  })

  it('classifies add/del/context lines', () => {
    expect(diffLineKind('+added')).toBe('add')
    expect(diffLineKind('-removed')).toBe('del')
    expect(diffLineKind(' context')).toBe('context')
    expect(diffLineKind('')).toBe('context')
  })
})

describe('capDiff', () => {
  it('returns short text unchanged and truncates over the limit with a marker', () => {
    expect(capDiff('abc')).toBe('abc')
    const long = 'x'.repeat(150)
    const capped = capDiff(long, 100)
    expect(capped.startsWith('x'.repeat(100))).toBe(true)
    expect(capped.endsWith('…(diff 过长,已截断)')).toBe(true)
    expect(capDiff('y'.repeat(30), 20).length).toBeLessThan(40)
  })
})
