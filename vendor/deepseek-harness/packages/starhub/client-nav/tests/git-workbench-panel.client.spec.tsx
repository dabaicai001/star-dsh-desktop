// @vitest-environment jsdom
/**
 * GitWorkbenchPanel:工具抽屉内跟随会话 cwd 的 Git 工作台视图——非 git 空态、
 * 变更三段列表与暂存/取消暂存/两步确认(放弃/删除未跟踪)/diff 查看/提交已
 * 暂存(含引号转义)/AI 草稿/历史(git log + git show 展开)/分支搜索与切换/
 * 同步远程·拉取·推送(超时参数与行内错误),全部经 __TAURI_INTERNALS__.invoke
 * stub 走 local_shell_exec(命令形状断言含在 handler 分派里)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GitWorkbenchPanel } from '../src/client/git/GitWorkbenchPanel.tsx'

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

function fail(stderr: string): ShellResult {
  return { stdout: '', stderr, exitCode: 1, elapsedMs: 1, truncated: false }
}

/** 变更页探测的标准三分状态:已暂存/未暂存/未跟踪各一。 */
const STATUS_THREE = 'M  staged.ts\0 M modified.ts\0?? untracked.ts\0'

/** 按命令前缀分派的 local_shell_exec stub;记录 workingDir::command 与原始 args。 */
function stubGit(commands: Record<string, ShellResult>) {
  const calls: string[] = []
  const argsLog: Array<{ command?: string; workingDir?: string; timeoutSec?: number }> = []
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: { command?: string; workingDir?: string; timeoutSec?: number }) => {
      if (cmd !== 'local_shell_exec') return Promise.reject(new Error(`unexpected: ${cmd}`))
      const command = args?.command ?? ''
      calls.push(`${args?.workingDir ?? ''}::${command}`)
      argsLog.push(args ?? {})
      // 更长前缀优先:git status --porcelain=v1 -z 须先于 git status --porcelain。
      const hit = Object.entries(commands).find(([prefix]) => command.startsWith(prefix))
      if (hit === undefined) {
        return Promise.resolve({ stdout: '', stderr: `unknown: ${command}`, exitCode: 1, elapsedMs: 1, truncated: false })
      }
      return Promise.resolve(hit[1])
    },
  }
  return {
    calls,
    argsLog,
    restore: () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    },
  }
}

/** 探测一组最小命令(仓库在 main 分支,无改动)。 */
function probeCommands(status = ''): Record<string, ShellResult> {
  return {
    'git branch --show-current': ok('main'),
    'git rev-parse --short HEAD': ok('abc1234'),
    'git status --porcelain=v1 -z': ok(status),
    'git status --porcelain': ok(status),
    'git rev-list --left-right --count': ok('0\t0'),
  }
}

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  cleanup()
  vi.restoreAllMocks()
})

const CWD = 'E:\\ws\\demo'

/** 定位某文件所在行(多段列表存在同名「暂存」按钮,须收窄到行内;等待探测完成)。 */
async function rowOf(file: string): Promise<HTMLElement> {
  return (await screen.findByText(file)).closest('div') as HTMLElement
}

function renderPanel(cwd = CWD, initialTab: 'changes' | 'history' | 'branches' = 'changes'): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  render(<GitWorkbenchPanel cwd={cwd} initialTab={initialTab} onClose={onClose} />)
  return { onClose }
}

