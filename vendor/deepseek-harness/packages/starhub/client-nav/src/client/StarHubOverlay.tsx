/**
 * StarHub overlay:注册进 `shell.overlay` 的层,现在只承载「新建/编辑连接」
 * 小对话框(壳内 React,dsh 风格)——资产实例操作页一律开「React 独立程序
 * 窗口」(见 index.ts 的 openAssetPage 接线 → /starhub-react),不再以壳内
 * overlay 弹框呈现,也不再回落 Vue embed iframe。
 * 打开入口:工作区列「新建连接」/资产行编辑钮、embed 资产条「去设置添加」
 * 的 postMessage 转发(监听常驻,与开关态无关)。关闭:右上角关闭钮 /
 * Esc / 点击遮罩 / 提交成功。
 */
import { useEffect } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { NewConnectionDialog } from './NewConnectionDialog.tsx'
import type { ConnectionManagerState } from './store.ts'

/** Business face injected by the registration: dialog open/close + asset-list refresh. */
export interface StarHubOverlayInjected {
  /** 打开连接对话框(embed 资产条「去设置添加」经 postMessage 触发)。 */
  openConnectionManager: () => void
  closeConnectionManager: () => void
  /** 提交/删除成功后刷新工作区资产列表(裸 source 桥,见 store.ts)。 */
  refreshAssets: () => void
  hooks: {
    connectionManager: SnapshotStore<ConnectionManagerState>
  }
}

/** Full composed props: overlay runtime share + injected face. */
export type StarHubOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<StarHubOverlayInjected>

/** Message type the embed asset bar posts to ask the shell to open the connection dialog. */
const EMBED_OPEN_SECTION_MESSAGE = 'starhub-embed-open-section'

/**
 * Render the connection dialog layer: null while closed; the small
 * NewConnectionDialog when the connection-manager bridge is open.
 * @param props - composed slot props (injected bridges face).
 * @returns null when closed; otherwise the dialog layer.
 */
export function StarHubOverlay({
  openConnectionManager, closeConnectionManager, refreshAssets,
  useConnectionManager,
}: StarHubOverlayProps) {
  const state = useConnectionManager(s => s)

  // embed 资产条「去设置添加」→ 打开连接对话框(常驻监听:消息可能在
  // 对话框关闭时到达——embed 页在 iframe 里时父帧是本壳)。
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const data = e.data as { type?: unknown; key?: unknown } | null
      if (data?.type === EMBED_OPEN_SECTION_MESSAGE && data.key === 'settings') {
        openConnectionManager()
      }
    }
    window.addEventListener('message', onMessage)
    return () =>{  window.removeEventListener('message', onMessage) }
  }, [openConnectionManager])

  // Esc 关闭(仅在对话框打开时挂,避免吞掉壳内其他 Esc 语义)。
  useEffect(() => {
    if (!state.open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeConnectionManager()
    }
    document.addEventListener('keydown', onKeyDown)
    return () =>{  document.removeEventListener('keydown', onKeyDown) }
  }, [state.open, closeConnectionManager])

  if (!state.open) return null

  return (
    <NewConnectionDialog
      key={state.asset?.id ?? 'new'}
      asset={state.asset}
      onClose={closeConnectionManager}
      onSaved={refreshAssets}
    />
  )
}
