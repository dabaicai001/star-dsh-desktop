/**
 * 会话头部「git 分支胶囊」(2026-08-21;v0.118.0 起融合为 Git 工作台入口):
 * 显示当前会话工作区(会话 cwd)的 git 分支与未提交脏点;点击把右侧工具抽屉
 * 切到「Git 工作台」视图(GitWorkbenchPanel——分支搜索/切换、暂存、提交、
 * 历史、同步远程等能力全部收进工作台,原胶囊弹层已移除)。
 *
 * 数据源:会话 cwd 经框架 `useSessions` 读取;分支与脏标记经 Tauri
 * `local_shell_exec`(git-service.ts)在挂载/每 10s 轮询/页面重新可见时刷新。
 * 非 git 仓库、无 cwd(blank 会话)或浏览器预览(无 Tauri IPC)时不渲染。
 */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconBranchOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the header-actions SlotMap row (declared by ui-conversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './GitBranchPill.module.css'
import { gitCurrentBranch, gitIsDirty } from './git-service.ts'
import type { GitWorkbenchState } from './git-workbench-state.ts'

/** 注入面:打开 Git 工作台视图的桥回调 + 视图开关源。 */
export interface GitBranchPillInjected {
  /** 打开 Git 工作台视图(组合:gitWorkbench.open + 打开工具抽屉)。 */
  openWorkbench: () => void
  hooks: {
    /** Git 工作台视图开关(裸 source,渲染器绑定为 useGitWorkbench)。 */
    gitWorkbench: SnapshotStore<GitWorkbenchState>
  }
}

/** Full composed props: header-actions runtime share + injected face. */
export type GitBranchPillProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<GitBranchPillInjected>

/** 外部 git 操作(如另一终端切换分支)的轮询间隔。 */
const BRANCH_POLL_MS = 10_000

/**
 * 渲染分支胶囊(Git 工作台入口)。
 * @param props - 框架份额(sessionId / useSessions)+ 注入面(openWorkbench / useGitWorkbench)。
 * @returns 胶囊;非 git 工作区不渲染。
 */
export function GitBranchPill({ sessionId, useSessions, useGitWorkbench, openWorkbench }: GitBranchPillProps) {
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const workbenchOpen = useGitWorkbench(s => s.open)
  const [branch, setBranch] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  // 挂载/轮询共用探测:分支+脏标记一次取齐;null(非仓库/瞬态失败)不落
  // 状态,避免胶囊闪隐(挂载首次探测允许落 null,以隐藏非 git 工作区的胶囊)。
  const probe = useCallback(async (dir: string, keepOnNull: boolean) => {
    const [name, dirtyNow] = await Promise.all([gitCurrentBranch(dir), gitIsDirty(dir)])
    if (name === null && keepOnNull) return
    setBranch(name)
    setDirty(dirtyNow)
  }, [])

  // 挂载与 cwd 变化时探测一次(非仓库/预览 → 隐藏胶囊)。
  useEffect(() => {
    if (cwd === undefined) { setBranch(null); return }
    let cancelled = false
    void Promise.all([gitCurrentBranch(cwd), gitIsDirty(cwd)]).then(([name, dirtyNow]) => {
      if (cancelled) return
      setBranch(name)
      setDirty(dirtyNow)
    })
    return () => { cancelled = true }
  }, [cwd])

  // 外部 git 操作(在其它终端/编辑器切了分支)后胶囊保持自动最新:挂载期
  // 每 10s 轮询一次分支与脏标记;页面重新可见时立即刷新。
  useEffect(() => {
    if (cwd === undefined) return
    const timer = window.setInterval(() => { void probe(cwd, true) }, BRANCH_POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void probe(cwd, true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [cwd, probe])

  if (branch === null || cwd === undefined) return null
  return (
    <div className={css.root}>
      <button
        type="button"
        className={clsx(css.pill, workbenchOpen && css.pillOpen)}
        title={`工作区分支:${branch}\n${cwd}\n点击打开 Git 工作台`}
        aria-haspopup="dialog"
        aria-expanded={workbenchOpen}
        onClick={openWorkbench}
      >
        <IconBranchOutlineMedium size={13} />
        <span className={css.branchName}>{branch}</span>
        {dirty && <span className={css.dirtyDot} title="有未提交改动" />}
      </button>
    </div>
  )
}
