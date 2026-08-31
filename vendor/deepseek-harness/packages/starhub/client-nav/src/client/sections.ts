/**
 * StarHub 功能导航事实表:三层结构「工具大类 → 子类 → 资产路由」(P1 方案)。
 *
 * 侧栏展示「工具」大类行(即分组头,可展开),下挂子类(终端 / 数据库 /
 * Docker / 沙箱桌面 / Android);点子类 → 右侧工具工作区列显示该类型的资产
 * (连接)列表;点资产行 → 新开独立窗口加载该实例的 React 原生操作页
 * (`/starhub-react/`),不再以整幅 overlay 盖住主壳或回落到 Vue embed。
 * 沙箱桌面与 Android 无资产概念(实例存 SQLite / 设备经 adb 发现),展开后
 * 渲染各自的工作面板而非资产列表。
 * 子类只定义分组/图标/资产匹配;实例路由前缀一律按资产类型经
 * `routePrefixForAsset` 派生(数据库子类混有多种库,不能共用子类前缀)。
 * Excel 已不在导航里(功能退役出侧栏);设置直接融入 dsh 底部设置面板
 * (StarHub 分组,壳内 React tab),连接管理为壳内小对话框。
 */
import {
  IconArchiveOutline20,
  IconBrowseOutline16,
  IconCodeOutline16,
  IconDataOutline16,
  type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

/** 资产序列化形态(与 src-tauri/src/commands/asset.rs 一致,供匹配用)。 */
export interface StarHubAsset {
  id: string
  type: string
  name: string
  config: Record<string, unknown>
}

/**
 * 一个子类:侧栏子行 + 右侧资产列表过滤 + 缺省段路由前缀。
 * 资产匹配复用 `routeNameForAsset` 的路由名映射(asset.type + config.dbType)。
 */
export interface StarHubSubcategory {
  /** 稳定 key(store 里 activeSubcategory 的取值)。 */
  key: string
  /** 侧栏子行文案。 */
  label: string
  /** 缺省段路由前缀(无资产空态与 routePrefixForAsset 未命中时的回退)。 */
  routePrefix: string
  /** 侧栏子行图标(ui-primitives 现成字形)。 */
  Icon: ComponentType<IconProps>
  /** 资产是否属于该子类(复用 routeNameForAsset 语义)。 */
  matches: (asset: StarHubAsset) => boolean
}

/**
 * 资产 → embed 功能路由名(与 src/utils/assetRouting.ts 的 routeNameForAsset 同构;只需 type + config)。
 * @param asset - 资产(只需 type + config 判定)。
 * @returns 功能路由名(如 'ssh-terminal' / 'db-mysql');未命中的 dbType 回退 'db-mysql'。
 */
export function routeNameForAsset(asset: { type: string; config: Record<string, unknown> }): string {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
  if (asset.type === 'local') return 'local'
  const dbType = typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql'
  if (dbType === 'redis') return 'db-redis'
  if (dbType === 'elasticsearch') return 'db-elasticsearch'
  if (dbType === 'clickhouse') return 'db-clickhouse'
  if (dbType === 'postgresql') return 'db-postgresql'
  if (dbType === 'kafka' || dbType === 'nsq') return 'db-broker'
  return 'db-mysql'
}

/** 功能路由名 → embed 段路由前缀(与 src/router/index.ts 的 :id 路由一致)。 */
export const ROUTE_NAME_PREFIX: Readonly<Record<string, string>> = {
  'ssh-terminal': '/ssh',
  'db-mysql': '/db/mysql',
  'db-postgresql': '/db/postgresql',
  'db-clickhouse': '/db/clickhouse',
  'db-redis': '/db/redis',
  'db-elasticsearch': '/db/elasticsearch',
  'db-broker': '/broker',
  docker: '/docker',
}

/**
 * 资产 → embed 段路由前缀。实例操作页必须按资产类型派生前缀:
 * 数据库子类下 MySQL / PG / CH / Redis / ES 各有独立功能路由(不同视图),
 * 用子类前缀会把 Redis/ES 资产错路由进 MySQL 工作台。
 * @param asset - 目标资产。
 * @returns 段路由前缀;无功能路由的类型(如 local)返回 null。
 */
export function routePrefixForAsset(asset: StarHubAsset): string | null {
  return ROUTE_NAME_PREFIX[routeNameForAsset(asset)] ?? null
}

/**
 * 资产副标题(user@host 之类,取最常用字段;没有就不显示)。工作区资产行、
 * `@` 资产 source 的候选/引用序列化共用这一个事实表。
 * @param asset - 资产(只需 config 判定)。
 * @returns 副标题文本;无可用字段时为空串。
 */
export function assetSubtitle(asset: { config: Record<string, unknown> }): string {
  const c = asset.config
  const host = typeof c.host === 'string' ? c.host : ''
  const username = typeof c.username === 'string' ? c.username : ''
  if (host !== '' && username !== '') return `${username}@${host}`
  if (host !== '') return host
  return typeof c.database === 'string' ? c.database : ''
}

/** 子类清单(展示顺序即数组顺序)。终端含 SSH/SFTP/Broker,数据库合并 MySQL / PG / CH / Redis / ES(方案 2.1)。 */
export const STARHUB_SUBCATEGORIES: readonly StarHubSubcategory[] = [
  {
    key: 'terminal',
    label: '终端',
    routePrefix: '/ssh',
    Icon: IconCodeOutline16,
    matches: (a) => {
      const name = routeNameForAsset(a)
      return name === 'ssh-terminal' || name === 'db-broker'
    },
  },
  {
    key: 'database',
    label: '数据库',
    routePrefix: '/db/mysql',
    Icon: IconDataOutline16,
    matches: (a) => {
      const name = routeNameForAsset(a)
      return name === 'db-mysql' || name === 'db-postgresql' || name === 'db-clickhouse'
        || name === 'db-redis' || name === 'db-elasticsearch'
    },
  },
  {
    key: 'docker',
    label: 'Docker',
    routePrefix: '/docker',
    Icon: IconArchiveOutline20,
    matches: a => routeNameForAsset(a) === 'docker',
  },
  {
    // 沙箱桌面:无资产概念(实例/模板存 SQLite),树节点展开后渲染
    // SandboxPanel(StarHubToolWorkspace 对 key='sandbox' 特判)。
    key: 'sandbox',
    label: '沙箱桌面',
    routePrefix: '/sandbox',
    Icon: IconArchiveOutline20,
    matches: () => false,
  },
  {
    // Android 实体机:无资产概念(设备经 adb 现场发现,不落连接管理器),
    // 树节点展开后渲染 AndroidPanel(StarHubToolWorkspace 对 key='android' 特判)。
    key: 'android',
    label: 'Android',
    routePrefix: '/android',
    Icon: IconBrowseOutline16,
    matches: () => false,
  },
]

/**
 * 组装实例「React 独立程序窗口」URL(host-static 托管 starhub-window 在
 * /starhub-react/)。独立窗口按资产 id 取整份资产并挂载对应 React 工作台,
 * 不再回落 Vue embed / 壳内弹框。workbench 提示位供入口预判,缺省由资产类型推断。
 * @param asset - 目标资产(只需 id + type/config 派生工作台)。
 * @returns 独立窗口入口 URL。
 */
export function assetWindowUrl(asset: StarHubAsset): string {
  const params = new URLSearchParams({ asset: asset.id })
  const route = routeNameForAsset(asset)
  // 仅对确有无 React 工作台的类型给提示位(窗口侧按资产兜底映射);ES/local
  // 等无工作台的类型省略提示,入口按「不支持」处理而非挂 Vue。
  const hint = route === 'ssh-terminal' ? 'ssh'
    : route === 'db-broker' ? 'broker'
      : route === 'db-redis' ? 'db-redis'
        : route === 'db-elasticsearch' ? 'db-elasticsearch'
          : route === 'docker' ? 'docker'
            : (route === 'db-mysql' || route === 'db-postgresql' || route === 'db-clickhouse' || route === 'db-elasticsearch') ? route : ''
  if (hint !== '') params.set('workbench', hint)
  return `/starhub-react/index.html?${params.toString()}`
}
