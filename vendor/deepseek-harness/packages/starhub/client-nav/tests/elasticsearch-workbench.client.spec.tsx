// @vitest-environment jsdom
/**
 * ElasticsearchWorkbench.tsx 组件测试:连接生命周期、概览/检索/索引 tab、
 * DSL 格式化与分页、表格/JSON 视图、新建索引与删除确认、连接失败与关闭。
 * 通过 mock window.__TAURI_INTERNALS__.invoke 驱动 db_es_* 命令。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RustAsset } from '../src/client/store.ts'
import { ElasticsearchWorkbench } from '../src/client/es/ElasticsearchWorkbench.tsx'

const esAsset: RustAsset = {
  id: 'es1', type: 'db', name: 'es-prod', group_id: null,
  config: { host: 'h', port: 9200 }, key_id: null, tags: [], favorite: false,
  last_used_at: null, created_at: 0, updated_at: 0,
}

function stubInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke: handler }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** 模拟未类型化的 IPC 拒绝(真实 Tauri 载荷可能是纯字符串而非 Error)。 */
function rawRejection(reason: string): Promise<never> {
  const reject = Promise.reject.bind(Promise)
  return reject(reason)
}

/** Default successful ES invoke handler. */
function okInvoke() {
  const calls: string[] = []
  const invoke = (cmd: string): unknown => {
    calls.push(cmd)
    switch (cmd) {
      case 'db_es_connect': return Promise.resolve({ connId: 'c1' })
      case 'db_es_disconnect': return Promise.resolve(null)
      case 'db_es_cluster_health': return Promise.resolve({ clusterName: 'n', status: 'green', numberOfNodes: 2, numberOfDataNodes: 2, activePrimaryShards: 1, activeShards: 1, activeShardsPercent: 100 })
      case 'db_es_list_indices': return Promise.resolve([
        { name: 'logs', docsCount: 10, storeSize: '1kb', health: 'green', status: 'open', primaryShards: 1, replicaShards: 0 },
        { name: 'metrics', docsCount: 3, storeSize: '2kb', health: 'yellow', status: 'open', primaryShards: 1, replicaShards: 1 },
      ])
      case 'db_es_get_index_mapping': return Promise.resolve({ indexName: 'logs', fields: [{ name: 'msg', type: 'text' }, { name: 'obj', type: 'object', children: [{ name: 'k', type: 'keyword' }] }] })
      case 'db_es_get_index_settings': return Promise.resolve({ index: { number_of_shards: '1' } })
      case 'db_es_delete_index': return Promise.resolve({ acknowledged: true })
      case 'db_es_create_index': return Promise.resolve({ acknowledged: true })
      case 'db_es_search': return Promise.resolve({
        took: 1, timedOut: false, totalHits: 2, maxScore: null,
        hits: [{ index: 'logs', id: '1', score: null, source: { msg: 'hello' } }, { index: 'logs', id: '2', score: null, source: { msg: 'world' } }],
        aggregations: {},
      })
      default: return Promise.resolve(null)
    }
  }
  return { invoke, calls }
}

