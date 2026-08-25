/**
 * StarHub 截图按钮(注册于 `conversation.input.left` 工具行)。
 *
 * 点击直接开始区域截图(遮罩框选);经 tauri.ts 桥调 Rust
 * commands/screenshot.rs 的 `screenshot_begin_region`。截图确认后
 * 主窗口收到 `screenshot:result` 事件,这里把最终 PNG 转成
 * draft 附件并追加到会话输入(复用现有图片附件管线)。
 */

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { tauriListen } from '../tauri.ts'
import css from './ScreenshotButton.module.css'

/** Rust `screenshot:result` 事件 payload(Vec<u8> 经 IPC 到 JS 是 Uint8Array)。 */
export interface ScreenshotResult {
  ok: boolean
  data?: Uint8Array<ArrayBuffer> | null
}

export type ScreenshotButtonProps = PropsRuntime<'conversation.input.left'> & {
  /** 把浏览器 File 注册为会话 draft 附件并挂进输入(rc.2 conversation 服务包装)。 */
  addImages: ((files: readonly File[]) => string | null) | undefined
  /** 开始区域截图。 */
  startRegion: () => Promise<void>
}

// Lucide 标准剪刀(线条风格,与 DSH 图标集一致);stroke=currentColor。
const SCISSORS_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="20" y1="4" x2="8.12" y2="15.88" />
    <line x1="14.47" y1="14.48" x2="20" y2="20" />
    <line x1="8.12" y1="8.12" x2="12" y2="12" />
  </svg>
)

/**
 * 把截图事件结果追加进当前会话输入框附件。
 * @param payload - `screenshot:result` 事件负载。
 * @param addImages - rc.2 conversation 附件注册回调(返回错误消息或 null)。
 */
function ingestScreenshot(
  payload: ScreenshotResult,
  addImages: ScreenshotButtonProps['addImages'],
): void {
  const raw = payload.data
  if (!payload.ok || raw == null || raw.length === 0) return
  if (addImages === undefined) return
  const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw)
  const file = new File([bytes], 'screenshot.png', { type: 'image/png' })
  addImages([file])
}

/** 截图失败提示自动消失时长。 */
const TOAST_DURATION_MS = 4000

export function ScreenshotButton({
  addImages,
  startRegion,
}: ScreenshotButtonProps): JSX.Element {
  const [toast, setToast] = useState<string | null>(null)
  // 事件回调经 ref 转发,监听本身只挂一次(避免 props 抖动重建订阅)。
  const latest = useRef({ addImages })
  latest.current = { addImages }

  useEffect(() => {
    const unlisten = tauriListen<ScreenshotResult>('screenshot:result', payload => {
      ingestScreenshot(payload, latest.current.addImages)
    })
    return () => { void unlisten.then(dispose => dispose()) }
  }, [])

  // toast 自动消失(时序副作用由出现断言覆盖,不单独测消失)。
  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  const run = (): void => {
    startRegion().catch((error: unknown) => {
      // 老系统(Linux PipeWire < 1.0)等前置失败必须可见,不能只打 console:
      // Tauri invoke 的拒绝值是 Rust Err 的字符串,浏览器预览则是 Error。
      const message = error instanceof Error ? error.message : String(error)
      // Ubuntu 22.04 兼容版(编译时关闭截图,未注册截图命令)点击时 invoke 会以
      // "Command ... not found" / "not allowed" 之类的 ACL/命令缺失错误拒绝,这里
      // 归并为对用户友好的提示,而不是暴露 Tauri 内部错误文案。
      if (/not found|not allowed|not registered/i.test(message) && !/ipc unavailable|pipewire/i.test(message)) {
        setToast('当前版本未编译截图功能(Ubuntu 22.04 兼容版);请使用支持截图的最新版本。')
        return
      }
      setToast(message)
    })
  }

  return (
    <>
      <button
        type="button"
        className={css.button}
        aria-label="截图"
        title="区域截图（拖拽框选屏幕区域）"
        onClick={run}
        onMouseDown={e => e.preventDefault()}
      >
        {SCISSORS_ICON}
      </button>
      {toast !== null && (
        <div className={css.toast} role="alert">{toast}</div>
      )}
    </>
  )
}
