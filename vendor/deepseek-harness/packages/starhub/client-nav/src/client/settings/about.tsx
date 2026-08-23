/**
 * Settings 关于 tab(React 壳内版)——自 SettingsView.vue 246-275(更新逻辑)/
 * 2289-2956(模板)迁移:hero(logo/名称/版本/简介/标语/GitHub 链接)+
 * 检查更新状态机 + 许可证。版本号经 `plugin:app|version` 运行时读取
 * (替代 Vue 的 `~package.json` alias,浏览器预览降级显示 '--')。
 */
import { useEffect, useState } from 'react'
import { tauriInvoke } from '../tauri.ts'
import {
  checkForUpdates, downloadAndInstall, isTauriRuntime, type UpdateInfo,
} from './services.ts'
import s from './settings.module.css'

/**
 * 渲染关于页:应用信息 + 更新检查/安装。
 * @returns 关于 tab 内容。
 */
export function AboutTab() {
  const [appVersion, setAppVersion] = useState('--')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)

  // 桌面端经 plugin:app|version 取运行版本;浏览器预览保持 '--'
  useEffect(() => {
    if (!isTauriRuntime()) return
    tauriInvoke<string>('plugin:app|version')
      .then((version) =>{  setAppVersion(version) })
      .catch(() => { /* 版本读取失败保持占位 */ })
  }, [])

  const onCheckUpdate = async () => {
    setUpdateChecking(true)
    setUpdateInfo(null)
    setUpdateError(null)
    try {
      setUpdateInfo(await checkForUpdates())
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
    } finally {
      setUpdateChecking(false)
    }
  }

  const onDownloadAndInstall = async () => {
    setUpdateInstalling(true)
    setUpdateError(null)
    try {
      await downloadAndInstall()
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
    } finally {
      setUpdateInstalling(false)
    }
  }

  return (
    <div className={s.panel}>
      <div className={s.aboutHero}>
        <div className={s.aboutLogo} aria-hidden="true">S</div>
        <h2 className={s.aboutName}>StarHub</h2>
        <div className={s.aboutVersion}>
          <code className={s.mono}>v{appVersion}</code>
          <span className={s.hint}>应用版本</span>
          <span className={s.aboutBadge}>deepseek harness</span>
        </div>
        <p className={s.aboutDesc}>
          跨平台开发运维工具箱:数据库客户端 · SSH 终端 · SFTP · Docker · AI 助手
        </p>
        <div className={s.aboutLinks}>
          <a
            className={s.aboutLink}
            href="https://github.com/dabaicai001/starhub"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <button
            type="button" className={s.btnSecondary}
            disabled={updateChecking || updateInstalling}
            onClick={() => void onCheckUpdate()}
          >
            {updateChecking ? '检查中…' : '检查更新'}
          </button>
        </div>
        {updateInfo?.available === true && (
          <div className={s.aboutUpdateAvailable}>
            <span>有新版本: v{updateInfo.version}</span>
            <button
              type="button" className={s.btn}
              disabled={updateInstalling}
              onClick={() => void onDownloadAndInstall()}
            >
              {updateInstalling ? '正在安装…' : '下载并安装'}
            </button>
          </div>
        )}
        {updateInfo !== null && ! updateInfo.available && updateError === null && (
          <div className={s.resultText}>已是最新版本</div>
        )}
        {updateError !== null && <div className={s.errorText}>{updateError}</div>}
        <div className={s.aboutLicense}>MIT License</div>
      </div>
    </div>
  )
}
