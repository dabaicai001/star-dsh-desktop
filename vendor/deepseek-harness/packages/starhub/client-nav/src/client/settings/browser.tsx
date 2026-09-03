/**
 * Settings AI 浏览器 tab:引擎选择(webview | obscura)。
 *
 * - webview:无痕独立 Tauri 窗口(wry),真实内核(WebView2/WKWebView/WebKitGTK),
 *   兼容性最好,默认。
 * - obscura:无头浏览器引擎(Rust,V8),rendering 内置,配 CDP 直播查看器窗口;
 *   渲染引擎仍在演进,复杂 SPA/登录页/验证码站兼容性可能不如真实内核。
 *
 * 保存经 browser_set_engine 写 settings 表;AI 下一次 browser_* 调用即按新值生效。
 */
import { useEffect, useState } from 'react'
import { tauriInvoke } from '../tauri.ts'
import s from './settings.module.css'
import css from '../sandbox/SandboxPanel.module.css'

type BrowserEngine = 'webview' | 'obscura'

/** AI 浏览器设置 tab 内容。 */
export function BrowserSettingsTab() {
  const [engine, setEngine] = useState<BrowserEngine>('webview')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void tauriInvoke<BrowserEngine>('browser_get_engine')
      .then(value => setEngine(value))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  const onSave = async () => {
    setSaved(false)
    try {
      await tauriInvoke('browser_set_engine', { engine })
      setError(null)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={s.panel}>
      <h3>AI 浏览器</h3>
      <p className={s.hint}>
        选择 AI 操作浏览器使用的渲染引擎。改动后下一次 browser_open 生效。
      </p>
      <label className={css.field}>
        引擎
        <select
          className={css.select}
          value={engine}
          onChange={event => { setEngine(event.target.value as BrowserEngine); setSaved(false) }}
        >
          <option value="webview">webview(无痕独立窗口,默认,兼容性最好)</option>
          <option value="obscura">obscura(无头引擎,低内存,反指纹,直播查看器窗口)</option>
        </select>
      </label>
      <div>
        <button className={css.button} onClick={() => { void onSave() }}>保存</button>
      </div>
      {saved && <div className={s.hint}>已保存。</div>}
      {error !== null && <div className={css.errorBanner}>{error}</div>}
    </div>
  )
}
