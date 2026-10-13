/**
 * Assistant registry: one agent-scoped session per SSH terminal page.
 *
 * The registry owns the assistant lifecycle (open / prompt / stop / close),
 * the per-assistant model override, the SSE client fan-out, and the parked
 * approval decisions. Every cordis-facing operation arrives through the
 * {@link AssistantHost} port, so the bookkeeping is testable without a live
 * agent loop; `apply()` wires that port to the real services.
 *
 * Identity: `sshSessionId` (the terminal page's own session id) keys the
 * user-visible assistant — reopening the same page reuses the live agent.
 * `assistantId` is the agent/session id in the dsh session store.
 *
 * @module @deepseek-ai/dsh-starhub-ssh-assistant/registry
 */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AssistantApprovalOutcome, AssistantFrame } from './frames.ts'
import { ASSISTANT_SECTION_NAME, ASSISTANT_TOOLS, assistantPersona } from './persona.ts'

/** Maximum SSE clients attached to one assistant stream. */
const MAX_CLIENTS_PER_ASSISTANT = 8

/** Session event types replayed to a late-attaching client. */
const REPLAYABLE_EVENTS: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/**
 * Replay buffer bound per assistant (events). The buffer is maintained
 * incrementally from the live `session/event` stream — synchronous reads of
 * arbitrary Session history are deprecated for new production callers, and a
 * bounded in-memory window is exactly the projected state a late client needs.
 */
const REPLAY_BUFFER_EVENTS = 2000

/** One live assistant: agent handle plus its panel-facing state. */
export interface AssistantEntry {
  /** Agent/session id in the dsh session store. */
  readonly assistantId: string
  /** Terminal-page session id this assistant serves (registry key). */
  readonly sshSessionId: string
  readonly assetId: string
  readonly assetName: string
  readonly handle: AgentHandle
  /** Model route in force (creation-time default until the panel overrides). */
  provider: string
  model: string
  status: 'idle' | 'running'
  readonly clients: Set<(frame: AssistantFrame) => void>
  readonly approvals: Map<string, (outcome: ApprovalOutcome) => void>
  /** Approval frame still awaiting a panel decision (re-pushed on attach). */
  pendingApproval: AssistantFrame | null
  /** Bounded renderable-event window replayed to late-attaching clients. */
  readonly recent: SessionEvent[]
}

/** Request to open (or reuse) the assistant of one terminal page. */
export interface OpenAssistantRequest {
  readonly sshSessionId: string
  readonly assetId: string
  readonly assetName: string
}

/** Result of {@link AssistantRegistry.open}. */
export interface OpenAssistantResult {
  readonly assistantId: string
  readonly provider: string
  readonly model: string
  readonly reused: boolean
}

/** Cordis-facing operations the registry depends on. */
export interface AssistantHost {
  /** Create the agent-scoped session (dsh `ctx.agents.create`). */
  createAgent(options: CreateAgentOptions): Promise<AgentHandle>
  /** Live agent for a session id, or undefined when it is gone. */
  getAgent(sessionId: SessionId): Agent | undefined
  /** Bind the assistant session to an asset (bridge `starhub/bind.asset`). */
  bindAsset(assetId: string, sessionId: string): Promise<void>
  /** Deployment default model route, or undefined when unconfigured. */
  defaultSelection(): { provider: string; model: string } | undefined
  /** Whether a provider route currently lists this model. */
  modelExists(provider: string, model: string): Promise<boolean>
}

/**
 * Registry of live SSH assistants with their panel streams.
 */
export class AssistantRegistry {
  private readonly bySsh = new Map<string, AssistantEntry>()
  private readonly byAssistant = new Map<string, AssistantEntry>()

  constructor(private readonly host: AssistantHost) {}

