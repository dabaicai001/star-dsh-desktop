import type { Asset } from '@/types/asset'
import type { AiAssetType } from '@/stores/ai'

/**
 * @ / # mention 共用解析逻辑(AiView 独立工作区与 AiChat 内嵌助手共用)。
 * 纯函数、无运行时依赖:node --test 单测直接 transpile 加载,请勿引入运行时 import。
 */

export type MentionTrigger = '@' | '#'

export interface MentionMatch {
  /** 匹配起始下标(含前导空白) */
  index: number
  /** 触发符前导字符('' 或空白),选择建议后原样保留 */
  leading: string
  /** 触发符:@ 选 Agent,# 绑定目标 */
  trigger: MentionTrigger
  /** 已输入的过滤词(不含触发符) */
  query: string
}

/** 输入末尾的 mention 触发匹配:「我问 @ag」→ @ 触发,query=ag;句中非行首/非空白后的 @# 不触发 */
export function matchMention(text: string): MentionMatch | null {
  const match = text.match(/(^|\s)([@#])([^\s@#]*)$/)
  if (!match || match.index === undefined) return null
  return {
    index: match.index,
    leading: match[1],
    trigger: match[2] as MentionTrigger,
    query: match[3]
  }
}

/** Agent 的 @ 句柄:名称去空白转短横线(与建议插入文本一致) */
export function agentHandle(agent: { name: string }): string {
  return agent.name.trim().replace(/\s+/g, '-')
}

/** 文本中 @ 提及的 Agent 句柄(小写去重) */
export function extractMentionedHandles(text: string): string[] {
  const handles = Array.from(text.matchAll(/@([^\s@#]+)/g), match => match[1].toLowerCase())
  return Array.from(new Set(handles))
}

/** 按 @ 提及过滤 Agent 列表(保持原顺序) */
export function filterMentionedAgents<T extends { name: string }>(agents: T[], text: string): T[] {
  const unique = new Set(extractMentionedHandles(text))
  return agents.filter(agent => unique.has(agentHandle(agent).toLowerCase()))
}

/** 文本中的 # 引用 token(带 # 前缀,小写去重) */
export function extractHashTokens(text: string): string[] {
  const tokens = Array.from(text.matchAll(/#([^\s@#]+)/g), match => `#${match[1]}`.toLowerCase())
  return Array.from(new Set(tokens))
}

/** 文本中的 # 模块作用域(#SSH/#DB/#Docker/#LOCAL/#本机,大小写不敏感) */
export function extractMentionScopes(text: string): AiAssetType[] {
  const matches = Array.from(text.matchAll(/#(ssh|db|docker|local|本机)(?=\s|$)/gi), match => {
    const scope = match[1].toLowerCase()
    return scope === '本机' ? 'local' : scope
  })
  return Array.from(new Set(matches)) as AiAssetType[]
}

/** 资产类型 → # 模块前缀(SSH/DB/Docker/LOCAL) */
export function workspacePrefix(type: AiAssetType | string): string {
  if (type === 'ssh') return 'SSH'
  if (type === 'db') return 'DB'
  if (type === 'docker') return 'Docker'
  return 'LOCAL'
}

/** 资产名 → token 安全形式:空白与 @# 折叠为单个短横线 */
export function tokenSafeName(value: string): string {
  return value.trim().replace(/[\s@#]+/g, '-').replace(/-+/g, '-')
}

/** 资产 mention token,如 #SSH-测试服务器 */
export function assetMentionToken(type: AiAssetType | string, name: string): string {
  return `#${workspacePrefix(type)}-${tokenSafeName(name)}`
}

/** 资产连接摘要(类型/名称之外的第三列,供建议列表与 system prompt 使用) */
export function assetSummary(asset: Asset): string {
  if (asset.type === 'ssh') return `${asset.config.host || '-'}:${asset.config.port || 22}`
  if (asset.type === 'db') return `${asset.config.dbType || 'mysql'} · ${asset.config.address || asset.config.host || '-'}`
  if (asset.type === 'docker') return asset.config.dockerTransport || asset.config.remoteHost || 'local'
  if (asset.type === 'local') return asset.config.rootPath || asset.name || '-'
  return asset.config.format || 'xlsx'
}

/** 按 # token 过滤资产(与 assetMentionToken 同一规则,大小写不敏感) */
export function filterMentionedAssets(assets: Asset[], text: string): Asset[] {
  const tokens = new Set(extractHashTokens(text))
  return assets.filter(asset => tokens.has(assetMentionToken(asset.type, asset.name).toLowerCase()))
}
