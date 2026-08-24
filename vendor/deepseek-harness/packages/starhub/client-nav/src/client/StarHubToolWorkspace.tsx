/**
 * StarHub 工具工作区列(方案 P1,重构版):右侧工具工作区列显示当前子类
 * (终端 / 数据库 / Docker)的资产(连接)列表;点资产行经注入的 openAsset
 * 回调新开该实例的独立操作页窗口(桌面端 Tauri webview 窗口,浏览器预览
 * 新标签页;不再用整幅 overlay 盖住 dsh 主壳)。行尾 hover 出编辑钮,经
 * openConnectionManager(asset) 打开连接对话框的编辑模式;列头带资产数、
 * 刷新与「新建连接」入口(openConnectionManager())。
 *
 * 资产行右键菜单(与任务 3 的 dsh 右键菜单同款 Menu 原语):打开 / 编辑 /
 * 复制连接信息(名称 + user@host 到剪贴板)/ 删除(删除复用连接对话框编辑
 * 模式内的两步确认删除入口,不在菜单里直接执行破坏性操作)。
 *
 * 浏览器预览(无 Tauri IPC)时 refresh 落入 preview 态,这里展示预览提示
 * 而不是红错;其他拉取失败给错误 + 重试。
 *
 * 本组件同时挂在 workspace(无会话)与 details.workspace(有会话)两座
 * session-maybe 席位上;框架在无会话分支不下发注册侧 store,故全部共享
 * 状态都走 inject hooks 舱位的裸 source(useSelection / useAssets),写入
 * 走注入回调(openAsset / refreshAssets / openConnectionManager)。挂载与
 * 切换子类时调 refreshAssets 重拉 get_assets,保证新建/删除连接后列表新鲜。
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'workspace' / 'details.workspace' SlotMap rows.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconCopyOutline16, IconEditOutline16, IconNewChatOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconRightUpOutline16, IconTrashOutline16,
  writeClipboard, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES, assetSubtitle, type StarHubAsset } from './sections.ts'
import type { RustAsset, StarHubAssetListState, ToolSelection } from './store.ts'
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
  /** 聚焦(或新建)壳内 AI 会话:右侧栏「AI 助手」入口。 */
  openAiAssistant: () => void
  /** 切回资产列表视图(文件树面板头部「返回资产列表」)。 */
  closeFileTree: () => void
  /** 把引用文本追加进当前会话对话框输入框(右键「引用文件/文件夹」)。 */
  insertFileReference: (text: string) => void
  hooks: {
    selection: SnapshotStore<ToolSelection>
    assets: SnapshotStore<StarHubAssetListState>
    fileTree: SnapshotStore<FileTreeState>
  }
}

/** Full composed props: workspace runtime share + the injected face (no slot store — see header). */
export type StarHubToolWorkspaceProps =
  & PropsRuntime<'workspace'>
  & InjectFace<StarHubToolWorkspaceInjected>

