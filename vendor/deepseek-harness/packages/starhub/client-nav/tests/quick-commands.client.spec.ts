// @vitest-environment jsdom
/**
 * 快捷命令持久化(quick-commands.ts):localStorage 加载/保存(含畸形 JSON 与
 * 空状态)、.qbl/.qblx 导入(经 File.arrayBuffer,存储式 ZIP 即可,不依赖
 * jsdom 之外的解压能力)、新建命令与 id 生成。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createQuickCommand, importQuickCommands, loadQuickCommands, saveQuickCommands,
} from '../src/client/terminal/quick-commands.ts'
import { decodeQblText, parseXshellQblDetailed } from '../src/client/terminal/xshell-quick-command.ts'

const STORAGE_KEY = 'starhub:ssh:quick-commands'

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

/** 手工构造存储式(method 0)ZIP,供 .qblx 导入路径使用。 */
function buildStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const raw = entry.data

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0, true)
    lv.setUint16(8, 0, true)
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0, true)
    lv.setUint32(14, 0, true)
    lv.setUint32(18, raw.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    chunks.push(local, raw)

    const centralEntry = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(centralEntry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, 0, true)
    cv.setUint32(20, raw.length, true)
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
    offset += local.length + raw.length
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

beforeEach(() => {
  window.localStorage.clear()
})

describe('loadQuickCommands', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(loadQuickCommands()).toEqual([])
  })

  it('returns an empty array for malformed JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadQuickCommands()).toEqual([])
  })

  it('returns an empty array when the stored value is not an array', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }))
    expect(loadQuickCommands()).toEqual([])
  })

  it('filters entries missing required string fields', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: '1', label: 'a', cmd: 'b' },
      null,
      42,
      'text',
      { id: '2', label: 'x' },
      { id: '3', cmd: 'y' },
      { label: 'z', cmd: 'w' },
      { id: 4, label: 'n', cmd: 'm' },
    ]))
    expect(loadQuickCommands()).toEqual([{ id: '1', label: 'a', cmd: 'b' }])
  })
})

describe('saveQuickCommands', () => {
  it('persists commands and round-trips through loadQuickCommands', () => {
    saveQuickCommands([{ id: '1', label: 'ls', cmd: 'ls -la' }])
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify([{ id: '1', label: 'ls', cmd: 'ls -la' }]))
    expect(loadQuickCommands()).toEqual([{ id: '1', label: 'ls', cmd: 'ls -la' }])
  })
})

describe('importQuickCommands', () => {
  it('imports a .qblx archive with fresh ids and skipped-script counts', async () => {
    const zipBytes = buildStoredZip([{
      name: 'commands.qbl',
      data: new TextEncoder().encode('[QuickButton]\nButton_1_Name=Z\nButton_1_Action=echo z\nButton_2_Action=./s\nButton_2_Type=2'),
    }])
    const file = new File([new Uint8Array(zipBytes)], 'quick.qblx')
    const result = await importQuickCommands(file)
    expect(result.commands).toEqual([
      expect.objectContaining({ label: 'Z', cmd: 'echo z' }),
    ])
    expect(result.commands[0]?.id).toMatch(/^quick-\d+-[a-z0-9]{6}$/)
    expect(result.skippedScripts).toBe(1)
  })

  it('imports a .qbl file with fresh ids', async () => {
    const bytes = new TextEncoder().encode('[QuickButton]\nButton_1_Name=L\nButton_1_Action=echo l')
    const file = new File([bytes], 'quick.qbl')
    const result = await importQuickCommands(file)
    expect(result.commands).toEqual([
      expect.objectContaining({ label: 'L', cmd: 'echo l' }),
    ])
    expect(result.commands[0]?.id).toMatch(/^quick-\d+-[a-z0-9]{6}$/)
    expect(result.skippedScripts).toBe(0)
  })

  it('matches file extensions case-insensitively', async () => {
    const bytes = new TextEncoder().encode('[QuickButton]\nButton_1_Name=U\nButton_1_Action=echo u')
    const file = new File([bytes], 'QUICK.QBL')
    const result = await importQuickCommands(file)
    expect(result.commands[0]?.label).toBe('U')
  })

  it('rejects files that are not .qbl or .qblx', async () => {
    const file = new File(['nope'], 'quick.txt')
    await expect(importQuickCommands(file)).rejects.toThrow('请选择 Xshell .qbl 或 .qblx 文件')
  })
})

describe('createQuickCommand', () => {
  it('creates a command with a fresh id and defaulted fields', () => {
    const command = createQuickCommand()
    expect(command.id).toMatch(/^quick-\d+-[a-z0-9]{6}$/)
    expect(command.label).toBe('')
    expect(command.cmd).toBe('')
  })

  it('creates a command with the provided label and cmd', () => {
    const command = createQuickCommand('ls', 'ls -la')
    expect(command.id).toMatch(/^quick-\d+-[a-z0-9]{6}$/)
    expect(command.label).toBe('ls')
    expect(command.cmd).toBe('ls -la')
  })

  it('generates distinct ids across calls', () => {
    expect(createQuickCommand().id).not.toBe(createQuickCommand().id)
  })
})

describe('import round-trip with parse helpers', () => {
  it('matches the standalone qbl parser and decoder', async () => {
    const qbl = '[QuickButton]\nButton_1_Name=R\nButton_1_Action=echo r'
    const file = new File([new TextEncoder().encode(qbl)], 'r.qbl')
    const imported = await importQuickCommands(file)
    const parsed = parseXshellQblDetailed(qbl).commands
    expect(imported.commands.map(command => ({ label: command.label, cmd: command.cmd }))).toEqual(parsed)
    expect(imported.commands.every(command => /^quick-\d+-[a-z0-9]{6}$/.test(command.id))).toBe(true)
    expect(decodeQblText(await file.arrayBuffer())).toBe(qbl)
  })
})
