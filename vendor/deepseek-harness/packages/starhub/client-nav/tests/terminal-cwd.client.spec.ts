// @vitest-environment node
/**
 * 终端 cwd 跟踪(terminal-cwd.ts):OSC 7 提取、pwd 输出解析、ANSI 清理、
 * 提示符分类、隐藏回显过滤器与状态化 tracker 的全部分支。
 */
import { describe, expect, it } from 'vitest'
import {
  createCwdTracker, createHiddenEchoFilter, extractOsc7Cwd, isShellPromptLine,
  normalizeTerminalText, OSC7_INJECT_COMMAND, OSC7_INJECT_ECHO_TEXT,
  parsePwdOutput, stripTerminalControl,
} from '../src/client/terminal/terminal-cwd.ts'

describe('extractOsc7Cwd', () => {
  it('returns null cwd and the full tail when no OSC 7 sequence is present', () => {
    expect(extractOsc7Cwd('plain text')).toEqual({ cwd: null, rest: 'plain text' })
    expect(extractOsc7Cwd('')).toEqual({ cwd: null, rest: '' })
  })

  it('extracts a plain absolute cwd terminated by BEL', () => {
    expect(extractOsc7Cwd('\x1b]7;/home/user\x07')).toEqual({ cwd: '/home/user', rest: '' })
  })

  it('extracts a cwd terminated by the ST escape', () => {
    expect(extractOsc7Cwd('\x1b]7;/opt\x1b\\')).toEqual({ cwd: '/opt', rest: '' })
  })

  it('strips the file:// scheme and host prefix from the cwd', () => {
    expect(extractOsc7Cwd('\x1b]7;file://host/var/www\x07')).toEqual({ cwd: '/var/www', rest: '' })
  })

  it('strips file:// with an empty host', () => {
    expect(extractOsc7Cwd('\x1b]7;file:///srv\x07')).toEqual({ cwd: '/srv', rest: '' })
  })

  it('keeps relative captured text out of the cwd', () => {
    expect(extractOsc7Cwd('\x1b]7;relative\x07')).toEqual({ cwd: null, rest: '' })
    expect(extractOsc7Cwd('\x1b]7;file://host\x07')).toEqual({ cwd: null, rest: '' })
  })

  it('keeps the latest match and the unconsumed tail', () => {
    expect(extractOsc7Cwd('\x1b]7;/a\x07\x1b]7;/b\x07tail'))
      .toEqual({ cwd: '/b', rest: 'tail' })
  })

  it('caps the rest at OSC7_TAIL_KEEP characters', () => {
    const result = extractOsc7Cwd(`\x1b]7;/a\x07${'y'.repeat(600)}`)
    expect(result.cwd).toBe('/a')
    expect(result.rest).toBe('y'.repeat(512))
  })

  it('buffers an unterminated sequence entirely', () => {
    expect(extractOsc7Cwd('\x1b]7;/a')).toEqual({ cwd: null, rest: '\x1b]7;/a' })
  })
})

describe('parsePwdOutput', () => {
  it('returns null for empty or path-less output', () => {
    expect(parsePwdOutput('')).toBeNull()
    expect(parsePwdOutput('hello world')).toBeNull()
    expect(parsePwdOutput('   \n  ')).toBeNull()
  })

  it('returns the first line that starts with a slash after trimming', () => {
    expect(parsePwdOutput('/root\n/var')).toBe('/root')
    expect(parsePwdOutput('first\n  /tmp  \nlast')).toBe('/tmp')
  })
})

describe('stripTerminalControl', () => {
  it('passes plain text through unchanged', () => {
    expect(stripTerminalControl('hello')).toBe('hello')
  })

  it('removes CSI, single-char escapes and BEL', () => {
    expect(stripTerminalControl('a\x1b[31mred\x1b[0mb')).toBe('aredb')
    expect(stripTerminalControl('a\x1bXb')).toBe('ab')
    expect(stripTerminalControl('a\x1b\\b')).toBe('ab')
    expect(stripTerminalControl('a\x07b')).toBe('ab')
  })

  it('strips an OSC header char (] is inside the @-Z range) and the trailing BEL separately', () => {
    expect(stripTerminalControl('a\x1b]0;title\x07b')).toBe('a0;titleb')
  })
})

describe('normalizeTerminalText', () => {
  it('normalizes CRLF and CR to LF and strips control sequences', () => {
    expect(normalizeTerminalText('a\r\nb')).toBe('a\nb')
    expect(normalizeTerminalText('a\rb')).toBe('a\nb')
    expect(normalizeTerminalText('a\r\nb\rc\x1b[Kd')).toBe('a\nb\ncd')
  })
})

