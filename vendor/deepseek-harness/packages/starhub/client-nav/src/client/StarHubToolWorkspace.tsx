/**
 * StarHub 工具面板(rc.2 适配,2026-08-26):由侧栏底部「工具」入口
 * (sidebar.footer.action → toolsPanel 桥)打开的 shell.overlay 面板,显示
 * 当前子类(终端 / 数据库 / Docker)的资产(连接)列表;点资产行经注入的
 * openAsset 回调新开该实例的独立操作页窗口(桌面端 Tauri webview 窗口,
 * 浏览器预览新标签页)。行尾 hover 出编辑钮,经 openConnectionManager(asset)
 * 打开连接对话框的编辑模式;列头带资产数、刷新与「新建连接」入口。
 *
 * 资产行右键菜单(与任务 3 的 dsh 右键菜单同款 Menu 原语):打开 / 编辑 /
 * 复制连接信息(名称 + user@host 到剪贴板)/ 删除(删除复用连接对话框编辑
 * 模式内的两步确认删除入口,不在菜单里直接执行破坏性操作)。
 *
 * 浏览器预览(无 Tauri IPC)时 refresh 落入 preview 态,这里展示预览提示
 * 而不是红错;其他拉取失败给错误 + 重试。
 *
 * rc.2 移除了可多人占位的 `workspace` / `details.workspace` 槽,本面板改挂
 * `shell.overlay`(root scope,list 槽):开关经 toolsPanel 桥(裸 source +
 * open/close)由 footer 按钮写、本面板读;渲染为居中浮层。root scope 无
 * 框架注入的 sessionId,文件树视图的 cwd 改从全局「当前会话」读取。
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconCloseOutline16, IconCopyOutline16, IconEditOutline16, IconNewChatOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconRightUpOutline16, IconTrashOutline16,
  writeClipboard, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES, assetSubtitle, type StarHubAsset, type StarHubSubcategory } from './sections.ts'
import type { RustAsset, StarHubAssetListState, ToolSelection, ToolsPanelState } from './store.ts'
import { TOOL_CONTEXT_NAMESPACE } from './tool-context.ts'
import { ContextMenu, useContextMenu } from './ContextMenu.tsx'
import { FileTreePanel } from './file-tree/FileTreePanel.tsx'
import type { FileTreeState } from './file-tree/state.ts'
import css from './StarHubToolWorkspace.module.css'

/** Business face injected by the registration: the connection wire + bridge/asset writes. */
export interface StarHubToolWorkspaceInjected {
  /** 连接线面;absent 时跳过 tool-context 同步(无宿主 settings RPC 的场景)。 */
  api?: IApiClient
  openAsset: (asset: StarHubAsset) => void
  refreshAssets: () => void
  /** 打开连接对话框:不传资产 = 新建;传资产 = 编辑(含删除入口)。 */
  openConnectionManager: (asset?: RustAsset) => void
  /** 聚焦(或新建)壳内 AI 会话:面板内「AI 助手」入口。 */
  openAiAssistant: () => void
  /** 切回资产列表视图(文件树面板头部「返回资产列表」)。 */
  closeFileTree: () => void
  /** 关闭工具面板(footer 入口再点或面板右上角 ×)。 */
  closeTools: () => void
  /** 选中一个子类(展开/聚焦该子类的资产列表)。 */
  selectSubcategory: (key: string) => void
  /** 把引用文本追加进当前会话对话框输入框(文件树右键「引用文件/文件夹」)。 */
  insertFileReference: (text: string) => void
  /** 当前会话工作区 cwd(文件树根;overlay root scope 经全局 sessions 提供)。 */
  sessionCwd: string | undefined
  hooks: {
    selection: SnapshotStore<ToolSelection>
    assets: SnapshotStore<StarHubAssetListState>
    fileTree: SnapshotStore<FileTreeState>
    toolsPanel: SnapshotStore<ToolsPanelState>
  }
}

/** Full composed props: overlay runtime share + the injected face (no slot store — see header). */
export type StarHubToolWorkspaceProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<StarHubToolWorkspaceInjected>

