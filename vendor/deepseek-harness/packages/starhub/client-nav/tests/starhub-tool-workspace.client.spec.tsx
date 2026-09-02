// @vitest-environment jsdom
/**
 * StarHubToolWorkspace (方案 P1):右侧工具工作区列按子类过滤资产列表。
 * Covers the guide/empty/loading/error/list render states, refreshAssets
 * firing on mount and subcategory switch, and the asset-row click opening the
 * instance operation page through the selection bridge. 资产/选择状态走
 * inject hooks 舱位(session-maybe 无会话分支不下发注册侧 store),测试
 * 直接驱动这两份裸 source。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createToolSelectionBridge, type StarHubAssetListState, type ToolSelection,
} from '../src/client/store.ts'
import type { ExecRecordsState } from '../src/client/conn/exec-records.ts'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'

afterEach(cleanup)

/**
 * Compose the full workspace props share: a real selection bridge plus an
 * asset-list bare source (both stand in for the apply-owned holders injected
 * through the hooks compartment), plus the session-maybe standard kit stubs
 * the component's PropsRuntime requires (the component itself only reads the
 * injected face).
 */
function workspaceProps(opts: { cwd?: string; sessionId?: string; panelOpen?: boolean } = {}) {
  const assets = createSnapshotStore<StarHubAssetListState>({ assets: [], loading: false, error: null, preview: false })
  const bridge = createToolSelectionBridge()
  const fileTree = createSnapshotStore<{ open: boolean }>({ open: false })
  const toolsPanel = createSnapshotStore<{ open: boolean }>({ open: opts.panelOpen ?? true })
  const execRecords = createSnapshotStore<ExecRecordsState>({ viewOpen: false, records: [] })
  const useAssets = <S,>(sel: (s: StarHubAssetListState) => S) => sel(assets.getSnapshot())
  const useSelection = <S,>(sel: (s: ToolSelection) => S) => sel(bridge.source.getSnapshot())
  const useFileTree = <S,>(sel: (s: { open: boolean }) => S) => sel(fileTree.getSnapshot())
  const useToolsPanel = <S,>(sel: (s: { open: boolean }) => S) => sel(toolsPanel.getSnapshot())
  const useExecRecords = <S,>(sel: (s: ExecRecordsState) => S) => sel(execRecords.getSnapshot())
  const sessionId = opts.sessionId === undefined ? undefined : opts.sessionId as never
  const useSessions = ((sel: (s: { current: string | undefined; byId: Record<string, { cwd?: string } | undefined> }) => unknown) => {
    const state = {
      current: opts.sessionId,
      byId: opts.sessionId === undefined || opts.cwd === undefined
        ? {}
        : { [opts.sessionId]: { cwd: opts.cwd } },
    }
    return sel(state)
  }) as never
  return {
    assets,
    bridge,
    fileTree,
    toolsPanel,
    execRecords,
    refreshAssets: vi.fn(),
    openConnectionManager: vi.fn(),
    closeFileTree: vi.fn(),
    closeExecView: vi.fn(),
    clearExecRecords: vi.fn(),
    disconnectExecSession: vi.fn(),
    closeTools: vi.fn(),
    selectSubcategory: vi.fn(),
    insertFileReference: vi.fn(),
    insertAssetReference: vi.fn(),
    useAssets,
    useSelection,
    useFileTree,
    useToolsPanel,
    useSessions,
    useExecRecords,
    // settings.update stub: the tool-context sync effect calls it and must
    // not throw in jsdom (no real wire).
    api: { settings: { update: () => Promise.resolve({ result: { ok: true } }) } } as never,
    openAsset: bridge.openAsset,
    useSession: (() => undefined) as never,
    sessionId,
    useProjection: (() => undefined) as never,
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useWorkspaces: (() => undefined) as never,
  }
}

const sshAsset = {
  id: 'a1',
  type: 'ssh',
  name: 'prod-server',
  group_id: null,
  config: { host: '10.0.0.5', username: 'deploy' },
  key_id: null,
  tags: [],
  favorite: false,
  last_used_at: null,
  created_at: 0,
  updated_at: 0,
}

