/**
 * Docker service for the shell-native Docker workbench.
 *
 * Thin wrapper over the StarHub Rust `docker_*` commands via the top-frame
 * Tauri IPC bridge (same pattern as `terminal/sftp-service.ts`). Mirrors the
 * Vue `src/services/docker.ts` contract so switching callers is zero-logic.
 * All commands target a connection id (`connId`) produced by `dockerConnect`.
 *
 * @module StarHub Docker service (client)
 */
import { tauriInvoke } from '../tauri.ts'

/** Docker connection request parameters (serde `DockerConnectParams`). */
export interface DockerConnectParams {
  host?: string
  apiVersion?: string
  transport?: 'socket' | 'tcp' | 'ssh'
  socketPath?: string
  /** SSH channel fields when `transport === 'ssh'` (unix-over-nc). */
  ssh?: {
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    passphrase?: string
    knownHostKey: string
    jumpHost?: string
    jumpPort?: number
    jumpUsername?: string
    jumpPassword?: string
    jumpPrivateKey?: string
    jumpPassphrase?: string
    jumpKnownHostKey?: string
    protocol: 'unix-over-nc' | 'unix-over-nc-sudo'
  }
}

/** Docker connection info returned by `dockerConnect`. */
export interface DockerConnectionInfo {
  connId: string
  host: string
}

/** One container list row (serde `ContainerInfo`). */
export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  created: number
  ports: { private: number; public?: number; type: string }[]
  labels: Record<string, string>
}

/** One image list row (serde `ImageInfo`). */
export interface ImageInfo {
  id: string
  tags: string[]
  size: number
  created: number
  digest?: string
}

/** Container resource statistics (serde `ContainerStats`). */
export interface ContainerStats {
  cpuPercent: number
  memoryUsage: number
  memoryLimit: number
  memoryPercent: number
  netRx: number
  netTx: number
  blockRead: number
  blockWrite: number
  pids: number
}

/** One container log line (serde `LogEntry`). */
export interface LogEntry {
  timestamp: string
  stream: string
  message: string
}

/** Result of a one-shot `dockerExec`. */
export interface DockerExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Result of creating a persistent interactive exec session. */
export interface DockerExecSessionStartResult {
  sessionId: string
}

/** One long-poll read from an interactive exec session. */
export interface DockerExecSessionReadResult {
  data: string
  running: boolean
  exitCode?: number
  error?: string
}

/** Connect to a Docker daemon; returns the connection id.
 * @param params - the connection request parameters.
 * @returns the new connection info.
 */
export function dockerConnect(params: DockerConnectParams): Promise<DockerConnectionInfo> {
  return tauriInvoke<DockerConnectionInfo>('docker_connect', { params })
}

/** Test a Docker connection without persisting it.
 * @param params - the connection request parameters.
 * @returns the test outcome with ok flag, message, and optional elapsed time.
 */
export function dockerTest(params: DockerConnectParams): Promise<{ ok: boolean; message: string; elapsed_ms?: number }> {
  return tauriInvoke<{ ok: boolean; message: string; elapsed_ms?: number }>('docker_test', { params })
}

/** Disconnect and release a Docker connection.
 * @param connId - the connection id to release.
 */
export function dockerDisconnect(connId: string): Promise<void> {
  return tauriInvoke<void>('docker_disconnect', { connId })
}

/** List containers (all = include exited/stopped).
 * @param connId - the connection id.
 * @param all - include stopped containers when true.
 * @returns the container list.
 */
export function dockerListContainers(connId: string, all?: boolean): Promise<ContainerInfo[]> {
  return tauriInvoke<ContainerInfo[]>('docker_list_containers', { connId, all })
}

/** Inspect one container's full metadata.
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @returns the container metadata object.
 */
export function dockerInspectContainer(connId: string, containerId: string): Promise<Record<string, unknown>> {
  return tauriInvoke<Record<string, unknown>>('docker_inspect_container', { connId, containerId })
}

/** Start a container.
 * @param connId - the connection id.
 * @param containerId - the container id.
 */
export function dockerStartContainer(connId: string, containerId: string): Promise<void> {
  return tauriInvoke<void>('docker_start_container', { connId, containerId })
}

/** Stop a container (after an optional timeout).
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @param timeout - optional stop timeout in seconds.
 */
export function dockerStopContainer(connId: string, containerId: string, timeout?: number): Promise<void> {
  return tauriInvoke<void>('docker_stop_container', { connId, containerId, timeout })
}

/** Restart a container (after an optional timeout).
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @param timeout - optional restart timeout in seconds.
 */
export function dockerRestartContainer(connId: string, containerId: string, timeout?: number): Promise<void> {
  return tauriInvoke<void>('docker_restart_container', { connId, containerId, timeout })
}

/** Remove a container (optionally forcing).
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @param force - force removal when true.
 */
export function dockerRemoveContainer(connId: string, containerId: string, force?: boolean): Promise<void> {
  return tauriInvoke<void>('docker_remove_container', { connId, containerId, force })
}