  /**
   * Open (or reuse) the assistant of one terminal page.
   * @param request - terminal session id plus the bound asset identity.
   * @returns the assistant id and the model route in force.
   * @throws when no default model is configured, agent creation fails, or the
   *   asset binding fails — the caller surfaces the message in the panel.
   */
  async open(request: OpenAssistantRequest): Promise<OpenAssistantResult> {
    const existing = this.bySsh.get(request.sshSessionId)
    if (existing !== undefined) {
      if (this.host.getAgent(SessionId(existing.assistantId)) !== undefined) {
        return {
          assistantId: existing.assistantId,
          provider: existing.provider,
          model: existing.model,
          reused: true,
        }
      }
      // The agent left the registry without our close (loop teardown): drop
      // the stale entry and build a fresh one below.
      this.forget(existing)
    }
    const selection = this.host.defaultSelection()
    if (selection === undefined) {
      throw new Error('没有可用的默认模型:请在 dsh 设置中配置模型后再打开 AI 助手')
    }
    const assistantId = `ssh-assistant-${randomUUID()}`
    const handle = await this.host.createAgent({
      sessionId: SessionId(assistantId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const tools = agentCtx.get('tools') as {
          restrict(filter: { allow: string[] }): void
        } | undefined
        if (tools === undefined) {
          throw new Error('starhub-ssh-assistant 需要 dsh tools 服务(组合中应包含 starhub-tools)')
        }
        // 收敛工具面:助手只能看到这台服务器的 SSH/SFTP 工具,本地 shell、
        // 数据库、浏览器一律不可见(allow 之外的全局工具全部拒绝)。
        tools.restrict({ allow: [...ASSISTANT_TOOLS] })
        const prompt = agentCtx.get('systemPrompt') as {
          section(section: { name: string; order: number; text: string }): void
        } | undefined
        if (prompt === undefined) {
          throw new Error('starhub-ssh-assistant 需要 dsh systemPrompt 服务')
        }
        prompt.section({
          name: ASSISTANT_SECTION_NAME,
          order: 5,
          text: assistantPersona(request.assetName),
        })
      },
    })
    await this.host.bindAsset(request.assetId, assistantId)
    const entry: AssistantEntry = {
      assistantId,
      sshSessionId: request.sshSessionId,
      assetId: request.assetId,
      assetName: request.assetName,
      handle,
      provider: selection.provider,
      model: selection.model,
      status: 'idle',
      clients: new Set(),
      approvals: new Map(),
      pendingApproval: null,
      recent: [],
    }
    this.bySsh.set(request.sshSessionId, entry)
    this.byAssistant.set(assistantId, entry)
    return { assistantId, provider: selection.provider, model: selection.model, reused: false }
  }

