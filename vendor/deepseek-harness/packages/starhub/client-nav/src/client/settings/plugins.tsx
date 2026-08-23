/**
 * Settings 插件 tab(React 壳内版):URL/本地导入三入口 + 市场(分类/搜索)。
 * 「已安装插件」列表按用户要求移除(启停/卸载入口随之下线);插件列表仍
 * 静默拉取一次,只用于市场项的「已安装」标记(installedByUrl)。
 * afterPluginMutation 收尾(关 runtime 让变更下次对话生效)语义保留。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { tauriInvoke } from '../tauri.ts'
import {
  fetchPluginMarket, installLocalPlugin, installPluginFromUrl, isTauriRuntime, listPlugins,
  shutdownDshRuntime,
  type DshMarketCatalog, type DshPluginInfo,
} from './services.ts'
import s from './settings.module.css'

/**
 * 渲染插件管理:安装入口 + 市场。
 * @returns 插件 tab 内容。
 */
export function PluginsTab() {
  const [pluginList, setPluginList] = useState<DshPluginInfo[]>([])
  const [pluginError, setPluginError] = useState('')
  const [pluginBusyId, setPluginBusyId] = useState('')
  const [pluginUrl, setPluginUrl] = useState('')
  const [pluginUrlInstalling, setPluginUrlInstalling] = useState(false)
  const [marketCatalog, setMarketCatalog] = useState<DshMarketCatalog | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketSearch, setMarketSearch] = useState('')
  const [marketPage, setMarketPage] = useState(0)
  const marketPageSize = 6

  // 静默拉取已装列表:只服务市场项的「已安装」标记,失败不打扰(空集即全可装)。
  const loadPlugins = useCallback(async () => {
    if (!isTauriRuntime()) return
    try {
      setPluginList(await listPlugins())
    } catch {
      // 列表只用于已安装标记,拉取失败按无已装处理
    }
  }, [])

  const loadMarket = useCallback(async (force = false) => {
    if (!isTauriRuntime()) return
    setMarketLoading(true)
    try {
      setMarketCatalog(await fetchPluginMarket(force))
    } catch {
      // Rust 侧已降级为空目录,这里只兜底 IPC 级失败
      setMarketCatalog({ stale: false, categories: [] })
    } finally {
      setMarketLoading(false)
    }
  }, [])

  // 切到本 tab 时懒加载(与 Vue watch(activeTab) 一致)
  useEffect(() => {
    if (pluginList.length === 0) void loadPlugins()
    if (marketCatalog === null) void loadMarket()
  }, [loadPlugins, loadMarket, pluginList.length, marketCatalog])

  const marketFiltered = useMemo(() => {
    const catalog = marketCatalog
    if (catalog === null) return []
    const keyword = marketSearch.trim().toLowerCase()
    if (keyword === '') return catalog.categories
    return catalog.categories
      .map(category => ({
        ...category,
        plugins: category.plugins.filter(plugin =>
          plugin.name.toLowerCase().includes(keyword)
          || plugin.description.toLowerCase().includes(keyword)
          || (plugin.npm ?? '').toLowerCase().includes(keyword)),
      }))
      .filter(category => category.plugins.length > 0)
  }, [marketCatalog, marketSearch])

  const marketItems = useMemo(() => marketFiltered.flatMap(category =>
    category.plugins.map(plugin => ({ category: category.name, plugin }))), [marketFiltered])
  const marketPageCount = Math.max(1, Math.ceil(marketItems.length / marketPageSize))
  const visibleMarketItems = marketItems.slice(marketPage * marketPageSize, (marketPage + 1) * marketPageSize)

  useEffect(() => {
    setMarketPage(0)
  }, [marketSearch, marketCatalog])

  useEffect(() => {
    if (marketPage >= marketPageCount) setMarketPage(marketPageCount - 1)
  }, [marketPage, marketPageCount])

  /** 变更后收尾:关 runtime(下次对话重启生效)+ 刷新已装标记。 */
  const afterPluginMutation = useCallback(async (message: string) => {
    try {
      await shutdownDshRuntime()
    } catch {
      // runtime 未运行属正常情况
    }
    void loadPlugins()
    return message
  }, [loadPlugins])

  const onInstallUrl = async () => {
    const url = pluginUrl.trim()
    if (url === '' || pluginUrlInstalling) return
    setPluginUrlInstalling(true)
    setPluginError('')
    try {
      await installPluginFromUrl(url)
      setPluginUrl('')
      await afterPluginMutation('插件已安装')
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginUrlInstalling(false)
    }
  }

  /** 本地导入(directory=true 选目录;否则选 .zip);浏览器预览无原生对话框 → null。 */
  const pickLocalPath = async (directory: boolean): Promise<string | null> => {
    if (!isTauriRuntime()) return null
    const picked = await tauriInvoke<string | string[] | null>('plugin:dialog|open', {
      options: {
        directory,
        multiple: false,
        ...(directory ? {} : { filters: [{ name: '插件压缩包', extensions: ['zip'] }] }),
      },
    })
    if (Array.isArray(picked)) return picked[0] ?? null
    return picked
  }

  const onImportLocal = async (directory: boolean) => {
    // v8 ignore next -- 导入按钮在 busy 时禁用,守卫为直接调用路径的防御分支
    if (pluginBusyId !== '') return
    const path = await pickLocalPath(directory)
    if (path === null) return
    setPluginBusyId('(import)')
    setPluginError('')
    try {
      await installLocalPlugin(path)
      await afterPluginMutation('插件已导入')
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginBusyId('')
    }
  }

  const installedByUrl = (url: string) => pluginList.some(plugin => url.includes(plugin.id))

  return (
    <div className={s.panel}>
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>安装插件</span>
        </div>
        {pluginError !== '' && <div className={s.errorText}>{pluginError}</div>}
        <div className={s.toolbar}>
          <input
            className={s.input} placeholder="GitHub 仓库 URL 或 zip 直链"
            value={pluginUrl}
            onChange={(event) =>{  setPluginUrl(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void onInstallUrl() }}
          />
          <button
            type="button" className={s.btn} disabled={pluginUrlInstalling || pluginUrl.trim() === ''}
            onClick={() => void onInstallUrl()}
          >
            {pluginUrlInstalling ? '安装中…' : 'URL 安装'}
          </button>
          <button
            type="button" className={s.btnSecondary} disabled={pluginBusyId !== ''}
            onClick={() => void onImportLocal(true)}
          >
            导入目录
          </button>
          <button
            type="button" className={s.btnSecondary} disabled={pluginBusyId !== ''}
            onClick={() => void onImportLocal(false)}
          >
            导入 Zip
          </button>
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>插件市场</span>
          <span className={s.spacer} />
          <input
            className={`${s.input} ${s.marketSearch}`} placeholder="搜索插件…"
            value={marketSearch}
            onChange={(event) =>{  setMarketSearch(event.target.value) }}
          />
          <button
            type="button" className={s.btnSecondary} disabled={marketLoading}
            onClick={() => void loadMarket(true)}
          >
            刷新
          </button>
        </div>
        {marketItems.length === 0 ? (
          <div className={s.empty}>暂无市场插件。</div>
        ) : (
          <>
            <div className={s.marketPage} aria-live="polite">
              {visibleMarketItems.map(({ category, plugin }) => (
                <div key={plugin.url} className={s.card}>
                  <div className={s.cardHead}>
                    <span className={s.cardName}>{plugin.name}</span>
                    {plugin.stars !== undefined && (
                      <span className={s.cardMetric}>★ {plugin.stars}</span>
                    )}
                    <span className={s.badgeOff}>未验证</span>
                    <span className={s.cardActions}>
                      <button
                        type="button" className={s.btnSecondary}
                        disabled={pluginUrlInstalling || installedByUrl(plugin.url)}
                        onClick={() => void onInstallUrlFromMarket(plugin.url, setPluginUrlInstalling, setPluginError, afterPluginMutation)}
                      >
                        {installedByUrl(plugin.url) ? '已安装' : '安装'}
                      </button>
                    </span>
                  </div>
                  <div className={s.cardMeta}>
                    <span>{category}</span>
                    {plugin.description !== '' && <span>{plugin.description}</span>}
                    {plugin.npm !== undefined && <span>npm: {plugin.npm}</span>}
                  </div>
                </div>
              ))}
            </div>
            <div className={s.marketPager} aria-label="插件市场分页">
              <button type="button" className={s.btnSecondary} disabled={marketPage === 0} onClick={() =>{  setMarketPage(page => page - 1) }}>上一页</button>
              <span className={s.marketPageIndicator} aria-live="polite">
                第 {marketPage + 1} / {marketPageCount} 页 · 共 {marketItems.length} 个插件
              </span>
              <button type="button" className={s.btnSecondary} disabled={marketPage >= marketPageCount - 1} onClick={() =>{  setMarketPage(page => page + 1) }}>下一页</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 市场安装按钮的独立入口(与 URL 安装共用防重入与收尾)。 */
async function onInstallUrlFromMarket(
  url: string,
  setInstalling: (value: boolean) => void,
  setError: (value: string) => void,
  afterMutation: (message: string) => Promise<string>,
): Promise<void> {
  setInstalling(true)
  setError('')
  try {
    await installPluginFromUrl(url)
    await afterMutation('插件已安装')
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  } finally {
    setInstalling(false)
  }
}
