/**
 * 文件树搜索服务(2026-08-24):封装 Tauri `local_search_files` ——文件名
 * 模糊匹配(mode=name)与文件内容检索(mode=content),后者额外返回匹配行。
 * 浏览器预览(无 Tauri IPC)调用 reject,组件展示错误/预览态。
 */
import { tauriInvoke } from '../tauri.ts'

/** `local_search_files` 的返回(serde camelCase)。 */
export interface LocalSearchHit {
  readonly path: string
  readonly name: string
  readonly kind: 'directory' | 'file' | 'symlink' | 'other'
  readonly size: number
  readonly modifiedAt: number | null
  /** 内容模式下首个匹配行的 1-based 行号;文件名模式为 null。 */
  readonly line: number | null
  /** 内容模式下匹配行的截断文本;文件名模式为 null。 */
  readonly snippet: string | null
}

/**
 * 在目录树中递归搜索文件。
 * @param root - 搜索根目录绝对路径。
 * @param query - 关键词(非空;前后空白被 Rust 侧裁剪)。
 * @param mode - `name` = 文件名模糊匹配;`content` = 文件内容检索。
 * @returns 按路径排序的命中列表。
 */
export function searchLocalFiles(
  root: string,
  query: string,
  mode: 'name' | 'content',
): Promise<LocalSearchHit[]> {
  return tauriInvoke<LocalSearchHit[]>('local_search_files', { root, query, mode })
}