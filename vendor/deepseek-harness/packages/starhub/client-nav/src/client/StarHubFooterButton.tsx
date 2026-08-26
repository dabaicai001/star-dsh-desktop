/**
 * StarHub 侧栏底部工具入口(rc.2 适配,2026-08-26):rc.2 移除了可多人占位的
 * `sidebar.navigation` 槽,StarHub 工具导航迁到 `sidebar.footer.action`
 * (侧栏底部、设置齿轮上方的 action 列表)。本组件是一个极简工具图标按钮,
 * 点击打开 shell.overlay 里的 StarHub 工具面板(资产列表 / 文件树)。
 *
 * 底部 action 空间有限,不在此展开「工具/终端/数据库/Docker」树——那是
 * 工具面板(StarHubToolWorkspace overlay)的职责;这里只提供入口。
 */
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import css from './StarHubFooterButton.module.css'

/** Business face injected by the registration: open the tool workspace panel. */
export interface StarHubFooterInjected {
  /** 打开侧栏工具面板(shell.overlay 承载的 StarHubToolWorkspace)。 */
  openTools: () => void
}

/** Full composed props: footer-action owner share ({ wide }) + injected face. */
export type StarHubFooterButtonProps =
  & PropsRuntime<'sidebar.footer.action'>
  & InjectFace<StarHubFooterInjected>

/**
 * Render the StarHub tools footer button.
 * @param props - wide flag (owner share) + the open-tools callback.
 * @returns the button.
 */
export function StarHubFooterButton({ wide, openTools }: StarHubFooterButtonProps) {
  return (
    <Tooltip label="StarHub 工具" delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.button, !wide && css.rail)}
        aria-label="StarHub 工具"
        title="StarHub 工具"
        onClick={openTools}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide ? <span className={css.label}>工具</span> : null}
      </button>
    </Tooltip>
  )
}