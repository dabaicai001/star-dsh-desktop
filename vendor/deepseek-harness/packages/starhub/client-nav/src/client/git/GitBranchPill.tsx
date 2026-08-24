/**
 * 会话头部「git 分支胶囊」(2026-08-21):显示当前会话工作区(会话 cwd)的
 * git 分支;点击展开面板——搜索/切换分支(本地 + 远程跟踪分支,远程分支点击
 * 拉取为本地跟踪分支)、同步远程引用(fetch)、拉取(pull)、暂存全部并提交、推送。
 *
 * 数据源:会话 cwd 经框架 `useSessions` 读取;git 状态经 Tauri
 * `local_shell_exec`(git-service.ts)在挂载/面板打开/操作完成后刷新。
 * 非 git 仓库、无 cwd(blank 会话)或浏览器预览(无 Tauri IPC)时不渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the header-actions SlotMap row (declared by ui-conversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './GitBranchPill.module.css'
import {
  gitCheckout, gitCheckoutRemote, gitCommitAll, gitCurrentBranch, gitDraftCommitMessage, gitFetch,
  gitIsDirty, gitListBranches, gitListRemoteBranches, gitPull, gitPush,
} from './git-service.ts'

/** Full composed props: header-actions runtime share(sessionId + useSessions)。 */
export type GitBranchPillProps = PropsRuntime<'conversation.session.header.actions'>

/** 分支胶囊对外部 git 操作(如另一终端切换分支)的轮询间隔。 */
const BRANCH_POLL_MS = 10_000

/** 面板一次刷新的数据源:本地分支 + 远程跟踪分支 + 脏标记。 */
async function loadPanelState(dir: string): Promise<{ local: string[]; remote: string[]; dirty: boolean }> {
  const [local, remote, dirty] = await Promise.all([
    gitListBranches(dir), gitListRemoteBranches(dir), gitIsDirty(dir),
  ])
  return { local, remote, dirty }
}

/**
 * 渲染分支胶囊与操作面板。
 * @param props - 框架份额(sessionId / useSessions)。
 * @returns 胶囊;非 git 工作区不渲染。
 */
