// @vitest-environment node
/**
 * 终端 cwd 跟踪(terminal-cwd.ts):OSC 7 提取、pwd 输出解析、ANSI 清理、
 * 提示符分类、隐藏回显过滤器与状态化 tracker 的全部分支。
 */
import { describe, expect, it } from 'vitest'
import {
  createCwdTracker, createHiddenEchoFilter, extractOsc7Cwd, extractPromptCwd, isShellPromptLine,
  buildOsc7InjectCommand, normalizeTerminalText, parseLoginShell, HIDDEN_ECHO_LINE_RESET,
  OSC7_INJECT_COMMAND, OSC7_INJECT_ECHO_TEXT, parsePwdOutput, stripTerminalControl,
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

  it('strips a complete OSC sequence with its payload (] must not fall into the @-Z esc-dispatch branch)', () => {
    // 旧行为把 \x1B] 当单字符转义吃掉、payload `0;title` 残留——正是带标题/
    // 颜色 PS1 的 prompt 永远识别不出、SFTP 只能手敲 pwd 才跟随的根因
    expect(stripTerminalControl('a\x1b]0;title\x07b')).toBe('ab')
    expect(stripTerminalControl('a\x1b]7;/var/www\x07b')).toBe('ab')
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
  it('passes chunks through untouched when not armed (default)', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    expect(filter.isArmed()).toBe(false)
    // 未武装零缓冲透传:行尾 `_`(marker 前缀)原样实时渲染,不再扣留
    expect(filter('visible line\n')).toBe('visible line\n')
    expect(filter('cd ~/my_')).toBe('cd ~/my_')
    expect(filter('__starhub_osc7() { :; }\n')).toBe('__starhub_osc7() { :; }\n')
    expect(filter('')).toBe('')
  })

  it('drops the marker echo line while armed and auto-disarms with the rest flushed', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    filter.arm()
    expect(filter.isArmed()).toBe(true)
    // 武装期间无换行的行整体扣留(窗口只持续到注入回显的 \n 到达)
    expect(filter('user@host:~$ ')).toBe('')
    // 注入命令回显跨分片:第一段扣留,第二段收束整行 → 整行剔除 + 行复位 + 冲刷
    expect(filter('__starhub_osc7() { printf')).toBe('')
    expect(filter(" '\\033]7;%s\\007' \"$PWD\"; }; PROMPT_COMMAND=__starhub_osc7\nnext prompt")).toBe(`${HIDDEN_ECHO_LINE_RESET}next prompt`)
    expect(filter.isArmed()).toBe(false)
    // 解除后恢复透传(例如 history 里再出现 marker 行,是用户可见输出)
    expect(filter('history shows __starhub_osc7\n')).toBe('history shows __starhub_osc7\n')
  })

  it('resets the line where the echo was dropped so the reprinted prompt does not glue onto the previous one', () => {
    // 真机字节流:提示符 1 → 注入回显行(`fi\r\n`)→ 提示符 2。剔除回显行时若
    // 连换行一起吞掉,提示符 2 会紧贴提示符 1(屏幕上并排两个提示符,每次
    // 打开终端必现);行复位(CR + 擦除整行)让重印的提示符落在同一行。
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    const prompt1 = '\u001b[?1034h[work@zhht-dev ~]$ '
    // 提示符 1 已渲染(注入由它触发,此时尚未武装),光标停在它末尾
    expect(filter(prompt1)).toBe(prompt1)
    filter.arm()
    const stream = filter('__starhub_osc7() { :; }\r\n\u001b]7;/home/work\u0007[work@zhht-dev ~]$ ')
    expect(stream).toBe(`${HIDDEN_ECHO_LINE_RESET}\u001b]7;/home/work\u0007[work@zhht-dev ~]$ `)
    // 行复位必须擦掉提示符 1,不能留下任何提示符文本
    expect(stream).not.toContain(prompt1)
  })

  it('holds only the incomplete tail while armed and never holds plain text after disarm', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    filter.arm()
    expect(filter('typed chars without newline')).toBe('')
    expect(filter.isArmed()).toBe(true)
    expect(filter.disarm()).toBe('typed chars without newline')
    expect(filter.isArmed()).toBe(false)
    expect(filter('cd ~/my_')).toBe('cd ~/my_')
  })

  it('emits earlier complete lines and drops only the marker line while armed', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    filter.arm()
    expect(filter('keep1\n__starhub_osc7\nkeep2\n')).toBe(`keep1\n${HIDDEN_ECHO_LINE_RESET}keep2\n`)
    expect(filter.isArmed()).toBe(false)
  })

  it('flushes and disarms when the armed window exceeds the buffer cap (echo never comes)', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    filter.arm()
    const big = 'x'.repeat(9000)
    expect(filter(big)).toBe(big)
    expect(filter.isArmed()).toBe(false)
    expect(filter('after')).toBe('after')
  })

  it('flushes and disarms when a marker line is consumed mid-stream, keeping later chunks live', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    filter.arm()
    expect(filter('echo __starhub_osc7 hook\nls ~/my_')).toBe(`${HIDDEN_ECHO_LINE_RESET}ls ~/my_`)
    expect(filter.isArmed()).toBe(false)
  })

  it('re-arms after auto-disarm (a later follow-toggle injection filters again)', () => {
    const filter = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])
    filter.arm()
    expect(filter('__starhub_osc7\n')).toBe(HIDDEN_ECHO_LINE_RESET)
    expect(filter.isArmed()).toBe(false)
    filter.arm()
    expect(filter('held')).toBe('')
    expect(filter('__starhub_osc7 tail\nrest')).toBe(`${HIDDEN_ECHO_LINE_RESET}rest`)
  })

  it('treats empty literals as an armed window that only ends via cap or disarm', () => {
    const filter = createHiddenEchoFilter([''])
    filter.arm()
    // 无 marker 可命中:完整行照常放行,窗口靠 cap/disarm 结束
    expect(filter('abc\n')).toBe('abc\n')
    expect(filter.disarm()).toBe('')
  })

  it('handles a single-character marker line while armed', () => {
    const filter = createHiddenEchoFilter(['a'])
    filter.arm()
    expect(filter('b\na\nc\n')).toBe(`b\n${HIDDEN_ECHO_LINE_RESET}c\n`)
    expect(filter.isArmed()).toBe(false)
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

describe('stripTerminalControl', () => {
  it('strips OSC (title / OSC 7), CSI colors and BEL from a colored PS1 prompt', () => {
    // 回归:OSC 分支必须在 C0 esc-dispatch 之前(否则 \x1B] 的 ] 被当
    // esc-dispatch 吃掉,OSC payload 残留,prompt 永远识别不出)
    const raw = '\u001b]0;deploy@server: ~/src\u0007\u001b[01;32mdeploy@server\u001b[00m:\u001b[01;34m~/src\u001b[00m$ '
    expect(stripTerminalControl(raw).trimEnd()).toBe('deploy@server:~/src$')
    // OSC 7 + prompt 粘连(无换行)也一并剥净
    expect(stripTerminalControl('\u001b]7;/root\u0007root@host:~# ')).toBe('root@host:~# ')
    // ST 结尾的 OSC 同样剥净
    expect(stripTerminalControl('\u001b]7;/opt\u001b\\ok')).toBe('ok')
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

describe('parseLoginShell', () => {
  it('recognizes the login shell from the $0 / ps probe lines', () => {
    expect(parseLoginShell('/root\nbash\nbash')).toBe('bash')
    expect(parseLoginShell('/root\n-bash\nbash')).toBe('bash')
    expect(parseLoginShell('/home/u\n/usr/bin/zsh\nzsh')).toBe('zsh')
    expect(parseLoginShell('/root\nfish\nfish')).toBe('fish')
    expect(parseLoginShell('/root\ntcsh\ntcsh')).toBe('tcsh')
  })

  it('returns null when no line matches a known shell', () => {
    expect(parseLoginShell('/root\n\n')).toBeNull()
    expect(parseLoginShell('')).toBeNull()
    expect(parseLoginShell('ps: invalid option')).toBeNull()
  })
})

describe('buildOsc7InjectCommand', () => {
  it('uses the shared bash/zsh command for undetected and POSIX shells', () => {
    expect(buildOsc7InjectCommand(null)).toBe(OSC7_INJECT_COMMAND)
    expect(buildOsc7InjectCommand('bash')).toBe(OSC7_INJECT_COMMAND)
    expect(buildOsc7InjectCommand('zsh')).toBe(OSC7_INJECT_COMMAND)
    expect(buildOsc7InjectCommand('sh')).toBe(OSC7_INJECT_COMMAND)
  })

  it('uses the fish_prompt event hook for fish', () => {
    const cmd = buildOsc7InjectCommand('fish')
    expect(cmd).toContain('--on-event fish_prompt')
    expect(cmd).toContain('__starhub_osc7')
    expect(cmd).toContain('$PWD')
    expect(cmd.endsWith('\n')).toBe(true)
  })

  it('returns empty for injection-immune shells (csh/tcsh/pwsh/…)', () => {
    expect(buildOsc7InjectCommand('csh')).toBe('')
    expect(buildOsc7InjectCommand('tcsh')).toBe('')
    expect(buildOsc7InjectCommand('pwsh')).toBe('')
  })
})

describe('extractPromptCwd', () => {
  it('extracts the path from Debian/CentOS default PS1 forms', () => {
    expect(extractPromptCwd('root@host:/var/log#', '/root')).toBe('/var/log')
    expect(extractPromptCwd('[root@host /var/log]#', '/root')).toBe('/var/log')
    expect(extractPromptCwd('/etc/nginx$', '/root')).toBe('/etc/nginx')
  })

  it('expands ~ against the login home', () => {
    expect(extractPromptCwd('root@host:~#', '/root')).toBe('/root')
    expect(extractPromptCwd('[root@host ~]#', '/root')).toBe('/root')
    expect(extractPromptCwd('user@h:~/src$', '/home/u')).toBe('/home/u/src')
  })

  it('takes the last path token (the one next to the prompt symbol)', () => {
    expect(extractPromptCwd('user@host ~ /opt$ ', '/home/u')).toBe('/opt')
  })

  it('never guesses ~ without a known home', () => {
    expect(extractPromptCwd('root@host:~#', '')).toBeNull()
    expect(extractPromptCwd('root@host:~#', 'relative')).toBeNull()
    expect(extractPromptCwd('root@host:/tmp#', '')).toBe('/tmp')
  })

  it('returns null for path-less prompts, relative dir names and URLs', () => {
    expect(extractPromptCwd('sh-5.1$', '/root')).toBeNull()
    expect(extractPromptCwd('#', '/root')).toBeNull()
    expect(extractPromptCwd('host: Documents user%', '/home/u')).toBeNull()
    expect(extractPromptCwd('visit https://a.com/x#', '/root')).toBeNull()
    expect(extractPromptCwd('~root@host:~#', '/root')).toBe('/root')
  })
})
