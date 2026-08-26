/**
 * 设置「打开配置文件」壳内编辑按钮(2026-08-x,插件形式):dsh 上游默认的
 * settings.action 把配置文件交给原生打开器(外跳系统应用)。这里由 StarHub
 * 插件注册自己的 settings.action,读取 settings.yaml 路径后经 starhubFileViewer
 * 在壳内打开(read 模式,支持编辑保存)——不修改上游工具视图,纯粹以插件
 * 贡献槽位的方式覆盖行为。
 *
 * 数据流:
 * 1. 点击 → 经 Tauri `dsh_settings_path` 取 settings.yaml 绝对路径
 *    (与 web GUI 的 DSH_SETTINGS_PATH 同源,见 build_spawn_env);
 * 2. 经注入的 openInShell 回调(starhubFileViewer.open)在壳内打开该路径,
 *    复用 FileViewerOverlay 的读改写与「保存」。
 * 3. 浏览器预览无 Tauri IPC 时静默降级(不弹外跳,展示一行提示)。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { dshSettingsPath } from '../tauri.ts'
import css from './OpenConfigAction.module.css'

/** 注册注入面:壳内打开回调 + 当前会话 id。 */
export interface OpenConfigActionInjected {
  /** 在壳内打开给定路径(read 模式,可编辑)。 */
  openInShell: (target: { kind: 'read'; path: string; sessionId: string }) => void
  /** 当前会话 id(FileViewerTarget 需要;无会话时回退空串)。 */
  sessionId: SessionId | undefined
}

/** Full composed props: settings-action owner share + injected face. */
export type OpenConfigActionProps =
  & PropsRuntime<'settings.action'>
  & InjectFace<OpenConfigActionInjected>

/**
 * Render the in-shell config-file open action.
 * @param props - owner share + the injected open callback and session id.
 * @returns the action button; opens settings.yaml in-shell on click.
 */
export function OpenConfigAction({ openInShell, sessionId }: OpenConfigActionProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = (): void => {
    setBusy(true)
    setError(null)
    dshSettingsPath()
      .then((path) => {
        openInShell({ kind: 'read', path, sessionId: sessionId as string ?? '' })
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { setBusy(false) })
  }
  return (
    <div className={css.action}>
      {error === null ? null : <span className={css.error} role="alert">{error}</span>}
      <Button variant="outline" size="sm" disabled={busy} onClick={open}>
        打开配置文件
      </Button>
    </div>
  )
}
