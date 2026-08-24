// @vitest-environment jsdom
/**
 * Redis 工作台(RedisWorkbench.tsx):连接/断连生命周期、DB 树(默认全收起,
 * 点击才懒加载该 db 的键;展开/收起/切换/缓存命中)、键树(文件夹分组/搜索/
 * 刷新/空态/错误重试)、键操作(打开/重命名/删除/清空/新建)、CLI,以及打开
 * RedisValueEditor 的值编辑分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/** 等待连接完成(DB 树按钮在连接前点击会被守卫忽略)。 */
async function waitConnected() {
  await waitFor(() =>{  expect(screen.getByText('已连接')).toBeTruthy() })
}

/** 点击展开/收起指定 db。 */
function clickDb(db: number) {
  fireEvent.click(screen.getByRole('button', { name: `数据库 db${db}` }))
}

/** 连接后展开 db0,点开 user 文件夹并等默认 stub 的 user:1 渲染出来。 */
async function expandDb0WithKeys() {
  await waitConnected()
  clickDb(0)
  const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
  fireEvent.click(userFolder)
  await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('RedisWorkbench connect & DB tree', () => {
  it('connects with asset config + password and renders the DB tree collapsed without fetching keys', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: 'h', port: 6379, db: 0, ssl: false, password: 'secret' } })
      // 懒加载:连接后不取任何 db 的键。
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(0)
      // 16 个 db 全收起。
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db15' }).getAttribute('aria-expanded')).toBe('false')
      // 头栏回退到 activeDb(db0),键数为 0;刷新钮在未展开时禁用。
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db0')
      expect(screen.getByTestId('redis-head-count').textContent).toBe('0 keys')
      expect((screen.getByLabelText('刷新') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText('选择一个 key 查看 / 编辑')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('uses default host/port when the config fields are missing or wrong-typed', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench({ ...asset, config: { host: 123, ssl: true } })
      await waitConnected()
      expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: '', port: 6379, db: 0, ssl: true } })
    } finally {
      restore()
    }
  })

  it('expanding a DB lazily loads its keys with folders collapsed by default', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // db0 已是客户端当前库:只 scan + db_size,不 select。
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1' })) })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_select', expect.anything())
      // 键文件夹默认收起:文件夹行在,叶子隐藏。
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTitle('user:1')).toBeNull()
      expect(screen.queryByTitle('sess:2')).toBeNull()
      // 点击文件夹才展开该文件夹的叶子;其余文件夹仍收起。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true')
      expect(screen.queryByTitle('sess:2')).toBeNull()
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      // 头栏 + db 行计数徽标随懒加载更新。
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db0')
      expect(screen.getByTestId('redis-head-count').textContent).toBe('2 keys')
      expect(within(screen.getByRole('button', { name: '数据库 db0' })).getByText('2')).toBeTruthy()
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      restore()
    }
  })

  it('expanding another DB switches the client and collapses the previous one', async () => {
    // 每次 SCAN 返回不同键:精确区分「db0 已卸载」与「db3 已加载」。
    let scanCount = 0
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') {
        scanCount += 1
        return Promise.resolve(scanCount === 1
          ? { keys: [keyInfo('user:1'), keyInfo('sess:2', 'hash')], cursor: 0 }
          : { keys: [keyInfo('other:9')], cursor: 0 })
      }
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(userFolder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 先点开 db3 的键文件夹,便于断言其键行。
      clickDb(3)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 3 }) })
      await waitFor(() =>{  expect(screen.getByTestId('redis-head-badge').textContent).toBe('db3') })
      const otherFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 other') })
      fireEvent.click(otherFolder)
      await waitFor(() =>{  expect(screen.getByTitle('other:9')).toBeTruthy() })
      // db0 收起:其键行与文件夹卸载(换到 db3 自己的键);db3 展开。
      expect(screen.queryByTitle('user:1')).toBeNull()
      expect(screen.queryByLabelText('文件夹 user')).toBeNull()
      await waitFor(() =>{  expect(screen.getByTitle('other:9')).toBeTruthy() })
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db3' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      restore()
    }
  })

  it('collapse keeps the cache (no refetch on re-expand) and closes the value editor', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 先打开一个 key 的值编辑器。
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'user:1' }) })
      // 收起:键行卸载、值编辑器关闭、头栏回退到 activeDb。
      clickDb(0)
      await waitFor(() =>{  expect(screen.queryByTitle('user:1')).toBeNull() })
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db0')
      expect(screen.getByText('选择一个 key 查看 / 编辑')).toBeTruthy()
      // 缓存命中:再展开不重复请求,键立即回来。
      const scansBefore = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(scansBefore) })
    } finally {
      restore()
    }
  })

  it('surfaces a switch rejection with a reverted expand (Error and plain-string)', async () => {
    const onClose = vi.fn()
    const invoke = installTauri({ selectError: new Error('sel-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      clickDb(5)
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-boom/)).toBeTruthy() })
      // 切换失败 → 展开回退(两个 db 都收起,db0 的键卸载)。
      expect(screen.getByRole('button', { name: '数据库 db5' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTitle('user:1')).toBeNull()
    } finally {
      restore()
    }
    cleanup()
    const invokePlain = installTauri({ selectError: 'sel-plain' })
    const restorePlain = stubInvoke(invokePlain)
    try {
      renderWorkbench(asset, onClose)
      await waitConnected()
      clickDb(7)
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-plain/)).toBeTruthy() })
    } finally {
      restorePlain()
    }
  })

  it('shows the empty state when the expanded DB has no keys', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('surfaces a key-list error with a working retry (Error and plain-string)', async () => {
    const invoke = installTauri({ scanError: new Error('scan-fail') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/加载失败:scan-fail/)).toBeTruthy() })
      const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.click(screen.getByText('重试'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(before) })
    } finally {
      restore()
    }
    cleanup()
    // 裸字符串 reject(非 Error)→ 走 `String(e)` 兜底,文本一致。
    const invokeRaw = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.reject('plain scan boom')
      return Promise.resolve(null)
    })
    const restoreRaw = stubInvoke(invokeRaw)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/加载失败:plain scan boom/)).toBeTruthy() })
    } finally {
      restoreRaw()
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

describe('RedisWorkbench lazy DB tree interactions', () => {
  it('groups keys into a folder tree by ":" and expands folders on click', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // 默认全收起:两个文件夹行都在,叶子都被折叠隐藏。
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      expect(screen.getByLabelText('文件夹 sess')).toBeTruthy()
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTitle('user:1')).toBeNull()
      expect(screen.queryByTitle('sess:2')).toBeNull()
      // 点击 user 文件夹 → 其叶子出现;sess 分支不受影响、仍收起。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.queryByTitle('sess:2')).toBeNull()
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true')
      expect((screen.getByLabelText('文件夹 sess')).getAttribute('aria-expanded')).toBe('false')
      // 再点 → user 收起,叶子隐藏。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.queryByTitle('user:1')).toBeNull() })
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      // 再点展开 → 叶子恢复(展开集持久)。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('re-applies the search on re-expand (cache mismatch) and on refresh', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 收起后再设搜索,重展开:缓存匹配串不一致 → 按新搜索重新取。
      clickDb(0)
      await waitFor(() =>{  expect(screen.queryByTitle('user:1')).toBeNull() })
      fireEvent.change(screen.getByLabelText('搜索 key'), { target: { value: 'user:*' } })
      clickDb(0)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1', matchPattern: 'user:*' })) })
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 搜索态强制文件夹全展开。
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true')
      // 刷新按钮按当前搜索重扫。
      const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.click(screen.getByLabelText('刷新'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(before) })
    } finally {
      restore()
    }
  })

  it('shows a loading hint and disables refresh while the SCAN is in flight', async () => {
    let releaseScan!: (v: unknown) => void
    const scanGate = new Promise<unknown>(res => { releaseScan = res })
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return scanGate
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // SCAN 挂起:加载中提示可见,刷新钮禁用。
      await waitFor(() =>{  expect(screen.getByText('加载键…')).toBeTruthy() })
      expect((screen.getByLabelText('刷新') as HTMLButtonElement).disabled).toBe(true)
      releaseScan({ keys: [keyInfo('user:1')], cursor: 0, total: 1 })
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect((screen.getByLabelText('刷新') as HTMLButtonElement).disabled).toBe(false)
    } finally {
      restore()
    }
  })

  it('shows a loading hint while the SELECT (client switch) is in flight', async () => {
    let releaseSelect!: (v: unknown) => void
    const selectGate = new Promise<unknown>(res => { releaseSelect = res })
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_select') return selectGate
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(3)
      // SELECT 挂起:目标 db 尚无缓存记录,同样显示加载中。
      await waitFor(() =>{  expect(screen.getByText('加载键…')).toBeTruthy() })
      releaseSelect(null)
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db3')
    } finally {
      restore()
    }
  })
})

