/**
 * StarHub 直播/接管主面板(去 Tauri 化 M3「面板化」)。
 *
 * Tauri 壳退役前,直播是独立 webview 窗口(`android-live://` custom protocol +
 * 自包含 HTML 页 + WebCodecs 解码 H.264)。新架构里它是 dsh 主壳内的一个
 * keyed 主面板(`main` 槽 key=`starhub-live`):
 *
 * - **帧**:经宿主 upgrade 路由 `/starhub/live?channel=…&token=…` 连到 sidecar
 *   的本地 WS(bridge 把字节中继过去,见 `starhub-bridge/src/live.ts`)。PNG
 *   帧直接画进 canvas,H.264 帧经 `VideoDecoder`(annexb → avcC 描述集见
 *   `live-frame.ts`)解码后画进同一个 canvas;
 * - **输入**:接管开启时,面板上的指针/滚轮/按键经同一条 WS 下行
 *   (`{"t":"input","action":{…}}`);未接管时服务端直接回 `not in takeover`
 *   (与 Tauri 直播页的 423 同文案),面板把原因显示在状态行;
 * - **接管**:开关经 `{"t":"takeover"}` 写帧枢纽——AI 写操作与人工操作因此
 *   互斥(域工具执行点读同一处),与 Tauri 窗口层的语义一致;
 * - **坐标**:一律按「画面内容矩形 → 设备物理像素」映射,免疫信箱边距与
 *   分辨率差(与 Tauri 直播页同算法)。
 *
 * 无页时渲染 null(面板不可见,不影响 layout 的 panel 记录)。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'main' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  buildAvcDescription,
  extractParameterSets,
  FLAG_CONFIG,
  FRAME_H264,
  FRAME_PNG,
  mapPointerToDevice,
  parseLiveFrame,
} from './live-frame.ts'
import { tauriInvoke } from '../tauri.ts'
import css from './StarHubLivePanel.module.css'

/** 宿主 upgrade 路由(与 `starhub-bridge` 的 LIVE_UPGRADE_ROUTE 一致)。 */
const LIVE_UPGRADE_ROUTE = '/starhub/live'

/**
 * WebCodecs 的 `VideoDecoder`(旧浏览器没有 → H.264 实时不可用,轮询帧照常)。
 *
 * 结构上等价于 DOM 的 `VideoDecoder`,只取本面板用到的三个方法;DOM lib 的
 * 原型在部分编译配置里不可见,因此这里自己声明窄面并在运行时探测。
 */
interface VideoDecoderLike {
  configure(config: {
    codec: string
    description?: ArrayBufferLike
    optimizeForLatency?: boolean
  }): void
  decode(chunk: { data: Uint8Array; timestamp: number }): void
  close(): void
}

/** 解码输出帧:本面板只取尺寸与 close(CanvasImageSource 由它自身满足)。 */
interface DecodedFrame {
  readonly width: number
  readonly height: number
  close(): void
}

type VideoDecoderCtor = new (init: {
  output: (frame: DecodedFrame) => void
  error: (error: unknown) => void
}) => VideoDecoderLike

/** Business face injected by the registration: channel writes + the store. */
export interface StarHubLivePanelInjected {
  /** 激活一条通道(点标签)。 */
  activateChannel: (channel: string) => void
  /** 关一条通道(标签上的 ×;同时通知 sidecar 回收源)。 */
  closeChannel: (channel: string) => void
  /** 写连接状态(WS 生命周期驱动)。 */
  setStatus: import('./live-panel.ts').LivePanelStore['setStatus']
  /** 写通道元数据(meta 消息驱动:模式/分辨率/降级原因)。 */
  setMeta: import('./live-panel.ts').LivePanelStore['setMeta']
  /** 写接管标志(服务端确认后同步,不本地乐观)。 */
  setTakeover: (takeover: boolean) => void
  hooks: {
    /** 通道簿(裸 source,渲染器绑定为 useLive)。 */
    live: SnapshotStore<import('./live-panel.ts').LivePanelState>
  }
}

/** Full composed props: main-panel runtime share + the injected face. */
export type StarHubLivePanelProps =
  & PropsRuntime<'main'>
  & InjectFace<StarHubLivePanelInjected>