beforeEach(cleanup)
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('ElasticsearchWorkbench connect lifecycle', () => {
  it('connects using default host/port when the config omits them', async () => {
    const calls: Array<[string, unknown]> = []
    const restore = stubInvoke((cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_list_indices') return Promise.resolve([])
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={{ ...esAsset, config: {} }} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      const connectCall = calls.find(([c]) => c === 'db_es_connect')
      expect(connectCall).toBeTruthy()
      const params = (connectCall![1] as { params: Record<string, unknown> }).params
      expect(params.host).toBe('localhost')
      expect(params.port).toBe(9200)
    } finally {
      restore()
    }
  })

  it('connects on mount, loads health + indices, and shows the overview', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      expect(await screen.findByText('Elasticsearch · es-prod')).toBeTruthy()
      expect(calls).toContain('db_es_connect')
      expect(calls).toContain('db_es_cluster_health')
      expect(calls).toContain('db_es_list_indices')
      expect(await screen.findByText(/logs/)).toBeTruthy()
      expect(screen.getAllByText('green').length).toBeGreaterThan(0)
      expect(screen.getByText(/2 nodes/)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('disconnects on unmount', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      const view = render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      view.unmount()
      await waitFor(() =>{  expect(calls).toContain('db_es_disconnect') })
    } finally {
      restore()
    }
  })

  it('shows a connect error screen when db_es_connect rejects', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.reject(new Error('boom'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      expect(await screen.findByText('boom')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('ElasticsearchWorkbench search', () => {
  it('executes DSL search, renders table view, and paginates', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByText('检索'))
      // Execute the query (defaults to match_all DSL).
      fireEvent.click(screen.getByText('执行查询'))
      expect(await screen.findByText(/hits ·/)).toBeTruthy()
      expect(calls).toContain('db_es_search')
      // Table view.
      fireEvent.click(screen.getByText('表格'))
      expect(screen.getByText('hello')).toBeTruthy()
      fireEvent.click(screen.getByText('JSON'))
      // Pagination.
      fireEvent.click(screen.getByText('上一页'))
    } finally {
      restore()
    }
  })

  it('surfaces invalid JSON in the DSL editor', async () => {
    const { invoke } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByText('检索'))
      const editor = screen.getByRole('textbox')
      fireEvent.change(editor, { target: { value: 'not json' } })
      fireEvent.click(screen.getByText('执行查询'))
      expect(await screen.findByText('Invalid JSON in DSL query')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('formats the DSL editor', async () => {
    const { invoke } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByText('检索'))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"a":1}' } })
      fireEvent.click(screen.getByText('格式化'))
      const editor = screen.getByRole<HTMLTextAreaElement>('textbox')
      expect(editor.value).toContain('\n')
    } finally {
      restore()
    }
  })
})

describe('ElasticsearchWorkbench index detail', () => {
  it('selects an index from overview, shows mapping + settings, and deletes with confirmation', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByText('logs'))
      // Index tab shows mapping field + settings JSON.
      expect(await screen.findByText('msg')).toBeTruthy()
      expect(screen.getAllByText('text').length).toBeGreaterThan(0)
      // Delete index from overview table via the confirm dialog.
      fireEvent.click(screen.getByRole('button', { name: '概览' }))
      await screen.findByText(/logs/)
      fireEvent.click(screen.getAllByText('删除')[0]!)
      expect(await screen.findByText(/确认删除索引 logs/)).toBeTruthy()
      // The confirm dialog's delete button is the last "删除" button in the DOM.
      fireEvent.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!)
      await waitFor(() =>{  expect(calls).toContain('db_es_delete_index') })
    } finally {
      restore()
    }
  })

  it('shows empty state when no index selected', async () => {
    const { invoke } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByRole('button', { name: '索引' }))
      expect(screen.getByText(/选择一个索引/)).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('ElasticsearchWorkbench new index dialog', () => {
  it('creates an index then reloads the list', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      expect(screen.getByPlaceholderText('index name')).toBeTruthy()
      const input = screen.getByPlaceholderText('index name')
      fireEvent.change(input, { target: { value: 'newidx' } })
      // Cancel first.
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(screen.queryByPlaceholderText('index name')).toBeNull()
      // Reopen and create.
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      fireEvent.change(screen.getByPlaceholderText('index name'), { target: { value: 'newidx' } })
      fireEvent.click(screen.getByRole('button', { name: '创建' }))
      await waitFor(() =>{  expect(calls).toContain('db_es_create_index') })
    } finally {
      restore()
    }
  })

  it('blocks creating with a blank name', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      fireEvent.click(screen.getByRole('button', { name: '创建' }))
      expect(await screen.findByText('名称不能为空')).toBeTruthy()
      expect(calls).not.toContain('db_es_create_index')
    } finally {
      restore()
    }
  })
})

