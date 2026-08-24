// @vitest-environment jsdom
/**
 * FileInfoDialog:文件信息弹窗——格式化函数(大小/时间/引用文本/语言 hint)、
 * 大对话框 + ReadBlock 行号预览、「引用到对话框」按钮回调;加载/错误态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  FileInfoDialog, formatFileSize, formatModifiedAt, langFromPath, renderFileReference,
} from '../src/client/file-tree/FileInfoDialog.tsx'

const STAT = {
  path: 'C:\\ws\\proj\\main.ts',
  name: 'main.ts',
  kind: 'file',
  size: 2048,
  modifiedAt: 1_700_000_000,
  readonly: false,
}

function stubInvoke(handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>) {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      const handler = handlers[cmd]
      if (handler === undefined) return Promise.reject(new Error(`unexpected: ${cmd}`))
      return handler(args ?? {})
    },
  }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  cleanup()
  vi.restoreAllMocks()
})

describe('formatters', () => {
  it('formatFileSize renders bytes, KB, MB and above', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(153_600)).toBe('150 KB') // ≥100 → 无小数
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('formatModifiedAt renders a date or 未知 for null', () => {
    expect(formatModifiedAt(1_700_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatModifiedAt(null)).toBe('未知')
  })

  it('renderFileReference produces @name (path) forms', () => {
    expect(renderFileReference('main.ts', 'C:\\p\\main.ts', 'file')).toBe('@main.ts (C:\\p\\main.ts)')
    expect(renderFileReference('src', 'C:\\p\\src', 'directory')).toBe('@src/ (C:\\p\\src)')
    expect(renderFileReference('src/', 'C:\\p\\src', 'directory')).toBe('@src/ (C:\\p\\src)')
  })

  it('langFromPath maps source/config extensions and stays plain for unknown ones', () => {
    expect(langFromPath('C:\\ws\\proj\\main.ts')).toBe('ts')
    expect(langFromPath('/home/u/a.py')).toBe('py')
    expect(langFromPath('conf.yml')).toBe('yaml')
    expect(langFromPath('main.go')).toBe('go')
    expect(langFromPath('.gitignore')).toBeUndefined()
    expect(langFromPath('noext')).toBeUndefined()
  })
})

describe('FileInfoDialog', () => {
  it('renders nothing when path is null', () => {
    const { container } = render(<FileInfoDialog path={null} onClose={vi.fn()} onReference={vi.fn()} />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows metadata and a ReadBlock line-numbered preview, and 引用到对话框 fires onReference', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: 'hello\nworld', offset: 0, bytesRead: 11, totalBytes: 11, truncated: false }),
    })
    const onReference = vi.fn()
    const onClose = vi.fn()
    render(<FileInfoDialog path={STAT.path} onClose={onClose} onReference={onReference} />)
    await screen.findByText(/文件信息 — main\.ts/)
    // 路径出现两处:元信息表 + ReadBlock 横幅
    expect(screen.getAllByText('C:\\ws\\proj\\main.ts').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    // ReadBlock 行号预览:内容按行拆成 gutter + 行文本
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByText('world')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /@ 引用到对话框/ }))
    expect(onReference).toHaveBeenCalledWith('@main.ts (C:\\ws\\proj\\main.ts)')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('marks the preview as truncated when the file is larger than the read window', { timeout: 15_000 }, async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve({ ...STAT, size: 1024 * 1024 }),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: 'x'.repeat(5000), offset: 0, bytesRead: 5000, totalBytes: 1024 * 1024, truncated: true }),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByText(/内容预览\(仅开头 8KB\)/)
  })

  it('marks the preview as truncated when untruncated content exceeds the preview limit', { timeout: 15_000 }, async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: 'x'.repeat(9000), offset: 0, bytesRead: 9000, totalBytes: 9000, truncated: false }),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByText(/内容预览\(仅开头 8KB\)/)
  })

  it('shows 空文件 when the file reads empty without error', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: '', offset: 0, bytesRead: 0, totalBytes: 0, truncated: false }),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByText('空文件')
  })

  it('renders directory and other kinds and the readonly badge', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve({ ...STAT, kind: 'directory', readonly: true }),
      local_read_text_file: () => Promise.reject(new Error('directory')),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByText('文件夹')
    expect(screen.getByText('只读')).toBeTruthy()

    // 其他类型(symlink/unknown)
    cleanup()
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        if (cmd === 'local_stat_path') {
          return Promise.resolve({ ...STAT, kind: 'symlink' })
        }
        return Promise.reject(new Error('directory'))
      },
    }
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByText('symlink')
    delete w.__TAURI_INTERNALS__
  })

  it('references a directory target through the dialog button', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve({ ...STAT, name: 'src', kind: 'directory' }),
      local_read_text_file: () => Promise.reject(new Error('directory')),
    })
    const onReference = vi.fn()
    render(<FileInfoDialog path={'C:\\ws\\proj\\src'} onClose={vi.fn()} onReference={onReference} />)
    await screen.findByText('文件夹')
    fireEvent.click(screen.getByRole('button', { name: /@ 引用到对话框/ }))
    expect(onReference).toHaveBeenCalledWith('@src/ (C:\\ws\\proj\\src)')
  })

  it('shows the read error and still renders metadata when content read fails', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.reject(new Error('binary or unreadable')),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByRole('alert')
    expect(screen.getByText('binary or unreadable')).toBeTruthy()
    // 元信息仍展示
    expect(screen.getByText('C:\\ws\\proj\\main.ts')).toBeTruthy()
  })

  it('renders a plain-string read failure verbatim', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.reject('plain failure'),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByRole('alert')
    expect(screen.getByText('plain failure')).toBeTruthy()
  })

  it('shows an error when stat fails', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.reject(new Error('not found')),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: '', offset: 0, bytesRead: 0, totalBytes: 0, truncated: false }),
    })
    render(<FileInfoDialog path={STAT.path} onClose={vi.fn()} onReference={vi.fn()} />)
    await screen.findByText('无法读取文件信息')
  })

  it('closes via the 关闭 button', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: '', offset: 0, bytesRead: 0, totalBytes: 0, truncated: false }),
    })
    const onClose = vi.fn()
    render(<FileInfoDialog path={STAT.path} onClose={onClose} onReference={vi.fn()} />)
    await screen.findByRole('dialog')
    // footer 的「关闭」按钮与 Modal 头部关闭钮同名,取最后一个(footer)。
    const buttons = screen.getAllByRole('button', { name: '关闭' })
    fireEvent.click(buttons[buttons.length - 1]!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via Escape', async () => {
    restore = stubInvoke({
      local_stat_path: () => Promise.resolve(STAT),
      local_read_text_file: () => Promise.resolve({ path: STAT.path, content: '', offset: 0, bytesRead: 0, totalBytes: 0, truncated: false }),
    })
    const onClose = vi.fn()
    render(<FileInfoDialog path={STAT.path} onClose={onClose} onReference={vi.fn()} />)
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
