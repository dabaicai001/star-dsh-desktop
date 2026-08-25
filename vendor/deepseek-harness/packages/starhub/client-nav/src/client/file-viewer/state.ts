/**
 * 壳内文件查看窗的状态桥(2026-08-21):ui-conversation 的 viewFile 回调经
 * `starhubFileViewer` 服务(ctx.provide)写入这里,shell.overlay 席位的
 * FileViewerOverlay 组件经 hooks 舱位读取——同一裸 source 桥范式
 * (one-handle-one-scope,同 connectionManager / aiChat)。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** 一次 before/after 变更 hunk(edit 查看请求用)。 */
export interface FileViewDiff {
  /** 变更前文本(null oldText 的纯新增由调用方归一化掉)。 */
  readonly oldText: string
  /** 变更后文本。 */
  readonly newText: string
}

/** 壳内文件查看请求:`read` 看当前内容,`edit` 看前后 hunk 对比。 */
export type FileViewRequest =
  | { readonly kind: 'read'; readonly path: string }
  | { readonly kind: 'edit'; readonly path: string; readonly diffs: readonly FileViewDiff[] }

/** 查看窗打开目标:查看请求 + 来源会话 id(据此门禁「AI 运行中只能查看」)。 */
export type FileViewTarget = FileViewRequest & { readonly sessionId: string }

/** 查看窗状态:null = 关闭。 */
export interface FileViewerState {
  readonly target: FileViewTarget | null
}

/** 查看窗桥:apply 持有的裸 observable + open/close 回调。 */
export interface FileViewerBridge {
  /** 注入 hooks 舱位的裸 observable。 */
  readonly source: SnapshotStore<FileViewerState>
  /** 打开查看窗(再次打开替换目标)。 */
  readonly open: (target: FileViewTarget) => void
  /** 关闭查看窗。 */
  readonly close: () => void
}

/**
 * Create the apply-owned file-viewer bridge.
 * @returns the bridge (bare source + open/close callbacks).
 */
export function createFileViewerBridge(): FileViewerBridge {
  const source = createSnapshotStore<FileViewerState>({ target: null })
  return {
    source,
    open: (target) => { source.set({ target }) },
    close: () => { source.set({ target: null }) },
  }
}
