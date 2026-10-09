/**
 * 壳内工作台页簿(去 Tauri 化 M2 第 6 步「iframe 搬入」)。
 *
 * Tauri 壳退役前,资产实例操作页经 `openNewPage` 新开独立 webview 窗口
 * (label `starhub-page-<key>-*`),浏览器预览退化为新标签页。新架构里工作台
 * 不再是独立窗口,而是 dsh 主壳内的一个 keyed 主面板(`main` 槽
 * key=`starhub-workbench`):每个资产实例一页,由 iframe 承载同源的
 * `/starhub-react/` 独立程序(它经同一套宿主桥 fetch/SSE 与 sidecar 通话,
 * 见 `tauri.ts`)。
 *
 * 页簿语义(与旧「按 key 开窗/聚焦」一致):
 * - `open`:同 key 已开 → 只激活(focus),不开第二份——与 sidecar 侧
 *   `starhub/open.asset` 的 open→focus 预判同语义;
 * - `close`:关一页;关掉的是当前页时激活余下页里最后开的一页;
 * - 页簿空 → 主面板该让位(由 index.ts 的订阅把面板切回工具列表)。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** 一个壳内工作台页(iframe 的来源与身份)。 */
export interface WorkbenchPage {
  /** 稳定身份(资产 id);同 key 重复 open = 聚焦。 */
  readonly key: string
  /** 页标题(资产名;标签页与面板头展示)。 */
  readonly title: string
  /** 同源绝对路径(`/starhub-react/index.html?asset=…`)。 */
  readonly url: string
}

/** 页簿状态:开页顺序即数组顺序,`activeKey` 为当前展示页。 */
export interface WorkbenchPanelState {
  pages: readonly WorkbenchPage[]
  activeKey: string | null
}

/** 页簿:裸 observable(供 inject hooks 下发)+ 写入回调。 */
export interface WorkbenchPanelStore {
  /** 注入 hooks 舱位的裸 observable(身份与快照引用在变化前保持稳定)。 */
  readonly source: SnapshotStore<WorkbenchPanelState>
  /** 打开或聚焦一页(同 key 已开则只激活)。 */
  open: (page: WorkbenchPage) => void
  /** 激活一页;该 key 没开返回 false(调用方可回退到「打开」)。 */
  activateIfOpen: (key: string) => boolean
  /** 关一页(未知 key 幂等)。 */
  close: (key: string) => void
}

/**
 * Create the in-shell workbench page store.
 * @returns the page store (bare source + write callbacks).
 */
export function createWorkbenchPanelStore(): WorkbenchPanelStore {
  const source = createSnapshotStore<WorkbenchPanelState>({ pages: [], activeKey: null })
  return {
    source,
    open: (page) => {
      const state = source.getSnapshot()
      if (state.pages.some((opened) => opened.key === page.key)) {
        // 已开:聚焦(不开第二份)。标题/URL 以最新一次为准(资产可能被改名)。
        source.set({
          pages: state.pages.map((opened) => (opened.key === page.key ? page : opened)),
          activeKey: page.key,
        })
        return
      }
      source.set({ pages: [...state.pages, page], activeKey: page.key })
    },
    activateIfOpen: (key) => {
      if (!source.getSnapshot().pages.some((opened) => opened.key === key)) return false
      source.update((draft) => { draft.activeKey = key })
      return true
    },
    close: (key) => {
      const state = source.getSnapshot()
      const pages = state.pages.filter((opened) => opened.key !== key)
      if (pages.length === state.pages.length) return
      const activeKey = state.activeKey === key
        ? (pages[pages.length - 1]?.key ?? null)
        : state.activeKey
      source.set({ pages, activeKey })
    },
  }
}
