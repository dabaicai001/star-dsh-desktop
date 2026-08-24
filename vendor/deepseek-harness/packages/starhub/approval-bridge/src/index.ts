/**
 * StarHub 审批桥(内核替换 Phase 2,方案 5.2 / D3;StarHub 本地包,不在上游。
 * 2026-08-17 由 starhub-approval 瘦身改名:策略层完全交给 dsh 权限 preset,
 * 本包只保留「消费 preset + 风险门 + 应答桥」三件最小职责):
 *
 * 1. preset 消费:session/created 时读取共享 settings.yaml 的 `permission`
 *    命名空间(dsh web GUI「设置 → 通用 → 权限」写入的 defaultPreset),
 *    把会话审批策略固定为 ask/never——StarHub 侧不再有自己的命令白名单,
 *    审核策略统一由 dsh 权限体系供给。
 * 2. starhub_* 工具风险门(防误删核心):tools/pre-execute 上把「需要人工
 *    确认」的调用升级为 ask(写操作恒 ask;命令/SQL 按只读判定放行、风险词
 *    命中或不确定一律 ask)。删除/高危档(`hard`)与权限预设脱钩:风险词命中
 *    (rm/find -delete/docker 删除/DROP/TRUNCATE/Redis DEL 等)即使会话策略
 *    为 never(danger-full-access 全访问)也必须弹确认卡,绝不静默放行;
 *    只有普通写操作档才随 never 策略放行,与 dsh 自家「全访问不弹审批」
 *    语义对齐。注意:preset 只提供策略,「哪些调用该问」的决定只由本门
 *    产生——删除本门 = 域工具不再有任何确认。
 * 3. 审批应答桥:approval/request 经 SDK stdio 双向 request
 *    (方法 `starhub/approval.request`)桥回 StarHub Rust 主进程,由前端
 *    确认卡给出 allowed-once / rejected;桥不可用一律 fail closed。
 *
 * 风险词与只读判定移植自 StarHub `src/utils/commandGuard.ts`(同源 TS),
 * 语义不变:宁可误拦不误放。
 *
 * @module @deepseek-ai/dsh-starhub-approval-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  effectiveApprovalPolicy,
  setApprovalPolicy,
  type ApprovalOutcome,
  type ApprovalPolicy,
} from '@deepseek-ai/dsh-user-approval'

export const name = 'starhub-approval-bridge'
export const inject = ['approval', 'settings']

/**
 * 插件配置:answerer=false 时只留权限固定与风险门,应答交给组合内其它 answerer;
 * ownsPermissionSettings=false 时不注册 permission 命名空间(组合内已有
 * permission-presets 持有,如 starhub-web),只在 session/created 只读消费——
 * 双注册会撞上 settings「duplicate registration fails loud」,先注册的一方胜出后
 * 另一方静默失效,GUI 权限行随即读到无 base/无 defaultPreset 的裸注册而报错。
 */
export const Config: z<{ answerer?: boolean; ownsPermissionSettings?: boolean }> = z.object({
  answerer: z.boolean().default(true),
  ownsPermissionSettings: z.boolean().default(true),
})

/** 桥方法名;Rust 侧实现见 src-tauri/src/harness/mod.rs。 */
const BRIDGE_METHOD = 'starhub/approval.request'

/** 与 web GUI 共享的权限设置命名空间(dsh permission-presets 的写入方)。 */
const PERMISSION_NAMESPACE: SettingsNamespace = settingsNamespace('permission')

/** settings.yaml 里 permission 段的最小形状(defaultPreset 由 GUI 权限行写入)。 */
const PermissionSchema = z.object({
  defaultPreset: z.string(),
})

// ── 风险词(移植自 commandGuard.ts RISKY_PATTERNS,语义硬编码、不可配置) ──

