/**
 * StarHub session registry(联动契约 §2.1/§5,StarHub 本地包,不在上游)。
 * 订阅入站 notification `starhub/registry.sync`(Rust 主进程在注册表每次变更
 * 时推送全量快照:`{ sessions: [{ assetId, sessionId, kind, attachedBy }] }`),
 * 维护 assetId → 活跃 session 的视图;每次快照整体替换,初始为空。
 *
 * 服务名 `starhub-session-registry`(`list()` / `forAsset(assetId)`),经
 * sdk-jsonrpc-server 本地补丁暴露的 `sdk-notifications` 服务订阅;组合中缺失
 * 该服务时加载即失败(fail loud)。
 *
 * @module @deepseek-ai/dsh-starhub-session-registry
 */

import type { Context } from '@deepseek-ai/cordis'
// StarHub 本地补丁模块(sdk/server/src/notifications.ts,不在上游导出面):
// 经该包 ./src/* 透出直接导入,避免依赖上游 index 的 re-export。
import type { SdkNotificationHub } from '@deepseek-ai/dsh-sdk-jsonrpc-server/src/notifications.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-session-registry'

/** Declared dependency: the sdk-notifications hub must be ACTIVE before this plugin applies. */
export const inject = ['sdk-notifications']

/** 桥通知方法名;Rust 侧实现见 src-tauri/src/harness/mod.rs。 */
const REGISTRY_SYNC_METHOD = 'starhub/registry.sync'

/** session 种类(契约 §2.1)。 */
export type StarHubSessionKind = 'ssh' | 'sftp' | 'db'

/** 注册表快照里的一条活跃 session(契约 §2.1)。 */
export interface StarHubSessionRecord {
  /** 资产 id,注册表主键。 */
  readonly assetId: string
  /** 后端 session id(Rust/Go 侧唯一实体)。 */
  readonly sessionId: string
  /** session 种类。 */
  readonly kind: StarHubSessionKind
  /** 当前附着的窗口/角色名列表。 */
  readonly attachedBy: string[]
}

/** `starhub/registry.sync` 的 params 形状(全量快照)。 */
export interface RegistrySyncParams {
  readonly sessions: StarHubSessionRecord[]
}

/**
 * 校验一条入站 session 记录(线边界:入站 notification 不可信)。
 * @param value - 快照数组里的一个元素。
 * @returns 规范化的记录;形状不合规返回 undefined(跳过该条,不破坏整帧)。
 */
function parseSessionRecord(value: unknown): StarHubSessionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.assetId !== 'string' || record.assetId === '') return undefined
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined
  if (record.kind !== 'ssh' && record.kind !== 'sftp' && record.kind !== 'db') return undefined
  const attachedBy = record.attachedBy
  if (!Array.isArray(attachedBy) || !attachedBy.every(entry => typeof entry === 'string')) return undefined
  return {
    assetId: record.assetId,
    sessionId: record.sessionId,
    kind: record.kind,
    attachedBy: [...attachedBy],
  }
}

/**
 * assetId → 活跃 session 视图。快照整体替换;初始为空。
 */
export class SessionRegistry {
  private readonly byAsset = new Map<string, StarHubSessionRecord>()

  /**
   * 用一帧全量快照替换整个视图;快照里没有的资产被剔除。
   * @param params - 入站 notification 的 params;不是 `{ sessions: [...] }`
   * 形状时整帧忽略(保持现状),条目级不合规者跳过。
   */
  replace(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const sessions = (params as Record<string, unknown>).sessions
    if (!Array.isArray(sessions)) return
    const next = new Map<string, StarHubSessionRecord>()
    for (const entry of sessions) {
      const record = parseSessionRecord(entry)
      if (record !== undefined) next.set(record.assetId, record)
    }
    this.byAsset.clear()
    for (const [assetId, record] of next) this.byAsset.set(assetId, record)
  }

  /**
   * 当前全部活跃 session。
   * @returns 快照里出现的顺序,数组为副本。
   */
  list(): StarHubSessionRecord[] {
    return [...this.byAsset.values()]
  }

  /**
   * 指定资产的活跃 session。
   * @param assetId - 资产 id。
   * @returns 该资产的记录,未注册返回 undefined。
   */
  forAsset(assetId: string): StarHubSessionRecord | undefined {
    return this.byAsset.get(assetId)
  }
}

/**
 * 注册插件:订阅 `starhub/registry.sync` 并提供 `starhub-session-registry` 服务。
 * @param ctx - plugin context;订阅与服务随 fiber 卸载。
 * @throws 当同组合缺少 sdk-notifications 服务时(在 effect 阶段,组合
 * apply 完成后读取,避免 apply 拓扑下 sdk-jsonrpc-server 尚未 provide)。
 */
export function apply(ctx: Context): void {
  const registry = new SessionRegistry()
  ctx.provide('starhub-session-registry', registry)
  ctx.effect(() => {
    // sdk-notifications 是宿主私有服务名,不走 Context 接口声明合并,读取后窄化。
    // 必须在这里(effect)读取:apply 阶段的 ctx.get 受 loader 拓扑影响,
    // sdk-jsonrpc-server 可能尚未 provide,会误报「组合缺少该服务」。
    const notifications = ctx.get('sdk-notifications') as SdkNotificationHub | undefined
    if (!notifications) {
      throw new Error('starhub-session-registry requires sdk-jsonrpc-server (sdk-notifications service) in the same composition')
    }
    const dispose = notifications.subscribe(REGISTRY_SYNC_METHOD, (params) => { registry.replace(params) })
    return () => { dispose() }
  }, 'starhub-session-registry: registry.sync subscription')
}
