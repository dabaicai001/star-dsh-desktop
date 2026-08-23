// @vitest-environment jsdom
/**
 * Redis 工作台(RedisWorkbench.tsx):连接/断连生命周期、DB 切换、键列表(SCAN/
 * 搜索/刷新/空态/错误)、键操作(打开/重命名/删除/清空/新建)、CLI,以及打开
 * RedisValueEditor 的值编辑分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RedisWorkbench } from '../src/client/redis/RedisWorkbench.tsx'
import type { RustAsset } from '../src/client/store.ts'

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown

function stubInvoke(handler: InvokeHandler): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke: handler }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

const asset: RustAsset = {
  id: 'r1', type: 'db', name: 'redis-1', group_id: null,
  config: { host: 'h', port: 6379, password: 'secret', ssl: false },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

const keyInfo = (key: string, type = 'string') => ({ key, type, ttl: -1 })

/** 测试拒绝:统一为 Error(组件展示文本与直接 reject 原值一致)。 */
function rejectAsError(e: Error | string): Promise<never> {
  return Promise.reject(typeof e === 'string' ? new Error(e) : e)
}

/** 安装 Tauri 调用分发 stub;`opts` 覆盖各命令返回。 */
function installTauri(opts?: {
  connectError?: Error | string
  sizeError?: Error | string
  scanError?: Error | string
  selectError?: Error | string
  delError?: Error | string
  renameError?: Error | string
  flushError?: Error | string
  executeError?: Error | string
  connectNoId?: boolean
}) {
  const invoke = vi.fn((cmd: string) => {
    switch (cmd) {
      case 'db_redis_connect': return opts?.connectError ? rejectAsError(opts.connectError) : Promise.resolve(opts?.connectNoId ? {} : { connId: 'c1', host: 'h', port: 6379 })
      case 'db_redis_db_size': return opts?.sizeError ? rejectAsError(opts.sizeError) : Promise.resolve({ size: 2 })
      case 'db_redis_scan': return opts?.scanError ? rejectAsError(opts.scanError) : Promise.resolve({ keys: [keyInfo('user:1'), keyInfo('sess:2', 'hash')], cursor: 0, total: 2 })
      case 'db_redis_get_value': return Promise.resolve({ key: 'user:1', type: 'string', value: 'v', ttl: -1 })
      case 'db_redis_select': return opts?.selectError ? rejectAsError(opts.selectError) : Promise.resolve(null)
      case 'db_redis_del': return opts?.delError ? rejectAsError(opts.delError) : Promise.resolve({ deleted: 1 })
      case 'db_redis_rename': return opts?.renameError ? rejectAsError(opts.renameError) : Promise.resolve(null)
      case 'db_redis_flush_db': return opts?.flushError ? rejectAsError(opts.flushError) : Promise.resolve(null)
      case 'db_redis_execute': return opts?.executeError ? rejectAsError(opts.executeError) : Promise.resolve({ result: 'OK', durationMs: 1 })
      case 'db_redis_disconnect': return Promise.resolve(null)
      default: return Promise.resolve(null)
    }
  })
  return invoke
}

