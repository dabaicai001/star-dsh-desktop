/**
 * 壳内直播/接管面板的通道簿(去 Tauri 化 M3「面板化」)。
 *
 * Tauri 壳退役前,直播/接管是独立 webview 窗口(`android-live://` /
 * `obscura-live://` custom protocol + 自包含页)。新架构里它是 dsh 主壳内的
 * 一个 keyed 主面板(`main` 槽 key=`starhub-live`):一条通道一页,帧与输入走
 * 宿主 upgrade 路由 `/starhub/live`(见 `starhub-bridge` 的 `src/live.ts`,
 * 它把字节中继到 sidecar 的本地 WS)。
 *
 * 簿语义与工作台页簿对齐(同一套心智):
 * - `open`:同通道已开 → 只激活(不开第二份 WS);
 * - `close`:关一条通道(组件退订 → sidecar 侧最后一个订阅者离开即回收源);
 * - 簿空 → 面板让回工具列表(index.ts 的订阅负责切面板)。
 *
 * 帧本身**不进 store**:H.264 12fps / PNG 400ms 的载荷走 store 会引发无谓
 * 重渲染,由组件直接画到 canvas/img。store 只承载通道清单、连接状态与元数据
 * (模式/分辨率/接管标志),这些才是要渲染的东西。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { tauriInvoke } from '../tauri.ts'

/** 一条直播通道(帧枢纽侧的身份 + 面板侧的一次性令牌)。 */
export interface LiveChannel {
  /** 稳定身份(`android:<serial>` / `browser:<key>` / `desktop:<id>`)。 */
  readonly channel: string
  /** 通道类型(android / browser / desktop)。 */
  readonly kind: string
  /** 一次性令牌(sidecar 在 WS 握手中消费;面板刷新后经 `ui.live_token` 补发)。 */
  token: string
  /** 展示名(设备型号 / serial / 实例名)。 */
  readonly label: string
}

/** 连接状态(面板据此显示 connecting / live / error)。 */
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error'

/** 通道簿状态。 */
export interface LivePanelState {
  readonly channels: readonly LiveChannel[]
  readonly activeChannel: string | null
  readonly status: LiveStatus
  /** 帧模式:`frames`(截图轮询)| `scrcpy`(H.264 实时)| 源自定义值。 */
  readonly mode: string
  /** 设备物理分辨率(坐标映射用;0 = 尚未拿到)。 */
  readonly width: number
  readonly height: number
  /** 降级原因(scrcpy 不可用 / adb 缺失;null = 无)。 */
  readonly error: string | null
  /** 接管中(AI 写操作互斥)。 */
  readonly takeover: boolean
}

/** 通道簿:裸 observable(供 inject hooks 下发)+ 写入回调。 */
export interface LivePanelStore {
  readonly source: SnapshotStore<LivePanelState>
  readonly open: (channel: LiveChannel) => void
  readonly activate: (channel: string) => void
  readonly close: (channel: string) => void
  readonly setStatus: (status: LiveStatus, error?: string | null) => void
  readonly setMeta: (meta: { mode?: string; width?: number; height?: number; error?: string | null }) => void
  readonly setTakeover: (takeover: boolean) => void
  /** 刷新当前通道的令牌(重连用;失败时抛,由调用方打日志)。 */
  readonly refreshToken: () => Promise<void>
}

/** `ui.live_open` 的结果信封(sidecar M3 方法面)。 */
interface LiveOpenResult {
  readonly endpoint?: string
  readonly token?: string
  readonly channel?: {
    readonly channel?: string
    readonly kind?: string
    readonly mode?: string
    readonly width?: number
    readonly height?: number
    readonly error?: string | null
  }
}

/**
 * Create the live-channel store.
 * @returns the channel store (bare source + write callbacks).
 */
