/**
 * Redis key 树:把扁平 SCAN 结果按分隔符(默认 ':')组装成文件夹树,与
 * Another Redis Desktop Manager / RedisInsight 的键浏览交互同构。
 * 纯函数 + 递归渲染组件分离:树构建可单测,渲染层只负责展开态与回调。
 */
import type { RedisKeyInfo } from './redis-service.ts'

/** 树节点:文件夹(children 非空)或叶子(keyInfo 携带完整 key)。 */
export interface KeyTreeNode {
  /** 展示名(路径最后一段)。 */
  name: string
  /** 根到本节点的完整路径(文件夹如 'user:1001';叶子即完整 key)。 */
  path: string
  /** 叶子节点对应的 key 信息;文件夹为 null。 */
  keyInfo: RedisKeyInfo | null
  /** 子节点(文件夹优先,再按名称排序)。 */
  children: KeyTreeNode[]
}

/**
 * 把扁平 key 列表组装成树。
 * @param keys - SCAN 一页的 key 列表。
 * @param separator - 层级分隔符,默认 ':'。
 * @returns 根层节点数组(文件夹优先、按名称排序)。
 */
export function buildKeyTree(keys: readonly RedisKeyInfo[], separator = ':'): KeyTreeNode[] {
  const root: KeyTreeNode[] = []
  /** path → 文件夹节点(快速找父)。 */
  const folders = new Map<string, KeyTreeNode>()
  const sorted = [...keys].sort((a, b) => a.key.localeCompare(b.key))
  for (const info of sorted) {
    const parts = info.key.split(separator)
    let siblings = root
    let prefix = ''
    // 逐段下钻:除最后一段外都落成文件夹(同名 key 与文件夹共存时,
    // 叶子按原名落进该文件夹——如 'a' 与 'a:b' 同时存在)。
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? ''
      prefix = prefix === '' ? seg : `${prefix}${separator}${seg}`
      let folder = folders.get(prefix)
      if (folder === undefined) {
        folder = { name: seg, path: prefix, keyInfo: null, children: [] }
        folders.set(prefix, folder)
        siblings.push(folder)
      }
      siblings = folder.children
    }
    siblings.push({
      name: parts[parts.length - 1] ?? info.key,
      path: info.key,
      keyInfo: info,
      children: [],
    })
  }
  /** 文件夹优先 + 名称排序(递归)。 */
  const sortLevel = (nodes: KeyTreeNode[]): void => {
    nodes.sort((a, b) => {
      const af = a.keyInfo === null ? 0 : 1
      const bf = b.keyInfo === null ? 0 : 1
      return af !== bf ? af - bf : a.name.localeCompare(b.name)
    })
    for (const node of nodes) sortLevel(node.children)
  }
  sortLevel(root)
  return root
}

/**
 * 收集树中全部文件夹路径(默认全展开用)。
 * @param nodes - 树节点数组(通常是根层)。
 * @returns 全部文件夹路径集合。
 */
export function allFolderPaths(nodes: readonly KeyTreeNode[]): Set<string> {
  const out = new Set<string>()
  const walk = (list: readonly KeyTreeNode[]): void => {
    for (const node of list) {
      if (node.keyInfo === null) {
        out.add(node.path)
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return out
}

/**
 * 文件夹下的叶子(key)总数,用于文件夹行尾计数徽标。
 * @param node - 树节点(文件夹或叶子)。
 * @returns 叶子数量(叶子自身计为 1)。
 */
export function countLeaves(node: KeyTreeNode): number {
  if (node.keyInfo !== null) return 1
  return node.children.reduce((total, child) => total + countLeaves(child), 0)
}
