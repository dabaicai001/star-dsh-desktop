/**
 * StarHub `@` 文件 source(2026-08-24):在 dsh ui-input-trigger 流水线注册
 * 第二个 `@` source(与 starhub-asset 并行),候选来自当前会话工作区(cwd)
 * 的文件/文件夹,按名称模糊过滤;pick 产出 ReferenceInsert(codec serialize
 * 输出纯文本 `@文件名 (路径)`,与文件树右键/信息窗的引用文本一致)。
 *
 * 兼容性:同一 trigger 多 source 按组并列显示,互不干扰;文件 source 不实现
 * lexicon(目录列表是异步 IPC,无法同步供装饰扫描),因此已输入的 `@文件名`
 * 纯文本不做 chip 装饰,但不影响 pick 与提交——序列化产物与右键引用完全
 * 一致,模型都能拿到完整路径做专项修改。
 */
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext, InputTriggerCandidate, InputTriggerSource, PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { renderFileReference } from './file-tree/FileInfoDialog.tsx'
import { listLocalDirectory, type LocalFileEntry } from './file-tree/file-tree-service.ts'

/** source 名(菜单分组与 codec 路由键)。 */
export const STARHUB_FILE_SOURCE = 'starhub-file'

/** 触发字符(与资产 source 共用 `@`)。 */
const STARHUB_FILE_TRIGGER = '@'

/** 噪音目录:递归收集时跳过,避免 @ 菜单被依赖树淹没。 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'out', 'coverage',
  '.next', '.nuxt', '.idea', '.vscode', '__pycache__', '.venv',
])

/** 递归深度上限(项目嵌套过深时保护性能)。 */
const MAX_DEPTH = 6
/** 候选总数上限(菜单不至于刷爆)。 */
const MAX_CANDIDATES = 200

/** 候选对象 → 文件条目的关联(WeakMap 随菜单生命周期自然回收)。 */
const byCandidate = new WeakMap<InputTriggerCandidate, LocalFileEntry>()

/** 路径 → 类型(codec 序列化需要判断目录引用加 `/`)。 */
const kindByPath = new Map<string, 'directory' | 'file'>()

/** 会话 cwd:经 sessions 服务按 sessionId 解析;无工作区返回 undefined。 */
function sessionCwd(sessions: ISessions, sessionId: string): string | undefined {
  const list = sessions.list.getSnapshot()
  return list.byId[sessionId as SessionId]?.cwd
}

/** 相对 cwd 的展示路径(Windows 反斜杠保留原样,只做前缀剥离)。 */
function relativeTo(cwd: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  /* v8 ignore next 1 -- entries always come from listLocalDirectory(root); a foreign path (symlink escape) is unreachable */
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : path
}

/** 目录在前、文件在后,各自按名称升序。 */
function sortEntries(entries: readonly LocalFileEntry[]): LocalFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === 'directory' && b.kind !== 'directory') return -1
    if (a.kind !== 'directory' && b.kind === 'directory') return 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * 递归收集工作区内的候选条目:空 query 只列 cwd 顶层;非空 query 时逐层
 * 展开匹配的目录(跳过噪音目录,深度/总数封顶)。
 * @param cwd - 会话工作区绝对路径。
 * @param query - 触发 token 后的查询文本(已 trim + lowercase)。
 * @param signal - 候选请求取消信号。
 * @returns 候选列表;目录优先,名称模糊匹配。
 */
