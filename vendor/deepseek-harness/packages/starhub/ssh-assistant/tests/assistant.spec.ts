/**
 * starhub-ssh-assistant 测试:注册表簿记(假 host)+ 真实组合(真 AgentLoop
 * + 脚本化 mock adapter,走真实 HTTP 路由驱动一整回合)。
 *
 * 组合层钉死三件事:
 * 1. 助手会话的工具面被 restrict 到 SSH/SFTP——调用未授权工具(bash)拿到
 *    工具错误,授权工具(ssh_exec)正常执行并回 tool/result;
 * 2. durable log 事件经 SSE 路由原样到达面板客户端(晚到客户端先收重放);
 * 3. 助手会话的 approval/request 由本插件承接:SSE 推卡 → 面板结算 →
 *    工具放行;非助手会话原样交回链尾。
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as plugin from '../src/index.ts'
import { AssistantRegistry, aiConnId, connFrame, type AssistantHost } from '../src/registry.ts'
import { decodeAssistantFrame, type AssistantFrame } from '../src/frames.ts'

// ── 假 host(注册表簿记单测)───────────────────────────────────────

interface FakeAgent {
  session: { id: SessionId; snapshotEvents: () => [] }
  followed: string[]
  cancels: number
  followup: (message: { content: [{ type: 'text'; text: string }] }) => void
  cancel: () => void
}

function fakeAgent(id: string): FakeAgent {
  const agent: FakeAgent = {
    session: { id: SessionId(id), snapshotEvents: () => [] },
    followed: [],
    cancels: 0,
    followup(message) { agent.followed.push(message.content[0].text) },
    cancel() { agent.cancels += 1 },
  }
  return agent
}

function fakeHost(): AssistantHost & {
  agents: Map<string, FakeAgent>
  disposed: string[]
  bindings: Array<[string, string]>
  notifications: Map<string, (params: object) => void>
} {
  const agents = new Map<string, FakeAgent>()
  const disposed: string[] = []
  const bindings: Array<[string, string]> = []
  const notifications = new Map<string, (params: object) => void>()
  return {
    agents,
    disposed,
    bindings,
    notifications,
    createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
      const id = String(options.sessionId)
      const agent = fakeAgent(id)
      agents.set(id, agent)
      // 真理由 agent-loop 调用 setup;假 host 同步触发以覆盖注册路径。
      void options.setup?.({
        get: (name: string) => (name === 'tools'
          ? { restrict: () => undefined }
          : name === 'systemPrompt' ? { section: () => undefined } : undefined),
      } as never, agent as never)
      return Promise.resolve({
        agent: agent as unknown as Agent,
        dispose: async () => { disposed.push(id); agents.delete(id) },
      })
    },
    getAgent(sessionId: SessionId) { return agents.get(String(sessionId)) as unknown as Agent | undefined },
    bindAsset(assetId: string, sessionId: string): Promise<void> {
      bindings.push([assetId, sessionId])
      return Promise.resolve()
    },
    defaultSelection() { return { provider: 'mock', model: 'mock-model' } },
    modelExists(provider: string, model: string): Promise<boolean> {
      return Promise.resolve(provider === 'mock' && model === 'mock-model')
    },
    subscribeNotification(method: string, handler: (params: object) => void): () => void {
      notifications.set(method, handler)
      return () => { notifications.delete(method) }
    },
  }
}

describe('AssistantRegistry bookkeeping', () => {
  it('opens once per terminal page and reuses the live agent', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const first = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    expect(first.reused).toBe(false)
    expect(host.bindings).toEqual([['a1', first.assistantId]])
    const second = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    expect(second).toMatchObject({ reused: true, assistantId: first.assistantId })
    expect(host.agents.size).toBe(1)
  })

  it('rebuilds when the agent left the registry without a close', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const first = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    host.agents.delete(first.assistantId)
    const second = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    expect(second.reused).toBe(false)
    expect(second.assistantId).not.toBe(first.assistantId)
  })

  it('fails loud without a default model', async () => {
    const host = fakeHost()
    host.defaultSelection = () => undefined
    const registry = new AssistantRegistry(host)
    await expect(registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' }))
      .rejects.toThrow('没有可用的默认模型')
  })

  it('routes prompts and stops to the agent', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const { assistantId } = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    registry.prompt(assistantId, 'df -h')
    registry.stop(assistantId)
    const agent = host.agents.get(assistantId)
    expect(agent?.followed).toEqual(['df -h'])
    expect(agent?.cancels).toBe(1)
    expect(() => { registry.prompt('missing', 'x') }).toThrow('AI 助手不存在或已关闭')
  })

  it('parks an approval for the panel and settles it once', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const { assistantId } = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    const frames: AssistantFrame[] = []
    registry.attach(assistantId, frame => frames.push(frame))
    const pending = registry.parkApproval(assistantId, { toolName: 'ssh_exec', reason: '风险命令:reboot' })
    expect(frames.some(frame => frame.t === 'approval')).toBe(true)
    expect(registry.submitApproval(assistantId, 'bogus', 'rejected')).toBe(false)
    const approvalFrame = frames.find(frame => frame.t === 'approval')
    expect(approvalFrame?.t === 'approval' && registry.submitApproval(assistantId, approvalFrame.requestId, 'allowed-once')).toBe(true)
    await expect(pending).resolves.toBe('allowed-once')
    // 重复结算无效。
    expect(approvalFrame?.t === 'approval' && registry.submitApproval(assistantId, approvalFrame.requestId, 'rejected')).toBe(false)
  })

  it('cancels parked approvals on close', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const { assistantId } = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    const pending = registry.parkApproval(assistantId, { toolName: 'ssh_exec' })
    await registry.close(assistantId)
    await expect(pending).resolves.toBe('cancelled')
    expect(host.disposed).toContain(assistantId)
  })

  it('applies the model override only to its own agent', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const { assistantId } = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    const base = { provider: 'mock', model: 'mock-model', reasoningEffort: 'high' as never, maxTokens: 10 }
    // 无覆盖:原样返回。
    expect(registry.applyRequestConfig('other', base)).toBe(base)
    await registry.setModel(assistantId, 'mock', 'mock-model')
    const same = registry.applyRequestConfig(assistantId, base)
    expect(same).toBe(base)
    await expect(registry.setModel(assistantId, 'mock', 'nope')).rejects.toThrow('当前不可用')
  })

  it('routes the asset AI-exec connection cards to the panel', async () => {
    const host = fakeHost()
    const registry = new AssistantRegistry(host)
    const { assistantId } = await registry.open({ sshSessionId: 's1', assetId: 'a1', assetName: 'server' })
    // 订阅精确事件(connId = dsh:a1:ssh,与 Rust ai_conn_id 对齐)。
    expect(host.notifications.has('ssh:kb-interactive:dsh:a1:ssh')).toBe(true)
    expect(host.notifications.has('ssh:hostkey-confirm:dsh:a1:ssh')).toBe(true)
    const frames: AssistantFrame[] = []
    registry.attach(assistantId, frame => frames.push(frame))

    host.notifications.get('ssh:kb-interactive:dsh:a1:ssh')?.({
      sessionId: 'dsh:a1:ssh',
      instructions: 'Verification code',
      prompts: [{ prompt: 'Password', echo: false }],
      autoFill: [null],
    })
    const kb = frames.find(frame => frame.t === 'kb-interactive')
    expect(kb).toMatchObject({ t: 'kb-interactive', connId: 'dsh:a1:ssh', instructions: 'Verification code' })

    // 晚到客户端:重推挂起的 MFA 卡。
    const late: AssistantFrame[] = []
    registry.attach(assistantId, frame => late.push(frame))
    expect(late.some(frame => frame.t === 'kb-interactive')).toBe(true)

    // 连接成功 → 卡关闭;不再重推。
    host.notifications.get('ssh:mfa-connected:dsh:a1:ssh')?.({})
    const latest: AssistantFrame[] = []
    registry.attach(assistantId, frame => latest.push(frame))
    expect(latest.some(frame => frame.t === 'kb-interactive')).toBe(false)

    // 堡垒机输出帧原样透传字节。
    host.notifications.get('ssh:bastion-output:dsh:a1:ssh')?.([104, 105])
    const out = frames.find(frame => frame.t === 'bastion-output')
    expect(out).toMatchObject({ t: 'bastion-output', connId: 'dsh:a1:ssh', bytes: [104, 105] })

    // active-conns 只报有面板客户端的连接。
    expect(registry.activeConns()).toEqual(['dsh:a1:ssh'])
    await registry.close(assistantId)
    expect(registry.activeConns()).toEqual([])
    expect(host.notifications.size).toBe(0)
  })

  it('drops notifications for unknown connection events', () => {
    expect(aiConnId('a1')).toBe('dsh:a1:ssh')
    expect(connFrame('nope', 'dsh:a1:ssh', {})).toBeNull()
    expect(connFrame('hostkey', 'dsh:a1:ssh', {})).toBeNull()
    expect(connFrame('bastion-output', 'dsh:a1:ssh', 'not-array' as unknown as object)).toMatchObject({ bytes: [] })
    expect(connFrame('bastion-done', 'dsh:a1:ssh', {})).toEqual({ t: 'bastion-done', connId: 'dsh:a1:ssh' })
  })
})

// ── 真实组合 ────────────────────────────────────────────────────

/** 脚本化 mock adapter:按调用次序吐出预算好的 chunk 序列。 */
class ScriptedAdapter extends LlmAdapter {
  calls = 0
  /** 挂起门的 resolvers(测试结束时统一放行,避免 dispose 悬挂)。 */
  private readonly gates: Array<() => void> = []
  constructor(private readonly script: () => StreamChunk[][]) { super() }
  override listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider: 'mock', id: 'mock-model', name: 'Mock Model' }])
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const rounds = this.script()
    const chunks = rounds[Math.min(this.calls, rounds.length - 1)] ?? []
    this.calls += 1
    for (const chunk of chunks) yield chunk
    // 脚本最后一轮且未含 finish:挂起(审批路径测试用)。
    if (!chunks.some(chunk => chunk.type === 'finish')) {
      await new Promise<void>((resolve) => { this.gates.push(resolve) })
    }
  }
  /** 放行全部挂起的流。 */
  release(): void {
    for (const resolve of this.gates.splice(0)) resolve()
  }
}

