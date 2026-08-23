import { decodeQblText, parseXshellQblDetailed, parseXshellQblx, type XshellQuickCommand } from './xshell-quick-command.ts'

const STORAGE_KEY = 'starhub:ssh:quick-commands'

/** A persisted quick command: an Xshell command plus a locally-assigned id. */
export interface QuickCommand extends XshellQuickCommand {
  id: string
}

function createId(): string {
  return `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Load persisted quick commands from localStorage.
 * @returns the stored commands, or an empty array when missing or malformed.
 */
export function loadQuickCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is QuickCommand => (
      typeof entry === 'object' && entry !== null
      && typeof (entry as QuickCommand).id === 'string'
      && typeof (entry as QuickCommand).label === 'string'
      && typeof (entry as QuickCommand).cmd === 'string'
    ))
  } catch {
    return []
  }
}

/**
 * Persist quick commands to localStorage.
 * @param commands - the commands to store.
 */
export function saveQuickCommands(commands: QuickCommand[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(commands))
}

/**
 * Import quick commands from an Xshell .qbl or .qblx file.
 * @param file - the selected import file.
 * @returns the imported commands (each with a fresh id) plus the count of
 *   skipped script entries.
 */
export async function importQuickCommands(file: File): Promise<{ commands: QuickCommand[]; skippedScripts: number }> {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.qblx')) {
    const result = await parseXshellQblx(await file.arrayBuffer())
    return { commands: result.commands.map(command => ({ ...command, id: createId() })), skippedScripts: result.skippedScripts }
  }
  if (lowerName.endsWith('.qbl')) {
    const result = parseXshellQblDetailed(decodeQblText(await file.arrayBuffer()))
    return { commands: result.commands.map(command => ({ ...command, id: createId() })), skippedScripts: result.skippedScripts }
  }
  throw new Error('请选择 Xshell .qbl 或 .qblx 文件')
}

/**
 * Create a new quick command with a fresh id.
 * @param label - the command label (defaults to empty).
 * @param cmd - the command text (defaults to empty).
 * @returns the new quick command.
 */
export function createQuickCommand(label = '', cmd = ''): QuickCommand {
  return { id: createId(), label, cmd }
}