export function GitBranchPill({ sessionId, useSessions }: GitBranchPillProps) {
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const [branch, setBranch] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const refreshBranch = useCallback(async (dir: string) => {
    setBranch(await gitCurrentBranch(dir))
  }, [])

  // 挂载与 cwd 变化时探测一次(非仓库/预览 → 隐藏胶囊)。
  useEffect(() => {
    if (cwd === undefined) { setBranch(null); return }
    let cancelled = false
    void gitCurrentBranch(cwd).then((name) => { if (!cancelled) setBranch(name) })
    return () => { cancelled = true }
  }, [cwd])

  // 外部 git 操作(在其它终端/编辑器切了分支)后胶囊保持自动最新:挂载期
  // 每 10s 轮询一次当前分支;页面重新可见时立即刷新。null(非仓库/瞬态
  // 失败)不落状态,避免胶囊闪隐。
  useEffect(() => {
    if (cwd === undefined) return
    let cancelled = false
    const probe = (): void => {
      void gitCurrentBranch(cwd).then((name) => {
        if (!cancelled && name !== null) setBranch(name)
      })
    }
    const timer = window.setInterval(probe, BRANCH_POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') probe()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [cwd])

  // 面板外点击关闭(焦点可能留在搜索框,用 pointerdown 捕获)。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return
      if (rootRef.current?.contains(ev.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open])

  const openPanel = async () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    setNotice(null)
    setFilter('')
    if (cwd === undefined) return
    // 开门即刷新胶囊里的当前分支(与面板分支列表同源)。
    await refreshBranch(cwd)
    const state = await loadPanelState(cwd)
    setBranches(state.local)
    setRemoteBranches(state.remote)
    setDirty(state.dirty)
  }

  const run = async (dir: string, label: string, action: () => Promise<{ ok: boolean; stdout: string; stderr: string }>) => {
    if (busy !== '') return
    setBusy(label)
    setNotice(null)
    const result = await action()
    setBusy('')
    if (result.ok) {
      setNotice({ kind: 'ok', text: result.stdout === '' ? `${label}完成` : result.stdout.split('\n')[0] ?? `${label}完成` })
      await refreshBranch(dir)
      const state = await loadPanelState(dir)
      setBranches(state.local)
      setRemoteBranches(state.remote)
      setDirty(state.dirty)
    } else {
      setNotice({ kind: 'error', text: result.stderr || `${label}失败` })
    }
  }

  const onCheckout = (target: string) => {
    if (target === branch || cwd === undefined) return
    void run(cwd, `切换到 ${target}`, () => gitCheckout(cwd, target))
  }

  // 远程分支「拉取到本地」:无本地同名分支时创建跟踪分支并切换。
  const onCheckoutRemote = (remoteRef: string) => {
    if (cwd === undefined) return
    const local = remoteRef.slice(remoteRef.indexOf('/') + 1)
    void run(cwd, `拉取 ${remoteRef}`, () => gitCheckoutRemote(cwd, remoteRef, branches.includes(local)))
  }

  const onFetch = () => {
    if (cwd === undefined) return
    void run(cwd, '同步远程', () => gitFetch(cwd))
  }

  const onCommit = () => {
    const message = commitMessage.trim()
    if (message === '') { setNotice({ kind: 'error', text: '提交信息不能为空' }); return }
    if (cwd === undefined) return
    void run(cwd, '提交', () => gitCommitAll(cwd, message)).then(() => { setCommitMessage('') })
  }

  const onPull = () => {
    if (cwd === undefined) return
    void run(cwd, '拉取', () => gitPull(cwd))
  }

  const onPush = () => {
    if (cwd === undefined) return
    void run(cwd, '推送', () => gitPush(cwd))
  }

  // AI 生成提交信息(2026-08-22):采集 status/diffstat/近期提交主题,经 host
  // 端点(dsh-starhub-commit-message)做 one-shot LLM 调用,草稿回填输入框,
  // 用户确认/编辑后再点「提交」。
  const onAiDraft = () => {
    if (busy !== '' || cwd === undefined) return
    setBusy('生成')
    setNotice(null)
    void gitDraftCommitMessage(cwd)
      .then((result) => {
        if (result.ok) setCommitMessage(result.message)
        else setNotice({ kind: 'error', text: result.error })
      })
      .finally(() => { setBusy('') })
  }

  if (branch === null || cwd === undefined) return null
  const matches = (name: string) => filter === '' || name.toLowerCase().includes(filter.toLowerCase())
  const visibleLocal = branches.filter(matches)
  // 本地已有同名分支的远程引用不重复列出(切本地分支即等价)。
  const visibleRemote = remoteBranches
    .filter(ref => !branches.includes(ref.slice(ref.indexOf('/') + 1)))
    .filter(matches)

  return (
    <div ref={rootRef} className={css.root}>
      <button
        type="button"
        className={clsx(css.pill, open && css.pillOpen)}
        title={`工作区分支:${branch}\n${cwd}`}
        aria-expanded={open}
        onClick={() => { void openPanel() }}
      >
        <IconBranchOutline16 size={13} />
        <span className={css.branchName}>{branch}</span>
        {dirty && <span className={css.dirtyDot} title="有未提交改动" />}
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label="Git 分支">
          <input
            className={css.search}
            placeholder="搜索分支…"
            value={filter}
            onChange={(ev) => { setFilter(ev.target.value) }}
          />
          <div className={css.branchList} role="listbox" aria-label="分支列表">
            {visibleLocal.map(name => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={name === branch}
                className={clsx(css.branchRow, name === branch && css.branchRowActive)}
                disabled={busy !== ''}
                onClick={() => { onCheckout(name) }}
              >
                <IconBranchOutline16 size={12} />
                <span className={css.branchRowName}>{name}</span>
                {name === branch && <span className={css.currentTag}>当前</span>}
              </button>
            ))}
            {visibleRemote.length > 0 && <div className={css.groupLabel}>远程(点击拉取到本地)</div>}
            {visibleRemote.map(ref => (
              <button
                key={ref}
                type="button"
                role="option"
                aria-selected={false}
                className={clsx(css.branchRow, css.branchRowRemote)}
                disabled={busy !== ''}
                title={`拉取 ${ref} 为本地跟踪分支`}
                onClick={() => { onCheckoutRemote(ref) }}
              >
                <IconBranchOutline16 size={12} />
                <span className={css.branchRowName}>{ref}</span>
              </button>
            ))}
            {visibleLocal.length === 0 && visibleRemote.length === 0 && (
              <div className={css.empty}>无匹配分支</div>
            )}
          </div>
          <div className={css.commitRow}>
            <input
              className={css.search}
              placeholder="提交信息(git add -A && commit)…"
              value={commitMessage}
              onChange={(ev) => { setCommitMessage(ev.target.value) }}
              onKeyDown={(ev) => { if (ev.key === 'Enter') onCommit() }}
            />
            <button
              type="button"
              className={css.actionBtn}
              disabled={busy !== ''}
              title="AI 根据工作区改动生成提交信息草稿"
              onClick={onAiDraft}
            >
              {busy === '生成' ? '生成中…' : '✨ AI'}
            </button>
            <button
              type="button"
              className={css.actionBtn}
              disabled={busy !== '' || commitMessage.trim() === ''}
              onClick={onCommit}
            >
              提交
            </button>
          </div>
          <div className={css.actionRow}>
            <button
              type="button"
              className={css.actionBtn}
              disabled={busy !== ''}
              title="git fetch --all --prune:同步远程分支列表"
              onClick={onFetch}
            >
              {busy === '同步远程' ? '同步中…' : '同步远程'}
            </button>
            <button
              type="button"
              className={css.actionBtn}
              disabled={busy !== ''}
              onClick={onPull}
            >
              {busy === '拉取' ? '拉取中…' : '拉取(git pull)'}
            </button>
            <button
              type="button"
              className={css.actionBtn}
              disabled={busy !== ''}
              onClick={onPush}
            >
              {busy === '推送' ? '推送中…' : '推送(git push)'}
            </button>
          </div>
          {busy !== '' && !['同步远程', '拉取', '推送', '生成'].includes(busy) && (
            <div className={css.busyText}>{busy}中…</div>
          )}
          {notice !== null && (
            <div className={clsx(css.notice, notice.kind === 'error' ? css.noticeError : css.noticeOk)}>
              {notice.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
