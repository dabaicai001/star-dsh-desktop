// @vitest-environment jsdom
/**
 * Redis 值编辑器(RedisValueEditor.tsx):tab 生命周期、string 文本编辑保存/还原、
 * 结构类型(hash/list/set/zset)字段表增删改保存、TTL 输入、加载/错误/重试分支,
 * 以及 ttlToInput / delVerb / rowsFromValue / revertRows 的覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RedisValueEditor, delVerb, ttlToInput } from '../src/client/redis/RedisValueEditor.tsx'
import type { RedisValueResult } from '../src/client/redis/redis-service.ts'

/** 测试拒绝:统一为 Error(组件展示文本与直接 reject 原值一致)。 */
function rejectAsError(e: Error | string): Promise<never> {
  return Promise.reject(typeof e === 'string' ? new Error(e) : e)
}

/** 安装 Tauri 调用分发 stub;`values` 按 key 提供 get_value 载荷。 */
function installInvoke(
  values: Record<string, RedisValueResult>,
  opts?: { getError?: Error | string; executeError?: Error | string; setError?: Error | string },
) {
  const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'db_redis_get_value': {
        const key = args?.key as string
        if (opts?.getError) return rejectAsError(opts.getError)
        return Promise.resolve(values[key] ?? { key, type: 'string', value: '', ttl: -1 })
      }
      case 'db_redis_execute': return opts?.executeError ? rejectAsError(opts.executeError) : Promise.resolve({ result: 'OK', durationMs: 1 })
      case 'db_redis_set': return opts?.setError ? rejectAsError(opts.setError) : Promise.resolve(null)
      default: return Promise.resolve(null)
    }
  })
  ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
  return invoke
}

let openFn: ((key: string, type: string) => void) | undefined

function captureOpen(open: (key: string, type: string) => void) {
  openFn = open
}

function renderEditor() {
  return render(<RedisValueEditor connId="c1" openRef={captureOpen} />)
}

function open(key: string, type: string) {
  act(() => { openFn?.(key, type) })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  openFn = undefined
})

describe('RedisValueEditor exports', () => {
  it('ttlToInput returns empty for negative TTL and the number otherwise', () => {
    expect(ttlToInput(-1)).toBe('')
    expect(ttlToInput(30)).toBe('30')
    expect(ttlToInput(0)).toBe('0')
  })

  it('delVerb maps type to the member-removal verb', () => {
    expect(delVerb('hash')).toBe('HDEL')
    expect(delVerb('set')).toBe('SREM')
    expect(delVerb('zset')).toBe('ZREM')
    expect(delVerb('list')).toBe('LREM')
    expect(delVerb('OTHER')).toBe('LREM')
  })
})

describe('RedisValueEditor empty & load', () => {
  it('shows the empty state before any key is opened', () => {
    installInvoke({})
    renderEditor()
    expect(screen.getByText('未选择 Key')).toBeTruthy()
  })

  it('opens a string key, shows loading, and loads its value and TTL', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: 30 } })
    renderEditor()
    open('foo', 'string')
    // open 后同步显示加载态(get_value 的 promise 尚未 resolve)
    expect(screen.getByText('加载中…')).toBeTruthy()
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    expect((screen.getByPlaceholderText<HTMLInputElement>('30')).value).toBe('30')
    expect(screen.getByText('STRING')).toBeTruthy()
  })

  it('stringifies a non-string value for a string-typed key (JSON pretty-printed)', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: { nested: 1 }, ttl: -1 } })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toContain('"nested"') })
  })

  it('shows an error with retry when the value fetch rejects', async () => {
    installInvoke({}, { getError: new Error('fetch-boom') })
    renderEditor()
    open('foo', 'string')
    // error 同时出现在中央错误块与底部 footer
    await waitFor(() =>{  expect(screen.getAllByText('fetch-boom').length).toBeGreaterThan(0) })
    // 重试:把 loading 置 true、清 error → 回到加载态(覆盖 retry onClick)
    fireEvent.click(screen.getByText('重试'))
    expect(screen.getByText('加载中…')).toBeTruthy()
  })

  it('surfaces a non-Error get_value rejection as a string', async () => {
    installInvoke({}, { getError: 'plain get boom' })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect(screen.getAllByText('plain get boom').length).toBeGreaterThan(0) })
  })
})

