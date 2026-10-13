# @deepseek-ai/dsh-starhub-ssh-assistant

StarHub SSH AI assistant (StarHub-local package, not upstream): one agent-scoped session per SSH terminal page that operates the bound server, reusing the deployment's model connection.

## What it does

- **One assistant per terminal page.** `open` keys on the terminal page's own SSH session id; reopening the page reuses the live agent, closing the page disposes it.
- **Model connection reuse.** The agent is created with the deployment default route (`agentDefaultModel` — the provider/key/model configured in dsh settings). The panel can switch provider/model per assistant (`POST .../model`, applied on the next request through the `agent/request` waterfall).
- **Scoped tool surface.** Inside the agent's creation window the registry restricts tools to this asset's eight SSH/SFTP tools (`ssh_exec`, `ssh_exec_background`, `ssh_wait_task`, `ssh_session_status`, `sftp_list`, `sftp_stat`, `sftp_upload`, `sftp_download`) and binds the session to the asset through the bridge (`starhub/bind.asset`). The sidecar resolves the asset from the binding and reuses the asset's shared AI exec connection — the same server and credentials as the interactive terminal, over a separate exec channel. Local shell, databases, browsers, and other servers are invisible to the assistant.
- **Approvals in the panel.** Risky/write commands still pass through `starhub-approval-bridge`'s risk gate (read-only auto-allowed). An ask for an assistant session is parked on the assistant's SSE stream and settled by the panel (`allowed-once` / `rejected`); with no panel client attached the ask delegates back down the waterfall (the shell's own approval UI is unaffected).
- **Event-sourced rendering.** The stream forwards the session log verbatim (`user/message`, `assistant/message`, `tool/call`, `tool/result`, turn/step boundaries) plus `status`, `model`, `approval`, and `closed` frames.

## Routes (same-origin, under the dsh web server)

| Route | Purpose |
|---|---|
| `POST /starhub/api/assistant/open` | `{sshSessionId, assetId, assetName}` → `{assistantId, provider, model, reused}` |
| `POST /starhub/api/assistant/prompt` | `{assistantId, text}` — queues one follow-up turn |
| `POST /starhub/api/assistant/stop` | `{assistantId}` — aborts the active turn |
| `POST /starhub/api/assistant/close` | `{assistantId}` — disposes agent + session |
| `POST /starhub/api/assistant/model` | `{assistantId, provider, model}` — per-assistant route override |
| `POST /starhub/api/assistant/approval` | `{assistantId, requestId, outcome}` — settles a parked approval |
| `GET /starhub/api/assistant/models` | provider/model catalog for the panel picker |
| `GET /starhub/api/assistant/stream?assistantId=` | SSE frame stream |

## Model Experience

- Each assistant adds one root agent session per open SSH terminal page. Sessions live in the dsh session store (visible in the shell's session list) and are disposed when the page closes or the plugin unloads.
- The persona section (`starhub-ssh-assistant`, order 5) is registered inside the agent scope only; the deployment's system prompt is unchanged for every other agent.
- The tool restriction is an allow-list intersection: the assistant sees exactly the eight SSH/SFTP tools and nothing else — no local `bash`/`fs` tools, no database, browser, Android, or subagent tools.
- Requests use the deployment default provider/model unless the panel overrides the route; an override drops a stale reasoning effort so the new model resolves its own default.
- Approval asks are logged on the assistant session by `dsh-user-approval` as usual; the panel is one answerer in the waterfall, not a policy owner.

## Composition

Requires `agents`, `webServer`, `tools` (service names) and, at assistant-open time, the `sdk-transport` service (`starhub-bridge`) plus a configured default model. Wired into `examples/starhub-desktop/cordis.patch.yml` and `scripts/provision-dsh.mjs` (`STARHUB_PACKAGES`).

## Known Limitations and Deferred Work

- MFA/bastion assets surface their verification and machine-selection cards in the shell (the sidecar event has no in-panel card yet); the assistant turn waits for the user there.
- The model picker lists registered provider routes only; routes configured but not registered (no credential) do not appear.
- One assistant per terminal page: two pages on the same asset run two independent assistant sessions.