export function createLivePanelStore(): LivePanelStore {
  const source = createSnapshotStore<LivePanelState>({
    channels: [],
    activeChannel: null,
    status: 'idle',
    mode: 'frames',
    width: 0,
    height: 0,
    error: null,
    takeover: false,
  })
  return {
    source,
    open: (channel) => {
      const state = source.getSnapshot()
      const existing = state.channels.find((entry) => entry.channel === channel.channel)
      if (existing !== undefined) {
        // 已开:聚焦并换上新令牌(旧令牌已被上一次握手消费)。store 快照是冻结的,
        // 必须整条替换通道对象,不能就地改 token。帧模式/分辨率/接管标志保留
        // (通道没变,只是重连)。
        source.set({
          ...state,
          channels: state.channels.map((entry) => (
            entry.channel === channel.channel ? channel : entry
          )),
          activeChannel: channel.channel,
          status: 'connecting',
          error: null,
        })
        return
      }
      source.set({
        channels: [...state.channels, channel],
        activeChannel: channel.channel,
        status: 'connecting',
        mode: 'frames',
        width: 0,
        height: 0,
        error: null,
        takeover: false,
      })
    },
    activate: (channel) => {
      const state = source.getSnapshot()
      if (!state.channels.some((entry) => entry.channel === channel)) return
      if (state.activeChannel === channel) return
      source.set({ ...state, activeChannel: channel, status: 'connecting', error: null })
    },
    close: (channel) => {
      const state = source.getSnapshot()
      const channels = state.channels.filter((entry) => entry.channel !== channel)
      if (channels.length === state.channels.length) return
      const activeChannel = state.activeChannel === channel
        ? (channels[channels.length - 1]?.channel ?? null)
        : state.activeChannel
      source.set({
        channels,
        activeChannel,
        status: activeChannel === null ? 'idle' : 'connecting',
        mode: 'frames',
        width: 0,
        height: 0,
        error: null,
        takeover: false,
      })
    },
    setStatus: (status, error = null) => {
      source.set({ ...source.getSnapshot(), status, error })
    },
    setMeta: (meta) => {
      const state = source.getSnapshot()
      source.set({
        ...state,
        mode: meta.mode ?? state.mode,
        width: meta.width ?? state.width,
        height: meta.height ?? state.height,
        error: meta.error === undefined ? state.error : meta.error,
      })
    },
    setTakeover: (takeover) => {
      source.set({ ...source.getSnapshot(), takeover })
    },
    refreshToken: async () => {
      const state = source.getSnapshot()
      const current = state.channels.find((entry) => entry.channel === state.activeChannel)
      if (current === undefined) return
      const result = await tauriInvoke<{ token?: string }>('live_token', { channel: current.channel })
      if (typeof result.token !== 'string' || result.token === '') return
      source.set({
        ...state,
        channels: state.channels.map((entry) => (
          entry.channel === current.channel ? { ...entry, token: result.token as string } : entry
        )),
      })
    },
  }
}

/**
 * 直播面板宿主:装了宿主(apply 层)就把「开直播」改为「开壳内直播面板通道」。
 * 与 `installWorkbenchPageHost` 同一范式;没装(浏览器预览 / 单测)时
 * `openAndroidLive` 仍然打通侧,只是没有面板可切。
 */
export type LivePanelHost = (channel: LiveChannel) => void

let livePanelHost: LivePanelHost | null = null

/**
 * Install (or clear) the in-shell live-panel host.
 * @param host - receives the opened channel (the host stores it and switches
 *   the main panel); null restores the preview behaviour (no panel switch).
 */
export function installLivePanelHost(host: LivePanelHost | null): void {
  livePanelHost = host
}

/**
 * 打开一台 Android 设备的直播通道并(装了宿主时)切到直播面板。
 * @param serial - 设备 serial。
 * @param label - 展示名(型号优先,回退 serial)。
 * @returns 开好的通道(宿主据此入簿);调用失败时抛(调用方展示错误横幅)。
 */
export async function openAndroidLive(serial: string, label: string): Promise<LiveChannel> {
  const result = await tauriInvoke<LiveOpenResult>('android_ui_open_live', { serial })
  const token = typeof result.token === 'string' ? result.token : ''
  if (token === '') throw new Error('直播通道未返回一次性令牌')
  const channel: LiveChannel = {
    channel: result.channel?.channel ?? `android:${serial}`,
    kind: result.channel?.kind ?? 'android',
    token,
    label: label === '' ? serial : label,
  }
  livePanelHost?.(channel)
  return channel
}
