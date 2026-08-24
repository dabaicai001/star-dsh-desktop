/**
 * 会话文件树的状态桥(2026-08-24):头部「文件树」按钮(conversation.
 * session.header.actions)与右侧详情列的文件树面板(details.workspace 内的
 * StarHubToolWorkspace 视图切换)跨 scope 共享——同一裸 source 桥范式
 * (one-handle-one-scope,同 connectionManager / aiChat / fileViewer)。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** 文件树桥状态:当前会话右侧列是否切到「文件树」视图。 */
export interface FileTreeState {
  readonly open: boolean
}

/** 文件树桥:apply 持有的裸 observable + open/close 回调。 */
export interface FileTreeBridge {
  /** 注入 hooks 舱位的裸 observable。 */
  readonly source: SnapshotStore<FileTreeState>
  /** 切到文件树视图。 */
  readonly open: () => void
  /** 切回资产列表视图。 */
  readonly close: () => void
}

/**
 * Create the apply-owned file-tree bridge.
 * @returns the bridge (bare source + open/close callbacks).
 */
export function createFileTreeBridge(): FileTreeBridge {
  const source = createSnapshotStore<FileTreeState>({ open: false })
  return {
    source,
    open: () => { source.set({ open: true }) },
    close: () => { source.set({ open: false }) },
  }
}
