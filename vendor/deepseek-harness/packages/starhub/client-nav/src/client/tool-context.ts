/**
 * 工具上下文 settings 通道(方案 4.3 / 契约 §6):client-nav 侧把「当前
 * StarHub 工具 + 资产」写入 `starhub-tool-context` settings namespace,host
 * 侧 tool-context 插件在 `agent/pre-step` 读取并注入 agent 请求。`@` 资产
 * source pick 的轻绑定与面板「问 AI」的资产上下文共用这一通道。
 */

/** Settings namespace holding the current StarHub tool selection. */
export const TOOL_CONTEXT_NAMESPACE = 'starhub-tool-context'

/**
 * settings 写入的最小面。0.1.6 起 apiproxy 的 IApiClient 撤除,类型化 RPC
 * 改走 `ctx.remote`(api-gateway 的 ClientRemote);本包只需要
 * `settings.update(ns, patch, revision)` 这一笔,故收窄成自己的小接口,
 * 调用点传 `ctx.remote.settings`。
 */
export interface SettingsUpdateWriter {
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<unknown>
}

/** 选择桥快照里参与上下文补丁的两个字段(其余字段由工作区列单独维护)。 */
export interface ToolContextSelection {
  subcategory: string | null
  routePrefix: string | null
}

/** 绑定资产的类型元数据(key 命名与资产 config 一致)。 */
export interface ToolContextAssetMeta {
  /** 资产大类 id / name(如 db / ssh / docker / local)。 */
  assetType: string
  /** 数据库子类型(redis / mysql / clickhouse / …);非 DB 资产为空。 */
  dbType?: string
}

/**
 * 轻绑定一个资产到工具上下文:写全量五字段补丁(空选择字段写空串,与
 * 工作区列的同步语义一致),失败静默——上下文是尽力而为的提示,不打断
 * 输入、不切窗口。
 *
 * sessionId 记录触发本次绑定的会话:host 侧 tool-context 插件在 pre-step
 * 只对「agent.session.id === sessionId」的会话注入,避免全局粘性让每条普通
 * 对话都带上 starhub-tool-context。
 * @param writer - settings 写入面(`ctx.remote.settings`)。
 * @param selection - 当前选择桥快照(subcategory / routePrefix)。
 * @param asset - 目标资产(id + 显示名)。
 * @param sessionId - 触发绑定的会话 id(会话级作用域)。
 */
export function bindAssetContext(
  writer: SettingsUpdateWriter,
  selection: ToolContextSelection,
  asset: { id: string; name: string; type?: string; config?: Record<string, unknown> },
  sessionId: string,
): void {
  const config = asset.config ?? {}
  const meta: ToolContextAssetMeta = {
    assetType: asset.type ?? '',
    ...(typeof config.dbType === 'string' && config.dbType !== ''
      ? { dbType: config.dbType }
      : {}),
  }
  void writer.update(TOOL_CONTEXT_NAMESPACE, {
    sessionId,
    subcategory: selection.subcategory ?? '',
    assetId: asset.id,
    assetName: asset.name,
    routePrefix: selection.routePrefix ?? '',
    assetType: meta.assetType,
    ...(meta.dbType !== undefined ? { dbType: meta.dbType } : {}),
  }, undefined).catch(() => {})
}
