// @vitest-environment jsdom
/**
 * 壳内工作台页簿(去 Tauri 化 M2 第 6 步):开页 / 同 key 聚焦 / 激活 / 关页
 * 的语义。页簿是「按 key 开窗/聚焦」的壳内替代——同 key 重复 open 不开第二份
 * (与 sidecar 侧 starhub/open.asset 的 open→focus 预判同语义),关掉当前页时
 * 激活余下页里最后开的一页,关未知 key 幂等。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchPanelStore, type WorkbenchPage } from '../src/client/workbench-panel.ts'

function page(key: string, title = key): WorkbenchPage {
  return { key, title, url: `/starhub-react/index.html?asset=${key}` }
}

describe('workbench panel store', () => {
  it('opens a page and activates it', () => {
    const store = createWorkbenchPanelStore()
    store.open(page('a1', '验收机'))
    const state = store.source.getSnapshot()
    expect(state.pages.map((p) => p.key)).toEqual(['a1'])
    expect(state.activeKey).toBe('a1')
  })

  it('focuses an already-open key instead of opening a second page', () => {
    const store = createWorkbenchPanelStore()
    store.open(page('a1', '旧名'))
    store.open(page('a2'))
    store.open(page('a1', '新名'))
    const state = store.source.getSnapshot()
    expect(state.pages.map((p) => p.key)).toEqual(['a1', 'a2'], '不开第二份')
    expect(state.activeKey).toBe('a1', '重复 open = 聚焦')
    // 标题/URL 以最新一次为准(资产可能被改名)
    expect(state.pages[0].title).toBe('新名')
  })

  it('activateIfOpen reports whether the key is open', () => {
    const store = createWorkbenchPanelStore()
    store.open(page('a1'))
    store.open(page('a2'))
    expect(store.activateIfOpen('a1')).toBe(true)
    expect(store.source.getSnapshot().activeKey).toBe('a1')
    expect(store.activateIfOpen('ghost')).toBe(false)
    expect(store.source.getSnapshot().activeKey).toBe('a1', '未开的 key 不改当前页')
  })

  it('closing the active page activates the last remaining page', () => {
    const store = createWorkbenchPanelStore()
    store.open(page('a1'))
    store.open(page('a2'))
    store.open(page('a3'))
    store.close('a3')
    let state = store.source.getSnapshot()
    expect(state.pages.map((p) => p.key)).toEqual(['a1', 'a2'])
    expect(state.activeKey).toBe('a2', '关当前页 → 余下最后开的一页')
    // 关非当前页:当前页不动
    store.close('a1')
    state = store.source.getSnapshot()
    expect(state.pages.map((p) => p.key)).toEqual(['a2'])
    expect(state.activeKey).toBe('a2')
  })

  it('closing the last page empties the book (panel falls back)', () => {
    const store = createWorkbenchPanelStore()
    store.open(page('a1'))
    store.close('a1')
    const state = store.source.getSnapshot()
    expect(state.pages).toEqual([])
    expect(state.activeKey).toBeNull()
  })

  it('closing an unknown key is a no-op', () => {
    const store = createWorkbenchPanelStore()
    store.open(page('a1'))
    store.close('ghost')
    const state = store.source.getSnapshot()
    expect(state.pages.map((p) => p.key)).toEqual(['a1'])
    expect(state.activeKey).toBe('a1')
  })

  it('notifies subscribers on every change', () => {
    const store = createWorkbenchPanelStore()
    const seen: number[] = []
    const unsubscribe = store.source.subscribe(() => {
      seen.push(store.source.getSnapshot().pages.length)
    })
    store.open(page('a1'))
    store.open(page('a2'))
    store.close('a1')
    unsubscribe()
    store.open(page('a3'))
    expect(seen).toEqual([1, 2, 1])
  })
})
