// @vitest-environment jsdom
/**
 * Broker 壳内工作台(BrokerView)+ 仪表盘卡片(DashboardCard)+ broker service。
 * Pins the Vue→React 迁移的验收口径:壳内直渲、kafka/nsq 两种列定义、
 * 30s 自动刷新与卸载清理、错误/预览降级、卡片详情模态(明细/图表/明细表)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrokerView } from '../src/client/broker/BrokerView.tsx'
import {
  DashboardCard, dashboardLinePoints, dashboardNumericValue,
  type DashboardDetailTable,
} from '../src/client/broker/DashboardCard.tsx'
import { loadBrokerOverview, testBroker, type BrokerOverview } from '../src/client/broker/service.ts'
import type { RustAsset } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

/** jsdom 全局下的 Tauri IPC stub 挂载/卸载。 */
function stubTauriInternals(invoke: (cmd: string, args?: unknown) => Promise<unknown>): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke }
  return () => {
    if (prev === undefined) {
      delete w.__TAURI_INTERNALS__
    } else {
      w.__TAURI_INTERNALS__ = prev
    }
  }
}

/** 模拟未类型化的 IPC 拒绝(真实 Tauri 载荷可能是纯字符串而非 Error)。 */
function rawRejection(reason: string): Promise<never> {
  const reject = Promise.reject.bind(Promise)
  return reject(reason)
}

function brokerAsset(overrides: Partial<RustAsset['config']> = {}, dbType = 'kafka'): RustAsset {
  return {
    id: 'b1', type: 'db', name: 'prod-kafka', group_id: null,
    config: { dbType, host: '10.0.0.8', port: 9092, ...overrides },
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }
}

const kafkaOverview: BrokerOverview = {
  kind: 'kafka', status: 'online', endpoint: '10.0.0.8:9092', nodeCount: 3,
  resources: [
    { name: 'orders', partitions: 6, leader: '2' },
    { name: 'events', partitions: 2, leader: '1' },
  ],
  observedAt: 0,
}

const nsqOverview: BrokerOverview = {
  kind: 'nsq', status: 'online', endpoint: '10.0.0.9:4150', nodeCount: 2,
  resources: [
    { name: 'jobs', channels: 3, depth: 42, messages: 1000 },
  ],
  observedAt: 0,
}

describe('broker service', () => {
  it('loadBrokerOverview forwards kind and params to broker_overview', async () => {
    const restore = stubTauriInternals((cmd, args) => {
      expect(cmd).toBe('broker_overview')
      expect(args).toEqual({ kind: 'kafka', params: { host: 'h', port: 9092 } })
      return Promise.resolve(kafkaOverview)
    })
    try {
      await expect(loadBrokerOverview('kafka', { host: 'h', port: 9092 })).resolves.toBe(kafkaOverview)
    } finally {
      restore()
    }
  })

  it('testBroker forwards kind and params to broker_test', async () => {
    const restore = stubTauriInternals((cmd, args) => {
      expect(cmd).toBe('broker_test')
      expect(args).toEqual({ kind: 'nsq', params: { host: 'h', port: 4150 } })
      return Promise.resolve({ ok: true, message: 'ok' })
    })
    try {
      await expect(testBroker('nsq', { host: 'h', port: 4150 })).resolves.toEqual({ ok: true, message: 'ok' })
    } finally {
      restore()
    }
  })
})

