/**
 * 侧栏「StarHub 工具」入口图标。
 *
 * 用 StarHub 品牌标记(四角星 + 中心节点 = star + hub)而不是 dsh 通用图标库
 * 里的数据库字形:侧栏里一眼能认出是 StarHub 的入口,与插件页的品牌图标同源
 * (`icon.svg` 的四角星 + 中心点)。线条规格与 dsh 图标一致:16×16 viewBox、
 * `fill="none"`、`currentColor` 描边,尺寸与选中态由侧栏下发。
 */

import type { ReactNode } from 'react'
import { ICON_MEDIUM_STROKE } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.panellist' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the StarHub tools glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected
 *   (描边走 `currentColor`,选中态的颜色由侧栏自身的 CSS 决定,这里不接样式)。
 * @returns the icon element.
 */
export function ToolsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={ICON_MEDIUM_STROKE}
    >
      {/* 四角星:凹陷的四个边把「星」的轮廓拉成星芒,中心留白给节点 */}
      <path
        d="M8 1.4C8.5 5.2 10.8 7.5 14.6 8 10.8 8.5 8.5 10.8 8 14.6 7.5 10.8 5.2 8.5 1.4 8 5.2 7.5 7.5 5.2 8 1.4Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      {/* 中心节点(hub):品牌图标里那个深色圆心 */}
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  )
}
