/**
 * Broker (Kafka / NSQ) metadata service — React 壳内版。
 *
 * 逐文件复制自 `src/services/broker.ts`(铁律 5:业务逻辑零重写,仅换调用方):
 * 原实现走 `@tauri-apps/api` 的 invoke,这里改走共享的顶层帧 Tauri 桥
 * (`tauriInvoke`),Rust 侧命令 `broker_test` / `broker_overview` 原样复用。
 */

import { tauriInvoke } from '../tauri.ts'

/** Broker 类型:kafka / nsq。 */
export type BrokerKind = 'kafka' | 'nsq'

/** 连接参数(与 Rust `broker_overview` 的 params 一致)。 */
export interface BrokerConnectParams {
  host: string
  port: number
  username?: string
  password?: string
  ssl?: boolean
}

/** Topic 下的一个 Channel(NSQ)。 */
export interface BrokerChannel {
  name: string
  depth?: number
  backlog?: number
  messages?: number
}

/** 一个 Topic(或 NSQ topic)的元数据行。 */
export interface BrokerResource {
  name: string
  partitions?: number
  channels?: number
  depth?: number
  messages?: number
  leader?: string
  channelList?: BrokerChannel[]
}

/** broker_overview 的返回。 */
export interface BrokerOverview {
  kind: BrokerKind
  status: string
  endpoint: string
  nodeCount: number
  resources: BrokerResource[]
  observedAt: number
}

/** 连接测试结果(与 src/types/db.ts 的 TestResult 一致)。 */
export interface BrokerTestResult {
  ok: boolean
  message: string
  elapsed_ms?: number
}

/**
 * 测试 Broker 连通性。
 * @param kind - Broker 类型(kafka / nsq)。
 * @param params - 连接参数。
 * @returns 连接测试结果(ok / message / elapsed_ms)。
 */
export function testBroker(kind: BrokerKind, params: BrokerConnectParams): Promise<BrokerTestResult> {
  return tauriInvoke('broker_test', { kind, params })
}

/**
 * 拉取 Broker 概览(连接状态 / 节点 / Topic 元数据)。
 * @param kind - Broker 类型(kafka / nsq)。
 * @param params - 连接参数。
 * @returns Broker 概览数据。
 */
export function loadBrokerOverview(
  kind: BrokerKind,
  params: BrokerConnectParams,
): Promise<BrokerOverview> {
  return tauriInvoke('broker_overview', { kind, params })
}
