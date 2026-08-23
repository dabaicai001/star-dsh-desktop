/**
 * StarHub `@` 资产 source(契约 §6.1):在 dsh ui-input-trigger 流水线注册
 * `@` source,候选来自壳内资产快照(get_assets 结果),lexicon 即资产名清单,
 * 资产列表刷新经 subscribeLexicon 通知控制器;pick 返回 ReferenceInsert
 * (codec serialize 产出 `<asset id="…">name (user@host)</asset>`),并轻绑定
 * 资产上下文到 starhub-tool-context settings namespace——不切窗口、不打断
 * (设计文档 M5.1:`@` 是用户的嘴,是否打开窗口由 AI 按消息意图调 focus 工具)。
 */
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type {
  ClientSessionContext, InputTriggerCandidate, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { assetSubtitle, routeNameForAsset } from './sections.ts'
import type { RustAsset, StarHubAssets, ToolSelectionBridge } from './store.ts'
import { bindAssetContext } from './tool-context.ts'

/** source 名(菜单分组与 codec 路由键,契约 §6.1)。 */
export const STARHUB_ASSET_SOURCE = 'starhub-asset'

/** 触发字符(用户语法 `@web-1`,设计文档 M5.1)。 */
const STARHUB_ASSET_TRIGGER = '@'

/** 构造依赖:settings RPC 面 + 资产快照 holder + 选择桥(轻绑定读当前子类)。 */
export interface StarHubAssetSourceDeps {
  api: IApiClient
  assets: StarHubAssets
  selection: ToolSelectionBridge
}

/**
 * 序列化一个资产引用为模型可见形式(设计 M5.1 / 契约 §6.1,2026-08-18 改):
 * 纯文本 `@name (user@host)`——用户要求对话框中不显示 `<asset id=…>` 标记。
 * 资产 id 绑定不依赖该文本:pick 时已轻绑定到 starhub-tool-context settings,
 * pre-step 注入会带上资产 id,模型据此解析目标资产;此处只负责干净展示。
 * @param asset - 目标资产(只需 id / name / config)。
 * @returns 模型可见引用文本(纯文本,无标记)。
 */
export function renderAssetReference(asset: { id: string; name: string; config: Record<string, unknown> }): string {
  const sub = assetSubtitle(asset)
  return sub === '' ? `@${asset.name}` : `@${asset.name} (${sub})`
}

/**
 * 资产 → 候选行首的工具徽标(工具大类短标签,经候选 icon 位展示,2026-08-21 加):
 * 用户要求 `@` 菜单候选前面能看出来属于哪个工具。Broker 路由名归终端子类
 * (与导航事实表一致),先判 db-broker;routeNameForAsset 把其余未识别类型
 * 一律回落 db-mysql,故剩余分支即数据库,与导航的兜底语义保持一致。
 * @param asset - 目标资产(只需 type + config 派生路由名)。
 * @returns 工具大类短标签。
 */
export function assetToolBadge(asset: { type: string; config: Record<string, unknown> }): string {
  const route = routeNameForAsset(asset)
  if (route === 'ssh-terminal' || route === 'db-broker') return '终端'
  if (route === 'docker') return 'Docker'
  if (route === 'local') return '本机'
  return '数据库'
}

/**
 * Create the `@` asset source: candidates from the asset snapshot, lexicon =
 * the asset-name roll (subscribeLexicon feeds the pipeline's decoration
 * scan), pick inserts a reference and light-binds the asset context.
 * @param deps - settings RPC face, asset holder and selection bridge.
 * @returns the source; register via ctx.effect on `ctx.inputTriggers`.
 */
export function createStarHubAssetSource(deps: StarHubAssetSourceDeps): InputTriggerSource {
  // Pick 时按候选对象反查资产:菜单保存的候选对象与 candidates() 返回的
  // 是同一引用(controller.pick 直接取 menu 里的 items),WeakMap 引用键
  // 在列表刷新后自然可回收。
  const byCandidate = new WeakMap<InputTriggerCandidate, RustAsset>()
  const source: InputTriggerSource = {
    trigger: STARHUB_ASSET_TRIGGER,
    name: STARHUB_ASSET_SOURCE,
    warm() {
      // 会话 scope 诞生即拉一次资产列表,保证候选菜单打开时有数据;
      // refresh 内部对并发拉取去重,浏览器预览落入 preview 态不发请求。
      deps.assets.refresh()
    },
    candidates(_session: ClientSessionContext, { query, signal }): Promise<readonly InputTriggerCandidate[]> {
      if (signal.aborted) return Promise.resolve([])
      const needle = query.trim().toLowerCase()
      const items: InputTriggerCandidate[] = []
      for (const asset of deps.assets.source.getSnapshot().assets) {
        if (needle !== '' && !asset.name.toLowerCase().includes(needle)) continue
        const sub = assetSubtitle(asset)
        const candidate: InputTriggerCandidate = {
          name: asset.name,
          icon: assetToolBadge(asset),
          ...(sub !== '' ? { description: sub } : {}),
        }
        byCandidate.set(candidate, asset)
        items.push(candidate)
      }
      return Promise.resolve(items)
    },
    lexicon(_session: ClientSessionContext) {
      // 资产名清单:快照总是「已暖」(空数组 = 尚未配置资产),直接返回。
      return deps.assets.source.getSnapshot().assets.map(a => a.name)
    },
    subscribeLexicon(_session: ClientSessionContext, listener: () => void) {
      // 名单的变更源就是资产快照(get_assets 刷新 / preview 切换)。
      return deps.assets.source.subscribe(listener)
    },
    onPick({ candidate }) {
      const asset = byCandidate.get(candidate)
      if (asset === undefined) {
        // 非本 source 产出的候选(防御路径):退回普通文本引用。
        return { text: `@${candidate.name} ` }
      }
      // 轻绑定:只写 settings 上下文,不切窗口、不打断输入。
      bindAssetContext(deps.api, deps.selection.source.getSnapshot(), asset)
      const sub = assetSubtitle(asset)
      return {
        insert: {
          source: STARHUB_ASSET_SOURCE,
          ref: asset.id,
          label: sub === '' ? asset.name : `${asset.name} (${sub})`,
          clipboardText: `@${asset.name}`,
        },
      }
    },
    codec: {
      clipboardText: (ref) => {
        // 剪贴板/持久化投影为 `@name`(资产已删除时退回裸 id)。
        const asset = deps.assets.source.getSnapshot().assets.find(a => a.id === ref)
        return `@${asset?.name ?? ref}`
      },
      serialize: (ref) => {
        // 模型表示必须在提交时解析;资产已删除 = 序列化失败,阻止发送
        // (流水线契约:绝不静默降级为剪贴板文本)。
        const asset = deps.assets.source.getSnapshot().assets.find(a => a.id === ref)
        if (asset === undefined) {
          return Promise.reject(new Error(`starhub-asset: 引用资产 "${ref}" 已不存在`))
        }
        return Promise.resolve(renderAssetReference(asset))
      },
    },
  }
  return source
}
