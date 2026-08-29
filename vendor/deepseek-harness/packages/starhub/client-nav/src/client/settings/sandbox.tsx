/**
 * Settings 沙箱平台 tab:选择「沙箱桌面」的 Docker 执行平台。
 * 语义(Rust desktop 模块实现):不选 = 默认本机 Docker;选中一个既有
 * Docker 连接后,模板构建与沙箱容器都落在那台;所选连接失效时报错,
 * 绝不静默回落本机(平台选择是安全决策)。
 */
import { useEffect, useState } from 'react'
import { fetchSandboxOverview, listDockerAssets, setSandboxPlatform, type DockerAssetOption } from '../sandbox/services.ts'
import s from './settings.module.css'
import css from '../sandbox/SandboxPanel.module.css'

/** 沙箱平台设置 tab 内容。 */
export function SandboxSettingsTab() {
  const [platformAssetId, setPlatformAssetId] = useState<string | null>(null)
  const [dockerAssets, setDockerAssets] = useState<DockerAssetOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void Promise.all([fetchSandboxOverview(), listDockerAssets()])
      .then(([overview, assets]) => {
        setPlatformAssetId(overview.platformAssetId)
        setDockerAssets(assets)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  const onChange = async (value: string) => {
    const next = value === '' ? null : value
    setSaved(false)
    try {
      await setSandboxPlatform(next)
      setPlatformAssetId(next)
      setError(null)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={s.panel}>
      <h3>沙箱平台</h3>
      <p className={s.hint}>
        AI 的 Ubuntu 容器沙箱在这个 Docker 上创建。默认本机;选择远程连接后全部沙箱操作落到该连接,
        连接失效会报错而不会静默回落本机。
      </p>
      <label className={css.field}>
        执行平台
        <select
          className={css.select}
          value={platformAssetId ?? ''}
          onChange={event => { void onChange(event.target.value) }}
        >
          <option value="">本机 Docker(默认)</option>
          {dockerAssets.map(asset => (
            <option key={asset.id} value={asset.id}>{asset.name}</option>
          ))}
        </select>
      </label>
      {saved && <div className={s.hint}>已保存。</div>}
      {error !== null && <div className={css.errorBanner}>{error}</div>}
    </div>
  )
}
