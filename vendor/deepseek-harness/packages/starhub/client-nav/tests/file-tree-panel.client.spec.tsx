// @vitest-environment jsdom
/**
 * FileTreePanel:项目文件目录树——根目录懒加载展开、子目录展开/收起、文件
 * 行点击弹文件信息窗、右键菜单「引用文件/复制路径/查看信息」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileTreePanel } from '../src/client/file-tree/FileTreePanel.tsx'
import { renderFileReference } from '../src/client/file-tree/FileInfoDialog.tsx'

const CWD = 'C:\\ws\\proj'

interface Entry {
  name: string
  path: string
  kind: string
  size: number
  modifiedAt: number | null
  readonly: boolean
  hidden: boolean
}

function dir(name: string, path: string): Entry {
  return { name, path, kind: 'directory', size: 0, modifiedAt: 1, readonly: false, hidden: false }
}

function file(name: string, path: string, size = 10): Entry {
  return { name, path, kind: 'file', size, modifiedAt: 1, readonly: false, hidden: false }
}

function stubInvoke(handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>) {
  const calls: string[] = []
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd)
      const handler = handlers[cmd]
      if (handler === undefined) return Promise.reject(new Error(`unexpected: ${cmd}`))
      return handler(args ?? {})
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

const STAT = { path: '', name: 'main.ts', kind: 'file', size: 42, modifiedAt: 100, readonly: false }
const READ = { path: '', content: 'line1\nline2', offset: 0, bytesRead: 11, totalBytes: 11, truncated: false }

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  cleanup()
  vi.restoreAllMocks()
})

function panelProps(insertReference = vi.fn()) {
  return {
    cwd: CWD,
    onClose: vi.fn(),
    insertReference,
  }
}

describe('FileTreePanel', () => {
  it('loads the root directory lazily and lists its entries (directories first)', async () => {
    restore = stubInvoke({
      local_list_directory: (_args) => Promise.resolve([
        file('main.ts', 'C:\\ws\\proj\\main.ts'),
        dir('src', 'C:\\ws\\proj\\src'),
      ]),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    // 根目录行
    expect(screen.getByRole('button', { name: /文件夹 proj/ })).toBeTruthy()
    // 懒加载完成后根子项出现
    const src = await screen.findByRole('button', { name: /文件夹 src/ })
    expect(src).toBeTruthy()
    expect(screen.getByRole('button', { name: /main\.ts/ })).toBeTruthy()
  })

  it('sorts entries directories-first then by name regardless of input order', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([
        file('z.ts', 'C:\\ws\\proj\\z.ts'),
        dir('b', 'C:\\ws\\proj\\b'),
        file('a.ts', 'C:\\ws\\proj\\a.ts'),
        dir('a', 'C:\\ws\\proj\\a'),
      ]),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    // 目录在前(a、b 按名),文件在后(a.ts、z.ts 按名);aria-label 目录带前缀。
    const rows = await screen.findAllByRole('button', { name: /^(文件夹 a|文件夹 b|a\.ts|z\.ts)$/ })
    const order = rows.map(row => row.getAttribute('aria-label') ?? row.textContent ?? '')
    expect(order).toEqual(['文件夹 a', '文件夹 b', 'a.ts', 'z.ts'])
  })

  it('clears a directory load error after a retry succeeds', async () => {
    let attempts = 0
    restore = stubInvoke({
      local_list_directory: (_args) => {
        attempts += 1
        if (attempts === 1) return Promise.reject(new Error('boom'))
        return Promise.resolve([file('ok.ts', 'C:\\ws\\proj\\ok.ts')])
      },
    }).restore
    const view = render(<FileTreePanel {...panelProps()} />)
    const root = await screen.findByRole('button', { name: /文件夹 proj/ })
    // 挂载自动展开首拉失败 → 错误行出现;点击根目录(错误态)= 重试 → 成功清除错误。
    await screen.findByText('boom')
    fireEvent.click(root)
    await screen.findByRole('button', { name: /ok\.ts/ })
    expect(screen.queryByText('boom')).toBeNull()
    view.unmount()
  })

  it('renders a plain-string directory load failure verbatim', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.reject('plain failure'),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    await screen.findByText('plain failure')
  })

  it('expands a child directory on click and collapses it back', async () => {
    restore = stubInvoke({
      local_list_directory: (args) => {
        if (args.path === 'C:\\ws\\proj') return Promise.resolve([dir('src', 'C:\\ws\\proj\\src')])
        return Promise.resolve([file('a.ts', 'C:\\ws\\proj\\src\\a.ts')])
      },
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const src = await screen.findByRole('button', { name: /文件夹 src/ })
    fireEvent.click(src)
    const a = await screen.findByRole('button', { name: /a\.ts/ })
    expect(a).toBeTruthy()
    fireEvent.click(src)
    await waitFor(() => expect(screen.queryByRole('button', { name: /a\.ts/ })).toBeNull())
  })

  it('right-clicking a file opens the context menu and 引用文件 inserts the reference', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([file('main.ts', 'C:\\ws\\proj\\main.ts')]),
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.resolve(READ),
    }).restore
    const insert = vi.fn()
    render(<FileTreePanel {...panelProps(insert)} />)
    const row = await screen.findByRole('button', { name: /main\.ts/ })
    fireEvent.contextMenu(row)
    const reference = await screen.findByRole('menuitem', { name: /引用文件/ })
    fireEvent.click(reference)
    expect(insert).toHaveBeenCalledWith(renderFileReference('main.ts', 'C:\\ws\\proj\\main.ts', 'file'))
  })

  it('right-clicking a directory shows 引用文件夹 and inserts the folder reference', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([dir('src', 'C:\\ws\\proj\\src')]),
    }).restore
    const insert = vi.fn()
    render(<FileTreePanel {...panelProps(insert)} />)
    const row = await screen.findByRole('button', { name: /文件夹 src/ })
    fireEvent.contextMenu(row)
    const reference = await screen.findByRole('menuitem', { name: /引用文件夹/ })
    fireEvent.click(reference)
    expect(insert).toHaveBeenCalledWith(renderFileReference('src', 'C:\\ws\\proj\\src', 'directory'))
  })

  it('copies the path and shows the transient label on success', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([file('main.ts', 'C:\\ws\\proj\\main.ts')]),
    }).restore
    const write = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    try {
      render(<FileTreePanel {...panelProps()} />)
      const row = await screen.findByRole('button', { name: /main\.ts/ })
      fireEvent.contextMenu(row)
      fireEvent.click(await screen.findByRole('menuitem', { name: /复制路径/ }))
      await vi.waitFor(() =>{  expect(write).toHaveBeenCalledWith('C:\\ws\\proj\\main.ts') })
      fireEvent.contextMenu(row)
      // copied 经 writeClipboard 的 promise 微任务生效,findBy 轮询等待菜单项更新。
      expect(await screen.findByRole('menuitem', { name: /已复制路径/ })).toBeTruthy()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('keeps the copy label unchanged when the clipboard write fails', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([file('main.ts', 'C:\\ws\\proj\\main.ts')]),
    }).restore
    const write = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    try {
      render(<FileTreePanel {...panelProps()} />)
      const row = await screen.findByRole('button', { name: /main\.ts/ })
      fireEvent.contextMenu(row)
      fireEvent.click(await screen.findByRole('menuitem', { name: /复制路径/ }))
      await vi.waitFor(() =>{  expect(write).toHaveBeenCalled() })
      fireEvent.contextMenu(row)
      expect(screen.getByRole('menuitem', { name: /复制路径/ })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: /已复制路径/ })).toBeNull()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('clicking a file opens the file info dialog with metadata and preview', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([file('main.ts', 'C:\\ws\\proj\\main.ts')]),
      local_stat_path: () => Promise.resolve({ ...STAT, path: 'C:\\ws\\proj\\main.ts', name: 'main.ts' }),
      local_read_text_file: () => Promise.resolve({ ...READ, path: 'C:\\ws\\proj\\main.ts' }),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const row = await screen.findByRole('button', { name: /main\.ts/ })
    fireEvent.click(row)
    await screen.findByText(/文件信息 — main\.ts/)
    // 元信息表展示路径与大小
    expect(screen.getByText('C:\\ws\\proj\\main.ts')).toBeTruthy()
    expect(screen.getByText('42 B')).toBeTruthy()
    // 内容进入可编辑 textarea(与 Read 卡一致,不再是只读行号预览)
    const editor = screen.getByLabelText('文件内容') as HTMLTextAreaElement
    expect(editor.value).toContain('line1')
    expect(editor.value).toContain('line2')
  })

  it('关闭按钮 in the info dialog closes it', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([file('main.ts', 'C:\\ws\\proj\\main.ts')]),
      local_stat_path: () => Promise.resolve({ ...STAT, path: 'C:\\ws\\proj\\main.ts', name: 'main.ts' }),
      local_read_text_file: () => Promise.resolve({ ...READ, path: 'C:\\ws\\proj\\main.ts' }),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const row = await screen.findByRole('button', { name: /main\.ts/ })
    fireEvent.click(row)
    const dialog = await screen.findByRole('dialog')
    // footer 的「关闭」按钮与 Modal 头部关闭钮同名,取最后一个(footer)。
    const buttons = within(dialog).getAllByRole('button', { name: '关闭' })
    fireEvent.click(buttons[buttons.length - 1]!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('searches files by name and lists the relative path', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([]),
      local_search_files: () => Promise.resolve([
        { path: 'C:\\ws\\proj\\src\\app.ts', name: 'app.ts', kind: 'file', size: 10, modifiedAt: 1, line: null, snippet: null },
      ]),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const input = screen.getByPlaceholderText('搜索文件名…')
    fireEvent.change(input, { target: { value: 'app' } })
    const row = await screen.findByRole('button', { name: /app\.ts/ })
    expect(row).toBeTruthy()
    expect(screen.getByText('src/app.ts')).toBeTruthy()
  })

  it('switches to content search and shows the matching snippet', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([]),
      local_search_files: (args: Record<string, unknown>) => {
        if (args.mode === 'content') {
          return Promise.resolve([
            { path: 'C:\\ws\\proj\\src\\main.ts', name: 'main.ts', kind: 'file', size: 10, modifiedAt: 1, line: 5, snippet: 'const TOKEN = 1' },
          ])
        }
        return Promise.resolve([])
      },
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    fireEvent.click(screen.getByRole('button', { name: '内容' }))
    const input = screen.getByPlaceholderText('搜索文件内容…')
    fireEvent.change(input, { target: { value: 'TOKEN' } })
    const row = await screen.findByRole('button', { name: /main\.ts/ })
    expect(row).toBeTruthy()
    expect(screen.getByText('src/main.ts')).toBeTruthy() // 相对路径
    expect(screen.getByText('const TOKEN = 1')).toBeTruthy() // snippet
  })

  it('shows 无匹配结果 and an empty search still resolves', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([]),
      local_search_files: () => Promise.resolve([]),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const input = screen.getByPlaceholderText('搜索文件名…')
    fireEvent.change(input, { target: { value: 'zzz' } })
    await screen.findByText('无匹配结果')
    // 清空输入回到树视图(根目录行回来)
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByRole('button', { name: /文件夹 proj/ })).toBeTruthy()
  })

  it('shows a search failure message', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([]),
      local_search_files: () => Promise.reject(new Error('search down')),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const input = screen.getByPlaceholderText('搜索文件名…')
    fireEvent.change(input, { target: { value: 'app' } })
    await screen.findByText('search down')
  })

  it('right-clicking a search hit inserts the file reference', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([]),
      local_search_files: () => Promise.resolve([
        { path: 'C:\\ws\\proj\\src\\app.ts', name: 'app.ts', kind: 'file', size: 10, modifiedAt: 1, line: null, snippet: null },
      ]),
    }).restore
    const insert = vi.fn()
    render(<FileTreePanel {...panelProps(insert)} />)
    const input = screen.getByPlaceholderText('搜索文件名…')
    fireEvent.change(input, { target: { value: 'app' } })
    const row = await screen.findByRole('button', { name: /app\.ts/ })
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('menuitem', { name: /引用文件/ }))
    expect(insert).toHaveBeenCalledWith('@app.ts (C:\\ws\\proj\\src\\app.ts)')
  })

  it('clicking a search result opens the file info dialog', async () => {
    restore = stubInvoke({
      local_list_directory: () => Promise.resolve([]),
      local_search_files: () => Promise.resolve([
        { path: 'C:\\ws\\proj\\src\\app.ts', name: 'app.ts', kind: 'file', size: 10, modifiedAt: 1, line: null, snippet: null },
      ]),
      local_stat_path: () => Promise.resolve({ path: 'C:\\ws\\proj\\src\\app.ts', name: 'app.ts', kind: 'file', size: 10, modifiedAt: 1, readonly: false }),
      local_read_text_file: () => Promise.resolve({ path: 'C:\\ws\\proj\\src\\app.ts', content: 'hi', offset: 0, bytesRead: 2, totalBytes: 2, truncated: false }),
    }).restore
    render(<FileTreePanel {...panelProps()} />)
    const input = screen.getByPlaceholderText('搜索文件名…')
    fireEvent.change(input, { target: { value: 'app' } })
    const row = await screen.findByRole('button', { name: /app\.ts/ })
    fireEvent.click(row)
    await screen.findByText(/文件信息 — app\.ts/)
  })
})