const RISKY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf]+|--force|--recursive)\b.*\/(?!\s*$)/i, reason: 'rm -rf 删除系统目录' },
  { pattern: /\brm\s+(-[a-z]*[rf]+|--force|--recursive)\b/i, reason: 'rm -rf 递归删除' },
  { pattern: /\brm\s+-[a-z]*r/i, reason: 'rm -r 递归删除' },
  { pattern: /\bdd\s+if=/i, reason: 'dd 命令会覆写磁盘' },
  { pattern: /\bmkfs\./i, reason: 'mkfs 格式化文件系统' },
  { pattern: /\b(format|fdisk)\b/i, reason: '磁盘格式化/分区工具' },
  { pattern: /\b(remove-item|ri)\b[^\n]*(-recurse|-force)/i, reason: 'PowerShell 递归/强制删除' },
  { pattern: /\b(del|erase)\b[^\n]*\/(s|q)\b/i, reason: 'Windows 批量/静默删除' },
  { pattern: /\b(rmdir|rd)\b[^\n]*\/s\b/i, reason: 'Windows 递归删除目录' },
  { pattern: /\b(format-volume|clear-disk|initialize-disk|diskpart)\b/i, reason: 'Windows 磁盘格式化/分区工具' },
  { pattern: /\bdiskutil\s+(erase|partition|apfs\s+delete)/i, reason: 'macOS 磁盘抹除/分区工具' },
  { pattern: /\bshutdown\b/i, reason: '关机命令' },
  { pattern: /\breboot\b/i, reason: '重启命令' },
  { pattern: /\bhalt\b/i, reason: '关机命令' },
  { pattern: /\bpoweroff\b/i, reason: '关机命令' },
  { pattern: /\b(stop-computer|restart-computer)\b/i, reason: 'Windows 关机/重启命令' },
  { pattern: /\bshutdown(?:\.exe)?\b[^\n]*\/(s|r|p)\b/i, reason: 'Windows 关机/重启命令' },
  { pattern: /\binit\s+[0-6]\b/i, reason: '切换运行级别' },
  { pattern: /\bkill\s+-9\s+1\b/i, reason: 'kill init 进程' },
  { pattern: /\bpkill\s+-9\s+-f\s+(bash|init|sshd)/i, reason: '杀死关键系统进程' },
  { pattern: /\bdrop\s+(database|schema|table)\b/i, reason: 'DROP 数据库对象' },
  { pattern: /\btruncate\s+(table|only)\b/i, reason: 'TRUNCATE 清空表' },
  { pattern: /\bdelete\s+from\b.*\bwhere\s+1\s*=\s*1\b/i, reason: '无条件 DELETE' },
  { pattern: /\bdelete\s+from\b(?!\s+\S+\s*;?\s*$)/i, reason: 'DELETE 无 WHERE 子句' },
  { pattern: /\bupdate\s+\S+\s+set\b(?![^;]*\bwhere\b)/i, reason: 'UPDATE 无 WHERE 子句' },
  { pattern: /\bgrant\s+all\b/i, reason: 'GRANT ALL 授权' },
  { pattern: /\brevoke\s+all\b/i, reason: 'REVOKE ALL 撤销授权' },
  { pattern: /\bdocker\s+system\s+prune\s+-a/i, reason: 'docker system prune -a 删除所有未使用资源' },
  { pattern: /\bdocker\s+rm\s+-f\b/i, reason: 'docker rm -f 强制删除容器' },
  { pattern: /\bdocker\s+rmi\s+-f\b/i, reason: 'docker rmi -f 强制删除镜像' },
  { pattern: /\bdocker\s+volume\s+rm\b/i, reason: 'docker volume rm 删除数据卷' },
  { pattern: /\bdocker\s+network\s+rm\b/i, reason: 'docker network rm 删除网络' },
  // Docker 删除类操作死规定:任何形态的删除/清理都必须人工确认(只读清单
  // 之外的 docker 命令本来就会 ask,这里给出明确原因,宁可误拦不误放)。
  { pattern: /\bdocker\s+(rm|rmi)\b/i, reason: 'docker rm/rmi 删除容器/镜像' },
  { pattern: /\bdocker\s+(system|image|container|builder|network|volume)\s+prune\b/i, reason: 'docker prune 清理删除资源' },
  { pattern: /\bdocker\s+(stack|service|config|secret|plugin)\s+rm\b/i, reason: 'docker 删除服务/配置/插件' },
  { pattern: /\bdocker\s+compose\s+(down|rm)\b/i, reason: 'docker compose 删除容器/编排' },
  { pattern: /\bdocker\s+exec\b.*\b(rm|mkfs|dd|shutdown|reboot)\b/i, reason: '容器内执行危险命令' },
  { pattern: /\bkubectl\s+delete\s+(namespace|node)\b/i, reason: 'kubectl 删除 namespace/node' },
  { pattern: /\bchmod\s+(-[a-z]*[r]+|--recursive)\b.*\b7{3,}\b/i, reason: 'chmod 777 公开权限' },
  { pattern: /\bchown\s+-R\b.*\b(root|0)\b/i, reason: 'chown 改属主为 root' },
  // find 带删除/执行参数:find 本身在只读清单里,但 -delete/-exec 会删除文件,
  // 必须人工确认(2026-08-2x SSH 加固:此前 `find /path -delete` 直接放行)。
  { pattern: /\bfind\b[^\n]*(?:-delete|-exec\b|-execdir\b|-ok\b|-okdir\b|'\{\}'\s*\+)/i, reason: 'find -delete/-exec 删除或执行' },
  // ip 网络配置变更/删除(ip link del / addr del / route del / set down / flush)。
  { pattern: /\bip\s+(link|addr|address|route|rule|neigh|neighbour|tunnel|maddr|netns)\s+(add|delete|del|set|change|replace|flush)\b/i, reason: 'ip 网络配置变更/删除' },
  // journalctl --vacuum/--rotate 会删除/滚动系统日志。
  { pattern: /\bjournalctl\b[^\n]*--(vacuum|rotate)/i, reason: 'journalctl 清理/滚动日志' },
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)\b/i, reason: '远程脚本管道执行' },
  { pattern: /\bwget\b.*\|\s*(bash|sh|zsh)\b/i, reason: '远程脚本管道执行' },
  { pattern: /\bcurl\b.*-o\s+\S+\s*&&\s*(chmod|xargs)/i, reason: '下载并执行文件' },
  { pattern: /\biptables\s+-F\b/i, reason: 'iptables 清空规则' },
  { pattern: /\bufw\s+(disable|reset)\b/i, reason: 'UFW 关闭/重置防火墙' },
]

