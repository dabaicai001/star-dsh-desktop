// @vitest-environment node
/**
 * Xshell 快捷命令解析(xshell-quick-command.ts):.qbl 文本解析(legacy + Xshell 8
 * keyed)、UTF-16/UTF-8 解码,以及 .qblx 归档(手构 ZIP 字节)的中央目录扫描与
 * stored/deflate/未知压缩条目读取。
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeQblText, parseXshellQblDetailed, parseXshellQblx } from '../src/client/terminal/xshell-quick-command.ts'

/** 把字符串按 UTF-16LE 编码(不含 BOM)。 */
function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return bytes
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

/** 手工构造最小 ZIP:local header + 数据 + central directory + EOCD(CRC 恒 0,解析器不读)。 */
function buildZip(entries: Array<{ name: string; data: Uint8Array; method?: 0 | 8 | 99 }>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 0
    const nameBytes = encoder.encode(entry.name)
    const raw = entry.data
    const compressed = method === 8 ? deflateRawSync(raw) : raw

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0, true)
    lv.setUint32(14, 0, true)
    lv.setUint32(18, compressed.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    chunks.push(local, compressed)

    const centralEntry = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(centralEntry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, 0, true)
    cv.setUint32(20, compressed.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    centralEntry.set(nameBytes, 46)
    central.push(centralEntry)
    offset += local.length + compressed.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)
  return concatBytes([...chunks, ...central, eocd])
}

const QBL_SAMPLE = [
  '[QuickButton]',
  'Button_1=My Label\\n[2]ls -la\\n[3]pwd',
  'Button_2=Just Label',
  'Button_3_Name=Keyed Name',
  'Button_3_Action=echo hi',
  'Button_3_Type=0',
  'Button_4_Name=Script',
  'Button_4_Action=./run.sh',
  'Button_4_Type=2',
  "Button_5_Action=printf 'a\\nb'",
  'Button_6_Desc=description only',
  'Button_7=Legacy Two\\n[2]first\\n[3]second',
].join('\n')

describe('parseXshellQblDetailed', () => {
  it('returns empty results for blank input', () => {
    expect(parseXshellQblDetailed('')).toEqual({ commands: [], skippedScripts: 0 })
    expect(parseXshellQblDetailed('   \n\n')).toEqual({ commands: [], skippedScripts: 0 })
  })

  it('parses legacy buttons with segment separators and joins commands', () => {
    const result = parseXshellQblDetailed(QBL_SAMPLE)
    expect(result.commands).toContainEqual({ label: 'My Label', cmd: 'ls -la\npwd' })
    expect(result.commands).toContainEqual({ label: 'Legacy Two', cmd: 'first\nsecond' })
    expect(result.skippedScripts).toBe(1)
  })

  it('skips legacy buttons with an empty command', () => {
    const result = parseXshellQblDetailed('[QuickButton]\nButton_2=Just Label')
    expect(result.commands).toEqual([])
  })

  it('falls back to the command prefix when the legacy label is empty', () => {
    const result = parseXshellQblDetailed('[QuickButton]\nButton_9=\\n[2]a-very-long-command-here')
    expect(result.commands).toEqual([{ label: 'a-very-long-command-', cmd: 'a-very-long-command-here' }])
  })

  it('parses keyed Name/Action/Type fields and unescapes newlines', () => {
    const result = parseXshellQblDetailed(QBL_SAMPLE)
    expect(result.commands).toContainEqual({ label: 'Keyed Name', cmd: 'echo hi' })
    expect(result.commands).toContainEqual({ label: "printf 'a\nb'", cmd: "printf 'a\nb'" })
  })

  it('skips keyed entries without an action and script-typed entries', () => {
    const result = parseXshellQblDetailed(QBL_SAMPLE)
    expect(result.commands.some(command => command.cmd === './run.sh')).toBe(false)
    expect(result.commands.some(command => command.label === 'Script')).toBe(false)
    expect(result.skippedScripts).toBe(1)
  })

  it('falls back to the action prefix when the keyed name is empty', () => {
    const result = parseXshellQblDetailed('[QuickButton]\nButton_3_Action=echo a-very-long-command-here')
    expect(result.commands).toEqual([{ label: 'echo a-very-long-com', cmd: 'echo a-very-long-command-here' }])
  })

  it('skips lines in non-QuickButton sections', () => {
    const text = '[Other]\nButton_1=Ignored\\n[2]nope\n[QuickButton]\nButton_2_Name=Real\nButton_2_Action=echo real'
    expect(parseXshellQblDetailed(text)).toEqual({
      commands: [{ label: 'Real', cmd: 'echo real' }],
      skippedScripts: 0,
    })
  })

  it('treats section and field names case-insensitively', () => {
    const text = '[quickbutton]\nbutton_3_NAME=Lower\nbutton_3_ACTION=echo lower'
    expect(parseXshellQblDetailed(text)).toEqual({
      commands: [{ label: 'Lower', cmd: 'echo lower' }],
      skippedScripts: 0,
    })
  })

  it('processes lines before any section header', () => {
    const text = 'Button_0=Early\\n[2]echo early\n[QuickButton]\nButton_1_Name=After\nButton_1_Action=echo after'
    expect(parseXshellQblDetailed(text)).toEqual({
      commands: [
        { label: 'Early', cmd: 'echo early' },
        { label: 'After', cmd: 'echo after' },
      ],
      skippedScripts: 0,
    })
  })

  it('sorts merged commands by button index', () => {
    const text = '[QuickButton]\nButton_5=Five\\n[2]echo five\nButton_2_Name=Two\nButton_2_Action=echo two'
    const result = parseXshellQblDetailed(text)
    expect(result.commands.map(command => command.label)).toEqual(['Two', 'Five'])
  })

  it('skips lines that match neither the keyed nor the legacy pattern', () => {
    const text = '[QuickButton]\nthis is not a button line\nButton_1_Name=Only\nButton_1_Action=echo only'
    expect(parseXshellQblDetailed(text).commands).toEqual([{ label: 'Only', cmd: 'echo only' }])
  })

  it('skips blank lines and comment lines', () => {
    const text = '; comment\n# another\n\nButton_1_Name=Only\nButton_1_Action=echo only'
    expect(parseXshellQblDetailed(text).commands).toEqual([{ label: 'Only', cmd: 'echo only' }])
  })

  it('trims CRLF line endings', () => {
    const text = '[QuickButton]\r\nButton_1_Name=A\r\nButton_1_Action=echo a\r\n'
    expect(parseXshellQblDetailed(text).commands).toEqual([{ label: 'A', cmd: 'echo a' }])
  })
})

