// @vitest-environment jsdom
/**
 * DbDataGrid(需求 5 React 化,批次 3 + 批次 5 补齐):服务端分页结果网格——
 * 挂载拉取 db_mysql_get_table_data,列头排序(服务端 orderBy/orderDir)、分页
 * (页大小 / 上页下页)、NULL 高亮、行号/值渲染;批次 5:CSV 导出(rowsToCsv /
 * downloadTextFile)、行复制为 INSERT(rowToInsert / sqlLiteral / 右键菜单)、
 * 列筛选(columnFilters 服务端参数 + 弹层应用/清除)、单元格编辑(dirty 集 →
 * db_mysql_update_rows 按行批量保存,Ctrl/Cmd+S)。纯函数与组件 UI 全覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DbDataGrid, cellText, downloadTextFile, rowsToCsv, rowToInsert, sqlLiteral } from '../src/client/DbDataGrid.tsx'

const RESULT = {
  columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }, { name: 'note', type: 'TEXT', nullable: true }],
  rows: [[1, 'alice', null], [2, 'bob', 'here']],
  totalRows: 2,
  isSelect: true,
}

/** stub window.__TAURI_INTERNALS__.invoke:get_table_data / list_columns / update_rows。 */
function stubInvoke(opts: {
  failLoad?: boolean
  failUpdate?: boolean
  zeroAffected?: boolean
  noPk?: boolean
  updateRowsError?: string
} = {}) {
  const calls: Array<[cmd: string, args: Record<string, unknown>]> = []
  const invoke = vi.fn((cmdOrName: string, args?: Record<string, unknown>) => {
    const a = (args ?? {})
    calls.push([cmdOrName, a])
    if (cmdOrName === 'db_mysql_get_table_data') {
      if (opts.failLoad) return Promise.reject(new Error('raw failure'))
      return Promise.resolve(RESULT)
    }
    if (cmdOrName === 'db_mysql_list_columns') {
      if (opts.noPk) return Promise.resolve([{ name: 'id', key: '' }, { name: 'name', key: '' }])
      return Promise.resolve([{ name: 'id', key: 'PRI' }, { name: 'name', key: '' }])
    }
    if (cmdOrName === 'db_mysql_update_rows') {
      if (opts.failUpdate) return Promise.reject(new Error('update failed'))
      if (opts.zeroAffected) return Promise.resolve({ rowsAffected: 0 })
      if (opts.updateRowsError !== undefined) return Promise.resolve({ rowsAffected: 0, error: opts.updateRowsError })
      return Promise.resolve({ rowsAffected: 1 })
    }
    return Promise.reject(new Error(`unexpected ${cmdOrName}`))
  })
  ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
  return { invoke, calls }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  // 清理下载创建的 DOM 节点。
  document.body.innerHTML = ''
})

describe('DbDataGrid pure helpers', () => {
  it('cellText renders NULL / objects / primitives', () => {
    expect(cellText(null)).toBe('NULL')
    expect(cellText(undefined)).toBe('NULL')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText(42)).toBe('42')
    expect(cellText('x')).toBe('x')
  })

  it('sqlLiteral quotes strings, escapes quotes, passes numbers', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(7)).toBe('7')
    expect(sqlLiteral(true)).toBe('TRUE')
    expect(sqlLiteral(false)).toBe('FALSE')
    expect(sqlLiteral("it's")).toBe("'it''s'")
  })

  it('rowToInsert builds a quoted INSERT statement', () => {
    const cols = [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }]
    expect(rowToInsert('users', cols, [1, "o'brien"])).toBe(
      'INSERT INTO `users` (`id`, `name`) VALUES (1, \'o\'\'brien\');',
    )
  })

  it('rowsToCsv escapes commas, quotes, newlines and emits null as empty', () => {
    const cols = [{ name: 'a' }, { name: 'b' }]
    expect(rowsToCsv(cols, [[1, null], ['x,y', 'say "hi"']])).toBe('a,b\n1,\n"x,y","say ""hi"""')
  })

  it('downloadTextFile creates a blob link and clicks it', () => {
    const createSpy = vi.fn(() => 'blob:fake')
    const revokeSpy = vi.fn()
    const clickSpy = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: createSpy, revokeObjectURL: revokeSpy })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clickSpy)
    downloadTextFile('out.csv', 'a,b')
    expect(createSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake')
  })
})

