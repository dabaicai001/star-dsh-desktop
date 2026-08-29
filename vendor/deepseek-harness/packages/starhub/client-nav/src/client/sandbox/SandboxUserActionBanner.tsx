/**
 * 「请求人工介入」全局横幅(shell.overlay 常驻):AI 调 desktop_request_user_action
 * 时 Rust 广播 starhub://desktop-user-action,本组件在任何 StarHub 页面上方
 * 弹出横幅。「打开直播画面」直接拉起该沙箱的接管窗口(独立 Tauri 窗口,
 * 双向 noVNC,关闭自动释放接管);用户点「已完成」/「无法完成」经
 * desktop_user_action_reply 应答;倒计时到 timeoutSeconds 自动收起
 * (Rust 侧同超时,晚到应答幂等吞掉)。
 */
import { useEffect, useState } from 'react'
import { onUserActionRequest, openSandboxLiveWindow, replyUserAction, type DesktopUserActionEvent } from './services.ts'
import css from './SandboxPanel.module.css'

/** 挂着的请求 + 剩余秒数。 */
interface PendingRequest {
  event: DesktopUserActionEvent
  remaining: number
}

/** 常驻横幅:无待答请求时渲染 null。 */
export function SandboxUserActionBanner() {
  const [pending, setPending] = useState<PendingRequest | null>(null)

  useEffect(() => {
    let disposed = false
    const subscription = onUserActionRequest((event) => {
      if (!disposed) setPending({ event, remaining: event.timeoutSeconds })
    })
    return () => {
      disposed = true
      void subscription.then(unlisten => { void unlisten() })
    }
  }, [])

  // 倒计时;归零收起(Rust 侧同超时收口)
  useEffect(() => {
    if (pending === null) return
    const timer = window.setInterval(() => {
      setPending(current => {
        if (current === null) return null
        if (current.remaining <= 1) return null
        return { ...current, remaining: current.remaining - 1 }
      })
    }, 1000)
    return () => { window.clearInterval(timer) }
  }, [pending !== null]) // eslint-disable-line react-hooks/exhaustive-deps -- 只在「有/无请求」切换时重建计时器

  if (pending === null) return null
  const { event, remaining } = pending

  const reply = (done: boolean) => {
    void replyUserAction(event.requestId, done).catch(() => { /* 晚到/未知请求幂等吞掉 */ })
    setPending(null)
  }

  // 一键拉起接管窗口(人工介入场景必然要动手操作,直接给双向);
  // 开窗失败(浏览器预览无 IPC)不收起横幅,用户仍可见倒计时
  const openLive = () => {
    void openSandboxLiveWindow(
      { id: event.sandboxId, containerId: event.containerId, novncPort: event.novncPort },
      true,
    ).catch(() => { /* 预览环境无 Tauri IPC,横幅其余按钮仍可用 */ })
  }

  return (
    <div className={css.banner} role="alertdialog" aria-label="AI 请求人工介入">
      <span className={css.bannerText}>
        AI 请求协助:{event.message}(剩余 {remaining} 秒;请在沙箱直播画面中操作)
      </span>
      <button type="button" className={css.button} onClick={openLive}>打开直播画面</button>
      <button type="button" className={css.button} onClick={() => { reply(true) }}>已完成</button>
      <button type="button" className={`${css.button} ${css.danger}`} onClick={() => { reply(false) }}>无法完成</button>
    </div>
  )
}
