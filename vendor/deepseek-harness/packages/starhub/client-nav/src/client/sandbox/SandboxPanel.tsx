/**
 * 沙箱桌面工作面板(工具面板「沙箱桌面」子类):实例卡片(noVNC 围观/接管、
 * 停止/恢复/销毁、回放)+ 模板管理(配方 TOML 编辑/新增/删除)。
 *
 * 安全语义(与 Rust desktop 模块一致):围观 = noVNC view_only;接管 =
 * setTakeover(true) + 双向 noVNC,接管期间 AI 写操作被拒但不撤销授权;
 * 关闭查看器自动退出接管。销毁/停止/恢复走 desktop_ui_lifecycle(用户按钮
 * 即审批表达,不经 AI 工具路径)。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  deleteSandboxTemplate, fetchReplayFrames, fetchSandboxOverview, fileSrc,
  novncUrl, sandboxLifecycle, setTakeover, upsertSandboxTemplate,
  type ReplayFrame, type SandboxInstance, type SandboxOverview, type SandboxTemplate,
} from './services.ts'
import css from './SandboxPanel.module.css'

/** 默认新模板配方(与 Rust recipe::DEFAULT_RECIPE_TOML 对齐)。 */
const NEW_TEMPLATE_RECIPE = `name = "my-template"
base = "ubuntu:24.04"
memory_mb = 2048
cpus = 2.0
network = "restricted"
resolution = "1920x1080"
install = ["mousepad"]
provision = []
`

/** 实例查看器状态:打开的实例 + 是否接管。 */
interface ViewerState {
  instance: SandboxInstance
  takeover: boolean
}