/** 单个资产行:主按钮(打开)+ 行尾编辑钮 + 右键菜单(打开/编辑/复制/删除)。 */
function AssetRow({ asset, badgeLabel, active, onOpen, onEdit, onDelete }: {
  asset: RustAsset
  badgeLabel: string
  /** 当前打开(选中)的资产行高亮。 */
  active: boolean
  onOpen: () => void
  onEdit: () => void
  /** 删除走连接对话框编辑模式(内含两步确认的 delete_asset 入口)。 */
  onDelete: () => void
}) {
  const menu = useContextMenu()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => { setCopied(false) }, 1500)
    return () => { window.clearTimeout(timer) }
  }, [copied])
  const subtitle = assetSubtitle(asset)
  const items: MenuEntry[] = [
    { id: 'open', label: '打开', icon: <IconRightUpOutline16 /> },
    { id: 'edit', label: '编辑', icon: <IconEditOutline16 /> },
    { id: 'copy', label: copied ? '已复制' : '复制连接信息', icon: <IconCopyOutline16 /> },
    { type: 'separator', id: 'asset-delete-separator' },
    // 删除不直接执行:复用连接对话框编辑模式内的两步确认删除入口
    // (delete_asset 命令),避免右键菜单里的无确认破坏性操作。
    { id: 'delete', label: '删除', icon: <IconTrashOutline16 />, danger: true },
  ]
  return (
    <div className={css.rowWrap} onContextMenu={menu.onContextMenu}>
      <button
        type="button"
        className={`${css.row} ${active ? css.active : ''}`}
        title={`打开 ${asset.name}(新窗口)`}
        onClick={onOpen}
      >
        <span className={css.badge}>{badgeLabel}</span>
        <span className={css.assetText}>
          <span className={css.rowName}>{asset.name}</span>
          {subtitle !== '' && <span className={css.rowSub}>{subtitle}</span>}
        </span>
      </button>
      <button
        type="button"
        className={css.rowEdit}
        title={`编辑 ${asset.name}`}
        aria-label={`编辑 ${asset.name}`}
        onClick={onEdit}
      >
        <IconEditOutline16 size={13} />
      </button>
      <ContextMenu
        menu={menu}
        items={items}
        onSelect={(id) => {
          if (id === 'open') onOpen()
          else if (id === 'edit') onEdit()
          else if (id === 'copy') {
            const text = subtitle === '' ? asset.name : `${asset.name} ${subtitle}`
            void writeClipboard(text).then((ok) => { if (ok) setCopied(true) })
          /* v8 ignore start -- 菜单 id 枚举完备(open/edit/copy/delete),delete 条件的假分支不可达 */
          } else if (id === 'delete') onDelete()
          /* v8 ignore stop */
        }}
        className={css.menuRoot}
      />
    </div>
  )
}

/**
 * Render the StarHub tools side panel: the mask + right-edge drawer shown when
 * the footer「工具」entry opens it. Inside, a collapsed tree renders the
 * subcategory rows (终端 / 数据库 / Docker), each expandable to its asset
 * (connection) list; clicking an asset opens its operation page. Also syncs
 * the current tool selection to host settings for AI context (Path B plan 4.3).
 *
 * 文件树视图(2026-08-24):面板内「文件树」按钮把 fileTree bridge 置 open 后,
 * 树区切换为项目文件目录树(以当前会话 cwd 为根)(overlay root scope 无框架
 * 注入 sessionId,当前会话经 useSessions 全局快照取 current → binding cwd)。
 * @param props - composed slot props (overlay runtime share + injected face).
 * @returns null when closed; otherwise the drawer layer.
 */
