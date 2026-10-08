// Fake StarHub sidecar for bridge transport tests: speaks the same
// newline-delimited JSON-RPC 2.0 protocol as starhub-sidecar-rust.
// Pass --fail-health to hang on ping (health-probe failure test).
import { createInterface } from 'node:readline'

const failHealth = process.argv.includes('--fail-health')

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return // malformed: ignored per protocol contract
  }
  if (frame.jsonrpc !== '2.0' || frame.method === undefined || frame.id === undefined) return
  if (failHealth && frame.method === 'ping') return // hang: never answer
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  const fail = (id, code, message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  if (frame.method === 'ping') {
    reply(frame.id, { pong: true, protocol: 'fake-sidecar/1.0.0' })
    return
  }
  if (frame.method === 'starhub_list_capabilities') {
    reply(frame.id, { protocol: 'fake-sidecar/1.0.0', methods: ['ping', 'starhub_list_capabilities'] })
    return
  }
  fail(frame.id, -32601, `method not found: ${frame.method}`)
})