/** 命中第一条风险词的原因;未命中返回 null。 */
function riskReason(command: string): string | null {
  const cmd = command.trim()
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(cmd)) return reason
  }
  return null
}

// ── 只读判定(移植自 commandGuard.ts,宁可误拦不误放) ──

const SQL_WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|use|lock|unlock|rename|set)\b/i
const SQL_READ_START = /^(select|show|desc|describe|explain)\b/i

/**
 * 只读 SQL 判定:去注释后每条语句以 SELECT/SHOW/DESC/EXPLAIN 开头(或纯 CTE)且不含写关键字。
 * @param sql - 待判定的完整 SQL 文本。
 * @returns 全部语句均只读时为 true;空文本为 false。
 */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const statements = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 0)
  if (statements.length === 0) return false
  return statements.every((s) => {
    if (SQL_WRITE_KEYWORDS.test(s)) return false
    if (SQL_READ_START.test(s)) return true
    return /^with\b/i.test(s) && !SQL_WRITE_KEYWORDS.test(s)
  })
}

const READ_ONLY_SHELL_SINGLE = new Set([
  'ls', 'll', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file',
  'find', 'grep', 'egrep', 'fgrep', 'rg', 'ps', 'top', 'htop', 'uptime', 'free',
  'df', 'du', 'mount', 'lsblk', 'lsof', 'uname', 'hostname', 'date', 'whoami',
  'id', 'w', 'who', 'last', 'env', 'printenv', 'which', 'whereis', 'type',
  'echo', 'printf', 'ip', 'ifconfig', 'netstat', 'ss', 'ping', 'traceroute',
  'dig', 'nslookup', 'host', 'journalctl', 'getenforce', 'lsusb', 'lspci',
  'vmstat', 'iostat', 'nproc', 'lsmod', 'dmesg', 'lsattr', 'getfacl', 'tree',
])
const READ_ONLY_SHELL_PAIRS = new Set([
  'docker ps', 'docker images', 'docker logs', 'docker inspect', 'docker stats',
  'docker top', 'docker version', 'docker info', 'docker port',
  'kubectl get', 'kubectl describe', 'kubectl logs', 'kubectl version',
  'kubectl api-resources', 'systemctl status', 'systemctl list-units',
  'systemctl list-timers', 'systemctl show', 'service --status-all',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'redis-cli get', 'redis-cli mget', 'redis-cli keys', 'redis-cli scan',
  'redis-cli ttl', 'redis-cli type', 'redis-cli exists', 'redis-cli info',
  'redis-cli hget', 'redis-cli hgetall', 'redis-cli lrange', 'redis-cli smembers',
  'redis-cli zrange', 'redis-cli dbsize', 'redis-cli ping',
])

