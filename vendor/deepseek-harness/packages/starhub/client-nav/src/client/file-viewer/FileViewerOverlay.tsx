/**
 * 壳内文件查看窗(2026-08-21):对话里 Read/Edit 等工具卡的文件名点击后在
 * 壳内开窗查看——Read 卡看当前文件内容,Edit 卡看「变更前 / 变更后」左右两栏。
 *
 * 编辑门禁:AI 运行中(会话 running)只读并提示「AI 运行中只能查看」;空闲时
 * 可编辑——Read 直接保存当前内容;Edit 的右栏保存时把各 hunk 的 oldText→newText
 * 应用到最新文件内容再写回(找不到 oldText 的 hunk 报错,不落盘)。
 *
 * 对比着色(2026-08-22):两栏默认按行级 diff 渲染——变更行带红(-)/绿(+)色块,
 * 两侧共有的行保持无色;空闲时右栏栏头的「编辑」切成纯文本编辑态,编辑后切回
 * 「查看对比」即按当前内容重新着色。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { readLocalTextFile, writeLocalTextFile } from './file-service.ts'
import { diffLines } from './diff-lines.ts'
import type { FileViewDiff, FileViewTarget, FileViewerState } from './state.ts'
import css from './FileViewerOverlay.module.css'

/** 注册注入面:查看窗 hooks 舱位 + 关闭回调。 */
export interface FileViewerInjected {
  /** 关闭查看窗。 */
  readonly closeViewer: () => void
  readonly hooks: {
    /** 查看窗状态裸 source(渲染器绑定为 useFileViewer)。 */
    readonly fileViewer: SnapshotStore<FileViewerState>
  }
}

/** Full composed props: overlay runtime share + injected face. */
export type FileViewerOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<FileViewerInjected>

/** 把 edit 请求的 hunk 串成展示文本(各 hunk 以分隔线相连)。 */
const HUNK_SEPARATOR = '\n\n// ── ── ── ── ──\n\n'

function joinHunks(target: Extract<FileViewTarget, { kind: 'edit' }>, field: 'oldText' | 'newText'): string {
  return target.diffs.map(d => d[field]).join(HUNK_SEPARATOR)
}

/**
 * 应用 edit 保存:把每个 hunk 的 oldText 首次出现处替换为(编辑后的)newText。
 * @param content - 最新文件内容。
 * @param diffs - 原始 hunk(oldText 定位)+ 用户编辑后的 newText(与 hunk 等长)。
 * @returns 应用后的内容;任一 oldText 找不到抛错。
 */
export function applyDiffs(content: string, diffs: readonly { oldText: string; newText: string }[]): string {
  let out = content
  for (const [index, diff] of diffs.entries()) {
    if (diff.oldText === '') {
      throw new Error(`第 ${index + 1} 处变更为纯新增,无法定位,请手动编辑`)
    }
    const at = out.indexOf(diff.oldText)
    if (at === -1) {
      throw new Error(`第 ${index + 1} 处变更前的内容在文件中找不到(文件可能已被改动)`)
    }
    out = out.slice(0, at) + diff.newText + out.slice(at + diff.oldText.length)
  }
  return out
}

/**
 * 一个 hunk 的着色渲染:每行一个色块,变更行带 +/- 号 gutter 与红/绿底色,
 * 两侧共有的行保持无色。
 */
function DiffLines({ text, tone, flags }: {
  text: string
  tone: 'add' | 'del'
  flags: readonly boolean[]
}) {
  const lines = text === '' ? [] : text.split('\n')
  return (
    <pre className={css.diffView}>
      {lines.map((line, index) => {
        const changedLine = flags[index] === true
        const cls = changedLine ? (tone === 'add' ? css.lineAdd : css.lineDel) : css.lineSame
        return (
          <div key={index} className={cls}>
            <span className={css.sign}>{changedLine ? (tone === 'add' ? '+' : '-') : ' '}</span>
            <span className={css.lineText}>{line === '' ? ' ' : line}</span>
          </div>
        )
      })}
    </pre>
  )
}

/**
 * 渲染文件查看窗。
 * @param props - composed slot props(overlay 运行时份额 + inject 面)。
 * @returns Modal;无目标时不渲染。
 */
