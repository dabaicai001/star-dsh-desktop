/**
 * Settings 审计日志 tab(React 壳内版)——自 SettingsView.vue 1009-1084(逻辑)/
 * 2026-2103(模板)迁移:操作历史表格(类别筛选/刷新/清空)+ 统计卡。
 * 并行拉取、固定 200/0 分页、清空后 3s 结果提示等语义原样保留。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  clearAuditLogs, fetchAuditLogs, fetchAuditStats, isTauriRuntime,
  type AuditLogEntry, type AuditStatItem,
} from './services.ts'
import s from './settings.module.css'

/** 类别筛选选项(与 Vue AUDIT_CATEGORIES 一致)。 */
const AUDIT_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'ssh', label: 'SSH' },
  { value: 'db', label: '数据库' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'docker', label: 'Docker' },
  { value: 'ai', label: 'AI' },
  { value: 'system', label: '系统' },
]

/** 秒级时间戳 → YYYY-MM-DD HH:mm:ss。 */
export function formatAuditTime(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 详情字段渲染成单行文本:字符串原样,标量用 String(),对象 JSON 化。 */
function detailValueString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return value.map(detailValueString).join(',')
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : ''
  } catch {
    return '[object Object]'
  }
}

/** 详情字段渲染成可读单行文本;历史记录无 detail 回退 target;不识别的字段整体回退 JSON。 */
export function formatAuditDetail(detail: Record<string, unknown> | null, target?: string | null): string {
  if (detail === null) return target ?? ''
  try {
    const parts: string[] = []
    const statement = detail.sql ?? detail.command
    if (typeof statement === 'string' && statement) parts.push(statement)
    if (typeof detail.database === 'string' && detail.database) parts.push(`db=${detail.database}`)
    if (typeof detail.table === 'string' && detail.table) parts.push(`table=${detail.table}`)
    if (typeof detail.durationMs === 'number') parts.push(`${detail.durationMs}ms`)
    if (typeof detail.rows === 'number') parts.push(`rows=${detail.rows}`)
    if (detail.source) parts.push(`source=${detailValueString(detail.source)}`)
    if (detail.error) parts.push(`error: ${detailValueString(detail.error)}`)
    if (parts.length > 0) return parts.join(' · ')
    return JSON.stringify(detail)
  } catch {
    return detailValueString(detail)
  }
}

/**
 * 渲染审计日志:操作历史表格 + 统计卡。
 * @returns 审计 tab 内容。
 */
export function AuditTab() {
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([])
  const [auditStats, setAuditStats] = useState<AuditStatItem[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditCategoryFilter, setAuditCategoryFilter] = useState('')
  const [auditClearing, setAuditClearing] = useState(false)
  const [auditClearResult, setAuditClearResult] = useState<string | null>(null)

  const loadAuditLogs = useCallback(async () => {
    if (!isTauriRuntime()) {
      setAuditLogs([])
      setAuditStats([])
      return
    }
    setAuditLoading(true)
    try {
      const [logs, stats] = await Promise.all([
        fetchAuditLogs({ limit: 200, offset: 0, categoryFilter: auditCategoryFilter || null }),
        fetchAuditStats(),
      ])
      setAuditLogs(logs)
      setAuditStats(stats)
    } catch (error) {
      console.warn('[settings] Failed to load audit logs:', error)
    } finally {
      setAuditLoading(false)
    }
  }, [auditCategoryFilter])

  // 挂载即加载;类别筛选变化时(loadAuditLogs 依赖 filter 重建)自动重载
  useEffect(() => {
    void loadAuditLogs()
  }, [loadAuditLogs])

  const onClearAudit = async () => {
    setAuditClearing(true)
    setAuditClearResult(null)
    try {
      const deleted = await clearAuditLogs()
      setAuditClearResult(`已清理 ${deleted} 条日志`)
      await loadAuditLogs()
    } catch (error) {
      setAuditClearResult(`清理失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAuditClearing(false)
      setTimeout(() => { setAuditClearResult(null) }, 3000)
    }
  }

  return (
    <div className={s.panel}>
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>操作历史</span>
        </div>
        <div className={s.toolbar}>
          <select
            className={s.select}
            value={auditCategoryFilter}
            onChange={(event) =>{  setAuditCategoryFilter(event.target.value) }}
          >
            {AUDIT_CATEGORIES.map(category => (
              <option key={category.value} value={category.value}>{category.label}</option>
            ))}
          </select>
          <button
            type="button" className={s.btnSecondary} aria-label="刷新"
            disabled={auditLoading} onClick={() => void loadAuditLogs()}
          >
            {auditLoading ? '…' : '刷新'}
          </button>
          <button
            type="button" className={s.btnDanger} disabled={auditClearing}
            onClick={() => void onClearAudit()}
          >
            {auditClearing ? '清理中…' : '清理全部'}
          </button>
          {auditClearResult !== null && <span className={s.hint}>{auditClearResult}</span>}
          <span className={s.spacer} />
          <span className={s.hint}>保留最近 2048 条</span>
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>时间</th>
                <th>类别</th>
                <th>操作</th>
                <th>目标</th>
                <th>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className={s.tableEmpty}>暂无审计日志</td>
                </tr>
              ) : (
                auditLogs.map(log => (
                  <tr key={log.id} className={log.success ? undefined : s.tableFailed}>
                    <td className={s.mono}>{formatAuditTime(log.timestamp)}</td>
                    <td>{log.category}</td>
                    <td>{log.action}</td>
                    <td>{log.target ?? '--'}</td>
                    <td>
                      <span className={log.success ? s.badge : s.badgeOff}>
                        {log.success ? '成功' : '失败'}
                      </span>
                    </td>
                    <td className={s.tableDetail}>{formatAuditDetail(log.detail, log.target)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {auditStats.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHeader}>
            <span className={s.sectionTitle}>统计</span>
          </div>
          <div className={s.statsGrid}>
            {auditStats.map(stat => (
              <div key={`${stat.category}-${stat.date}`} className={s.statCard}>
                <div className={s.statHead}>
                  <span className={s.cardName}>{stat.category}</span>
                  <span className={s.hint}>{stat.date}</span>
                </div>
                <div className={s.statRow}>
                  <span>总数 <code className={s.mono}>{stat.total}</code></span>
                  <span>成功 <code className={s.mono}>{stat.success}</code></span>
                  <span>失败 <code className={s.mono}>{stat.failed}</code></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
