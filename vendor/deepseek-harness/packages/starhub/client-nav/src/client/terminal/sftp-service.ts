/**
 * SFTP service for the shell-native SSH/SFTP overlay.
 *
 * Thin wrapper over the StarHub Rust `sftp_*` commands via the top-frame Tauri
 * IPC bridge (same pattern as `tauri.ts`). Mirrors the Vue `src/services/sftp.ts`
 * contract so switching callers is zero-logic. All commands share the SSH
 * session id: SFTP reuses the terminal's live session (`ensure_session` opens
 * the SFTP channel on it), which is why SSH terminal and SFTP live together.
 *
 * @module StarHub SFTP service (client)
 */
import { tauriInvoke } from '../tauri.ts'

/** One remote file/directory entry (serde `SftpEntry`). */
export interface SftpEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified?: number
  permissions: number
  uid?: number
  gid?: number
}

/** How the SFTP subsystem was launched (diagnostic only). */
export interface SftpLaunchInfo {
  mode: 'subsystem' | 'fallback_exec' | 'custom_exec'
  server_path?: string | null
  diagnostic?: string | null
}

/** One file inside a transfer task. */
export interface TransferFile {
  name: string
  size: number
  transferred: number
}

/** Transfer direction for a streaming task. */
export type TransferDirection = 'upload' | 'download'
/** Lifecycle state of a transfer task. */
export type TransferStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

/** Full transfer task (mirror of Vue `TransferTask`). */
export interface TransferTask {
  id: string
  sessionId: string
  direction: TransferDirection
  files: TransferFile[]
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  error?: string | null
}

/** `sftp://transfer-status` payload (Rust `TransferStatusEvent`). */
export interface TransferStatusEvent {
  transferId: string
  sessionId: string
  direction: TransferDirection
  status: TransferStatus
  error?: string | null
}

/** `sftp://transfer-progress` payload (Rust `TransferProgress`). */
export interface TransferProgressEvent {
  transferId: string
  fileName: string
  transferred: number
  total: number
  direction: TransferDirection
}

/**
 * List a remote directory.
 * @param id - the SSH session id.
 * @param path - the remote directory path.
 * @returns the directory entries.
 */
export function sftpList(id: string, path: string): Promise<SftpEntry[]> {
  return tauriInvoke<SftpEntry[]>('sftp_list', { id, path })
}

/**
 * Stat a remote path.
 * @param id - the SSH session id.
 * @param path - the remote path.
 * @returns the entry metadata.
 */
export function sftpStat(id: string, path: string): Promise<SftpEntry> {
  return tauriInvoke<SftpEntry>('sftp_stat', { id, path })
}

/**
 * Remove a remote file or directory.
 * @param id - the SSH session id.
 * @param path - the remote path.
 */
export function sftpRemove(id: string, path: string): Promise<void> {
  return tauriInvoke<void>('sftp_remove', { id, path })
}

/**
 * Make a remote directory.
 * @param id - the SSH session id.
 * @param path - the remote directory path.
 */
export function sftpMkdir(id: string, path: string): Promise<void> {
  return tauriInvoke<void>('sftp_mkdir', { id, path })
}

/**
 * Rename/move a remote path.
 * @param id - the SSH session id.
 * @param from - the source remote path.
 * @param to - the destination remote path.
 */
export function sftpRename(id: string, from: string, to: string): Promise<void> {
  return tauriInvoke<void>('sftp_rename', { id, from, to })
}

/**
 * Ensure the SFTP subsystem channel is open on the live session.
 * @param id - the SSH session id.
 * @returns launch info for diagnostics, or null when unavailable.
 */
export function sftpEnsureSession(id: string): Promise<SftpLaunchInfo | null> {
  return tauriInvoke<SftpLaunchInfo | null>('sftp_ensure_session', { id })
}

/**
 * Start a streaming upload; resolves with the transfer id.
 * @param id - the SSH session id.
 * @param localPaths - the local files to upload.
 * @param remoteDir - the destination remote directory.
 * @param speedLimit - optional per-transfer byte/s limit (0 = unlimited).
 * @returns the transfer id.
 */
export function sftpStartUpload(id: string, localPaths: string[], remoteDir: string, speedLimit = 0): Promise<string> {
  return tauriInvoke<string>('sftp_start_upload', { id, localPaths, remoteDir, speedLimit })
}

/**
 * Start a streaming download; resolves with the transfer id.
 * @param id - the SSH session id.
 * @param remotePaths - the remote files to download.
 * @param localDir - the destination local directory.
 * @param speedLimit - optional per-transfer byte/s limit (0 = unlimited).
 * @returns the transfer id.
 */
export function sftpStartDownload(id: string, remotePaths: string[], localDir: string, speedLimit = 0): Promise<string> {
  return tauriInvoke<string>('sftp_start_download', { id, remotePaths, localDir, speedLimit })
}

/**
 * Cancel a transfer (running or paused).
 * @param id - the SSH session id.
 * @param transferId - the transfer task id.
 */
export function sftpCancelTransfer(id: string, transferId: string): Promise<void> {
  return tauriInvoke<void>('sftp_cancel_transfer', { id, transferId })
}

/**
 * Pause a running transfer (keeps the resume offset).
 * @param id - the SSH session id.
 * @param transferId - the transfer task id.
 */
export function sftpPauseTransfer(id: string, transferId: string): Promise<void> {
  return tauriInvoke<void>('sftp_pause_transfer', { id, transferId })
}

/**
 * Resume a paused transfer from its offset.
 * @param id - the SSH session id.
 * @param transferId - the transfer task id.
 */
export function sftpResumeTransfer(id: string, transferId: string): Promise<void> {
  return tauriInvoke<void>('sftp_resume_transfer', { id, transferId })
}

/**
 * Retry a failed/cancelled transfer.
 * @param id - the SSH session id.
 * @param transferId - the transfer task id.
 * @returns the new transfer id.
 */
export function sftpRetryTransfer(id: string, transferId: string): Promise<string> {
  return tauriInvoke<string>('sftp_retry_transfer', { id, transferId })
}

/**
 * List all transfer tasks for a session.
 * @param id - the SSH session id.
 * @returns the session's transfer tasks.
 */
export function sftpListTransfers(id: string): Promise<TransferTask[]> {
  return tauriInvoke<TransferTask[]>('sftp_list_transfers', { id })
}

/**
 * Join a parent dir + name into a remote path.
 * @param parent - the parent directory path.
 * @param name - the entry name to append.
 * @returns the joined path.
 */
export function joinPath(parent: string, name: string): string {
  if (parent === '/' || parent === '') return `/${name}`
  if (parent.endsWith('/')) return `${parent}${name}`
  return `${parent}/${name}`
}

/**
 * Return the parent dir path (root stays `/`).
 * @param path - the remote path.
 * @returns the parent directory path.
 */
export function parentPath(path: string): string {
  if (!path || path === '/') return '/'
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

/**
 * Format a byte count as a human-readable string.
 * @param bytes - the byte count.
 * @returns the formatted size string.
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
