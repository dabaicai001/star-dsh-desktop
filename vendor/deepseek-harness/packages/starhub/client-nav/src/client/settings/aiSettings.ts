/**
 * AI 设置持久化桥(React 壳内版,settings AI tab 用)。
 *
 * 读写与 Vue 版 `src/stores/ai.ts` 同一份 localStorage(pinia 持久化
 * key `ai-v2`,paths 含 settings):本模块只碰 AI tab 未随 dsh 接管而保留
 * 的记忆与上下文区块,其余字段原样保留。命令白名单已随「统一走
 * deepseek-harness 权限体系」移除,不再读也不再写。
 */

/** localStorage key(与 aiStore 的 persist key 同名,用户数据无缝)。 */
export const AI_STORAGE_KEY = 'ai-v2'

/** AI 设置(只声明 AI tab 保留区块相关字段,其余原样透传)。 */
export interface AiSettings {
  /** 专属记忆模型 provider 路由(与 memoryModel 必须成对非空,记忆功能硬前置)。 */
  memoryProvider: string
  /** 专属记忆模型 model id(与 memoryProvider 必须成对非空)。 */
  memoryModel: string
  /**
   * 长期记忆总开关:同时驱动「预读注入」与「自动沉淀」。v0.96.4 起把原先
   * 「启用长期记忆」与「自动沉淀记忆」两个开关合并为一个,host 侧
   * `starhub-memory-context` namespace 的 enabled 与 autoReview 同值写入。
   */
  memoryEnabled: boolean
}

/** 默认值(v0.96.4 起「启用长期记忆」合并「自动沉淀记忆」为单开关,默认关闭;
 * 用户需在 AI 助手设置面板显式打开后才有记忆预读注入与自动沉淀)。
 * v0.94.0(2026-08-23)起记忆模型是硬前置:默认未配置,记忆功能整体关闭。
 */
function defaultAiSettings(): AiSettings {
  return {
    memoryProvider: '',
    memoryModel: '',
    memoryEnabled: false,
  }
}

/**
 * 记忆功能是否已配置(专属记忆模型 provider + model 均非空)。
 * 未配置时「启用长期记忆」开关被禁用,host 侧注入/沉淀/memory 工具一并关闭。
 * @param settings - 归一化后的设置。
 * @returns 已配置为 true。
 */
export function isMemoryRouteConfigured(settings: AiSettings): boolean {
  return settings.memoryProvider.trim() !== '' && settings.memoryModel.trim() !== ''
}

/**
 * 归一化一次持久化 settings(与 aiStore ensureSettingsShape 的记忆字段逐条对齐)。
 * 上下文预算/迭代步数/压缩阈值等字段由 dsh harness 接管,不再读也不写;
 * 旧版命令白名单字段(commandWhitelist / commandWhitelistVersion)与已退役的
 * 记忆开关(memoryStoreToolOutputs / memoryWriteNeedsConfirm / memoryAutoReview)
 * 一并丢弃。
 * v0.94.0 起:记忆模型未配置时,强行把「启用长期记忆」归零(与「只有配置了
 * 才能勾选」的门禁一致,防旧 localStorage 残留开启态)。
 * @param raw - 从 localStorage 读出的 settings 对象(可能缺字段/类型错)。
 * @returns 归一化后的设置(缺省回落默认值,只含保留字段)。
 */
export function normalizeAiSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const base = defaultAiSettings()
  const next: AiSettings = {
    ...base,
    ...(raw ?? {}),
  }
  // 退役字段随旧版一并丢弃,写回时不再保留(避免读回旧值污染新单开关)。
  const legacy = next as unknown as Record<string, unknown>
  delete legacy.commandWhitelist
  delete legacy.commandWhitelistVersion
  delete legacy.memoryStoreToolOutputs
  delete legacy.memoryWriteNeedsConfirm
  delete legacy.memoryAutoReview
  if (typeof next.memoryProvider !== 'string') next.memoryProvider = ''
  if (typeof next.memoryModel !== 'string') next.memoryModel = ''
  if (typeof next.memoryEnabled !== 'boolean') next.memoryEnabled = false
  // 记忆模块硬前置:路由未配置 → 开关强制关闭(无法通过 UI 勾选,host 也不注入/不沉淀)。
  if (!isMemoryRouteConfigured(next)) {
    next.memoryEnabled = false
  }
  return next
}

/** localStorage 里的 pinia 持久化结构({ settings, agents, conversationSummaries })。 */
interface AiPersistedState {
  settings?: unknown
  agents?: unknown
  conversationSummaries?: unknown
}

/**
 * 读取 AI 设置(从 ai-v2 的 settings 字段)。
 * @returns 归一化后的设置(无持久化数据时返回默认值)。
 */
export function loadAiSettings(): AiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? 'null') as AiPersistedState | null
    return normalizeAiSettings(raw?.settings as Partial<AiSettings> | undefined)
  } catch {
    return defaultAiSettings()
  }
}

/**
 * 写回 AI 设置(只替换 settings 字段,agents/conversationSummaries 原样保留)。
 * @param settings - 归一化后的设置。
 */
export function saveAiSettings(settings: AiSettings): void {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? 'null') as AiPersistedState | null
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({ ...(raw ?? {}), settings }))
  } catch {
    // localStorage 不可用(隐私模式等):静默降级,与 aiStore 持久化失败语义一致
  }
}
