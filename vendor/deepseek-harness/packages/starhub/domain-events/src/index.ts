/**
 * StarHub domain events(联动契约 §1/§2.1/§5,StarHub 本地包,不在上游)。
 * 订阅入站 notification `starhub/domain.event`(事件产生即报,schema 见契约 §1:
 * `{ kind, assetId?, ts, summary, data?, origin? }`),按资产维护环形缓冲
 * (每资产最近 50 条;无 assetId 的事件进全局桶),供 pre-step 注入与查询。
 *
 * 服务名 `starhub-domain-events`(`recent(assetId?, limit?)` 按 ts 倒序,
 * 默认 limit 10),经 sdk-jsonrpc-server 本地补丁暴露的 `sdk-notifications`
 * 服务订阅;组合中缺失该服务时加载即失败(fail loud)。
 *
 * 线边界校验(契约 §1):kind/ts/summary 缺失的帧丢弃;assetId 存在但非法
 * 的帧丢弃;origin 省略 = user。
 *
 * @module @deepseek-ai/dsh-starhub-domain-events
 */

import type { Context } from '@deepseek-ai/cordis'
// StarHub 本地补丁模块(sdk/server/src/notifications.ts,不在上游导出面):
// 经该包 ./src/* 透出直接导入,避免依赖上游 index 的 re-export。
import type { SdkNotificationHub } from '@deepseek-ai/dsh-sdk-jsonrpc-server/src/notifications.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-domain-events'

/** Declared dependency: the sdk-notifications hub must be ACTIVE before this plugin applies. */
export const inject = ['sdk-notifications']

/** 桥通知方法名;Rust 侧实现见 src-tauri/src/harness/mod.rs。 */
const DOMAIN_EVENT_METHOD = 'starhub/domain.event'

/** 每资产环形缓冲容量(契约 §5)。 */
const BUCKET_CAPACITY = 50

/** 无资产上下文事件的全局桶键。 */
const GLOBAL_BUCKET: string | undefined = undefined

/** 事件起源(契约 §1;省略 = user)。 */
export type StarHubEventOrigin = 'user' | 'ai'

/** 领域事件(契约 §1)。 */
export interface StarHubDomainEvent {
  /** 事件类型,如 ssh.exec_completed / db.query_executed / sftp.transfer_completed。 */
  readonly kind: string
  /** 资产 id;无资产上下文时省略。 */
  readonly assetId?: string
  /** 秒级 unix 时间戳。 */
  readonly ts: number
  /** 模型可读单行摘要。 */
  readonly summary: string
  /** 领域负载(exitCode / rowCount / bytes / database / table ...)。 */
  readonly data?: unknown
  /** 事件起源;wire 上省略时规范化为 "user"。 */
  readonly origin: StarHubEventOrigin
}

/**
 * 校验一帧入站事件(线边界:入站 notification 不可信)。
 * @param value - 入站 notification 的 params。
 * @returns 规范化的事件;kind/ts/summary 缺失或 assetId 非法返回 undefined。
 */
function parseDomainEvent(value: unknown): StarHubDomainEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.kind !== 'string' || record.kind === '') return undefined
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return undefined
  if (typeof record.summary !== 'string' || record.summary === '') return undefined
  const assetId = record.assetId
  if (assetId !== undefined && (typeof assetId !== 'string' || assetId === '')) return undefined
  return {
    kind: record.kind,
    ...(assetId === undefined ? {} : { assetId }),
    ts: record.ts,
    summary: record.summary,
    ...(record.data === undefined ? {} : { data: record.data }),
    origin: record.origin === 'ai' ? 'ai' : 'user',
  }
}

/**
 * 每资产(及全局)环形缓冲。初始为空;超出容量丢弃最旧事件。
 */
export class DomainEventStore {
  private readonly buckets = new Map<string | undefined, StarHubDomainEvent[]>()

  /**
   * 追加一帧事件;非法帧静默丢弃。
   * @param params - 入站 notification 的 params(契约 §1 schema)。
   */
  push(params: unknown): void {
    const event = parseDomainEvent(params)
    if (event === undefined) return
    const bucketKey = event.assetId ?? GLOBAL_BUCKET
    let bucket = this.buckets.get(bucketKey)
    if (bucket === undefined) {
      bucket = []
      this.buckets.set(bucketKey, bucket)
    }
    bucket.push(event)
    if (bucket.length > BUCKET_CAPACITY) bucket.shift()
  }

  /**
   * 取最近事件,按 ts 倒序。
   * @param assetId - 指定资产;省略时合并全局桶与所有资产桶。
   * @param limit - 返回条数上限,默认 10;非正数返回空数组。
   * @returns 事件数组(副本;同 ts 保持存储顺序)。
   */
  recent(assetId?: string, limit = 10): StarHubDomainEvent[] {
    const safeLimit = Math.max(0, Math.floor(limit))
    const pool = assetId === undefined
      ? [...this.buckets.values()].flat()
      : this.buckets.get(assetId) ?? []
    return pool
      .slice()
      .sort((left, right) => right.ts - left.ts)
      .slice(0, safeLimit)
  }
}

/**
 * 注册插件:订阅 `starhub/domain.event` 并提供 `starhub-domain-events` 服务。
 * @param ctx - plugin context;订阅与服务随 fiber 卸载。
 * @throws 当同组合缺少 sdk-notifications 服务时(在 effect 阶段,组合
 * apply 完成后读取,避免 apply 拓扑下 sdk-jsonrpc-server 尚未 provide)。
 */
export function apply(ctx: Context): void {
  const store = new DomainEventStore()
  ctx.provide('starhub-domain-events', store)
  ctx.effect(() => {
    // sdk-notifications 是宿主私有服务名,不走 Context 接口声明合并,读取后窄化。
    // 必须在这里(effect)读取:apply 阶段的 ctx.get 受 loader 拓扑影响,
    // sdk-jsonrpc-server 可能尚未 provide,会误报「组合缺少该服务」。
    const notifications = ctx.get('sdk-notifications') as SdkNotificationHub | undefined
    if (!notifications) {
      throw new Error('starhub-domain-events requires sdk-jsonrpc-server (sdk-notifications service) in the same composition')
    }
    const dispose = notifications.subscribe(DOMAIN_EVENT_METHOD, (params) => { store.push(params) })
    return () => { dispose() }
  }, 'starhub-domain-events: domain.event subscription')
}