async function collectCandidates(
  cwd: string,
  query: string,
  signal: AbortSignal,
): Promise<readonly InputTriggerCandidate[]> {
  const items: InputTriggerCandidate[] = []
  const push = (entry: LocalFileEntry): void => {
    if (signal.aborted) return
    if (items.length >= MAX_CANDIDATES) return
    if (IGNORED_DIRS.has(entry.name)) return
    const candidate: InputTriggerCandidate = {
      name: entry.name,
      icon: entry.kind === 'directory' ? '文件夹' : '文件',
      ...(relativeTo(cwd, entry.path) !== entry.name ? { description: relativeTo(cwd, entry.path) } : {}),
    }
    byCandidate.set(candidate, entry)
    kindByPath.set(entry.path, entry.kind === 'directory' ? 'directory' : 'file')
    items.push(candidate)
  }

  const walk = async (dir: string, depth: number, seen: ReadonlySet<string>): Promise<void> => {
    if (signal.aborted || items.length >= MAX_CANDIDATES) return
    if (depth > MAX_DEPTH || seen.has(dir)) return
    const nextSeen = new Set(seen).add(dir)
    let entries: LocalFileEntry[]
    try {
      entries = sortEntries(await listLocalDirectory(dir))
    } catch {
      return // 单目录读取失败(权限/消失):跳过,不阻塞整体
    }
    for (const entry of entries) {
      if (signal.aborted || items.length >= MAX_CANDIDATES) return
      if (IGNORED_DIRS.has(entry.name)) continue
      if (entry.kind !== 'directory') {
        // walk 只被非空 query 调用,`query === ''` 恒假,省略。
        if (entry.name.toLowerCase().includes(query)) push(entry)
        continue
      }
      // 目录:名称匹配时入候选;不匹配仍深入(路径可能匹配更深层文件)。
      if (entry.name.toLowerCase().includes(query)) push(entry)
      await walk(entry.path, depth + 1, nextSeen)
    }
  }

  // 空 query:只列 cwd 顶层(避免打开 @ 就全量递归)。
  if (query === '') {
    try {
      for (const entry of sortEntries(await listLocalDirectory(cwd))) push(entry)
    } catch {
      // 根目录不可读:空候选。
    }
    return items
  }
  await walk(cwd, 0, new Set())
  return items
}

/**
 * Create the `@` file source: candidates from the session cwd tree, pick
 * inserts a reference whose model form is `@文件名 (路径)`.
 * @param deps - sessions service (for the session cwd).
 * @returns the source; register via ctx.effect on `ctx.inputTriggers`.
 */
export function createStarhubFileSource(deps: { sessions: ISessions }): InputTriggerSource {
  return {
    trigger: STARHUB_FILE_TRIGGER,
    name: STARHUB_FILE_SOURCE,
    order: 10, // 排在资产 source(默认 0)之后
    candidates(session: ClientSessionContext, req: { query: string; position: 'leading' | 'inline'; signal: AbortSignal }): Promise<readonly InputTriggerCandidate[]> {
      const cwd = sessionCwd(deps.sessions, session.sessionId)
      if (cwd === undefined) return Promise.resolve([])
      return collectCandidates(cwd, req.query.trim().toLowerCase(), req.signal)
    },
    onPick({ candidate }): PickOutcome {
      const entry = byCandidate.get(candidate)
      if (entry === undefined) {
        // 非本 source 产出的候选(防御路径):退回普通文本引用。
        return { text: `@${candidate.name} ` }
      }
      const kind = entry.kind === 'directory' ? 'directory' : 'file'
      return {
        insert: {
          source: STARHUB_FILE_SOURCE,
          ref: entry.path,
          label: kind === 'directory' ? `${entry.name}/` : entry.name,
          clipboardText: `@${entry.name}`,
        },
      }
    },
    codec: {
      clipboardText: (ref: string) => {
        /* v8 ignore next 1 -- split always yields ≥1 member; at(-1) is never undefined */
        const name = ref.split(/[\\/]/).at(-1) ?? ref
        return `@${name}`
      },
      serialize: (ref: string) => {
        /* v8 ignore next 1 -- split always yields ≥1 member; at(-1) is never undefined */
        const name = ref.split(/[\\/]/).at(-1) ?? ref
        return Promise.resolve(renderFileReference(name, ref, kindByPath.get(ref) ?? 'file'))
      },
    },
  }
}
