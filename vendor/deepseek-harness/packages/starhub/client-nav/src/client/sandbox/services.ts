/**
 * 沙箱桌面前端服务:desktop_ui_* / desktop_set_takeover / desktop_user_action_reply
 * 的 Tauri 命令封装 + 「请求人工介入」事件监听。全部经 client-nav 的
 * tauriInvoke/tauriListen 桥(浏览器预览时调用方自行降级)。
 */
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'

/** 沙箱实例(UI 投影)。 */
export interface SandboxInstance {
  id: string
  containerId: string
  platform: string
  novncPort: number
  status: string
  task: string
  createdAt: number
}

/** 沙箱模板(UI 投影)。 */
export interface SandboxTemplate {
  id: string
  name: string
  recipe: string
  imageTag: string | null
  createdAt: number
}

/** desktop_ui_overview 返回的聚合。 */
export interface SandboxOverview {
  instances: SandboxInstance[]
  templates: SandboxTemplate[]
  platformAssetId: string | null
}

/** 「请求人工介入」横幅事件(starhub://desktop-user-action)。 */
export interface DesktopUserActionEvent {
  requestId: string
  sandboxId: string
  containerId: string
  novncPort: number
  message: string
  timeoutSeconds: number
}

/** 回放帧。 */
export interface ReplayFrame {
  action: string
  shotPath: string | null
  createdAt: number
}

/** Docker 连接资产(平台选择器候选)。 */
export interface DockerAssetOption {
  id: string
  name: string
}

export function fetchSandboxOverview(): Promise<SandboxOverview> {
  return tauriInvoke<SandboxOverview>('desktop_ui_overview')
}

export function setSandboxPlatform(assetId: string | null): Promise<void> {
  return tauriInvoke('desktop_ui_set_platform', { assetId })
}

export function upsertSandboxTemplate(name: string, recipeToml: string): Promise<void> {
  return tauriInvoke('desktop_ui_upsert_template', { name, recipeToml })
}

export function deleteSandboxTemplate(name: string): Promise<void> {
  return tauriInvoke('desktop_ui_delete_template', { name })
}

export function fetchReplayFrames(sandboxId: string): Promise<ReplayFrame[]> {
  return tauriInvoke<{ frames: ReplayFrame[] }>('desktop_ui_replay_frames', { sandboxId })
    .then(result => result.frames)
}

/** 停止(pause)/恢复(resume)/销毁(destroy)。 */
export function sandboxLifecycle(sandboxId: string, action: 'destroy' | 'pause' | 'resume'): Promise<string> {
  return tauriInvoke<string>('desktop_ui_lifecycle', { sandboxId, action })
}

/** 直播窗口目标(实例卡片或「请求人工介入」事件都够用)。 */
export interface LiveWindowTarget {
  id: string
  containerId: string
  novncPort: number
}

/**
 * 打开沙箱直播独立 Tauri 窗口(全页 noVNC,不再是侧边栏 iframe——
 * 内嵌尺寸太小且 iframe permissions-policy 禁用全屏)。takeover=false
 * 围观(view_only);true 接管(双向 + 接管互斥,窗口关闭由 Rust 自动
 * 释放接管)。同沙箱重复打开 = 关旧窗开新窗(围观 ⇄ 接管切换)。
 */
export function openSandboxLiveWindow(target: LiveWindowTarget, takeover: boolean): Promise<void> {
  return tauriInvoke('desktop_ui_open_live_window', {
    sandboxId: target.id,
    containerId: target.containerId,
    novncPort: target.novncPort,
    takeover,
  })
}

/** 「请求人工介入」应答:done=true 已完成,false 无法完成。 */
export function replyUserAction(requestId: string, done: boolean): Promise<void> {
  return tauriInvoke('desktop_user_action_reply', { requestId, done })
}

/** 订阅「请求人工介入」横幅事件;返回退订函数。 */
export function onUserActionRequest(handler: (event: DesktopUserActionEvent) => void): Promise<TauriUnlisten> {
  return tauriListen<DesktopUserActionEvent>('starhub://desktop-user-action', handler)
}

/** 列出全部 Docker 类型资产(平台选择器候选)。 */
export function listDockerAssets(): Promise<DockerAssetOption[]> {
  return tauriInvoke<Array<{ id: string; type: string; name: string }>>('get_assets')
    .then(assets => assets.filter(a => a.type === 'docker').map(a => ({ id: a.id, name: a.name })))
}

/**
 * 本地文件路径 → webview 可加载 URL(回放截图)。Tauri 2 的
 * convertFileSrc 挂在 __TAURI_INTERNALS__ 上;无注入(浏览器预览)返回空串。
 */
export function fileSrc(path: string): string {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { convertFileSrc?: (p: string) => string }
  }).__TAURI_INTERNALS__
  return internals?.convertFileSrc !== undefined ? internals.convertFileSrc(path) : ''
}

/** noVNC 直播 URL 由 Rust desktop_ui_open_live_window 构造(独立窗口全页加载),前端不再内嵌。 */
