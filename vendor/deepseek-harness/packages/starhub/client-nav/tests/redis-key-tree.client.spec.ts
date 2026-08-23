/**
 * Redis 键树(key-tree.ts):扁平 SCAN 结果按 ':' 组装文件夹树——分组、
 * 文件夹优先排序、多层嵌套、同名 key 与文件夹共存、计数与路径收集。
 */
import { describe, expect, it } from 'vitest'
import { allFolderPaths, buildKeyTree, countLeaves, type KeyTreeNode } from '../src/client/redis/key-tree.ts'
import type { RedisKeyInfo } from '../src/client/redis/redis-service.ts'

const key = (k: string, type = 'string'): RedisKeyInfo => ({ key: k, type, ttl: -1 })

/** 收集一层节点的展示名(按渲染顺序)。 */
function names(nodes: readonly KeyTreeNode[]): string[] {
  return nodes.map(n => n.name)
}

describe('buildKeyTree', () => {
  it('groups keys by the ":" separator into nested folders', () => {
    const tree = buildKeyTree([key('user:1001:name'), key('user:1002:name'), key('sess:abc', 'hash'), key('plain')])
    expect(names(tree)).toEqual(['sess', 'user', 'plain'])
    const user = tree.find(n => n.name === 'user')
    expect(user?.keyInfo).toBeNull()
    expect(names(user?.children ?? [])).toEqual(['1001', '1002'])
    const leaf = user?.children[0]?.children[0]
    expect(leaf?.name).toBe('name')
    expect(leaf?.path).toBe('user:1001:name')
    expect(leaf?.keyInfo?.key).toBe('user:1001:name')
  })

  it('sorts folders before leaves and alphabetically within each group', () => {
    const tree = buildKeyTree([key('zz'), key('b:1'), key('aa'), key('a:1')])
    expect(names(tree)).toEqual(['a', 'b', 'aa', 'zz'])
  })

  it('keeps a leaf whose name collides with a folder (a and a:b coexist)', () => {
    const tree = buildKeyTree([key('a'), key('a:b')])
    const folder = tree.find(n => n.keyInfo === null)
    const leaf = tree.find(n => n.keyInfo !== null)
    expect(folder?.path).toBe('a')
    expect(leaf?.path).toBe('a')
    expect(folder?.children[0]?.path).toBe('a:b')
  })

  it('supports a custom separator', () => {
    const tree = buildKeyTree([key('user/1/name')], '/')
    expect(tree[0]?.name).toBe('user')
    expect(tree[0]?.children[0]?.children[0]?.name).toBe('name')
  })
})

describe('allFolderPaths / countLeaves', () => {
  it('collects every folder path recursively', () => {
    const tree = buildKeyTree([key('a:b:c'), key('a:d'), key('x')])
    expect([...allFolderPaths(tree)].sort()).toEqual(['a', 'a:b'])
  })

  it('counts leaf keys under a folder', () => {
    const tree = buildKeyTree([key('a:b:c'), key('a:b:d'), key('a:e'), key('x')])
    const a = tree.find(n => n.name === 'a')
    expect(countLeaves(a!)).toBe(3)
    expect(countLeaves(a!.children.find(n => n.name === 'b')!)).toBe(2)
  })
})