/** 面板能拿到的 WebCodecs 形态(不存在时走 PNG-only 降级)。 */
function videoDecoderCtor(): VideoDecoderCtor | null {
  const scope = globalThis as unknown as { VideoDecoder?: VideoDecoderCtor }
  return scope.VideoDecoder ?? null
}

/**
 * Render the in-shell live/takeover panel: channel tabs, one canvas, the
 * takeover switch, and the gesture surface.
 * @param props - main-panel runtime share + injected channel writes/store.
 * @returns the panel element, or null when no channel is open.
 */
export function StarHubLivePanel({
  useLive,
  activateChannel,
  closeChannel,
  setStatus,
  setMeta,
  setTakeover,
}: StarHubLivePanelProps): JSX.Element | null {
  const state = useLive((snapshot) => snapshot)
  const active = state.channels.find((entry) => entry.channel === state.activeChannel)
    ?? state.channels[state.channels.length - 1]
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const decoderRef = useRef<VideoDecoderLike | null>(null)
  const descriptionRef = useRef<Uint8Array | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  /** 画一帧位图到 canvas(按帧自身尺寸设 canvas 尺寸)。 */
  const draw = useCallback((source: CanvasImageSource, width: number, height: number) => {
    const canvas = canvasRef.current
    if (canvas === null) return
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (ctx !== null) ctx.drawImage(source, 0, 0)
  }, [])

  /** 连接 / 重连当前通道;返回清理函数。 */
  const connect = useCallback((channelId: string, token: string) => {
    const scheme = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${scheme}://${globalThis.location.host}${LIVE_UPGRADE_ROUTE}?channel=${encodeURIComponent(channelId)}&token=${encodeURIComponent(token)}`
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket

    socket.onopen = () => { setHint(null); setStatus('live') }
    socket.onerror = () => {
      setHint('帧通道连接失败(宿主路由未挂载或令牌已失效)')
      setStatus('error')
    }
    socket.onclose = () => {
      decoderRef.current?.close()
      decoderRef.current = null
      descriptionRef.current = null
      setStatus('closed')
    }
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string') {
        let parsed: {
          t?: string
          mode?: string
          width?: number
          height?: number
          error?: string | null
          takeover?: boolean
        }
        try {
          parsed = JSON.parse(event.data) as typeof parsed
        } catch {
          return
        }
        if (parsed.t === 'meta') {
          setMeta({
            ...(typeof parsed.mode === 'string' ? { mode: parsed.mode } : {}),
            ...(typeof parsed.width === 'number' ? { width: parsed.width } : {}),
            ...(typeof parsed.height === 'number' ? { height: parsed.height } : {}),
            error: parsed.error ?? null,
          })
          setTakeover(parsed.takeover === true)
          setStatus('live')
          if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
            const canvas = canvasRef.current
            if (canvas !== null && parsed.width > 0 && parsed.height > 0) {
              canvas.width = parsed.width
              canvas.height = parsed.height
            }
          }
          if (typeof parsed.error === 'string' && parsed.error !== '') setHint(parsed.error)
        } else if (parsed.t === 'error' && typeof parsed.error === 'string') {
          setHint(parsed.error)
        }
        return
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      const frame = parseLiveFrame(bytes)
      if (frame === null) return
      if (frame.kind === FRAME_PNG) {
        const blob = new Blob([frame.payload as BlobPart], { type: 'image/png' })
        const image = new Image()
        image.onload = () => { draw(image, image.naturalWidth, image.naturalHeight) }
        image.src = URL.createObjectURL(blob)
        return
      }
      if (frame.kind !== FRAME_H264) return
      const ctor = videoDecoderCtor()
      if (ctor === null) {
        setHint('当前环境不支持 WebCodecs,H.264 实时画面不可用(截图轮询模式同样不可用)')
        return
      }
      if (frame.flags & FLAG_CONFIG) {
        const sets = extractParameterSets(frame.payload)
        if (sets !== null) descriptionRef.current = buildAvcDescription(sets.sps, sets.pps)
        return
      }
      if (decoderRef.current === null && descriptionRef.current !== null) {
        const description = descriptionRef.current
        const decoder = new ctor({
          output: (video) => {
            draw(video as unknown as CanvasImageSource, video.width, video.height)
            video.close()
          },
          error: () => { setHint('H.264 解码失败,画面已停') },
        })
        decoder.configure({
          codec: 'avc1.42E01E',
          // description 只接受 ArrayBufferLike:拷贝进独立 ArrayBuffer,
          // 避免把底层更大缓冲的视图交出去(WebCodecs 要求精确长度)
          description: description.slice().buffer as ArrayBuffer,
          optimizeForLatency: true,
        })
        decoderRef.current = decoder
      }
      decoderRef.current?.decode({ data: frame.payload, timestamp: performance.now() })
    }
    return () => {
      decoderRef.current?.close()
      decoderRef.current = null
      socket.close()
    }
  }, [draw])

  // 通道切换 / 令牌变化:重连。令牌是一次性的,断线重连前先补发一张。
  useEffect(() => {
    if (active === undefined) return
    let cleanup: (() => void) | undefined
    let cancelled = false
    const open = (token: string): void => {
      if (cancelled) return
      cleanup = connect(active.channel, token)
    }
    if (typeof active.token === 'string' && active.token !== '') {
      open(active.token)
    } else {
      void tauriInvoke<{ token?: string }>('live_token', { channel: active.channel })
        .then((result) => { if (typeof result.token === 'string') open(result.token) })
        .catch(() => { setHint('补发直播令牌失败') })
    }
    return () => {
      cancelled = true
      cleanup?.()
      socketRef.current = null
    }
  }, [active, connect])

  /** 把指针事件映射成设备坐标并经 WS 下行。 */
  const sendGesture = useCallback((action: Record<string, unknown>) => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ t: 'input', action }))
  }, [])

  const pointerToDevice = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (canvas === null) return { x: 0, y: 0 }
    const box = canvas.getBoundingClientRect()
    return mapPointerToDevice(event.clientX, event.clientY, box, {
      width: canvas.width,
      height: canvas.height,
    })
  }, [])

  if (active === undefined) return null

  return (
    <div className={css.panel}>
      <div className={css.tabs} role="tablist">
        {state.channels.map((entry) => (
          <span key={entry.channel} className={css.tabSlot}>
            <button
              type="button"
              role="tab"
              aria-selected={entry.channel === active.channel}
              className={clsx(css.tab, entry.channel === active.channel && css.active)}
              onClick={() => { activateChannel(entry.channel) }}
            >
              <span className={css.tabLabel}>{entry.label}</span>
            </button>
            <button
              type="button"
              aria-label={`关闭 ${entry.label}`}
              className={css.tabClose}
              onClick={() => {
                const socket = socketRef.current
                if (entry.channel === active.channel && socket !== null) socket.close()
                void tauriInvoke('live_close', { channel: entry.channel }).catch(() => {})
                closeChannel(entry.channel)
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className={css.bar}>
        <span className={clsx(css.badge, state.mode === 'scrcpy' ? css.badgeLive : css.badgeSlow)}>
          {state.mode === 'scrcpy' ? 'H.264 实时' : '截图轮询'}
        </span>
        <span className={css.dim}>
          {state.width > 0 && state.height > 0 ? `${state.width}×${state.height}` : '分辨率探测中'}
        </span>
        <label className={css.takeover}>
          <input
            type="checkbox"
            checked={state.takeover}
            onChange={(event) => {
              const socket = socketRef.current
              socket?.send(JSON.stringify({ t: 'takeover', active: event.target.checked }))
              // 乐观更新:ack 到达前勾选状态已可点(服务端拒绝时由 meta 回滚)
              setTakeover(event.target.checked)
            }}
          />
          接管(AI 操作暂停)
        </label>
        <span className={css.status}>
          {state.status === 'connecting' && '连接中…'}
          {state.status === 'live' && '已连接'}
          {state.status === 'closed' && '通道已关闭'}
          {state.status === 'error' && '通道错误'}
          {state.status === 'idle' && '空闲'}
        </span>
      </div>
      <div className={css.stage}>
        <canvas
          ref={canvasRef}
          className={css.surface}
          onPointerDown={(event) => {
            if (!state.takeover) return
            const point = pointerToDevice(event)
            sendGesture({ type: 'tap', x: point.x, y: point.y })
          }}
          onWheel={(event) => {
            if (!state.takeover) return
            event.preventDefault()
            sendGesture({
              type: 'scroll',
              direction: event.deltaY > 0 ? 'down' : 'up',
              amount: Math.round(Math.abs(event.deltaY) * 3),
            })
          }}
        />
        {hint !== null && <div className={css.hint}>{hint}</div>}
      </div>
    </div>
  )
}
