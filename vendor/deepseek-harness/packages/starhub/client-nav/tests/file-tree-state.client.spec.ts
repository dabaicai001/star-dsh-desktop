// @vitest-environment jsdom
/**
 * file-tree 状态桥:裸 source + open/close 回调——open 置位、close 复位,
 * 快照身份在两次变更间保持稳定。
 */
import { describe, expect, it } from 'vitest'
import { createFileTreeBridge } from '../src/client/file-tree/state.ts'

describe('createFileTreeBridge', () => {
  it('starts closed and toggles via open/close', () => {
    const bridge = createFileTreeBridge()
    expect(bridge.source.getSnapshot()).toEqual({ open: false })
    bridge.open()
    expect(bridge.source.getSnapshot()).toEqual({ open: true })
    bridge.close()
    expect(bridge.source.getSnapshot()).toEqual({ open: false })
  })

  it('keeps the snapshot reference stable between changes', () => {
    const bridge = createFileTreeBridge()
    const first = bridge.source.getSnapshot()
    expect(bridge.source.getSnapshot()).toBe(first)
    bridge.open()
    const second = bridge.source.getSnapshot()
    expect(second).toEqual({ open: true })
    expect(second).not.toBe(first)
    expect(bridge.source.getSnapshot()).toBe(second)
  })

  it('notifies subscribers on state change', () => {
    const bridge = createFileTreeBridge()
    const seen: Array<{ open: boolean }> = []
    const off = bridge.source.subscribe(() => { seen.push(bridge.source.getSnapshot()) })
    bridge.open()
    bridge.close()
    off()
    expect(seen).toEqual([{ open: true }, { open: false }])
  })
})