describe('decodeQblText', () => {
  it('decodes UTF-16LE content with a BOM', () => {
    const bytes = concatBytes([new Uint8Array([0xff, 0xfe]), utf16leBytes('hello qbl')])
    expect(decodeQblText(new Uint8Array(bytes).buffer)).toBe('hello qbl')
  })

  it('decodes UTF-8 content without a BOM', () => {
    const bytes = new TextEncoder().encode('hello qbl')
    expect(decodeQblText(bytes.buffer)).toBe('hello qbl')
  })
})

describe('parseXshellQblx', () => {
  it('parses a stored commands.qbl at the archive root without a set prefix', async () => {
    const bytes = buildZip([{ name: 'commands.qbl', data: new TextEncoder().encode(QBL_SAMPLE) }])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toContainEqual({ label: 'My Label', cmd: 'ls -la\npwd' })
    expect(result.commands).toContainEqual({ label: 'Keyed Name', cmd: 'echo hi' })
    expect(result.skippedScripts).toBe(1)
  })

  it('prefixes labels with the set directory when multiple sets have commands', async () => {
    const encoder = new TextEncoder()
    const bytes = buildZip([
      { name: 'set-a/commands.qbl', data: encoder.encode('[QuickButton]\nButton_1_Name=A\nButton_1_Action=echo a') },
      { name: 'set-b/commands.qbl', data: encoder.encode('[QuickButton]\nButton_1_Name=B\nButton_1_Action=echo b') },
    ])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([
      { label: 'set-a/A', cmd: 'echo a' },
      { label: 'set-b/B', cmd: 'echo b' },
    ])
  })

  it('keeps labels unprefixed for a single set and normalizes backslash paths', async () => {
    const bytes = buildZip([{ name: 'set-a\\commands.qbl', data: new TextEncoder().encode('[QuickButton]\nButton_1_Name=A\nButton_1_Action=echo a') }])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([{ label: 'A', cmd: 'echo a' }])
  })

  it('decompresses deflate-raw entries', async () => {
    const bytes = buildZip([{
      name: 'commands.qbl',
      data: new TextEncoder().encode('[QuickButton]\nButton_1_Name=D\nButton_1_Action=echo d'),
      method: 8,
    }])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([{ label: 'D', cmd: 'echo d' }])
  })

  it('skips entries with an unsupported compression method', async () => {
    const bytes = buildZip([{ name: 'commands.qbl', data: new TextEncoder().encode('ignored'), method: 99 }])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([])
  })

  it('skips empty commands.qbl entries and non-matching names', async () => {
    const encoder = new TextEncoder()
    const bytes = buildZip([
      { name: 'commands.qbl', data: new Uint8Array(0) },
      { name: 'readme.txt', data: encoder.encode('not a qbl') },
    ])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([])
  })

  it('decodes UTF-16LE commands.qbl content inside the archive', async () => {
    const content = concatBytes([new Uint8Array([0xff, 0xfe]), utf16leBytes('[QuickButton]\nButton_1_Name=U16\nButton_1_Action=echo u16')])
    const bytes = buildZip([{ name: 'commands.qbl', data: content }])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([{ label: 'U16', cmd: 'echo u16' }])
  })

  it('sums skipped scripts across sets', async () => {
    const encoder = new TextEncoder()
    const bytes = buildZip([
      { name: 'a/commands.qbl', data: encoder.encode('[QuickButton]\nButton_1_Action=./a\nButton_1_Type=2') },
      { name: 'b/commands.qbl', data: encoder.encode('[QuickButton]\nButton_1_Action=./b\nButton_1_Type=2') },
    ])
    const result = await parseXshellQblx(new Uint8Array(bytes).buffer)
    expect(result.commands).toEqual([])
    expect(result.skippedScripts).toBe(2)
  })

  it('returns an empty result for non-archive bytes', async () => {
    const notZip = new Uint8Array(64).fill(0x42)
    const result = await parseXshellQblx(new Uint8Array(notZip).buffer)
    expect(result.commands).toEqual([])
    expect(result.skippedScripts).toBe(0)
  })

  it('returns an empty result for bytes shorter than the EOCD window', async () => {
    const tiny = new TextEncoder().encode('short')
    const result = await parseXshellQblx(new Uint8Array(tiny).buffer)
    expect(result.commands).toEqual([])
  })

  it('finds the EOCD when trailing bytes follow the archive', async () => {
    const base = buildZip([{ name: 'commands.qbl', data: new TextEncoder().encode('[QuickButton]\nButton_1_Name=T\nButton_1_Action=echo t') }])
    const withTrailing = concatBytes([base, new TextEncoder().encode('garbage!')])
    const result = await parseXshellQblx(new Uint8Array(withTrailing).buffer)
    expect(result.commands).toEqual([{ label: 'T', cmd: 'echo t' }])
  })
})
