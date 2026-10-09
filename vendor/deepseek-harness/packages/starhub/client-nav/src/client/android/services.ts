/**
 * Android 实体机前端服务:android_ui_list_devices / android_ui_open_live 的
 * 宿主桥封装(经 client-nav 的 tauriInvoke 桥;浏览器预览时调用方降级)。
 * 设备写操作不暴露给 UI(只走 AI 工具路径),这里只有只读列表与直播开通道。
 */
import { openAndroidLive } from '../live/live-panel.ts'
import { tauriInvoke } from '../tauri.ts'

/** adb 设备(UI 投影,与 android_ui_list_devices 的 JSON 一致)。 */
export interface AndroidDevice {
  serial: string
  /** device / unauthorized / offline 等。 */
  state: string
  /** 型号(可能为空串)。 */
  model: string
}

export function listAndroidDevices(): Promise<AndroidDevice[]> {
  return tauriInvoke<AndroidDevice[]>('android_ui_list_devices')
}

/**
 * 打开设备直播通道并切到壳内直播面板(去 Tauri 化 M3)。
 *
 * 用户点按钮 = 审批表达(与 Tauri 版 `android_ui_open_live` 同口径)。返回后
 * 面板自行连帧通道;失败由调用方展示错误横幅。
 *
 * @param serial - 设备 serial。
 * @param label - 展示名(型号优先,回退 serial)。
 */
export async function openAndroidLiveWindow(serial: string, label = serial): Promise<void> {
  await openAndroidLive(serial, label)
}
