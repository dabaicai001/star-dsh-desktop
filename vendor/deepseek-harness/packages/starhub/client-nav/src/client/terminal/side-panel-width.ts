/**
 * SSH 侧栏(文件 / AI / 监控)宽度持久化:拖好的宽度写 localStorage,重开侧栏、
 * 重开工作区都沿用上次拖好的值,不再每次重置回默认宽度。夹取区间与 overlay
 * 拖拽把手共用同一组常量,加载与落盘都过一次夹取,防止旧版本/手改的越界值。
 *
 * @module StarHub SSH side panel width persistence (client)
 */

const STORAGE_KEY = 'starhub:ssh:side-panel-width'

/** 未存过宽度时的默认值(px)。 */
export const SIDE_PANEL_DEFAULT_WIDTH = 500

/** 宽度下界(px):再窄放不下文件树 / 监控卡片。 */
export const SIDE_PANEL_MIN_WIDTH = 340

/** 宽度上界(px):再宽把终端压得太窄。 */
export const SIDE_PANEL_MAX_WIDTH = 560

/**
 * 把候选宽度夹进合法区间(非有限值回退默认值)。
 * @param value - 候选宽度(px)。
 * @returns 夹取并取整后的宽度(px)。
 */
export function clampSidePanelWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDE_PANEL_DEFAULT_WIDTH
  return Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, Math.round(value)))
}

/**
 * 从 localStorage 读取记忆的侧栏宽度。
 * @returns 存储值(夹取后);缺失、畸形或非数字时返回默认宽度。
 */
export function loadSidePanelWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return SIDE_PANEL_DEFAULT_WIDTH
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'number') return SIDE_PANEL_DEFAULT_WIDTH
    return clampSidePanelWidth(parsed)
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH
  }
}

/**
 * 把侧栏宽度写入 localStorage(夹取后存)。
 * @param width - 当前侧栏宽度(px)。
 */
export function saveSidePanelWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clampSidePanelWidth(width)))
  } catch {
    // 隐私模式 / 存储被禁:宽度仅本次会话有效,不影响拖拽本身。
  }
}
