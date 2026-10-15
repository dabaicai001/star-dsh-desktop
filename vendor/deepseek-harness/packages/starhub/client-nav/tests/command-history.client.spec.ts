// @vitest-environment jsdom
/**
 * 最近命令(command-history.ts):localStorage 读写与截断、连续重复去重、
 * 输入行还原(单字符 / 批量 / 退格 / 控制字符 / 转义序列 / 多次回车)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCommandHistory, COMMAND_HISTORY_LIMIT, loadCommandHistory, pushCommandHistory, reduceInputLine,
  saveCommandHistory,
} from '../src/client/terminal/command-history.ts'

const STORAGE_KEY = 'starhub:ssh:command-history'

beforeEach(() => { localStorage.clear() })

describe('command history', () => {
  it('loads an empty list when nothing is stored or the payload is malformed', () => {
    expect(loadCommandHistory()).toEqual([])
    localStorage.setItem(STORAGE_KEY, 'not json')
    expect(loadCommandHistory()).toEqual([])
    localStorage.setItem(STORAGE_KEY, '{"cmd":"x"}')
    expect(loadCommandHistory()).toEqual([])
  })

  it('filters malformed entries out of a stored array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { cmd: 'ls', at: 1 },
      { cmd: '', at: 2 },
      { cmd: 'pwd' },
      { at: 3 },
      'nope',
    ]))
    expect(loadCommandHistory()).toEqual([{ cmd: 'ls', at: 1 }])
  })

  it('pushes newest first, drops consecutive duplicates and persists', () => {
    const first = pushCommandHistory([], 'ls')
    expect(first.map(entry => entry.cmd)).toEqual(['ls'])
    const second = pushCommandHistory(first, 'pwd')
    expect(second.map(entry => entry.cmd)).toEqual(['pwd', 'ls'])
    const deduped = pushCommandHistory(second, 'ls')
    expect(deduped.map(entry => entry.cmd)).toEqual(['ls', 'pwd'])
    expect(loadCommandHistory().map(entry => entry.cmd)).toEqual(['ls', 'pwd'])
  })

  it('ignores blank commands and caps the stored list', () => {
    expect(pushCommandHistory([], '   ')).toEqual([])
    const many = Array.from({ length: COMMAND_HISTORY_LIMIT + 10 }, (_, index) => ({ cmd: `cmd-${index}`, at: index }))
    const capped = pushCommandHistory(many, 'newest')
    expect(capped).toHaveLength(COMMAND_HISTORY_LIMIT)
    expect(capped[0]?.cmd).toBe('newest')
    expect(loadCommandHistory()).toHaveLength(COMMAND_HISTORY_LIMIT)
  })

  it('saves and clears explicitly', () => {
    saveCommandHistory([{ cmd: 'ls', at: 1 }])
    expect(loadCommandHistory()).toEqual([{ cmd: 'ls', at: 1 }])
    clearCommandHistory()
    expect(loadCommandHistory()).toEqual([])
  })
})

describe('reduceInputLine', () => {
  it('accumulates printable characters and submits on Enter', () => {
    let state = { line: '', submitted: null as string | null }
    for (const char of 'ls -l') state = reduceInputLine(state.line, char)
    expect(state.line).toBe('ls -l')
    state = reduceInputLine(state.line, '\r')
    expect(state).toEqual({ line: '', submitted: 'ls -l' })
  })

  it('submits a batched chunk that already carries the newline', () => {
    expect(reduceInputLine('', 'uptime\r')).toEqual({ line: '', submitted: 'uptime' })
  })

  it('ignores blank submissions and keeps the buffer', () => {
    expect(reduceInputLine('   ', '\r')).toEqual({ line: '', submitted: null })
    expect(reduceInputLine('ab', '\n')).toEqual({ line: '', submitted: 'ab' })
  })

  it('handles backspace, control characters and escape sequences', () => {
    expect(reduceInputLine('ls', '\x7f')).toEqual({ line: 'l', submitted: null })
    // Ctrl+C / Ctrl+U:放弃当前行
    expect(reduceInputLine('ls', '\x03')).toEqual({ line: '', submitted: null })
    expect(reduceInputLine('ls', '\x15')).toEqual({ line: '', submitted: null })
    // 方向上键:整条转义序列不当输入,行缓冲清空
    expect(reduceInputLine('ls', '\x1b[A')).toEqual({ line: '', submitted: null })
    expect(reduceInputLine('ls', '\x1b')).toEqual({ line: '', submitted: null })
    expect(reduceInputLine('ls', '\x1b[3~')).toEqual({ line: '', submitted: null })
  })

  it('submits the last command of a multi-line chunk', () => {
    expect(reduceInputLine('', 'a\rb\rc\r')).toEqual({ line: '', submitted: 'c' })
  })
})
