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
  /** AI exec connection id of the bound asset (`dsh:<assetId>:ssh`). */
  readonly connId: string
  /** Connection-card frame still open (MFA/bastion/hostkey; re-pushed on attach). */
  pendingConnCard: AssistantFrame | null
  /** Disposers of this entry's sidecar notification subscriptions. */
  readonly notificationOffs: Array<() => void>
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
  /**
   * Absolute local cwd stamped on every assistant session. StarHub-owned and
   * created by the host at plugin apply; sessions without one cannot assemble
   * their prompt (`{{cwd}}` section) and are rejected by the session list.
   */
  readonly sessionCwd: string
  /** Create the agent-scoped session (dsh `ctx.agents.create`). */
  createAgent(options: CreateAgentOptions): Promise<AgentHandle>
  /** Live agent for a session id, or undefined when it is gone. */
  getAgent(sessionId: SessionId): Agent | undefined
  /**
   * Pin one live assistant session's display title (plain server name); a
   * missing title service degrades to a warn — the assistant still works.
   */
  renameSession(sessionId: string, title: string): void
  /** Bind the assistant session to an asset (bridge `starhub/bind.asset`). */
  bindAsset(assetId: string, sessionId: string): Promise<void>
  /** Deployment default model route, or undefined when unconfigured. */
  defaultSelection(): { provider: string; model: string } | undefined
  /** Whether a provider route currently lists this model. */
  modelExists(provider: string, model: string): Promise<boolean>
  /** Subscribe to a sidecar notification by exact event name (bridge hub). */
  subscribeNotification(method: string, handler: (params: object) => void): () => void
}

/**
 * The AI exec connection id of one asset — mirrors the Rust side
 * `starhub_domain_ssh::tools::ai_conn_id` (`dsh:{asset_id}:ssh`), the session
 * `ensure_ssh_session` reuses for every tool call on this asset.
 * @param assetId - bound asset id.
 * @returns the AI exec connection id.
 */
export function aiConnId(assetId: string): string {
  return `dsh:${assetId}:ssh`
}

/** sidecar 精确事件名:连接验证卡三类(MFA / 堡垒机 / 主机密钥)。 */
const CONN_EVENT_METHODS: readonly string[] = [
  'kb-interactive',
  'mfa-connected',
  'bastion-select',
  'bastion-output',
  'bastion-done',
  'hostkey-confirm',
]

/**
 * Translate one sidecar connection notification into a panel frame.
 *
 * Payload shapes mirror the sidecar emissions (`session.rs` / `auth.rs`):
 * kb-interactive `{sessionId, instructions, prompts, autoFill}`, bastion-select
 * `{sessionId}`, bastion-output the raw byte array, bastion-done unit,
 * mfa-connected the session id string, hostkey-confirm
 * `{hostname, port, remote, keyType, sha256}`.
 * @param name - event kind without the `ssh:` prefix and `:<connId>` suffix.
 * @param connId - AI exec connection id the event belongs to.
 * @param params - raw notification payload.
 * @returns the frame, or null for an unknown kind / unusable payload.
 */
