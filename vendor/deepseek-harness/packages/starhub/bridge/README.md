# starhub-bridge

StarHub sidecar bridge (StarHub-local package, not upstream). It owns the tool-plane endpoint of the drop-Tauri migration: the plugin spawns the Go and Rust sidecars, speaks newline-delimited JSON-RPC 2.0 over their stdio (byte-compatible with `JsonRpcLineTransport`), and registers the sidecar method surface as dsh model tools.

## Config

| Field | Default | Meaning |
|---|---|---|
| `sidecarCommand` | `["starhub-sidecar-rust"]` | Executable plus arguments for the Rust sidecar; PATH-resolved when bare. The Go sidecar joins in a later M1 commit. |
| `healthTimeoutMs` | `10000` | Budget for the startup `ping` probe. A sidecar that misses it fails plugin initialization (fail loud); every downstream tool would fail the same way. |

## Semantics

- **Process lifetime.** Spawn on plugin init, kill on dispose (stdin end → SIGTERM → SIGKILL after a 2s grace). The child's bounded stderr tail rides the health-probe error message.
- **Protocol.** Requests get exactly one response; sidecar notifications (domain events, exec progress) are consumed by the transport's notification handler; malformed lines never kill either side. Error codes: `-32601` unknown method, `-32602` invalid params, `-32603` handler failure.
- **Tools.** `starhub_sidecar_status` reports liveness plus the live method inventory. Domain tools (`ssh_*`, `db_query`, `browser_*`, …) register as they are extracted per `docs/去Tauri化-M1-命令映射清单.md`; the `starhub/tool.execute` compatibility layer that `starhub-tools` speaks today lands in a later M1 commit, keeping the nine plugins' TypeScript surface unchanged.

## Model Experience

The bridge itself contributes one model-visible tool, `starhub_sidecar_status` (no parameters, text output). It reads no session state and writes none. Every domain tool registered later carries the same model-visible contract as its retired Tauri command: identical name, identical parameter schema, identical result text format — the text format is a contract and must not drift.

## Known Limitations and Deferred Work

- The live-view frame channel (browser/Android/desktop 直播面板) is not wired yet; `webServer.registerUpgrade` is the planned seat, zero vendor changes.
- Excel tools (`excel_*`, 24) stay on the frontend workbook and will forward through the workbench panel channel instead of this bridge.
- `sidecarCommand` names a single Rust binary today; per-domain binaries remain an option if isolation demands it.
