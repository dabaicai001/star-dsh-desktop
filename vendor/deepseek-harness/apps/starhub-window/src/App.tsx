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

/** Convenience used by tests/main: mount into #root. */
export function mount(): void {
  // 独立窗口不跑 dsh 插件树(ui-theme):工作台按深色设计,直接钉住深色调色板。
  document.documentElement.style.colorScheme = 'dark'
  document.body.toggleAttribute('data-ds-dark-theme', true)
  const el = document.getElementById('root')
  if (el !== null) render(el)
}

// Expose workbenchForRouteName for external/route reuse without an asset.
export { workbenchForRouteName }
