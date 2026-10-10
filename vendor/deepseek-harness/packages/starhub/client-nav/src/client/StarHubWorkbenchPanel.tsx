/**
 * StarHub 工作台主面板(去 Tauri 化 M2 第 6 步「iframe 搬入」)。
 *
 * 资产实例操作页不再是独立 webview 窗口 / 新标签页,而是本面板内的一个标签页:
 * 标签条一页一签(点签切换、× 关页),内容区用**同源 iframe** 承载
 * `/starhub-react/` 独立程序。iframe 与主壳同源,因此工作台内的
 * `tauriInvoke` / `tauriListen` 经同一套宿主桥(fetch + SSE)打到 sidecar,
 * 113 个调用点零改动。
 *
 * 挂在 ui-layout 的 root-scope `main` keyed 槽(key=`starhub-workbench`);
 * 入口(资产行点击 / `starhub://open-asset`)经 `layout.selectPanel` 切到本面板,
 * 关掉最后一页时由 index.ts 的订阅把面板让回会话视图。无页时渲染 null(面板
 * 不可见,不影响 layout 的 panel 记录)。面板内不再有「返回工具列表」出口
 * (v0.132.0:关页 = 回会话;回工具列表走侧栏常驻的「工具」行)。
 */
import clsx from 'clsx'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'main' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCloseOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchPanelState } from './workbench-panel.ts'
import css from './StarHubWorkbenchPanel.module.css'

/** Business face injected by the registration: page writes + the page store. */
export interface StarHubWorkbenchPanelInjected {
  /** 激活一页(点标签)。 */
  activatePage: (key: string) => void
  /** 关一页(标签上的 ×);关掉最后一页 = 面板让回会话视图(index.ts 订阅)。 */
  closePage: (key: string) => void
  hooks: {
    /** 页簿(裸 source,渲染器绑定为 useWorkbench)。 */
    workbench: SnapshotStore<WorkbenchPanelState>
  }
}

/** Full composed props: main-panel runtime share + the injected face. */
export type StarHubWorkbenchPanelProps =
  & PropsRuntime<'main'>
  & InjectFace<StarHubWorkbenchPanelInjected>

/**
 * Render the in-shell workbench: tab strip over a same-origin iframe.
 * @param props - main-panel runtime share + injected page writes/store.
 * @returns the panel element, or null when no page is open.
 */
export function StarHubWorkbenchPanel({
  useWorkbench,
  activatePage,
  closePage,
}: StarHubWorkbenchPanelProps): JSX.Element | null {
  const state = useWorkbench((snapshot) => snapshot)
  if (state.pages.length === 0) return null
  const active = state.pages.find((page) => page.key === state.activeKey)
    ?? state.pages[state.pages.length - 1]
  // 理论不可达(pages 非空时末元素必在); Narrowing 让 iframe 的 active 引用安全。
  if (active === undefined) return null
  return (
    <div className={css.panel}>
      <div className={css.tabs} role="tablist">
        {state.pages.map((page) => (
          <span key={page.key} className={css.tabSlot}>
            <button
              type="button"
              role="tab"
              aria-selected={page.key === active.key}
              className={clsx(css.tab, page.key === active.key && css.active)}
              onClick={() => { activatePage(page.key) }}
            >
              <span className={css.tabLabel}>{page.title}</span>
            </button>
            <button
              type="button"
              aria-label={`关闭 ${page.title}`}
              className={css.tabClose}
              onClick={() => { closePage(page.key) }}
            >
              <IconCloseOutlineMedium />
            </button>
          </span>
        ))}
      </div>
      <iframe
        className={css.frame}
        title={active.title}
        src={active.url}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  )
}
