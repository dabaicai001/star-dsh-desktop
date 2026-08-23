// @vitest-environment jsdom
/**
 * StarHubNav / StarHubOverlay(重构版):侧栏「工具」大类行 + 子类行(无
 * Excel/设置条目);overlay 现在只承载「新建/编辑连接」小对话框——打开
 * (新建/编辑两态)、Esc / 关闭钮 / postMessage「去设置添加」打开、异域
 * 消息忽略。资产实例页已改走新开独立窗口(见 starhub-apply 规格的
 * openAsset 用例),不再经 overlay iframe。设置五个 tab 各自直渲,见
 * settings-tabs 规格。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import {
  createAiChatOverlay, createConnectionManagerOverlay, createStarHubNavStore, createToolSelectionBridge,
  type ConnectionManagerState, type ToolSelection,
} from '../src/client/store.ts'
import { StarHubNav } from '../src/client/StarHubNav.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'

afterEach(cleanup)

/** Stable session-list snapshot (no current session) — getSnapshot must stay identity-stable for useSyncExternalStore. */
const emptySessionList = { current: undefined, ids: [] as string[], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
/** Stable workspace-list snapshot (no recent workspace). */
const emptyWorkspaceList = { recentWorkspaceId: undefined, ids: [] as string[], byId: {}, phase: 'ready', items: [] }

/** 组装 StarHubNav 的完整 props(store 实例 + 选择桥 + 框架席位 stub)。 */
function navProps() {
  const instance = createStarHubNavStore().create()
  const bridge = createToolSelectionBridge()
  return {
    bridge,
    wide: true,
    useStore: (<S,>(sel: (s: { categoryOpen: boolean }) => S) => sel(instance.getSnapshot())) as never,
    actions: instance.actions,
    selectSubcategory: vi.fn(),
    useSelection: (<S,>(sel: (s: ToolSelection) => S) => sel(bridge.source.getSnapshot())) as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
  }
}

/** 组装 StarHubOverlay 的完整 props(连接 + AI 聊天桥 + 框架席位 stub)。 */
function overlayProps() {
  const manager = createConnectionManagerOverlay()
  const aiChat = createAiChatOverlay()
  return {
    manager,
    aiChat,
    openConnectionManager: vi.fn(),
    closeConnectionManager: vi.fn(),
    closeAiChat: vi.fn(),
    refreshAssets: vi.fn(),
    sessions: {
      list: { getSnapshot: () => emptySessionList, subscribe: () => () => {} },
      binding: () => undefined,
      open: vi.fn(), clear: vi.fn(),
    } as never,
    workspaces: {
      list: { getSnapshot: () => emptyWorkspaceList, subscribe: () => () => {} },
      connectWorkspace: vi.fn(),
    } as never,
    useConnectionManager: (<S,>(sel: (s: ConnectionManagerState) => S) => sel(manager.source.getSnapshot())) as never,
    useAiChat: (<S,>(sel: (s: { open: boolean }) => S) => sel(aiChat.source.getSnapshot())) as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
  }
}

describe('StarHubNav', () => {
  it('renders the category row and the three subcategory rows (no Excel/设置 entries)', () => {
    const props = navProps()
    render(<StarHubNav {...props} />)
    expect(screen.getByTitle('工具')).toBeTruthy()
    expect(screen.getByTitle('终端')).toBeTruthy()
    expect(screen.getByTitle('数据库')).toBeTruthy()
    expect(screen.getByTitle('Docker')).toBeTruthy()
    expect(screen.queryByTitle('Excel')).toBeNull()
    expect(screen.queryByTitle('设置')).toBeNull()
  })

  it('toggles the category via the store action and collapses the subcategory rows', () => {
    const props = navProps()
    const view = render(<StarHubNav {...props} />)
    fireEvent.click(screen.getByTitle('工具'))
    view.rerender(<StarHubNav {...props} />)
    expect(screen.queryByTitle('终端')).toBeNull()
  })

  it('marks the active subcategory and forwards clicks to selectSubcategory', () => {
    const props = navProps()
    props.bridge.selectSubcategory('database')
    render(<StarHubNav {...props} />)
    const row = screen.getByTitle('数据库')
    expect(row.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(row)
    expect(props.selectSubcategory).toHaveBeenCalledWith('database')
  })

  it('renders the rail (narrow) variant without labels when wide is false', () => {
    const props = navProps()
    props.wide = false
    render(<StarHubNav {...props} />)
    expect(screen.queryByText('工具')).toBeNull()
    expect(screen.queryByText('终端')).toBeNull()
    expect(screen.getByTitle('工具')).toBeTruthy()
    expect(screen.getByTitle('终端')).toBeTruthy()
  })

  it('opens a right-click menu that opens the asset list without a Vue embed window', () => {
    const props = navProps()
    render(<StarHubNav {...props} />)
    fireEvent.contextMenu(screen.getByTitle('数据库'))
    expect(screen.getByText('打开资产列表')).toBeTruthy()
    expect(screen.queryByText('新窗口打开')).toBeNull()
    fireEvent.click(screen.getByText('打开资产列表'))
    expect(props.selectSubcategory).toHaveBeenCalledWith('database')
  })
})

describe('StarHubOverlay (connection dialog)', () => {
  it('renders nothing while the dialog is closed', () => {
    const props = overlayProps()
    const { container } = render(<StarHubOverlay {...props} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the small create dialog (no fullscreen iframe) when the bridge opens', () => {
    const props = overlayProps()
    props.manager.open()
    render(<StarHubOverlay {...props} />)
    expect(screen.getByRole('dialog', { name: '新建连接' })).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('renders the edit dialog when the bridge opens with an asset', () => {
    const props = overlayProps()
    props.manager.open({
      id: 'a1', type: 'ssh', name: 'web-1', group_id: null,
      config: { host: '1.1.1.1', port: 22, username: 'root' },
      key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
    })
    render(<StarHubOverlay {...props} />)
    expect(screen.getByRole('dialog', { name: '编辑连接' })).toBeTruthy()
    expect((screen.getByLabelText<HTMLInputElement>('名称 *')).value).toBe('web-1')
    expect((screen.getByLabelText<HTMLInputElement>('主机 *')).value).toBe('1.1.1.1')
  })

  it('closes on Escape while open and ignores other keys', () => {
    const props = overlayProps()
    props.manager.open()
    render(<StarHubOverlay {...props} />)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(props.closeConnectionManager).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.closeConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('opens the dialog on the embed open-section message (works while closed)', () => {
    const props = overlayProps()
    render(<StarHubOverlay {...props} />)
    fireEvent(window, new MessageEvent('message', {
      data: { type: 'starhub-embed-open-section', key: 'settings' }, origin: window.location.origin,
    }))
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('ignores open-section messages with another key and foreign origins', () => {
    const props = overlayProps()
    render(<StarHubOverlay {...props} />)
    fireEvent(window, new MessageEvent('message', {
      data: { type: 'starhub-embed-open-section', key: 'other' }, origin: window.location.origin,
    }))
    fireEvent(window, new MessageEvent('message', {
      data: { type: 'starhub-embed-open-section', key: 'settings' }, origin: 'https://evil.example',
    }))
    expect(props.openConnectionManager).not.toHaveBeenCalled()
  })

  it('closes through the dialog close button and backdrop', () => {
    const props = overlayProps()
    props.manager.open()
    render(<StarHubOverlay {...props} />)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(props.closeConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('renders the AI chat panel when its bridge opens and closes on Escape', () => {
    const props = overlayProps()
    render(<StarHubOverlay {...props} />)
    expect(screen.queryByText('AI 聊天')).toBeNull()
    props.aiChat.open()
    render(<StarHubOverlay {...props} />)
    expect(screen.getByText('AI 聊天')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.closeAiChat).toHaveBeenCalledTimes(1)
  })

  it('AI chat bridge toggles open and closed through its real callbacks', () => {
    const props = overlayProps()
    expect(props.aiChat.source.getSnapshot()).toEqual({ open: false })
    props.aiChat.open()
    expect(props.aiChat.source.getSnapshot()).toEqual({ open: true })
    props.aiChat.close()
    expect(props.aiChat.source.getSnapshot()).toEqual({ open: false })
  })
})
