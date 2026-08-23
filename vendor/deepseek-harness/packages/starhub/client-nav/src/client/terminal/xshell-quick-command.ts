/** Xshell .qbl and .qblx quick-command parser for the SSH workbench. */
export interface XshellQuickCommand {
  label: string
  cmd: string
}

/** Parsed .qbl/.qblx content: extracted commands plus the skipped-script count. */
export interface XshellParseResult {
  commands: XshellQuickCommand[]
  skippedScripts: number
}

const SEGMENT_SEP = /\\n\[\d+\]/
const KEYED_RE = /^Button_(\d+)_(Name|Action|Type|Desc|Icon|Param)\s*=\s*(.*)$/i
const LEGACY_RE = /^Button_(\d+)\s*=\s*(.*)$/i

function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\n+$/g, '').trim()
}

/**
 * Parse legacy and Xshell 8 QuickButton definitions.
 * @param text - the raw .qbl text content.
 * @returns the parsed commands and skipped script count.
 */
export function parseXshellQblDetailed(text: string): XshellParseResult {
  const legacy: { index: number; label: string; cmd: string }[] = []
  const keyed = new Map<number, { name?: string; action?: string; type?: string }>()
  let skippedScripts = 0
  let inQuickButton = false
  let sawSection = false
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section !== null) {
      sawSection = true
      /* v8 ignore next -- the section regex group 1 requires 1+ chars, so section[1] is always defined */
      inQuickButton = (section[1] ?? '').trim().toLowerCase() === 'quickbutton'
      continue
    }
    if (sawSection && !inQuickButton) continue
    const keyedMatch = KEYED_RE.exec(line)
    if (keyedMatch !== null) {
      /* v8 ignore start -- KEYED_RE groups 1-3 are all mandatory, so none of the ?? fallbacks apply */
      const index = Number(keyedMatch[1] ?? '0')
      const field = (keyedMatch[2] ?? '').toLowerCase()
      const value = keyedMatch[3] ?? ''
      /* v8 ignore stop */
      const entry = keyed.get(index) ?? {}
      if (field === 'name') entry.name = value
      else if (field === 'action') entry.action = value
      else if (field === 'type') entry.type = value
      keyed.set(index, entry)
      continue
    }
    const legacyMatch = LEGACY_RE.exec(line)
    if (legacyMatch === null) continue
    /* v8 ignore start -- LEGACY_RE group 2 is mandatory and split() always yields segments[0] */
    const segments = (legacyMatch[2] ?? '').split(SEGMENT_SEP)
    const label = (segments[0] ?? '').trim()
    /* v8 ignore stop */
    const cmd = segments.slice(1).join('\n').trim()
    /* v8 ignore next -- LEGACY_RE group 1 is mandatory, so the ?? fallback never applies */
    if (cmd !== '') legacy.push({ index: Number(legacyMatch[1] ?? '0'), label: label || cmd.slice(0, 20), cmd })
  }
  const keyedCommands: { index: number; label: string; cmd: string }[] = []
  for (const [index, entry] of keyed) {
    const cmd = entry.action === undefined ? '' : unescapeNewlines(entry.action)
    if (cmd === '') continue
    if (entry.type === '2') { skippedScripts += 1; continue }
    const label = entry.name?.trim() ?? ''
    keyedCommands.push({ index, label: label || cmd.slice(0, 20), cmd })
  }
  const merged = [...legacy, ...keyedCommands]
    .sort((a, b) => a.index - b.index)
    .map(({ label, cmd }) => ({ label, cmd }))
  return { commands: merged, skippedScripts }
}

/**
 * Decode UTF-8, UTF-16 LE and legacy single-byte qbl content.
 * @param data - the raw file bytes.
 * @returns the decoded text.
 */
export function decodeQblText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  return new TextDecoder('utf-8').decode(bytes)
}

interface ZipEntry { name: string; method: number; compressedSize: number; uncompressedSize: number; offset: number }

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (bytes[index] !== 0x50 || bytes[index + 1] !== 0x4b || bytes[index + 2] !== 0x05 || bytes[index + 3] !== 0x06) continue
    const count = new DataView(bytes.buffer, bytes.byteOffset + index).getUint16(10, true)
    const offset = new DataView(bytes.buffer, bytes.byteOffset + index).getUint32(16, true)
    const entries: ZipEntry[] = []
    let cursor = offset
    for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + cursor)
      const method = view.getUint16(10, true)
      const compressedSize = view.getUint32(20, true)
      const uncompressedSize = view.getUint32(24, true)
      const nameLength = view.getUint16(28, true)
      const extraLength = view.getUint16(30, true)
      const commentLength = view.getUint16(32, true)
      const localOffset = view.getUint32(42, true)
      const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength))
      entries.push({ name, method, compressedSize, uncompressedSize, offset: localOffset })
      cursor += 46 + nameLength + extraLength + commentLength
    }
    return entries
  }
  return []
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset + entry.offset)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const dataStart = entry.offset + 30 + nameLength + extraLength
  const data = bytes.slice(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) return new Uint8Array()
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Parse all commands.qbl entries from an Xshell .qblx archive.
 * @param data - the raw .qblx archive bytes.
 * @returns the merged commands (set-prefixed when multiple sets) and skipped
 *   script count.
 */
export async function parseXshellQblx(data: ArrayBuffer): Promise<XshellParseResult> {
  const bytes = new Uint8Array(data)
  const entries = zipEntries(bytes).filter(entry => /(^|\/)commands\.qbl$/i.test(entry.name.replace(/\\/g, '/')))
  const sets: { setName: string; result: XshellParseResult }[] = []
  for (const entry of entries) {
    const content = await readZipEntry(bytes, entry)
    if (content.length === 0) continue
    const normalized = entry.name.replace(/\\/g, '/')
    const slash = normalized.lastIndexOf('/')
    const copy = new Uint8Array(content)
    sets.push({ setName: slash >= 0 ? normalized.slice(0, slash) : '', result: parseXshellQblDetailed(decodeQblText(copy.buffer)) })
  }
  const multiSet = sets.filter(set => set.result.commands.length > 0).length > 1
  const commands: XshellQuickCommand[] = []
  let skippedScripts = 0
  for (const { setName, result } of sets) {
    skippedScripts += result.skippedScripts
    for (const command of result.commands) commands.push(multiSet && setName !== '' ? { label: `${setName}/${command.label}`, cmd: command.cmd } : command)
  }
  return { commands, skippedScripts }
}
