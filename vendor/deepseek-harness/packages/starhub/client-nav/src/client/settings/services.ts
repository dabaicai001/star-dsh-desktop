/**
 * Settings 各 tab 的 Tauri IPC 封装(React 壳内版)。
 *
 * 逐文件复制自 `src/services/`(铁律 5:业务逻辑零重写,仅换调用方):
 * audit.ts / alert.ts / aiDshPlugins.ts / updater.ts / aiMemory.ts(二期子集)/
 * aiHarness.ts(shutdown)。`@tauri-apps/*` 依赖一律改走共享顶层帧 Tauri 桥
 * (tauriInvoke);updater 的 check/download_and_install 直接调
 * `plugin:updater|*` 命令(Channel 用 `__CHANNEL__:id` 串行化桥接)。
 */

import { tauriInvoke } from '../tauri.ts'

/** 浏览器预览判定(与 src/services 各文件的 isTauriRuntime 同语义)。
 * @returns 是否运行在 Tauri 桌面环境。
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ===== 审计(settings 审计 tab / AI tab 记忆操作记审计) =====

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

/** 记录一条审计日志。
 * @param params - 审计日志参数。
 * @returns 写入的审计日志 id(浏览器预览返回 0)。
 */
export async function logAudit(params: {
  category: string
  action: string
  target?: string | null
  detail?: Record<string, unknown> | null
  sessionId?: string | null
  assetId?: string | null
  success?: boolean
}): Promise<number> {
  if (!isTauriRuntime()) return 0
  return tauriInvoke<number>('audit_log', {
    category: params.category,
    action: params.action,
    target: params.target ?? null,
    detail: params.detail ?? null,
    sessionId: params.sessionId ?? null,
    assetId: params.assetId ?? null,
    success: params.success ?? true,
  })
}

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

// ===== dsh 插件(settings 插件 tab) =====

/** 插件来源描述(kind + 可选位置)。 */
export interface DshPluginSource {
  kind: string
  location?: string
}

/** 已安装的 dsh 插件信息。 */
export interface DshPluginInfo {
  id: string
  name: string
  version: string
  description?: string
  license?: string
  source: DshPluginSource
  entry: string
  enabled: boolean
  installedAt?: string
  missing?: boolean
  /** 浏览器端 UI 插件(manifest 声明 dsh.client;由 dsh web 进程加载) */
  dshClient?: boolean
  /** 内置插件(壳依赖,随应用发布;不可启停/卸载) */
  builtin?: boolean
}

/** 插件市场中的单个插件条目。 */
export interface DshMarketPlugin {
  name: string
  url: string
  description: string
  stars?: number
  npm?: string
}

/** 插件市场分类(分类名 + 该分类下的插件)。 */
export interface DshMarketCategory {
  name: string
  plugins: DshMarketPlugin[]
}

/** 插件市场目录(抓取时间 + 各分类插件)。 */
export interface DshMarketCatalog {
  fetchedAt?: string
  stale: boolean
  categories: DshMarketCategory[]
}

/** 已安装插件列表。
 * @returns 已安装插件信息列表。
 */
export async function listPlugins(): Promise<DshPluginInfo[]> {
  if (!isTauriRuntime()) return []
  return tauriInvoke<DshPluginInfo[]>('dsh_plugin_list')
}

/** 本地导入:插件目录或 .zip 文件路径,返回安装记录(默认关闭)。
 * @param path - 本地插件目录或 .zip 文件路径。
 * @returns 安装后的插件信息。
 */
export async function installLocalPlugin(path: string): Promise<DshPluginInfo> {
  return tauriInvoke<DshPluginInfo>('dsh_plugin_install_local', { path })
}

/** URL 安装:GitHub 仓库地址(可带 /tree/<branch>)或 zip 直链。
 * @param url - 插件仓库地址或 zip 直链。
 * @returns 安装后的插件信息。
 */
export async function installPluginFromUrl(url: string): Promise<DshPluginInfo> {
  return tauriInvoke<DshPluginInfo>('dsh_plugin_install_url', { url })
}

/** 逐项启停(需重启 runtime 生效)。
 * @param id - 插件 id。
 * @param enabled - 是否启用该插件。
 */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await tauriInvoke('dsh_plugin_set_enabled', { id, enabled })
}

/** 卸载(需重启 runtime 生效)。
 * @param id - 插件 id。
 */
export async function uninstallPlugin(id: string): Promise<void> {
  await tauriInvoke('dsh_plugin_uninstall', { id })
}

