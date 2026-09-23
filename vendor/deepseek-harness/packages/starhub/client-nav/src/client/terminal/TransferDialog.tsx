/**
 * SFTP 传输任务弹框(2026-09-11,传输中心):从内联区块升级为独立 Dialog。
 *
 * - 任务级聚合进度条(taskTransferred/taskTotal,多文件不回跳)+ 当前文件名 +
 *   实时速度 / 剩余时间(事件差分,useTransferTasks 提供);
 * - 逐文件明细可展开(当前文件高亮);
 * - 暂停 / 继续 / 取消 / 重试(失败与已取消都可,断点续传)/ 单条删除 /
 *   全部暂停 / 清除已完成 / 下载完成「打开目录」;
 * - 失败原因完整展示 + 复制,终态任务保留到手动清除(不再 4 秒自动消失);
 * - 运行中可动态调整限速(KB/s,0 = 不限)。
 *
 * 数据来自 overlay 级 useTransferTasks 投影(关面板传输不丢);本组件只做
 * 展示与动作编排,动作失败在行内通知条呈现。
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  IconCloseOutlineMedium, IconCopyOutlineMedium, IconDownloadOutlineMedium, IconFolderOpenOutlineMedium,
  IconPauseOutlineMedium, IconPlayOutlineMedium, IconRefreshOutlineMedium, IconTrashOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  formatSize, sftpCancelTransfer, sftpPauseTransfer, sftpResumeTransfer,
  sftpRetryTransfer, sftpRevealLocal, sftpSetSpeedLimit,
  type TransferTask,
} from './sftp-service.ts'
import type { TransferTasksApi } from './use-transfer-tasks.ts'
import css from './TransferDialog.module.css'

/** 弹框 props:会话 id + overlay 级任务投影 + 开关。 */
export interface TransferDialogProps {
  readonly sessionId: string
  readonly api: TransferTasksApi
  readonly onClose: () => void
}