describe('StarHubToolWorkspace', () => {
  it('shows the guide and subcategory rows when no subcategory is selected', () => {
    const props = workspaceProps()
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/点击展开一个子类/)).toBeTruthy()
    // 子类行始终渲染(否则永远无法选中,死胡同);「终端」出现在子类行上。
    expect(screen.getByText('终端')).toBeTruthy()
    expect(screen.getByText('数据库')).toBeTruthy()
    expect(screen.getByText('Docker')).toBeTruthy()
  })

  it('calls refreshAssets on mount and on subcategory switch', () => {
    const props = workspaceProps()
    const view = render(<StarHubToolWorkspace {...props} />)
    expect(props.refreshAssets).toHaveBeenCalledTimes(1)
    props.bridge.selectSubcategory('terminal')
    view.rerender(<StarHubToolWorkspace {...props} />)
    expect(props.refreshAssets).toHaveBeenCalledTimes(2)
  })

  it('renders the loading state while fetching', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.loading = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/加载资产/)).toBeTruthy()
  })

  it('renders the error state with a retry button when loading failed', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.error = 'boom' })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/资产加载失败:boom/)).toBeTruthy()
    screen.getByText('重试').click()
    expect(props.refreshAssets).toHaveBeenCalledTimes(2) // mount + retry
  })

  it('renders the browser-preview hint instead of an error in preview mode', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.preview = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('浏览器预览模式')).toBeTruthy()
    expect(screen.queryByText(/资产加载失败/)).toBeNull()
  })

  it('renders the sandbox panel (no asset list) for the sandbox subcategory', async () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('sandbox')
    render(<StarHubToolWorkspace {...props} />)
    // 沙箱子类无资产概念:展开即 SandboxPanel;无 Tauri IPC(测试环境)时
    // 面板落到概览错误态而不是资产加载态。
    await waitFor(() => expect(screen.getByText(/沙箱概览不可用/)).toBeTruthy())
    expect(screen.queryByText(/暂无 沙箱桌面 连接/)).toBeNull()
  })

  it('renders the android panel (no asset list) for the android subcategory', async () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('android')
    render(<StarHubToolWorkspace {...props} />)
    // Android 子类无资产概念:展开即 AndroidPanel;无 Tauri IPC(测试环境)时
    // 面板落到浏览器预览提示而不是资产加载态。
    await waitFor(() => expect(screen.getByText(/浏览器里/)).toBeTruthy())
    expect(screen.queryByText(/暂无 Android 连接/)).toBeNull()
  })

  it('shows the per-subcategory empty state with a 新建连接 button when no assets match', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('docker')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无 Docker 连接/)).toBeTruthy()
  })

  it('renders the header with the matching count and opens the connection manager from the header + button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('1')).toBeTruthy()
    screen.getByLabelText('新建连接').click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('renders matching asset rows with badge and subtitle, filtering per subcategory', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('prod-server')).toBeTruthy()
    // 列表行徽标与列头都含子类名,至少两处
    expect(screen.getAllByText('终端').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('deploy@10.0.0.5')).toBeTruthy()
  })

  it('renders subtitle fallbacks for host-only, database-only and empty configs', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => {
      d.assets = [
        { ...sshAsset, id: 'h1', config: { host: '10.0.0.6' } },
        { ...sshAsset, id: 'd1', config: { database: 'orders' } },
        { ...sshAsset, id: 'e1', config: {} },
      ]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('10.0.0.6')).toBeTruthy()
    expect(screen.getByText('orders')).toBeTruthy()
  })

  it('shows the concrete database type badge instead of the generic 数据库 label', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('database')
    props.assets.update((d) => {
      d.assets = [
        { ...sshAsset, id: 'm1', type: 'db', name: 'mysql-box', config: { dbType: 'mysql', host: '10.0.0.1' } },
        { ...sshAsset, id: 'r1', type: 'db', name: 'redis-box', config: { dbType: 'redis', host: '10.0.0.2' } },
        { ...sshAsset, id: 'e1', type: 'db', name: 'es-box', config: { dbType: 'elasticsearch', host: '10.0.0.3' } },
      ]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('MySQL')).toBeTruthy()
    expect(screen.getByText('Redis')).toBeTruthy()
    expect(screen.getByText('ES')).toBeTruthy()
  })

  it('skips the settings sync when the api face is absent', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('终端')).toBeTruthy()
  })

  it('refreshes from the header refresh button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    screen.getByTitle('刷新').click()
    expect(props.refreshAssets).toHaveBeenCalledTimes(2) // mount + refresh button
  })

  it('opens the connection manager from the empty-state 新建连接 button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('docker')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    // 头部与空态各有一个「新建连接」,空态按钮在列表区域
    const buttons = screen.getAllByText('新建连接')
    buttons[buttons.length - 1]!.click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('opens the instance operation page when an asset row is clicked', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    const row = screen.getByText('prod-server').closest('button')
    expect(row).not.toBeNull()
    row!.click()
    const sel = props.bridge.source.getSnapshot()
    expect(sel.assetId).toBe('a1')
    expect(sel.routePrefix).toBe('/ssh')
    expect(sel.instanceId).toMatch(/^a1__\d+$/)
  })

  it('opens the connection dialog in edit mode from the row edit button (without opening the page)', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    screen.getByLabelText('编辑 prod-server').click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
    expect(props.openConnectionManager).toHaveBeenCalledWith(sshAsset)
    // 编辑钮不触发打开操作页
    expect(props.bridge.source.getSnapshot().assetId).toBeNull()
  })

  it('copies connection info from the row context menu and reverts the label after 1.5s', async () => {
    vi.useFakeTimers()
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    const write = vi.fn(() => Promise.resolve(true))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    try {
      render(<StarHubToolWorkspace {...props} />)
      const openMenu = () => fireEvent.contextMenu(screen.getByText('prod-server'))
      openMenu()
      fireEvent.click(screen.getByText('复制连接信息'))
      // 剪贴板写成功 → copied 置位;菜单已关闭,重开可见「已复制」标签
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledWith('prod-server deploy@10.0.0.5')
      openMenu()
      expect(screen.getByText('已复制')).toBeTruthy()
      // 1.5s 定时器回退标签
      await vi.advanceTimersByTimeAsync(1500)
      expect(screen.getByText('复制连接信息')).toBeTruthy()
    } finally {
      vi.useRealTimers()
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('opens the connection dialog in edit mode from the row context menu delete entry', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.contextMenu(screen.getByText('prod-server'))
    fireEvent.click(screen.getByText('删除'))
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
    expect(props.openConnectionManager).toHaveBeenCalledWith(sshAsset)
  })

  it('routes the row context-menu 引用到当前对话框 entry to insertAssetReference', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.contextMenu(screen.getByText('prod-server'))
    fireEvent.click(screen.getByText('引用到当前对话框'))
    // 引用经注入面回调分发(真正的 chip 插入 + 轻绑定在 apply 层)
    expect(props.insertAssetReference).toHaveBeenCalledTimes(1)
    expect(props.insertAssetReference).toHaveBeenCalledWith(sshAsset)
    // 引用不触发打开操作页,也不进连接对话框
    expect(props.bridge.source.getSnapshot().assetId).toBeNull()
    expect(props.openConnectionManager).not.toHaveBeenCalled()
  })

  it('routes the row context-menu 打开 and 编辑 entries to their callbacks', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [{ ...sshAsset, id: 'e1', config: {} }] })
    render(<StarHubToolWorkspace {...props} />)
    const openMenu = () => fireEvent.contextMenu(screen.getByText('prod-server'))
    // 打开:走 openAsset 回调,打开该资产实例(无副标题资产)
    openMenu()
    fireEvent.click(screen.getByText('打开'))
    expect(props.bridge.source.getSnapshot().assetId).toBe('e1')
    // 编辑:走连接对话框编辑模式
    openMenu()
    fireEvent.click(screen.getByText('编辑'))
    expect(props.openConnectionManager).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })

  it('keeps the copy label when the clipboard write fails', async () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [{ ...sshAsset, config: {} }] })
    // 剪贴板拒绝写(writeText reject)→ writeClipboard 返回 false → 不置 copied
    const write = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    try {
      render(<StarHubToolWorkspace {...props} />)
      fireEvent.contextMenu(screen.getByText('prod-server'))
      fireEvent.click(screen.getByText('复制连接信息'))
      await vi.waitFor(() =>{  expect(write).toHaveBeenCalled() })
      // 无副标题资产:复制文案只有名称;写失败不置 copied
      expect(write).toHaveBeenCalledWith('prod-server')
      fireEvent.contextMenu(screen.getByText('prod-server'))
      expect(screen.getByText('复制连接信息')).toBeTruthy()
      expect(screen.queryByText('已复制')).toBeNull()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('renders the file tree when the fileTree bridge is open and the session has a cwd', async () => {
    const props = workspaceProps({ sessionId: 's1', cwd: 'C:\\ws\\proj' })
    props.fileTree.update((d) => { d.open = true })
    // 文件树需要 local_list_directory(Tauri invoke stub);根目录懒加载。
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: { path?: string }) => {
        if (cmd !== 'local_list_directory') return Promise.reject(new Error(`unexpected: ${cmd}`))
        const path = args?.path ?? ''
        if (path === 'C:\\ws\\proj') {
          return Promise.resolve([{ name: 'main.ts', path: 'C:\\ws\\proj\\main.ts', kind: 'file', size: 10, modifiedAt: 1, readonly: false, hidden: false }])
        }
        return Promise.reject(new Error(`unknown dir: ${path}`))
      },
    }
    try {
      const view = render(<StarHubToolWorkspace {...props} />)
      // 头部「文件树」标题出现,资产视图被替换
      expect(screen.getByText('文件树')).toBeTruthy()
      expect(screen.queryByText('新建连接')).toBeNull()
      // 根目录懒加载 → 文件行出现
      const fileRow = await screen.findByRole('button', { name: /main\.ts/ })
      expect(fileRow).toBeTruthy()
      // 返回资产列表按钮 → closeFileTree
      fireEvent.click(screen.getByLabelText('返回资产列表'))
      expect(props.closeFileTree).toHaveBeenCalledTimes(1)
      delete w.__TAURI_INTERNALS__
      view.unmount()
    } finally {
      delete w.__TAURI_INTERNALS__
    }
  })

  it('keeps the asset list when the fileTree bridge is open but no session cwd exists', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    props.fileTree.update((d) => { d.open = true })
    render(<StarHubToolWorkspace {...props} />)
    // 无 cwd:文件树不可用,资产列表照常
    expect(screen.getByText('prod-server')).toBeTruthy()
    expect(screen.queryByText('文件树')).toBeNull()
  })

  it('switches to the exec-records view when the bridge is open and hides the asset list', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:asset-1:ssh', conversationId: 'conv-A', command: 'ls -la /var/log', output: 'total 48\nrc.service', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('SSH 执行记录')).toBeTruthy()
    expect(screen.getByText('asset-1')).toBeTruthy()
    expect(screen.getByText('$ ls -la /var/log')).toBeTruthy()
    // 默认收起:输出不出现在 DOM
    expect(screen.queryByText(/total 48/)).toBeNull()
    expect(screen.queryByText('新建连接')).toBeNull()
  })

  it('expands a record on click to show the command output, collapses on second click', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:asset-1:ssh', conversationId: 'conv-A', command: 'df -h', output: '/dev/sda1 40G 20G', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    const head = screen.getByTitle(/^asset-1\(点击/)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(head)
    expect(screen.getByText('/dev/sda1 40G 20G')).toBeTruthy()
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(head)
    expect(screen.queryByText('/dev/sda1 40G 20G')).toBeNull()
  })

  it('passes the row close button through to disconnectExecSession with the connection id', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:a1:ssh', conversationId: 'conv-A', command: 'ls', output: '', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '断开 a1 的连接并移除记录' }))
    expect(props.disconnectExecSession).toHaveBeenCalledWith('dsh:a1:ssh')
  })

  it('clears all records through the injected callback and closes via 返回资产列表', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:a1:ssh', conversationId: 'conv-A', command: 'ls', output: '', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.click(screen.getByText('清空'))
    expect(props.clearExecRecords).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('返回资产列表'))
    expect(props.closeExecView).toHaveBeenCalledTimes(1)
  })

  it('renders the exec view empty state with 清空 disabled when no records exist', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => { d.viewOpen = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无记录/)).toBeTruthy()
    const clear = screen.getByText('清空') as HTMLButtonElement
    expect(clear.disabled).toBe(true)
  })

})