/** 沙箱桌面面板:实例 + 模板两栏。 */
export function SandboxPanel() {
  const [overview, setOverview] = useState<SandboxOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [replay, setReplay] = useState<{ sandboxId: string; frames: ReplayFrame[] } | null>(null)
  const [editing, setEditing] = useState<{ name: string; recipe: string; isNew: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setOverview(await fetchSandboxOverview())
      setError(null)
    } catch (cause) {
      setOverview(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 关闭查看器时自动退出接管(接管互斥不能残留)
  useEffect(() => {
    if (viewer === null) return
    const containerId = viewer.instance.containerId
    return () => { void setTakeover(containerId, false).catch(() => { /* 退出接管尽力而为 */ }) }
  }, [viewer])

  const onLifecycle = async (instance: SandboxInstance, action: 'destroy' | 'pause' | 'resume') => {
    setBusy(`${instance.id}:${action}`)
    try {
      await sandboxLifecycle(instance.id, action)
      if (action === 'destroy' && viewer?.instance.id === instance.id) setViewer(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const onToggleTakeover = async () => {
    if (viewer === null) return
    const next = !viewer.takeover
    try {
      await setTakeover(viewer.instance.containerId, next)
      setViewer({ ...viewer, takeover: next })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onOpenReplay = async (sandboxId: string) => {
    try {
      setReplay({ sandboxId, frames: await fetchReplayFrames(sandboxId) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onSaveTemplate = async () => {
    if (editing === null) return
    setBusy('template:save')
    try {
      await upsertSandboxTemplate(editing.name, editing.recipe)
      setEditing(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const onDeleteTemplate = async (template: SandboxTemplate) => {
    setBusy(`template:${template.name}`)
    try {
      await deleteSandboxTemplate(template.name)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (loading && overview === null) return <div className={css.status}>加载沙箱…</div>
  if (overview === null) {
    return (
      <div className={css.status}>
        <div>沙箱概览不可用:{error ?? '桌面端后端未连接(浏览器预览)'}</div>
        <button type="button" className={css.button} onClick={() => { void refresh() }}>重试</button>
      </div>
    )
  }

  return (
    <div className={css.root}>
      {error !== null && <div className={css.errorBanner}>{error}</div>}

      {viewer !== null ? (
        <div className={css.viewer}>
          <div className={css.viewerBar}>
            <span className={css.viewerTitle}>
              沙箱 {viewer.instance.id.slice(0, 8)} · {viewer.takeover ? '接管中(AI 写操作已暂停)' : '围观中'}
            </span>
            <button
              type="button"
              className={css.button}
              onClick={() => { void onToggleTakeover() }}
            >
              {viewer.takeover ? '退出接管' : '接管'}
            </button>
            <button type="button" className={css.button} onClick={() => { setViewer(null) }}>关闭直播</button>
          </div>
          <iframe
            key={viewer.takeover ? 'takeover' : 'watch'}
            className={css.viewerFrame}
            src={novncUrl(viewer.instance.novncPort, !viewer.takeover)}
            title={`沙箱直播 ${viewer.instance.id}`}
          />
        </div>
      ) : (
        <>
          <section className={css.section}>
            <h3 className={css.sectionTitle}>实例({overview.instances.filter(i => i.status !== 'destroyed').length})</h3>
            {overview.instances.filter(i => i.status !== 'destroyed').length === 0 && (
              <div className={css.status}>没有运行中的沙箱。让 AI 调 desktop_create_sandbox 创建。</div>
            )}
            {overview.instances.filter(i => i.status !== 'destroyed').map(instance => (
              <div key={instance.id} className={css.card}>
                <div className={css.cardMain}>
                  <span className={css.cardTitle}>{instance.task !== '' ? instance.task : instance.id.slice(0, 8)}</span>
                  <span className={css.cardSub}>
                    {instance.status} · 平台 {instance.platform} · noVNC :{instance.novncPort}
                  </span>
                </div>
                <div className={css.cardActions}>
                  <button
                    type="button"
                    className={css.button}
                    onClick={() => { setViewer({ instance, takeover: false }) }}
                  >
                    直播
                  </button>
                  {instance.status === 'running' && (
                    <button type="button" className={css.button} disabled={busy !== null} onClick={() => { void onLifecycle(instance, 'pause') }}>停止</button>
                  )}
                  {instance.status === 'paused' && (
                    <button type="button" className={css.button} disabled={busy !== null} onClick={() => { void onLifecycle(instance, 'resume') }}>恢复</button>
                  )}
                  <button type="button" className={css.button} onClick={() => { void onOpenReplay(instance.id) }}>回放</button>
                  <button
                    type="button"
                    className={`${css.button} ${css.danger}`}
                    disabled={busy !== null}
                    onClick={() => { void onLifecycle(instance, 'destroy') }}
                  >
                    销毁
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className={css.section}>
            <h3 className={css.sectionTitle}>
              模板({overview.templates.length})
              <button
                type="button"
                className={css.button}
                onClick={() => { setEditing({ name: 'my-template', recipe: NEW_TEMPLATE_RECIPE, isNew: true }) }}
              >
                新建模板
              </button>
            </h3>
            {overview.templates.map(template => (
              <div key={template.id} className={css.card}>
                <div className={css.cardMain}>
                  <span className={css.cardTitle}>{template.name}</span>
                  <span className={css.cardSub}>{template.imageTag !== null ? `镜像 ${template.imageTag}` : '未构建'}</span>
                </div>
                <div className={css.cardActions}>
                  <button
                    type="button"
                    className={css.button}
                    onClick={() => { setEditing({ name: template.name, recipe: template.recipe, isNew: false }) }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.danger}`}
                    disabled={busy !== null}
                    onClick={() => { void onDeleteTemplate(template) }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {editing !== null && (
        <div className={css.dialogMask}>
          <div className={css.dialog} role="dialog" aria-label="编辑模板">
            <h3 className={css.sectionTitle}>{editing.isNew ? '新建模板' : `编辑模板 ${editing.name}`}</h3>
            <textarea
              className={css.recipeEditor}
              value={editing.recipe}
              rows={12}
              onChange={event => { setEditing({ ...editing, recipe: event.target.value }) }}
            />
            <div className={css.cardActions}>
              <button type="button" className={css.button} disabled={busy !== null} onClick={() => { void onSaveTemplate() }}>保存</button>
              <button type="button" className={css.button} onClick={() => { setEditing(null) }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {replay !== null && (
        <div className={css.dialogMask}>
          <div className={css.dialog} role="dialog" aria-label="沙箱回放">
            <h3 className={css.sectionTitle}>回放:{replay.sandboxId.slice(0, 8)}({replay.frames.length} 帧)</h3>
            <div className={css.replayList}>
              {replay.frames.length === 0 && <div className={css.status}>该沙箱没有回放帧</div>}
              {replay.frames.map((frame, index) => (
                <div key={index} className={css.replayRow}>
                  <span className={css.cardSub}>
                    #{index + 1} {frame.action} · {new Date(frame.createdAt * 1000).toLocaleTimeString()}
                  </span>
                  {frame.shotPath !== null && fileSrc(frame.shotPath) !== '' && (
                    <img className={css.replayShot} src={fileSrc(frame.shotPath)} alt={`帧 ${index + 1}`} />
                  )}
                </div>
              ))}
            </div>
            <div className={css.cardActions}>
              <button type="button" className={css.button} onClick={() => { setReplay(null) }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
