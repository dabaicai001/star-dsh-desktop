/**
 * Standalone workbench window: parse the URL, fetch the target asset via the
 * injected Tauri IPC, and render the matching React workbench full-window.
 * Reuses the client-nav workbench components so SSH/SFTP sharing, DB
 * lifecycle, Docker and Redis panels all behave identically to the in-shell
 * versions. The window closes with a header close button.
 */
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { tauriInvoke } from '@deepseek-ai/dsh-starhub-client-nav/src/client/tauri.ts'
import type { RustAsset } from '@deepseek-ai/dsh-starhub-client-nav/src/client/store.ts'
import { DbWorkbench } from '@deepseek-ai/dsh-starhub-client-nav/src/client/DbWorkbench.tsx'
import { DockerWorkbench } from '@deepseek-ai/dsh-starhub-client-nav/src/client/docker/DockerWorkbench.tsx'
import { RedisWorkbench } from '@deepseek-ai/dsh-starhub-client-nav/src/client/redis/RedisWorkbench.tsx'
import { ElasticsearchWorkbench } from '@deepseek-ai/dsh-starhub-client-nav/src/client/es/ElasticsearchWorkbench.tsx'
import { BrokerView } from '@deepseek-ai/dsh-starhub-client-nav/src/client/broker/BrokerView.tsx'
import { SshTerminalOverlay } from '@deepseek-ai/dsh-starhub-client-nav/src/client/terminal/SshTerminalOverlay.tsx'
import {
  parseWindowParams, workbenchForAsset, workbenchForRouteName, type WindowWorkbench,
} from './route.ts'
import './window-shell.css'

/** Shell states: loading, resolved to a workbench, or failed. */
type ShellState =
  | { kind: 'loading' }
  | { kind: 'no-params' }
  | { kind: 'asset-missing'; assetId: string }
  | { kind: 'unsupported'; assetId: string }
  | { kind: 'ready'; asset: RustAsset; workbench: WindowWorkbench }

/** Surface a workbench render failure instead of leaving an empty webview. */
class WorkbenchErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('StarHub workbench render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="window-frame window-error" role="alert">
          <p>工作台加载失败</p>
          <pre>{this.state.error.message}</pre>
          <button type="button" onClick={requestWindowClose}>关闭</button>
        </div>
      )
    }
    return this.props.children
  }
}

/** A window-level "close" (the webview has no Tauri close grant here). */
function requestWindowClose(): void {
  // Best-effort: try Tauri window close; fall back to self.close().
  void tauriInvoke('plugin:window|close')
    .then(() => { /* closed by host */ })
    .catch(() => { window.close() })
}

/** Standalone shell: resolve the URL to a workbench and render it. */
export function WindowShell() {
  const [state, setState] = useState<ShellState>({ kind: 'loading' })

  useEffect(() => {
    const params = parseWindowParams(window.location.search)
    if (params === null) {
      setState({ kind: 'no-params' })
      return
    }
    let cancelled = false
    tauriInvoke<RustAsset[]>('get_assets')
      .then((assets) => {
        if (cancelled) return
        const asset = assets.find(a => a.id === params.assetId)
        if (asset === undefined) {
          setState({ kind: 'asset-missing', assetId: params.assetId })
          return
        }
        const workbench = params.workbench ?? workbenchForAsset(asset)
        if (workbench === null) {
          setState({ kind: 'unsupported', assetId: params.assetId })
          return
        }
        setState({ kind: 'ready', asset, workbench })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'asset-missing', assetId: params.assetId })
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const renderWorkbench = (asset: RustAsset, workbench: WindowWorkbench) => {
    switch (workbench) {
      case 'ssh':
        return <SshTerminalOverlay asset={asset} onClose={requestWindowClose} />
      case 'db-mysql':
      case 'db-postgresql':
      case 'db-clickhouse':
        return <DbWorkbench asset={asset} onClose={requestWindowClose} />
      case 'db-redis':
        return <RedisWorkbench asset={asset} onClose={requestWindowClose} />
      case 'db-elasticsearch':
        return <ElasticsearchWorkbench asset={asset} onClose={requestWindowClose} />
      case 'broker':
        return <BrokerView asset={asset} />
      case 'docker':
        return <DockerWorkbench asset={asset} onClose={requestWindowClose} />
    }
  }

  if (state.kind === 'ready') {
    return (
      <div className="window-frame standalone-workbench">
        <WorkbenchErrorBoundary>{renderWorkbench(state.asset, state.workbench)}</WorkbenchErrorBoundary>
      </div>
    )
  }

  const message = state.kind === 'loading'
    ? '正在加载…'
    : state.kind === 'no-params'
      ? '缺少资产参数。'
      : state.kind === 'asset-missing'
        ? `未找到资产 ${state.assetId}。`
        : `该资产类型暂不支持独立窗口(${state.assetId})。`

  return (
    <div className="window-frame window-error">
      <p>{message}</p>
      <button type="button" onClick={requestWindowClose}>关闭</button>
    </div>
  )
}

/** Keep a reference so HMR can unmount cleanly (used by main.tsx). */
export let rootRef: Root | null = null
export function render(container: HTMLElement): void {
  rootRef = createRoot(container)
  rootRef.render(<WindowShell />)
}

/** Resolve the workbench-window theme from the opener's `dark` hint, else fall
 *  back to DSH's default preference (`system` → `prefers-color-scheme`). The
 *  standalone workbench has no ui-theme plugin tree, so it mirrors the shell's
 *  resolved theme instead of pinning a fixed palette. */
export function resolveWindowTheme(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const dark = params.get('dark')
  if (dark !== null) return dark === '1'
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** Convenience used by tests/main: mount into #root. */
export function mount(): void {
  const apply = (dark: boolean): void => {
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.body.toggleAttribute('data-ds-dark-theme', dark)
  }
  const params = new URLSearchParams(window.location.search)
  const fromHint = params.get('dark') !== null
  // 跟随宿主(DSH 壳)的解析主题:opener 传 `dark` 命中则用,否则按 system 解析;
  // 独立窗口不跑 dsh 插件树(ui-theme),故按此显式落地 DSH 的深浅色 token 切换。
  apply(resolveWindowTheme(window.location.search))
  // system 模式(无显式 dark 提示)下跟随操作系统深色切换实时更新。
  if (!fromHint && typeof matchMedia !== 'undefined') {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => { apply(mq.matches) })
  }
  const el = document.getElementById('root')
  if (el !== null) render(el)
}

// Expose workbenchForRouteName for external/route reuse without an asset.
export { workbenchForRouteName }
