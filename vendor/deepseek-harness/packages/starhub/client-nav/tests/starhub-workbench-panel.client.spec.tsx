// @vitest-environment jsdom
/**
 * 壳内工作台主面板(去 Tauri 化 M2 第 6 步):标签条一页一签(点签切换、× 关页),
 * 内容区是同源 iframe(承载 /starhub-react/ 独立程序)。无页时渲染 null;
 * 关页/切页都经注入回调,不在组件内持有状态。v0.130.0 起标签条左侧常驻
 * 「返回工具列表」出口(工作台不占侧栏行,页面开着时需要显式回路)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  StarHubWorkbenchPanel, type StarHubWorkbenchPanelProps,
} from '../src/client/StarHubWorkbenchPanel.tsx'
import { createWorkbenchPanelStore } from '../src/client/workbench-panel.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPanel() {
  const store = createWorkbenchPanelStore()
  const activated: string[] = []
  const closed: string[] = []
  const backToTools = vi.fn()
  const rerender = (): void => {
    view.rerender(<StarHubWorkbenchPanel {...props} />)
  }
  // 组件只消费 inject 面的四员(activatePage / closePage / backToTools /
  // useWorkbench);`PropsRuntime<'main'>` 是 SlotMap 派生 share,测试按
  // 「plain stubs for framework hooks」的 sanctioned 路径整体造型,不逐条
  // 复刻派生成员。
  const props = {
    activatePage: (key: string) => { activated.push(key); store.activateIfOpen(key); rerender() },
    closePage: (key: string) => { closed.push(key); store.close(key); rerender() },
    backToTools,
    useWorkbench: (selector: (state: never) => unknown) =>
      selector(store.source.getSnapshot() as never),
  } as unknown as StarHubWorkbenchPanelProps
  const view = render(<StarHubWorkbenchPanel {...props} />)
  return { store, activated, closed, backToTools, rerender, container: view.container }
}

describe('StarHubWorkbenchPanel', () => {
  it('renders nothing without an open page', () => {
    const { container } = renderPanel()
    expect(container.innerHTML).toBe('')
  })

  it('renders one tab per page and the active iframe', () => {
    const { store, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    store.open({ key: 'a2', title: 'MySQL', url: '/starhub-react/index.html?asset=a2' })
    rerender()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['验收机', 'MySQL'])
    const frame = screen.getByTitle('MySQL') as HTMLIFrameElement
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/starhub-react/index.html?asset=a2')
  })

  it('clicking a tab activates that page; the close button closes it', () => {
    const { store, activated, closed, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    store.open({ key: 'a2', title: 'MySQL', url: '/starhub-react/index.html?asset=a2' })
    rerender()

    fireEvent.click(screen.getAllByRole('tab')[0]!)
    expect(activated).toEqual(['a1'])
    expect((screen.getByTitle('验收机') as HTMLIFrameElement).getAttribute('src'))
      .toBe('/starhub-react/index.html?asset=a1')

    fireEvent.click(screen.getByRole('button', { name: '关闭 MySQL' }))
    expect(closed).toEqual(['a2'])
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['验收机'])
  })

  it('closing the last page empties the panel', () => {
    const { store, rerender, container } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    rerender()
    fireEvent.click(screen.getByRole('button', { name: '关闭 验收机' }))
    expect(container.innerHTML).toBe('')
  })

  it('back-to-tools button on the tab strip routes through the injected callback', () => {
    const { store, backToTools, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    rerender()
    fireEvent.click(screen.getByRole('button', { name: '返回工具列表' }))
    expect(backToTools).toHaveBeenCalledTimes(1)
  })
})
