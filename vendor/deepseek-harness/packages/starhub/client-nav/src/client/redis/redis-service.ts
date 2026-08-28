/**
 * StarHub 原生 Redis 服务的命令封装与类型(批次 2:Redis 工作台 React 化)。
 *
 * 与 src/services/db.ts 的 redis* 封装同契约;入参统一 `{ connId, ... }`,
 * 命令名 `db_redis_*`(capabilities 已授权,见 permissions/commands.toml)。
 * 浏览器预览(无 Tauri IPC)时由顶层 tauriInvoke reject,组件据此展示预览提示。
 *
 * @module Redis service (client)
 */
import { tauriInvoke } from '../tauri.ts'

/** Redis 连接参数(与 src/services/db.ts 的 RedisConnectParams 同契约)。 */
export interface RedisConnectParams {
  host: string
  port: number
  password?: string
  /** 初始 DB 编号(0-15)。 */
  db?: number
  /** 是否 SSL/TLS。 */
  ssl?: boolean
}

/** 连接建立返回(db_redis_connect)。 */
export interface RedisConnectionInfo {
  connId: string
  host: string
  port: number
}

/** SCAN 返回的单条 key 元信息。 */
export interface RedisKeyInfo {
  key: string
  type: string
  ttl: number
  size?: number
}

/** db_redis_scan / scan_all 的返回。 */
export interface RedisScanResult {
  keys: RedisKeyInfo[]
  cursor: number
  total?: number
}

/** db_redis_get_value 的返回;`value` 按 key 类型承载结构化数据。 */
export interface RedisValueResult {
  key: string
  type: string
  value: unknown
  ttl: number
  size?: number
}

/** db_redis_execute 的返回(CLI / 结构类型字段写回)。 */
export interface RedisCommandResult {
  result: unknown
  durationMs: number
  error?: string
}

/** db_redis_del 的返回。 */
export interface RedisDeleteResult {
  deleted: number
}

/** db_redis_db_size 的返回。 */
export interface RedisDbSize {
  size: number
}

/** 连续 SCAN 的累计结果:keys 为去重后累计,cursor 为最后返回的下一游标。 */
export interface RedisScanAccumulated {
  keys: RedisKeyInfo[]
  cursor: number
  /** 游标是否已归零(全量遍历完成)。 */
  complete: boolean
}

/** 单页 SCAN 的最小形态(redisScan 本体;抽成入参便于纯函数单测注入)。 */
export type RedisScanPage = (cursor: number, match?: string, count?: number) => Promise<RedisScanResult>

/**
 * 从 startCursor 起连续 SCAN,直到游标归零、累计 key 达 batchLimit 或页数达
 * maxPages;existing 中已有的 key 去重保留(续传时 SCAN 重复项不累积)。
 * @param scan - 单页 SCAN 实现。
 * @param startCursor - 起始游标(0 = 从头遍历)。
 * @param match - 可选 MATCH 模式。
 * @param existing - 已累计的 key(续传基底)。
 * @param batchLimit - 累计 key 总量上限(达到即停在 batch 末尾,由调用方决定续传)。
 * @param pageHint - 每页 COUNT 提示值(服务端默认 100,调大减少往返)。
 * @param maxPages - 单次连续 SCAN 页数安全上限(防游标不归零的病态循环)。
 * @returns 累计结果(keys + 下一游标 + 是否遍历完成)。
 */
export async function redisScanAccumulate(
  scan: RedisScanPage,
  startCursor: number,
  match: string | undefined,
  existing: readonly RedisKeyInfo[],
  batchLimit: number,
  pageHint = 500,
  maxPages = 400,
): Promise<RedisScanAccumulated> {
  const seen = new Set(existing.map(info => info.key))
  const keys = [...existing]
  let cursor = startCursor
  let pages = 0
  do {
    const page = await scan(cursor, match, pageHint)
    cursor = page.cursor
    for (const info of page.keys) {
      if (seen.has(info.key)) continue
      seen.add(info.key)
      keys.push(info)
    }
    pages += 1
  } while (cursor !== 0 && keys.length < batchLimit && pages < maxPages)
  return { keys, cursor, complete: cursor === 0 }
}