/** Read a container's recent logs.
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @param tail - optional tail line count string.
 * @returns the log entries.
 */
export function dockerContainerLogs(connId: string, containerId: string, tail?: string): Promise<LogEntry[]> {
  return tauriInvoke<LogEntry[]>('docker_container_logs', { connId, containerId, tail })
}

/** Read a container's live stats snapshot.
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @returns the stats snapshot.
 */
export function dockerContainerStats(connId: string, containerId: string): Promise<ContainerStats> {
  return tauriInvoke<ContainerStats>('docker_container_stats', { connId, containerId })
}

/** List images.
 * @param connId - the connection id.
 * @param all - include intermediate images when true.
 * @returns the image list.
 */
export function dockerListImages(connId: string, all?: boolean): Promise<ImageInfo[]> {
  return tauriInvoke<ImageInfo[]>('docker_list_images', { connId, all })
}

/** Pull an image by name.
 * @param connId - the connection id.
 * @param imageName - the image name to pull.
 * @returns the pull result message.
 */
export function dockerPullImage(connId: string, imageName: string): Promise<{ result: string }> {
  return tauriInvoke<{ result: string }>('docker_pull_image', { connId, imageName })
}

/** Remove an image (optionally forcing).
 * @param connId - the connection id.
 * @param imageId - the image id.
 * @param force - force removal when true.
 */
export function dockerRemoveImage(connId: string, imageId: string, force?: boolean): Promise<void> {
  return tauriInvoke<void>('docker_remove_image', { connId, imageId, force })
}

/** Prune dangling images.
 * @param connId - the connection id.
 */
export function dockerPruneImages(connId: string): Promise<void> {
  return tauriInvoke<void>('docker_prune_images', { connId })
}

/** Run one command in a container non-interactively.
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @param command - the command argv to run.
 * @param options - optional workdir and timeout in seconds.
 * @returns the exec result with stdout, stderr, and exit code.
 */
export function dockerExec(
  connId: string,
  containerId: string,
  command: string[],
  options?: { workdir?: string; timeoutSec?: number },
): Promise<DockerExecResult> {
  return tauriInvoke<DockerExecResult>('docker_exec', {
    connId, containerId, command,
    ...(options?.workdir !== undefined ? { workdir: options.workdir } : {}),
    ...(options?.timeoutSec !== undefined ? { timeoutSec: options.timeoutSec } : {}),
  })
}

/** Start a persistent TTY exec session in a container.
 * @param connId - the connection id.
 * @param containerId - the container id.
 * @param cols - initial terminal columns (default 120).
 * @param rows - initial terminal rows (default 30).
 * @returns the new exec session id.
 */
export function dockerExecSessionStart(connId: string, containerId: string, cols = 120, rows = 30): Promise<DockerExecSessionStartResult> {
  return tauriInvoke<DockerExecSessionStartResult>('docker_exec_session_start', { connId, containerId, cols, rows })
}

/** Long-poll one batch of output bytes (base64) from an exec session.
 * @param connId - the connection id.
 * @param sessionId - the exec session id.
 * @param waitMs - long-poll wait in milliseconds (default 1000).
 * @returns the read batch and whether the session is still running.
 */
export function dockerExecSessionRead(connId: string, sessionId: string, waitMs = 1000): Promise<DockerExecSessionReadResult> {
  return tauriInvoke<DockerExecSessionReadResult>('docker_exec_session_read', { connId, sessionId, waitMs })
}

/** Write raw input bytes to an exec session (xterm data).
 * @param connId - the connection id.
 * @param sessionId - the exec session id.
 * @param data - the raw input text to write.
 */
export function dockerExecSessionWrite(connId: string, sessionId: string, data: string): Promise<void> {
  return tauriInvoke<void>('docker_exec_session_write', { connId, sessionId, data })
}

/** Resize an exec session's TTY.
 * @param connId - the connection id.
 * @param sessionId - the exec session id.
 * @param cols - new terminal columns.
 * @param rows - new terminal rows.
 */
export function dockerExecSessionResize(connId: string, sessionId: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke<void>('docker_exec_session_resize', { connId, sessionId, cols, rows })
}

/** Close an exec session.
 * @param connId - the connection id.
 * @param sessionId - the exec session id.
 */
export function dockerExecSessionClose(connId: string, sessionId: string): Promise<void> {
  return tauriInvoke<void>('docker_exec_session_close', { connId, sessionId })
}

/** Pick a daemon API base from a connect response host string (diagnostic).
 * @param host - the connect response host string.
 * @returns the daemon label (docker when empty).
 */
export function daemonLabel(host: string): string {
  return host === '' ? 'docker' : host
}

/** Format a byte count as a human-readable string (0 B / KB / MB / GB / TB).
 * @param bytes - the byte count to format.
 * @returns the human-readable size string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Decode a base64 string from an exec session read into text.
 * @param data - the base64-encoded string.
 * @returns the decoded text (or the raw input when decoding fails).
 */
export function decodeExecOutput(data: string): string {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return data
  }
}
