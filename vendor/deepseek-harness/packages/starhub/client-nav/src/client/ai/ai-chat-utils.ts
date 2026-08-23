/**
 * Pure helpers for the in-shell AI chat panel: classify a flat conversation
 * node into a render role + display fields, and extract readable text from
 * content/assistant blocks. Everything here is a pure function so the panel's
 * own branches stay thin and the whole module hits per-file 100% coverage
 * through plain unit tests.
 *
 * @module StarHub AI chat utils (client)
 */
import type {
  AssistantBlock, ConversationNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** The visual role a conversation node is drawn with. */
export type NodeRole = 'user' | 'assistant' | 'context' | 'tool' | 'command' | 'notice' | 'error'

/** Normalized render data for one conversation node. */
export interface NodeRenderData {
  /** Stable React key (event seq). */
  key: string
  /** Visual role. */
  role: NodeRole
  /** Leading label (tool/command name, role tag) — keep short. */
  label: string
  /** Primary readable text; empty when the node has none (e.g. image-only). */
  text: string
  /** Optional structured payload (tool args/result) rendered as JSON. */
  json?: string
  /** Whether the node is an error state. */
  error: boolean
}

/** A minimal textual content block (ContentBlock uses `type`; AssistantBlock uses `kind`). */
interface TextyBlock { type?: unknown; kind?: unknown; text?: unknown }

/** Whether a block is a text/reasoning body the chat shows as prose. */
function isTextBlock(b: TextyBlock): b is TextyBlock & { text: string } {
  const tag = b.type === 'text' || b.type === 'reasoning' || b.kind === 'text' || b.kind === 'reasoning'
  return tag && typeof b.text === 'string' && b.text !== ''
}

/**
 * Join the readable text portions of content/assistant blocks, ignoring
 * non-text kinds such as tool-call fences and images.
 * @param blocks - content or assistant blocks.
 * @returns the concatenated text, or '' when none.
 */
export function blocksToText(blocks: readonly TextyBlock[] | undefined): string {
  if (blocks === undefined) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (isTextBlock(b)) parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * Extract the readable text from an assistant message's UI-classified blocks.
 * @param blocks - assistant blocks.
 * @returns concatenated text, or '' when none.
 */
export function assistantBlocksText(blocks: readonly AssistantBlock[]): string {
  return blocksToText(blocks)
}

/** One stable render key from a node's seq. */
function seqKey(seq: number): string {
  return String(seq)
}

/**
 * Classify one flat conversation node into render role + display fields.
 * Every member of the `kind` union has an arm (covering the full surface).
 * @param node - a conversation node.
 * @returns normalized render data.
 */
export function nodeRenderData(node: ConversationNode): NodeRenderData {
  switch (node.kind) {
    case 'user':
      return { key: seqKey(node.seq), role: 'user', label: '你', text: blocksToText(node.content), error: false }
    case 'steering':
      return { key: seqKey(node.seq), role: 'user', label: '你 (插话)', text: blocksToText(node.content), error: false }
    case 'assistant': {
      const text = assistantBlocksText(node.blocks)
      return {
        key: seqKey(node.seq),
        role: node.interrupted === true ? 'notice' : 'assistant',
        label: node.interrupted === true ? '已停止' : '助手',
        text,
        error: false,
      }
    }
    case 'context':
      return { key: seqKey(node.seq), role: 'context', label: '上下文', text: blocksToText(node.content), error: false }
    case 'tool-result': {
      const payload = node.content.length === 0 ? undefined : JSON.stringify(node.content)
      return {
        key: seqKey(node.seq),
        role: 'tool',
        label: node.call?.name ?? node.callId,
        text: blocksToText(node.content),
        ...(payload !== undefined ? { json: payload } : {}),
        error:  node.isError,
      }
    }
    case 'command':
      return {
        key: seqKey(node.seq),
        role: 'command',
        label: node.name ?? '命令',
        text: node.outcome?.text ?? (node.outcome === null ? '执行中…' : ''),
        error: node.outcome?.kind === 'error',
      }
    case 'turn-error':
      return { key: seqKey(node.seq), role: 'error', label: '错误', text: node.message, error: true }
    case 'turn-max-tokens':
      return { key: seqKey(node.seq), role: 'notice', label: '已达输出上限', text: '', error: false }
    case 'model-retry':
      return { key: seqKey(node.seq), role: 'notice', label: '重试', text: '', error: false }
    case 'compaction':
      return {
        key: seqKey(node.seq),
        role: 'notice',
        label: '已压缩上文',
        text: node.summary ?? '(无摘要)',
        error: false,
      }
    case 'unknown':
      return { key: seqKey(node.seq), role: 'notice', label: node.type, text: '', error: false }
  }
}

/** Open-state copy for the panel header/gate (loading/open/error/cold). */
export interface OpenStateView {
  /** True while the window is being backfilled. */
  loading: boolean
  /** True when the window failed to open. */
  error: boolean
  /** Human error text (openError), or '' when none. */
  errorText: string
}

/**
 * Project the snapshot's openState into the panel's gating flags.
 * @param openState - window open state; undefined = cold/unopened.
 * @param openError - optional open error.
 * @returns the gating view.
 */
export function openStateView(
  openState: string | undefined,
  openError: { message: string } | null | undefined,
): OpenStateView {
  if (openState === 'error') {
    return { loading: false, error: true, errorText: openError?.message ?? '会话历史打开失败' }
  }
  return { loading: openState === 'loading', error: false, errorText: '' }
}

/** Prompt failure copy for the composer error strip. */
export interface PromptErrorView {
  /** 'send' | 'stop' | '' */
  op: string
  /** Human text. */
  text: string
}

/**
 * Normalize the snapshot's prompt error into composer copy.
 * @param err - promptError from the snapshot (may be null).
 * @returns op + text, or an empty view when null.
 */
export function promptErrorView(err: { op?: unknown; error: { message?: unknown } } | null | undefined): PromptErrorView {
  if (err === null || err === undefined) return { op: '', text: '' }
  const op = err.op === 'send' || err.op === 'stop' ? err.op : 'send'
  const message = typeof err.error.message === 'string' ? err.error.message : ''
  return { op, text: op === 'send' ? `发送失败: ${message}` : `停止失败: ${message}` }
}