describe('RedisWorkbench actions', () => {
  it('opens a key into the value editor and shows the placeholder otherwise', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      expect(screen.getByText('选择一个 key 查看 / 编辑')).toBeTruthy()
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
      await expandDb0WithKeys()
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
      await expandDb0WithKeys()
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:del-boom/)).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('renames a key, closes on cancel/empty/same-name, and surfaces a rename failure toast', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      // 空名确认 → 关闭 renameBar,不调用
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: '' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_rename', expect.anything())
      // 同名确认 → 关闭,不调用
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
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
      await expandDb0WithKeys()
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
      await expandDb0WithKeys()
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
    // 收起态清空:目标 = activeDb,只刷新总数不取键。
    const confirmSpy2 = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invokeCollapsed = installTauri()
    const restoreCollapsed = stubInvoke(invokeCollapsed)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(invokeCollapsed).toHaveBeenCalledWith('db_redis_flush_db', { connId: 'c1' }) })
      await waitFor(() =>{  expect(screen.getByText(/db0 已清空/)).toBeTruthy() })
      await waitFor(() =>{  expect(invokeCollapsed).toHaveBeenCalledWith('db_redis_db_size', { connId: 'c1' }) })
      expect(invokeCollapsed.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(0)
    } finally {
      restoreCollapsed()
      confirmSpy2.mockRestore()
    }
    cleanup()
    // flush 失败 toast
    const confirmSpy3 = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invokeErr = installTauri({ flushError: new Error('fl-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:fl-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
      confirmSpy3.mockRestore()
    }
  })

  it('creates a new key through the modal, cancels, and guards empty names', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
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
      await expandDb0WithKeys()
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
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:create-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('runs a CLI command on Enter and via the execute button, refreshing the expanded DB', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // 空命令 Enter → 早退
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
      // 命令可能改键:展开态下命令后刷新该 db 的键(基线取在执行前)。
      const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(input, { target: { value: 'GET foo' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'GET foo' }) })
      await waitFor(() =>{  expect(screen.getByText('OK')).toBeTruthy() })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(before) })
    } finally {
      restore()
    }
  })

  it('dumps a non-object command result via String() and refreshes only the size when collapsed', async () => {
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
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'PING' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('123')).toBeTruthy() })
      // 未展开任何 db:命令后只刷当前库总数,不取键(保持懒加载)。
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_db_size', { connId: 'c1' }) })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(0)
    } finally {
      restore()
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
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'HGETALL k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText(/"ok": 1/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('shows an execute error field, handles a null result, and surfaces a runCli rejection', async () => {
    // execute 返回 error 字段 → 直接展示。
    const invokeErr = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: null, durationMs: 1, error: 'internal-err' })
      return Promise.resolve(null)
    })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('internal-err')).toBeTruthy() })
    } finally {
      restoreErr()
    }
    cleanup()
    // null 结果 → `?? ''` 回退,输出空串(不渲染 pre);非 Enter 键不触发。
    const invokeNull = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: undefined, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restoreNull = stubInvoke(invokeNull)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input2 = screen.getByLabelText('命令输入')
      fireEvent.keyDown(input2, { key: 'a' })
      expect(invokeNull).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
      fireEvent.change(input2, { target: { value: 'PING' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(invokeNull).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'PING' }) })
      expect(screen.queryByText('undefined')).toBeNull()
    } finally {
      restoreNull()
    }
    cleanup()
    // execute 拒绝 → 输出错误串
    const invokeRej = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.reject(new Error('plain-exec'))
      return Promise.resolve(null)
    })
    const restoreRej = stubInvoke(invokeRej)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input3 = screen.getByLabelText('命令输入')
      fireEvent.change(input3, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('plain-exec')).toBeTruthy() })
    } finally {
      restoreRej()
    }
  })

  it('closes via the header close button and calls onClose', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    const onClose = vi.fn()
    try {
      renderWorkbench(asset, onClose)
      await expandDb0WithKeys()
      fireEvent.click(screen.getByText('关闭'))
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('RedisWorkbench failure variants', () => {
  it('surfaces a db-size failure during the expand refresh', async () => {
    const invoke = installTauri({ sizeError: new Error('size-err') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/获取键数失败:size-err/)).toBeTruthy() })
      // 键列表不受 db_size 失败影响,照常展示(点开文件夹)。
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('surfaces raw-string rejections (non-Error) as toast/error text', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const raw = (msg: string) => Promise.reject(msg)
    const invoke = vi.fn((cmd: string) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_scan': return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
        case 'db_redis_db_size': return raw('raw-size')
        case 'db_redis_select': return raw('raw-sel')
        case 'db_redis_del': return raw('raw-del')
        case 'db_redis_rename': return raw('raw-ren')
        case 'db_redis_flush_db': return raw('raw-fl')
        case 'db_redis_execute': return raw('raw-exec')
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      // 展开 db0:db_size 裸串拒绝 → toast;scan 成功 → 点开文件夹后键行出现。
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/获取键数失败:raw-size/)).toBeTruthy() })
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // delete / rename / flush 裸串拒绝。
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:raw-del/)).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.getByText(/重命名失败:raw-ren/)).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:raw-fl/)).toBeTruthy() })
      // CLI execute 裸串拒绝 → 输出串。
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('raw-exec')).toBeTruthy() })
      // create execute 裸串拒绝 → toast。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:raw-exec/)).toBeTruthy() })
      // select 裸串拒绝(放最后:切换失败会收起展开态)。
      clickDb(4)
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:raw-sel/)).toBeTruthy() })
      expect(screen.getByRole('button', { name: '数据库 db4' }).getAttribute('aria-expanded')).toBe('false')
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('keeps the newer expand when a stale SELECT fails (race guard)', async () => {
    let rejectSelect!: (e: unknown) => void
    const selectGate = new Promise<never>((_, reject) => { rejectSelect = reject })
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_select') return selectGate
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(3)
      await waitFor(() =>{  expect(screen.getByText('加载键…')).toBeTruthy() })
      // select(3) 挂起时用户改点已是当前库的 db0(无需 select,直接加载)。
      clickDb(0)
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 迟到的 select 失败:回退守卫看到当前展开已是 db0,不覆盖它。
      rejectSelect('sel-race')
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-race/)).toBeTruthy() })
      expect(screen.getByRole('button', { name: '数据库 db3' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByTitle('user:1')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('surfaces failure text for delete/rename/flush/create', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 1 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
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
      await expandDb0WithKeys()
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

  it('keeps the value editor open when deleting a different key', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 打开 user:1 的值编辑器
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.anything()) })
      // sess:2 在默认收起的 sess 文件夹下,先点开它。
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      // 删除不同的 key(sess:2)→ openValue(user:1) 保留下 (cur?.key !== key → cur)
      fireEvent.click(screen.getByLabelText('删除 sess:2'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['sess:2'] }) })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.objectContaining({ key: 'user:1' })) })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('cancels an in-progress rename via the cancel button', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
    } finally {
      restore()
    }
  })
})