describe('RedisValueEditor string save & revert', () => {
  it('saves an edited string with a TTL and updates dirty state', async () => {
    const invoke = installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: 30 } })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    // 初始未 dirty → 保存禁用
    expect((screen.getByText<HTMLButtonElement>('保存')).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'world' } })
    expect((screen.getByText<HTMLButtonElement>('保存')).disabled).toBe(false)
    // 改 TTL
    fireEvent.change(screen.getByPlaceholderText('30'), { target: { value: '60' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_set', { connId: 'c1', key: 'foo', value: 'world', expiration: 60 }) })
    // 保存后还原为新的原文,保存/还原禁用
    await waitFor(() =>{  expect((screen.getByText<HTMLButtonElement>('保存')).disabled).toBe(true) })
    expect((screen.getByText<HTMLButtonElement>('还原')).disabled).toBe(true)
  })

  it('saves a string with an empty TTL (persistent) and handles wrong-type TTL', async () => {
    const invoke = installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: 30 } })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('30'), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'v' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_set', { connId: 'c1', key: 'foo', value: 'v', expiration: undefined }) })
  })

  it('reverts an edited string back to its original text', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('还原'))
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
  })

  it('surfaces a non-Error set rejection as a string in the footer', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } }, { setError: 'plain set boom' })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(screen.getAllByText('plain set boom').length).toBeGreaterThan(0) })
  })
})

describe('RedisValueEditor structural (hash) rows', () => {
  it('renders hash rows, deletes one, edits another, and saves HDEL + HSET', async () => {
    const invoke = installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1', b: '2' }, ttl: -1 } })
    renderEditor()
    open('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(2) })
    // 重命名第二行(b→b2)→ dirty
    const fieldInputs = screen.getAllByPlaceholderText<HTMLInputElement>('字段')
    fireEvent.change(fieldInputs[1]!, { target: { value: 'b2' } })
    // 删除第一行(a)→ dirty
    const delButtons = screen.getAllByTitle('删除')
    fireEvent.click(delButtons[0]!)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HDEL h a' }) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET h b2 2' }) })
  })

  it('reverts a deleted-and-changed hash row back to the original', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 } })
    renderEditor()
    open('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.click(screen.getAllByTitle('删除')[0]!)
    await waitFor(() =>{  expect(screen.getByTitle('撤销删除')).toBeTruthy() })
    fireEvent.click(screen.getByText('还原'))
    await waitFor(() =>{  expect(screen.getByTitle('删除')).toBeTruthy() })
    expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('a')
  })
})

describe('RedisValueEditor structural (list/set/zset) rows', () => {
  it('renders list rows by index and saves via LSET', async () => {
    const invoke = installInvoke({ l: { key: 'l', type: 'list', value: ['a', 'b'], ttl: -1 } })
    renderEditor()
    open('l', 'list')
    // 2 行数据 + 1 新增行,list 下字段占位符都是「索引」
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('索引').length).toBe(3) })
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: 'A' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'LSET l 0 A' }) })
  })

  it('renders set rows (scalar members) and saves via SADD for the new row', async () => {
    const invoke = installInvoke({ s: { key: 's', type: 'set', value: ['m1'], ttl: -1 } })
    renderEditor()
    open('s', 'set')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.change(screen.getByPlaceholderText('新字段'), { target: { value: 'm2' } })
    fireEvent.change(screen.getByPlaceholderText('新值'), { target: { value: '1' } })
    fireEvent.click(screen.getByTitle('新增'))
    expect(screen.getAllByPlaceholderText('字段').length).toBe(2)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SADD s m2' }) })
  })

  it('renders zset rows as [member, score] pairs and saves ZADD with score first', async () => {
    const invoke = installInvoke({ z: { key: 'z', type: 'zset', value: [['mem', '5']], ttl: -1 } })
    renderEditor()
    open('z', 'zset')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText<HTMLInputElement>('字段')[0]).toBeTruthy() })
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: '9' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'ZADD z 9 mem' }) })
  })

  it('adds and then deletes a new row so nothing is submitted on save', async () => {
    const invoke = installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor()
    open('s', 'set')
    await waitFor(() =>{  expect(screen.getByPlaceholderText('新字段')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('新字段'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTitle('新增'))
    fireEvent.click(screen.getAllByTitle('删除')[0]!)
    fireEvent.click(screen.getByText('保存'))
    expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
  })

  it('disables the add button when the new-field name is blank', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor()
    open('s', 'set')
    await waitFor(() =>{  expect(screen.getByTitle('新增')).toBeTruthy() })
    expect((screen.getByTitle<HTMLButtonElement>('新增')).disabled).toBe(true)
  })
})

