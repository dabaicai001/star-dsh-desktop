/**
 * StarHub 壳级导航 + 资产状态(P1 方案)。
 *
 * 状态按 scope 拆成三份,因为 dsh 的 store handle 有 one-handle-one-scope
 * 约束(共享 handle 首次挂载即钉死 scope,跨 scope 复用直接抛错),且
 * session-maybe 席位在无会话时不挂注册侧 store(useStore 不下发):
 * - `createStarHubNavStore`(root scope):侧栏「工具」大类展开态,只挂
 *   sidebar.navigation 一座席位;
 * - `createStarHubAssets`:资产列表(get_assets 结果)与拉取状态。两座
 *   工作区席位(workspace 无会话 / details.workspace 有会话)在无会话分支
 *   拿不到注册侧 store,故资产状态由 apply 持有的裸 source 经 inject
 *   hooks 舱位下发、经 refresh 回调驱动(同 ui-agent-preset 的 controller 范式);
 * - `createToolSelectionBridge`:跨 scope 的「当前子类 + 打开的资产实例」。
 *   选择状态必须跨 root(nav 点击)与 session-maybe(工作区列表/overlay
 *   读)两个 scope,同样走 apply 持有的裸 source + 注入回调。
 * - `createConnectionManagerOverlay`:连接管理 overlay(设置页资产 tab)
 *   的开关,同一裸 source 桥范式(session-maybe 工作区写,root overlay 读)。
 */
import {
  createSnapshotStore, defineStore, type EngineStoreHandle, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { routePrefixForAsset, STARHUB_SUBCATEGORIES, type StarHubAsset } from './sections.ts'

/** Rust get_assets 返回的 Asset 序列化形态(与 src-tauri/src/commands/asset.rs 一致)。 */
export interface RustAsset {
  id: string
  type: string
  name: string
  group_id: number | null
  config: Record<string, unknown>
  key_id: string | null
  tags: string[]
  favorite: boolean
  last_used_at: number | null
  created_at: number
  updated_at: number
}

/** 壳内导航状态(root scope):「工具」大类展开态。 */
type StarHubNavState = {
  /** 「工具」大类是否展开(侧栏)。 */
  categoryOpen: boolean
}

/** 导航写集合。 */
type StarHubNavActions = {
  toggleCategory: (draft: StarHubNavState) => void
}

/**
 * Create the root-scope navigation store handle (only the sidebar
 * navigation seat mounts it).
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createStarHubNavStore(): EngineStoreHandle<StarHubNavState, StarHubNavActions> {
  return defineStore({
    init: (): StarHubNavState => ({ categoryOpen: true }),
    actions: {
      toggleCategory: (d) => { d.categoryOpen = !d.categoryOpen },
    },
  })
}

/** 资产列表状态:get_assets 结果与拉取状态。 */
export interface StarHubAssetListState {
  /** 最近一次 get_assets 的结果(可能为空)。 */
  assets: readonly RustAsset[]
  /** 拉取中(组件据此展示 loading;refresh 期间忽略重复触发)。 */
  loading: boolean
  /** 最近一次拉取的错误;null = 无错误。 */
  error: string | null
  /** 浏览器预览(无 Tauri IPC):资产后端不可达,组件展示预览提示而非错误。 */
  preview: boolean
}

/** 顶层帧 Tauri IPC 直调(共享桥,见 tauri.ts);浏览器预览(无 Tauri)时 reject。 */
import { tauriInvoke } from './tauri.ts'

/**
 * 资产列表 holder:apply 持有的裸 source + refresh 回调。session-maybe 席位
 * 在无会话时框架不挂注册侧 store,资产状态因此不走 defineStore;组件在
 * 挂载与切换子类时调 refresh(每次都拉,保证设置里新建/删除连接后列表新鲜)。
 */
export interface StarHubAssets {
  /** 注入 hooks 舱位的裸 observable。 */
  source: SnapshotStore<StarHubAssetListState>
  /** 重新拉取资产列表(拉取中重复调用会被忽略)。 */
  refresh: () => void
}

/**
 * Create the apply-owned asset list holder.
 * @returns the holder (bare source + refresh callback).
 */
export function createStarHubAssets(): StarHubAssets {
  const source = createSnapshotStore<StarHubAssetListState>({ assets: [], loading: false, error: null, preview: false })
  const refresh = (): void => {
    if (source.getSnapshot().loading) return
    // 浏览器预览无 Tauri IPC:不发请求,直接落 preview 态(组件据此展示
    // 「请在桌面应用中使用」提示,而不是一条红错)。
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === undefined) {
      source.update((d) => { d.loading = false; d.error = null; d.preview = true })
      return
    }
    source.update((d) => { d.loading = true; d.error = null; d.preview = false })
    tauriInvoke<RustAsset[]>('get_assets')
      .then((list) => { source.update((d) => { d.assets = list; d.loading = false }) })
      .catch((e: unknown) => {
        source.update((d) => {
          d.error = e instanceof Error ? e.message : String(e)
          d.loading = false
        })
      })
  }
  return { source, refresh }
}

/** 连接管理对话框状态:open + 编辑目标(null = 新建)。 */
export interface ConnectionManagerState {
  open: boolean
  /** 编辑模式的目标资产(get_assets 返回的完整行);null = 新建。 */
  asset: RustAsset | null
}