export function StarHubToolWorkspace({
  api, openAsset, refreshAssets, openConnectionManager, openAiAssistant,
  closeFileTree, closeTools, selectSubcategory, insertFileReference, sessionCwd,
  useSelection, useAssets, useFileTree, useToolsPanel,
}: StarHubToolWorkspaceProps) {
  // toolsPanel 开关:未提供该 hook(组件在旧测试桩/独立渲染下)时默认视为打开。
  const panelOpen = useToolsPanel?.(s => s.open) ?? true
  const open = panelOpen
  const assets = useAssets(s => s.assets)
  const loading = useAssets(s => s.loading)
  const error = useAssets(s => s.error)
  const preview = useAssets(s => s.preview)
  const activeSubcategory = useSelection(s => s.subcategory)
  const activeAssetId = useSelection(s => s.assetId)
  const activeRoutePrefix = useSelection(s => s.routePrefix)
  const fileTreeOpen = useFileTree(s => s.open)

  // 打开时(以及切换子类时)重新拉取(回调内部对并发拉取去重)。
  useEffect(() => { if (open) refreshAssets() }, [open, activeSubcategory, refreshAssets])

  // 4.3: 当前工具选择 → host settings(供 agent/pre-step 注入 AI 上下文)。
  // 全量四字段:取消选中写空串清除,避免过期资产滞留成 AI 上下文。
  useEffect(() => {
    if (api === undefined) return
    const subcategory = STARHUB_SUBCATEGORIES.find(s => s.key === activeSubcategory)
    const asset = activeAssetId !== null ? assets.find(a => a.id === activeAssetId) : undefined
    const patch = {
      subcategory: subcategory?.key ?? '',
      assetId: asset?.id ?? '',
      assetName: asset?.name ?? '',
      routePrefix: (activeAssetId !== null ? activeRoutePrefix : null) ?? subcategory?.routePrefix ?? '',
    }
    void api.settings.update({ ns: TOOL_CONTEXT_NAMESPACE, patch }).catch(() => {})
  }, [api, activeSubcategory, activeAssetId, activeRoutePrefix, assets])

  if (!open) return null

  return (
    <div className={css.layer}>
      <div className={css.mask} aria-hidden="true" onClick={closeTools} />
      <aside className={css.panel} role="dialog" aria-modal="true" aria-label="StarHub 工具">
        <header className={css.header}>
          <span className={css.title}>StarHub 工具</span>
          <span className={css.spacer} />
          <button
            type="button"
            className={css.iconButton}
            title="AI 助手"
            aria-label="AI 助手"
            onClick={() =>{  openAiAssistant() }}
          >
            <IconNewChatOutline16 size={13} />
          </button>
          <button
            type="button"
            className={css.iconButton}
            title="刷新"
            aria-label="刷新"
            disabled={loading}
            onClick={() =>{  refreshAssets() }}
          >
            <IconRefreshOutline14 size={13} />
          </button>
          <button
            type="button"
            className={css.closeButton}
            title="关闭工具面板"
            aria-label="关闭工具面板"
            onClick={closeTools}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </header>

        {fileTreeOpen && sessionCwd !== undefined ? (
          <FileTreePanel
            cwd={sessionCwd}
            onClose={closeFileTree}
            insertReference={insertFileReference}
          />
        ) : activeSubcategory === null ? (
          <div className={css.tree}>
            <div className={css.status}>请在左侧选择工具子类(终端 / 数据库 / Docker)。</div>
            <button type="button" className={css.newButton} onClick={() =>{  openConnectionManager() }}>
              <IconPlusOutline16 size={12} />
              <span>新建连接</span>
            </button>
          </div>
        ) : (
          <div className={css.tree}>
            {STARHUB_SUBCATEGORIES.map(subcategory => renderSubcategory(
              subcategory,
              assets,
              activeSubcategory,
              activeAssetId,
              loading,
              error,
              preview,
              {
                openAsset,
                openConnectionManager,
                refreshAssets,
                selectSubcategory,
              },
            ))}
            <button type="button" className={css.newButton} onClick={() =>{  openConnectionManager() }}>
              <IconPlusOutline16 size={12} />
              <span>新建连接</span>
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}

/** 渲染一个子类树节点:子类行(选中态)+ 展开后的资产列表。 */
function renderSubcategory(
  subcategory: StarHubSubcategory,
  assets: readonly RustAsset[],
  activeSubcategory: string | null,
  activeAssetId: string | null,
  loading: boolean,
  error: string | null,
  preview: boolean,
  handlers: {
    openAsset: (asset: StarHubAsset) => void
    openConnectionManager: (asset?: RustAsset) => void
    refreshAssets: () => void
    selectSubcategory: (key: string) => void
  },
) {
  const expanded = subcategory.key === activeSubcategory
  const matched = assets.filter(subcategory.matches)
  const Icon = subcategory.Icon
  return (
    <section key={subcategory.key} className={css.node}>
      <button
        type="button"
        className={`${css.category} ${expanded ? css.active : ''}`}
        aria-expanded={expanded}
        onClick={() =>{  handlers.selectSubcategory(subcategory.key) }}
      >
        <Icon size={13} />
        <span className={css.categoryLabel}>{subcategory.label}</span>
        {!preview && !loading && error === null && <span className={css.count}>{matched.length}</span>}
      </button>
      {expanded && (
        <div className={css.assetGroup}>
          {loading && <div className={css.status}>加载资产…</div>}
          {!loading && preview && (
            <div className={css.status}>
              <div className={css.previewTitle}>浏览器预览模式</div>
              <div>当前页面跑在纯浏览器里,没有 StarHub 桌面端后端(Tauri IPC),资产列表不可用。</div>
            </div>
          )}
          {!loading && !preview && error !== null && (
            <div className={css.status}>
              <div>资产加载失败:{error}</div>
              <button type="button" className={css.retryButton} onClick={() =>{  handlers.refreshAssets() }}>重试</button>
            </div>
          )}
          {!loading && !preview && error === null && matched.length === 0 && (
            <div className={css.status}>
              <div>暂无 {subcategory.label} 连接。</div>
              <button type="button" className={css.retryButton} onClick={() =>{  handlers.openConnectionManager() }}>
                新建连接
              </button>
            </div>
          )}
          {!loading && !preview && error === null && matched.length > 0 && (
            <div className={css.list}>
              {matched.map(asset => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  badgeLabel={subcategory.label}
                  active={activeAssetId === asset.id}
                  onOpen={() =>{  handlers.openAsset(asset) }}
                  onEdit={() =>{  handlers.openConnectionManager(asset) }}
                  onDelete={() =>{  handlers.openConnectionManager(asset) }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