/** 文本回复。 */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 工具调用回复。 */
function toolCallResponse(callId: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId as never, name, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 挂起回复:吐出文本后永不结束(把回合保持在 open,供审批路径测试)。 */
function hangResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
  ]
}

/** 假 req:POST + JSON body 或 GET + 查询串。 */
function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk },
    on() { return this },
  } as unknown as IncomingMessage
}

/** 假 res:捕获 writeHead/write/end。 */
function fakeResponse(): ServerResponse & { body: () => string; frames: () => AssistantFrame[] } {
  let head = ''
  const chunks: string[] = []
  const res = {
    writableEnded: false,
    writeHead(_status: number, headers: Record<string, string>) { head = JSON.stringify(headers) },
    write(chunk: string) { chunks.push(chunk) },
    end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk) },
    on() { return this },
    body: () => chunks.join(''),
    frames: () => chunks
      .join('')
      .split('\n\n')
      .filter(block => block.includes('data: '))
      .map(block => decodeAssistantFrame(block.slice(block.indexOf('data: ') + 6).trim()))
      .filter((frame): frame is AssistantFrame => frame !== null),
    headers: () => head,
  }
  return res as unknown as ServerResponse & { body: () => string; frames: () => AssistantFrame[] }
}

/** 解析路由响应信封;ok:false 时带上 error 抛出(失败可诊断)。 */
function parseEnvelope(res: { body: () => string }): Record<string, unknown> {
  const body = JSON.parse(res.body()) as { ok: boolean; result?: unknown; error?: string }
  if (!body.ok) throw new Error(`assistant route failed: ${body.error ?? 'unknown'}`)
  return body.result === undefined ? {} : body.result as Record<string, unknown>
}

