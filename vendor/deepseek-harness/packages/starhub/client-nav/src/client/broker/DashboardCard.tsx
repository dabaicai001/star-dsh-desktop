/**
 * 仪表盘通用卡片(React 壳内版)——自 `src/components/dashboard/DashboardCard.vue`
 * 逐组件迁移:DOM 结构保留、class 全换 dsw token、逻辑零改动(铁律 5)。
 *
 * 行为对齐 Vue 版:点击卡片打开实时指标详情(模态),内含趋势图(采样
 * 历史折线 / 占比圆环)、明细列表与明细表;value/chartValue/sampleKey
 * 变化时追加一个采样点(保留最近 20 个)。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DashboardCard.module.css'

export interface DashboardDetail {
  label: string
  value: string | number
}

export interface DashboardDetailColumn {
  key: string
  label: string
  align?: 'left' | 'right'
  wide?: boolean
}

export interface DashboardDetailTable {
  columns: DashboardDetailColumn[]
  rows: Array<Record<string, string | number | null | undefined>>
  emptyText?: string
}

export interface DashboardChartPoint {
  label: string
  value: number
}

export type DashboardColor = 'cyan' | 'green' | 'yellow' | 'red' | 'purple' | 'blue'
export type DashboardTrend = 'up' | 'down' | 'stable'
export type DashboardChartType = 'auto' | 'line' | 'donut' | 'none'

export interface DashboardCardProps {
  title: string
  icon: ReactNode
  value: string | number
  subtitle?: string
  progress?: number
  color?: DashboardColor
  trend?: DashboardTrend
  loading?: boolean
  description?: string
  details?: DashboardDetail[]
  detailTable?: DashboardDetailTable
  chartType?: DashboardChartType
  chartValue?: number
  chartData?: DashboardChartPoint[]
  sampleKey?: string | number
}

/** 颜色 → CSS 语义 token(与 Vue 版 color-* 主题一一对应,dsw 无 yellow/purple 专属别名,取静态色)。 */
export const DASHBOARD_COLOR_TOKENS: Record<DashboardColor, string> = {
  cyan: 'var(--dsw-accent)',
  green: 'var(--dsw-alias-state-success-primary)',
  yellow: 'var(--dsw-static-amber-400)',
  red: 'var(--dsw-alias-state-error-primary)',
  purple: 'var(--dsw-static-deepseek-400)',
  blue: 'var(--dsw-static-blue-450)',
}

/** 默认描述文案(与 Vue 版一致)。 */
const DEFAULT_DESCRIPTION = '该指标来自当前连接的实时采集结果,每 30 秒自动刷新一次。'

/**
 * 从 value/chartValue 提取数值;无法解析返回 null(Vue 版 numericValue)。
 * @param value - 展示值(可带千分位/文本前缀)。
 * @param chartValue - 显式图表数值(优先)。
 * @returns 数值或 null。
 */
