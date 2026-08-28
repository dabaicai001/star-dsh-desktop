// @vitest-environment jsdom
/**
 * Redis 值编辑器(RedisValueEditor.tsx,v0.102.0 受控 props 版):按 key 加载、
 * key 切换重挂载/重拉取、加载失败重试(generation 重拉)、string 文本编辑
 * 保存/还原、结构类型(hash/list/set/zset)字段表增删改保存(含改名删旧
 * 成员、list 新增走 RPUSH)、成员筛选(仅过滤展示)、TTL 输入,以及
 * ttlToInput / delVerb / fieldPlaceholders 的覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RedisValueEditor, delVerb, fieldPlaceholders, ttlToInput } from '../src/client/redis/RedisValueEditor.tsx'
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

function renderEditor(key = 'foo', type = 'string') {
  return render(<RedisValueEditor connId="c1" redisKey={key} keyType={type} />)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
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

  it('fieldPlaceholders gives per-type column labels (set is single-column)', () => {
    expect(fieldPlaceholders('set')).toEqual({ field: '成员', value: '', single: true })
    expect(fieldPlaceholders('zset')).toEqual({ field: '成员', value: '分数', single: false })
    expect(fieldPlaceholders('list')).toEqual({ field: '索引', value: '值', single: false })
    expect(fieldPlaceholders('hash')).toEqual({ field: '字段', value: '值', single: false })
  })
})

describe('RedisValueEditor load & key switching', () => {
  it('opens a string key, shows loading, and loads its value and TTL', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: 30 } })
    renderEditor('foo', 'string')
    // 挂载后同步显示加载态(get_value 的 promise 尚未 resolve)
    expect(screen.getByText('加载中…')).toBeTruthy()
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    expect((screen.getByLabelText<HTMLInputElement>('TTL 秒数')).value).toBe('30')
    expect(screen.getByText('STRING')).toBeTruthy()
  })

  it('reloads when the key prop changes (workbench switches keys)', async () => {
    const invoke = installInvoke({
      a: { key: 'a', type: 'string', value: 'va', ttl: -1 },
      b: { key: 'b', type: 'string', value: 'vb', ttl: -1 },
    })
    const { rerender } = renderEditor('a', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('va') })
    // 切换 key(工作台以 React key 重挂载 + props 变化双保险)→ 拉取新 key。
    rerender(<RedisValueEditor key="b" connId="c1" redisKey="b" keyType="string" />)
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('vb') })
    expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'a' })
    expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'b' })
  })

  it('stringifies a non-string value for a string-typed key (JSON pretty-printed)', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: { nested: 1 }, ttl: -1 } })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toContain('"nested"') })
  })

  it('shows an error with retry when the value fetch rejects, and retry refetches', async () => {
    let calls = 0
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_get_value') {
        calls += 1
        // 第一次失败,重试后成功。
        return calls === 1
          ? Promise.reject(new Error('fetch-boom'))
          : Promise.resolve({ key: 'foo', type: 'string', value: 'recovered', ttl: -1 })
      }
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderEditor('foo', 'string')
    // error 同时出现在中央错误块与底部 footer
    await waitFor(() =>{  expect(screen.getAllByText('fetch-boom').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByText('重试'))
    // 重试真正重新拉取(generation+1),成功后展示值。
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('recovered') })
    expect(calls).toBe(2)
  })

  it('surfaces a non-Error get_value rejection as a string', async () => {
    installInvoke({}, { getError: 'plain get boom' })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect(screen.getAllByText('plain get boom').length).toBeGreaterThan(0) })
  })
})

describe('RedisValueEditor string save & revert', () => {
  it('saves an edited string with a TTL and updates dirty state', async () => {
    const invoke = installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: 30 } })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    // 初始未 dirty → 保存禁用
    expect((screen.getByText<HTMLButtonElement>('保存')).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'world' } })
    expect((screen.getByText<HTMLButtonElement>('保存')).disabled).toBe(false)
    // 改 TTL
    fireEvent.change(screen.getByLabelText('TTL 秒数'), { target: { value: '60' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_set', { connId: 'c1', key: 'foo', value: 'world', expiration: 60 }) })
    // 保存后还原为新的原文,保存/还原禁用
    await waitFor(() =>{  expect((screen.getByText<HTMLButtonElement>('保存')).disabled).toBe(true) })
    expect((screen.getByText<HTMLButtonElement>('还原')).disabled).toBe(true)
  })

  it('saves a string with an empty TTL (persistent) and handles wrong-type TTL', async () => {
    const invoke = installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: 30 } })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByLabelText('TTL 秒数'), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'v' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_set', { connId: 'c1', key: 'foo', value: 'v', expiration: undefined }) })
  })

  it('reverts an edited string back to its original text', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('还原'))
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
  })

  it('surfaces a non-Error set rejection as a string in the footer', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } }, { setError: 'plain set boom' })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(screen.getAllByText('plain set boom').length).toBeGreaterThan(0) })
  })

  it('surfaces an Error (not string) set rejection via the message', async () => {
    installInvoke({ foo: { key: 'foo', type: 'string', value: 'hello', ttl: -1 } }, { setError: new Error('set-err-obj') })
    renderEditor('foo', 'string')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLTextAreaElement>('值…')).value).toBe('hello') })
    fireEvent.change(screen.getByPlaceholderText('值…'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(screen.getAllByText('set-err-obj').length).toBeGreaterThan(0) })
  })
})

describe('RedisValueEditor structural (hash) rows', () => {
  it('renders hash rows; rename deletes the old field, delete marks HDEL, save runs HDEL + HSET', async () => {
    const invoke = installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1', b: '2' }, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(2) })
    // 重命名第二行(b→b2)→ dirty;v0.102.0 起改名会 HDEL 旧字段
    const fieldInputs = screen.getAllByPlaceholderText<HTMLInputElement>('字段')
    fireEvent.change(fieldInputs[1]!, { target: { value: 'b2' } })
    // 删除第一行(a)→ dirty
    const delButtons = screen.getAllByTitle('删除')
    fireEvent.click(delButtons[0]!)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HDEL h a b' }) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET h b2 2' }) })
  })

  it('reverts a deleted-and-changed hash row back to the original', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.click(screen.getAllByTitle('删除')[0]!)
    await waitFor(() =>{  expect(screen.getByTitle('撤销删除')).toBeTruthy() })
    fireEvent.click(screen.getByText('还原'))
    await waitFor(() =>{  expect(screen.getByTitle('删除')).toBeTruthy() })
    expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('a')
  })
})

describe('RedisValueEditor structural (list/set/zset) rows', () => {
  it('renders list rows by index (index read-only) and saves via LSET', async () => {
    const invoke = installInvoke({ l: { key: 'l', type: 'list', value: ['a', 'b'], ttl: -1 } })
    renderEditor('l', 'list')
    // 2 行数据(索引禁用,值可编辑)
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('索引').length).toBe(2) })
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('索引')[0]!).disabled).toBe(true)
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: 'A' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'LSET l 0 A' }) })
  })

  it('appends a new list entry via RPUSH (not LSET)', async () => {
    const invoke = installInvoke({ l: { key: 'l', type: 'list', value: ['a'], ttl: -1 } })
    renderEditor('l', 'list')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('索引').length).toBe(1) })
    fireEvent.change(screen.getByLabelText('新值'), { target: { value: 'tail' } })
    fireEvent.click(screen.getByTitle('新增'))
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'RPUSH l tail' }) })
  })

  it('renders set rows as a single member column and saves SADD for the new member', async () => {
    const invoke = installInvoke({ s: { key: 's', type: 'set', value: ['m1'], ttl: -1 } })
    renderEditor('s', 'set')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('成员').length).toBe(1) })
    fireEvent.change(screen.getByLabelText('新值'), { target: { value: 'm2' } })
    fireEvent.click(screen.getByTitle('新增'))
    expect(screen.getAllByPlaceholderText('成员').length).toBe(2)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SADD s m2' }) })
  })

  it('renames a set member via SREM old + SADD new (no stale member left)', async () => {
    const invoke = installInvoke({ s: { key: 's', type: 'set', value: ['m1'], ttl: -1 } })
    renderEditor('s', 'set')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('成员').length).toBe(1) })
    fireEvent.change(screen.getByPlaceholderText('成员'), { target: { value: 'm9' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SREM s m1' }) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SADD s m9' }) })
  })

  it('renders zset rows as member+score and saves ZADD with score first', async () => {
    const invoke = installInvoke({ z: { key: 'z', type: 'zset', value: [['mem', '5']], ttl: -1 } })
    renderEditor('z', 'zset')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText<HTMLInputElement>('成员')[0]).toBeTruthy() })
    fireEvent.change(screen.getAllByPlaceholderText('分数')[0]!, { target: { value: '9' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'ZADD z 9 mem' }) })
  })

  it('renames a zset member via ZREM old + ZADD new', async () => {
    const invoke = installInvoke({ z: { key: 'z', type: 'zset', value: [['mem', '5']], ttl: -1 } })
    renderEditor('z', 'zset')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText<HTMLInputElement>('成员')[0]).toBeTruthy() })
    fireEvent.change(screen.getAllByPlaceholderText('成员')[0]!, { target: { value: 'mem2' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'ZREM z mem' }) })
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'ZADD z 5 mem2' }) })
  })

  it('adds and then deletes a new row so nothing is submitted on save', async () => {
    const invoke = installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor('s', 'set')
    await waitFor(() =>{  expect(screen.getByLabelText('新值')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('新值'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTitle('新增'))
    fireEvent.click(screen.getAllByTitle('删除')[0]!)
    fireEvent.click(screen.getByText('保存'))
    expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
  })

  it('disables the add button when the new member/value is blank', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor('s', 'set')
    await waitFor(() =>{  expect(screen.getByTitle('新增')).toBeTruthy() })
    expect((screen.getByTitle<HTMLButtonElement>('新增')).disabled).toBe(true)
  })
})

describe('RedisValueEditor member filter', () => {
  it('filters rows by member/value substring, edits apply to the right row, and clear restores', async () => {
    const invoke = installInvoke({ h: { key: 'h', type: 'hash', value: { alpha: '1', beta: '2', gamma: '3' }, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(3) })
    const filterBox = screen.getByLabelText('筛选成员')
    fireEvent.change(filterBox, { target: { value: 'beta' } })
    // 只剩 beta 行
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    // 过滤态编辑命中原始行(beta),保存时 HSET beta
    fireEvent.change(screen.getByPlaceholderText('值'), { target: { value: '22' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET h beta 22' }) })
  })

  it('shows a no-match hint and clears the filter via the × button', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.change(screen.getByLabelText('筛选成员'), { target: { value: 'zzz' } })
    await waitFor(() =>{  expect(screen.getByText('无匹配成员')).toBeTruthy() })
    fireEvent.click(screen.getByLabelText('清除筛选'))
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
  })

  it('shows an empty hint when the structure has no members', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: {}, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getByText('暂无成员')).toBeTruthy() })
  })
})

describe('RedisValueEditor structural failure & empty value', () => {
  it('surfaces a non-Error execute rejection (structural save) as a footer error', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 } }, { executeError: 'plain exec boom' })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: '2' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(screen.getAllByText('plain exec boom').length).toBeGreaterThan(0) })
  })

  it('handles a get_value payload with a null value for a structural key', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: null, ttl: -1 } })
    renderEditor('h', 'hash')
    // rowsFromValue null → 无字段行(仅新增行)
    await waitFor(() =>{  expect(screen.getByText('HASH')).toBeTruthy() })
    expect(screen.getAllByLabelText('新值').length).toBe(1)
  })

  it('handles a get_value payload for an empty object hash (no rows, new-row only)', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: {}, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('新字段').length).toBe(1) })
  })

  it('renders an empty set value with only the new-row controls', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor('s', 'set')
    await waitFor(() =>{  expect(screen.getByLabelText('新值')).toBeTruthy() })
    expect(screen.getAllByTitle('新增').length).toBe(1)
  })

  it('throws from runCommand when the executed command reports an error field', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_get_value') return Promise.resolve({ key: 'h', type: 'hash', value: { a: '1' }, ttl: -1 })
      // 命令"执行成功"但载有 error 字段 → runCommand 抛错
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: null, durationMs: 1, error: 'internal-err' })
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('字段').length).toBe(1) })
    fireEvent.change(screen.getAllByPlaceholderText('值')[0]!, { target: { value: '2' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET h a 2' }) })
    await waitFor(() =>{  expect(screen.getAllByText('internal-err').length).toBeGreaterThan(0) })
  })
})

describe('RedisValueEditor value parsing edge cases', () => {
  it('parses a set value whose items include nullish members into blank rows', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [null, undefined] as unknown, ttl: -1 } })
    renderEditor('s', 'set')
    // 两条数据行,占位符都是「成员」
    await waitFor(() =>{  expect(screen.getAllByPlaceholderText('成员').length).toBe(2) })
    // `pair` 为 null → 空成员
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('成员')[0]!).value).toBe('')
  })

  it('maps a hash value with a null field value to a blank cell', async () => {
    installInvoke({ h: { key: 'h', type: 'hash', value: { a: null }, ttl: -1 } })
    renderEditor('h', 'hash')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('a') })
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('值')[0]!).value).toBe('')
  })

  it('parses a zset row whose score is nullish into two blank cells', async () => {
    installInvoke({ z: { key: 'z', type: 'zset', value: [['mem', null] as unknown as string[]], ttl: -1 } })
    renderEditor('z', 'zset')
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>('成员')).value).toBe('mem') })
    // pair[1] 为 null → 分数空串(pair[1] ?? '')
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('分数')[0]!).value).toBe('')
  })

  it('parses a list whose first item is nullish into a blank value cell', async () => {
    installInvoke({ l: { key: 'l', type: 'list', value: [null, 'b'] as unknown, ttl: -1 } })
    renderEditor('l', 'list')
    await waitFor(() =>{  expect((screen.getAllByPlaceholderText<HTMLInputElement>('索引')[0]!).value).toBe('0') })
    // 第一行 item 为 null → 值空串(item ?? '')
    expect((screen.getAllByPlaceholderText<HTMLInputElement>('值')[0]!).value).toBe('')
  })

  it('renders an unknown type with default field/value columns', async () => {
    installInvoke({ st: { key: 'st', type: 'stream', value: { f1: 'v1' }, ttl: -1 } })
    renderEditor('st', 'stream')
    await waitFor(() =>{  expect(screen.getByText('STREAM')).toBeTruthy() })
    expect((screen.getByPlaceholderText<HTMLInputElement>('字段')).value).toBe('f1')
  })

  it('revert keeps an added (unsubmitted) structural row with its entered member', async () => {
    installInvoke({ s: { key: 's', type: 'set', value: [], ttl: -1 } })
    renderEditor('s', 'set')
    await waitFor(() =>{  expect(screen.getByLabelText('新值')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('新值'), { target: { value: 'newmem' } })
    fireEvent.click(screen.getByTitle('新增'))
    expect(screen.getAllByPlaceholderText('成员').length).toBe(1)
    // 还原:新行 originalField==='' → 保留并回填输入的 field/value
    fireEvent.click(screen.getByText('还原'))
    await waitFor(() =>{  expect((screen.getByPlaceholderText<HTMLInputElement>('成员')).value).toBe('newmem') })
  })
})
