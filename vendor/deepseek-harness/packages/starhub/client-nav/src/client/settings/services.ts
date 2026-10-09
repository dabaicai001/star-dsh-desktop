/**
 * Settings 各 tab 的宿主桥 IPC 封装(React 壳内版)。
 *
 * 逐文件复制自 `src/services/`(铁律 5:业务逻辑零重写,仅换调用方):
 * audit.ts / alert.ts / aiDshPlugins.ts / updater.ts。`@tauri-apps/*` 依赖
 * 一律改走共享顶层帧宿主桥(tauriInvoke);自更新归 Electron 壳负责,
 * StarHub 侧无动作(去 Tauri 化 M2,见 tauri.ts)。
 */

import { isTauriRuntime, tauriInvoke } from '../tauri.ts'

export { isTauriRuntime }

// ===== 审计(settings 审计 tab) =====

/** 审计日志条目。 */
export interface AuditLogEntry {
  id: number
  timestamp: number
  category: string
  action: string
  target: string | null
  detail: Record<string, unknown> | null
  session_id: string | null
  asset_id: string | null
  success: boolean
}

/** 审计统计条目(按类别 + 日期分组)。 */
export interface AuditStatItem {
  category: string
  date: string
  total: number
  success: number
  failed: number
}

/** 审计类别枚举。 */
export type AuditCategory = 'ssh' | 'db' | 'sftp' | 'docker' | 'ai' | 'system'

/** 查询审计日志(固定 200/0 一次拉全量,与 Vue 版一致)。
 * @param params - 查询参数(limit/offset/categoryFilter)。
 * @returns 审计日志条目列表。
 */
export async function fetchAuditLogs(params: {
  limit?: number
  offset?: number
  categoryFilter?: string | null
}): Promise<AuditLogEntry[]> {
  if (!isTauriRuntime()) return []
  return tauriInvoke<AuditLogEntry[]>('audit_list', {
    limit: params.limit ?? 200,
    offset: params.offset ?? 0,
    categoryFilter: params.categoryFilter ?? null,
  })
}

/** 清理审计日志(不传 beforeTimestamp 则清理全部),返回删除条数。
 * @param beforeTimestamp - 清理该时间戳之前的日志;缺省清理全部。
 * @returns 删除的日志条数。
 */
export async function clearAuditLogs(beforeTimestamp?: number): Promise<number> {
  if (!isTauriRuntime()) return 0
  return tauriInvoke<number>('audit_clear', { beforeTimestamp: beforeTimestamp ?? null })
}

/** 审计统计(按类别 + 日期分组)。
 * @returns 审计统计条目列表。
 */
export async function fetchAuditStats(): Promise<AuditStatItem[]> {
  if (!isTauriRuntime()) return []
  return tauriInvoke<AuditStatItem[]>('audit_stats')
}

// ===== 告警规则(settings 告警 tab) =====

/** 告警规则。 */
export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  category: string
  metric: string
  operator: string
  threshold: number
  duration_sec: number
  webhook_url: string | null
  cooldown_sec: number
  created_at: number
  updated_at: number
}

/** 告警规则创建/更新输入。 */
export interface AlertRuleInput {
  name: string
  enabled?: boolean
  category: string
  metric: string
  operator: string
  threshold: number
  duration_sec?: number
  webhook_url?: string | null
  cooldown_sec?: number
}

/** 创建告警规则;浏览器预览返回本地 mock(与 Vue 版一致)。
 * @param input - 告警规则输入。
 * @returns 创建的告警规则。
 */
export async function createAlertRule(input: AlertRuleInput): Promise<AlertRule> {
  if (!isTauriRuntime()) {
    const now = Math.floor(Date.now() / 1000)
    return {
      id: `browser-${crypto.randomUUID()}`,
      name: input.name,
      enabled: input.enabled ?? true,
      category: input.category,
      metric: input.metric,
      operator: input.operator,
      threshold: input.threshold,
      duration_sec: input.duration_sec ?? 0,
      webhook_url: input.webhook_url ?? null,
      cooldown_sec: input.cooldown_sec ?? 300,
      created_at: now,
      updated_at: now,
    }
  }
  return tauriInvoke<AlertRule>('alert_create', { input })
}

/** 更新告警规则(浏览器预览抛错,与 Vue 版一致)。
 * @param id - 告警规则 id。
 * @param input - 告警规则输入。
 * @returns 更新后的告警规则。
 */
export async function updateAlertRule(id: string, input: AlertRuleInput): Promise<AlertRule> {
  if (!isTauriRuntime()) throw new Error('请在 StarHub 桌面端更新告警规则')
  return tauriInvoke<AlertRule>('alert_update', { id, input })
}

/** 删除告警规则(浏览器预览 no-op)。
 * @param id - 告警规则 id。
 */
export async function deleteAlertRule(id: string): Promise<void> {
  if (!isTauriRuntime()) return
  await tauriInvoke('alert_delete', { id })
}

/** 列出所有告警规则。
 * @returns 告警规则列表。
 */
export async function fetchAlertRules(): Promise<AlertRule[]> {
  if (!isTauriRuntime()) return []
  return tauriInvoke<AlertRule[]>('alert_list')
}

/** 测试 webhook 连通性。
 * @param url - 目标 webhook 地址。
 * @returns 测试结果文本。
 */
export async function testAlertWebhook(url: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error('请在 StarHub 桌面端测试 Webhook')
  return tauriInvoke<string>('alert_test_webhook', { url })
}

// ===== 自动更新(settings 关于 tab) =====

/** 自动更新检查结果。 */
export interface UpdateInfo {
  available: boolean
  version?: string
  date?: string
  body?: string
}

/**
 * 检查是否有可用更新。自更新归 Electron 壳负责(去 Tauri 化 M2 后
 * `plugin:updater|*` 面不存在),StarHub 侧恒报告无可用更新。
 * @returns 更新信息(恒 available=false)。
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  return { available: false }
}

/**
 * 下载并安装更新。自更新归 Electron 壳负责,StarHub 侧无动作。
 */
export async function downloadAndInstall(): Promise<void> {
}