export function FileViewerOverlay({ useSessions, useFileViewer, closeViewer }: FileViewerOverlayProps) {
  const viewer = useFileViewer(s => s)
  const target = viewer.target
  const running = useSessions(s => (
    target === null ? false : s.byId[target.sessionId as SessionId]?.running ?? false
  ))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** read: 文件当前内容;edit: 左栏(变更前)。 */
  const [before, setBefore] = useState('')
  /** read: 编辑草稿;edit: 右栏(变更后,各 hunk newText 以分隔线相连)。 */
  const [after, setAfter] = useState('')
  const [saving, setSaving] = useState(false)
  /** edit 模式:右栏是否处于纯文本编辑态(默认查看红绿对比)。 */
  const [editing, setEditing] = useState(false)

  // 逐 hunk 行级 diff:只在 before/after 变化时重算;编辑态切回对比视图即
  // 按当前右栏内容重新着色。
  const hunkFlags = useMemo(() => {
    if (target === null || target.kind !== 'edit') return []
    const newSegments = after.split(HUNK_SEPARATOR)
    return before.split(HUNK_SEPARATOR).map((segment, index) => diffLines(segment, newSegments[index] ?? ''))
  }, [target, before, after])

  // 打开新目标时装载:read 读当前文件;edit 用 hunk 文本。
  useEffect(() => {
    if (target === null) return
    setError(null)
    setNotice(null)
    setSaving(false)
    setEditing(false)
    let cancelled = false
    if (target.kind === 'read') {
      setLoading(true)
      setBefore('')
      setAfter('')
      readLocalTextFile(target.path)
        .then((result) => {
          if (cancelled) return
          setBefore(result.content)
          setAfter(result.content)
          if (result.truncated) setNotice('文件较大,只加载了前 256KB;保存会写回已加载部分,请谨慎操作')
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    } else {
      setBefore(joinHunks(target, 'oldText'))
      setAfter(joinHunks(target, 'newText'))
      setLoading(false)
    }
    return () => { cancelled = true }
  }, [target])

  const save = useCallback(async () => {
    if (target === null || saving || running) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      if (target.kind === 'read') {
        await writeLocalTextFile(target.path, after)
      } else {
        // edit:右栏按分隔线拆回各 hunk 的 newText;段数不一致(用户动了
        // 分隔线)时拒绝保存,避免把整栏文本当作文件内容写回。
        const parts = after.split(HUNK_SEPARATOR)
        if (parts.length !== target.diffs.length) {
          throw new Error('右栏内容与变更段数不一致(分隔线被改动),无法保存;请保持各段之间的分隔线不变')
        }
        const latest = await readLocalTextFile(target.path)
        const applied = applyDiffs(
          latest.content,
          target.diffs.map((d: FileViewDiff, i: number) => ({ oldText: d.oldText, newText: parts[i] ?? d.newText })),
        )
        await writeLocalTextFile(target.path, applied)
      }
      setNotice('已保存')
      setBefore(after)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [target, after, saving, running])

  if (target === null) return null
  const dirty = after !== before
  const title = target.kind === 'read' ? `查看文件 — ${target.path}` : `变更对比 — ${target.path}`

  return (
    <Modal
      open
      onClose={closeViewer}
      title={title}
      className={css.viewer ?? ''}
      footer={(
        <>
          {running && <span className={css.runningHint}>AI 运行中只能查看</span>}
          <span className={css.footerSpacer} />
          <button type="button" className={css.btn} onClick={closeViewer}>关闭</button>
          <button
            type="button"
            className={css.btnPrimary}
            disabled={running || saving || loading || !dirty}
            title={running ? 'AI 运行中只能查看' : undefined}
            onClick={() => { void save() }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      {running && (
        <div className={css.banner} role="status">AI 运行中只能查看,暂不支持修改</div>
      )}
      {loading && <div className={css.banner}>读取中…</div>}
      {error !== null && <div className={css.bannerError} role="alert">{error}</div>}
      {notice !== null && <div className={css.banner}>{notice}</div>}
      {target.kind === 'read' ? (
        <textarea
          className={css.editor}
          value={after}
          readOnly={running || loading}
          spellCheck={false}
          onChange={(ev) => { setAfter(ev.target.value) }}
        />
      ) : (
        <div className={css.columns}>
          <div className={css.column}>
            <div className={css.columnHead}>变更前</div>
            {before.split(HUNK_SEPARATOR).map((segment, index) => (
              <Fragment key={index}>
                {index > 0 && <div className={css.hunkDivider} aria-hidden="true" />}
                <DiffLines
                  text={segment}
                  tone="del"
                  flags={hunkFlags[index]?.before ?? []}
                />
              </Fragment>
            ))}
          </div>
          <div className={css.column}>
            <div className={css.columnHead}>
              变更后
              {!running && (
                <button
                  type="button"
                  className={css.headToggle}
                  onClick={() => { setEditing(value => !value) }}
                >
                  {editing ? '查看对比' : '编辑'}
                </button>
              )}
            </div>
            {editing && !running ? (
              <textarea
                className={css.editor}
                value={after}
                spellCheck={false}
                onChange={(ev) => { setAfter(ev.target.value) }}
              />
            ) : (
              after.split(HUNK_SEPARATOR).map((segment, index) => (
                <Fragment key={index}>
                  {index > 0 && <div className={css.hunkDivider} aria-hidden="true" />}
                  <DiffLines
                    text={segment}
                    tone="add"
                    flags={hunkFlags[index]?.after ?? []}
                  />
                </Fragment>
              ))
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