export function dashboardNumericValue(value: string | number, chartValue?: number): number | null {
  if (chartValue !== undefined && Number.isFinite(chartValue)) return chartValue
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (match === null) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 折线采样点的 SVG 坐标串(与 Vue 版 linePoints 同算法)。
 * @param points - 采样点。
 * @param min - 纵轴下限。
 * @param max - 纵轴上限。
 * @returns "x,y x,y …" 或空串。
 */
export function dashboardLinePoints(
  points: readonly DashboardChartPoint[],
  min: number,
  max: number,
): string {
  const span = Math.max(max - min, Math.abs(max) * 0.08, 1)
  return points.map((point, index) => {
    const x = points.length === 1 ? 160 : 12 + (index / (points.length - 1)) * 296
    const y = 100 - ((point.value - min) / span) * 80
    return `${x.toFixed(1)},${Math.max(12, Math.min(100, y)).toFixed(1)}`
  }).join(' ')
}

/**
 * 渲染仪表盘卡片(按钮)+ 详情模态。
 * @param props - 卡片契约。
 * @returns 卡片按钮与(打开时的)详情模态。
 */
export function DashboardCard({
  title, icon, value, subtitle, progress, color = 'cyan', trend, loading = false,
  description, details, detailTable, chartType = 'auto', chartValue, chartData, sampleKey,
}: DashboardCardProps) {
  const [detailOpen, setDetailOpen] = useState(false)
  const [sampledHistory, setSampledHistory] = useState<DashboardChartPoint[]>([])

  const progressWidth = progress === undefined ? 0 : Math.min(100, Math.max(0, progress))

  // Vue watch(value, chartValue, sampleKey, immediate):变化时追加采样点,保留 20 个。
  useEffect(() => {
    const numeric = dashboardNumericValue(value, chartValue)
    if (numeric === null) return
    const label = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    setSampledHistory(history => [...history, { label, value: numeric }].slice(-20))
  }, [value, chartValue, sampleKey])

  const detailRows = useMemo<DashboardDetail[]>(() => {
    const rows: DashboardDetail[] = [{ label: '当前值', value }]
    if (subtitle !== undefined) rows.push({ label: '补充信息', value: subtitle })
    if (progress !== undefined) rows.push({ label: '占比', value: `${progressWidth.toFixed(2)}%` })
    return [...rows, ...(details ?? [])]
  }, [value, subtitle, progress, progressWidth, details])

  const chartPoints = useMemo(
    () => (chartData !== undefined && chartData.length > 0 ? chartData.slice(-20) : sampledHistory),
    [chartData, sampledHistory],
  )
  const effectiveChartType = useMemo<DashboardChartType>(() => {
    if (chartType === 'none' || chartType === 'line' || chartType === 'donut') return chartType
    if (progress !== undefined) return 'donut'
    return chartPoints.length > 0 ? 'line' : 'none'
  }, [chartType, progress, chartPoints.length])

  const chartRange = useMemo(() => {
    const values = chartPoints.map(point => point.value)
    if (values.length === 0) return { min: 0, max: 0 }
    return { min: Math.min(...values), max: Math.max(...values) }
  }, [chartPoints])

  const linePoints = useMemo(
    () => dashboardLinePoints(chartPoints, chartRange.min, chartRange.max),
    [chartPoints, chartRange],
  )
  const lineAreaPoints = linePoints === '' ? '' : `12,104 ${linePoints} 308,104`

  const chartCaption = useMemo(() => {
    if (effectiveChartType === 'donut') {
      return `${progressWidth.toFixed(1)}% 已使用 · ${(100 - progressWidth).toFixed(1)}% 可用`
    }
    if (chartPoints.length === 0) return '等待采集'
    // 长度 > 0 已在上行保证;at(-1) 恒有值,?? 分支仅类型收窄。
    const lastLabel = chartPoints.at(-1)?.label ?? ''
    return `${chartPoints.length} 个真实采样点 · ${lastLabel}`
  }, [effectiveChartType, progressWidth, chartPoints])

  const trendMark = trend === 'up' ? '↑' : trend === 'down' ? '↓' : trend === 'stable' ? '→' : null

  const accent = DASHBOARD_COLOR_TOKENS[color]

  return (
    <>
      <button
        type="button"
        className={css.card}
        style={{ '--card-accent': accent } as React.CSSProperties}
        disabled={loading}
        title={`${title}: ${value}(点击查看详情)`}
        onClick={() =>{  setDetailOpen(true) }}
      >
        <span className={css.cardHead}>
          <span className={css.cardIcon}>{icon}</span>
          <span className={css.cardTitle}>{title}</span>
          {trendMark !== null && <span className={css.cardTrend}>{trendMark}</span>}
          <span className={css.detailChevron}>›</span>
        </span>
        <span className={css.cardBody}>
          {loading ? (
            <span className={css.cardLoading}>
              <span className={css.loadingDot} />
              <span className={css.loadingDot} />
              <span className={css.loadingDot} />
            </span>
          ) : (
            <>
              <span className={css.cardValue}>{value}</span>
              {subtitle !== undefined && <span className={css.cardSubtitle}>{subtitle}</span>}
            </>
          )}
        </span>
        {progress !== undefined && (
          <span className={css.cardProgress}>
            <span className={css.progressBar}>
              <span className={css.progressFill} style={{ width: `${progressWidth}%` }} />
            </span>
            <span className={css.progressText}>{progressWidth.toFixed(1)}%</span>
          </span>
        )}
      </button>

      {detailOpen && (
        <div className={css.dialogBackdrop} role="presentation" onMouseDown={() =>{  setDetailOpen(false) }}>
          <div
            className={css.detailPanel}
            role="dialog"
            aria-label={`${title} 实时指标详情`}
            onMouseDown={(event) =>{  event.stopPropagation() }}
          >
            <div className={css.detailHead}>
              <span className={css.cardIcon}>{icon}</span>
              <span className={css.detailHeadText}>
                <strong>{title}</strong>
                <span>实时指标详情</span>
              </span>
              <button
                type="button"
                className={css.closeButton}
                aria-label="关闭"
                onClick={() =>{  setDetailOpen(false) }}
              >
                <IconCloseOutline16 size={14} />
              </button>
            </div>
            <div className={css.detailValue}>{value}</div>
            <p className={css.detailDescription}>
              {description ?? DEFAULT_DESCRIPTION}
            </p>
            {effectiveChartType !== 'none' && (
              <div className={css.detailChart}>
                <div className={css.detailChartHead}>
                  <strong>{effectiveChartType === 'donut' ? '占比构成' : '实时趋势'}</strong>
                  <span>{chartCaption}</span>
                </div>
                {effectiveChartType === 'donut' ? (
                  <div className={css.donutWrap}>
                    <svg className={css.donut} viewBox="0 0 120 120" role="img" aria-label={chartCaption}>
                      <circle className={css.donutTrack} cx="60" cy="60" r="46" />
                      <circle
                        className={css.donutValue}
                        cx="60" cy="60" r="46" pathLength={100}
                        strokeDasharray={`${progressWidth} ${100 - progressWidth}`}
                      />
                    </svg>
                    <div className={css.donutLabel}>
                      <strong>{progressWidth.toFixed(1)}%</strong>
                      <span>当前占比</span>
                    </div>
                    <div className={css.donutLegend}>
                      <span><i className={css.used} />已使用 {progressWidth.toFixed(1)}%</span>
                      <span><i />可用 {(100 - progressWidth).toFixed(1)}%</span>
                    </div>
                  </div>
                ) : (
                  <div className={css.lineWrap}>
                    <svg className={css.line} viewBox="0 0 320 116" preserveAspectRatio="none" role="img" aria-label={chartCaption}>
                      <path className={css.lineGrid} d="M12 24H308 M12 64H308 M12 104H308" />
                      {lineAreaPoints !== '' && <polygon className={css.lineArea} points={lineAreaPoints} />}
                      {linePoints !== '' && <polyline className={css.lineValue} points={linePoints} />}
                    </svg>
                    <div className={css.lineRange}>
                      <span>MIN {chartRange.min.toLocaleString()}</span>
                      <span>MAX {chartRange.max.toLocaleString()}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className={css.detailList}>
              {detailRows.map(row => (
                <div key={row.label} className={css.detailRow}>
                  <span>{row.label}</span>
                  <code>{row.value}</code>
                </div>
              ))}
            </div>
            {detailTable !== undefined && (
              <div className={css.detailTableWrap}>
                <table className={css.detailTable}>
                  <thead>
                    <tr>
                      {detailTable.columns.map(column => (
                        <th
                          key={column.key}
                          className={column.wide === true ? css.wide : column.align === 'right' ? css.right : undefined}
                        >
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detailTable.rows.length === 0 ? (
                      <tr>
                        <td colSpan={detailTable.columns.length} className={css.detailEmpty}>
                          {detailTable.emptyText ?? '暂无明细或当前账号无权读取。'}
                        </td>
                      </tr>
                    ) : (
                      detailTable.rows.map((row, index) => (
                        <tr key={index}>
                          {detailTable.columns.map(column => (
                            <td
                              key={column.key}
                              className={column.wide === true ? css.wide : column.align === 'right' ? css.right : undefined}
                              title={String(row[column.key] ?? '--')}
                            >
                              {row[column.key] ?? '--'}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