describe('RedisValueEditor structural failure & empty value', () => {
  it('surfaces a non-Error execute rejection (structural save) as a footer error', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 } }, { executeError: 'plain exec boom' })
    renderEditor()
    open('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: '2' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(screen.getAllByText('plain exec boom').length).toBeGreaterThan(0) })
  })

  it('handles a get_value payload with a null value for a structural key', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: null, ttl: -1 } })
    renderEditor()
    open('h', 'hash')
    // rowsFromValue null → 无字段行(仅新增行占位符)
    await waitFor(() =>{  expect(screen.getByText('HASH')).toBeTruthy() })
    expect(screen.getAllByPlaceholderText('新字段').length).toBe(1)
  })

  it('handles a get_value payload for an empty object hash (no rows, new-row only)', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: {}, ttl: -1 } })
    renderEditor()
    open('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('新字段').length).toBe(1) })
  })

  it('renders an empty set value with only the new-row controls', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor()
    open('s', 'set')
    await waitFor(() =>{  expect(screen.getByPlaceholderText('新字段')).toBeTruthy() })
    expect(screen.getAllByTitle('新增').length).toBe(1)
  })
})

describe('RedisValueEditor extra branches', () => {
  it('re-opens an already-open key by bumping generation instead of a new tab', async () => {
    const invoke = installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_get_value').length
    // 再次打开同一 key → 触发重新加载(generation+1),不新增 tab
    open('foo', 'string')
    await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_get_value').length).toBeGreaterThan(before) })
  })

  it('mounts without an openRef (no-op) and stays in the empty state', () => {
    installInvoke({})
    // 不传 openRef → 挂载 effect 的 `openRef !== undefined` 走 false 分支
    render(<RedisValueEditor connId="c1" />)
    expect(screen.getByText('未选择 Key')).toBeTruthy()
  })

  it('revert keeps an added (unsubmitted) structural row with its entered field/value', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor()
    open('s', 'set')
    await waitFor(() =>{  expect(screen.getByPlaceholderText('新字段')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('新字段'), { target: { value: 'newmem' } })
    fireEvent.change(screen.getByPlaceholderText('新值'), { target: { value: '1' } })
    fireEvent.click(screen.getByTitle('新增'))
    expect(screen.getAllByPlaceholderText('字段').length).toBe(1)
    // 还原:新行 originalField==='' → 保留并回填输入的 field/value
    fireEvent.click(screen.getByText('还原'))
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('newmem') })
  })

  it('surfaces an Error (not string) set rejection via the message', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } }, { setError: new Error('set-err-obj') })
    renderEditor()
    open('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(screen.getAllByText('set-err-obj').length).toBeGreaterThan(0) })
  })

  it('throws from runCommand when the executed command reports an error field', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_get_value') return Promise.resolve({ key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 })
      // 命令"执行成功"但载有 error 字段 → runCommand 抛错
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: null, durationMs: 1, error: 'internal-err' })
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderEditor()
    open('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: '2' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET h a 2' }) })
    await waitFor(() =>{  expect(screen.getAllByText('internal-err').length).toBeGreaterThan(0) })
  })

  it('parses a set value whose items include nullish members into blank rows', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [null, undefined] as unknown, ttl: -1 } })
    renderEditor()
    open('s', 'set')
    // 两条数据行 + 新增行,占位符都是「字段」
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(2) })
    // `pair` 为 null → 空字段与空值
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('字段')[0]!).value).toBe('')
  })

  it('maps a hash value with a null field value to a blank cell', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: null }, ttl: -1 } })
    renderEditor()
    open('h', 'hash')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('a') })
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('值')[0]!).value).toBe('')
  })

  it('parses a zset row whose score is nullish into two blank cells', async () => {
    installInvoke({ z: { key: 'z', type: 'zset', value: [['mem', null] as unknown as string[]], ttl: -1 } })
    renderEditor()
    open('z', 'zset')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('mem') })
    // pair[1] 为 null → 值空串(pair[1] ?? '')
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('值')[0]!).value).toBe('')
  })

  it('parses a list whose first item is nullish into a blank value cell', async () => {
    installInvoke({ l: { key: 'l', type: 'list', value: [null, 'b'] as unknown, ttl: -1 } })
    renderEditor()
    open('l', 'list')
    await waitFor(() =>{  expect((screen.getAllByPlaceholderText<HTMLInputElement>('索引')[0]!).value).toBe('0') })
    // 第一行 item 为 null → 值空串(item ?? '')
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('值')[0]!).value).toBe('')
  })
})
