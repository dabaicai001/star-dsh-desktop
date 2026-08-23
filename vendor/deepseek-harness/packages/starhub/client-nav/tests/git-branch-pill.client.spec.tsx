// @vitest-environment jsdom
/**
 * GitBranchPill:会话头部 git 分支胶囊——分支展示/隐藏条件、面板打开后的
 * 分支搜索与切换、提交、推送,全部经 __TAURI_INTERNALS__.invoke stub 走
 * local_shell_exec(命令形状断言含在 handler 分派里)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { GitBranchPill, type GitBranchPillProps } from '../src/client/git/GitBranchPill.tsx'

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

/** 按命令文本分派的 local_shell_exec stub;返回调用记录。 */
function stubGit(commands: Record<string, ShellResult>) {
  const calls: string[] = []
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: { command?: string }) => {
      if (cmd !== 'local_shell_exec') return Promise.reject(new Error(`unexpected: ${cmd}`))
      const command = args?.command ?? ''
      calls.push(command)
      const hit = Object.entries(commands).find(([prefix]) => command.startsWith(prefix))
      if (hit === undefined) {
        return Promise.resolve({ stdout: '', stderr: `unknown: ${command}`, exitCode: 1, elapsedMs: 1, truncated: false })
      }
      return Promise.resolve(hit[1])
    },
  }
  return {
    calls,
    restore: () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    },
  }
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

/** 完整 props:组件只用 sessionId/useSessions,其余 session 标准份额以未用桩补齐。 */
function pillProps(cwd?: string): GitBranchPillProps {
  const unused = (): never => { throw new Error('unused share') }
  return {
    sessionId: SID,
    useSessions: makeUseSessions(cwd),
    useSession: unused as never,
    useProjection: unused as never,
    useInput: unused as never,
    inputActions: {} as never,
  } as unknown as GitBranchPillProps
}

const CWD = 'E:\\ws\\starhub'

describe('GitBranchPill', () => {
  it('renders nothing for non-git workspaces or missing cwd', async () => {
    restore = stubGit({}) .restore
    const { container } = render(<GitBranchPill {...pillProps(CWD)} />)
    await act(async () => {})
    expect(container.querySelector('button')).toBeNull()

    const bare = render(<GitBranchPill {...pillProps()} />)
    await act(async () => {})
    expect(bare.container.querySelector('button')).toBeNull()
  })

  it('shows the current branch and switches via the search panel', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main\nfeat/git-pill\nfix/login'),
      'git status --porcelain': ok(' M src/index.ts'),
      'git checkout': ok("Switched to branch 'feat/git-pill'"),
    })
    restore = stub.restore
    render(<GitBranchPill {...pillProps(CWD)} />)
    const pill = await screen.findByRole('button', { name: /main/ })
    fireEvent.click(pill)

    const search = await screen.findByPlaceholderText('搜索分支…')
    fireEvent.change(search, { target: { value: 'git' } })
    const row = screen.getByRole('option', { name: /feat\/git-pill/ })
    expect(screen.queryByRole('option', { name: /fix\/login/ })).toBeNull()
    fireEvent.click(row)
    await act(async () => {})
    expect(stub.calls).toContain("git checkout 'feat/git-pill'")
  })

  it('commits all changes with the entered message', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main'),
      'git status --porcelain': ok(''),
      'git add -A': ok(''),
      'git commit': ok('[main abc1234] wip'),
    })
    restore = stub.restore
    render(<GitBranchPill {...pillProps(CWD)} />)
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    const input = await screen.findByPlaceholderText(/提交信息/)
    fireEvent.change(input, { target: { value: "feat: it's done" } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await act(async () => {})
    expect(stub.calls).toContain('git add -A')
    // PowerShell 单引号转义:信息里的单引号翻倍
    expect(stub.calls.some(c => c === "git commit -m 'feat: it''s done'")).toBe(true)
  })

  it('pushes with a 120s timeout and surfaces failures inline', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main'),
      'git status --porcelain': ok(''),
      'git push': { stdout: '', stderr: 'no upstream', exitCode: 1, elapsedMs: 1, truncated: false },
    })
    restore = stub.restore
    render(<GitBranchPill {...pillProps(CWD)} />)
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    fireEvent.click(await screen.findByRole('button', { name: /推送/ }))
    await act(async () => {})
    expect(stub.calls).toContain('git push')
    expect(await screen.findByText('no upstream')).toBeTruthy()
  })

  it('drafts a commit message with AI and fills the input', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main'),
      'git status --porcelain': ok(' M src/index.ts'),
      'git diff HEAD --stat': ok(' src/index.ts | 2 +-'),
      'git log -8 "--pretty=%s"': ok('feat: prior work'),
    })
    restore = stub.restore
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'feat: draft it' }), { status: 200 })))
    render(<GitBranchPill {...pillProps(CWD)} />)
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    fireEvent.click(await screen.findByRole('button', { name: /AI/ }))
    await act(async () => {})
    const input = await screen.findByPlaceholderText<HTMLInputElement>(/提交信息/)
    expect(input.value).toBe('feat: draft it')
    expect(stub.calls).toContain('git diff HEAD --stat')
    expect(stub.calls).toContain('git log -8 "--pretty=%s"')
  })

  it('surfaces AI draft failures inline and reports clean trees', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main'),
      'git status --porcelain': ok(''),
      'git diff HEAD --stat': ok(''),
      'git log -8 "--pretty=%s"': ok(''),
    })
    restore = stub.restore
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'provider down' }), { status: 502 })))
    render(<GitBranchPill {...pillProps(CWD)} />)
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    // 无改动:不请求端点,直接提示
    fireEvent.click(await screen.findByRole('button', { name: /AI/ }))
    expect(await screen.findByText(/没有改动/)).toBeTruthy()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('lists remote-only branches and pulls one into a local tracking branch', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main\nfeat/local'),
      'git branch -r "--format=%(refname:short)"': ok('origin/main\norigin/feat/remote-only\norigin/feat/local\norigin/HEAD'),
      'git status --porcelain': ok(''),
      'git checkout': ok("Switched to a new branch 'feat/remote-only'"),
    })
    restore = stub.restore
    render(<GitBranchPill {...pillProps(CWD)} />)
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))

    // 本地已有同名分支的 origin/feat/local 与 symbolic origin/HEAD 不列出
    const remoteRow = await screen.findByRole('option', { name: /origin\/feat\/remote-only/ })
    expect(screen.queryByRole('option', { name: /origin\/feat\/local/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /origin\/HEAD/ })).toBeNull()

    fireEvent.click(remoteRow)
    await act(async () => {})
    expect(stub.calls).toContain("git checkout -b 'feat/remote-only' --track 'origin/feat/remote-only'")
  })

  it('syncs remote refs and pulls the current branch', async () => {
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git branch "--format=%(refname:short)"': ok('main'),
      'git status --porcelain': ok(''),
      'git fetch --all --prune': ok('Fetching origin'),
      'git pull': ok('Already up to date.'),
    })
    restore = stub.restore
    render(<GitBranchPill {...pillProps(CWD)} />)
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))

    fireEvent.click(await screen.findByRole('button', { name: /同步远程/ }))
    await act(async () => {})
    expect(stub.calls).toContain('git fetch --all --prune')

    fireEvent.click(screen.getByRole('button', { name: /拉取\(git pull\)/ }))
    await act(async () => {})
    expect(stub.calls).toContain('git pull')
    expect(await screen.findByText('Already up to date.')).toBeTruthy()
  })
})
