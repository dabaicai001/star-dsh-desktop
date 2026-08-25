/**
 * 会话头部「文件树」按钮(2026-08-24):分支胶囊(GitBranchPill)旁边新增的
 * 第二个胶囊——点击打开工具抽屉并切到「文件树」视图(StarHubToolWorkspace
 * 读到 fileTree bridge 后渲染目录树),再次点击切回资产列表。
 *
 * 数据源:会话 cwd 经框架 `useSessions` 读取;无 cwd(blank 会话/浏览器预览
 * 无工作区)时不渲染,与 GitBranchPill 同条件。
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the header-actions SlotMap row (declared by ui-conversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import clsx from 'clsx'
import css from './FileTreeButton.module.css'
import type { FileTreeState } from './state.ts'

/** 注入面:切到/退出文件树视图的桥回调 + 文件树开关源。 */
export interface FileTreeButtonInjected {
  /** 打开文件树视图(组合:fileTree.open + 打开工具抽屉)。 */
  openFileTree: () => void
  /** 关闭文件树视图(切回资产列表)。 */
  closeFileTree: () => void
  hooks: {
    /** 文件树视图开关(裸 source,渲染器绑定为 useFileTree)。 */
    fileTree: SnapshotStore<FileTreeState>
  }
}

/** Full composed props: header-actions runtime share + injected face. */
export type FileTreeButtonProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<FileTreeButtonInjected>

/**
 * Render the file-tree toggle pill next to the git branch pill.
 * @param props - framework session kit (sessionId/useSessions) + injected face.
 * @returns the pill; hidden without a session cwd.
 */
export function FileTreeButton({
  sessionId, useSessions, useFileTree, openFileTree, closeFileTree,
}: FileTreeButtonProps) {
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const open = useFileTree(s => s.open)
  if (cwd === undefined) return null
  return (
    <button
      type="button"
      className={clsx(css.pill, open && css.pillOpen)}
      title={open ? `文件树(${cwd})\n点击返回资产列表` : `展开项目文件树\n${cwd}`}
      aria-expanded={open}
      onClick={() => { if (open) closeFileTree(); else openFileTree() }}
    >
      <IconFolderOpenOutline16 size={13} />
      <span className={css.label}>{open ? '文件树' : '文件'}</span>
    </button>
  )
}
