/** The sidebar's StarHub tools entry icon; the sidebar owns the button, label, and selected state around it. */

import type { ReactNode } from 'react'
import { IconDataOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.panellist' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the tools glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function ToolsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconDataOutlineMedium size={size} />
}
