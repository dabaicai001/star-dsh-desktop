/**
 * 会话头部「执行」按钮(v0.100.0,重构自右下角 BastionExecPanel 浮层):
 * 「文件」胶囊旁边新增的第三个胶囊——点击打开工具抽屉并切到「SSH 执行记录」
 * 视图(StarHubToolWorkspace 读到 execRecords 桥后渲染 ExecRecordList),
 * 再次点击返回资产列表;有记录时展示条数角标。
 *
 * 与 FileTreeButton 不同:执行记录是全局的(AI 静默执行的 SSH 命令),不依赖
 * 会话 cwd,故无 cwd 不渲染的门槛。
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconPlayOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the header-actions SlotMap row (declared by ui-conversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import clsx from 'clsx'
import css from './ExecDrawerButton.module.css'
import type { ExecRecordsState } from './exec-records.ts'

/** 注入面:切到/退出执行记录视图的桥回调 + 记录源。 */
export interface ExecDrawerButtonInjected {
  /** 打开执行记录视图(组合:execRecords.openView + 关文件树视图 + 开工具抽屉)。 */
  openExecView: () => void
  /** 返回资产列表。 */
  closeExecView: () => void
  hooks: {
    /** 执行记录桥(裸 source,渲染器绑定为 useExecRecords)。 */
    execRecords: SnapshotStore<ExecRecordsState>
  }
}

/** Full composed props: header-actions runtime share + injected face. */
export type ExecDrawerButtonProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<ExecDrawerButtonInjected>

/**
 * Render the exec-records toggle pill next to the file-tree pill.
 * @param props - framework session kit + injected face.
 * @returns the pill with the record-count badge.
 */
export function ExecDrawerButton({
  useExecRecords, openExecView, closeExecView,
}: ExecDrawerButtonProps) {
  const viewOpen = useExecRecords(s => s.viewOpen)
  const count = useExecRecords(s => s.records.length)
  return (
    <button
      type="button"
      className={clsx(css.pill, viewOpen && css.pillOpen)}
      title={viewOpen ? '返回资产列表' : '查看 SSH 命令执行记录'}
      aria-expanded={viewOpen}
      onClick={() => { if (viewOpen) closeExecView(); else openExecView() }}
    >
      <IconPlayOutline16 size={12} />
      <span className={css.label}>执行</span>
      {count > 0 && <span className={css.count}>{count}</span>}
    </button>
  )
}
