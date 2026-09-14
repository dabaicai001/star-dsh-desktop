/**
 * Git 文本输出纯解析器(Git 工作台数据层):porcelain v1 -z 状态记录、
 * git log 定制 pretty 记录、diff 行分类与超长截断。全部为纯函数、零 I/O,
 * 供 GitWorkbenchPanel 消费,vitest 直接覆盖边界(中文路径 / rename / 混合状态)。
 */

/** 一条 porcelain v1 -z 状态记录(X=暂存区状态位,Y=工作树状态位)。 */
export interface GitStatusEntry {
  readonly x: string
  readonly y: string
  /** 相对仓库根的路径(rename/copy 时为新路径;-z 模式不做引号转义)。 */
  readonly path: string
  /** rename/copy 的原路径(仅 R/C 状态位存在)。 */
  readonly origPath?: string
}

/** 状态四分类:已暂存 / 未暂存(已跟踪) / 未跟踪 / 合并冲突。 */
export type GitChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'conflicts'

/** 合并冲突状态位组合(porcelain v1 XY 格式)。 */
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** 判断一条状态记录是否为合并冲突。 */
export function isConflictEntry(entry: GitStatusEntry): boolean {
  return CONFLICT_PAIRS.has(entry.x + entry.y)
}

/** 分类后的状态组(同一文件改动既未暂存又有已暂存部分时,同时出现在两组)。 */
export interface GitStatusGroups {
  readonly staged: readonly GitStatusEntry[]
  readonly unstaged: readonly GitStatusEntry[]
  readonly untracked: readonly GitStatusEntry[]
  /** 合并冲突文件(UU/AA/DD 等);处理完冲突 git add 后回到 staged 组。 */
  readonly conflicts: readonly GitStatusEntry[]
}

/**
 * 解析 `git status --porcelain=v1 -z` 输出。记录以 NUL 分隔,形如
 * `XY <path>`;R/C(rename/copy)时原路径紧跟在同记录后的下一个 NUL 字段。
 * -z 模式下路径不经过引号转义,中文/空格路径原样保留。
 * @param raw - git 命令 stdout(允许带尾随 NUL/空白)。
 * @returns 状态记录列表(忽略空字段与畸形短记录)。
 */
export function parseGitStatusZ(raw: string): readonly GitStatusEntry[] {
  const fields = raw.split('\0')
  const entries: GitStatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    // 形如 `XY path`:两位状态 + 一个空格 + 至少 1 字符路径
    if (field === undefined || field.length < 4 || field.charAt(2) !== ' ') continue
    const x = field.charAt(0)
    const y = field.charAt(1)
    const path = field.slice(3)
    if (x === '?' && y === '?') {
      entries.push({ x, y, path })
      continue
    }
    const entry: { x: string; y: string; path: string; origPath?: string } = { x, y, path }
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const orig = fields[i + 1]
      if (orig !== undefined && orig !== '') {
        entry.origPath = orig
        i++
      }
    }
    entries.push(entry)
  }
  return entries
}

/**
 * 把状态记录归入三组。`??` → 未跟踪;`!!`(ignored,默认不输出)跳过;
 * X 位非空格/问号 → 有已暂存改动;Y 位非空格/问号 → 有未暂存改动。
 * @param entries - parseGitStatusZ 的输出。
 * @returns 三组分类结果。
 */
export function classifyGitStatus(entries: readonly GitStatusEntry[]): GitStatusGroups {
  const staged: GitStatusEntry[] = []
  const unstaged: GitStatusEntry[] = []
  const untracked: GitStatusEntry[] = []
  const conflicts: GitStatusEntry[] = []
  for (const entry of entries) {
    if (entry.x === '?' && entry.y === '?') {
      untracked.push(entry)
      continue
    }
    if (entry.x === '!' && entry.y === '!') continue
    if (isConflictEntry(entry)) {
      conflicts.push(entry)
      continue
    }
    if (entry.x !== ' ' && entry.x !== '?') staged.push(entry)
    if (entry.y !== ' ' && entry.y !== '?') unstaged.push(entry)
  }
  return { staged, unstaged, untracked, conflicts }
}

/** 一条提交记录(git log 定制 pretty 的解析产物)。 */
export interface GitLogEntry {
  /** 完整 40 位哈希(git show 用)。 */
  readonly hash: string
  /** 短哈希(列表展示用)。 */
  readonly short: string
  readonly author: string
  /** 作者日期(ISO 8601,%aI)。 */
  readonly date: string
  readonly subject: string
  /** refs 装饰(已剥外层括号,如 `HEAD -> main, origin/main`);无装饰为空串。 */
  readonly refs: string
}

/** git log 的 pretty 模板(\x1f 分字段、\x1e 分记录;字段值可含任意可见字符)。 */
export const GIT_LOG_PRETTY = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%d%x1e'

/**
 * 解析 GIT_LOG_PRETTY 输出为提交记录列表。
 * @param raw - git 命令 stdout(空输出 → 空数组,如空仓库)。
 * @returns 提交记录(保持 git 输出顺序,新→旧)。
 */
export function parseGitLogPretty(raw: string): readonly GitLogEntry[] {
  return raw
    .split('\x1e')
    .map(record => record.replace(/^\n+/, '').trim())
    .filter(record => record !== '')
    .map((record) => {
      const [hash = '', short = '', author = '', date = '', subject = '', refs = '']
        = record.split('\x1f')
      const refsTrimmed = refs.trim()
      return {
        hash, short, author, date, subject,
        refs: /^\(.*\)$/.test(refsTrimmed) ? refsTrimmed.slice(1, -1) : refsTrimmed,
      }
    })
}

/** unified diff 单行的类别(着色用)。 */
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

/**
 * 判定一行 unified diff 输出的类别。注意 `--- a/x` / `+++ b/x` 以 +/- 开头,
 * 必须先于 add/del 判定,否则文件头行会被当成增/删行着色。
 * @param line - diff 输出中的一行。
 * @returns 行类别。
 */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ')
    || line.startsWith('+++ ') || line.startsWith('\\')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/** diff 渲染字符上限:超出截断,避免超大 patch 撑爆 DOM。 */
export const DIFF_CHAR_LIMIT = 120_000

/**
 * 按字符上限截断 diff 文本并标注。
 * @param text - 完整 diff 输出。
 * @param limit - 字符上限(默认 DIFF_CHAR_LIMIT)。
 * @returns 原文或截断文本(带截断标注尾行)。
 */
export function capDiff(text: string, limit: number = DIFF_CHAR_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(diff 过长,已截断)`
}