/**
 * 只读 Shell 判定:按 && / || / | / ; 切段,每段无重定向/命令替换/提权且首词在只读清单。
 * @param command - 待判定的完整 shell 命令文本。
 * @returns 所有切段均为只读清单内命令时为 true;空文本为 false。
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||[|;]/).map(s => s.trim()).filter(s => s.length > 0)
  if (segments.length === 0) return false
  return segments.every((seg) => {
    if (/[>`]|\$\(|`/.test(seg)) return false
    const parts = seg.split(/\s+/)
    const first = parts[0]?.toLowerCase()
    if (!first || first === 'sudo' || first === 'su') return false
    if (READ_ONLY_SHELL_SINGLE.has(first)) return true
    const second = parts[1]?.toLowerCase()
    if (second !== undefined && READ_ONLY_SHELL_PAIRS.has(`${first} ${second}`)) return true
    return false
  })
}

// ── 工具确认分级 ──

/** 门的结论:放行,或带原因升级 ask。 */
interface GateVerdict {
  readonly ask: boolean
  readonly reason?: string
  /**
   * 删除/高危档(死规定):即使会话审批策略为 never(全访问不弹审批),
   * 本类调用也必须弹确认卡,绝不静默放行。仅风险词命中(rm/dd/mkfs/
   * find -delete/docker 删除/DROP/TRUNCATE/Redis DEL 等)置位。
   */
  readonly hard?: boolean
}

const ALLOW: GateVerdict = { ask: false }

/** 无论参数如何都必须人工确认的工具(写操作/外部效应)。 */
const ALWAYS_ASK_TOOLS: ReadonlySet<string> = new Set([
  'sftp_upload',
  'sftp_download',
  'es_index_document',
  'es_delete_document',
  'es_delete_index',
  'memory',
  'skill_save',
  'mcp_call',
])

/** 即使 never 策略也必须确认的 ALWAYS_ASK 工具(删除类)。 */
const ALWAYS_ASK_HARD_TOOLS: ReadonlySet<string> = new Set([
  'es_delete_document',
  'es_delete_index',
])

/** Redis 只读命令首词。 */
const REDIS_READONLY = new Set([
  'get', 'mget', 'keys', 'scan', 'ttl', 'type', 'exists', 'info',
  'hget', 'hgetall', 'hmget', 'hlen', 'lrange', 'llen', 'smembers', 'scard',
  'zrange', 'zrangebyscore', 'zcard', 'dbsize', 'ping', 'strlen', 'getrange',
  'sismember', 'zscore', 'zrank', 'object', 'memory', 'xinfo', 'xlen', 'xrange',
])

