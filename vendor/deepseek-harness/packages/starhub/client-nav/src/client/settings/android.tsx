/**
 * Settings Android 设备 tab:adb 二进制路径配置。
 * 语义(Rust android 模块实现):留空 = 自动探测(设置表 → STARHUB_ADB_PATH
 * 环境变量 → PATH → 平台常见安装位置);显式填写后写 settings 表
 * android.adb_path,保存即清主进程解析缓存,下一次 adb 调用按新值生效。
 */
import { useEffect, useState } from 'react'
import { tauriInvoke } from '../tauri.ts'
import s from './settings.module.css'
import css from '../sandbox/SandboxPanel.module.css'

/** android_ui_get_config 返回的聚合。 */
interface AndroidConfig {
  adbPath: string | null
  resolvedAdb: string | null
}

/** Android 设备设置 tab 内容。 */
export function AndroidSettingsTab() {
  const [adbPath, setAdbPath] = useState('')
  const [resolvedAdb, setResolvedAdb] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void tauriInvoke<AndroidConfig>('android_ui_get_config')
      .then(config => {
        setAdbPath(config.adbPath ?? '')
        setResolvedAdb(config.resolvedAdb)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  const onSave = async () => {
    const next = adbPath.trim()
    setSaved(false)
    try {
      await tauriInvoke('android_ui_set_adb_path', { path: next === '' ? null : next })
      setResolvedAdb(next === '' ? null : next)
      setError(null)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={s.panel}>
      <h3>Android 设备(adb)</h3>
      <p className={s.hint}>
        AI 直连实体 Android 手机(开发者模式 → USB 调试 / 无线调试)使用的 adb 二进制。
        留空自动探测;未安装时可在终端执行 winget install --id Google.PlatformTools -e(Windows)、
        brew install android-platform-tools(macOS)或 apt install adb(Linux),也可以直接让 AI 代装。
      </p>
      <label className={css.field}>
        adb 路径(留空 = 自动探测)
        <input
          className={css.select}
          value={adbPath}
          placeholder="如 D:\platform-tools\adb.exe"
          onChange={event => { setAdbPath(event.target.value); setSaved(false) }}
        />
      </label>
      <p className={s.hint}>
        当前生效:{resolvedAdb ?? (adbPath.trim() === '' ? '尚未解析(首次使用时自动探测)' : '(保存后生效)')}
      </p>
      <div>
        <button className={css.button} onClick={() => { void onSave() }}>保存</button>
      </div>
      {saved && <div className={s.hint}>已保存。</div>}
      {error !== null && <div className={css.errorBanner}>{error}</div>}
    </div>
  )
}
