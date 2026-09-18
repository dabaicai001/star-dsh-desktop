/**
 * StarHub 兼容垫片 —— 不是上游包:上游在 0.1.1-rc.2 → 0.1.6-alpha.1 之间删除
 * 了 `dsh-client-runtime`,其导出迁往新家。StarHub 自有 client 包(client-nav、
 * web 壳等)仍按旧面 import;此处从新家再导出,消费方代码零改动。新代码请直接
 * import 新家。
 */
export type { SessionId } from '@deepseek-ai/dsh-session/types'
export type {
  ISessions, SessionFace, SessionListState, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
export type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
export { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
export type {
  AssistantBlock, ConversationNode, PartialAssistant,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
export { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
