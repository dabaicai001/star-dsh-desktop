// @vitest-environment jsdom
/**
 * GitBranchPill:会话头部 git 分支胶囊(v0.118.0 起为 Git 工作台入口)——
 * 分支与脏点展示、隐藏条件(非 git 工作区 / 无 cwd)、点击回调 openWorkbench、
 * 视图开关 aria-expanded、10s 轮询与页面可见刷新,全部经宿主桥 invoke
 * 替身走 local_shell_exec。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { GitBranchPill, type GitBranchPillProps } from '../src/client/git/GitBranchPill.tsx'
import type { GitWorkbenchState } from '../src/client/git/git-workbench-state.ts'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

const SID = 'sess-1' as SessionId

interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  elapsedMs: number
  truncated: boolean
}

function ok(stdout: string): ShellResult {
  return { stdout, stderr: '', exitCode: 0, elapsedMs: 1, truncated: false }
}

/** 按命令前缀分派的 local_shell_exec 替身;返回调用记录。 */
function stubGit(commands: Record<string, ShellResult>) {
  const calls: string[] = []
  stubHostBridge((cmd, args) => {
    if (cmd !== 'local_shell_exec') return Promise.reject(new Error(`unexpected: ${cmd}`))
    const command = (args as { command?: string }).command ?? ''
    calls.push(command)
    const hit = Object.entries(commands).find(([prefix]) => command.startsWith(prefix))
    if (hit === undefined) {
      return Promise.resolve({ stdout: '', stderr: `unknown: ${command}`, exitCode: 1, elapsedMs: 1, truncated: false })
    }
    return Promise.resolve(hit[1])
  })
  return { calls, restore: () => { restoreHostBridge() } }
}

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  cleanup()
  vi.restoreAllMocks()
})

/** 读取 cwd 的 useSessions stub(只实现组件用到的选择路径,其余字段收窄掉)。 */
function makeUseSessions(cwd?: string): GitBranchPillProps['useSessions'] {
  const stub = <T,>(selector: (state: { byId: Record<string, { cwd?: string } | undefined> }) => T): T =>
    selector({ byId: { 'sess-1': cwd === undefined ? undefined : { cwd } } })
  return stub as unknown as GitBranchPillProps['useSessions']
}

/** 完整 props:注入面(openWorkbench + useGitWorkbench)+ 未用 session 份额桩。 */
function pillProps(cwd?: string, gitWorkbenchSource?: SnapshotStore<GitWorkbenchState>): {
  props: GitBranchPillProps
  openWorkbench: ReturnType<typeof vi.fn>
  source: SnapshotStore<GitWorkbenchState>
} {
  const unused = (): never => { throw new Error('unused share') }
  const openWorkbench = vi.fn()
  const source = gitWorkbenchSource ?? createSnapshotStore<GitWorkbenchState>({ open: false, initialTab: 'changes' })
  const props = {
    sessionId: SID,
    useSessions: makeUseSessions(cwd),
    useGitWorkbench: <S,>(sel: (s: GitWorkbenchState) => S): S => sel(source.getSnapshot()),
    openWorkbench,
    useSession: unused as never,
    useProjection: unused as never,
    useInput: unused as never,
    inputActions: {} as never,
  } as unknown as GitBranchPillProps
  return { props, openWorkbench, source }
}

const CWD = 'E:\\ws\\starhub'