describe('isShellPromptLine', () => {
  it('rejects empty, whitespace-only and over-long lines', () => {
    expect(isShellPromptLine('')).toBe(false)
    expect(isShellPromptLine('   ')).toBe(false)
    expect(isShellPromptLine('x'.repeat(181))).toBe(false)
  })

  it('accepts bare prompt symbols', () => {
    expect(isShellPromptLine('$')).toBe(true)
    expect(isShellPromptLine('# ')).toBe(true)
    expect(isShellPromptLine('%')).toBe(true)
    expect(isShellPromptLine('>')).toBe(true)
  })

  it('accepts bracketed prompt formats', () => {
    expect(isShellPromptLine('[root@host:~] $')).toBe(true)
    expect(isShellPromptLine('[user@host]#')).toBe(true)
  })

  it('accepts user@host and path-prefixed prompts', () => {
    expect(isShellPromptLine('user@host:/home $')).toBe(true)
    expect(isShellPromptLine('root@server:~/proj #')).toBe(true)
    expect(isShellPromptLine('/home/user $')).toBe(true)
    expect(isShellPromptLine('~ $')).toBe(true)
    expect(isShellPromptLine('.. $')).toBe(true)
    expect(isShellPromptLine('. $')).toBe(true)
  })

  it('accepts fish-style arrows', () => {
    expect(isShellPromptLine('❯')).toBe(true)
    expect(isShellPromptLine('➜ ')).toBe(true)
  })

  it('rejects ordinary command output', () => {
    expect(isShellPromptLine('ls -la')).toBe(false)
    expect(isShellPromptLine('user@host')).toBe(false)
    expect(isShellPromptLine('[not a prompt]')).toBe(false)
  })
})

describe('createHiddenEchoFilter', () => {
  it('drops complete lines containing a literal and keeps the rest', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    expect(filter('visible line\n')).toBe('visible line\n')
    expect(filter('__starhub_osc7() { :; }\nnext\n')).toBe('next\n')
    expect(filter('a\n__starhub_osc7\nb\n')).toBe('a\nb\n')
  })

  it('buffers a partial marker at the end of a chunk and emits it once complete', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    expect(filter('echo __star')).toBe('echo ')
    expect(filter('hub_osc7 hidden\n')).toBe('')
  })

  it('returns out immediately when pending holds a full marker without a newline', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    expect(filter('x__starhub_osc7')).toBe('')
    expect(filter('y\n')).toBe('')
  })

  it('passes a no-marker chunk through and flushes its pending buffer', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    expect(filter('plain tail')).toBe('plain tail')
    expect(filter('')).toBe('')
  })

  it('handles multiple complete lines in a single chunk', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    expect(filter('l1\nl2\n')).toBe('l1\nl2\n')
  })

  it('treats empty literals as a passthrough filter', () => {
    const filter = createHiddenEchoFilter([''])
    expect(filter('abc\n')).toBe('abc\n')
    expect(filter('xyz')).toBe('xyz')
  })

  it('handles a single-character marker without a prefix-overlap loop', () => {
    const filter = createHiddenEchoFilter(['a'])
    expect(filter('b')).toBe('b')
    expect(filter('ba')).toBe('')
    expect(filter('c\n')).toBe('')
  })
})

describe('createCwdTracker', () => {
  it('starts empty and reports changes only when the cwd actually changes', () => {
    const tracker = createCwdTracker()
    expect(tracker.get()).toBe('')
    expect(tracker.onChunk('\x1b]7;/home\x07')).toBe('/home')
    expect(tracker.get()).toBe('/home')
    expect(tracker.onChunk('\x1b]7;/home\x07')).toBeNull()
    expect(tracker.onChunk('\x1b]7;/var\x07')).toBe('/var')
    expect(tracker.get()).toBe('/var')
  })

  it('falls back to a lone absolute path line from pwd output', () => {
    const tracker = createCwdTracker()
    expect(tracker.onChunk('\n/tmp\n')).toBe('/tmp')
    expect(tracker.get()).toBe('/tmp')
    // same path again: no change reported
    expect(tracker.onChunk('\n/tmp\n')).toBeNull()
    // no lone path in the chunk: no change
    expect(tracker.onChunk('ls -la')).toBeNull()
  })

  it('lets a pwd path supersede a same-chunk OSC 7 cwd', () => {
    const tracker = createCwdTracker()
    expect(tracker.onChunk('\x1b]7;/a\x07\n/b\n')).toBe('/b')
    expect(tracker.get()).toBe('/b')
  })

  it('set() updates the cwd only when the value differs and get() returns it', () => {
    const tracker = createCwdTracker()
    tracker.set('/opt')
    expect(tracker.get()).toBe('/opt')
    tracker.set('/opt')
    expect(tracker.get()).toBe('/opt')
    tracker.set('/srv')
    expect(tracker.get()).toBe('/srv')
  })
})

describe('OSC 7 inject command constant', () => {
  it('injects a __starhub_osc7 hook into bash/zsh and ends with a newline', () => {
    expect(OSC7_INJECT_COMMAND).toContain('__starhub_osc7()')
    expect(OSC7_INJECT_COMMAND).toContain('precmd_functions')
    expect(OSC7_INJECT_COMMAND).toContain('PROMPT_COMMAND')
    expect(OSC7_INJECT_COMMAND.endsWith('\n')).toBe(true)
    expect(OSC7_INJECT_ECHO_TEXT).toBe('__starhub_osc7')
  })
})