/** Redis 删除/高危命令首词(哪怕 never 策略也必须确认)。 */
const REDIS_DESTRUCTIVE = new Set([
  'del', 'unlink', 'flushdb', 'flushall', 'flush', 'reset',
])

/**
 * starhub_* 工具调用的确认分级:只读放行;写操作/风险命令/不确定形态 ask。
 * 风险命令(删除/覆写/停机等)标 hard:死规定,即使会话策略为 never
 * (全访问不弹审批)也仍须人工确认。
 * 非 starhub 工具返回 null(门不介入)。
 * @param toolName - 工具名。
 * @param args - 模型参数(pre-execute 阶段为未校验 JSON)。
 * @returns 门结论;null 表示非本域工具。
 */
export function classifyStarHubCall(toolName: string, args: unknown): GateVerdict | null {
  if (!toolName.startsWith('starhub_') && !STARHUB_DOMAIN_TOOLS.has(toolName)) return null
  if (ALWAYS_ASK_TOOLS.has(toolName)) {
    return {
      ask: true,
      reason: `${toolName} 是写操作,必须人工确认`,
      ...(ALWAYS_ASK_HARD_TOOLS.has(toolName) ? { hard: true } : {}),
    }
  }
  const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  switch (toolName) {
    case 'ssh_exec':
    case 'ssh_exec_background':
    case 'docker_exec': {
      const command = typeof record.command === 'string' ? record.command : ''
      if (command === '') return { ask: true, reason: '缺少命令文本,无法判定安全性' }
      const risk = riskReason(command)
      if (risk !== null) return { ask: true, reason: `风险命令:${risk}`, hard: true }
      if (isReadOnlyShellCommand(command)) return ALLOW
      return { ask: true, reason: '非只读命令,需要确认' }
    }
    case 'db_query': {
      const sql = typeof record.sql === 'string' ? record.sql : ''
      if (sql === '') return { ask: true, reason: '缺少 SQL,无法判定安全性' }
      const risk = riskReason(sql)
      if (risk !== null) return { ask: true, reason: `风险 SQL:${risk}`, hard: true }
      if (isReadOnlySql(sql)) return ALLOW
      return { ask: true, reason: '写 SQL,需要确认' }
    }
    case 'redis_exec': {
      const command = typeof record.command === 'string' ? record.command.trim() : ''
      const first = command.split(/\s+/)[0]?.toLowerCase() ?? ''
      if (first !== '' && REDIS_READONLY.has(first)) return ALLOW
      const destructive = first !== '' && REDIS_DESTRUCTIVE.has(first)
      return destructive
        ? { ask: true, reason: '删除 Redis 数据,必须人工确认', hard: true }
        : { ask: true, reason: '写 Redis 命令,需要确认' }
    }
    default:
      // 只读域工具(列表/查询/搜索/上传下载以外的 sftp、excel 工作簿操作等)放行。
      return ALLOW
  }
}

/** starhub 域工具名全集(不含 starhub_ 前缀的注册名)。 */
const STARHUB_DOMAIN_TOOLS: ReadonlySet<string> = new Set([
  'ssh_exec', 'ssh_exec_background', 'ssh_wait_task',
  'sftp_list', 'sftp_stat', 'sftp_upload', 'sftp_download',
  'db_query', 'redis_exec',
  'es_list_indices', 'es_cluster_health', 'es_get_mapping', 'es_search',
  'es_get_document', 'es_count',
  'docker_list_containers', 'docker_logs', 'docker_inspect', 'docker_exec',
  'mcp_list',
])

/** 会话的有效审批策略:会话覆盖优先,缺省组合配置(ask)。 */
function sessionPolicy(ctx: Context, session: Session): ApprovalPolicy {
  return effectiveApprovalPolicy(session.events) ?? ctx.approval.config.policy ?? 'ask'
}