/** 连接 Redis。
 * @param params - 连接参数。
 * @returns 连接建立后的连接信息。
 */
export function redisConnect(params: RedisConnectParams): Promise<RedisConnectionInfo> {
  return tauriInvoke('db_redis_connect', { params })
}

/** 断开 Redis 会话。
 * @param connId - 连接 id。
 */
export function redisDisconnect(connId: string): Promise<void> {
  return tauriInvoke('db_redis_disconnect', { connId })
}

/** 切换到指定 DB 编号。
 * @param connId - 连接 id。
 * @param db - 目标 DB 编号(0-15)。
 */
export function redisSelect(connId: string, db: number): Promise<void> {
  return tauriInvoke('db_redis_select', { connId, db })
}

/** 当前 DB 键总数。
 * @param connId - 连接 id。
 * @returns 当前 DB 的键总数。
 */
export function redisDBSize(connId: string): Promise<RedisDbSize> {
  return tauriInvoke('db_redis_db_size', { connId })
}

/** SCAN 增量遍历(游标分页 + MATCH 过滤)。
 * @param connId - 连接 id。
 * @param cursor - 游标,缺省从 0 开始。
 * @param match - 可选的 MATCH 过滤模式。
 * @param count - 可选的单批返回条数。
 * @returns SCAN 结果(keys + 下一游标)。
 */
export function redisScan(connId: string, cursor?: number, match?: string, count?: number): Promise<RedisScanResult> {
  return tauriInvoke('db_redis_scan', { connId, cursor: cursor || 0, matchPattern: match, count })
}

/** 取一个 key 的值(按类型返回结构化数据)。
 * @param connId - 连接 id。
 * @param key - 目标 key。
 * @returns key 的值(结构化)。
 */
export function redisGetValue(connId: string, key: string): Promise<RedisValueResult> {
  return tauriInvoke('db_redis_get_value', { connId, key })
}

/** 删除一个或多个 key。
 * @param connId - 连接 id。
 * @param keys - 要删除的 key 列表。
 * @returns 删除结果(删除数量)。
 */
export function redisDel(connId: string, keys: string[]): Promise<RedisDeleteResult> {
  return tauriInvoke('db_redis_del', { connId, keys })
}

/** 重命名 key。
 * @param connId - 连接 id。
 * @param oldKey - 原 key 名。
 * @param newKey - 新 key 名。
 */
export function redisRename(connId: string, oldKey: string, newKey: string): Promise<void> {
  return tauriInvoke('db_redis_rename', { connId, oldKey, newKey })
}

/** 写字符串 key(可带 TTL 秒;缺省持久化)。
 * @param connId - 连接 id。
 * @param key - 目标 key。
 * @param value - 要写入的字符串值。
 * @param expiration - 可选的 TTL 秒数。
 */
export function redisSet(connId: string, key: string, value: string, expiration?: number): Promise<void> {
  return tauriInvoke('db_redis_set', { connId, key, value, expiration })
}

/** 执行任意 Redis 命令(CLI / 结构类型字段写回)。
 * @param connId - 连接 id。
 * @param command - 要执行的命令文本。
 * @returns 命令执行结果。
 */
export function redisExecute(connId: string, command: string): Promise<RedisCommandResult> {
  return tauriInvoke('db_redis_execute', { connId, command })
}

/** 清空当前 DB。
 * @param connId - 连接 id。
 */
export function redisFlushDB(connId: string): Promise<void> {
  return tauriInvoke('db_redis_flush_db', { connId })
}

/** 取 INFO(可限定 section)。
 * @param connId - 连接 id。
 * @param section - 可选的 INFO section 名。
 * @returns INFO 原始文本。
 */
export function redisInfo(connId: string, section?: string): Promise<string> {
  return tauriInvoke('db_redis_info', { connId, section })
}

/**
 * 给 Redis 命令参数里的字符串加引号(与 Vue HashEditor.redisQuote 同契约:
 * 纯 [a-zA-Z0-9._\-:@]+ 直接原样,否则 JSON 风格转义后包双引号)。
 * @param s - 待引用的字符串(key 或 field 等)。
 * @returns 安全内联进命令的片段。
 */
export function redisQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-:@]+$/.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
