// @vitest-environment jsdom
/**
 * SSH 执行记录抽屉(v0.100.0 重构,替代右下角 BastionExecPanel 浮层):
 * - exec-records 桥:note 去重置顶 / 上限淘汰 / 非 dsh 会话忽略 / clear;
 * - 订阅:tauriListen 注册 ssh:exec-done 并过滤后写入,disposer 反注册;
 * - ExecDrawerButton:开合回调与计数角标;
 * - ExecRecordList:行点击展开/收起、清空与返回。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createExecRecordsBridge, subscribeSshExecEvents,
  type ExecRecordsState, type SshExecDoneEvent,
} from '../src/client/conn/exec-records.ts'
import { ExecDrawerButton } from '../src/client/conn/ExecDrawerButton.tsx'
import { ExecRecordList } from '../src/client/conn/ExecRecordList.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

/** 挂载 Tauri internals:transformCallback 记录监听回调,invoke 记录调用。 */
function stubInternals(callbacks: Array<(event: unknown) => void>, invoke: ReturnType<typeof vi.fn>) {
  ;(window as unknown as {
    __TAURI_INTERNALS__: { invoke: typeof invoke; transformCallback: (cb: (event: unknown) => void) => number }
  }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback) => {
      callbacks.push(callback)
      return callbacks.length
    },
  }
}

function makeEvent(sessionId: string, command: string, output: string): SshExecDoneEvent {
  return { sessionId, command, output }
}

describe('createExecRecordsBridge', () => {
  it('keeps the latest record per session at the top and ignores non-dsh sessions', () => {
    const bridge = createExecRecordsBridge()
    bridge.note(makeEvent('dsh:a1:ssh', 'ls', 'one'))
    bridge.note(makeEvent('dsh:a2:ssh', 'df', 'two'))
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:a2:ssh', 'dsh:a1:ssh'])
    // 同连接再次执行:替换旧条目并置顶(不产生第二条)
    bridge.note(makeEvent('dsh:a1:ssh', 'uptime', 'fresh'))
    const records = bridge.source.getSnapshot().records
    expect(records).toHaveLength(2)
    expect(records[0]!.sessionId).toBe('dsh:a1:ssh')
    expect(records[0]!.command).toBe('uptime')
    // 非 dsh 会话(AI 域工具以外)不入列
    bridge.note(makeEvent('plain-session', 'whoami', 'root'))
    expect(bridge.source.getSnapshot().records).toHaveLength(2)
  })

  it('evicts the oldest record beyond the cap and clears on demand', () => {
    const bridge = createExecRecordsBridge()
    for (let i = 0; i < 55; i++) {
      bridge.note(makeEvent(`dsh:cap-${i}:ssh`, `cmd-${i}`, ''))
    }
    const records = bridge.source.getSnapshot().records
    expect(records).toHaveLength(50)
    expect(records[0]!.sessionId).toBe('dsh:cap-54:ssh')
    expect(records.at(-1)!.sessionId).toBe('dsh:cap-5:ssh')
    bridge.clear()
    expect(bridge.source.getSnapshot().records).toHaveLength(0)
  })

  it('toggles the drawer view flag through openView/closeView', () => {
    const bridge = createExecRecordsBridge()
    expect(bridge.source.getSnapshot().viewOpen).toBe(false)
    bridge.openView()
    expect(bridge.source.getSnapshot().viewOpen).toBe(true)
    bridge.closeView()
    expect(bridge.source.getSnapshot().viewOpen).toBe(false)
  })
})

describe('subscribeSshExecEvents', () => {
  it('feeds dsh events into note and unlistens on dispose', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'plugin:event|unlisten') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    stubInternals(callbacks, invoke)

    const bridge = createExecRecordsBridge()
    const dispose = subscribeSshExecEvents(bridge.note)
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'ssh:exec-done', target: { kind: 'Any' } })) })

    callbacks[0]!({ event: 'ssh:exec-done', id: 1, payload: makeEvent('dsh:a1:ssh', 'ls', 'out') })
    await waitFor(() => { expect(bridge.source.getSnapshot().records).toHaveLength(1) })

    void dispose()
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', expect.objectContaining({ event: 'ssh:exec-done' })) })
  })
})

describe('ExecDrawerButton', () => {
  /** 最小 header-actions runtime 面 + 注入面(同 file-tree-button spec 桩法)。 */
  function buttonProps(state: ExecRecordsState) {
    const unused = (): never => { throw new Error('unused share') }
    return {
      sessionId: 'sess-1' as never,
      useSessions: unused as never,
      useSession: unused as never,
      useProjection: unused as never,
      useInput: unused as never,
      inputActions: {} as never,
      openExecView: vi.fn(),
      closeExecView: vi.fn(),
      useExecRecords: <S,>(sel: (s: ExecRecordsState) => S): S => sel(state),
    } as unknown as Parameters<typeof ExecDrawerButton>[0]
  }

  it('opens the exec view and shows the record count when closed', () => {
    const props = buttonProps({ viewOpen: false, records: [
      { sessionId: 'dsh:a1:ssh', command: 'ls', output: '', at: 0 },
      { sessionId: 'dsh:a2:ssh', command: 'df', output: '', at: 1 },
    ] })
    render(<ExecDrawerButton {...props} />)
    const pill = screen.getByRole('button', { name: /执行/ })
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(pill.textContent).toContain('2')
    fireEvent.click(pill)
    expect(props.openExecView).toHaveBeenCalledTimes(1)
    expect(props.closeExecView).not.toHaveBeenCalled()
  })

  it('closes back to the asset list when already open', () => {
    const props = buttonProps({ viewOpen: true, records: [] })
    render(<ExecDrawerButton {...props} />)
    const pill = screen.getByRole('button', { name: /执行/ })
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(pill)
    expect(props.closeExecView).toHaveBeenCalledTimes(1)
    expect(props.openExecView).not.toHaveBeenCalled()
  })
})

describe('ExecRecordList', () => {
  const records = [
    { sessionId: 'dsh:asset-9:ssh', command: 'docker ps -a | head -3', output: 'CONTAINER ID   IMAGE\na1b2c3 nginx', at: Date.now() },
  ]

  it('renders rows collapsed by default and expands the full output on click', () => {
    render(<ExecRecordList records={records} onClose={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByText('$ docker ps -a | head -3')).toBeTruthy()
    expect(screen.queryByText(/CONTAINER ID/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /asset-9/ }))
    expect(screen.getByText(/CONTAINER ID/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /asset-9/ }))
    expect(screen.queryByText(/CONTAINER ID/)).toBeNull()
  })

  it('clears all records and returns to the asset list via the injected callbacks', () => {
    const onClose = vi.fn()
    const onClear = vi.fn()
    render(<ExecRecordList records={records} onClose={onClose} onClear={onClear} />)
    expect(screen.getByText('SSH 执行记录').textContent).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy() // 记录条数角标
    fireEvent.click(screen.getByText('清空'))
    expect(onClear).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('返回资产列表'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the empty state with 清空 disabled when there are no records', () => {
    render(<ExecRecordList records={[]} onClose={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByText(/暂无记录/)).toBeTruthy()
    expect((screen.getByText('清空') as HTMLButtonElement).disabled).toBe(true)
  })
})
