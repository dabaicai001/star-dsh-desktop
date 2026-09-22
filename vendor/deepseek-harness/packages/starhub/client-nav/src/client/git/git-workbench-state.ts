/**
 * Git 工作台的状态桥(2026-09-10):会话头部分支胶囊(GitBranchPill,入口)
 * 与工具抽屉(StarHubToolWorkspace 内的视图切换)跨 scope 共享——同一裸
 * source 桥范式(one-handle-one-scope,同 execRecords)。
 * open 携带落地 Tab:胶囊点击以分支管理为首要意图,落到「分支」Tab。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Git 工作台 Tab(变更 / 历史 / 分支)。 */
export type GitWorkbenchTab = 'changes' | 'history' | 'branches'

/** Git 工作台桥状态:当前会话右侧抽屉是否切到「Git 工作台」视图及落地 Tab。 */
export interface GitWorkbenchState {
  readonly open: boolean
  /** open 时面板应落到的 Tab(关闭时复位为 changes)。 */
  readonly initialTab: GitWorkbenchTab
}

/** Git 工作台桥:apply 持有的裸 observable + open/close 回调。 */
export interface GitWorkbenchBridge {
  /** 注入 hooks 舱位的裸 observable。 */
  readonly source: SnapshotStore<GitWorkbenchState>
  /** 切到 Git 工作台视图并落到指定 Tab。 */
  readonly open: (tab: GitWorkbenchTab) => void
  /** 切回资产列表视图。 */
  readonly close: () => void
}

/**
 * Create the apply-owned git-workbench bridge.
 * @returns the bridge (bare source + open/close callbacks).
 */
export function createGitWorkbenchBridge(): GitWorkbenchBridge {
  const source = createSnapshotStore<GitWorkbenchState>({ open: false, initialTab: 'changes' })
  return {
    source,
    open: (tab) => { source.set({ open: true, initialTab: tab }) },
    close: () => { source.set({ open: false, initialTab: 'changes' }) },
  }
}