export function connFrame(name: string, connId: string, params: object): AssistantFrame | null {
  const record = params as Record<string, unknown>
  switch (name) {
    case 'kb-interactive': {
      const prompts = Array.isArray(record.prompts) ? record.prompts : []
      return {
        t: 'kb-interactive',
        connId,
        instructions: typeof record.instructions === 'string' ? record.instructions : '',
        prompts: prompts.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return []
          const prompt = entry as Record<string, unknown>
          return typeof prompt.prompt === 'string' && typeof prompt.echo === 'boolean'
            ? [{ prompt: prompt.prompt, echo: prompt.echo }]
            : []
        }),
        autoFill: Array.isArray(record.autoFill)
          ? record.autoFill.map(entry => (typeof entry === 'string' ? entry : null))
          : [],
      }
    }
    case 'mfa-connected':
      return { t: 'mfa-connected', connId }
    case 'bastion-select':
      return { t: 'bastion-select', connId }
    case 'bastion-output':
      return { t: 'bastion-output', connId, bytes: Array.isArray(params) ? params as number[] : [] }
    case 'bastion-done':
      return { t: 'bastion-done', connId }
    case 'hostkey-confirm':
      return typeof record.hostname === 'string'
        ? {
          t: 'hostkey',
          connId,
          hostname: record.hostname,
          port: typeof record.port === 'number' ? record.port : 22,
          remote: typeof record.remote === 'string' ? record.remote : record.hostname,
          keyType: typeof record.keyType === 'string' ? record.keyType : 'unknown',
          sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
        }
        : null
    default:
      return null
  }
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
      // 打上 StarHub 自有 cwd:无 cwd 的会话拼不出 {{cwd}} 段(回合在第 1 步
      // 静默失败、面板无响应),且被会话列表按 not-found 拒绝。
      meta: { cwd: this.host.sessionCwd },
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
    // 钉住显示名:会话列表里显示纯服务器名(user 来源同时压住自动标题)。
    this.host.renameSession(assistantId, request.assetName)
    await this.host.bindAsset(request.assetId, assistantId)
    const connId = aiConnId(request.assetId)
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
      connId,
      pendingConnCard: null,
      notificationOffs: [],
    }
    this.bySsh.set(request.sshSessionId, entry)
    this.byAssistant.set(assistantId, entry)
    this.subscribeConnEvents(entry)
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
    entry.pendingConnCard = null
    for (const off of entry.notificationOffs) off()
    entry.notificationOffs.length = 0
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
   * status, the model route, and any approval or connection card still open.
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
    if (entry.pendingConnCard !== null) write(entry.pendingConnCard)
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

  /**
   * Subscribe the entry to its asset's AI-exec connection-card events.
   *
   * The sidecar emits both a generic and a precise event per verification
   * step; the precise names carry the AI exec connection id, so one
   * subscription set per assistant routes exactly this asset's MFA /
   * bastion / hostkey prompts to this panel. The shell card keeps serving
   * every other AI exec session.
   * @param entry - the assistant entry to wire.
   */
  private subscribeConnEvents(entry: AssistantEntry): void {
    for (const name of CONN_EVENT_METHODS) {
      const off = this.host.subscribeNotification(`ssh:${name}:${entry.connId}`, (params) => {
        this.onConnEvent(entry, name, params)
      })
      entry.notificationOffs.push(off)
    }
  }

  /**
   * Translate one sidecar connection event into a panel frame.
   * @param entry - owning assistant entry.
   * @param name - event kind (`kb-interactive` / `kb-connected` /
   *   `bastion-select` / `bastion-output` / `bastion-done` / `hostkey`).
   * @param params - raw notification payload.
   */
  private onConnEvent(entry: AssistantEntry, name: string, params: object): void {
    const frame = connFrame(name, entry.connId, params)
    if (frame === null) return
    // 结束类事件清掉挂起的卡;请求类事件记为待重推(晚到客户端补发)。
    if (frame.t === 'bastion-done' || frame.t === 'mfa-connected') entry.pendingConnCard = null
    else entry.pendingConnCard = frame
    for (const write of entry.clients) write(frame)
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

  /**
   * AI exec connection ids whose assistant panel currently has live clients.
   * The shell connection card consults this to suppress cards the assistant
   * panel already owns (one verification, one card).
   * @returns the connection ids with at least one attached panel client.
   */
  activeConns(): string[] {
    return [...this.byAssistant.values()]
      .filter(entry => entry.clients.size > 0)
      .map(entry => entry.connId)
  }

  /** Dispose every live assistant (plugin unload). */
  async disposeAll(): Promise<void> {
    const entries = [...this.byAssistant.values()]
    for (const entry of entries) {
      this.forget(entry)
      for (const settle of entry.approvals.values()) settle('cancelled')
      entry.approvals.clear()
      entry.pendingApproval = null
      entry.pendingConnCard = null
      for (const off of entry.notificationOffs) off()
      entry.notificationOffs.length = 0
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
