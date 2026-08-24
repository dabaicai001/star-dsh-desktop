/**
 * 长期记忆开关的 settings 通道(2026-08-21):client-nav 侧把「启用长期记忆」
 * 写入 `starhub-memory-context` settings namespace,host 侧 memory-context
 * 插件在 `agent/pre-step` 读取——关闭则完全不注入记忆卡。
 * 写入失败静默(旧运行时无该 namespace;开关仍以 localStorage 为准)。
 */
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'

/** Settings namespace holding the memory master switch. */
export const MEMORY_CONTEXT_NAMESPACE = 'starhub-memory-context'

/**
 * 同步「启用长期记忆」开关到 host 侧 namespace(尽力而为,不打断设置交互)。
 * @param api - 连接线的 settings RPC 面。
 * @param enabled - 开关状态。
 */
export function syncMemoryEnabled(api: IApiClient, enabled: boolean): void {
  void api.settings.update({
    ns: MEMORY_CONTEXT_NAMESPACE,
    patch: { enabled },
  }).catch(() => {})
}

/**
 * 同步「自动沉淀记忆」开关到 host 侧 namespace(v0.92.0,2026-08-22):
 * 控制 `@deepseek-ai/dsh-starhub-memory-sink` 是否在 `agent/turn-stopping`
 * 钩子发起 LLM 抽取。namespace 未写过视为关闭(v0.92.0 起默认关,与 host 侧
 * isAutoReviewEnabled / pre-step 门禁的 explicit-true 语义一致)。
 * @param api - 连接线的 settings RPC 面。
 * @param autoReview - 开关状态。
 */
export function syncMemoryAutoReview(api: IApiClient, autoReview: boolean): void {
  void api.settings.update({
    ns: MEMORY_CONTEXT_NAMESPACE,
    patch: { autoReview },
  }).catch(() => {})
}

/**
 * 同步「记忆模型」配置(provider + model)到 host 侧 namespace(v0.94.0,
 * 2026-08-23):模型路由是记忆功能的硬前置——未成对配置时 memory-context 不
 * 注入、memory-sink 不沉淀、memory 工具调用被 tools/pre-execute 锁死。
 * 清空配置(空串)时 host 侧按未配置处理,UI 侧 normalizeAiSettings 会同步
 * 把两个开关强制归零。
 * @param api - 连接线的 settings RPC 面。
 * @param provider - 记忆模型 provider 路由。
 * @param model - 记忆模型 model id。
 */
export function syncMemoryModel(api: IApiClient, provider: string, model: string): void {
  void api.settings.update({
    ns: MEMORY_CONTEXT_NAMESPACE,
    patch: { memoryProvider: provider, memoryModel: model },
  }).catch(() => {})
}