describe('DbDataGrid', () => {
  it('loads on mount and renders columns, row numbers, values, and NULL markers', async () => {
    stubInvoke()
    render(<DbDataGrid connId="c1" table="users" database="app" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    expect(screen.getByText('id')).toBeTruthy()
    expect(screen.getByText('name')).toBeTruthy()
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
    expect(screen.getByText('bob')).toBeTruthy()
    expect(screen.getAllByText('NULL').length).toBeGreaterThan(0)
    expect(screen.getByText(/1 \/ 1/)).toBeTruthy()
  })

  it('passes sort args on column click and toggles direction', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(calls.length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByText('name'))
    await waitFor(() =>{  expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'asc')).toBe(true) })
    fireEvent.click(screen.getByText('name'))
    await waitFor(() =>{  expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'desc')).toBe(true) })
  })

  it('shows an error state when the request fails', async () => {
    stubInvoke({ failLoad: true })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('raw failure')).toBeTruthy() })
  })

  it('renders object cells as JSON text', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({
          columns: [{ name: 'meta', type: 'JSON' }],
          rows: [[{ a: 1 }]],
          totalRows: 1,
          isSelect: true,
        })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([{ name: 'meta', key: '' }])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText(JSON.stringify({ a: 1 }))).toBeTruthy() })
  })

  it('fetches primary keys via list_columns on mount', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    expect(calls.some(([cmd, a]) => cmd === 'db_mysql_list_columns' && a.table === 'users')).toBe(true)
  })

  it('shows the CSV export button and downloads current page', async () => {
    stubInvoke()
    const { getByText } = render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const createSpy = vi.fn(() => 'blob:fake')
    const revokeSpy = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: createSpy, revokeObjectURL: revokeSpy })
    const clickSpy = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clickSpy)
    fireEvent.click(getByText('导出 CSV'))
    expect(createSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
  })

  it('disables CSV export when there are no rows', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [{ name: 'id', type: 'BIGINT' }], rows: [], totalRows: 0, isSelect: true })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('导出 CSV').hasAttribute('disabled')).toBe(true) })
  })

  it('applies a column filter via the popover and passes columnFilters server-side', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.click(screen.getByLabelText('筛选 name'))
    const input = screen.getByPlaceholderText('输入筛选值…')
    fireEvent.change(input, { target: { value: 'alice' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([, a]) => {
      const f = a.columnFilters as Record<string, string> | undefined
      return f !== undefined && f.name === 'alice'
    })).toBe(true) })
    // 筛选 badge 出现。
    expect(screen.getByText('1 个筛选')).toBeTruthy()
  })

  it('applies a quick filter via Enter and passes quickFilter server-side', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const input = screen.getByLabelText('快捷筛选')
    fireEvent.change(input, { target: { value: 'ali' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([, a]) => a.quickFilter === 'ali')).toBe(true) })
  })

  it('clears the quick filter via the × button and stops passing it', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const input = screen.getByLabelText('快捷筛选')
    fireEvent.change(input, { target: { value: 'ali' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([, a]) => a.quickFilter === 'ali')).toBe(true) })
    fireEvent.click(screen.getByLabelText('清除快捷筛选'))
    await waitFor(() =>{  expect((calls[calls.length - 1]?.[1].quickFilter ?? '')).toBe('') })
  })

  it('resets the quick filter when the table changes', async () => {
    const { calls } = stubInvoke()
    const { rerender } = render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const input = screen.getByLabelText('快捷筛选')
    fireEvent.change(input, { target: { value: 'ali' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(calls.some(([, a]) => a.quickFilter === 'ali')).toBe(true) })
    rerender(<DbDataGrid connId="c1" table="orders" />)
    await waitFor(() =>{  expect((screen.getByLabelText('快捷筛选') as HTMLInputElement).value).toBe('') })
  })

  it('clears a column filter and removes the badge', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.click(screen.getByLabelText('筛选 name'))
    const input = screen.getByPlaceholderText('输入筛选值…')
    fireEvent.change(input, { target: { value: 'alice' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText('1 个筛选')).toBeTruthy() })
    fireEvent.click(screen.getByLabelText('筛选 name'))
    fireEvent.click(screen.getByText('清除'))
    await waitFor(() =>{  expect(screen.queryByText('1 个筛选')).toBeNull() })
    expect(calls.some(([, a]) => (a.columnFilters as Record<string, string> | undefined)?.name === '')).toBeFalsy()
  })

  it('dismisses the filter popover with Escape', async () => {
    stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.click(screen.getByLabelText('筛选 name'))
    const input = screen.getByPlaceholderText('输入筛选值…')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('输入筛选值…')).toBeNull()
  })

  it('copies the row as INSERT via the row context menu', async () => {
    stubInvoke()
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    // 右键第一行 → 菜单出现 → 点「复制为 INSERT」。
    const rowEl = screen.getByText('alice').closest('[role="row"]')
    expect(rowEl).not.toBeNull()
    fireEvent.contextMenu(rowEl as HTMLElement)
    const item = await screen.findByText('复制为 INSERT')
    fireEvent.click(item)
    await waitFor(() =>{  expect(writeText).toHaveBeenCalled() })
    const sql = writeText.mock.calls[0]?.[0] as string
    expect(sql).toContain('INSERT INTO `users`')
    expect(sql).toContain('VALUES (1, \'alice\', NULL)')
  })

  it('edits a cell into the dirty set and saves via db_mysql_update_rows', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    // 双击 name 列(alice 单元格)。
    const alice = screen.getByText('alice')
    fireEvent.doubleClick(alice)
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    expect(editInput).not.toBeNull()
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    // dirty 出现 → 保存按钮。
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && (a.sets as Record<string, unknown>).name === 'alicia')).toBe(true) })
    // WHERE 用主键定位第一行。
    const upd = calls.find(([cmd]) => cmd === 'db_mysql_update_rows')
    expect(upd?.[1].where).toContain('`id` = 1')
  })

  it('shows an error when saving without primary keys', async () => {
    const { calls } = stubInvoke({ noPk: true })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const alice = screen.getByText('alice')
    fireEvent.doubleClick(alice)
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(screen.getByText('表缺少主键列,无法定位行更新')).toBeTruthy() })
    expect(calls.some(([cmd]) => cmd === 'db_mysql_update_rows')).toBe(false)
  })

  it('shows the backend error when update_rows reports an error', async () => {
    stubInvoke({ updateRowsError: 'fk violation' })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(screen.getByText('fk violation')).toBeTruthy() })
  })

  it('reports when an update affects zero rows', async () => {
    stubInvoke({ zeroAffected: true })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(screen.getByText(/更新 0 行/)).toBeTruthy() })
  })

  it('shows an error when the update request rejects', async () => {
    stubInvoke({ failUpdate: true })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(screen.getByText('update failed')).toBeTruthy() })
  })

  it('saves via Ctrl/Cmd+S and cancels an edit with Escape', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Escape' })
    // Escape 取消编辑,不产生 dirty。
    expect(screen.queryByText(/保存 1/)).toBeNull()
    // 再编辑一次,用 Ctrl+S 保存。
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput2 = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput2, { target: { value: 'alicia' } })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && (a.sets as Record<string, unknown>).name === 'alicia')).toBe(true) })
  })

  it('restores the original value when the edit matches the original', async () => {
    stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    // 原值 alice → 不改。
    fireEvent.change(editInput, { target: { value: 'alice' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    expect(screen.queryByText(/保存 1/)).toBeNull()
  })

  it('invokes the onExport callback with current sort state', async () => {
    const { calls } = stubInvoke()
    const onExport = vi.fn()
    render(<DbDataGrid connId="c1" table="users" onExport={onExport} />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.click(screen.getByText('name'))
    await waitFor(() =>{  expect(calls.some(([, a]) => a.orderBy === 'name')).toBe(true) })
    fireEvent.click(screen.getByText('导出 Excel'))
    expect(onExport).toHaveBeenCalledWith('name', 'asc')
  })

  it('handles a column without a type hint', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [{ name: 'raw' }], rows: [['x']], totalRows: 1, isSelect: true })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('x')).toBeTruthy() })
    expect(screen.getByText('raw')).toBeTruthy()
  })

  it('tracks scroll position and shows durationMs', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({
          columns: [{ name: 'id', type: 'BIGINT' }],
          rows: Array.from({ length: 50 }, (_, i) => [i]),
          totalRows: 50,
          durationMs: 12,
          isSelect: true,
        })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([{ name: 'id', key: 'PRI' }])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('12 ms')).toBeTruthy() })
    const viewport = document.querySelector('[role="rowgroup"]') as HTMLElement
    fireEvent.scroll(viewport, { target: { scrollTop: 28 * 5 } })
    // 滚动后行号从 6 开始渲染(可见首行)。
    await waitFor(() =>{  expect(screen.getAllByText('6').length).toBeGreaterThan(0) })
  })

  it('pages forward and backward when totalRows exceeds the page size', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, (args ?? {})])
      if (cmd === 'db_mysql_get_table_data') {
        const offset = Number((args as Record<string, unknown>).offset ?? 0)
        return Promise.resolve({
          columns: [{ name: 'id', type: 'BIGINT' }],
          rows: Array.from({ length: 100 }, (_, i) => [offset + i]),
          totalRows: 250,
          isSelect: true,
        })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([{ name: 'id', key: 'PRI' }])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('0')).toBeTruthy() })
    const next = screen.getByText<HTMLButtonElement>('下一页')
    expect(next.disabled).toBe(false)
    fireEvent.click(next)
    await waitFor(() =>{  expect(screen.getByText(/2 \/ 3/)).toBeTruthy() })
    fireEvent.click(screen.getByText('上一页'))
    await waitFor(() =>{  expect(screen.getByText(/1 \/ 3/)).toBeTruthy() })
  })

  it('changes the page size via the select and resets to page 1', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({
          columns: [{ name: 'id', type: 'BIGINT' }],
          rows: Array.from({ length: 100 }, (_, i) => [i]),
          totalRows: 500,
          isSelect: true,
        })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([{ name: 'id', key: 'PRI' }])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText(/1 \/ 5/)).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('每页行数'), { target: { value: '500' } })
    await waitFor(() =>{  expect(screen.getByText(/1 \/ 1/)).toBeTruthy() })
  })

  it('commits the pending edit on blur', async () => {
    stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.blur(editInput)
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
  })

  it('shows a backend error embedded in the query result', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [], rows: [], error: 'syntax error near x' })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('syntax error near x')).toBeTruthy() })
  })

  it('formats a non-Error rejection as a string', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        // 非 Error 拒绝值:组件按 String(e) 兜底渲染,测试保持非 Error 路径。
        return Promise.resolve().then(() => { throw 'boom-string' })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('boom-string')).toBeTruthy() })
  })

  it('ignores a list_columns failure', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [{ name: 'id', type: 'BIGINT' }], rows: [[7]], totalRows: 1, isSelect: true })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.reject(new Error('no perms'))
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('7')).toBeTruthy() })
    // 主键获取失败不应阻塞浏览(无错误条)。
    expect(screen.queryByText('no perms')).toBeNull()
  })

  it('stages an empty edit as NULL', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: '' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && (a.sets as Record<string, unknown>).name === null)).toBe(true) })
  })

  it('parses a numeric edit into a number', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    // id 列显示 "1" —— 与行号冲突,用行内 id 单元格精确双击。
    const idValue = [...document.querySelectorAll('[role="row"]')].map(r =>
      [...r.querySelectorAll('[role="gridcell"]')].find(c => c.textContent === '1'))
    void idValue
    const firstRow = screen.getByText('alice').closest('[role="row"]') as HTMLElement
    const cells = firstRow.querySelectorAll('div[title]')
    const idCell = [...cells].find(c => c.getAttribute('title') === '1') ?? null
    expect(idCell).not.toBeNull()
    fireEvent.doubleClick(idCell as HTMLElement)
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: '99' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && (a.sets as Record<string, unknown>).id === 99)).toBe(true) })
  })

  it('keeps a non-numeric edit as text on a numeric column', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const firstRow = screen.getByText('alice').closest('[role="row"]') as HTMLElement
    const cells = firstRow.querySelectorAll('div[title]')
    const idCell = [...cells].find(c => c.getAttribute('title') === '1') ?? null
    fireEvent.doubleClick(idCell as HTMLElement)
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'abc' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && (a.sets as Record<string, unknown>).id === 'abc')).toBe(true) })
  })

  it('toggles sort direction back to asc on a third click', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.click(screen.getByText('name'))
    await waitFor(() =>{  expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'asc')).toBe(true) })
    fireEvent.click(screen.getByText('name'))
    await waitFor(() =>{  expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'desc')).toBe(true) })
    fireEvent.click(screen.getByText('name'))
    await waitFor(() =>{  expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'asc')).toBe(true) })
  })

  it('is a no-op when pressing Ctrl+S without dirty edits', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(calls.some(([cmd]) => cmd === 'db_mysql_update_rows')).toBe(false)
  })

  it('handles a composite primary key marker (PRI,)', async () => {
    const { calls } = stubInvoke()
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, (args ?? {})])
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({
          columns: [{ name: 'id', type: 'BIGINT' }, { name: 'org', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }],
          rows: [[1, 7, 'alice']],
          totalRows: 1,
          isSelect: true,
        })
      }
      if (cmd === 'db_mysql_list_columns') {
        return Promise.resolve([{ name: 'id', key: 'PRI' }, { name: 'org', key: 'PRI,' }])
      }
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && (a.where as string).includes('`org` = 7'))).toBe(true) })
  })

  it('tolerates a clipboard write failure', async () => {
    stubInvoke()
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    const rowEl = screen.getByText('alice').closest('[role="row"]') as HTMLElement
    fireEvent.contextMenu(rowEl)
    const item = await screen.findByText('复制为 INSERT')
    fireEvent.click(item)
    await waitFor(() =>{  expect(writeText).toHaveBeenCalled() })
  })

  it('passes the database to update_rows when provided', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" database="app" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(calls.some(([cmd, a]) => cmd === 'db_mysql_update_rows' && a.database === 'app')).toBe(true) })
  })

  it('formats a non-Error saveAll rejection as a string', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }], rows: [[1, 'alice']], totalRows: 1, isSelect: true })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([{ name: 'id', key: 'PRI' }])
      if (cmd === 'db_mysql_update_rows') {
        // 非 Error 拒绝值:组件按 String(e) 兜底渲染,测试保持非 Error 路径。
        return Promise.resolve().then(() => { throw 'update-boom' })
      }
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(screen.getByText('update-boom')).toBeTruthy() })
  })

  it('reports a missing pk column in the result as an error', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }], rows: [[1, 'alice']], totalRows: 1, isSelect: true })
      }
      // 主键列「uid」不在查询结果列里 → WHERE 拼不出 → 报错。
      if (cmd === 'db_mysql_list_columns') return Promise.resolve([{ name: 'uid', key: 'PRI' }])
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('alice')).toBeTruthy() })
    fireEvent.doubleClick(screen.getByText('alice'))
    const editInput = screen.getByTestId<HTMLInputElement>('cell-edit-input')
    fireEvent.change(editInput, { target: { value: 'alicia' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() =>{  expect(screen.getByText(/保存 1/)).toBeTruthy() })
    fireEvent.click(screen.getByText(/保存 1/))
    await waitFor(() =>{  expect(screen.getByText('表缺少主键列,无法定位行更新')).toBeTruthy() })
  })

  it('tolerates a null list_columns payload', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({ columns: [{ name: 'id', type: 'BIGINT' }], rows: [[9]], totalRows: 1, isSelect: true })
      }
      if (cmd === 'db_mysql_list_columns') return Promise.resolve(null)
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() =>{  expect(screen.getByText('9')).toBeTruthy() })
  })
})