describe('GitWorkbenchPanel', () => {
  it('renders the non-git empty state and closes back to the asset list', async () => {
    // 分支与 rev-parse 全失败 → 非 git 仓库
    restore = stubGit({}).restore
    const { onClose } = renderPanel()
    expect(await screen.findByText('当前工作区不是 git 仓库')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回资产列表' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the three change sections and closes from the header button', async () => {
    const stub = stubGit(probeCommands(STATUS_THREE))
    restore = stub.restore
    const { onClose } = renderPanel()
    expect(await screen.findByText('已暂存(1)')).toBeTruthy()
    expect(screen.getByText('未暂存的变更(1)')).toBeTruthy()
    expect(screen.getByText('未跟踪(1)')).toBeTruthy()
    expect(screen.getByText('staged.ts')).toBeTruthy()
    expect(screen.getByText('modified.ts')).toBeTruthy()
    expect(screen.getByText('untracked.ts')).toBeTruthy()
    // 有改动 → 头部脏点;关闭按钮回调 onClose
    expect(screen.getByTitle('有未提交改动')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('关闭 Git 工作台'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a clean-tree hint and enables no commit without staged files', async () => {
    const stub = stubGit(probeCommands())
    restore = stub.restore
    renderPanel()
    expect(await screen.findByText('工作区干净,没有未提交的改动。')).toBeTruthy()
    expect((screen.getByTitle('暂存区为空') as HTMLButtonElement).disabled).toBe(true)
  })

  it('stages, unstages and stage-alls with fixed command shapes and reloads', async () => {
    const stub = stubGit({ ...probeCommands(STATUS_THREE), 'git add -- ': ok(''), 'git add -A': ok(''), 'git restore --staged -- ': ok('') })
    restore = stub.restore
    renderPanel()
    const modifiedRow = await rowOf('modified.ts')
    fireEvent.click(within(modifiedRow).getByRole('button', { name: '暂存' }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git add -- 'modified.ts'`))
    // 操作后重载重挂载,行元素需重查
    fireEvent.click(within(await rowOf('staged.ts')).getByRole('button', { name: '取消暂存' }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git restore --staged -- 'staged.ts'`))
    fireEvent.click(screen.getByRole('button', { name: /暂存全部/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git add -A`))
    // 操作后重载:状态命令被再次执行
    expect(stub.calls.filter(c => c.endsWith('git status --porcelain=v1 -z')).length).toBeGreaterThanOrEqual(3)
    // 空输出成功 → 「<动作>完成」通知(最后一个动作为暂存全部)
    expect(await screen.findByText('暂存全部完成')).toBeTruthy()
  })

  it('discards a tracked file only after the two-step confirm, and can cancel', async () => {
    const stub = stubGit({ ...probeCommands(STATUS_THREE), 'git restore -- ': ok('') })
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '放弃' }))
    expect(await screen.findByText('确认放弃?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(stub.calls.some(c => c.includes('git restore -- '))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git restore -- 'modified.ts'`))
  })

  it('deletes an untracked file via git clean after the two-step confirm', async () => {
    const stub = stubGit({ ...probeCommands(STATUS_THREE), 'git clean -f -- ': ok('') })
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(await screen.findByText('确认删除?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git clean -f -- 'untracked.ts'`))
  })

  it('shows the staged diff with colored lines and the untracked placeholder', async () => {
    const patch = ['diff --git a/staged.ts b/staged.ts', 'index 111..222 100644', '--- a/staged.ts', '+++ b/staged.ts', '@@ -1,2 +1,2 @@', '-old line', '+new line', ' ctx'].join('\n')
    const stub = stubGit({
      ...probeCommands(STATUS_THREE),
      'git diff --no-ext-diff -U3 --cached -- ': ok(patch),
    })
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'staged.ts' }))
    expect(await screen.findByText('已暂存 diff')).toBeTruthy()
    expect(screen.getByText('+new line')).toBeTruthy()
    expect(screen.getByText('-old line')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'untracked.ts' }))
    expect(await screen.findByText(/新文件\(未跟踪\)/)).toBeTruthy()
  })

  it('surfaces diff read failures and empty diffs inline', async () => {
    const stub = stubGit(probeCommands(STATUS_THREE))
    restore = stub.restore
    renderPanel()
    // stub 无 diff 命令 → exit 1 → 失败提示
    fireEvent.click(await screen.findByRole('button', { name: 'staged.ts' }))
    expect(await screen.findByText('diff 读取失败。')).toBeTruthy()
    // 空差异 → 无差异提示
    restore = undefined
    cleanup()
    const emptyStub = stubGit({ ...probeCommands(STATUS_THREE), 'git diff --no-ext-diff -U3 --cached -- ': ok('') })
    restore = emptyStub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'staged.ts' }))
    expect(await screen.findByText('无差异。')).toBeTruthy()
  })

  it('commits the staged changes with PowerShell quote escaping', async () => {
    const stub = stubGit({ ...probeCommands(STATUS_THREE), 'git commit -m ': ok('[main a1b2c3] feat: it works') })
    restore = stub.restore
    renderPanel()
    const input = await screen.findByPlaceholderText(/提交信息/)
    fireEvent.change(input, { target: { value: "feat: it's done" } })
    fireEvent.click(screen.getByRole('button', { name: /提交已暂存\(1\)/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git commit -m 'feat: it''s done'`))
    expect(await screen.findByText('[main a1b2c3] feat: it works')).toBeTruthy()
    // 提交成功后清空输入
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('drafts a commit message with AI and fills the input', async () => {
    const stub = stubGit({
      ...probeCommands(STATUS_THREE),
      'git diff HEAD --stat': ok(' src/index.ts | 2 +-'),
      'git log -8 "--pretty=%s"': ok('feat: prior work'),
    })
    restore = stub.restore
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'feat: draft it' }), { status: 200 })))
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /AI/ }))
    await act(async () => {})
    const input = await screen.findByPlaceholderText<HTMLInputElement>(/提交信息/)
    expect(input.value).toBe('feat: draft it')
  })

  it('surfaces AI draft failures for clean trees', async () => {
    const stub = stubGit(probeCommands())
    restore = stub.restore
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'provider down' }), { status: 502 })))
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /AI/ }))
    expect(await screen.findByText(/没有改动/)).toBeTruthy()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('lists history, expands a commit patch and collapses on the second click', async () => {
    const log = 'hash1\x1fa1\x1fAlice\x1f2026-09-10T00:00:00Z\x1ffeat: one\x1f (HEAD -> main)\n\x1ehash2\x1fa2\x1fBob\x1f2026-09-09T00:00:00Z\x1ffix: two\x1f'
    const patch = 'commit a1  feat: one\nAlice  2026-09-10T00:00:00Z\n@@ -1 +1 @@\n+added\n-removed'
    const stub = stubGit({
      ...probeCommands(),
      'git log -n 50 "--pretty=': ok(log),
      'git show --no-ext-diff -U3 --no-color': ok(patch),
    })
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('tab', { name: '历史' }))
    expect(await screen.findByText('feat: one')).toBeTruthy()
    expect(screen.getByText('fix: two')).toBeTruthy()
    expect(screen.getByText('HEAD -> main')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /feat: one/ }))
    expect(await screen.findByText('+added')).toBeTruthy()
    // hash 必须在 `--` 之前:`--` 之后是 pathspec,放错位置 git 返回空补丁
    expect(stub.calls.some(c => /git show --no-ext-diff -U3 --no-color "--pretty=[^"]*" 'hash1' --$/.test(c))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /feat: one/ }))
    await act(async () => {})
    expect(screen.queryByText('+added')).toBeNull()
  })

  it('shows the empty-history state when git log fails (bare repository)', async () => {
    const stub = stubGit(probeCommands())
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('tab', { name: '历史' }))
    expect(await screen.findByText('暂无提交(空仓库或读取失败)。')).toBeTruthy()
  })

  it('searches and switches branches, pulling remote-only refs as tracking branches', async () => {
    const stub = stubGit({
      ...probeCommands(),
      'git branch "--format=%(refname:short)"': ok('main\nfeat/wb'),
      'git branch -r "--format=%(refname:short)"': ok('origin/main\norigin/feat/remote-only\norigin/feat/wb\norigin/HEAD'),
      'git checkout ': ok("Switched to branch 'feat/wb'"),
    })
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('tab', { name: '分支' }))
    expect(await screen.findByRole('option', { name: /origin\/feat\/remote-only/ })).toBeTruthy()
    // 本地已有同名的 origin/feat/wb 与 symbolic origin/HEAD 不列出
    expect(screen.queryByRole('option', { name: 'origin/feat/wb' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'origin/HEAD' })).toBeNull()
    // 点击当前分支(已高亮)不发起切换
    fireEvent.click(screen.getByRole('option', { name: /^main/ }))
    expect(stub.calls.some(c => c.includes('git checkout '))).toBe(false)
    // 过滤分支列表
    const search = screen.getByPlaceholderText('搜索分支…')
    fireEvent.change(search, { target: { value: 'wb' } })
    expect(screen.queryByRole('option', { name: /^feat\/wb/ })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(await screen.findByText('无匹配分支')).toBeTruthy()
    // 清空过滤 → 切本地分支 → 重查询后拉取远程分支为本地跟踪分支
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('option', { name: /^feat\/wb/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git checkout 'feat/wb'`))
    fireEvent.click(await screen.findByRole('option', { name: /origin\/feat\/remote-only/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git checkout -b 'feat/remote-only' --track 'origin/feat/remote-only'`))
  })

  it('syncs remote refs, pulls and pushes with a 120s network timeout', async () => {
    const stub = stubGit({
      ...probeCommands(),
      'git branch "--format=%(refname:short)"': ok('main'),
      'git branch -r "--format=%(refname:short)"': ok('origin/main'),
      'git rev-list --left-right --count': ok('2\t1'),
      'git fetch --all --prune': ok('Fetching origin'),
      'git pull': ok('Already up to date.'),
      'git push': fail('no upstream'),
    })
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /同步/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git fetch --all --prune`))
    expect(await screen.findByText('Fetching origin')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /拉取/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git pull`))
    expect(await screen.findByText('Already up to date.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /推送/ }))
    await waitFor(() => expect(stub.calls).toContain(`${CWD}::git push`))
    expect(await screen.findByText('no upstream')).toBeTruthy()
    expect(stub.argsLog.some(a => a.command === 'git push' && a.timeoutSec === 120)).toBe(true)
  })

  it('blocks concurrent actions while one is running', async () => {
    let resolveAdd: (r: ShellResult) => void = () => {}
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    const prev = w.__TAURI_INTERNALS__
    const calls: string[] = []
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: { command?: string; workingDir?: string }) => {
        if (cmd !== 'local_shell_exec') return Promise.reject(new Error(`unexpected: ${cmd}`))
        const command = args?.command ?? ''
        calls.push(command)
        if (command.startsWith('git add -- ')) {
          return new Promise((res) => { resolveAdd = res })
        }
        if (command.startsWith('git branch --show-current')) return Promise.resolve(ok('main'))
        if (command.startsWith('git rev-parse --short HEAD')) return Promise.resolve(ok('abc1234'))
        if (command.startsWith('git status --porcelain=v1 -z')) return Promise.resolve(ok(STATUS_THREE))
        if (command.startsWith('git status --porcelain')) return Promise.resolve(ok(STATUS_THREE))
        return Promise.resolve({ stdout: '', stderr: `unknown: ${command}`, exitCode: 1, elapsedMs: 1, truncated: false })
      },
    }
    restore = () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    }
    renderPanel()
    const modifiedRow = await rowOf('modified.ts')
    fireEvent.click(within(modifiedRow).getByRole('button', { name: '暂存' }))
    fireEvent.click(within(modifiedRow).getByRole('button', { name: '暂存' }))
    resolveAdd(ok(''))
    await act(async () => {})
    expect(calls.filter(c => c.startsWith('git add -- '))).toHaveLength(1)
  })

  it('reprobes and resets interaction state when the workspace cwd changes', async () => {
    const stub = stubGit(probeCommands(STATUS_THREE))
    restore = stub.restore
    const view = render(<GitWorkbenchPanel cwd={CWD} initialTab="changes" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'staged.ts' }))
    expect(await screen.findByText('已暂存 diff')).toBeTruthy()
    // 注意:JSX 表达式传参(字符串属性不处理反斜杠转义)
    view.rerender(<GitWorkbenchPanel cwd={'D:\\other\\repo'} initialTab="changes" onClose={vi.fn()} />)
    await waitFor(() => { expect(stub.calls.filter(c => c.startsWith('D:\\other\\repo::git branch')).length).toBe(1) })
    // 上个仓库的 diff 选择已清空
    await waitFor(() => { expect(screen.queryByText('已暂存 diff')).toBeNull() })
  })

  it('renders the diff inside the section that owns the selected file', async () => {
    const patch = ['@@ -1 +1 @@', '-old', '+new'].join('\n')
    const stub = stubGit({
      ...probeCommands(STATUS_THREE),
      'git diff --no-ext-diff -U3 --cached -- ': ok(patch),
      'git diff --no-ext-diff -U3 -- ': ok(patch),
    })
    restore = stub.restore
    renderPanel()
    // 点「已暂存」段的文件:diff 出现在该 section 内,而不是列表末尾
    fireEvent.click(await screen.findByRole('button', { name: 'staged.ts' }))
    await screen.findByText('已暂存 diff')
    const stagedSection = screen.getByText('已暂存(1)').closest('section') as HTMLElement
    expect(within(stagedSection).getByText('已暂存 diff')).toBeTruthy()
    // 其它段不渲染 diff 视图
    const unstagedSection = screen.getByText('未暂存的变更(1)').closest('section') as HTMLElement
    expect(within(unstagedSection).queryByText(/diff/)).toBeNull()
  })

  it('cancels a pending two-step confirm when another file is selected', async () => {
    const stub = stubGit(probeCommands(STATUS_THREE))
    restore = stub.restore
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '放弃' }))
    expect(await screen.findByText('确认放弃?')).toBeTruthy()
    // 选中其它行 → 行内确认条自动消失,且未发起 restore
    fireEvent.click(screen.getByRole('button', { name: 'staged.ts' }))
    await act(async () => {})
    expect(screen.queryByText('确认放弃?')).toBeNull()
    expect(stub.calls.some(c => c.includes('git restore -- '))).toBe(false)
  })

  it('lands on the tab given by initialTab (branch pill opens on branches)', async () => {
    const stub = stubGit({
      ...probeCommands(),
      'git branch "--format=%(refname:short)"': ok('main\nfeat/wb'),
      'git branch -r "--format=%(refname:short)"': ok('origin/main'),
    })
    restore = stub.restore
    renderPanel(CWD, 'branches')
    // 落地即分支 Tab:分支列表已加载
    expect(await screen.findByRole('option', { name: /^main/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '分支' }).getAttribute('aria-selected')).toBe('true')
  })

  it('reloads the current tab when the page becomes visible again', async () => {
    let status = STATUS_THREE
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git rev-parse --short HEAD': ok('abc1234'),
      get 'git status --porcelain=v1 -z'() { return ok(status) },
      get 'git status --porcelain'() { return ok(status) },
    })
    restore = stub.restore
    renderPanel()
    expect(await screen.findByText('已暂存(1)')).toBeTruthy()
    // 外部(终端)又改了一个文件 → 页面重新可见时变更列表自动刷新
    status = `${STATUS_THREE} M later.ts\0`
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(await screen.findByText('later.ts')).toBeTruthy()
  })

  it('offers a retry from the status-failure state', async () => {    // 分支探测成功但 status 命令失败 → 状态读取失败 + 重试
    const stub = stubGit({
      'git branch --show-current': ok('main'),
      'git rev-parse --short HEAD': ok('abc1234'),
    })
    restore = stub.restore
    renderPanel()
    expect(await screen.findByText('git 状态读取失败。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await act(async () => {})
  })

  it('reports status loading before the first probe settles', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    const prev = w.__TAURI_INTERNALS__
    w.__TAURI_INTERNALS__ = {
      invoke: () => new Promise(() => { /* 永不 resolve:探测挂起 */ }),
    }
    restore = () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    }
    renderPanel()
    expect(await screen.findByText('读取 git 状态…')).toBeTruthy()
  })
})