describe('BrokerView', () => {
  it('renders the kafka dashboard with kafka columns and no 累计消息 card', async () => {
    const restore = stubTauriInternals(() => Promise.resolve(kafkaOverview))
    try {
      render(<BrokerView asset={brokerAsset()} />)
      expect(screen.getByText('KAFKA')).toBeTruthy()
      expect(screen.getByText('prod-kafka')).toBeTruthy()
      expect(await screen.findByText('在线')).toBeTruthy()
      expect(screen.getByText('3')).toBeTruthy() // Broker 节点
      expect(screen.getByText('2')).toBeTruthy() // Topic 数量
      expect(screen.getByText('8')).toBeTruthy() // 分区总数
      expect(screen.queryByText('累计消息')).toBeNull()
      expect(screen.queryByText('当前积压')).toBeNull()
    } finally {
      restore()
    }
  })

  it('renders the nsq dashboard with nsq columns and the 累计消息 card (default port 4150)', async () => {
    const restore = stubTauriInternals(() => Promise.resolve(nsqOverview))
    try {
      render(<BrokerView asset={brokerAsset({ dbType: 'nsq', port: undefined }, 'nsq')} />)
      expect(screen.getByText('NSQ')).toBeTruthy()
      expect(await screen.findByText('当前积压')).toBeTruthy()
      expect(screen.getByText('42')).toBeTruthy() // 当前积压
      expect(screen.getByText('累计消息')).toBeTruthy()
      expect(screen.getByText('1,000')).toBeTruthy() // toLocaleString
    } finally {
      restore()
    }
  })

  it('shows the offline state when the overview reports offline', async () => {
    const restore = stubTauriInternals(() => Promise.resolve({ ...kafkaOverview, status: 'offline' }))
    try {
      render(<BrokerView asset={brokerAsset()} />)
      expect(await screen.findByText('离线')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('surfaces fetch failures in the error panel and marks the status card 异常', async () => {
    const restore = stubTauriInternals(() => Promise.reject(new Error('connection refused')))
    try {
      render(<BrokerView asset={brokerAsset()} />)
      expect(await screen.findByText('connection refused')).toBeTruthy()
      expect(screen.getByText('异常')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('stringifies non-Error rejections in the error panel', async () => {
    const restore = stubTauriInternals(() => rawRejection('raw failure'))
    try {
      render(<BrokerView asset={brokerAsset()} />)
      expect(await screen.findByText('raw failure')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows the browser-preview rejection message when Tauri internals are absent', async () => {
    render(<BrokerView asset={brokerAsset()} />)
    expect(await screen.findByText(/Tauri IPC unavailable/)).toBeTruthy()
  })

  it('does not invoke when the asset has no host', () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(kafkaOverview))
    const restore = stubTauriInternals(invoke)
    try {
      render(<BrokerView asset={brokerAsset({ host: undefined })} />)
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('refreshes on the refresh button and falls back to the default port when unset', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(kafkaOverview))
    const restore = stubTauriInternals(invoke)
    try {
      render(<BrokerView asset={brokerAsset({ port: undefined })} />)
      await act(async () => { await Promise.resolve() })
      expect(invoke).toHaveBeenCalledTimes(1)
      const args = invoke.mock.calls[0]![1]! as { params: { port: number } }
      expect(args.params.port).toBe(9092)
      fireEvent.click(screen.getByTitle('刷新状态'))
      await act(async () => { await Promise.resolve() })
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      restore()
    }
  })

  it('passes username/password/ssl through when present', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(kafkaOverview))
    const restore = stubTauriInternals(invoke)
    try {
      render(<BrokerView asset={brokerAsset({ username: 'u', password: 'p', ssl: true })} />)
      await act(async () => { await Promise.resolve() })
      const params = (invoke.mock.calls[0]![1]! as { params: Record<string, unknown> }).params
      expect(params.username).toBe('u')
      expect(params.password).toBe('p')
      expect(params.ssl).toBe(true)
    } finally {
      restore()
    }
  })

  it('auto-refreshes every 30 seconds and stops refreshing after unmount', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(kafkaOverview))
    const restore = stubTauriInternals(invoke)
    try {
      const view = render(<BrokerView asset={brokerAsset()} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(invoke).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
      expect(invoke).toHaveBeenCalledTimes(2)
      view.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      restore()
    }
  })

  it('opens the topic detail dialog from a card and closes it', async () => {
    const restore = stubTauriInternals(() => Promise.resolve(kafkaOverview))
    try {
      render(<BrokerView asset={brokerAsset()} />)
      await screen.findByText('在线')
      fireEvent.click(screen.getByTitle(/^Topic 数量: /))
      expect(screen.getByRole('dialog', { name: 'Topic 数量 实时指标详情' })).toBeTruthy()
      // 明细表:kafka 列头 Topic/分区/Leader + 行数据
      expect(screen.getByText('orders')).toBeTruthy()
      expect(screen.getByText('Topic')).toBeTruthy()
      fireEvent.click(screen.getByLabelText('关闭'))
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      restore()
    }
  })
})

describe('DashboardCard', () => {
  it('renders title, value and icon; sampling a numeric value shows a line chart caption', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value={1234} />)
    expect(screen.getByText('指标')).toBeTruthy()
    expect(screen.getByText('1234')).toBeTruthy()
    expect(screen.getByText('i')).toBeTruthy()
    fireEvent.click(screen.getByTitle('指标: 1234(点击查看详情)'))
    expect(screen.getByText(/个真实采样点/)).toBeTruthy()
  })

  it('skips non-numeric values (no sampling; a forced line chart waits for samples)', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value="--" chartType="line" />)
    fireEvent.click(screen.getByTitle('指标: --(点击查看详情)'))
    expect(screen.getByText('等待采集')).toBeTruthy()
  })

  it('parses comma-grouped strings and honors the chartValue override', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value="1,234" chartValue={5} />)
    fireEvent.click(screen.getByTitle('指标: 1,234(点击查看详情)'))
    expect(screen.queryByText(/5 个真实采样点/)).toBeNull()
    expect(screen.getByText(/1 个真实采样点/)).toBeTruthy()
    expect(dashboardNumericValue('1,234')).toBe(1234)
    expect(dashboardNumericValue('n/a', 3)).toBe(3)
    expect(dashboardNumericValue('n/a')).toBeNull()
    // 非有限数值(数字型 NaN / 超长数字串解析为 Infinity)→ null,不采样
    expect(dashboardNumericValue(NaN)).toBeNull()
    expect(dashboardNumericValue(Infinity)).toBeNull()
    expect(dashboardNumericValue('9'.repeat(400))).toBeNull()
  })

  it('renders loading dots and disables the card while loading', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value={1} loading />)
    expect(screen.getByTitle('指标: 1(点击查看详情)').getAttribute('disabled')).not.toBeNull()
    expect(screen.queryByText('1')).toBeNull()
  })

  it('renders the progress bar and donut chart in auto mode with progress', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value={50} progress={25} />)
    fireEvent.click(screen.getByTitle('指标: 50(点击查看详情)'))
    expect(screen.getByText('占比构成')).toBeTruthy()
    expect(screen.getByText(/25\.0% 已使用/)).toBeTruthy()
    expect(screen.getByText(/可用 75\.0%/)).toBeTruthy()
    // donut 标签 + 卡片进度条文本都是 25.0%,至少一处
    expect(screen.getAllByText('25.0%').length).toBeGreaterThanOrEqual(1)
    // 明细行:当前值 + 占比
    expect(screen.getByText('占比')).toBeTruthy()
  })

  it('clamps the progress width into 0..100', () => {
    const { rerender } = render(<DashboardCard title="指标" icon={<span>i</span>} value={1} progress={120} />)
    expect(screen.getByText('100.0%')).toBeTruthy()
    rerender(<DashboardCard title="指标" icon={<span>i</span>} value={1} progress={-5} />)
    expect(screen.getByText('0.0%')).toBeTruthy()
  })

  it('renders a forced line chart with chartData and min/max range', () => {
    render(
      <DashboardCard
        title="指标" icon={<span>i</span>} value={1}
        chartType="line"
        chartData={[{ label: 'a', value: 1 }, { label: 'b', value: 2 }]}
      />,
    )
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.getByText('实时趋势')).toBeTruthy()
    expect(screen.getByText('MIN 1')).toBeTruthy()
    expect(screen.getByText('MAX 2')).toBeTruthy()
    expect(dashboardLinePoints([{ label: 'a', value: 5 }], 5, 5)).toMatch(/^160\.0,/)
  })

  it('renders a forced donut chart without progress', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value={1} chartType="donut" />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.getByText('占比构成')).toBeTruthy()
    expect(screen.getByText('0.0% 已使用 · 100.0% 可用')).toBeTruthy()
  })

  it('hides the chart entirely with chartType none', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value={1} chartType="none" />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.queryByText('实时趋势')).toBeNull()
    expect(screen.queryByText('占比构成')).toBeNull()
  })

  it('shows no chart in auto mode without progress or samples', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value="--" />)
    fireEvent.click(screen.getByTitle('指标: --(点击查看详情)'))
    expect(screen.queryByText('实时趋势')).toBeNull()
    expect(screen.queryByText('占比构成')).toBeNull()
  })

  it('renders trend marks for up/down/stable', () => {
    const { rerender } = render(<DashboardCard title="指标" icon={<span>i</span>} value={1} trend="up" />)
    expect(screen.getByText('↑')).toBeTruthy()
    rerender(<DashboardCard title="指标" icon={<span>i</span>} value={1} trend="down" />)
    expect(screen.getByText('↓')).toBeTruthy()
    rerender(<DashboardCard title="指标" icon={<span>i</span>} value={1} trend="stable" />)
    expect(screen.getByText('→')).toBeTruthy()
  })

  it('renders subtitle, description override, and detail rows', () => {
    render(
      <DashboardCard
        title="指标" icon={<span>i</span>} value={9}
        subtitle="sub" description="自定义说明"
        details={[{ label: 'Endpoint', value: 'h:1' }]}
      />,
    )
    expect(screen.getByText('sub')).toBeTruthy()
    fireEvent.click(screen.getByTitle('指标: 9(点击查看详情)'))
    expect(screen.getByText('自定义说明')).toBeTruthy()
    expect(screen.getByText('补充信息')).toBeTruthy()
    expect(screen.getByText('Endpoint')).toBeTruthy()
    expect(screen.getByText('h:1')).toBeTruthy()
  })

  it('uses the default description when none is provided', () => {
    render(<DashboardCard title="指标" icon={<span>i</span>} value={1} />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.getByText(/每 30 秒自动刷新一次/)).toBeTruthy()
  })

  it('renders the detail table rows and falls back to emptyText for an empty table', () => {
    const table: DashboardDetailTable = {
      columns: [{ key: 'name', label: 'Topic', wide: true }, { key: 'depth', label: '积压', align: 'right' }],
      rows: [{ name: 'orders', depth: 3 }, { name: 'nulls', depth: null }],
    }
    const emptyTable: DashboardDetailTable = { columns: table.columns, rows: [], emptyText: '没有可见 Topic。' }
    const { rerender } = render(<DashboardCard title="指标" icon={<span>i</span>} value={1} detailTable={table} />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.getByText('orders')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByTitle('3')).toBeTruthy() // cell title fallback
    expect(screen.getByTitle('--')).toBeTruthy() // nullish cell → '--'
    expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(1)
    rerender(<DashboardCard title="指标" icon={<span>i</span>} value={1} detailTable={emptyTable} />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.getByText('没有可见 Topic。')).toBeTruthy()
  })

  it('uses the default empty text when emptyText is omitted', () => {
    const table: DashboardDetailTable = { columns: [{ key: 'name', label: 'Topic' }], rows: [] }
    render(<DashboardCard title="指标" icon={<span>i</span>} value={1} detailTable={table} />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    expect(screen.getByText(/暂无明细或当前账号无权读取/)).toBeTruthy()
  })

  it('closes the dialog on backdrop mousedown but not on panel mousedown', () => {
    const { container } = render(<DashboardCard title="指标" icon={<span>i</span>} value={1} />)
    fireEvent.click(screen.getByTitle('指标: 1(点击查看详情)'))
    const panel = container.querySelector('[role="dialog"]')!
    fireEvent.mouseDown(panel)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.mouseDown(container.querySelector('[role="presentation"]')!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