/** 审批桥插件配置(默认值语义见 {@link apply})。 */
export interface ApprovalBridgeConfig {
  /** 是否挂载 approval 应答桥;false 时只留权限固定与风险门。 */
  readonly answerer?: boolean
  /** 是否由本桥注册 `permission` 设置命名空间。 */
  readonly ownsPermissionSettings?: boolean
}

/**
 * 注册审批桥:权限固定 + 风险门 + 应答桥。
 * `answerer: false` 时只保留权限固定与风险门(应答交给组合内其它 answerer,
 * 如 dsh web 的浏览器确认框;starhub-web 组合用),避免同一请求双应答。
 * @param ctx - plugin context;监听器随插件 fiber 卸载。
 */
export function apply(ctx: Context, config: ApprovalBridgeConfig = {}): void {
  const answerer = config.answerer !== false
  const ownsPermissionSettings = config.ownsPermissionSettings !== false
  const transport = ctx.get('sdk-transport') as JsonRpcTransportPeer | undefined
  if (!transport) {
    throw new Error('starhub-approval-bridge requires sdk-jsonrpc-server (sdk-transport service) in the same composition')
  }

  // 1. 会话权限固定:读取共享 settings.yaml 的 permission.defaultPreset。
  //    只填空缺:permission-presets 已在会话创建时按 preset 整体钉入
  //    sandbox + approval,这里再无条件覆写 approval 会与钉入的 preset
  //    冲突(如 workspace-write + never 不匹配任何 preset),把会话权限
  //    派生成不存在的 "custom" 状态。已有 approval 时保持钉入结果。
  //    命名空间归口:ownsPermissionSettings=true(内嵌 AI 内核等没有
  //    permission-presets 的组合)由本桥注册并持有;false(starhub-web,
  //    permission-presets 在组合内)只读消费其解析值,绝不重复注册。
  const readDefaultPreset: () => string | undefined = ownsPermissionSettings
    ? (() => {
      const permissionScope = ctx.settings.register(PERMISSION_NAMESPACE, PermissionSchema)
      return () => permissionScope.get().defaultPreset
    })()
    : () => {
      const value = ctx.settings.get(PERMISSION_NAMESPACE) as { defaultPreset?: unknown } | undefined
      return typeof value?.defaultPreset === 'string' ? value.defaultPreset : undefined
    }
  ctx.on('session/created', (session) => {
    if (effectiveApprovalPolicy(session.events) !== undefined) return
    const preset = readDefaultPreset()
    const policy: ApprovalPolicy = preset === 'danger-full-access' ? 'never' : 'ask'
    setApprovalPolicy(session, policy)
  })

  // 2. starhub_* 工具风险门:never 策略只放行「软确认」档(普通写操作),
  //    删除/高危档(hard)是死规定——即使全访问(never)也仍弹确认卡。
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const agent = exec.agent
    if (agent === undefined) return decision
    const verdict = classifyStarHubCall(exec.name, exec.arguments)
    if (verdict === null || !verdict.ask) return decision
    const policy = sessionPolicy(ctx, agent.session)
    if (policy === 'never' && verdict.hard !== true) return decision
    return verdict.reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason: verdict.reason }
  })

  if (!answerer) return

  // 3. 审批应答桥:桥回宿主确认卡;桥异常一律 fail closed(交回链尾 = unavailable)。
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    try {
      const result: unknown = await transport.request(BRIDGE_METHOD, {
        sessionId: String(req.agent.session.id),
        toolName: req.toolName,
        callId: req.callId === undefined ? undefined : String(req.callId),
        reason: req.reason,
      })
      const outcome = typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>).outcome
        : undefined
      if (outcome === 'allowed-once' || outcome === 'rejected') return outcome
      return 'unavailable'
    } catch {
      // transport 断开/宿主报错:审批通道不可用,fail closed。
      return next()
    }
  })
}
