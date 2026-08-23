/**
 * StarHub 截图按钮(注册于 `conversation.input.left` 工具行)。
 *
 * 点击弹出小菜单:区域截图(遮罩框选)或窗口截图(点击整窗);
 * 经 tauri.ts 桥调 Rust commands/screenshot.rs。截图确认后
 * 主窗口收到 `screenshot:result` 事件,这里把最终 PNG 转成
 * draft 附件并追加到会话输入(复用现有图片附件管线)。
 */

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { tauriListen } from '../tauri.ts'
import css from './ScreenshotButton.module.css'

/** Rust `screenshot:result` 事件 payload(Vec<u8> 经 IPC 到 JS 是 Uint8Array)。 */
export interface ScreenshotResult {
  ok: boolean
  data?: Uint8Array<ArrayBuffer> | null
}

export type ScreenshotButtonProps = PropsRuntime<'conversation.input.left'> & {
  /** 把浏览器 File 注册为会话 draft 附件(conversation 服务包装)。 */
  createDraftImages: (files: readonly File[]) => readonly ComposerAttachment[]
  /** 开始区域截图。 */
  startRegion: () => Promise<void>
  /** 开始窗口截图。 */
  startWindow: () => Promise<void>
}

const SCISSORS_ICON = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
    <path
      d="M5.2 5.6a2.4 2.4 0 1 0-1.4-2.1l-2.4 1.4A1 1 0 0 0 1.8 6l4.7 4.2a2 2 0 0 1 .5.6v.2a2.2 2.2 0 1 0 2.2-2.2h-.3l3.5-3.1a1 1 0 0 0 .1-1.5l-.5-.4a1 1 0 0 0-1.3.1L8.7 5.5 7.4 4.5l1.2-1.1a1 1 0 0 0 .1-1.5l-.5-.4a1 1 0 0 0-1.3.1L5.2 5.6Zm-1.8-1.2.7-.4a1 1 0 1 1-.7.4Zm8 7.2a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z"
      fill="currentColor"
    />
  </svg>
)

/**
 * 把截图事件结果追加进当前会话输入框附件。
 * @param payload - `screenshot:result` 事件负载。
 * @param createDraftImages - draft 附件注册回调。
 * @param addImages - 会话输入动作(把 draft id 挂进输入机)。
 */
function ingestScreenshot(
  payload: ScreenshotResult,
  createDraftImages: ScreenshotButtonProps['createDraftImages'],
  addImages: ((ids: readonly DraftAttachmentId[]) => boolean) | undefined,
): void {
  const raw = payload.data
  if (!payload.ok || raw == null || raw.length === 0) return
  const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw)
  const file = new File([bytes], 'screenshot.png', { type: 'image/png' })
  const images = createDraftImages([file])
  if (images.length > 0) addImages?.(images.map(image => image.id))
}

export function ScreenshotButton({
  createDraftImages,
  startRegion,
  startWindow,
  inputActions,
}: ScreenshotButtonProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  // 事件回调经 ref 转发,监听本身只挂一次(避免 props 抖动重建订阅)。
  const latest = useRef({ createDraftImages, addImages: inputActions?.addImages })
  latest.current = { createDraftImages, addImages: inputActions?.addImages }

  useEffect(() => {
    const unlisten = tauriListen<ScreenshotResult>('screenshot:result', payload => {
      ingestScreenshot(payload, latest.current.createDraftImages, latest.current.addImages)
    })
    return () => { void unlisten.then(dispose => dispose()) }
  }, [])

  // 点击外部关闭菜单。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  const run = (fn: () => Promise<void>): void => {
    setOpen(false)
    fn().catch(error => { console.error('开始截图失败:', error) })
  }

  return (
    <div ref={boxRef} className={css.root}>
      <button
        type="button"
        className={css.button}
        aria-label="截图"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        onMouseDown={e => e.preventDefault()}
      >
        {SCISSORS_ICON}
      </button>
      {open && (
        <div className={css.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={css.item}
            onClick={() => run(startRegion)}
          >
            <span className={css.itemIcon}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M2 9.5h12" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <span className={css.itemText}>区域截图</span>
            <span className={css.itemHint}>拖拽框选屏幕区域</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.item}
            onClick={() => run(startWindow)}
          >
            <span className={css.itemIcon}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <span className={css.itemText}>窗口截图</span>
            <span className={css.itemHint}>点击截取整个窗口</span>
          </button>
        </div>
      )}
    </div>
  )
}
