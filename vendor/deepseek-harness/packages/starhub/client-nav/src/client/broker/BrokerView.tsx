/**
 * Broker(Kafka / NSQ)状态工作台——React 壳内版。
 *
 * 自 `src/views/BrokerView.vue` 迁移(手册 P1 首个最小样本):结构保留、
 * class 换 dsw token、逻辑零改动。挂载即刷新 + 每 30 秒自动刷新;
 * 资产类型由 config.dbType 决定(kafka / nsq),连接参数取自资产配置,
 * 数据经共享 Tauri 桥调 Rust `broker_overview`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconDataOutline16, IconLinkOutline16, IconListPenOutline16, IconQueueOutline14,
  IconRefreshOutline14, IconSendOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RustAsset } from '../store.ts'
import { loadBrokerOverview, type BrokerConnectParams, type BrokerKind, type BrokerOverview } from './service.ts'
import { DashboardCard, type DashboardDetailTable } from './DashboardCard.tsx'
import css from './BrokerView.module.css'

/** Broker 视图 props:只读资产(连接参数 + 类型)。 */
export interface BrokerViewProps {
  /** 打开的 broker 资产(config 携带 host/port/凭据;dbType 决定 kafka/nsq)。 */
  asset: RustAsset
}

/** 默认端口(kafka=9092 / nsq=4150,与 Vue 版一致)。 */
function defaultPort(kind: BrokerKind): number {
  return kind === 'kafka' ? 9092 : 4150
}

/**
 * 渲染 Broker 状态工作台:头部(资产名 + endpoint + 刷新)+ 错误提示 +
 * 仪表盘卡片网格(kafka 分区 / nsq 积压等)。
 * @param props - 资产只读 props。
 * @returns 壳内直渲的 Broker 工作台。
 */
export function BrokerView({ asset }: BrokerViewProps) {
  const kind: BrokerKind = asset.config.dbType === 'nsq' ? 'nsq' : 'kafka'
  const [overview, setOverview] = useState<BrokerOverview>({
    kind, status: 'offline', endpoint: '--', nodeCount: 0, resources: [], observedAt: 0,
  })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sampleKey, setSampleKey] = useState(0)

  const refresh = useCallback(async () => {
    const host = typeof asset.config.host === 'string' ? asset.config.host : ''
    if (host === '') return
    setRefreshing(true)
    try {
      // exactOptionalPropertyTypes:可选字段缺省时整体不传(与 Vue 版 undefined 语义一致)。
      const params: BrokerConnectParams = {
        host,
        port: (typeof asset.config.port === 'number' ? asset.config.port : 0) || defaultPort(kind),
      }
      if (typeof asset.config.username === 'string') params.username = asset.config.username
      if (typeof asset.config.password === 'string') params.password = asset.config.password
      if (typeof asset.config.ssl === 'boolean') params.ssl = asset.config.ssl
      const result = await loadBrokerOverview(kind, params)
      setOverview(result)
      setError(null)
      setSampleKey(key => key + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [asset.config, kind])

  // 挂载即刷新 + 每 30 秒自动刷新;卸载清定时器(Vue onMounted/onBeforeUnmount)。
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 30000)
    return () =>{  window.clearInterval(timer) }
  }, [refresh])

  const totalPartitions = useMemo(
    () => overview.resources.reduce((total, resource) => total + (resource.partitions || 0), 0),
    [overview.resources],
  )
  const totalDepth = useMemo(
    () => overview.resources.reduce((total, resource) => total + (resource.depth || 0), 0),
    [overview.resources],
  )
  const totalMessages = useMemo(
    () => overview.resources.reduce((total, resource) => total + (resource.messages || 0), 0),
    [overview.resources],
  )

  const resourceTable = useMemo<DashboardDetailTable>(() => ({
    columns: kind === 'kafka'
      ? [
        { key: 'name', label: 'Topic', wide: true },
        { key: 'partitions', label: '分区', align: 'right' },
        { key: 'leader', label: 'Leader' },
      ]
      : [
        { key: 'name', label: 'Topic', wide: true },
        { key: 'channels', label: 'Channel', align: 'right' },
        { key: 'depth', label: '积压', align: 'right' },
        { key: 'messages', label: '累计消息', align: 'right' },
      ],
    rows: overview.resources.map(resource => ({
      name: resource.name,
      partitions: resource.partitions,
      leader: resource.leader,
      channels: resource.channels,
      depth: resource.depth,
      messages: resource.messages,
    })),
    emptyText: `当前 ${kind.toUpperCase()} 没有可见 Topic。`,
  }), [kind, overview.resources])

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.headerLeft}>
          <span className={css.kindBadge}>{kind.toUpperCase()}</span>
          <span className={css.name}>{asset.name}</span>
          <code className={css.endpoint}>{overview.endpoint}</code>
        </div>
        <button
          type="button"
          className={css.refreshButton}
          title="刷新状态"
          aria-label="刷新状态"
          disabled={refreshing}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline14 size={14} className={refreshing ? css.spin : undefined} />
        </button>
      </div>

      {error !== null && (
        <div className={css.error}>
          <IconWarningOutline16 size={14} />
          {error}
        </div>
      )}

      <div className={css.grid}>
        <DashboardCard
          title="连接状态"
          icon={<IconLinkOutline16 size={16} />}
          value={error !== null ? '异常' : overview.status === 'online' ? '在线' : '离线'}
          color={error !== null ? 'red' : 'green'}
          loading={loading}
          chartValue={error !== null ? 0 : 1}
          sampleKey={sampleKey}
          details={[{ label: 'Endpoint', value: overview.endpoint }]}
        />
        <DashboardCard
          title={kind === 'kafka' ? 'Broker 节点' : 'NSQD 节点'}
          icon={<IconDataOutline16 size={16} />}
          value={overview.nodeCount}
          color="cyan"
          loading={loading}
          chartValue={overview.nodeCount}
          sampleKey={sampleKey}
        />
        <DashboardCard
          title="Topic 数量"
          icon={<IconListPenOutline16 size={16} />}
          value={overview.resources.length}
          color="purple"
          loading={loading}
          chartValue={overview.resources.length}
          sampleKey={sampleKey}
          detailTable={resourceTable}
        />
        <DashboardCard
          title={kind === 'kafka' ? '分区总数' : '当前积压'}
          icon={<IconQueueOutline14 size={16} />}
          value={kind === 'kafka' ? totalPartitions : totalDepth}
          color={kind === 'nsq' && totalDepth > 0 ? 'yellow' : 'cyan'}
          loading={loading}
          chartValue={kind === 'kafka' ? totalPartitions : totalDepth}
          sampleKey={sampleKey}
          detailTable={resourceTable}
        />
        {kind === 'nsq' && (
          <DashboardCard
            title="累计消息"
            icon={<IconSendOutline16 size={16} />}
            value={totalMessages.toLocaleString()}
            color="green"
            loading={loading}
            chartValue={totalMessages}
            sampleKey={sampleKey}
            detailTable={resourceTable}
          />
        )}
      </div>
    </div>
  )
}