/** 装配真实组合并挂载插件;返回驱动面。 */
async function mounted(options: { script: () => StreamChunk[][] }) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const adapter = new ScriptedAdapter(options.script)
  ctx.llm.registerAdapter(['mock'], adapter)
  // 8 个 SSH/SFTP 工具夹具(真实组合里由 starhub-tools 注册);执行记录进 ran。
  const ran: string[] = []
  for (const name of ['ssh_exec', 'ssh_exec_background', 'ssh_wait_task', 'ssh_session_status', 'sftp_list', 'sftp_stat', 'sftp_upload', 'sftp_download']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `fake ${name}`,
      parameters: {},
      async execute(args) {
        ran.push(`${name} ${JSON.stringify(args)}`)
        return [{ type: 'text', text: `ok-${name}` }]
      },
    }))
  }
  // 假 webServer:记录路由注册。
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  ctx.provide('webServer', {
    register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  })
  // 假 sdk-transport:记录 bind.asset。
  const bridgeCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  ctx.provide('sdk-transport', {
    async request(method: string, params: object) {
      bridgeCalls.push({ method, params: params as Record<string, unknown> })
      if (method === 'starhub/bind.asset') return { ok: true, action: 'bound' }
      throw new Error(`unexpected bridge method ${method}`)
    },
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) })
  // 假 sdk-notifications:记录订阅,测试可手动派发精确事件。
  const notifications = new Map<string, (params: object) => void>()
  ctx.provide('sdk-notifications', {
    subscribe(method: string, handler: (params: object) => void) {
      notifications.set(method, handler)
      return () => { notifications.delete(method) }
    },
  })
  await ctx.plugin(plugin)
  onTestFinished(() =>{  adapter.release() })
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`route ${path} not registered`)
    const res = fakeResponse()
    await handler(fakeRequest('POST', path, body), res)
    return parseEnvelope(res)
  }
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`route ${path} not registered`)
    const res = fakeResponse()
    await handler(fakeRequest('GET', path), res)
    return parseEnvelope(res)
  }
  const stream = async (assistantId: string): Promise<{ frames: () => AssistantFrame[]; res: ReturnType<typeof fakeResponse> }> => {
    const handler = routes.get('/starhub/api/assistant/stream')
    if (handler === undefined) throw new Error('stream route not registered')
    const res = fakeResponse()
    await handler(fakeRequest('GET', `/starhub/api/assistant/stream?assistantId=${assistantId}`), res)
    return { frames: () => res.frames(), res }
  }
  return { ctx, adapter, routes, bridgeCalls, ran, notifications, post, get, stream }
}

