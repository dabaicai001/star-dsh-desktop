/**
 * Git 工作台(2026-09-10):工具抽屉内跟随当前会话工作区(cwd)的 git 视图,
 * 入口为会话头部分支胶囊(GitBranchPill,点击把抽屉切到本视图)。三个 Tab:
 * - 变更:已暂存 / 未暂存 / 未跟踪三段文件列表,单文件 diff 查看,暂存/取消
 *   暂存/放弃(两步确认)/删除未跟踪(git clean,两步确认),提交已暂存
 *   (含 ✨AI 提交信息草稿,复用 dsh-starhub-commit-message 端点);
 * - 历史:近 50 条提交(短哈希/refs 徽标/主题/作者/日期),点击展开 git show 补丁;
 * - 分支:本地/远程分支搜索与切换(自原分支胶囊弹层迁入,远程分支点击拉取为
 *   本地跟踪分支)。
 * 头部操作行:刷新 / 同步远程 / 拉取 / 推送;非 git 工作区渲染空态。
 * 落地 Tab 由桥状态 initialTab 决定(胶囊点击落「分支」);页面重新可见时
 * 自动刷新当前 Tab(终端等外部改动回流);diff 视图紧随选中项所在分段渲染。
 * 数据层全部经 git-service 的固定形状 git 命令(local_shell_exec),本组件
 * 只做展示与交互编排,便于 vitest 以 __TAURI_INTERNALS__ stub 全覆盖。
 */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconBranchOutlineMedium, IconCloseOutlineMedium, IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  gitAheadBehind, gitCheckout, gitCheckoutRemote, gitCleanPath, gitCommitStaged, gitCurrentBranch,
  gitDiffFile, gitDiscard, gitDraftCommitMessage, gitFetch, gitListBranches,
  gitListRemoteBranches, gitLog, gitMergeAbort, gitPull, gitPush, gitShowCommit, gitStage, gitStageAll,
  gitStatus, gitUnstage, type GitOutcome,
} from './git-service.ts'
import {
  capDiff, classifyGitStatus, diffLineKind, type GitChangeGroup,
  type GitLogEntry, type GitStatusEntry,
} from './git-parse.ts'
import type { GitWorkbenchTab } from './git-workbench-state.ts'
import css from './GitWorkbenchPanel.module.css'

/** Git 工作台面板 props。 */
export interface GitWorkbenchPanelProps {
  /** 会话工作区绝对路径(git 命令的执行目录;子目录也能命中仓库根)。 */
  readonly cwd: string
  /** 打开时落到的 Tab(分支胶囊以分支管理为首要意图,落「分支」)。 */
  readonly initialTab: GitWorkbenchTab
  /** 返回资产列表(关闭 Git 工作台视图)。 */
  readonly onClose: () => void
}

/** 工作台 Tab(与桥状态共用同一类型)。 */
type WorkbenchTab = GitWorkbenchTab

/** 当前选中查看 diff 的文件。 */
interface SelectedFile {
  readonly path: string
  readonly group: GitChangeGroup
  readonly loading: boolean
  /** diff 文本;null = 未跟踪(占位)或读取失败(按 loading 区分)。 */
  readonly text: string | null
}

/** 两步确认目标:对哪个路径执行哪类危险操作。 */
interface ConfirmTarget {
  readonly path: string
  readonly action: 'discard' | 'clean'
}

/** 历史展开态:正在查看哪条提交的补丁。 */
interface ExpandedCommit {
  readonly hash: string
  readonly loading: boolean
  readonly text: string | null
}

/** 一次通知(ok/error,沿用分支胶囊的行内提示范式)。 */
interface Notice {
  readonly kind: 'ok' | 'error'
  readonly text: string
}

/** TAB 定义(id + 文案)。 */
const TABS: ReadonlyArray<{ readonly id: WorkbenchTab; readonly label: string }> = [
  { id: 'changes', label: '变更' },
  { id: 'history', label: '历史' },
  { id: 'branches', label: '分支' },
]

/** 历史一次读取条数。 */
const LOG_LIMIT = 50

/**
 * 渲染 Git 工作台面板。
 * @param props.cwd - 会话工作区绝对路径。
 * @param props.onClose - 返回资产列表。
 * @returns 工作台面板(含三 Tab 与行内通知)。
 */
