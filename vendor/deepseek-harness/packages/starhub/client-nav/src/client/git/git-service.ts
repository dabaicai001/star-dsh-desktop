/**
 * 会话工作区 git 服务(2026-08-21,会话头部「分支胶囊」的数据层):
 * 全部经 Tauri `local_shell_exec` 在会话 cwd 下跑固定形式的 git 子命令;
 * 浏览器预览(无 Tauri IPC)调用方先行隐藏,这里只做薄封装。
 *
 * 安全面:命令形状固定,唯一插值是分支名(来自 git 自身输出)与提交信息
 * (PowerShell 单引号转义);不提供任意命令入口。
 */
import { tauriInvoke } from '../tauri.ts'
import { GIT_LOG_PRETTY, parseGitLogPretty, parseGitStatusZ, type GitLogEntry, type GitStatusEntry } from './git-parse.ts'

/** `local_shell_exec` 的返回(serde camelCase)。 */
export interface LocalShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly elapsedMs: number
  readonly truncated: boolean
}

/** 一次 git 操作的简化结果。 */
export interface GitOutcome {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/** PowerShell 单引号字符串转义(单引号翻倍)。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 在工作区目录执行一条固定形状的 git 命令。
 * @param cwd - 会话工作区绝对路径。
 * @param command - 完整 git 命令行(内部组装,不接受用户输入直拼)。
 * @param timeoutSec - 超时秒数(push 等网络操作给 120)。
 * @returns 简化结果;IPC/进程级失败转为 ok:false。
 */
/**
 * 去除尾随 NUL 与换行(不移除行首空白:porcelain 的 XY 状态位里,
 * 行首空格是「未暂存」的合法状态位,trim 掉会导致解析丢记录)。
 */
function stripTrailingNul(text: string): string {
  return text.replace(/[\0\r\n]+$/, '')
}

async function runGit(cwd: string, command: string, timeoutSec?: number): Promise<GitOutcome> {
  try {
    const result = await tauriInvoke<LocalShellResult>('local_shell_exec', {
      command,
      workingDir: cwd,
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
    })
    return {
      ok: result.exitCode === 0,
      stdout: stripTrailingNul(result.stdout),
      stderr: result.stderr.trim(),
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读当前分支名;detached HEAD 返回 `( detached <短sha> )`,非 git 仓库返回 null。
 * @param cwd - 会话工作区绝对路径。
 * @returns 分支展示名;非仓库/IPC 不可用返回 null。
 */
export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  const branch = await runGit(cwd, 'git branch --show-current')
  if (branch.ok && branch.stdout !== '') return branch.stdout
  const head = await runGit(cwd, 'git rev-parse --short HEAD')
  if (head.ok && head.stdout !== '') return `(detached ${head.stdout})`
  return null
}

/**
 * 列本地分支名(当前分支除外不特殊标注,由调用方对照)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 分支名列表;失败返回空数组。
 */
export async function gitListBranches(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, 'git branch "--format=%(refname:short)"')
  if (!result.ok) return []
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * 列远程跟踪分支名(`origin/xxx`;只读本地 refs,不联网,同步用 gitFetch)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 远程分支列表(过滤 symbolic `origin/HEAD`);失败返回空数组。
 */
export async function gitListRemoteBranches(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, 'git branch -r "--format=%(refname:short)"')
  if (!result.ok) return []
  return result.stdout.split('\n').map(line => line.trim())
    .filter(line => line !== '' && !line.endsWith('/HEAD'))
}

/**
 * 同步远程引用(git fetch --all --prune,网络操作超时 120s)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 简化结果。
 */
export function gitFetch(cwd: string): Promise<GitOutcome> {
  return runGit(cwd, 'git fetch --all --prune', 120)
}

/**
 * 把远程分支拉取到本地:创建同名本地跟踪分支并切换
 * (git checkout -b <名> --track <远程引用>)。本地已存在同名分支时退化为普通切换。
 * @param cwd - 会话工作区绝对路径。
 * @param remoteRef - 远程引用(如 `origin/feat/x`,来自 gitListRemoteBranches)。
 * @param localExists - 本地是否已有同名分支(有则直接 checkout,避免 -b 冲突报错)。
 * @returns 简化结果。
 */
export function gitCheckoutRemote(cwd: string, remoteRef: string, localExists: boolean): Promise<GitOutcome> {
  const local = remoteRef.slice(remoteRef.indexOf('/') + 1)
  if (localExists) return runGit(cwd, `git checkout ${psQuote(local)}`)
  return runGit(cwd, `git checkout -b ${psQuote(local)} --track ${psQuote(remoteRef)}`)
}

/**
 * 工作区是否有未提交改动(切换分支前的提示依据)。
 * @param cwd - 会话工作区绝对路径。
 * @returns true = 有改动;命令失败按 false 处理(不阻塞操作)。
 */
export async function gitIsDirty(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, 'git status --porcelain')
  return result.ok && result.stdout !== ''
}

/**
 * 切换分支。
 * @param cwd - 会话工作区绝对路径。
 * @param branch - 目标分支名(来自 gitListBranches,不做任意输入)。
 * @returns 简化结果。
 */
export function gitCheckout(cwd: string, branch: string): Promise<GitOutcome> {
  return runGit(cwd, `git checkout ${psQuote(branch)}`)
}

/**
 * 暂存全部改动并提交(git add -A && git commit)。
 * @param cwd - 会话工作区绝对路径。
 * @param message - 提交信息(PowerShell 单引号转义)。
 * @returns 简化结果。
 */
export async function gitCommitAll(cwd: string, message: string): Promise<GitOutcome> {
  const add = await runGit(cwd, 'git add -A')
  if (!add.ok) return add
  return runGit(cwd, `git commit -m ${psQuote(message)}`)
}

/**
 * 推送当前分支(git push,网络操作超时 120s)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 简化结果。
 */
export function gitPush(cwd: string): Promise<GitOutcome> {
  return runGit(cwd, 'git push', 120)
}

/**
 * 拉取当前分支(git pull,网络操作超时 120s)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 简化结果。
 */
export function gitPull(cwd: string): Promise<GitOutcome> {
  return runGit(cwd, 'git pull', 120)
}

/**
 * 读当前分支与上游的 ahead/behind 计数。
 * @param cwd - 会话工作区绝对路径。
 * @returns [ahead, behind];无上游/非 git 仓库/命令失败返回 null。
 */
export async function gitAheadBehind(cwd: string): Promise<readonly [number, number] | null> {
  const result = await runGit(cwd, 'git rev-list --left-right --count HEAD...@{upstream}')
  if (!result.ok) return null
  const match = /^(\d+)\s+(\d+)$/.exec(result.stdout)
  if (match === null) return null
  return [Number(match[1]), Number(match[2])]
}

/**
 * 读工作区状态(porcelain v1 -z:路径含中文/空格不会被引号破坏)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 状态记录;非 git 仓库/命令失败返回 null(调用方据以渲染空态)。
 */
export async function gitStatus(cwd: string): Promise<readonly GitStatusEntry[] | null> {
  const result = await runGit(cwd, 'git status --porcelain=v1 -z')
  if (!result.ok) return null
  return parseGitStatusZ(result.stdout)
}

/**
 * 暂存指定文件(git add -- <paths>;未跟踪文件同样适用)。
 * @param cwd - 会话工作区绝对路径。
 * @param paths - 相对仓库根的文件路径(来自 git status 输出,经单引号转义)。
 * @returns 简化结果。
 */
export function gitStage(cwd: string, paths: readonly string[]): Promise<GitOutcome> {
  return runGit(cwd, `git add -- ${paths.map(psQuote).join(' ')}`)
}

/**
 * 暂存全部改动(git add -A,含删除与新文件)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 简化结果。
 */
export function gitStageAll(cwd: string): Promise<GitOutcome> {
  return runGit(cwd, 'git add -A')
}

/**
 * 取消暂存(git restore --staged -- <paths>;不动工作树内容)。
 * @param cwd - 会话工作区绝对路径。
 * @param paths - 相对仓库根的文件路径。
 * @returns 简化结果。
 */
export function gitUnstage(cwd: string, paths: readonly string[]): Promise<GitOutcome> {
  return runGit(cwd, `git restore --staged -- ${paths.map(psQuote).join(' ')}`)
}

/**
 * 放弃工作树改动(git restore -- <paths>;仅已跟踪文件,不可恢复)。
 * @param cwd - 会话工作区绝对路径。
 * @param paths - 相对仓库根的已跟踪文件路径。
 * @returns 简化结果。
 */
export function gitDiscard(cwd: string, paths: readonly string[]): Promise<GitOutcome> {
  return runGit(cwd, `git restore -- ${paths.map(psQuote).join(' ')}`)
}

/**
 * 删除未跟踪文件(git clean -f -- <paths>;pathspec 限定到具体文件,不递归目录)。
 * @param cwd - 会话工作区绝对路径。
 * @param paths - 相对仓库根的未跟踪文件路径。
 * @returns 简化结果。
 */
export function gitCleanPath(cwd: string, paths: readonly string[]): Promise<GitOutcome> {
  return runGit(cwd, `git clean -f -- ${paths.map(psQuote).join(' ')}`)
}

/**
 * 中止进行中的合并(git merge --abort;回到合并前状态)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 简化结果。
 */
export function gitMergeAbort(cwd: string): Promise<GitOutcome> {
  return runGit(cwd, 'git merge --abort')
}

/**
 * 读单文件 diff(--no-ext-diff 禁外部 diff 工具;-U3 上下文)。
 * @param cwd - 会话工作区绝对路径。
 * @param path - 相对仓库根的文件路径。
 * @param staged - true 读已暂存 diff(--cached),false 读未暂存 diff。
 * @returns diff 文本(无差异为空串);命令失败返回 null。
 */
export async function gitDiffFile(cwd: string, path: string, staged: boolean): Promise<string | null> {
  const command = staged
    ? `git diff --no-ext-diff -U3 --cached -- ${psQuote(path)}`
    : `git diff --no-ext-diff -U3 -- ${psQuote(path)}`
  const result = await runGit(cwd, command)
  return result.ok ? result.stdout : null
}

/**
 * 读提交历史(新→旧;git log 定制 pretty,\x1f/\x1e 控制字符分字段/分记录,
 * 主题含引号/反引号不会破坏解析)。
 * @param cwd - 会话工作区绝对路径。
 * @param limit - 读取条数(内部固定值,非用户输入)。
 * @returns 提交列表;非 git 仓库/命令失败(含空仓库无 HEAD)返回 null。
 */
export async function gitLog(cwd: string, limit: number): Promise<readonly GitLogEntry[] | null> {
  const result = await runGit(cwd, `git log -n ${limit} "--pretty=${GIT_LOG_PRETTY}"`)
  if (!result.ok) return null
  return parseGitLogPretty(result.stdout)
}

/**
 * 提交已暂存改动(git commit -m;不自动暂存,提交哪些由暂存区决定)。
 * @param cwd - 会话工作区绝对路径。
 * @param message - 提交信息(PowerShell 单引号转义)。
 * @returns 简化结果。
 */
export function gitCommitStaged(cwd: string, message: string): Promise<GitOutcome> {
  return runGit(cwd, `git commit -m ${psQuote(message)}`)
}

/**
 * 读单条提交的完整补丁(git show,含提交头与 unified diff)。hash 必须放在
 * `--` 之前——`--` 之后是 pathspec,`git show ... -- <hash>` 会把哈希当路径
 * 过滤而返回空输出(已实测)。
 * @param cwd - 会话工作区绝对路径。
 * @param hash - 完整哈希(来自 gitLog 输出)。
 * @returns 补丁文本;命令失败返回 null。
 */
export async function gitShowCommit(cwd: string, hash: string): Promise<string | null> {
  const result = await runGit(cwd, `git show --no-ext-diff -U3 --no-color "--pretty=commit %h  %s%n%an  %aI" ${psQuote(hash)} --`)
  return result.ok ? result.stdout : null
}

/** AI 生成提交信息的 host 端点(dsh-starhub-commit-message 插件注册)。 */
export const COMMIT_MESSAGE_ENDPOINT = '/starhub/git/commit-message'

/** AI 草稿结果:成功带 message,失败带 error。 */
export interface GitDraftOutcome {
  readonly ok: boolean
  readonly message: string
  readonly error: string
}

/** 变更摘要截断上限(host 端 maxInputBytes 16KB,客户端留足余量)。 */
const DRAFT_STATUS_LIMIT = 8 * 1024
const DRAFT_STAT_LIMIT = 4 * 1024

/** 按字符上限截断并标注(超限部分对草稿质量影响不大)。 */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(截断)`
}

/**
 * 采集工作区变更摘要(status + diffstat + 近期提交主题),请求 host 端点
 * 生成草稿提交信息。非 git 仓库/无改动/端点不可用都转为 ok:false。
 * @param cwd - 会话工作区绝对路径。
 * @returns 草稿结果;浏览器预览(无 Tauri IPC)在 status 一步即失败。
 */
export async function gitDraftCommitMessage(cwd: string): Promise<GitDraftOutcome> {
  const fail = (error: string): GitDraftOutcome => ({ ok: false, message: '', error })
  const [status, diffHead, log] = await Promise.all([
    runGit(cwd, 'git status --porcelain'),
    runGit(cwd, 'git diff HEAD --stat'),
    runGit(cwd, 'git log -8 "--pretty=%s"'),
  ])
  if (!status.ok) return fail(status.stderr || '读取工作区状态失败')
  if (status.stdout === '') return fail('工作区没有改动,无可提交的变更')
  // 新仓库尚无 HEAD 时 diff HEAD 失败,回落到未暂存 diff(新文件由 status 覆盖)。
  const stat = diffHead.ok ? diffHead.stdout : (await runGit(cwd, 'git diff --stat')).stdout
  const recentSubjects = log.ok ? log.stdout.split('\n').filter(line => line !== '') : []
  let response: Response
  try {
    response = await fetch(COMMIT_MESSAGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: clip(status.stdout, DRAFT_STATUS_LIMIT),
        diffStat: clip(stat, DRAFT_STAT_LIMIT),
        recentSubjects,
      }),
    })
  } catch (error) {
    return fail(`AI 端点不可达:${error instanceof Error ? error.message : String(error)}`)
  }
  let payload: { message?: unknown; error?: unknown }
  try {
    payload = await response.json() as { message?: unknown; error?: unknown }
  } catch {
    return fail(`AI 端点返回了非 JSON 响应(HTTP ${response.status})`)
  }
  if (!response.ok || typeof payload.message !== 'string') {
    return fail(typeof payload.error === 'string' ? payload.error : `AI 生成失败(HTTP ${response.status})`)
  }
  const message = payload.message.trim()
  return message === '' ? fail('模型没有产出文本,请重试') : { ok: true, message, error: '' }
}