  /**
   * Queue one user prompt as the assistant's next turn.
   * @param assistantId - target assistant.
   * @param text - prompt text.
   * @throws when the assistant is unknown (closed or never opened).
   */
  prompt(assistantId: string, text: string): void {
    const entry = this.require(assistantId)
    const agent = this.host.getAgent(SessionId(entry.assistantId))
    if (agent === undefined) {
      throw new Error('AI 助手会话已关闭,请重新打开')
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  }

  /**
   * Abort the assistant's active turn (queued input survives).
   * @param assistantId - target assistant.
   */
  stop(assistantId: string): void {
    const entry = this.require(assistantId)
    const agent = this.host.getAgent(SessionId(entry.assistantId))
    agent?.cancel({ kind: 'user' })
  }

  /**
   * Dispose one assistant: parked approvals settle as cancelled, panel clients
   * receive a closing frame, and the agent handle unwinds its scoped world.
   * @param assistantId - target assistant.
   */
  async close(assistantId: string): Promise<void> {
    const entry = this.byAssistant.get(assistantId)
    if (entry === undefined) return
    this.forget(entry)
    for (const settle of entry.approvals.values()) settle('cancelled')
    entry.approvals.clear()
    entry.pendingApproval = null
    for (const write of entry.clients) write({ t: 'closed' })
    entry.clients.clear()
    await entry.handle.dispose()
  }

  /**
   * Override the model route for one assistant's subsequent requests.
   * @param assistantId - target assistant.
   * @param provider - provider route key.
   * @param model - provider-owned model id.
   * @throws when the route/model pair is not currently available.
   */
  async setModel(assistantId: string, provider: string, model: string): Promise<void> {
    const entry = this.require(assistantId)
    if (!await this.host.modelExists(provider, model)) {
      throw new Error(`模型 ${provider}/${model} 当前不可用`)
    }
    entry.provider = provider
    entry.model = model
    for (const write of entry.clients) write({ t: 'model', provider, model })
  }

  /**
   * Attach one SSE client to an assistant's stream.
   *
   * A late client (tab reopened, stream reconnected) first receives the
   * assistant's bounded event window — the same events the live listener
   * forwards, so folding stays idempotent by message/call id — then the live
   * status, the model route, and any approval still awaiting a decision.
   * @param assistantId - target assistant.
   * @param write - frame sink; the returned disposer detaches it.
   * @returns the disposer.
   * @throws when the assistant is unknown or the client cap is reached.
   */
  attach(assistantId: string, write: (frame: AssistantFrame) => void): () => void {
    const entry = this.require(assistantId)
    if (entry.clients.size >= MAX_CLIENTS_PER_ASSISTANT) {
      throw new Error('AI 助手流客户端过多')
    }
    entry.clients.add(write)
    for (const event of entry.recent) write({ t: 'event', event })
    write({ t: 'status', status: entry.status })
    write({ t: 'model', provider: entry.provider, model: entry.model })
    if (entry.pendingApproval !== null) write(entry.pendingApproval)
    return () => { entry.clients.delete(write) }
  }

  /**
   * Settle one parked approval from the panel.
   *
   * Deletion belongs to the parked `settle` wrapper (its double-settle guard);
   * deleting here first would make that guard fail and never resolve the ask.
   * @param assistantId - target assistant.
   * @param requestId - the parked request identity.
   * @param outcome - the panel's decision.
   * @returns false when the request is unknown (already settled or expired).
   */
  submitApproval(assistantId: string, requestId: string, outcome: AssistantApprovalOutcome): boolean {
    const entry = this.byAssistant.get(assistantId)
    const settle = entry?.approvals.get(requestId)
    if (entry === undefined || settle === undefined) return false
    entry.pendingApproval = null
    settle(outcome)
    return true
  }

  /**
   * Park one approval request for an assistant session and await the panel.
   * @param assistantId - the requesting assistant.
   * @param request - tool identity plus the asker's reason.
   * @returns the settled outcome; 'cancelled' when the assistant closes first.
   */
  parkApproval(
    assistantId: string,
    request: { toolName: string; callId?: string; reason?: string; signal?: AbortSignal },
  ): Promise<ApprovalOutcome> {
    const entry = this.byAssistant.get(assistantId)
    if (entry === undefined) return Promise.resolve('unavailable')
    const requestId = randomUUID()
    const frame: AssistantFrame = {
      t: 'approval',
      requestId,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }
    entry.pendingApproval = frame
    for (const write of entry.clients) write(frame)
    return new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (entry.approvals.delete(requestId)) {
          entry.pendingApproval = null
          resolve(outcome)
        }
      }
      entry.approvals.set(requestId, settle)
      request.signal?.addEventListener('abort', () => { settle('cancelled') }, { once: true })
    })
  }

  /** Forward one session event to the owning assistant's clients. */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    const entry = this.byAssistant.get(sessionId)
    if (entry === undefined) return
    if (REPLAYABLE_EVENTS.has(event.type)) {
      entry.recent.push(event)
      if (entry.recent.length > REPLAY_BUFFER_EVENTS) {
        entry.recent.splice(0, entry.recent.length - REPLAY_BUFFER_EVENTS)
      }
    }
    for (const write of entry.clients) write({ t: 'event', event })
  }

  /** Track and forward one agent status transition. */
  onStatus(sessionId: string, status: 'idle' | 'running'): void {
    const entry = this.byAssistant.get(sessionId)
    if (entry === undefined) return
    entry.status = status
    for (const write of entry.clients) write({ t: 'status', status })
  }

  /**
   * Apply the per-assistant model override to a frozen request config.
   * @param sessionId - the requesting agent's session id.
   * @param config - the config the loop frozen for this request.
   * @returns the config unchanged for other agents or without an override;
   *   otherwise the replaced route (a stale reasoning effort is dropped so the
   *   new model resolves its own default).
   */
  applyRequestConfig(sessionId: string, config: LlmCallConfig): LlmCallConfig {
    const entry = this.byAssistant.get(sessionId)
    if (entry === undefined) return config
    if (config.provider === entry.provider && config.model === entry.model) return config
    const { reasoningEffort: _stale, ...rest } = config
    return { ...rest, provider: entry.provider, model: entry.model }
  }

  /** Assistant id serving one terminal page, when live. */
  assistantFor(sshSessionId: string): string | undefined {
    return this.bySsh.get(sshSessionId)?.assistantId
  }

  /** Whether a session id belongs to a live assistant. */
  isAssistant(sessionId: string): boolean {
    return this.byAssistant.has(sessionId)
  }

  /** Whether an assistant currently has panel clients on its stream. */
  hasClients(sessionId: string): boolean {
    const entry = this.byAssistant.get(sessionId)
    return entry !== undefined && entry.clients.size > 0
  }

  /** Dispose every live assistant (plugin unload). */
  async disposeAll(): Promise<void> {
    const entries = [...this.byAssistant.values()]
    for (const entry of entries) {
      this.forget(entry)
      for (const settle of entry.approvals.values()) settle('cancelled')
      entry.approvals.clear()
      entry.pendingApproval = null
      for (const write of entry.clients) write({ t: 'closed' })
      entry.clients.clear()
      await entry.handle.dispose()
    }
  }

  /**
   * @param assistantId - assistant id to look up.
   * @returns the entry.
   * @throws when unknown.
   */
  private require(assistantId: string): AssistantEntry {
    const entry = this.byAssistant.get(assistantId)
    if (entry === undefined) throw new Error('AI 助手不存在或已关闭')
    return entry
  }

  /** Remove one entry from both indexes without touching its agent. */
  private forget(entry: AssistantEntry): void {
    this.bySsh.delete(entry.sshSessionId)
    this.byAssistant.delete(entry.assistantId)
  }
}