function renderWorkbench(assetOverride: RustAsset = asset, onClose = vi.fn()) {
  return { onClose, ...render(<RedisWorkbench asset={assetOverride} onClose={onClose} />) }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('RedisWorkbench connect & list', () => {
  it('connects with asset config + password, loads the key list, and renders the dashboard', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: 'h', port: 6379, db: 0, ssl: false, password: 'secret' } }) })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1' })) })
      await waitFor(() =>{  expect(screen.getByText('已连接')).toBeTruthy() })
      expect(screen.getByTitle('user:1')).toBeTruthy()
      expect(screen.getByTitle('sess:2')).toBeTruthy()
      // keyCount from db_size
      expect(screen.getByText(/2 keys/)).toBeTruthy()
      expect((screen.getByRole<HTMLSelectElement>('combobox')).value).toBe('0')
    } finally {
      restore()
    }
  })

  it('uses default host/port when the config fields are missing or wrong-typed', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench({ ...asset, config: { host: 123, ssl: true } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: '', port: 6379, db: 0, ssl: true } }) })
    } finally {
      restore()
    }
  })

  it('shows the empty state when the key list is empty', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('surfaces a key-list error with a working retry', async () => {
    const invoke = installTauri({ scanError: new Error('scan-fail') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText(/加载失败:scan-fail/)).toBeTruthy() })
      fireEvent.click(screen.getByText('重试'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1' })) })
    } finally {
      restore()
    }
  })

  it('surfaces a scan failure given as a plain-string option', async () => {
    const invoke = installTauri({ scanError: 'plain scan boom' })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText(/加载失败:plain scan boom/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('surfaces a connect rejection with a back action and a missing-connId connect', async () => {
    const onClose = vi.fn()
    const invoke = installTauri({ connectError: new Error('conn-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench(asset, onClose)
      await waitFor(() =>{  expect(screen.getByText('conn-boom')).toBeTruthy() })
      fireEvent.click(screen.getByText('返回'))
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
    // 连接返回无 connId → 抛错 → errorBar
    const invoke2 = installTauri({ connectNoId: true })
    const restore2 = stubInvoke(invoke2)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText(/未返回 connId/)).toBeTruthy() })
    } finally {
      restore2()
    }
  })
})

describe('RedisWorkbench actions', () => {
  it('switches DB, refreshes the list, and surfaces a switch failure toast', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByLabelText('搜索 key')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('搜索 key'), { target: { value: 'user:*' } })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 3 }) })
      expect((screen.getByRole<HTMLSelectElement>('combobox')).value).toBe('3')
    } finally {
      restore()
    }
    cleanup()
    // select 失败 → toast
    const invokeErr = installTauri({ selectError: new Error('sel-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByLabelText('搜索 key')).toBeTruthy() })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '5' } })
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('refreshes the key list via the refresh button', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.click(screen.getByLabelText('刷新'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(before) })
    } finally {
      restore()
    }
  })

  it('groups keys into a folder tree by ":" and collapses folders on click', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      // 默认全展开:文件夹行(user / sess)+ 叶子(末段名)都在。
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.getByLabelText('文件夹 user')).toBeTruthy()
      expect(screen.getByLabelText('文件夹 sess')).toBeTruthy()
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true')
      // 折叠 user 文件夹 → 其叶子隐藏;sess 分支不受影响。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.queryByTitle('user:1')).toBeNull() })
      expect(screen.getByTitle('sess:2')).toBeTruthy()
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      // 再点展开 → 叶子恢复。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('opens a key into the value editor and shows the placeholder otherwise', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('选择一个 key 查看 / 编辑')).toBeTruthy() })
      fireEvent.click(screen.getByTitle('user:1'))
      // RedisValueEditor 通过 openRef 立即打开该 key → get_value
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'user:1' }) })
      expect(screen.queryByText('选择一个 key 查看 / 编辑')).toBeNull()
    } finally {
      restore()
    }
  })

  it('deletes a key after confirm, closes the value editor for that key, and guards on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 先打开值编辑器
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.anything()) })
      // 取消删除 → 不调用
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      expect(invoke).not.toHaveBeenCalledWith('db_redis_del', expect.anything())
      // 确认删除 → 调用 + toast + 值编辑器关闭(同 key)
      confirmSpy.mockReturnValue(true)
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['user:1'] }) })
      await waitFor(() =>{  expect(screen.getByText('已删除:user:1')).toBeTruthy() })
      await waitFor(() =>{  expect(screen.getByText('选择一个 key 查看 / 编辑')).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('surfaces a delete failure toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = installTauri({ delError: new Error('del-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:del-boom/)).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('renames a key, closes on cancel/empty, and surfaces a rename failure toast', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      // 空名确认 → 关闭 renameBar,不调用
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: '' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_rename', expect.anything())
      // 重新打开 + 改名确认
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'user:9' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_rename', { connId: 'c1', oldKey: 'user:1', newKey: 'user:9' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已重命名')).toBeTruthy() })
    } finally {
      restore()
    }
    cleanup()
    // rename 失败 toast
    const invokeErr = installTauri({ renameError: new Error('ren-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.getByText(/重命名失败:ren-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('flushes the DB after confirm, guards on cancel, and surfaces a failure toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      expect(invoke).not.toHaveBeenCalledWith('db_redis_flush_db', expect.anything())
      confirmSpy.mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_flush_db', { connId: 'c1' }) })
      await waitFor(() =>{  expect(screen.getByText(/db0 已清空/)).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
    cleanup()
    // flush 失败 toast
    const confirmSpy2 = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invokeErr = installTauri({ flushError: new Error('fl-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:fl-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
      confirmSpy2.mockRestore()
    }
  })
})

describe('RedisWorkbench CLI & new key', () => {
  it('runs a CLI command on Enter and via the execute button', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // 空命令 Enter → 早退
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
      fireEvent.change(input, { target: { value: 'GET foo' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'GET foo' }) })
      await waitFor(() =>{  expect(screen.getByText('OK')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('dumps a non-object command result via String() and surfaces a rejection', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: 123, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'PING' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('123')).toBeTruthy() })
    } finally {
      restore()
    }
    cleanup()
    // execute 拒绝 → 输出错误串
    const invokeErr = installTauri({ executeError: new Error('exec-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input2 = screen.getByLabelText('命令输入')
      fireEvent.change(input2, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('exec-boom')).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('creates a new key through the modal, cancels, and guards empty names', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 空 key → 创建按钮禁用
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      expect((screen.getByText<HTMLButtonElement>('创建')).disabled).toBe(true)
      // 取消
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() =>{  expect(screen.queryByLabelText('key 名')).toBeNull() })
      // 重新打开 + 输入 + 创建
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'newkey' } })
      fireEvent.change(screen.getByLabelText('值(string)'), { target: { value: "it's" } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: "SET newkey 'it\\'s'" }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      await waitFor(() =>{  expect(screen.queryByLabelText('key 名')).toBeNull() })
    } finally {
      restore()
    }
  })

  it('enforces the empty-key guard in createKey and surfaces a create failure toast', async () => {
    // 空 key 直接触发 createKey(按钮禁用但 fireEvent 会派发)→ 覆盖 `key === ''` 早退
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.click(screen.getByText('创建'))
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
    } finally {
      restore()
    }
    cleanup()
    // 创建失败 toast
    const invokeErr = installTauri({ executeError: new Error('create-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:create-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('closes via the header close button and calls onClose', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    const onClose = vi.fn()
    try {
      renderWorkbench(asset, onClose)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByText('关闭'))
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('RedisWorkbench failure variants & CLI output', () => {
  it('surfaces a db-size failure during the initial refresh', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.reject(new Error('plain size'))
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText(/获取键数失败:plain size/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('surfaces failure text for switch/delete/rename/flush/create', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 1 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      if (cmd === 'db_redis_select') return Promise.reject(new Error('plain-sel'))
      if (cmd === 'db_redis_del') return Promise.reject(new Error('plain-del'))
      if (cmd === 'db_redis_rename') return Promise.reject(new Error('plain-ren'))
      if (cmd === 'db_redis_flush_db') return Promise.reject(new Error('plain-fl'))
      if (cmd === 'db_redis_execute') return Promise.reject(new Error('plain-exec'))
      return Promise.resolve(null)
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // switchDb 失败
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } })
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:plain-sel/)).toBeTruthy() })
      // delete 失败
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:plain-del/)).toBeTruthy() })
      // rename 失败
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.getByText(/重命名失败:plain-ren/)).toBeTruthy() })
      // flush 失败
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:plain-fl/)).toBeTruthy() })
      // create(execute) 失败
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:plain-exec/)).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('dumps an object CLI result via JSON.stringify', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: { ok: 1 }, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'HGETALL k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText(/"ok": 1/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('handles a null CLI result (empty output) and a runCli rejection', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: undefined, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // 非 Enter 键 → 不触发执行
      fireEvent.keyDown(input, { key: 'a' })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
      // undefined 结果 → 走 `res.result ?? ''` 回退,输出空串(不渲染 pre)
      fireEvent.change(input, { target: { value: 'PING' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'PING' }) })
      expect(screen.queryByText('undefined')).toBeNull()
    } finally {
      restore()
    }
    cleanup()
    // execute 拒绝 → 输出错误串
    const invokeErr = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.reject(new Error('plain-exec'))
      return Promise.resolve(null)
    })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input2 = screen.getByLabelText('命令输入')
      fireEvent.change(input2, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('plain-exec')).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('cancels an in-progress rename via the cancel button', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
    } finally {
      restore()
    }
  })

  it('surfaces an Error db-size failure during the initial refresh', async () => {
    const invoke = installTauri({ sizeError: new Error('size-err') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText(/获取键数失败:size-err/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('keeps the value editor open when deleting a different key', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 打开 user:1 的值编辑器
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.anything()) })
      // 删除不同的 key(sess:2)→ openValue(user:1) 保留下 (cur?.key !== key → cur)
      fireEvent.click(screen.getByLabelText('删除 sess:2'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['sess:2'] }) })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.objectContaining({ key: 'user:1' })) })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })
})
