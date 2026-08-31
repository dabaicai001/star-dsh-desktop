/**
 * Android 实体机面板(工具面板「Android」子类):adb 设备卡片列表。
 *
 * 设备不是「资产」(不经连接管理器落库),由 adb 现场发现,因此与 SandboxPanel
 * 同姿势:展开子类即渲染本面板,自己拉数据。每张卡片显示型号/serial/状态,
 * 就绪(state=device)设备提供「打开直播」(独立窗口围观,窗口内可切接管);
 * unauthorized/offline 给一行处理提示。刷新按钮重新执行 adb devices -l。
 *
 * 浏览器预览(无 Tauri IPC)时展示预览提示而不是红错,与资产列表同语义。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { listAndroidDevices, openAndroidLiveWindow, type AndroidDevice } from './services.ts'
import css from '../sandbox/SandboxPanel.module.css'

/** 状态 → 中文徽标 + 处理提示(与 AI 工具 android_list_devices 的话术对齐)。 */
function stateNote(state: string): { label: string; hint: string } {
  switch (state) {
    case 'device':
      return { label: '就绪', hint: '' }
    case 'unauthorized':
      return { label: '未授权', hint: '请在手机上点「允许 USB 调试」' }
    case 'offline':
      return { label: '离线', hint: '拔插数据线重试' }
    default:
      return { label: state, hint: '' }
  }
}

/** Android 设备面板:加载/错误/预览/空态/设备卡片。 */
export function AndroidPanel() {
  const [devices, setDevices] = useState<AndroidDevice[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setDevices(await listAndroidDevices())
      setError(null)
      setPreview(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setDevices(null)
      // 与资产列表同语义:无 Tauri IPC = 浏览器预览态,不当红错
      if (message.includes('Tauri IPC unavailable')) {
        setPreview(true)
        setError(null)
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const onOpenLive = async (device: AndroidDevice) => {
    setBusy(device.serial)
    try {
      await openAndroidLiveWindow(device.serial)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={css.root}>
      <div className={css.section}>
        <h3 className={css.sectionTitle}>
          <span>adb 设备</span>
          <button
            type="button"
            className={css.button}
            disabled={loading}
            onClick={() => { void refresh() }}
          >
            <IconRefreshOutline14 size={12} /> 刷新
          </button>
        </h3>
        {loading && <div className={css.status}>加载设备…</div>}
        {!loading && preview && (
          <div className={css.status}>
            当前页面跑在纯浏览器里,没有 StarHub 桌面端后端(Tauri IPC),设备列表不可用。
          </div>
        )}
        {!loading && error !== null && (
          <div className={css.errorBanner}>
            设备列表不可用:{error}
          </div>
        )}
        {!loading && !preview && error === null && devices !== null && devices.length === 0 && (
          <div className={css.status}>
            未发现设备。请确认:手机已开 开发者模式 → USB 调试,并用数据线连接(或已配置无线调试)。
          </div>
        )}
        {!loading && error === null && devices?.map(device => {
          const note = stateNote(device.state)
          return (
            <div key={device.serial} className={css.card}>
              <div className={css.cardMain}>
                <span className={css.cardTitle}>{device.model !== '' ? device.model : device.serial}</span>
                <span className={css.cardSub}>
                  {device.serial} · {note.label}{note.hint !== '' ? `(${note.hint})` : ''}
                </span>
              </div>
              <div className={css.cardActions}>
                {device.state === 'device' && (
                  <button
                    type="button"
                    className={css.button}
                    disabled={busy === device.serial}
                    onClick={() => { void onOpenLive(device) }}
                  >
                    打开直播
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
