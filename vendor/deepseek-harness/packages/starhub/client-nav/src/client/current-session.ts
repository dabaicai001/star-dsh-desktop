/**
 * DSH 0.1.7 适配:会话导航(哪个会话是「当前」)归 view owner 持有——
 * `ISessions.list` 快照不再带 `current`,选择事实是「被 mainView source 保留的
 * 会话」(`ui-session` 的 publishMain 同源推导)。本助手给 client-nav 的宿主
 * 事件、执行记录桥与工具面板提供同一读取面。
 *
 * 导航(切当前会话)走 `ctx.uiWorkspace.openSession(target)`,不再有
 * `ISessions.open/clear`。
 *
 * @module @deepseek-ai/dsh-starhub-client-nav/src/client/current-session
 */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only:声明合并 SessionReferenceSourceMap 的 `mainView` 键(读取前提)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * 当前会话 id:list 中第一个被 mainView source 保留的会话;无从推导返回 undefined。
 * @param state - `ISessions.list` 快照。
 * @returns 当前会话 id,或 undefined(无选中会话)。
 */
export function currentSessionId(state: SessionListState): SessionId | undefined {
  return state.ids.find(id => (state.byId[id]?.retainedBy.mainView ?? 0) > 0)
}