/** 拉取插件市场目录;抓取失败不抛错(有缓存回缓存 stale=true,无缓存空目录)。
 * @param forceRefresh - 是否强制刷新(忽略缓存)。
 * @returns 插件市场目录。
 */
export async function fetchPluginMarket(forceRefresh = false): Promise<DshMarketCatalog> {
  return tauriInvoke<DshMarketCatalog>('dsh_plugin_market_fetch', { forceRefresh })
}

/** 关闭 dsh runtime(插件变更后重启生效;runtime 未运行属正常)。 */
export async function shutdownDshRuntime(): Promise<void> {
  await tauriInvoke('dsh_shutdown')
}

/** 重启 dsh web 进程,使插件增删/启停重新注入 web 运行时。
 * 插件列表(pluginInventory)读的是 web 运行时 Loader 快照,该注入只在
 * spawn 时执行一次;变更插件后须重启 web 才能让新启用的 dsh.client 插件
 * 出现在「插件列表」里。返回重启后的实际 URL。
 */
export async function restartDshWeb(): Promise<string> {
  return tauriInvoke<string>('dsh_web_restart')
}

// ===== 自动更新(settings 关于 tab) =====

/** 自动更新检查结果。 */
export interface UpdateInfo {
  available: boolean
  version?: string
  date?: string
  body?: string
}

/** updater Channel 的最小桥(与 @tauri-apps/api/core 的 Channel 同串行化契约,仅用于进度回调占位)。 */
function updaterChannel(): { toJSON: () => string } {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { transformCallback?: (callback: unknown, once?: boolean) => number }
  }).__TAURI_INTERNALS__
  const transform = internals?.transformCallback
  // v8 ignore next 2 -- 回调由 Rust updater 在下载进度事件时调用,浏览器侧仅注册占位
  const id = typeof transform === 'function' ? transform(() => {}, false) : 0
  return { toJSON: () => `__CHANNEL__:${id}` }
}

/** 检查是否有可用更新;纯浏览器预览降级返回无更新。
 * @returns 更新信息(无可用更新时 available=false)。
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  if (!isTauriRuntime()) return { available: false }
  const metadata = await tauriInvoke<{ version?: string; date?: string; body?: string } | null>('plugin:updater|check')
  if (metadata === null) return { available: false }
  const info: UpdateInfo = { available: true }
  // exactOptionalPropertyTypes:可选字段缺省时整体不设
  if (metadata.version !== undefined) info.version = metadata.version
  if (metadata.date !== undefined) info.date = metadata.date
  if (metadata.body !== undefined) info.body = metadata.body
  return info
}

/** 下载并安装更新,安装完成后自动重启;纯浏览器预览直接返回。 */
export async function downloadAndInstall(): Promise<void> {
  if (!isTauriRuntime()) return
  const metadata = await tauriInvoke<{ rid: number } | null>('plugin:updater|check')
  if (metadata === null) return
  await tauriInvoke('plugin:updater|download_and_install', {
    onEvent: updaterChannel(),
    rid: metadata.rid,
  })
  await tauriInvoke('plugin:process|restart')
}

// ===== 长期记忆(settings AI tab 记忆管理) =====

/** 一条长期记忆条目。 */
export interface AiMemoryRow {
  id: string
  scope: string
  content: string
  created_at: number
  updated_at: number
}

/** 列出记忆条目;scope 精确过滤,不传返回全部。
 * @param scope - 可选的作用域过滤条件。
 * @returns 记忆条目列表。
 */
export async function aiMemoryList(scope?: string): Promise<AiMemoryRow[]> {
  if (!isTauriRuntime()) return []
  return tauriInvoke<AiMemoryRow[]>('ai_memory_list', { scope: scope ?? null })
}

/** 按 id 更新内容(有容量检查,超限 reject)。
 * @param id - 记忆条目 id。
 * @param content - 新的记忆内容。
 * @returns 更新后的记忆条目。
 */
export async function aiMemoryUpdate(id: string, content: string): Promise<AiMemoryRow> {
  if (!isTauriRuntime()) throw new Error('记忆功能仅在桌面版可用')
  return tauriInvoke<AiMemoryRow>('ai_memory_update', { id, content })
}

/** 按 id 删除。
 * @param id - 记忆条目 id。
 */
export async function aiMemoryDelete(id: string): Promise<void> {
  if (!isTauriRuntime()) return
  await tauriInvoke('ai_memory_delete', { id })
}