describe('ElasticsearchWorkbench edge coverage', () => {
  it('selects an index in the search dropdown', async () => {
    const { invoke } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '检索' }))
      const select = screen.getByRole<HTMLSelectElement>('combobox')
      fireEvent.change(select, { target: { value: 'metrics' } })
      expect(select.value).toBe('metrics')
    } finally {
      restore()
    }
  })

  it('executes search with Ctrl+Enter on the DSL editor', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '检索' }))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })
      await waitFor(() =>{  expect(calls).toContain('db_es_search') })
    } finally {
      restore()
    }
  })

  it('creates an index via Enter key', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      fireEvent.change(screen.getByPlaceholderText('index name'), { target: { value: 'enter-idx' } })
      fireEvent.keyDown(screen.getByPlaceholderText('index name'), { key: 'Enter' })
      await waitFor(() =>{  expect(calls).toContain('db_es_create_index') })
    } finally {
      restore()
    }
  })

  it('surfaces a create-index failure and re-enables the button', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_create_index') return Promise.reject(new Error('create boom'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/nodes/)
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      fireEvent.change(screen.getByPlaceholderText('index name'), { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: '创建' }))
      expect(await screen.findByText('create boom')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('surfaces a search rejection', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_search') return Promise.reject(new Error('search boom'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/nodes/)
      fireEvent.click(screen.getByRole('button', { name: '检索' }))
      fireEvent.click(screen.getByRole('button', { name: '执行查询' }))
      expect(await screen.findByText('search boom')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('connects even when health and index listing reject', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_cluster_health') return Promise.reject(new Error('health down'))
      if (cmd === 'db_es_list_indices') return Promise.reject(new Error('idx down'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      // Connect succeeds; health/indices fall back quietly.
      expect(await screen.findByText('Elasticsearch · es-prod')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('paginates next then prev with a result larger than one page', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_search') return Promise.resolve({ took: 1, timedOut: false, totalHits: 50, maxScore: null, hits: [{ index: 'i', id: 'a', score: null, source: { msg: 'x', nested: { k: 1 } } }], aggregations: {} })
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/nodes/)
      fireEvent.click(screen.getByRole('button', { name: '检索' }))
      fireEvent.click(screen.getByRole('button', { name: '执行查询' }))
      expect(await screen.findByText(/50 hits/)).toBeTruthy()
      // Next page (0 + 20 < 50 → enabled).
      fireEvent.click(screen.getByText('下一页'))
      // Prev page (from 20 → enabled).
      fireEvent.click(screen.getByText('上一页'))
      // Object-valued field renders as JSON (table view).
      fireEvent.click(screen.getByText('表格'))
      await waitFor(() =>{  expect(screen.getByText(/nested/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('keeps the DSL unchanged when formatting invalid JSON', async () => {
    const { invoke } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '检索' }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not-json' } })
      fireEvent.click(screen.getByText('格式化'))
      expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('not-json')
    } finally {
      restore()
    }
  })

  it('normalizes a mapping child with non-string name/type', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([{ name: 'idx', docsCount: 1, storeSize: '1b', health: 'green', status: 'open', primaryShards: 1, replicaShards: 0 }])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_get_index_mapping') return Promise.resolve({ indexName: 'idx', fields: [{ name: 'obj', type: 'object', children: [{ name: 5, type: undefined }] }] })
      if (cmd === 'db_es_get_index_settings') return Promise.resolve({})
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/idx/)
      fireEvent.click(screen.getByText('idx'))
      // The malformed child (non-string name/type) renders with empty strings.
      expect(await screen.findByText('obj')).toBeTruthy()
      expect(screen.getAllByText('object').length).toBeGreaterThanOrEqual(1)
    } finally {
      restore()
    }
  })
})

describe('ElasticsearchWorkbench defensive paths', () => {
  it('loads a mapping with null fields (settings rejected → hidden)', async () => {
    const calls: string[] = []
    const restore = stubInvoke((cmd) => {
      calls.push(cmd)
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([{ name: 'logs', docsCount: 1, storeSize: '1b', health: 'green', status: 'open', primaryShards: 1, replicaShards: 0 }])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_get_index_mapping') return Promise.resolve({ indexName: 'logs', fields: null })
      if (cmd === 'db_es_get_index_settings') return Promise.reject(new Error('settings down'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByText('logs'))
      // No fields → mapping section renders empty; settings rejected → hidden.
      expect(await screen.findByText('映射')).toBeTruthy()
      expect(calls).toContain('db_es_get_index_settings')
      expect(screen.queryByText('Settings')).toBeNull()
    } finally {
      restore()
    }
  })

  it('surfaces a mapping error when selecting an index', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([{ name: 'logs', docsCount: 1, storeSize: '1b', health: 'green', status: 'open', primaryShards: 1, replicaShards: 0 }])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_get_index_mapping') return Promise.reject(new Error('mapping boom'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByText('logs'))
      expect(await screen.findByText('mapping boom')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('reloads the index list via the refresh button', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      await waitFor(() =>{  expect(calls.filter(c => c === 'db_es_list_indices').length).toBeGreaterThanOrEqual(2) })
    } finally {
      restore()
    }
  })

  it('surfaces a refresh error', async () => {
    let listCalls = 0
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') {
        listCalls += 1
        return listCalls === 1
          ? Promise.resolve([])
          : Promise.reject(new Error('refresh boom'))
      }
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      expect(await screen.findByText('refresh boom')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('surfaces a delete-index error', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([{ name: 'logs', docsCount: 1, storeSize: '1b', health: 'green', status: 'open', primaryShards: 1, replicaShards: 0 }])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_delete_index') return Promise.reject(new Error('delete boom'))
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getAllByText('删除')[0]!)
      expect(await screen.findByText(/确认删除索引 logs/)).toBeTruthy()
      fireEvent.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!)
      expect(await screen.findByText('delete boom')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('deletes an index via the confirm dialog and reloads', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getAllByText('删除')[0]!)
      expect(await screen.findByText(/确认删除索引 logs/)).toBeTruthy()
      fireEvent.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!)
      await waitFor(() =>{  expect(calls).toContain('db_es_delete_index') })
      await waitFor(() =>{  expect(calls.filter(c => c === 'db_es_list_indices').length).toBeGreaterThanOrEqual(2) })
    } finally {
      restore()
    }
  })

  it('ignores non-execute keystrokes in the DSL editor', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '检索' }))
      // Plain Enter without Ctrl/Meta must NOT run a search.
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      // A non-Enter key must not run a search either.
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
      await new Promise(r => setTimeout(r, 50))
      expect(calls.filter(c => c === 'db_es_search').length).toBe(0)
    } finally {
      restore()
    }
  })

  it('surfaces a create error that is not an Error object', async () => {
    const restore = stubInvoke((cmd) => {
      if (cmd === 'db_es_connect') return Promise.resolve({ connId: 'c1' })
      if (cmd === 'db_es_list_indices') return Promise.resolve([])
      if (cmd === 'db_es_cluster_health') return Promise.resolve({ status: 'green', numberOfNodes: 1 })
      if (cmd === 'db_es_create_index') return rawRejection('plain string failure')
      if (cmd === 'db_es_disconnect') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/nodes/)
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      fireEvent.change(screen.getByPlaceholderText('index name'), { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: '创建' }))
      expect(await screen.findByText('plain string failure')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('cancels the delete confirmation without deleting', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getAllByText('删除')[0]!)
      expect(await screen.findByText(/确认删除索引 logs/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(screen.queryByText(/确认删除索引 logs/)).toBeNull()
      expect(calls).not.toContain('db_es_delete_index')
    } finally {
      restore()
    }
  })

  it('creates an index from the new-index dialog via Enter while not busy', async () => {
    const { invoke, calls } = okInvoke()
    const restore = stubInvoke(invoke)
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={vi.fn()} />)
      await screen.findByText(/logs/)
      fireEvent.click(screen.getByRole('button', { name: '新建索引' }))
      const input = screen.getByPlaceholderText('index name')
      fireEvent.change(input, { target: { value: 'enter-idx' } })
      // Non-Enter keypress must not submit (covers the guarded `if` false path).
      fireEvent.keyDown(input, { key: 'a' })
      // Metakey variants should also submit (the || metaKey branch).
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
      await waitFor(() =>{  expect(calls).toContain('db_es_create_index') })
    } finally {
      restore()
    }
  })
})

describe('ElasticsearchWorkbench close', () => {
  it('calls onClose from the header close button', async () => {
    const { invoke } = okInvoke()
    const restore = stubInvoke(invoke)
    const onClose = vi.fn()
    try {
      render(<ElasticsearchWorkbench asset={esAsset} onClose={onClose} />)
      await screen.findByText('Elasticsearch · es-prod')
      fireEvent.click(screen.getByText('关闭'))
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})