/** 状态徽标文案。 */
const STATUS_LABEL: Record<TransferTask['status'], string> = {
  queued: '排队中',
  running: '传输中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 任务摘要名:单文件显示文件名,多文件显示「首文件 等 N 个」。 */
function taskTitle(t: TransferTask): string {
  if (t.files.length === 0) return t.direction === 'upload' ? '上传任务' : '下载任务'
  /* v8 ignore next -- files[0] 必然存在(length===0 已提前返回),`?.`/`??` 仅为 TS 索引类型收窄 */
  const first = t.files[0]?.name ?? ''
  return t.files.length === 1 ? first : `${first} 等 ${t.files.length} 个文件`
}

/** 剩余时间估算(秒 → 可读文本);速度为 0 时返回 null。 */
function etaText(remaining: number, speed: number): string | null {
  if (speed <= 0) return null
  const sec = Math.ceil(remaining / speed)
  if (sec < 60) return `剩 ${sec}s`
  if (sec < 3600) return `剩 ${Math.floor(sec / 60)}m${sec % 60}s`
  return `剩 ${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`
}

/**
 * 渲染传输任务弹框。
 * @param props - 会话 id、任务投影与关闭回调。
 * @returns 弹框 markup。
 */
export function TransferDialog({ sessionId, api, onClose }: TransferDialogProps) {
  const { tasks, speeds, activeFiles, clearFinished } = api
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  /** 逐文件明细展开态。 */
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({})
  /** 限速输入草稿(KB/s 文本)。 */
  const [limitDraft, setLimitDraft] = useState<Readonly<Record<string, string>>>({})

  /** 动作执行:busy 门 + 行内通知(沿用面板 transferAction 范式)。 */
  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    /* v8 ignore next 2 -- busy 期间所有入口按钮均 disabled,此门仅防重渲染前连点的竞态 */
    if (busy !== '') return
    setBusy(label)
    setNotice(null)
    try {
      await action()
      setNotice({ kind: 'ok', text: `${label}成功` })
    } catch (e) {
      setNotice({ kind: 'error', text: `${label}失败: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy('')
    }
  }

  const finishedCount = tasks.filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled').length

  return (
    <div className={css.backdrop} role="presentation" onClick={onClose}>
      <section
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="SFTP 传输任务"
        onClick={event => event.stopPropagation()}
      >
        <header className={css.header}>
          <span className={css.title}>
            传输任务
            {api.activeCount > 0 && <span className={css.countBadge}>{api.activeCount}</span>}
          </span>
          <span className={css.spacer} />
          <button
            type="button"
            className={css.headBtn}
            disabled={api.activeCount === 0 || busy !== ''}
            onClick={() => void run('全部暂停', async () => {
              for (const t of tasks) {
                if (t.status === 'running' || t.status === 'queued') {
                  await sftpPauseTransfer(sessionId, t.id)
                }
              }
            })}
          >全部暂停</button>
          <button
            type="button"
            className={css.headBtn}
            disabled={finishedCount === 0 || busy !== ''}
            title="移除已完成 / 失败 / 已取消的任务记录"
            onClick={() => { clearFinished() }}
          >清除已完成</button>
          <button type="button" className={css.iconBtn} onClick={onClose} aria-label="关闭传输任务">
            <IconCloseOutlineMedium size={14} />
          </button>
        </header>

        {notice !== null && (
          <div className={notice.kind === 'ok' ? css.noticeOk : css.noticeError} role="status">
            {notice.text}
          </div>
        )}

        <div className={css.body}>
          {tasks.length === 0 && <div className={css.empty}>暂无传输任务</div>}
          {tasks.map(t => (
            <TransferRow
              key={t.id}
              task={t}
              sessionId={sessionId}
              speed={speeds[t.id] ?? 0}
              activeFile={activeFiles[t.id]}
              expanded={expanded[t.id] === true}
              limitDraft={limitDraft[t.id] ?? ''}
              busy={busy !== ''}
              onToggleExpand={() => { setExpanded(prev => ({ ...prev, [t.id]: !(prev[t.id] === true) })) }}
              onLimitDraft={(value) => { setLimitDraft(prev => ({ ...prev, [t.id]: value })) }}
              onRun={run}
              onDismiss={() => { clearFinished(t.id) }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

/** 单行任务卡。 */
function TransferRow(props: {
  readonly task: TransferTask
  readonly sessionId: string
  readonly speed: number
  readonly activeFile: string | undefined
  readonly expanded: boolean
  readonly limitDraft: string
  readonly busy: boolean
  readonly onToggleExpand: () => void
  readonly onLimitDraft: (value: string) => void
  readonly onRun: (label: string, action: () => Promise<unknown>) => Promise<void>
  readonly onDismiss: () => void
}) {
  const {
    task: t, sessionId, speed, activeFile, expanded, limitDraft, busy,
    onToggleExpand, onLimitDraft, onRun, onDismiss,
  } = props
  const pct = t.totalBytes > 0 ? Math.min(100, Math.round((t.transferredBytes / t.totalBytes) * 100)) : 0
  const eta = t.status === 'running' ? etaText(t.totalBytes - t.transferredBytes, speed) : null
  const terminal = t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'

  return (
    <div className={clsx(css.row, t.status === 'failed' && css.rowFailed)}>
      <div className={css.rowHead}>
        <span
          className={clsx(css.dirIcon, t.direction === 'upload' && css.dirIconUp)}
          title={t.direction === 'upload' ? '上传' : '下载'}
        >
          <IconDownloadOutlineMedium size={14} />
        </span>
        <span className={css.rowTitle} title={taskTitle(t)}>{taskTitle(t)}</span>
        <span className={clsx(css.statusBadge, css[`st-${t.status}`])}>{STATUS_LABEL[t.status]}</span>
      </div>

      <div className={css.track} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={clsx(css.fill, t.status === 'failed' && css.fillFailed, t.status === 'done' && css.fillDone)} style={{ width: `${pct}%` }} />
      </div>
      <div className={css.metaLine}>
        <span>{pct}% · {formatSize(t.transferredBytes)} / {formatSize(t.totalBytes)}</span>
        {t.status === 'running' && speed > 0 && <span>{formatSize(speed)}/s</span>}
        {eta !== null && <span>{eta}</span>}
      </div>
      {t.status === 'running' && activeFile !== undefined && activeFile !== '' && (
        <div className={css.currentFile} title={activeFile}>当前:{activeFile}</div>
      )}
      {t.error !== null && t.error !== undefined && t.error !== '' && (
        <div className={css.errorLine}>
          <span className={css.errorText}>{t.error}</span>
          <button
            type="button"
            className={css.miniBtn}
            title="复制错误信息"
            onClick={() => {
              /* v8 ignore next -- error 在本块内已判空(渲染条件),`?? ''` 仅为 TS 收窄进闭包 */
              void navigator.clipboard.writeText(t.error ?? '')
            }}
          ><IconCopyOutlineMedium size={11} /></button>
        </div>
      )}

      {(t.status === 'running' || t.status === 'paused') && (
        <div className={css.limitLine}>
          <span className={css.limitLabel}>限速 KB/s(0 不限)</span>
          <input
            className={css.limitInput}
            type="number"
            min={0}
            placeholder={String(Math.round((t.speedLimit ?? 0) / 1024))}
            value={limitDraft}
            onChange={event => { onLimitDraft(event.target.value) }}
          />
          <button
            type="button"
            className={css.miniBtn}
            disabled={busy || limitDraft === ''}
            onClick={() => void onRun('设置限速', () => {
              // NaN(空/非数字草稿,> 比较恒 false)与 0 都落到不限速
              const kb = Number.parseInt(limitDraft, 10)
              return sftpSetSpeedLimit(sessionId, t.id, kb > 0 ? kb * 1024 : 0)
            })}
          >应用</button>
        </div>
      )}

      <div className={css.rowActions}>
        {t.status === 'running' && (
          <button type="button" className={css.miniBtn} disabled={busy}
            onClick={() => void onRun('暂停', () => sftpPauseTransfer(sessionId, t.id))}>
            <IconPauseOutlineMedium size={11} />暂停
          </button>
        )}
        {t.status === 'paused' && (
          <button type="button" className={css.miniBtn} disabled={busy}
            onClick={() => void onRun('继续', () => sftpResumeTransfer(sessionId, t.id))}>
            <IconPlayOutlineMedium size={11} />继续
          </button>
        )}
        {!terminal && (
          <button type="button" className={css.miniBtnDanger} disabled={busy}
            onClick={() => void onRun('取消', () => sftpCancelTransfer(sessionId, t.id))}>
            取消
          </button>
        )}
        {(t.status === 'failed' || t.status === 'cancelled') && (
          <button type="button" className={css.miniBtn} disabled={busy}
            title="从断点处续传(复用本任务)"
            onClick={() => void onRun('重试', () => sftpRetryTransfer(sessionId, t.id))}>
            <IconRefreshOutlineMedium size={11} />重试
          </button>
        )}
        {t.status === 'done' && t.direction === 'download' && typeof t.downloadLocalDir === 'string' && (
          <button type="button" className={css.miniBtn} disabled={busy}
            title={`打开落盘目录:${t.downloadLocalDir}`}
            onClick={() => void onRun('打开目录', () => {
              /* v8 ignore next -- 本块由 `typeof t.downloadLocalDir === 'string'` 守护,`?? ''` 仅为 TS 收窄进闭包 */
              return sftpRevealLocal(t.downloadLocalDir ?? '')
            })}>
            <IconFolderOpenOutlineMedium size={11} />打开目录
          </button>
        )}
        {terminal && (
          <button type="button" className={css.miniBtn} disabled={busy} title="从列表移除该记录"
            onClick={onDismiss}>
            <IconTrashOutlineMedium size={11} />删除
          </button>
        )}
        <span className={css.spacer} />
        {t.files.length > 1 && (
          <button type="button" className={css.miniBtn} onClick={onToggleExpand}>
            {expanded ? '收起明细' : `明细(${t.files.length})`}
          </button>
        )}
      </div>

      {expanded && t.files.length > 1 && (
        <div className={css.fileList}>
          {t.files.map(f => {
            const filePct = f.size > 0 ? Math.min(100, Math.round((f.transferred / f.size) * 100)) : (f.transferred > 0 ? 100 : 0)
            const isCurrent = activeFile === f.name && (t.status === 'running' || t.status === 'paused')
            return (
              <div key={f.name} className={clsx(css.fileRow, isCurrent && css.fileRowCurrent)}>
                <span className={css.fileName} title={f.name}>{f.name}</span>
                <span className={css.fileMeta}>{filePct}% · {formatSize(f.transferred)} / {formatSize(f.size)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