describe('GitBranchPill', () => {
  it('renders nothing for non-git workspaces or missing cwd', async () => {
    restore = stubGit({}).restore
    const { container } = render(<GitBranchPill {...pillProps(CWD).props} />)
    await act(async () => {})
    expect(container.querySelector('button')).toBeNull()

    const bare = render(<GitBranchPill {...pillProps().props} />)
    await act(async () => {})
    expect(bare.container.querySelector('button')).toBeNull()
  })

  it('shows the branch with a dirty dot for uncommitted changes', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git status --porcelain': ok(' M src/index.ts'),
    })
    restore = stub.restore
    render(<GitBranchPill {...pillProps(CWD).props} />)
    expect(await screen.findByRole('button', { name: /main/ })).toBeTruthy()
    expect(screen.getByTitle('有未提交改动')).toBeTruthy()
  })

  it('omits the dirty dot for a clean worktree', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git status --porcelain': ok(''),
    })
    restore = stub.restore
    const { container } = render(<GitBranchPill {...pillProps(CWD).props} />)
    await screen.findByRole('button', { name: /main/ })
    expect(container.querySelector('[title="有未提交改动"]')).toBeNull()
  })

  it('opens the workbench on click and mirrors the view state via aria-expanded', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git status --porcelain': ok(''),
    })
    restore = stub.restore
    const { props, openWorkbench, source } = pillProps(CWD)
    const view = render(<GitBranchPill {...props} />)
    const pill = await screen.findByRole('button', { name: /main/ })
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(pill)
    expect(openWorkbench).toHaveBeenCalledTimes(1)
    // 桥置 open(抽屉切到 Git 工作台)→ 胶囊 aria-expanded 同步为打开态
    act(() => { source.set({ open: true, initialTab: 'branches' }) })
    view.rerender(<GitBranchPill {...props} />)
    expect(screen.getByRole('button', { name: /main/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('auto-refreshes the branch when it changes externally (10s poll)', async () => {
    vi.useFakeTimers()
    let branch = 'feat/wb'
    const calls: string[] = []
    stubHostBridge((cmd, args) => {
      if (cmd !== 'local_shell_exec') return Promise.reject(new Error(`unexpected: ${cmd}`))
      const command = (args as { command?: string }).command ?? ''
      calls.push(command)
      if (command.startsWith('git branch --show-current')) {
        return Promise.resolve(branch !== '' ? ok(branch) : { stdout: '', stderr: '', exitCode: 1, elapsedMs: 1, truncated: false })
      }
      if (command.startsWith('git rev-parse --short HEAD')) {
        return Promise.resolve(branch !== '' ? ok('abc1234') : { stdout: '', stderr: '', exitCode: 1, elapsedMs: 1, truncated: false })
      }
      return Promise.resolve({ stdout: '', stderr: `unknown: ${command}`, exitCode: 1, elapsedMs: 1, truncated: false })
    })
    restore = () => {
      restoreHostBridge()
      vi.useRealTimers()
    }
    try {
      render(<GitBranchPill {...pillProps(CWD).props} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('button', { name: /feat\/wb/ })).toBeTruthy()
      // 外部(另一终端 git checkout main)→ 轮询一周期后胶囊自动更新
      branch = 'main'
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001) })
      expect(screen.getByRole('button', { name: /main/ })).toBeTruthy()
      // 瞬态失败(null)不落状态:胶囊保持显示,不闪隐
      branch = ''
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001) })
      expect(screen.getByRole('button', { name: /main/ })).toBeTruthy()
      expect(calls.filter(c => c.startsWith('git branch --show-current')).length).toBeGreaterThanOrEqual(3)
    } finally {
      restore()
      restore = undefined
    }
  })

  it('refreshes the branch when the page becomes visible again', async () => {
    let branch = 'fix/one'
    stubHostBridge((cmd, args) => {
      if (cmd !== 'local_shell_exec') return Promise.reject(new Error(`unexpected: ${cmd}`))
      const command = (args as { command?: string }).command ?? ''
      if (command.startsWith('git branch --show-current')) return Promise.resolve(ok(branch))
      if (command.startsWith('git rev-parse --short HEAD')) return Promise.resolve(ok('abc1234'))
      return Promise.resolve({ stdout: '', stderr: `unknown: ${command}`, exitCode: 1, elapsedMs: 1, truncated: false })
    })
    restore = () => { restoreHostBridge() }
    try {
      render(<GitBranchPill {...pillProps(CWD).props} />)
      await screen.findByRole('button', { name: /fix\/one/ })
      branch = 'fix/two'
      // 切走(隐藏)再切回可见:visibilitychange 触发一次重读,胶囊更新
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      await act(async () => {})
      expect(screen.getByRole('button', { name: /fix\/two/ })).toBeTruthy()
    } finally {
      restore()
      restore = undefined
    }
  })
})
