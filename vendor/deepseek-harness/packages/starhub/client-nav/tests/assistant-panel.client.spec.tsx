// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SshAssistantPanel } from '../src/client/terminal/SshAssistantPanel.tsx'
import { emitHostEvent, restoreHostEvents, stubHostEvents } from './host-bridge.ts'

/** 记录到的助手路由调用。 */
interface AssistantCall {
  path: string
  body: Record<string, unknown>
}

let calls: AssistantCall[] = []

/** open 路由返回的助手身份。 */
const OPEN_RESULT = {
  assistantId: 'ssh-assistant-1',
  provider: 'deepseek',
  model: 'deepseek-chat',
  reused: false,
}

/** 构造 JSON 响应(jsdom 无 Response 构造器时手搓 ok/status/json 面)。 */
function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  if (typeof Response === 'function') {
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) as unknown } as unknown as Response
}

/** fetch 替身:按路径应答助手路由,其余 404。 */
async function assistantFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const path = url.replace(/^https?:\/\/[^/]+/, '')
  const method = (init?.method ?? 'GET').toUpperCase()
  if (!path.startsWith('/starhub/api/assistant/')) {
    return jsonResponse({ ok: false, error: `unmatched ${method} ${path}` }, 404)
  }
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  calls.push({ path, body })
  if (path.endsWith('/open')) return jsonResponse({ ok: true, result: OPEN_RESULT })
  if (path.endsWith('/models')) {
    return jsonResponse({
      ok: true,
      result: {
        providers: [{
          provider: 'deepseek',
          displayName: 'DeepSeek',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        }],
      },
    })
  }
  return jsonResponse({ ok: true, result: {} })
}

/** 等助手就绪(open 往返 + 订阅建立)。 */
async function waitReady(): Promise<void> {
  await waitFor(() =>{  expect(screen.getByText('问点什么,或交给它一个任务。')).toBeTruthy() })
}

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', assistantFetch)
  stubHostEvents()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  restoreHostEvents()
})

describe('SshAssistantPanel', () => {
  it('opens the assistant for the terminal session and shows the empty state', async () => {
    render(
      <SshAssistantPanel sshSessionId="ssh-1__c00000" assetId="ssh-1" assetName="server" />,
    )
    await waitReady()
    expect(calls[0]).toMatchObject({
      path: '/starhub/api/assistant/open',
      body: { sshSessionId: 'ssh-1__c00000', assetId: 'ssh-1', assetName: 'server' },
    })
    // 头部展示当前模型路由(部署默认,面板可切)。
    expect(screen.getByLabelText('选择模型提供方')).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>('选择模型').value).toBe('deepseek-chat')
  })

  it('sends the draft as one prompt', async () => {
    render(
      <SshAssistantPanel sshSessionId="s1" assetId="ssh-1" assetName="server" />,
    )
    await waitReady()
    const input = screen.getByLabelText('AI 助手输入框') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'df -h' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(call => call.path.endsWith('/prompt'))).toBe(true) })
    expect(calls.find(call => call.path.endsWith('/prompt'))?.body).toEqual({ assistantId: 'ssh-assistant-1', text: 'df -h' })
    expect(input.value).toBe('')
  })

  it('folds streamed frames into messages', async () => {
    render(
      <SshAssistantPanel sshSessionId="s1" assetId="ssh-1" assetName="server" />,
    )
    await waitReady()
    act(() => {
      emitHostEvent('starhub-assistant', {
        t: 'event',
        event: { type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text: '看看磁盘' }], source: { kind: 'user' } } },
      })
      emitHostEvent('starhub-assistant', {
        t: 'event',
        event: { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: '好的,执行 df -h' }] }, stream: [] } },
      })
      emitHostEvent('starhub-assistant', {
        t: 'event',
        event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'ssh_exec', arguments: '{"command":"df -h"}' } },
      })
      emitHostEvent('starhub-assistant', {
        t: 'event',
        event: { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'r1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '/dev/sda1 50G' }] } } },
      })
    })
    expect(screen.getByText('看看磁盘')).toBeTruthy()
    expect(screen.getByText('好的,执行 df -h')).toBeTruthy()
    expect(screen.getByText('ssh_exec')).toBeTruthy()
    expect(screen.getByText('/dev/sda1 50G')).toBeTruthy()
  })

  it('settles an approval from the panel', async () => {
    render(
      <SshAssistantPanel sshSessionId="s1" assetId="ssh-1" assetName="server" />,
    )
    await waitReady()
    act(() => {
      emitHostEvent('starhub-assistant', {
        t: 'approval',
        requestId: 'r1',
        toolName: 'ssh_exec',
        reason: '风险命令:reboot',
      })
    })
    expect(screen.getByText('风险命令:reboot')).toBeTruthy()
    fireEvent.click(screen.getByText('允许一次'))
    await waitFor(() =>{  expect(screen.getByText('已允许')).toBeTruthy() })
    expect(calls.find(call => call.path.endsWith('/approval'))?.body).toEqual({
      assistantId: 'ssh-assistant-1',
      requestId: 'r1',
      outcome: 'allowed-once',
    })
  })

  it('stops a running turn from the panel', async () => {
    render(
      <SshAssistantPanel sshSessionId="s1" assetId="ssh-1" assetName="server" />,
    )
    await waitReady()
    act(() =>{  emitHostEvent('starhub-assistant', { t: 'status', status: 'running' }) })
    fireEvent.click(screen.getByLabelText('停止'))
    await waitFor(() =>{  expect(calls.some(call => call.path.endsWith('/stop'))).toBe(true) })
    expect(calls.find(call => call.path.endsWith('/stop'))?.body).toEqual({ assistantId: 'ssh-assistant-1' })
  })

  it('disables the composer once the session is closed', async () => {
    render(
      <SshAssistantPanel sshSessionId="s1" assetId="ssh-1" assetName="server" />,
    )
    await waitReady()
    act(() =>{  emitHostEvent('starhub-assistant', { t: 'closed' }) })
    expect(screen.getByText('会话已关闭')).toBeTruthy()
    expect(screen.getByLabelText<HTMLTextAreaElement>('AI 助手输入框').disabled).toBe(true)
  })
})
