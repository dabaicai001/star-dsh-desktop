import type { Context } from '@deepseek-ai/cordis'
import { IconEditOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { diffCardModel } from '../models/diff-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type FileMutationRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/**
 * Lets users expand an applied file diff and open the reported path.
 */
export function FileMutationRow({ toolName, block, cwd, home, openFile, inspect, t }: FileMutationRowProps) {
  const model = toolRowModel(toolName, block, cwd, home)
  const diff = diffCardModel(block)
  // 变更行的文件名链接:把应用后 hunks 经 options.diffs 随 openFile 一并传上,
  // 宿主据此打开壳内「变更前 / 变更后」双栏对比(edit 模式);无 diff(如报错)
  // 退回默认打开路径(read)语义。
  const openMutation = (path: string) => {
    const diffs = diff?.card.diffs
    openFile(path, diffs === undefined ? undefined : { diffs })
  }
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconEditOutline16 size={14} />}
      title={t(model.titleKey)}
      summary={model.summary}
      output={model.output}
      errorSummary={model.errorSummary}
      diff={diff}
      state={model.state}
      filePath={model.filePath}
      onOpenFile={openMutation}
      inspect={inspect}
    />
  )
}

/** Registers the edit and write conversation rows. */
export const fileMutationToolview = {
  name: 'file-mutation-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', locale: NS }, FileMutationRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', locale: NS }, FileMutationRow)
    })
  },
}
