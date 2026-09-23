/**
 * Settings AI 浏览器 tab:引擎选择(webview | obscura)+ Jev 决策配置。
 *
 * - webview:无痕独立 Tauri 窗口(wry),真实内核(WebView2/WKWebView/WebKitGTK),
 *   兼容性最好,默认。
 * - obscura:无头浏览器引擎(Rust,V8),rendering 内置,配 CDP 直播查看器窗口;
 *   渲染引擎仍在演进,复杂 SPA/登录页/验证码站兼容性可能不如真实内核。
 *
 * Jev 决策(TypeSafe "System One" 决策模型):`browser_decide` 工具把「目标 +
 * 页面快照」发给 Jev 拿结构化动作建议(只读,不执行)。非密配置走
 * `browser_get_jev_config`/`browser_set_jev_config`(settings 表),API key 走
 * keyring 的 `set/get_ai_model_api_key`(id = "jev")。默认关闭:页面快照会
 * 外发到所配置端点,私有部署场景请确认合规后再开启。
 *
 * 保存经 browser_set_engine 写 settings 表;AI 下一次 browser_* 调用即按新值生效。
 */
import { useEffect, useState } from 'react'
import { tauriInvoke } from '../tauri.ts'
import s from './settings.module.css'
import css from '../sandbox/SandboxPanel.module.css'

type BrowserEngine = 'webview' | 'obscura'

/** Jev 非密配置(与 Rust browser::decide::JevConfig 对齐,camelCase)。 */
type JevConfig = {
  enabled: boolean
  baseUrl: string
  model: string
  threshold: number
  timeoutMs: number
}

const JEV_DEFAULT: JevConfig = {
  enabled: false,
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  threshold: 0.6,
  timeoutMs: 8000,
}

/** Jev API key 的 keyring id(与 Rust decide::API_KEY_ID 对齐)。 */
const JEV_KEY_ID = 'jev'

type KeyPresence = 'unknown' | 'set' | 'missing'

/** AI 浏览器设置 tab 内容。 */
export function BrowserSettingsTab() {
  const [engine, setEngine] = useState<BrowserEngine>('webview')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [jev, setJev] = useState<JevConfig>(JEV_DEFAULT)
  const [jevSaved, setJevSaved] = useState(false)
  const [keyPresence, setKeyPresence] = useState<KeyPresence>('unknown')
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)

  useEffect(() => {
    void tauriInvoke<BrowserEngine>('browser_get_engine')
      .then(value => setEngine(value))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  useEffect(() => {
    void tauriInvoke<JevConfig>('browser_get_jev_config')
      .then(value => setJev({ ...JEV_DEFAULT, ...value }))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    void tauriInvoke<string>('get_ai_model_api_key', { id: JEV_KEY_ID })
      .then(() => setKeyPresence('set'))
      .catch(() => setKeyPresence('missing'))
  }, [])

  const onSave = async () => {
    setSaved(false)
    try {
      await tauriInvoke('browser_set_engine', { engine })
      setError(null)
      setSaved(true)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onSaveJev = async () => {
    setJevSaved(false)
    try {
      await tauriInvoke('browser_set_jev_config', {
        enabled: jev.enabled,
        baseUrl: jev.baseUrl.trim(),
        model: jev.model.trim(),
        threshold: jev.threshold,
        timeoutMs: jev.timeoutMs,
      })
      setError(null)
      setJevSaved(true)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onSaveKey = async () => {
    setKeySaving(true)
    try {
      await tauriInvoke('set_ai_model_api_key', { id: JEV_KEY_ID, value: keyDraft.trim() })
      setKeyDraft('')
      setKeyPresence('set')
      setError(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setKeySaving(false)
    }
  }

  const onDeleteKey = async () => {
    setKeySaving(true)
    try {
      await tauriInvoke('delete_ai_model_api_key', { id: JEV_KEY_ID })
      setKeyPresence('missing')
      setError(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setKeySaving(false)
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

      <h3>Jev 决策</h3>
      <p className={s.hint}>
        TypeSafe Jev 决策模型:AI 调 browser_decide 时,把「目标 + 页面快照」发给 Jev,
        返回下一步动作建议(元素编号 + 置信度)。Jev 只做判断,不执行任何操作;
        未启用时 browser_decide 返回提示,AI 照常用 browser_extract。
      </p>
      <p className={s.hint}>
        注意:启用后,页面快照与目标文本会发送到下方配置的第三方端点(默认 TypeSafe 官方 API)。
        私有部署 / 数据不外发场景请填写自建或网关端点并确认合规后再开启。
      </p>
      <label className={s.checkboxRow}>
        <input
          type="checkbox"
          checked={jev.enabled}
          onChange={event => { setJev({ ...jev, enabled: event.target.checked }); setJevSaved(false) }}
        />
        启用 Jev 决策(默认关闭)
      </label>
      <label className={css.field}>
        <span className={s.fieldLabel}>API 地址(base_url)</span>
        <input
          className={s.input}
          type="text"
          value={jev.baseUrl}
          placeholder="https://api.typesafe.ai"
          onChange={event => { setJev({ ...jev, baseUrl: event.target.value }); setJevSaved(false) }}
        />
      </label>
      <label className={css.field}>
        <span className={s.fieldLabel}>模型</span>
        <input
          className={s.input}
          type="text"
          value={jev.model}
          placeholder="jev-latest"
          onChange={event => { setJev({ ...jev, model: event.target.value }); setJevSaved(false) }}
        />
      </label>
      <label className={css.field}>
        <span className={s.fieldLabel}>置信度阈值(0.00–1.00,低于它时决策仅供参考)</span>
        <input
          className={s.input}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={jev.threshold}
          onChange={event => { setJev({ ...jev, threshold: Number(event.target.value) }); setJevSaved(false) }}
        />
      </label>
      <label className={css.field}>
        <span className={s.fieldLabel}>超时(毫秒,500–60000)</span>
        <input
          className={s.input}
          type="number"
          min={500}
          max={60000}
          step={500}
          value={jev.timeoutMs}
          onChange={event => { setJev({ ...jev, timeoutMs: Number(event.target.value) }); setJevSaved(false) }}
        />
      </label>
      <div>
        <button className={css.button} onClick={() => { void onSaveJev() }}>保存配置</button>
      </div>
      {jevSaved && <div className={s.hint}>Jev 配置已保存,下一次 browser_decide 生效。</div>}

      <label className={css.field}>
        <span className={s.fieldLabel}>API Key(存系统钥匙串,不留明文)</span>
        <span className={s.fieldHint}>
          {keyPresence === 'set' ? '已配置' : keyPresence === 'missing' ? '未配置' : '读取中…'}
        </span>
        <input
          className={s.input}
          type="password"
          value={keyDraft}
          placeholder={keyPresence === 'set' ? '已配置,输入新值可覆盖' : 'sk-…'}
          onChange={event => setKeyDraft(event.target.value)}
        />
      </label>
      <div>
        <button
          className={css.button}
          disabled={keySaving || keyDraft.trim().length === 0}
          onClick={() => { void onSaveKey() }}
        >
          保存密钥
        </button>
        {keyPresence === 'set' && (
          <button className={css.button} disabled={keySaving} onClick={() => { void onDeleteKey() }}>
            删除密钥
          </button>
        )}
      </div>
    </div>
  )
}
