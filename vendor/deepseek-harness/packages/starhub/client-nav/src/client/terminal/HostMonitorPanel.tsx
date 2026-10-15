/**
 * SSH 终端「监控」页签:在已连接的会话上周期性采集主机指标并渲染成卡片 +
 * 磁盘表。采集走 `ui.ssh_exec`(不新开连接、不在终端留输出),因此断开连接
 * 时面板只展示占位提示。
 *
 * @module StarHub SSH host monitor panel (client)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconGaugeOutlineMedium, IconRefreshOutlineMedium, IconWarningTriangleOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { tauriInvoke } from '../tauri.ts'
import {
  formatBytes, HOST_METRICS_COMMAND, parseHostMetrics, type HostMetrics,
} from './host-monitor.ts'
import css from './HostMonitorPanel.module.css'

/** 自动刷新间隔(ms)。 */
const AUTO_REFRESH_MS = 5000

/** 单次采集超时(s)。 */
const COLLECT_TIMEOUT_SEC = 15

/** 监控面板属性。 */
export interface HostMonitorPanelProps {
  /** 终端会话 id(采集命令在此会话上执行)。 */
  sessionId: string
  /** SSH 是否已连接(断开时只展示占位)。 */
  sshConnected: boolean
}

/**
 * 渲染主机监控面板。
 * @param props - 会话 id 与连接状态。
 * @returns 监控面板。
 */
export function HostMonitorPanel({ sessionId, sshConnected }: HostMonitorPanelProps) {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  // 组件卸载后不再 setState:轮询 / 慢采集都要靠它收口。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  /** 采集一次主机指标。 */
  const refresh = useCallback(async (): Promise<void> => {
    if (!sshConnected) return
    setLoading(true)
    try {
      const raw = await tauriInvoke<string>('ssh_exec', {
        id: sessionId,
        command: HOST_METRICS_COMMAND,
        timeoutSec: COLLECT_TIMEOUT_SEC,
      })
      if (!aliveRef.current) return
      setMetrics(parseHostMetrics(raw))
      setError(null)
      setUpdatedAt(Date.now())
    } catch (caught) {
      if (!aliveRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [sessionId, sshConnected])

  // 首次进入 / 换会话时采集一次;自动刷新按间隔续采。
  useEffect(() => {
    if (!sshConnected) return
    void refresh()
    if (!auto) return
    const timer = window.setInterval(() => { void refresh() }, AUTO_REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [auto, refresh, sshConnected])

  if (!sshConnected) {
    return (
      <div className={css.placeholder}>
        <span className={css.placeholderIcon} aria-hidden="true"><IconGaugeOutlineMedium size={22} /></span>
        <span className={css.placeholderTitle}>等待 SSH 连接</span>
        <span className={css.placeholderHint}>连接成功后即可查看主机负载、内存、磁盘与网络指标。</span>
      </div>
    )
  }

  const memPercent = metrics?.mem?.percent ?? 0
  return (
    <div className={css.panel}>
      <header className={css.toolbar}>
        <button type="button" className={css.refresh} onClick={() => void refresh()} disabled={loading} title="重新采集" aria-label="重新采集主机指标">
          <IconRefreshOutlineMedium size={13} />{loading ? '采集中…' : '刷新'}
        </button>
        <label className={css.auto}>
          <input type="checkbox" checked={auto} onChange={(event) => { setAuto(event.target.checked) }} />
          自动刷新(5s)
        </label>
        <span className={css.updated}>
          {updatedAt === null ? '尚未采集' : `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}
        </span>
      </header>
      {error !== null && (
        <div className={css.error} role="alert">
          <span aria-hidden="true"><IconWarningTriangleOutlineMedium size={13} /></span>
          <span>{error}</span>
        </div>
      )}
      <div className={css.body}>
        <div className={css.cards}>
          <Card label="运行时长" value={metrics?.uptime ?? '—'} />
          <Card
            label="平均负载"
            value={metrics?.load === null || metrics?.load === undefined ? '—' : metrics.load.map(value => value.toFixed(2)).join(' / ')}
            hint="1 / 5 / 15 分钟"
          />
          <Card label="CPU 核数" value={metrics?.cpuCores === null || metrics?.cpuCores === undefined ? '—' : String(metrics.cpuCores)} />
          <Card label="进程数" value={metrics?.procs === null || metrics?.procs === undefined ? '—' : String(metrics.procs)} />
          <Card
            label="网络收发"
            value={metrics?.net === null || metrics?.net === undefined ? '—' : `${formatBytes(metrics.net.rxBytes)} ↓`}
            hint={metrics?.net === null || metrics?.net === undefined ? undefined : `${formatBytes(metrics.net.txBytes)} ↑`}
          />
        </div>
        <section className={css.memCard}>
          <header className={css.memHead}>
            <span className={css.memTitle}>内存</span>
            <span className={css.memValue}>
              {metrics?.mem === null || metrics?.mem === undefined
                ? '—'
                : `${metrics.mem.usedMb} / ${metrics.mem.totalMb} MB (${memPercent}%)`}
            </span>
          </header>
          <div className={css.memTrack} aria-hidden="true">
            <div className={css.memFill} style={{ width: `${Math.min(100, Math.max(0, memPercent))}%` }} />
          </div>
          {metrics?.mem !== null && metrics?.mem !== undefined && (
            <span className={css.memHint}>可用 {metrics.mem.freeMb} MB</span>
          )}
        </section>
        <section className={css.diskCard}>
          <header className={css.memHead}>
            <span className={css.memTitle}>磁盘</span>
            <span className={css.memValue}>{metrics?.disks.length ?? 0} 个挂载点</span>
          </header>
          {metrics !== null && metrics.disks.length > 0 ? (
            <table className={css.table}>
              <thead>
                <tr><th>挂载点</th><th>容量</th><th>已用</th><th>可用</th><th>使用率</th></tr>
              </thead>
              <tbody>
                {metrics.disks.map(disk => (
                  <tr key={`${disk.fs}-${disk.mount}`}>
                    <td className={css.mount} title={`${disk.fs} → ${disk.mount}`}>{disk.mount}</td>
                    <td>{disk.size}</td>
                    <td>{disk.used}</td>
                    <td>{disk.avail}</td>
                    <td>
                      <span className={css.percentWrap}>
                        <span className={css.percentTrack} aria-hidden="true">
                          <span className={css.percentFill} style={{ width: `${Math.min(100, Math.max(0, disk.percent))}%` }} />
                        </span>
                        {disk.percent}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className={css.diskEmpty}>暂无磁盘数据</div>
          )}
        </section>
        <footer className={css.host}>
          {metrics?.hostname ?? '未知主机'}
          {metrics?.kernel !== null && metrics?.kernel !== undefined ? ` · ${metrics.kernel}` : ''}
        </footer>
      </div>
    </div>
  )
}

/** 一张指标卡。 */
function Card({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className={css.card}>
      <span className={css.cardLabel}>{label}</span>
      <span className={css.cardValue}>{value}</span>
      {hint !== undefined && hint !== '' && <span className={css.cardHint}>{hint}</span>}
    </div>
  )
}
