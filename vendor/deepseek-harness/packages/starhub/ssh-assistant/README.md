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
| `GET /starhub/api/assistant/active-conns` | AI exec conns with live panel clients (shell card suppression) |
| `GET /starhub/api/assistant/stream?assistantId=` | SSE frame stream |

## Connection cards (MFA / bastion / host key)

MFA/bastion assets need interactive verification before the AI exec connection
(`dsh:<assetId>:ssh`) can authenticate. The plugin subscribes to the sidecar's
precise events for that connection (`ssh:kb-interactive:<connId>`,
`ssh:mfa-connected:<connId>`, `ssh:bastion-select/output/done:<connId>`,
`ssh:hostkey-confirm:<connId>`) and forwards them as stream frames, so the
panel renders the verification card in place:

- **MFA / 2FA**: instructions plus one input per prompt; answers go back over
  the workbench invoke route (`ssh_kb_response`). A later round reuses the card.
- **Bastion**: the real bastion pty streams into an in-panel xterm
  (`ssh:bastion-output:<connId>` in, `ssh_write`/`ssh_resize` out); "执行 AI
  命令" sends the `__run__` sentinel (`ssh_bastion_response`) and stage 2
  proceeds. Cancel sends the empty selection.
- **Host key**: trust-and-persist / once / reject via `ssh_hostkey_response`.

While the panel has live stream clients, `active-conns` reports the connection
so the shell's own connection card suppresses its duplicate card; with no panel
client attached (or without this plugin) the shell card serves those prompts
exactly as before.

## Model Experience

- Each assistant adds one root agent session per open SSH terminal page. Sessions live in the dsh session store (visible in the shell's session list) and are disposed when the page closes or the plugin unloads.
- The persona section (`starhub-ssh-assistant`, order 5) is registered inside the agent scope only; the deployment's system prompt is unchanged for every other agent.
- The tool restriction is an allow-list intersection: the assistant sees exactly the eight SSH/SFTP tools and nothing else — no local `bash`/`fs` tools, no database, browser, Android, or subagent tools.
- Requests use the deployment default provider/model unless the panel overrides the route; an override drops a stale reasoning effort so the new model resolves its own default.
- Approval asks are logged on the assistant session by `dsh-user-approval` as usual; the panel is one answerer in the waterfall, not a policy owner.

## Composition

Requires `agents`, `webServer`, `tools` (service names) and, at assistant-open time, the `sdk-transport` service (`starhub-bridge`) plus a configured default model. Wired into `examples/starhub-desktop/cordis.patch.yml` and `scripts/provision-dsh.mjs` (`STARHUB_PACKAGES`).

## Known Limitations and Deferred Work

- The model picker lists registered provider routes only; routes configured but not registered (no credential) do not appear.
- One assistant per terminal page: two pages on the same asset run two independent assistant sessions.
- The panel's bastion terminal is a compact viewport (180px); a full-screen selection experience remains the shell card's strength for very tall menus.
