// @vitest-environment jsdom
/**
 * FileTreeButton:会话头部「文件树」胶囊——无会话 cwd 不渲染;点击调用
 * openFileTree / closeFileTree(视图开合与文案切换)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { FileTreeButton, type FileTreeButtonProps } from '../src/client/file-tree/FileTreeButton.tsx'
import type { FileTreeState } from '../src/client/file-tree/state.ts'

const SID = 'sess-1' as SessionId

function makeUseSessions(cwd?: string): FileTreeButtonProps['useSessions'] {
  const stub = <T,>(selector: (state: { byId: Record<string, { cwd?: string } | undefined> }) => T): T =>
    selector({ byId: { 'sess-1': cwd === undefined ? undefined : { cwd } } })
  return stub as unknown as FileTreeButtonProps['useSessions']
}

function buttonProps(cwd?: string): FileTreeButtonProps {
  const unused = (): never => { throw new Error('unused share') }
  const fileTree = createSnapshotStore<FileTreeState>({ open: false })
  return {
    sessionId: SID,
    useSessions: makeUseSessions(cwd),
    useSession: unused as never,
    useProjection: unused as never,
    useInput: unused as never,
    inputActions: {} as never,
    openFileTree: vi.fn(),
    closeFileTree: vi.fn(),
    useFileTree: <S,>(sel: (s: FileTreeState) => S): S => sel(fileTree.getSnapshot()),
  } as unknown as FileTreeButtonProps
}

afterEach(cleanup)

describe('FileTreeButton', () => {
  it('renders nothing without a session cwd', () => {
    const { container } = render(<FileTreeButton {...buttonProps()} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('renders the closed pill and opens the file tree on click', () => {
    const props = buttonProps('C:\\ws\\proj')
    render(<FileTreeButton {...props} />)
    const pill = screen.getByRole('button', { name: /文件/ })
    fireEvent.click(pill)
    expect(props.openFileTree).toHaveBeenCalledTimes(1)
    expect(props.closeFileTree).not.toHaveBeenCalled()
  })

  it('switches to the open label and closes on click when already open', () => {
    const fileTree = createSnapshotStore<FileTreeState>({ open: true })
    const props = buttonProps('C:\\ws\\proj')
    const open = vi.fn()
    const close = vi.fn()
    render((
      <FileTreeButton
        {...props}
        openFileTree={open}
        closeFileTree={close}
        useFileTree={<S,>(sel: (s: FileTreeState) => S): S => sel(fileTree.getSnapshot())}
      />
    ))
    const pill = screen.getByRole('button', { name: /文件树/ })
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(pill)
    expect(close).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
})