/** 单个资产行:主按钮(打开)+ 行尾编辑钮 + 右键菜单(打开/编辑/复制/删除)。 */
function AssetRow({ asset, badgeLabel, onOpen, onEdit, onDelete }: {
  asset: RustAsset
  badgeLabel: string
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
        className={css.row}
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
 * Render the in-shell tool workspace column: header (subcategory label,
 * count, refresh, 新建连接) above the current subcategory's asset list;
 * clicking a row opens that instance's operation page. Also syncs the
 * current tool selection to host settings for AI context (Path B plan 4.3) —
 * the patch is always the full four fields, empty string clearing the key, so
 * a deselected asset never lingers as stale AI context.
 *
 * 文件树视图(2026-08-24):头部「文件树」按钮把 fileTree bridge 置 open 后,
 * 本列切换为项目文件目录树(以会话 cwd 为根)——引用文件/文件夹到对话框、
 * 点击文件弹信息窗;「返回资产列表」回到资产列表视图。无会话 cwd 时(blank
 * 会话/浏览器预览)文件树不可用,保持资产列表。
 * @param props - composed slot props (workspace runtime share + injected face).
 * @returns the asset list surface, or a guide/loading/preview/error/empty state.
 */
export function StarHubToolWorkspace({
  api, openAsset, refreshAssets, openConnectionManager, openAiAssistant, closeFileTree,
  insertFileReference, useSelection, useAssets, useFileTree, useSessions, sessionId,
}: StarHubToolWorkspaceProps) {
  const assets = useAssets(s => s.assets)
  const loading = useAssets(s => s.loading)
  const error = useAssets(s => s.error)
  const preview = useAssets(s => s.preview)
  const activeSubcategory = useSelection(s => s.subcategory)
  const activeAssetId = useSelection(s => s.assetId)
  const activeRoutePrefix = useSelection(s => s.routePrefix)
  const subcategory = STARHUB_SUBCATEGORIES.find(s => s.key === activeSubcategory)
  const fileTreeOpen = useFileTree(s => s.open)
  const sessionCwd = useSessions(s => (
    sessionId === undefined ? undefined : s.byId[sessionId]?.cwd
  ))

  // 挂载与切换子类时都重新拉取(回调内部对并发拉取去重)。
  useEffect(() => { refreshAssets() }, [activeSubcategory, refreshAssets])

  // 4.3: 当前工具选择 → host settings(供 agent/pre-step 注入 AI 上下文)。
  // 全量四字段:取消选中写空串清除,避免过期资产滞留成 AI 上下文。
  useEffect(() => {
    if (api === undefined) return
    const asset = activeAssetId !== null ? assets.find(a => a.id === activeAssetId) : undefined
    const patch = {
      subcategory: subcategory?.key ?? '',
      assetId: asset?.id ?? '',
      assetName: asset?.name ?? '',
      routePrefix: (activeAssetId !== null ? activeRoutePrefix : null) ?? subcategory?.routePrefix ?? '',
    }
    void api.settings.update({ ns: TOOL_CONTEXT_NAMESPACE, patch }).catch(() => {})
  }, [api, subcategory, activeAssetId, activeRoutePrefix, assets])

  // 文件树视图:仅会话有 cwd 时可用(无 cwd 回退资产列表)。
  if (fileTreeOpen && sessionCwd !== undefined) {
    return (
      <FileTreePanel
        cwd={sessionCwd}
        onClose={closeFileTree}
        insertReference={insertFileReference}
      />
    )
  }

  if (subcategory === undefined) {
    return <div className={css.status}>请在左侧选择工具子类(终端 / 数据库 / Docker)。</div>
  }

  const matched = assets.filter(subcategory.matches)

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{subcategory.label}</span>
        {!preview && !loading && error === null && <span className={css.count}>{matched.length}</span>}
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
        <button type="button" className={css.newButton} onClick={() =>{  openConnectionManager() }}>
          <IconPlusOutline16 size={12} />
          <span>新建连接</span>
        </button>
      </div>
      {loading && <div className={css.status}>加载资产…</div>}
      {!loading && preview && (
        <div className={css.status}>
          <div className={css.previewTitle}>浏览器预览模式</div>
          <div>当前页面跑在纯浏览器里,没有 StarHub 桌面端后端(Tauri IPC),资产列表不可用。</div>
          <div>请在 StarHub 桌面应用中打开本页管理连接。</div>
        </div>
      )}
      {!loading && !preview && error !== null && (
        <div className={css.status}>
          <div>资产加载失败:{error}</div>
          <button type="button" className={css.retryButton} onClick={() =>{  refreshAssets() }}>重试</button>
        </div>
      )}
      {!loading && !preview && error === null && matched.length === 0 && (
        <div className={css.status}>
          <div>暂无 {subcategory.label} 连接。</div>
          <button type="button" className={css.retryButton} onClick={() =>{  openConnectionManager() }}>
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
              onOpen={() =>{  openAsset(asset) }}
              onEdit={() =>{  openConnectionManager(asset) }}
              onDelete={() =>{  openConnectionManager(asset) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
