// @vitest-environment jsdom
/**
 * SSH 执行记录抽屉(v0.100.0 重构;v0.100.1 会话隔离 + 行内断开):
 * - exec-records 桥:note 去重置顶 / 上限淘汰 / 非 dsh 会话忽略 / 按活跃
 *   会话过滤(setConversation)/ removeSession 跨视角移除 / 清空只作用当前会话;
 * - 订阅:tauriListen 注册 ssh:exec-done 并过滤后写入,disposer 反注册;
 * - ExecDrawerButton:开合回调与计数角标(计数已随隔离过滤);
 * - ExecRecordList:行点击展开/收起、行尾「断开连接」、清空与返回。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createExecRecordsBridge, subscribeSshExecEvents,
  type ExecRecord, type ExecRecordsState, type SshExecDoneEvent,
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

/** 组件测试记录构造:默认挂在 conv-A 下(桥外直接给数据的场景)。 */
function rec(sessionId: string, overrides: Partial<ExecRecord> = {}): ExecRecord {
  return { sessionId, conversationId: 'conv-A', command: 'ls', output: '', at: 0, ...overrides }
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

  it('shows nothing until tracking starts, then isolates records per conversation', () => {
    const bridge = createExecRecordsBridge()
    // 未喂入任何会话前(兼容模式):不过滤,全量可见
    bridge.note(makeEvent('dsh:a1:ssh', 'ls', ''))
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:a1:ssh'])
    // 跟踪开启后打上「当时会话」标记;未标记的历史条目在隔离态不可见
    bridge.setConversation('conv-B')
    expect(bridge.source.getSnapshot().records).toHaveLength(0)
    bridge.note(makeEvent('dsh:b1:ssh', 'df', ''))
    bridge.note(makeEvent('dsh:b2:ssh', 'free', ''))
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:b2:ssh', 'dsh:b1:ssh'])
    expect(bridge.source.getSnapshot().records.every(r => r.conversationId === 'conv-B')).toBe(true)
    // 切回另一会话:B 的记录隐藏,A 只见本会话新产生的
    bridge.setConversation('conv-A')
    expect(bridge.source.getSnapshot().records).toHaveLength(0)
    bridge.note(makeEvent('dsh:a2:ssh', 'uptime', ''))
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:a2:ssh'])
    bridge.setConversation('conv-B')
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:b2:ssh', 'dsh:b1:ssh'])
  })

  it('hides a closed connection everywhere once removeSession runs', () => {
    const bridge = createExecRecordsBridge()
    bridge.setConversation('conv-A')
    bridge.note(makeEvent('dsh:a1:ssh', 'ls', ''))
    bridge.setConversation('conv-B')
    bridge.note(makeEvent('dsh:b1:ssh', 'df', ''))
    // 从 A 视角断开 B 正在用的连接:A 不受影响
    bridge.setConversation('conv-A')
    bridge.removeSession('dsh:b1:ssh')
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:a1:ssh'])
    // 切到 B:该连接的记录已消失
    bridge.setConversation('conv-B')
    expect(bridge.source.getSnapshot().records).toHaveLength(0)
    // 未知连接的移除是无害 no-op
    bridge.removeSession('dsh:none:ssh')
    expect(bridge.source.getSnapshot().records).toHaveLength(0)
  })

  it('scopes 清空 to the current conversation and leaves other sessions untouched', () => {
    const bridge = createExecRecordsBridge()
    bridge.setConversation('conv-A')
    bridge.note(makeEvent('dsh:a1:ssh', 'ls', ''))
    bridge.setConversation('conv-B')
    bridge.note(makeEvent('dsh:b1:ssh', 'df', ''))
    bridge.clear()
    expect(bridge.source.getSnapshot().records).toHaveLength(0)
    // B 清空后切回 A:A 的记录仍在
    bridge.setConversation('conv-A')
    expect(bridge.source.getSnapshot().records.map(r => r.sessionId)).toEqual(['dsh:a1:ssh'])
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
      rec('dsh:a1:ssh'),
      rec('dsh:a2:ssh'),
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
    rec('dsh:asset-9:ssh', { command: 'docker ps -a | head -3', output: 'CONTAINER ID   IMAGE\na1b2c3 nginx', at: Date.now() }),
  ]

  it('renders rows collapsed by default and expands the full output on click', () => {
    render(<ExecRecordList records={records} onClose={vi.fn()} onClear={vi.fn()} onDisconnect={vi.fn()} />)
    expect(screen.getByText('$ docker ps -a | head -3')).toBeTruthy()
    expect(screen.queryByText(/CONTAINER ID/)).toBeNull()

    fireEvent.click(screen.getByTitle(/^asset-9\(点击/))
    expect(screen.getByText(/CONTAINER ID/)).toBeTruthy()

    fireEvent.click(screen.getByTitle(/^asset-9\(点击/))
    expect(screen.queryByText(/CONTAINER ID/)).toBeNull()
  })

  it('calls onDisconnect with the connection id from the row close button', () => {
    const onDisconnect = vi.fn()
    render(<ExecRecordList records={records} onClose={vi.fn()} onClear={vi.fn()} onDisconnect={onDisconnect} />)
    fireEvent.click(screen.getByRole('button', { name: '断开 asset-9 的连接并移除记录' }))
    expect(onDisconnect).toHaveBeenCalledWith('dsh:asset-9:ssh')
  })

  it('clears current-conversation records and returns to the asset list via the injected callbacks', () => {
    const onClose = vi.fn()
    const onClear = vi.fn()
    render(<ExecRecordList records={records} onClose={onClose} onClear={onClear} onDisconnect={vi.fn()} />)
    expect(screen.getByText('SSH 执行记录').textContent).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy() // 记录条数角标
    fireEvent.click(screen.getByText('清空'))
    expect(onClear).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('返回资产列表'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the empty state with 清空 disabled when there are no records', () => {
    render(<ExecRecordList records={[]} onClose={vi.fn()} onClear={vi.fn()} onDisconnect={vi.fn()} />)
    expect(screen.getByText(/暂无记录/)).toBeTruthy()
    expect((screen.getByText('清空') as HTMLButtonElement).disabled).toBe(true)
  })
})
