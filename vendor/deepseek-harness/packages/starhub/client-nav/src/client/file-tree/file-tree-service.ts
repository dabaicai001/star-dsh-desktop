/**
 * 会话文件树的本机文件服务(2026-08-24):复用 Tauri `local_list_directory`
 * / `local_stat_path` / `local_read_text_file`(permissions/commands.toml 已
 * 授权)。浏览器预览(无 Tauri IPC)调用 reject,组件展示错误/预览态。
 */
import { tauriInvoke } from '../tauri.ts'

/** `local_list_directory` 的返回(serde camelCase)。 */
export interface LocalFileEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'file' | 'symlink' | 'other'
  readonly size: number
  readonly modifiedAt: number | null
  readonly readonly: boolean
  readonly hidden: boolean
}

/** `local_stat_path` 的返回(serde camelCase)。 */
export interface LocalPathInfo {
  readonly path: string
  readonly name: string
  readonly kind: 'directory' | 'file' | 'symlink' | 'other'
  readonly size: number
  readonly modifiedAt: number | null
  readonly readonly: boolean
}

/**
 * 列一个目录的内容(单次最多 500 项,失败抛错由组件转内联错误)。
 * @param path - 绝对目录路径。
 * @returns 条目列表(Rust 侧已按名称排序)。
 */
export function listLocalDirectory(path: string): Promise<LocalFileEntry[]> {
  return tauriInvoke<LocalFileEntry[]>('local_list_directory', { path })
}

/**
 * 取本机路径元数据,不读文件正文。
 * @param path - 绝对路径。
 * @returns 元信息;失败抛错。
 */
export function statLocalPath(path: string): Promise<LocalPathInfo> {
  return tauriInvoke<LocalPathInfo>('local_stat_path', { path })
}
