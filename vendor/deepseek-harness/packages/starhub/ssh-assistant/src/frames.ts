/**
 * Assistant SSE frame vocabulary (StarHub-local, host → panel).
 *
 * The panel is a plain React app inside the workbench window: it has no dsh
 * client runtime, so the assistant stream rides the bridge's same-origin SSE
 * pattern (`event:` = one frame kind, `data:` = one single-line JSON object).
 * Every frame carries a `t` discriminator; the panel folds them into its
 * message list. Session events are forwarded verbatim — the durable log is the
 * single source of truth, exactly like the dsh GUI's event-sourced rendering.
 *
 * @module @deepseek-ai/dsh-starhub-ssh-assistant/frames
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One approval decision the panel can submit. */
export type AssistantApprovalOutcome = 'allowed-once' | 'rejected'

/** One server → panel frame on the assistant SSE stream. */
export type AssistantFrame =
  | { readonly t: 'status'; readonly status: 'idle' | 'running' }
  | { readonly t: 'event'; readonly event: SessionEvent }
  | {
    readonly t: 'approval'
    readonly requestId: string
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
  }
  | { readonly t: 'model'; readonly provider: string; readonly model: string }
  | { readonly t: 'closed' }
  | { readonly t: 'error'; readonly message: string }

/** SSE `event:` field shared by every assistant frame. */
export const ASSISTANT_FRAME_EVENT = 'starhub-assistant'

/**
 * Encode one frame as an SSE event block.
 * @param frame - the frame to serialize.
 * @returns the `event:` + single-line `data:` block, newline-terminated.
 */
export function encodeAssistantFrame(frame: AssistantFrame): string {
  return `event: ${ASSISTANT_FRAME_EVENT}\ndata: ${JSON.stringify(frame)}\n\n`
}

/**
 * Decode one SSE `data:` payload back into a frame.
 * @param raw - the JSON text of one `data:` line.
 * @returns the parsed frame, or null when the payload is not a known frame.
 */
export function decodeAssistantFrame(raw: string): AssistantFrame | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  switch (record.t) {
    case 'status':
      return record.status === 'idle' || record.status === 'running'
        ? { t: 'status', status: record.status }
        : null
    case 'event':
      return typeof record.event === 'object' && record.event !== null
        ? { t: 'event', event: record.event as SessionEvent }
        : null
    case 'approval':
      return typeof record.requestId === 'string' && typeof record.toolName === 'string'
        ? {
          t: 'approval',
          requestId: record.requestId,
          toolName: record.toolName,
          ...(typeof record.callId === 'string' ? { callId: record.callId } : {}),
          ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
        }
        : null
    case 'model':
      return typeof record.provider === 'string' && typeof record.model === 'string'
        ? { t: 'model', provider: record.provider, model: record.model }
        : null
    case 'closed':
      return { t: 'closed' }
    case 'error':
      return typeof record.message === 'string' ? { t: 'error', message: record.message } : null
    default:
      return null
  }
}
