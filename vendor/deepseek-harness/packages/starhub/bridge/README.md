# starhub-bridge

StarHub sidecar bridge (StarHub-local package, not upstream). It owns the tool-plane endpoint of the drop-Tauri migration: the plugin spawns the Rust sidecar, speaks newline-delimited JSON-RPC 2.0 over its stdio (byte-compatible with `JsonRpcLineTransport`), and exposes the sidecar method surface to the model through the `starhub/tool.execute` compatibility layer the nine StarHub plugins already speak.

## Config

| Field | Default | Meaning |
|---|---|---|
| `sidecarCommand` | `["starhub-sidecar-rust"]` | Executable plus arguments for the Rust sidecar; PATH-resolved when bare. |
| `healthTimeoutMs` | `10000` | Budget for the startup `ping` probe. A sidecar that misses it fails plugin initialization (fail loud); every downstream tool would fail the same way. |

## Semantics

- **Process lifetime.** Spawn on plugin init, kill on dispose (stdin end → SIGTERM → SIGKILL after a 2s grace). The child's bounded stderr tail rides the health-probe error message.
- **Protocol.** Requests get exactly one response; sidecar notifications (domain events, exec progress) are consumed by the transport's notification handler; malformed lines never kill either side. Error codes: `-32601` unknown method, `-32602` invalid params, `-32603` handler failure.
- **Compatibility layer** (`src/compat.ts`). The plugin provides the two private services the nine StarHub plugins read — `sdk-transport` and `sdk-notifications`, the same names the `sdk-jsonrpc-server` patch provided in the Tauri composition — so their TypeScript surface is unchanged:

  | bridge method | sidecar method | result |
  |---|---|---|
  | `starhub/tool.execute {sessionId,name,args}` | `name` with `args` | model-readable text (the `{text}` envelope is unwrapped) |
  | `starhub/bind.asset` | `bind_asset_context` | `{ok,action:"bound"}` |
  | `starhub/open.asset` / `starhub/focus.tool` | same names | `{ok,action:"opened"|"focused"}` |
  | `starhub/live.snapshot` | same name | live snapshot object |

  Only one of `starhub-bridge` / `sdk-jsonrpc-server` may be composed: providing the same service name twice fails loud at load. `starhub/approval.request` is deliberately unanswered — the approval answerer belongs to dsh's own approval UI (`starhub-approval-bridge` composes with `answerer: false`).
- **Notifications.** Every sidecar event arrives as one `starhub/domain-event` notification carrying `{event, payload}`; the dispatcher fans it out under the inner `event` name (`starhub/domain.event`, `starhub/registry.sync`, `ssh:exec-done`, `sftp://transfer-progress`, …), which is exactly what `starhub-domain-events` / `starhub-session-registry` subscribe to. Subscriber failures are isolated.
- **Tools.** `starhub_sidecar_status` reports liveness plus the live method inventory (bridge-only method `starhub/capabilities`). Every domain tool keeps the model-visible contract of its retired Tauri command: identical name, identical parameter schema, identical result text format — the text format is a contract and must not drift.
- **Workbench API** (`src/workbench.ts`). `POST /starhub/api/invoke` maps a command name to a sidecar method (`{ok:true,result}` / `{ok:false,error}`), and `GET /starhub/api/events` streams every sidecar notification as Server-Sent Events under its original event name. This is the seat that replaces `window.__TAURI_INTERNALS__.invoke` / `tauriListen` for the React workbench once it moves into the dsh GUI (M2); commands the sidecar does not implement answer `{ok:false,error}`, the same degradation a missing Tauri IPC produced.

## Model Experience

The bridge itself contributes one model-visible tool, `starhub_sidecar_status` (no parameters, text output). It reads no session state and writes none. Every domain tool routed through the compatibility layer carries the same model-visible contract as its retired Tauri command.

## Known Limitations and Deferred Work

- The live-view frame channel (browser/Android/desktop 直播面板) is not wired yet; `webServer.registerUpgrade` is the planned seat, zero vendor changes.
- Excel tools (`excel_*`, 24) were removed together with the capability: the React workbench has no workbook view, so the frontend executor they forwarded to no longer existed. See the CHANGELOG entry.
- `sidecarCommand` names a single Rust binary; per-domain binaries remain an option if isolation demands it.
