/**
 * Top-frame Tauri IPC bridge for the StarHub client plugin.
 *
 * The desktop shell injects `window.__TAURI_INTERNALS__.invoke` into the top
 * frame (same-origin, P0 spike verified). The client bundle cannot import
 * `@tauri-apps/api`, so every StarHub tool service goes through this thin
 * adapter — the same pattern the browser preview relies on: without Tauri
 * internals the call rejects, and views render their preview/error state.
 */

/** Tauri IPC surface injected into the top frame by the desktop shell. */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Callback registry used by the event plugin (present in the real runtime). */
  transformCallback?: (callback: unknown, once?: boolean) => number
}

/**
 * Call a Tauri command through the injected IPC bridge.
 * @param cmd - Rust command name (e.g. `broker_overview`).
 * @param args - command arguments (camelCase keys; Tauri serializes to snake_case).
 * @returns the command result.
 * @throws when running in a plain browser preview (no Tauri internals).
 */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) {
    return Promise.reject(new Error('Tauri IPC unavailable (browser preview)'))
  }
  return internals.invoke(cmd, args) as Promise<T>
}

/**
 * 读取 dsh 设置文件(settings.yaml)的绝对路径。桌面端经 Tauri `dsh_settings_path`
 * 命令解析(与 web GUI 的 DSH_SETTINGS_PATH 同源);浏览器预览无 Tauri IPC 时
 * reject,由调用方展示预览提示。
 * @returns settings.yaml 绝对路径。
 */
export function dshSettingsPath(): Promise<string> {
  return tauriInvoke<string>('dsh_settings_path')
}

/** Event payload envelope delivered by the Tauri event plugin to listen callbacks. */
interface TauriEventEnvelope<T> {
  event: string
  id: number
  payload: T
}

/** Async disposer returned by a Tauri event subscription. */
export type TauriUnlisten = () => Promise<void>

/**
 * Subscribe to a Tauri event through the event plugin (`plugin:event|listen`),
 * mirroring `@tauri-apps/api/event.listen` over the injected IPC bridge (the
 * client bundle cannot import the api package). The callback registration
 * requires `transformCallback`, which exists in the real desktop runtime;
 * without it (browser preview or stubbed internals) the subscription is a
 * no-op and the returned disposer resolves immediately.
 * @param event - event name (e.g. `ssh:hostkey-confirm:<id>`).
 * @param handler - receives each event payload until disposed.
 * @returns disposer that unlistens from the event plugin.
 */
// T is the subscription payload type, used exactly once in the handler
// signature — inherent to a listen API, so the single-use heuristic of
// no-unnecessary-type-parameters is a false positive here.
// eslint-disable-next-line typescript/no-unnecessary-type-parameters
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<TauriUnlisten> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  const transform = internals?.transformCallback
  if (internals === undefined || typeof transform !== 'function') {
    return () => Promise.resolve()
  }
  const callbackId = transform((envelope: TauriEventEnvelope<T>) => { handler(envelope.payload) }, false)
  const eventId = await internals.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: callbackId,
  }) as number
  return async () => {
    await internals.invoke('plugin:event|unlisten', { event, eventId })
  }
}

/**
 * Window-label prefix for one keyed StarHub page (`starhub-page-<key>-`).
 * The key (asset id for asset pages) lets `starhub://open-asset` focus an
 * already-opened window by scanning `plugin:webview|get_all_webviews`.
 * @param key - stable page identity (e.g. the asset id).
 * @returns the label prefix; the full label appends a timestamp.
 */
export function starhubPageLabelPrefix(key: string): string {
  return `starhub-page-${key}-`
}

/**
 * Open a StarHub page in a NEW window instead of overlaying the dsh shell.
 * Desktop: a real Tauri webview window (label must match the capability
 * glob `starhub-*` so the React workbench inside keeps its IPC grants).
 * Browser preview: a new tab. The page URL is a same-origin path (for example
 * `/starhub-react/index.html?asset=...`); the Tauri command needs an absolute
 * URL, so it is resolved against the current origin.
 * @param path - same-origin page path (absolute path, not full URL).
 * @param title - new window title (asset name).
 * @param key - optional stable identity embedded in the window label so a
 *   later `starhub://open-asset` focus can find this window; omit for pages
 *   with no focus semantics (e.g. subcategory section pages).
 * @returns after the window/tab has been requested.
 * @throws when the desktop window creation IPC fails (no silent fallback —
 *   a failed open must surface, not quietly do nothing).
 */
export async function openNewPage(path: string, title: string, key?: string): Promise<void> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) {
    window.open(path, '_blank', 'noopener')
    return
  }
  await internals.invoke('plugin:webview|create_webview_window', {
    options: {
      label: key === undefined ? `starhub-page-${Date.now()}` : `${starhubPageLabelPrefix(key)}${Date.now()}`,
      url: new URL(path, window.location.origin).toString(),
      title,
      width: 1280,
      height: 800,
      center: true,
    },
  })
}

/**
 * Focus an already-opened keyed StarHub window, best-effort. Scans the live
 * webview registry for a label matching `starhub-page-<key>-` and raises its
 * window (`plugin:window|set_focus`); any IPC failure or a missing window
 * reports false so the caller falls back to opening the page.
 * @param key - the page identity embedded at open time (asset id).
 * @returns true when a matching window was focused; false in preview, when
 *   no window matches, or when the focus IPC fails.
 */
export async function focusWindowByKey(key: string): Promise<boolean> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) return false
  try {
    const webviews = await internals.invoke('plugin:webview|get_all_webviews')
    const match = (webviews as ReadonlyArray<{ label: string; windowLabel: string }>)
      .find(w => w.label.startsWith(starhubPageLabelPrefix(key)))
    if (match === undefined) return false
    await internals.invoke('plugin:window|set_focus', { label: match.windowLabel })
    return true
  } catch {
    // IPC 失败(如能力缺失/窗口已关):按「无可聚焦窗口」处理,由调用方
    // 回退打开页面——聚焦是尽力而为,失败不吞掉打开动作。
    return false
  }
}