describe('starhub-ssh-assistant composition', () => {
  it('runs one full assistant turn over the real HTTP routes', async () => {
    const host = await mounted({
      script: () => [[
        ...toolCallResponse('call-1', 'ssh_exec', { command: 'df -h' }),
      ], [
        ...textResponse('磁盘使用率 50%。'),
      ]],
    })
    // 一个未授权工具(bash):restrict 之后模型调不到它。
    let bashRan = false
    host.ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'local shell',
      parameters: { command: { type: 'string', required: true } },
      async execute() { bashRan = true; return [{ type: 'text', text: 'nope' }] },
    }))

    const opened = await host.post('/starhub/api/assistant/open', {
      sshSessionId: 'ssh-1__c00000',
      assetId: 'ssh-1',
      assetName: 'server',
    })
    const assistantId = (opened as { assistantId: string }).assistantId
    expect(host.bridgeCalls).toEqual([{ method: 'starhub/bind.asset', params: { assetId: 'ssh-1', sessionId: assistantId } }])

    // 先挂流客户端(晚到客户端拿重放)。
    const { frames } = await host.stream(assistantId)
    const prompt = await host.post('/starhub/api/assistant/prompt', { assistantId, text: '看看磁盘' })
    expect(prompt).toEqual({ accepted: true })

    // 等回合结束:最终助手消息落库(durable log → SSE 客户端)。
    await vi.waitFor(() =>{  expect(frames().some(frame =>
      frame.t === 'event' && frame.event.type === 'assistant/message')).toBe(true) }, { timeout: 5000 })

    // 授权工具执行了;本地 shell 从未被调用(restrict 生效)。
    expect(host.ran.some(entry => entry.startsWith('ssh_exec '))).toBe(true)
    expect(bashRan).toBe(false)
    // durable log 事件到达了面板客户端。
    const events = frames().flatMap(frame => frame.t === 'event' ? [frame.event] : [])
    expect(events.some(event => event.type === 'user/message')).toBe(true)
    expect(events.some(event => event.type === 'tool/call')).toBe(true)
    expect(events.some(event => event.type === 'tool/result')).toBe(true)
    expect(events.some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('parks an assistant approval on the stream and settles it from the panel', async () => {
    // 模型流挂起(无 finish),回合保持 open——与真实回合里 tools/pre-execute
    // 升级 ask 的时序一致。
    const host = await mounted({ script: () => [[...hangResponse('thinking')]] })
    const opened = await host.post('/starhub/api/assistant/open', {
      sshSessionId: 's1', assetId: 'ssh-1', assetName: 'server',
    })
    const assistantId = (opened as { assistantId: string }).assistantId
    const { res } = await host.stream(assistantId)

    const agent = host.ctx.agents.get(SessionId(assistantId))
    agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'reboot' }], source: { kind: 'user' } }))
    // 等 turn/start 落库(approval.request 要求 open turn)。
    await vi.waitFor(() =>{  expect(res.frames().some(frame =>
      frame.t === 'event' && frame.event.type === 'turn/start')).toBe(true) }, { timeout: 5000 })
    const ask = host.ctx.approval.request({ agent: agent as never, toolName: 'ssh_exec', reason: '风险命令:reboot' })
    await vi.waitFor(() =>{  expect(res.frames().some(frame => frame.t === 'approval')).toBe(true) }, { timeout: 5000 })
    const approvalFrame = res.frames().find(frame => frame.t === 'approval')
    const requestId = approvalFrame?.t === 'approval' ? approvalFrame.requestId : ''
    const settled = await host.post('/starhub/api/assistant/approval', {
      assistantId, requestId, outcome: 'allowed-once',
    })
    expect(settled).toEqual({ settled: true })
    await expect(ask).resolves.toBe('allowed-once')
  })

  it('leaves non-assistant approvals to the waterfall', async () => {
    const host = await mounted({ script: () => [[...textResponse('done')]] })
    // 非助手会话:approval/request 监听直接交回链尾(无 answerer → unavailable)。
    const session = host.ctx.sessions.create(SessionId('plain'))
    const outcome = await host.ctx.waterfall(
      'approval/request',
      { agent: { session } as never, toolName: 'ssh_exec' },
      () => Promise.resolve('unavailable' as const),
    )
    expect(outcome).toBe('unavailable')
  })

  it('closes the assistant session on demand', async () => {
    const host = await mounted({ script: () => [[...textResponse('done')]] })
    const opened = await host.post('/starhub/api/assistant/open', {
      sshSessionId: 's1', assetId: 'ssh-1', assetName: 'server',
    })
    const assistantId = (opened as { assistantId: string }).assistantId
    expect(host.ctx.agents.get(SessionId(assistantId))).toBeDefined()
    const closed = await host.post('/starhub/api/assistant/close', { assistantId })
    expect(closed).toEqual({ closed: true })
    expect(host.ctx.agents.get(SessionId(assistantId))).toBeUndefined()
  })

  it('serves the model catalog for the panel picker', async () => {
    const host = await mounted({ script: () => [[...textResponse('done')]] })
    const res = await host.get('/starhub/api/assistant/models')
    expect((res as { providers: Array<{ provider: string; models: Array<{ id: string }> }> }).providers[0]?.models[0]?.id).toBe('mock-model')
  })

  it('forwards the asset connection card to the panel and reports active conns', async () => {
    const host = await mounted({ script: () => [[...textResponse('done')]] })
    const opened = await host.post('/starhub/api/assistant/open', {
      sshSessionId: 's1', assetId: 'ssh-1', assetName: 'server',
    })
    const assistantId = (opened as { assistantId: string }).assistantId
    const { frames } = await host.stream(assistantId)

    // sidecar 精确事件(AI exec 连接 dsh:ssh-1:ssh)→ SSE 帧。
    const kb = host.notifications.get('ssh:kb-interactive:dsh:ssh-1:ssh')
    expect(kb).toBeDefined()
    kb?.({
      sessionId: 'dsh:ssh-1:ssh',
      instructions: 'Verification code',
      prompts: [{ prompt: 'Password', echo: false }],
      autoFill: [null],
    })
    expect(frames().some(frame => frame.t === 'kb-interactive')).toBe(true)

    // 壳内连接卡据此抑制:active-conns 只含有面板客户端的连接。
    const active = await host.get('/starhub/api/assistant/active-conns')
    expect(active).toEqual({ conns: ['dsh:ssh-1:ssh'] })
  })
})