export function GitWorkbenchPanel({ cwd, initialTab, onClose }: GitWorkbenchPanelProps) {
  const [tab, setTab] = useState<WorkbenchTab>(initialTab)
  /** 当前分支;null = 非 git 仓库。 */
  const [branch, setBranch] = useState<string | null>(null)
  /** 首次探测是否完成(完成前不渲染空态,避免闪烁)。 */
  const [probed, setProbed] = useState(false)
  /** 分类后的状态组;null = 状态读取失败。 */
  const [status, setStatus] = useState<ReturnType<typeof classifyGitStatus> | null>(null)
  const [log, setLog] = useState<readonly GitLogEntry[] | null>(null)
  const [branches, setBranches] = useState<{ readonly local: readonly string[]; readonly remote: readonly string[] }>(
    { local: [], remote: [] },
  )
  const [selected, setSelected] = useState<SelectedFile | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [expanded, setExpanded] = useState<ExpandedCommit | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 当前分支与上游的 ahead/behind;null = 无上游或读取失败。 */
  const [aheadBehind, setAheadBehind] = useState<readonly [number, number] | null>(null)

  /** 读当前分支 + 状态 + ahead/behind(挂载 / cwd 变化 / 变更操作后刷新)。 */
  const loadChanges = useCallback(async (dir: string) => {
    const [branchName, entries, ab] = await Promise.all([gitCurrentBranch(dir), gitStatus(dir), gitAheadBehind(dir)])
    setBranch(branchName)
    setStatus(entries !== null ? classifyGitStatus(entries) : null)
    setAheadBehind(ab)
    setProbed(true)
  }, [])

  /** 读提交历史(空仓库 git log 失败 → null → 渲染「暂无提交」)。 */
  const loadHistory = useCallback(async (dir: string) => {
    setLog(await gitLog(dir, LOG_LIMIT))
  }, [])

  /** 读本地 + 远程分支。 */
  const loadBranches = useCallback(async (dir: string) => {
    const [local, remote] = await Promise.all([gitListBranches(dir), gitListRemoteBranches(dir)])
    setBranches({ local, remote })
  }, [])

  // 挂载 / cwd 变化 / 落地 Tab 变化(面板已开时再次点胶囊):重载数据、清掉
  // 上个仓库的交互残留并回到落地 Tab。落地 Tab 非「变更」时它的数据也要
  // 加载(切 Tab 的懒加载只覆盖点击路径)。
  useEffect(() => {
    setSelected(null)
    setConfirmTarget(null)
    setExpanded(null)
    setNotice(null)
    setProbed(false)
    setBranch(null)
    setStatus(null)
    setAheadBehind(null)
    setTab(initialTab)
    void loadChanges(cwd)
    if (initialTab === 'history') void loadHistory(cwd)
    else if (initialTab === 'branches') void loadBranches(cwd)
  }, [cwd, initialTab, loadChanges, loadHistory, loadBranches])

  // 页面重新可见时刷新当前 Tab 数据:终端等外部 git 改动回流到面板
  // (胶囊自有 10s 轮询,面板不做定时轮询,可见性事件足够)。
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      if (tab === 'history') void loadHistory(cwd)
      else if (tab === 'branches') void loadBranches(cwd)
      else void loadChanges(cwd)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [tab, cwd, loadChanges, loadHistory, loadBranches])

  // 切 Tab:始终重载该 Tab 数据(命令廉价,保数据新鲜,免缓存失效逻辑)。
  const switchTab = (next: WorkbenchTab): void => {
    setTab(next)
    if (next === 'history') void loadHistory(cwd)
    else if (next === 'branches') void loadBranches(cwd)
  }

  /** 刷新按钮:重载当前 Tab 数据。 */
  const refresh = (): void => {
    if (tab === 'history') { void loadHistory(cwd); return }
    if (tab === 'branches') { void loadBranches(cwd); return }
    void loadChanges(cwd)
  }

  /**
   * 通用动作执行:busy 门 + 行内通知 + 成功后回调(重载)。
   * label 用名词式(「切换分支」),通知/忙碌文案由模板拼出;okText 可给出
   * 更具体成功文案(含目标名),缺省取 git stdout 首行或「<label>完成」。
   */
  const run = async (
    label: string,
    action: () => Promise<GitOutcome>,
    after?: () => Promise<void>,
    okText?: string,
  ): Promise<void> => {
    if (busy !== '') return
    setBusy(label)
    setNotice(null)
    const result = await action()
    setBusy('')
    if (result.ok) {
      const firstLine = result.stdout === '' ? undefined : result.stdout.split('\n')[0]
      setNotice({ kind: 'ok', text: okText ?? firstLine ?? `${label}完成` })
    } else {
      setNotice({ kind: 'error', text: result.stderr || `${label}失败` })
    }
    await after?.()
  }

  /** 变更类操作后的统一重载:状态 + 清选择(选择对应的 diff 已过期)。 */
  const reloadAfterChange = async (): Promise<void> => {
    setSelected(null)
    await loadChanges(cwd)
  }

  const onStage = (entry: GitStatusEntry): void => {
    void run('暂存', () => gitStage(cwd, [entry.path]), reloadAfterChange)
  }

  const onStageAll = (): void => {
    void run('暂存全部', () => gitStageAll(cwd), reloadAfterChange)
  }

  const onUnstage = (entry: GitStatusEntry): void => {
    void run('取消暂存', () => gitUnstage(cwd, [entry.path]), reloadAfterChange)
  }

  /** 两步确认后的执行:放弃(已跟踪)或删除(未跟踪,git clean)。 */
  const onConfirm = (target: ConfirmTarget): void => {
    setConfirmTarget(null)
    const action = target.action === 'discard'
      ? gitDiscard(cwd, [target.path])
      : gitCleanPath(cwd, [target.path])
    const label = target.action === 'discard' ? '放弃' : '删除'
    void run(label, () => action, reloadAfterChange)
  }

  const onSelect = (entry: GitStatusEntry, group: GitChangeGroup): void => {
    // 选中其它行时自动取消挂在行上的两步确认,避免确认条残留在视线外。
    setConfirmTarget(null)
    if (group === 'untracked') {
      setSelected({ path: entry.path, group, loading: false, text: null })
      return
    }
    setSelected({ path: entry.path, group, loading: true, text: null })
    void gitDiffFile(cwd, entry.path, group === 'staged').then((text) => {
      setSelected(prev => (prev !== null && prev.path === entry.path
        ? { path: entry.path, group, loading: false, text }
        : prev))
    })
  }

  const onCommit = (): void => {
    const message = commitMessage.trim()
    if (message === '') { setNotice({ kind: 'error', text: '提交信息不能为空' }); return }
    void run('提交', () => gitCommitStaged(cwd, message), async () => {
      setCommitMessage('')
      await loadChanges(cwd)
    })
  }

  /** AI 生成提交信息草稿(采集 status/diffstat/近期主题,回填输入框)。 */
  const onAiDraft = (): void => {
    if (busy !== '') return
    setBusy('生成')
    setNotice(null)
    void gitDraftCommitMessage(cwd)
      .then((result) => {
        if (result.ok) setCommitMessage(result.message)
        else setNotice({ kind: 'error', text: result.error })
      })
      .finally(() => { setBusy('') })
  }

  /** 展开/收起一条提交的补丁(再次点击同一行收起)。 */
  const toggleCommit = (entry: GitLogEntry): void => {
    if (expanded !== null && expanded.hash === entry.hash) { setExpanded(null); return }
    setExpanded({ hash: entry.hash, loading: true, text: null })
    void gitShowCommit(cwd, entry.hash).then((text) => {
      setExpanded(prev => (prev !== null && prev.hash === entry.hash
        ? { hash: entry.hash, loading: false, text }
        : prev))
    })
  }

  const onCheckout = (name: string): void => {
    if (name === branch) return
    void run('切换分支', () => gitCheckout(cwd, name), async () => {
      await Promise.all([loadChanges(cwd), loadBranches(cwd)])
      setSelected(null)
    }, `已切换到 ${name}`)
  }

  const onCheckoutRemote = (remoteRef: string): void => {
    const local = remoteRef.slice(remoteRef.indexOf('/') + 1)
    void run('拉取远程分支', () => gitCheckoutRemote(cwd, remoteRef, branches.local.includes(local)), async () => {
      await Promise.all([loadChanges(cwd), loadBranches(cwd)])
      setSelected(null)
    }, `已把 ${remoteRef} 拉取为本地分支 ${local}`)
  }

  const onFetch = (): void => {
    void run('同步远程', () => gitFetch(cwd), async () => { await loadBranches(cwd) })
  }

  const onPull = (): void => {
    void run('拉取', () => gitPull(cwd), async () => { await loadChanges(cwd) })
  }

  const onPush = (): void => {
    void run('推送', () => gitPush(cwd))
  }

  const onMergeAbort = (): void => {
    void run('中止合并', () => gitMergeAbort(cwd), reloadAfterChange)
  }

  const dirty = status !== null
    && (status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0)

  // 非 git 工作区:探测完成后渲染空态(探测中不渲染,避免闪烁)。
  if (probed && branch === null) {
    return (
      <div className={css.panel} role="dialog" aria-label="Git 工作台">
        <PanelHeader
          branch={null}
          dirty={false}
          aheadBehind={null}
          busy={busy}
          onRefresh={refresh}
          onFetch={onFetch}
          onPull={onPull}
          onPush={onPush}
          onClose={onClose}
        />
        <div className={css.emptyRoot}>
          <div className={css.emptyTitle}>当前工作区不是 git 仓库</div>
          <div className={css.emptyPath}>{cwd}</div>
          <button type="button" className={css.actionBtn} onClick={onClose}>返回资产列表</button>
        </div>
      </div>
    )
  }

  const stagedCount = status?.staged.length ?? 0
  const matches = (name: string): boolean => branchFilter === '' || name.toLowerCase().includes(branchFilter.toLowerCase())
  const visibleLocal = branches.local.filter(matches)
  // 本地已有同名分支的远程引用不重复列出(切本地分支即等价),symbolic */HEAD 亦然。
  const visibleRemote = branches.remote
    .filter(ref => !branches.local.includes(ref.slice(ref.indexOf('/') + 1)))
    .filter(matches)

  return (
    <div className={css.panel} role="dialog" aria-label="Git 工作台">
      <PanelHeader
        branch={branch}
        dirty={dirty}
        aheadBehind={aheadBehind}
        busy={busy}
        onRefresh={refresh}
        onFetch={onFetch}
        onPull={onPull}
        onPush={onPush}
        onClose={onClose}
      />
      {!probed ? (
        <div className={css.status}>读取 git 状态…</div>
      ) : (
        <>
          <div className={css.tabs} role="tablist" aria-label="Git 工作台分区">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={clsx(css.tab, tab === id && css.tabActive)}
                onClick={() => { switchTab(id) }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={css.body}>
            {tab === 'changes' && status !== null && (
              <ChangesTab
                status={status}
                selected={selected}
                confirmTarget={confirmTarget}
                commitMessage={commitMessage}
                busy={busy}
                stagedCount={stagedCount}
                onSelect={onSelect}
                onStage={onStage}
                onStageAll={onStageAll}
                onUnstage={onUnstage}
                onAskConfirm={setConfirmTarget}
                onCancelConfirm={() => { setConfirmTarget(null) }}
                onConfirm={onConfirm}
                onCommit={onCommit}
                onAiDraft={onAiDraft}
                onMessageChange={setCommitMessage}
                onMergeAbort={onMergeAbort}
              />
            )}
            {tab === 'changes' && status === null && (
              <div className={css.status}>
                <div>git 状态读取失败。</div>
                <button type="button" className={css.actionBtn} onClick={() => { void loadChanges(cwd) }}>重试</button>
              </div>
            )}
            {tab === 'history' && (
              <HistoryTab log={log} expanded={expanded} onToggle={toggleCommit} />
            )}
            {tab === 'branches' && (
              <BranchesTab
                branch={branch}
                visibleLocal={visibleLocal}
                visibleRemote={visibleRemote}
                filter={branchFilter}
                busy={busy}
                onFilterChange={setBranchFilter}
                onCheckout={onCheckout}
                onCheckoutRemote={onCheckoutRemote}
              />
            )}
          </div>
          {busy !== '' && !['同步远程', '拉取', '推送', '生成'].includes(busy) && (
            <div className={css.busyText}>{busy}中…</div>
          )}
          {notice !== null && (
            <div className={clsx(css.notice, notice.kind === 'error' ? css.noticeError : css.noticeOk)}>
              {notice.text}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 抽屉面板头:标题(分支 + 脏点 + ahead/behind)+ 操作行 + 关闭。 */
function PanelHeader({ branch, dirty, aheadBehind, busy, onRefresh, onFetch, onPull, onPush, onClose }: {
  branch: string | null
  dirty: boolean
  aheadBehind: readonly [number, number] | null
  busy: string
  onRefresh: () => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  onClose: () => void
}) {
  const ahead = aheadBehind?.[0] ?? 0
  const behind = aheadBehind?.[1] ?? 0
  const hasUpstream = aheadBehind !== null
  return (
    <header className={css.header}>
      <span className={css.title} title={branch ?? undefined}>
        <IconBranchOutlineMedium size={13} />
        {branch !== null && <span className={css.branchName}>{branch}</span>}
        {branch !== null && dirty && <span className={css.dirtyDot} title="有未提交改动" />}
        {hasUpstream && (ahead > 0 || behind > 0) && (
          <span className={css.abTag} title={`领先上游 ${ahead} 个提交,落后 ${behind} 个提交`}>
            {ahead > 0 && `↑${ahead}`}
            {behind > 0 && `↓${behind}`}
          </span>
        )}
      </span>
      <span className={css.spacer} />
      <button type="button" className={css.iconButton} title="刷新" aria-label="刷新" onClick={onRefresh}>
        <IconRefreshOutlineMedium size={13} />
      </button>
      <button type="button" className={css.actionBtn} disabled={busy !== ''} title="git fetch --all --prune:同步远程分支列表" onClick={onFetch}>
        {busy === '同步远程' ? '同步中…' : '同步'}
      </button>
      <button type="button" className={css.actionBtn} disabled={busy !== '' || !hasUpstream || behind === 0} title="git pull:拉取当前分支" onClick={onPull}>
        {busy === '拉取' ? '拉取中…' : '拉取'}
      </button>
      <button type="button" className={css.actionBtn} disabled={busy !== '' || !hasUpstream || ahead === 0} title="git push:推送当前分支" onClick={onPush}>
        {busy === '推送' ? '推送中…' : '推送'}
      </button>
      <button type="button" className={css.iconButton} title="关闭 Git 工作台" aria-label="关闭 Git 工作台" onClick={onClose}>
        <IconCloseOutlineMedium size={14} />
      </button>
    </header>
  )
}

/** 变更 Tab props(全部经回调注入,保持组件可测)。 */
interface ChangesTabProps {
  readonly status: NonNullable<ReturnType<typeof classifyGitStatus>>
  readonly selected: SelectedFile | null
  readonly confirmTarget: ConfirmTarget | null
  readonly commitMessage: string
  readonly busy: string
  readonly stagedCount: number
  onSelect: (entry: GitStatusEntry, group: GitChangeGroup) => void
  onStage: (entry: GitStatusEntry) => void
  onStageAll: () => void
  onUnstage: (entry: GitStatusEntry) => void
  onAskConfirm: (target: ConfirmTarget) => void
  onCancelConfirm: () => void
  onConfirm: (target: ConfirmTarget) => void
  onCommit: () => void
  onAiDraft: () => void
  onMessageChange: (message: string) => void
  onMergeAbort: () => void
}

/** 变更 Tab:冲突区 + 三段文件列表(滚动) + 底部固定提交区。 */
function ChangesTab({
  status, selected, confirmTarget, commitMessage, busy, stagedCount,
  onSelect, onStage, onStageAll, onUnstage, onAskConfirm, onCancelConfirm, onConfirm,
  onCommit, onAiDraft, onMessageChange, onMergeAbort,
}: ChangesTabProps) {
  const isEmpty = status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0
  const hasConflicts = status.conflicts.length > 0
  return (
    <>
      <div className={css.tabToolbar}>
        <button
          type="button"
          className={css.actionBtn}
          disabled={busy !== '' || isEmpty}
          title="git add -A:暂存全部改动(含未跟踪)"
          onClick={onStageAll}
        >
          {busy === '暂存全部' ? '暂存中…' : '暂存全部'}
        </button>
      </div>
      <div className={css.changesScroll}>
        {hasConflicts && (
          <div className={css.conflictBanner} role="alert">
            <span className={css.conflictText}>
              {status.conflicts.length} 个文件存在合并冲突,请手动编辑解决后点「标记已解决」
            </span>
            <button
              type="button"
              className={css.dangerBtn}
              disabled={busy !== ''}
              title="git merge --abort:放弃合并,回到合并前状态"
              onClick={onMergeAbort}
            >
              中止合并
            </button>
          </div>
        )}
        {hasConflicts && (
          <FileSection
            title={`冲突文件(${status.conflicts.length})`}
            entries={status.conflicts}
            group="conflicts"
            selected={selected}
            confirmTarget={confirmTarget}
            busy={busy}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onAskConfirm={onAskConfirm}
            onCancelConfirm={onCancelConfirm}
            onConfirm={onConfirm}
          />
        )}
        {isEmpty && !hasConflicts && <div className={css.status}>工作区干净,没有未提交的改动。</div>}
        {status.staged.length > 0 && (
          <FileSection
            title={`已暂存(${status.staged.length})`}
            entries={status.staged}
            group="staged"
            selected={selected}
            confirmTarget={confirmTarget}
            busy={busy}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onAskConfirm={onAskConfirm}
            onCancelConfirm={onCancelConfirm}
            onConfirm={onConfirm}
          />
        )}
        {status.unstaged.length > 0 && (
          <FileSection
            title={`未暂存的变更(${status.unstaged.length})`}
            entries={status.unstaged}
            group="unstaged"
            selected={selected}
            confirmTarget={confirmTarget}
            busy={busy}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onAskConfirm={onAskConfirm}
            onCancelConfirm={onCancelConfirm}
            onConfirm={onConfirm}
          />
        )}
        {status.untracked.length > 0 && (
          <FileSection
            title={`未跟踪(${status.untracked.length})`}
            entries={status.untracked}
            group="untracked"
            selected={selected}
            confirmTarget={confirmTarget}
            busy={busy}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onAskConfirm={onAskConfirm}
            onCancelConfirm={onCancelConfirm}
            onConfirm={onConfirm}
          />
        )}
      </div>
      <div className={css.commitArea}>
        <textarea
          className={css.commitInput}
          rows={3}
          placeholder={stagedCount === 0 ? '先暂存要提交的文件,再填写提交信息…' : '提交信息(提交已暂存的变更)…'}
          value={commitMessage}
          onChange={(ev) => { onMessageChange(ev.target.value) }}
        />
        <div className={css.commitRow}>
          <button
            type="button"
            className={css.actionBtn}
            disabled={busy !== ''}
            title="AI 根据工作区改动生成提交信息草稿"
            onClick={onAiDraft}
          >
            {busy === '生成' ? '生成中…' : '✨ AI'}
          </button>
          <button
            type="button"
            className={css.primaryBtn}
            disabled={busy !== '' || stagedCount === 0 || commitMessage.trim() === ''}
            title={stagedCount === 0 ? '暂存区为空' : 'git commit -m <信息>'}
            onClick={onCommit}
          >
            {busy === '提交' ? '提交中…' : `提交已暂存(${stagedCount})`}
          </button>
        </div>
      </div>
    </>
  )
}

/** 一段文件列表(标题 + 行:名称 + 操作)。 */
function FileSection({
  title, entries, group, selected, confirmTarget, busy,
  onSelect, onStage, onUnstage, onAskConfirm, onCancelConfirm, onConfirm,
}: {
  title: string
  entries: readonly GitStatusEntry[]
  group: GitChangeGroup
  selected: SelectedFile | null
  confirmTarget: ConfirmTarget | null
  busy: string
  onSelect: (entry: GitStatusEntry, group: GitChangeGroup) => void
  onStage: (entry: GitStatusEntry) => void
  onUnstage: (entry: GitStatusEntry) => void
  onAskConfirm: (target: ConfirmTarget) => void
  onCancelConfirm: () => void
  onConfirm: (target: ConfirmTarget) => void
}) {
  return (
    <section className={css.section}>
      <div className={css.sectionHead}>{title}</div>
      <div className={css.fileList}>        {entries.map((entry) => {
          // 本行是否处于两步确认态(非空即本行目标,类型同步收窄)。
          const ct = confirmTarget !== null && confirmTarget.path === entry.path ? confirmTarget : null
          return (
            <div key={entry.path} className={css.fileRow}>
              <button
                type="button"
                className={clsx(css.fileBtn, selected?.path === entry.path && css.fileBtnActive)}
                title={`${entry.path}${entry.origPath === undefined ? '' : ` (自 ${entry.origPath} 重命名)`}\n点击查看 diff`}
                onClick={() => { onSelect(entry, group) }}
              >
                <span className={css.filePath}>{entry.path}</span>
                {entry.origPath !== undefined && <span className={css.renameTag}>R</span>}
              </button>
              {ct !== null ? (
                <span className={css.rowConfirm}>
                  确认{ct.action === 'clean' ? '删除' : '放弃'}?
                  <button type="button" className={css.dangerBtn} disabled={busy !== ''} onClick={() => { onConfirm(ct) }}>
                    确认
                  </button>
                  <button type="button" className={css.actionBtn} onClick={onCancelConfirm}>取消</button>
                </span>
              ) : (
                <span className={css.rowActions}>
                  {group === 'conflicts' && (
                    <button
                      type="button"
                      className={css.rowBtn}
                      disabled={busy !== ''}
                      title="git add -- <文件>:标记冲突已解决"
                      onClick={() => { onStage(entry) }}
                    >
                      标记已解决
                    </button>
                  )}
                  {group !== 'staged' && group !== 'conflicts' && (
                    <button type="button" className={css.rowBtn} disabled={busy !== ''} title="git add -- <文件>" onClick={() => { onStage(entry) }}>
                      暂存
                    </button>
                  )}
                  {group === 'staged' && (
                    <button type="button" className={css.rowBtn} disabled={busy !== ''} title="git restore --staged -- <文件>" onClick={() => { onUnstage(entry) }}>
                      取消暂存
                    </button>
                  )}
                  {group === 'unstaged' && (
                    <button
                      type="button"
                      className={css.rowBtnDanger}
                      disabled={busy !== ''}
                      title="git restore -- <文件>:丢弃工作树改动,不可恢复"
                      onClick={() => { onAskConfirm({ path: entry.path, action: 'discard' }) }}
                    >
                      放弃
                    </button>
                  )}
                  {group === 'untracked' && (
                    <button
                      type="button"
                      className={css.rowBtnDanger}
                      disabled={busy !== ''}
                      title="git clean -f -- <文件>:删除未跟踪文件,不可恢复"
                      onClick={() => { onAskConfirm({ path: entry.path, action: 'clean' }) }}
                    >
                      删除
                    </button>
                  )}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {/* diff 视图紧随本段渲染:选中项属于哪段就出现在哪段下面,不与触发源分离 */}
      {selected !== null && selected.group === group && <DiffView selected={selected} />}
    </section>
  )
}

/** 单文件 diff 视图:未跟踪占位 / 加载态 / 失败态 / 着色 diff。 */
function DiffView({ selected }: { selected: SelectedFile }) {
  return (
    <div className={css.diffSection}>
      <div className={css.sectionHead}>
        {selected.path}
        <span className={css.diffGroup}>
          {selected.group === 'staged' ? '已暂存 diff' : selected.group === 'unstaged' ? '未暂存 diff' : selected.group === 'conflicts' ? '冲突 diff' : '未跟踪'}
        </span>
      </div>
      {selected.group === 'untracked' && (
        <div className={css.diffPlaceholder}>新文件(未跟踪):暂存后可查看与 HEAD 的 diff。</div>
      )}
      {selected.group !== 'untracked' && selected.loading && <div className={css.diffPlaceholder}>加载 diff…</div>}
      {selected.group !== 'untracked' && !selected.loading && selected.text === null && (
        <div className={css.diffPlaceholder}>diff 读取失败。</div>
      )}
      {selected.group !== 'untracked' && !selected.loading && selected.text !== null && (
        selected.text === ''
          ? <div className={css.diffPlaceholder}>无差异。</div>
          : <DiffPre text={selected.text} />
      )}
    </div>
  )
}

/** 着色 diff 块:按 unified diff 行类别渲染 span。 */
function DiffPre({ text }: { text: string }) {
  return (
    <pre className={css.diffPre}>{capDiff(text).split('\n').map((line, index) => {
      const kind = diffLineKind(line)
      return (
        <span
          key={index}
          className={clsx(
            kind === 'add' && css.diffAdd,
            kind === 'del' && css.diffDel,
            kind === 'hunk' && css.diffHunk,
            kind === 'meta' && css.diffMeta,
            kind === 'context' && css.diffCtx,
          )}
        >
          {line}
        </span>
      )
    })}</pre>
  )
}

/** 历史 Tab props。 */
interface HistoryTabProps {
  readonly log: readonly GitLogEntry[] | null
  readonly expanded: ExpandedCommit | null
  onToggle: (entry: GitLogEntry) => void
}

/** 历史 Tab:提交列表 + 点击展开 git show 补丁。 */
function HistoryTab({ log, expanded, onToggle }: HistoryTabProps) {
  if (log === null) return <div className={css.status}>暂无提交(空仓库或读取失败)。</div>
  if (log.length === 0) return <div className={css.status}>暂无提交。</div>
  return (
    <div className={css.logList}>
      {log.map(entry => (
        <div key={entry.hash} className={css.logItem}>
          <button
            type="button"
            className={css.logRow}
            title={`${entry.hash}\n点击${expanded !== null && expanded.hash === entry.hash ? '收起' : '查看补丁'}`}
            onClick={() => { onToggle(entry) }}
          >
            <span className={css.logRefs}>
              {entry.refs !== '' && entry.refs.split(', ').map(ref => (
                <span key={ref} className={css.refTag}>{ref}</span>
              ))}
            </span>
            <span className={css.logSubject}>{entry.subject}</span>
            <span className={css.logMeta}>{entry.short} · {entry.author} · {entry.date.slice(0, 10)}</span>
          </button>
          {expanded !== null && expanded.hash === entry.hash && (
            expanded.loading || expanded.text === null
              ? <div className={css.diffPlaceholder}>{expanded.loading ? '加载补丁…' : '补丁读取失败。'}</div>
              : <DiffPre text={expanded.text} />
          )}
        </div>
      ))}
    </div>
  )
}

/** 分支 Tab props。 */
interface BranchesTabProps {
  readonly branch: string | null
  readonly visibleLocal: readonly string[]
  readonly visibleRemote: readonly string[]
  readonly filter: string
  readonly busy: string
  onFilterChange: (filter: string) => void
  onCheckout: (name: string) => void
  onCheckoutRemote: (remoteRef: string) => void
}

/** 分支 Tab:搜索 + 本地/远程切换(自原分支胶囊弹层迁入)。 */
function BranchesTab({
  branch, visibleLocal, visibleRemote, filter, busy, onFilterChange, onCheckout, onCheckoutRemote,
}: BranchesTabProps) {
  return (
    <>
      <input
        className={css.search}
        placeholder="搜索分支…"
        value={filter}
        onChange={(ev) => { onFilterChange(ev.target.value) }}
      />
      <div className={css.branchList} role="listbox" aria-label="分支列表">
        {visibleLocal.map(name => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={name === branch}
            className={clsx(css.branchRow, name === branch && css.branchRowActive)}
            disabled={busy !== ''}
            onClick={() => { onCheckout(name) }}
          >
            <IconBranchOutlineMedium size={12} />
            <span className={css.branchRowName}>{name}</span>
            {name === branch && <span className={css.currentTag}>当前</span>}
          </button>
        ))}
        {visibleRemote.length > 0 && <div className={css.groupLabel}>远程(点击拉取到本地)</div>}
        {visibleRemote.map(ref => (
          <button
            key={ref}
            type="button"
            role="option"
            aria-selected={false}
            className={clsx(css.branchRow, css.branchRowRemote)}
            disabled={busy !== ''}
            title={`拉取 ${ref} 为本地跟踪分支`}
            onClick={() => { onCheckoutRemote(ref) }}
          >
            <IconBranchOutlineMedium size={12} />
            <span className={css.branchRowName}>{ref}</span>
          </button>
        ))}
        {visibleLocal.length === 0 && visibleRemote.length === 0 && (
          <div className={css.empty}>无匹配分支</div>
        )}
      </div>
    </>
  )
}
