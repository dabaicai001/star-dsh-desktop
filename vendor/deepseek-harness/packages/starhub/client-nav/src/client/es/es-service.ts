/**
 * Elasticsearch command layer for the React ES workbench. Each function wraps
 * one Tauri `db_es_*` / `es_*` command with the exact arg shape the Rust
 * command expects (mirrors the Vue src/services/db.ts ES section).
 * @module StarHub ES service (client)
 */
import { tauriInvoke } from '../tauri.ts'

/** ES connect params. */
export interface EsConnectParams {
  address?: string
  host: string
  port: number
  username?: string
  password?: string
  useSSL?: boolean
}

/** ES connect result. */
export interface EsConnectResult {
  connId: string
  host: string
  port: number
  clusterName: string
  version: string
}

/** Cluster health info. */
export interface ClusterHealthInfo {
  clusterName: string
  status: 'green' | 'yellow' | 'red'
  numberOfNodes: number
  numberOfDataNodes: number
  activePrimaryShards: number
  activeShards: number
  activeShardsPercent: number
}

/** A single index row. */
export interface EsIndexInfo {
  name: string
  docsCount: number
  storeSize: string
  health: string
  status: string
  primaryShards: number
  replicaShards: number
}

/** A mapping field (optionally with children). */
export interface EsFieldInfo {
  name: string
  type: string
  children?: EsFieldInfo[]
}

/** Index mapping: index name + flattened top-level fields. */
export interface IndexMappingInfo {
  indexName: string
  fields: EsFieldInfo[]
}

/** One search hit. */
export interface EsSearchHit {
  index: string
  id: string
  score: number | null
  source: Record<string, unknown>
}

/** Search result envelope. */
export interface EsSearchResult {
  took: number
  timedOut: boolean
  totalHits: number
  maxScore: number | null
  hits: EsSearchHit[]
  aggregations: Record<string, unknown>
}

/** Acknowledged write result. */
export interface EsAcknowledgedResult {
  acknowledged: boolean
}

/** Connect and return a conn id.
 * @param params - the connection parameters.
 * @returns the new connection id.
 */
export async function esConnect(params: EsConnectParams): Promise<EsConnectResult> {
  return tauriInvoke('db_es_connect', { params })
}

/** Disconnect a conn id.
 * @param connId - the connection id to close.
 */
export async function esDisconnect(connId: string): Promise<void> {
  return tauriInvoke('db_es_disconnect', { connId })
}

/** Cluster health.
 * @param connId - the connection id.
 * @returns the cluster health info.
 */
export async function esClusterHealth(connId: string): Promise<ClusterHealthInfo> {
  return tauriInvoke('db_es_cluster_health', { connId })
}

/** List indices.
 * @param connId - the connection id.
 * @returns the index list.
 */
export async function esListIndices(connId: string): Promise<EsIndexInfo[]> {
  return tauriInvoke('db_es_list_indices', { connId })
}

/** Get an index mapping.
 * @param connId - the connection id.
 * @param index - the index name.
 * @returns the index mapping.
 */
export async function esGetMapping(connId: string, index: string): Promise<IndexMappingInfo> {
  return tauriInvoke('db_es_get_index_mapping', { connId, index })
}

/** Get an index settings object.
 * @param connId - the connection id.
 * @param index - the index name.
 * @returns the index settings object.
 */
export async function esGetSettings(connId: string, index: string): Promise<Record<string, unknown>> {
  return tauriInvoke('db_es_get_index_settings', { connId, index })
}

/** Create an index.
 * @param connId - the connection id.
 * @param index - the index name.
 * @param mappings - optional field mappings.
 * @param settings - optional index settings.
 * @returns an acknowledged result.
 */
export async function esCreateIndex(
  connId: string, index: string,
  mappings?: Record<string, unknown>,
  settings?: Record<string, unknown>,
): Promise<EsAcknowledgedResult> {
  return tauriInvoke('db_es_create_index', { connId, index, mappings, settings })
}

/** Delete an index.
 * @param connId - the connection id.
 * @param index - the index name.
 * @returns an acknowledged result.
 */
export async function esDeleteIndex(connId: string, index: string): Promise<EsAcknowledgedResult> {
  return tauriInvoke('db_es_delete_index', { connId, index })
}

/** Run a DSL search (paged via from/size).
 * @param connId - the connection id.
 * @param index - the index name.
 * @param body - the query DSL body.
 * @param from - the page offset.
 * @param size - the page size.
 * @returns the search result.
 */
export async function esSearch(
  connId: string, index: string, body: Record<string, unknown>,
  from?: number, size?: number,
): Promise<EsSearchResult> {
  return tauriInvoke('db_es_search', { connId, index, body, from, size })
}

/** Count documents matching an optional filter body.
 * @param connId - the connection id.
 * @param index - the index name.
 * @param body - the optional filter body.
 * @returns the document count.
 */
export async function esCount(
  connId: string, index: string, body?: Record<string, unknown>,
): Promise<{ count: number }> {
  return tauriInvoke('db_es_count', { connId, index, body })
}

/** Pure helpers (unit-tested). */

/** Parse a single index "name" → { index, health, status } when NDJSON-shaped.
 * @param raw - the raw row to parse.
 * @returns the parsed index info.
 */
export function indexRowOf(raw: unknown): EsIndexInfo {
  if (typeof raw === 'string') return { name: raw, docsCount: 0, storeSize: '-', health: 'unknown', status: '-', primaryShards: 0, replicaShards: 0 }
  const r = raw as Record<string, unknown> | null
  const name = typeof r?.name === 'string' ? r.name : ''
  const docsCount = typeof r?.docsCount === 'number' ? r.docsCount : 0
  const primaryShards = typeof r?.primaryShards === 'number' ? r.primaryShards : 0
  const replicaShards = typeof r?.replicaShards === 'number' ? r.replicaShards : 0
  return {
    name,
    docsCount,
    storeSize: typeof r?.storeSize === 'string' ? r.storeSize : '-',
    health: typeof r?.health === 'string' ? r.health : 'unknown',
    status: typeof r?.status === 'string' ? r.status : '-',
    primaryShards,
    replicaShards,
  }
}

/** Health badge color: green/yellow/red, fallback muted.
 * @param status - the health status string.
 * @returns the badge color hex.
 */
export function healthColor(status: string): string {
  if (status === 'green') return '#22c55e'
  if (status === 'yellow') return '#eab308'
  if (status === 'red') return '#ef4444'
  return '#8a94a6'
}

/** Field type badge color (mirrors Vue getFieldTypeColor).
 * @param type - the field type string.
 * @returns the badge color hex.
 */
export function fieldTypeColor(type: string): string {
  if (type === 'text') return '#22d3ee'
  if (type === 'keyword') return '#22c55e'
  if (type === 'long' || type === 'integer' || type === 'short' || type === 'byte'
    || type === 'double' || type === 'float') return '#eab308'
  if (type === 'date') return '#a78bfa'
  if (type === 'boolean') return '#8a94a6'
  if (type === 'nested' || type === 'object') return '#f472b6'
  return '#cbd5e1'
}
