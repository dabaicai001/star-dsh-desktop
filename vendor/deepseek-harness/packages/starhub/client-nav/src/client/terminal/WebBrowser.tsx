/**
 * StarHub 原生 Web 浏览器(需求 6 web 子集,React 化)。
 *
 * 从 Vue `src/views/WebBrowserView.vue` 移植:复用同一 SSH 会话,经 SSH
 * direct-tcpip 转发启动本地 Web 网关(`ssh_start_web_gateway` → 返回
 * 127.0.0.1:{port}),用 sandbox iframe 加载 `/__proxy__/{scheme}/{hostport}`
 * 代理 URL。地址栏规范化、网关幂等启动/校验、back/forward/reload 通过向网关
 * 注入的桥接脚本 postMessage 驱动,`navigated` 上报回写地址栏。
 *
 * 网关生命周期:挂载时首次导航拉端口(幂等);`ssh_web_gateway_port` 校验缓存
 * 端口,不一致(`0`/不同值)则重启;卸载时 `ssh_stop_web_gateway` 停网关。
 *
 * @module StarHub web browser (client)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { tauriInvoke } from '../tauri.ts'
import { buildProxyUrl, normalizeUrl, proxyToOriginal, type NormalizedUrl } from './web-browser-utils.ts'
import css from './WebBrowser.module.css'

/** Web 浏览器 props:复用同一 SSH 会话 id 与资产(用于标题/审计)。 */
export interface WebBrowserProps {
  sessionId: string
  assetName: string
  /** Whether the shared SSH session is ready for tunnel creation. */
  sshConnected?: boolean
}

/** 发送给网关桥接脚本的命令类型。 */
type BridgeCmd = 'back' | 'forward' | 'reload'

/**
 * Render an embedded web browser behind the SSH local web gateway.
 * @param props.sessionId - the shared SSH session id (also drives the gateway).
 * @param props.assetName - the owning asset name for titles / messages.
 * @returns the browser toolbar + iframe stage.
 */
export function WebBrowser({ sessionId, assetName, sshConnected = true }: WebBrowserProps) {
  const [address, setAddress] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 持续跟踪当前网关端口;0 表示未启动。
  const gatewayPortRef = useRef(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  /** 确保网关存活:缓存端口失效(SSH 重连 / 他处停网关)则重启。 */
  const ensureGateway = useCallback(async (): Promise<number> => {
    if (gatewayPortRef.current > 0) {
      const alive = await tauriInvoke<number | null>('ssh_web_gateway_port', { sessionId }).catch(() => null)
      if (alive !== gatewayPortRef.current) gatewayPortRef.current = 0
    }
    if (gatewayPortRef.current <= 0) {
      const port = await tauriInvoke<number>('ssh_start_web_gateway', { sessionId })
      gatewayPortRef.current = port
    }
    return gatewayPortRef.current
  }, [sessionId])

  /** 导航到地址栏输入(规范化 → 拉网关 → 设 iframe src)。 */
  const navigate = useCallback(async (target: NormalizedUrl): Promise<void> => {
    setLoading(true)
    setErrorText(null)
    try {
      const port = await ensureGateway()
      const proxyUrl = buildProxyUrl(port, target)
      /* v8 ignore next -- 防御:iframe 恒渲染,引用不为空 */
      if (proxyUrl !== null && iframeRef.current !== null) {
        iframeRef.current.src = proxyUrl
      }
      setAddress(target.href)
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [ensureGateway])

  const onAddressSubmit = (): void => {
    if (loading) return
    const target = normalizeUrl(address)
    if (target === null) {
      setNotice('地址无效,请输入有效 URL')
      return
    }
    setNotice(null)
    void navigate(target)
  }

  /** back / forward / reload:向网关桥接脚本发命令。 */
  const sendCmd = (type: BridgeCmd): void => {
    if (gatewayPortRef.current <= 0) return
    try {
      iframeRef.current?.contentWindow?.postMessage({ __starhub: 1, type }, `http://127.0.0.1:${gatewayPortRef.current}`)
    } catch { /* 跨源投递失败静默 */ }
  }

  // 网关桥接脚本上报:导航回写地址栏。
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as { __starhub?: number; type?: string; href?: string } | null
      if (d === null || d.__starhub !== 1) return
      const port = gatewayPortRef.current
      if (port > 0 && e.origin !== `http://127.0.0.1:${port}`) return
      const win = iframeRef.current?.contentWindow
      if (win === undefined || e.source !== win) return
      if (d.type === 'navigated' && typeof d.href === 'string') {
        const original = proxyToOriginal(new URL(d.href))
        /* v8 ignore next -- 防御分支:非代理 navigated 上报忽略(jsdom 跨窗口 source
         * 归属难覆盖);proxyToOriginal 的 null 返回路径已由 web-browser-utils spec 覆盖 */
        if (original !== null) setAddress(original)
      }
    }
    window.addEventListener('message', onMessage)
    return () =>{  window.removeEventListener('message', onMessage) }
  }, [])

  // 卸载时停网关(与 SSH 会话共享;SSH 断开也会由后端清理)。
  useEffect(() => {
    return () => {
      if (gatewayPortRef.current > 0) {
        void tauriInvoke('ssh_stop_web_gateway', { sessionId }).catch(() => {})
      }
    }
  }, [sessionId])

  const unavailable = !sshConnected

  return (
    <div className={css.root}>
      <div className={css.toolbar}>
        <button type="button" className={css.navBtn} onClick={() =>{  sendCmd('back') }} title="后退" disabled={unavailable}>←</button>
        <button type="button" className={css.navBtn} onClick={() =>{  sendCmd('forward') }} title="前进" disabled={unavailable}>→</button>
        <button type="button" className={css.navBtn} onClick={() =>{  sendCmd('reload') }} title="刷新" disabled={unavailable}>⟳</button>
        <input
          className={css.address}
          value={address}
          disabled={unavailable}
          onChange={(e) =>{  setAddress(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onAddressSubmit()
          }}
          placeholder={unavailable ? '等待 SSH 会话连接…' : '输入完整网址后按 Enter 访问'}
          aria-label="地址栏"
        />
        {loading && <span className={css.hint}>加载中</span>}
      </div>
      {unavailable ? (
        <div className={css.emptyState}>
          <span className={css.emptyIcon} aria-hidden="true">◫</span>
          <strong>网页访问等待 SSH 连接</strong>
          <span>SSH 会话建立后，输入完整网址即可通过安全网关访问。</span>
        </div>
      ) : (
        <>
          {notice !== null && <div className={css.notice} role="status">{notice}</div>}
          {errorText !== null && <div className={css.error} role="alert">{errorText}</div>}
          {address === '' && errorText === null && (
            <div className={css.emptyState}>
              <span className={css.emptyIcon} aria-hidden="true">◫</span>
              <strong>通过 SSH 访问内部网页</strong>
              <span>在上方输入完整 URL，例如 `https://intranet.example`。</span>
            </div>
          )}
          <iframe
            ref={iframeRef}
            className={address === '' ? css.frameHidden : css.frame}
            title={`${assetName} 网页`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </>
      )}
    </div>
  )
}

export default WebBrowser