/** 跨 scope 的连接管理对话框开关(壳内 React 小对话框,非整幅 iframe 层)。 */
export interface ConnectionManagerOverlay {
  /** 注入 hooks 舱位的裸 observable。 */
  source: SnapshotStore<ConnectionManagerState>
  /** 打开连接对话框(新建连接入口 / embed 资产条「去设置添加」);传入资产进入编辑模式。 */
  open: (asset?: RustAsset) => void
  /** 关闭对话框(关闭钮 / Esc / 提交成功)。 */
  close: () => void
}

/**
 * Create the apply-owned connection-manager dialog holder. Open state is
 * read in the root-scope overlay seat and written from the session-maybe
 * workspace seats, so it rides the same bare-source bridge pattern as the
 * tool selection (one-handle-one-scope forbids a shared store handle).
 * @returns the holder (bare source + open/close callbacks).
 */
export function createConnectionManagerOverlay(): ConnectionManagerOverlay {
  const source = createSnapshotStore<ConnectionManagerState>({ open: false, asset: null })
  return {
    source,
    open: (asset) => { source.set({ open: true, asset: asset ?? null }) },
    close: () => { source.set({ open: false, asset: null }) },
  }
}


/** AI 聊天面板(壳内 shell.overlay)开关状态。 */
export interface AiChatState {
  open: boolean
}

/** AI 聊天面板开关桥:apply 持有的裸 source + open/close 回调。 */
export interface AiChatOverlay {
  open: () => void
  close: () => void
  source: SnapshotStore<AiChatState>
}

/**
 * Create the apply-owned AI-chat panel bridge. The workspace seat opens it
 * (「AI 助手」按钮) while the root overlay seat renders the panel — the same
 * bare-source bridge pattern as the connection manager (one-handle-one-scope).
 * @returns the bridge (bare source + open/close callbacks).
 */
export function createAiChatOverlay(): AiChatOverlay {
  const source = createSnapshotStore<AiChatState>({ open: false })
  return {
    open: () =>{  source.set({ open: true }) },
    close: () =>{  source.set({ open: false }) },
    source,
  }
}

/** StarHub 工具面板(侧栏底部入口打开的 overlay)开关状态。 */
export interface ToolsPanelState {
  open: boolean
}

/** 工具面板开关桥:footer 按钮写 open,shell.overlay 席位读渲染。 */
export interface ToolsPanelOverlay {
  open: () => void
  close: () => void
  source: SnapshotStore<ToolsPanelState>
}

/**
 * Create the apply-owned tools-panel bridge. The footer action button opens
 * it (侧栏底部「工具」入口); the shell.overlay seat renders the workspace
 * surface — the same bare-source bridge pattern as the AI chat panel
 * (one-handle-one-scope).
 * @returns the bridge (bare source + open/close callbacks).
 */
export function createToolsPanelOverlay(): ToolsPanelOverlay {
  const source = createSnapshotStore<ToolsPanelState>({ open: false })
  return {
    open: () =>{  source.set({ open: true }) },
    close: () =>{  source.set({ open: false }) },
    source,
  }
}

/** 跨 scope 的当前工具选择:子类 + 打开的资产实例(含派生好的路由前缀)。 */
export interface ToolSelection {
  /** 当前选中的子类 key(STARHUB_SUBCATEGORIES[].key);null = 未选。 */
  subcategory: string | null
  /** 当前打开操作页的资产 id;null = 未打开。 */
  assetId: string | null
  /** 打开动作生成一次的实例 id(`<assetId>__<timestamp>`);null = 未打开。 */
  instanceId: string | null
  /** 实例路由前缀(打开时按 routePrefixForAsset 派生);null = 未打开。 */
  routePrefix: string | null
}

/**
 * 选择桥:apply 持有的裸 observable + 写入回调。选择状态跨 root 与
 * session-maybe 两个 scope(one-handle-one-scope 禁止共享 store handle
 * 跨 scope 挂载),故不走注册侧 store;各注册经 inject hooks 舱位拿到
 * 同一 source(绑定按 source 缓存,身份必须稳定),写入一律经回调。
 */
export interface ToolSelectionBridge {
  /** 注入 hooks 舱位的裸 observable(身份与快照引用在变化前保持稳定)。 */
  source: SnapshotStore<ToolSelection>
  /** 选中子类(侧栏点击;不影响已打开的资产实例)。 */
  selectSubcategory: (key: string) => void
  /** 打开资产实例操作页:按资产类型派生路由前缀,并生成一次 instanceId。 */
  openAsset: (asset: StarHubAsset) => void
  /** 关闭当前资产实例操作页(保留子类选择)。 */
  closeAsset: () => void
}

/**
 * Create the cross-scope tool-selection bridge.
 * @returns the bridge (bare source + write callbacks).
 */
export function createToolSelectionBridge(): ToolSelectionBridge {
  const source = createSnapshotStore<ToolSelection>({
    subcategory: null,
    assetId: null,
    instanceId: null,
    routePrefix: null,
  })
  return {
    source,
    selectSubcategory: (key) => { source.update((d) => { d.subcategory = key }) },
    openAsset: (asset) => {
      const prefix = routePrefixForAsset(asset)
        ?? STARHUB_SUBCATEGORIES.find(s => s.key === source.getSnapshot().subcategory)?.routePrefix
        ?? null
      // 无功能路由的资产类型(如 local):不打开,保持现状
      if (prefix === null) return
      source.set({
        ...source.getSnapshot(),
        assetId: asset.id,
        instanceId: `${asset.id}__${Date.now()}`,
        routePrefix: prefix,
      })
    },
    closeAsset: () => {
      source.update((d) => { d.assetId = null; d.instanceId = null; d.routePrefix = null })
    },
  }
}
