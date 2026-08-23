/**
 * Terminal current-directory tracking for the shell-native SSH overlay.
 *
 * Pure port of the Vue `src/utils/terminalCwd.ts` + the cwd-relevant parts of
 * `src/utils/sshPromptCapture.ts` and `SshTerminal.vue`. Tracks the remote cwd
 * from two signals in the PTY stream — the shell's own OSC 7 (`ESC ] 7 ; <cwd>`
 * BEL) and `pwd` output lines — and optionally lazy-injects an OSC 7 hook into
 * the running shell so `cd` reports cwd live (the SFTP「跟随终端」flow).
 *
 * @module StarHub terminal cwd tracking (client)
 */

/** Inject the OSC 7 hook into the running shell (ends with newline to run). */
export const OSC7_INJECT_COMMAND =
  '__starhub_osc7() { printf \'\\033]7;%s\\007\' "$PWD"; }; ' +
  'if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__starhub_osc7); ' +
  'else PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__starhub_osc7"; fi\n'

/** Stable substring of the inject-command echo line (hidden by the render filter). */
export const OSC7_INJECT_ECHO_TEXT = '__starhub_osc7'

/** Max tail length kept because OSC sequences may straddle TCP fragments. */
const OSC7_TAIL_KEEP = 512

/**
 * Extract the latest complete OSC 7 cwd from a tail; return cwd + unconsumed rest.
 * @param tail - the buffered terminal tail (may contain partial OSC sequences).
 * @returns the latest complete cwd (null when none) and the unconsumed rest.
 */
export function extractOsc7Cwd(tail: string): { cwd: string | null; rest: string } {
  const re = /\x1b\]7;([^\x07\x1b]{1,300})(?:\x07|\x1b\\)/g
  let cwd: string | null = null
  let consumed = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(tail)) !== null) {
    const captured = m[1]
    /* v8 ignore next -- the OSC 7 capture group requires 1-300 chars, so m[1] is always defined */
    if (captured === undefined) continue
    let p = captured
    const fileMatch = p.match(/^file:\/\/[^/]*(\/.*)$/)
    const pathPart = fileMatch?.[1]
    if (pathPart !== undefined) p = pathPart
    if (p.startsWith('/')) cwd = p
    consumed = re.lastIndex
  }
  return { cwd, rest: tail.slice(consumed).slice(-OSC7_TAIL_KEEP) }
}

/**
 * Parse the first line starting with `/` from `pwd` output (login dir).
 * @param output - the raw `pwd` output text.
 * @returns the first absolute path line, or null when none.
 */
export function parsePwdOutput(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('/')) return trimmed
  }
  return null
}

/**
 * Strip ANSI control sequences and BEL.
 * @param input - the raw terminal text.
 * @returns the text with control sequences removed.
 */
export function stripTerminalControl(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\x07/g, '')
}

/**
 * Strip control sequences and normalize \r\n / \r to \n.
 * @param input - the raw terminal text.
 * @returns the normalized text.
 */
export function normalizeTerminalText(input: string): string {
  return stripTerminalControl(input)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Whether a line looks like a shell prompt (bash/sh/zsh/fish formats).
 * @param line - the line to classify.
 * @returns true when the line is a plausible shell prompt.
 */
export function isShellPromptLine(line: string): boolean {
  const trimmed = line.trimEnd()
  if (!trimmed || trimmed.length > 180) return false
  if (/^[#$%>]\s*$/.test(trimmed)) return true
  if (/^\[[^\]\n]{1,140}\]\s*[#$%>]\s*$/.test(trimmed)) return true
  if (/^[\w.-]+@[\w.-]+(?::[^\n]{0,120})?\s*[#$%>]\s*$/.test(trimmed)) return true
  if (/^(?:~|\/[\w./-]*|\.\.?)(?:\s+[^\n]{0,80})?\s*[#$%>]\s*$/.test(trimmed)) return true
  if (/(?:❯|➜)\s*$/.test(trimmed)) return true
  return false
}

/**
 * Hidden-echo filter that drops full logical lines containing any given
 * literal (e.g. the OSC 7 inject command echo). Keeps state across TCP
 * fragments, mirroring `createHiddenEchoFilter` in sshPromptCapture.ts.
 * @param literals - substrings of lines to drop.
 * @returns a per-chunk filter that returns the visible text.
 */
export function createHiddenEchoFilter(literals: string[]): (chunk: string) => string {
  let pending = ''
  const markers = literals.filter(lit => lit.length > 0)
  const longest = markers.reduce((max, lit) => Math.max(max, lit.length), 0)
  const PARTIAL_HEAD = 8

  function markerPrefixOverlap(buf: string): number {
    const max = Math.min(buf.length, longest - 1)
    for (let k = max; k > 0; k--) {
      if (markers.some(lit => k < lit.length && buf.endsWith(lit.slice(0, k)))) return k
    }
    return 0
  }

  return (chunk: string): string => {
    pending += chunk
    let out = ''
    let nl = pending.indexOf('\n')
    while (nl >= 0) {
      const line = pending.slice(0, nl + 1)
      pending = pending.slice(nl + 1)
      if (!markers.some(lit => line.includes(lit))) out += line
      nl = pending.indexOf('\n')
    }
    if (!pending) return out
    const hit = markers.some(lit =>
      pending.includes(lit) || pending.includes(lit.slice(0, Math.min(lit.length, PARTIAL_HEAD))),
    )
    if (hit) return out
    const keep = markerPrefixOverlap(pending)
    out += pending.slice(0, pending.length - keep)
    pending = pending.slice(pending.length - keep)
    return out
  }
}

/** Stateful cwd tracker: consume terminal chunks and yield the latest cwd. */
export interface CwdTracker {
  /** Feed one decoded text chunk; returns the updated cwd (null if unchanged). */
  onChunk(chunk: string): string | null
  /** Report a full line/path (e.g. from `pwd` output) as the cwd. */
  set(cwd: string): void
  /** Current best-known cwd (may be empty until first signal). */
  get(): string
}

/**
 * Create a cwd tracker that parses OSC 7 + `pwd` output across fragments.
 * @returns the tracker handle.
 */
export function createCwdTracker(): CwdTracker {
  let cwd = ''
  let tail = ''
  return {
    onChunk(chunk) {
      tail += chunk
      const osc7 = extractOsc7Cwd(tail)
      tail = osc7.rest
      let changed = false
      if (osc7.cwd !== null && osc7.cwd !== cwd) {
        cwd = osc7.cwd
        changed = true
      }
      // pwd output fallback: a line that is just an absolute path
      const pwdMatch = chunk.match(/(?:\r\n|\n|\r)(\/[\w\-./]{1,200})\s*(?:\r\n|\n|\r|$)/)
      const pwdPath = pwdMatch?.[1]
      if (pwdPath !== undefined && pwdPath.startsWith('/') && pwdPath !== cwd) {
        cwd = pwdPath
        changed = true
      }
      return changed ? cwd : null
    },
    set(next) {
      if (next !== cwd) cwd = next
    },
    get() {
      return cwd
    },
  }
}
