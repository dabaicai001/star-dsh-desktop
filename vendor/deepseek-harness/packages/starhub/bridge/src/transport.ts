/**
 * Sidecar transport: spawn the Rust/Go sidecar processes and speak the
 * newline-delimited JSON-RPC 2.0 protocol over their stdio.
 *
 * The framing matches `JsonRpcLineTransport` on the TypeScript side and the
 * sidecar's stdio loop on the Rust side; this module only owns process
 * lifetime (spawn, health probe, dispose), never protocol semantics.
 *
 * @module @deepseek-ai/dsh-starhub-bridge/transport
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

/** One spawned sidecar process with its transport and disposer. */
export interface SidecarHandle {
  /** JSON-RPC peer over the sidecar's stdio (concrete: notification-capable). */
  readonly transport: JsonRpcLineTransport
  /** The spawned child (retained for diagnostics and tests). */
  readonly child: ChildProcess
  /** Close the transport, kill the child, and await its exit. */
  dispose(): Promise<void>
}

/** Bare sidecar name used when nothing is shipped beside this module (PATH lookup). */
const BARE_SIDECAR_COMMAND = 'starhub-sidecar-rust'

/**
 * Absolute sidecar paths shipped beside this bridge module, nearest ancestor first.
 *
 * A bundle-installed bridge carries its own sidecar (`<plugin>/bridge/sidecar/…`),
 * and the Go sidecar must sit in that same directory because the Rust sidecar
 * resolves it as a sibling of its own executable. Ancestors are probed because
 * the built module sits at different depths in the tsdown and tsc layouts.
 * @returns candidate executable paths, or the bare name when none exists.
 */
function bundledSidecarCandidates(): string[] {
  const executable = process.platform === 'win32' ? `${BARE_SIDECAR_COMMAND}.exe` : BARE_SIDECAR_COMMAND
  const candidates: string[] = []
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth += 1) {
    candidates.push(join(dir, 'sidecar', executable), join(dir, executable))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return candidates
}

/** Default sidecar launch command: the bundled executable when present, else PATH. */
export const DEFAULT_SIDECAR_COMMAND: readonly string[] = (() => {
  const bundled = bundledSidecarCandidates().find(candidate => existsSync(candidate))
  return bundled === undefined ? [BARE_SIDECAR_COMMAND] : [bundled]
})()

/** Default health-probe budget after spawn. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 10_000

/**
 * Spawn one sidecar and probe it with `ping` before returning.
 *
 * Fails loud at plugin load: a sidecar that does not answer `ping` within
 * the budget is a misconfigured deployment, and every downstream tool would
 * fail the same way — better to reject the plugin initialization once.
 *
 * @param command - executable plus arguments (PATH-resolved when bare).
 * @param healthTimeoutMs - ping budget in milliseconds.
 * @returns the live handle; the caller owns disposal.
 */
export async function spawnSidecar(
  command: readonly string[] = DEFAULT_SIDECAR_COMMAND,
  healthTimeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<SidecarHandle> {
  const [executable, ...args] = command
  if (executable === undefined || executable === '') {
    throw new Error('starhub-bridge: sidecarCommand must name an executable')
  }
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    // Bounded tail: diagnostics only; the protocol never rides stderr.
    stderr.push(chunk.toString('utf8'))
    if (stderr.length > 64) stderr.shift()
  })
  const spawnError = await new Promise<Error | undefined>((resolve) => {
    const onError = (error: Error) => resolve(error)
    child.once('error', onError)
    child.once('spawn', () => {
      child.off('error', onError)
      resolve(undefined)
    })
  })
  if (spawnError !== undefined) {
    throw new Error(`starhub-bridge: sidecar spawn failed (${command.join(' ')}): ${spawnError.message}`)
  }

  const transport = new JsonRpcLineTransport(child.stdout!, child.stdin!)
  transport.start()
  try {
    await withTimeout(
      transport.request('ping', {}),
      healthTimeoutMs,
      `starhub-bridge: sidecar did not answer ping within ${String(healthTimeoutMs)}ms (${command.join(' ')})`,
    )
  } catch (error) {
    transport.close()
    child.kill()
    const tail = stderr.join('').trim()
    const detail = tail === '' ? '' : `; stderr tail: ${tail.slice(-400)}`
    throw new Error(`starhub-bridge: sidecar health probe failed: ${errorMessage(error)}${detail}`)
  }

  return {
    transport,
    child,
    async dispose() {
      transport.close()
      child.stdin?.end()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        child.once('exit', () => resolve())
        child.kill()
        // The sidecar exits on stdin EOF; force the edge after a grace period.
        setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2000).unref()
      })
    },
  }
}

/** Race a promise against a deadline, rejecting with the sidecar-labeled message. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Normalize unknown thrown values to a message string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
