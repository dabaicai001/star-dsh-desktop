/**
 * Android 实体机前端服务:android_ui_list_devices / android_ui_open_live 的
 * Tauri 命令封装(经 client-nav 的 tauriInvoke 桥;浏览器预览时调用方降级)。
 * 设备写操作不暴露给 UI(只走 AI 工具路径),这里只有只读列表与直播开窗。
 */
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

/** 打开设备直播独立窗口(围观;窗口内「接管」开关由用户自控)。 */
export function openAndroidLiveWindow(serial: string): Promise<void> {
  return tauriInvoke('android_ui_open_live', { serial })
}
