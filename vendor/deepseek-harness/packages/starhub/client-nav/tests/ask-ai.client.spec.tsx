// @vitest-environment jsdom
/**
 * `starhub://ask-ai` 监听(host-events.ts 的 ask-ai 半):优先聚焦已有会话并
 * prefill composer;无会话时经 connectWorkspace 新建/复用工作区空白会话
 * (先写 draft 再 open);无任何工作区则清空选择;资产引用轻绑定工具上下文;
 * conversation 服务缺失时退化为仅聚焦。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import { createToolSelectionBridge } from '../src/client/store.ts'
import { createAskAiHandler } from '../src/client/host-events.ts'
import { TOOL_CONTEXT_NAMESPACE } from '../src/client/tool-context.ts'

interface HarnessOverrides {
  current?: string
  recentWorkspaceId?: string
  connect?: () => Promise<string>
  /** true = 会话不可寻址(binding 返回 undefined,prefill 跳过)。 */
  unresolvable?: boolean
  /** true = ui-conversation 未装载(conversation 服务缺失)。 */
  noConversation?: boolean
}

function harness(overrides: HarnessOverrides = {}) {
  const open = vi.fn()
  const clear = vi.fn()
  const setDraft = vi.fn()
  const inputFor = vi.fn(() => ({ setDraft }))
  const binding = vi.fn(() => (overrides.unresolvable === true ? undefined : { sessionId: 's1', session: {}, ctx: {} }))
  const sessions = {
    list: { getSnapshot: () => ({ current: overrides.current, ids: [], byId: {} }) },
    open,
    clear,
    binding,
  } as unknown as ISessions
  const connectWorkspace = overrides.connect ?? vi.fn(() => Promise.resolve('new1'))
  const workspaces = {
    list: { getSnapshot: () => ({ recentWorkspaceId: overrides.recentWorkspaceId }) },
    connectWorkspace,
  } as unknown as IWorkspaces
  const conversation = overrides.noConversation === true
    ? undefined
    : { input: { for: inputFor } } as unknown as IConversation
  const update = vi.fn(() => Promise.resolve({ result: { ok: true } }))
  const api = { settings: { update } } as unknown as IApiClient
  const selection = createToolSelectionBridge()
  const handler = createAskAiHandler({ api, selection, sessions, workspaces, conversation })
  return { handler, open, clear, setDraft, inputFor, connectWorkspace, binding, update, selection }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAskAiHandler', () => {
  it('prefills and refocuses the current session when one exists', () => {
    const { handler, open, clear, setDraft, connectWorkspace } = harness({ current: 's1' })
    handler({ text: '看看 web-1 的日志' })
    expect(setDraft).toHaveBeenCalledWith('看看 web-1 的日志')
    expect(open).toHaveBeenCalledWith('s1')
    expect(clear).not.toHaveBeenCalled()
    expect(connectWorkspace).not.toHaveBeenCalled()
  })

  it('connects the recent workspace blank session and prefills it before opening', async () => {
    const { handler, open, setDraft, connectWorkspace } = harness({
      recentWorkspaceId: 'w1',
      connect: vi.fn(() => Promise.resolve('fresh1')),
    })
    handler({ text: '查一下报错' })
    await vi.waitFor(() =>{  expect(open).toHaveBeenCalledWith('fresh1') })
    expect(connectWorkspace).toHaveBeenCalledWith('w1')
    expect(setDraft).toHaveBeenCalledWith('查一下报错')
  })

  it('clears the selection when no workspace exists at all', () => {
    const { handler, open, clear } = harness()
    handler({ text: 'hi' })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('logs a warn and stays quiet when creating the session fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { handler, open } = harness({
      recentWorkspaceId: 'w1',
      connect: vi.fn(() => Promise.reject(new Error('connect failed'))),
    })
    try {
      handler({ text: 'x' })
      await vi.waitFor(() =>{  expect(warn).toHaveBeenCalled() })
      expect(open).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('light-binds the referenced asset onto the tool-context settings namespace', () => {
    const { handler, update, selection } = harness({ current: 's1' })
    selection.selectSubcategory('terminal')
    handler({ text: 'web-1 报错', assetId: 'a1', assetName: 'web-1' })
    expect(update).toHaveBeenCalledWith({
      ns: TOOL_CONTEXT_NAMESPACE,
      patch: { sessionId: 's1', subcategory: 'terminal', assetId: 'a1', assetName: 'web-1', routePrefix: '', assetType: '' },
    })
  })

  it('light-binds with an empty name when the payload omits assetName', () => {
    const { handler, update } = harness({ current: 's1' })
    handler({ text: 'x', assetId: 'a1' })
    expect(update).toHaveBeenCalledWith({
      ns: TOOL_CONTEXT_NAMESPACE,
      patch: { sessionId: 's1', subcategory: '', assetId: 'a1', assetName: '', routePrefix: '', assetType: '' },
    })
  })

  it('skips prefill but still focuses when the conversation service is absent', () => {
    const { handler, open, setDraft } = harness({ current: 's1', noConversation: true })
    handler({ text: 'hi' })
    expect(open).toHaveBeenCalledWith('s1')
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('skips prefill when the session binding is unresolvable', () => {
    const { handler, open, inputFor, setDraft } = harness({ current: 's1', unresolvable: true })
    handler({ text: 'hi' })
    expect(open).toHaveBeenCalledWith('s1')
    expect(inputFor).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })
})
