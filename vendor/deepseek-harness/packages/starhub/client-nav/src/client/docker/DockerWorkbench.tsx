/**
 * StarHub 原生 Docker 工作台(批次 1:Docker 全线 React 化)。
 *
 * 形态:壳内全屏 overlay(经 shell.overlay 槽内的 DockerWorkbench 分支渲染),
 * 替换原先 Docker 资产「openNewPage 开 Vue embed 独立窗口」。自带连接生命周期
 * (挂载按 asset.config 调 docker_connect → connId,卸载 docker_disconnect)。
 * 顶部为概览卡条(容器/运行/停止/暂停 + 镜像数),下分「容器 / 镜像」两个 tab:
 *  - 容器:列表(名称/镜像/状态/端口/运行时长)+ 行操作(启动/停止/重启/删除)+
 *    独立日志弹框与行内实时 stats,「终端」按钮开交互式 exec 弹层。
 *  - 镜像:列表(标签/体积/创建时间)+ 拉取/删除/prune。
 * 交互优化(相对 Vue):浅色状态徽章、操作后即时刷新、空态/加载/错误引导、
 * 危险操作(删除/清理)二次确认、按状态分组的概览卡。
 *
 * 命令面全部复用既定 Tauri command(starhub-commands 已授权,见
 * capabilities/default.json + permissions/commands.toml 的 docker_* 组)。
 *
 * @module StarHub Docker workbench (client)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconCloseOutline16, IconCodeOutline16, IconDataOutline16, IconInspectOutline12, IconPaperclipOutline16,
  IconPlayOutline16, IconRefreshOutline14, IconRefreshOutline16, IconStopFill16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RustAsset } from '../store.ts'
import { tauriInvoke } from '../tauri.ts'
import {
  dockerConnect, dockerContainerLogs, dockerContainerStats, dockerDisconnect,
  dockerListContainers, dockerListImages, dockerPruneImages, dockerPullImage, dockerRemoveContainer,
  dockerRemoveImage, dockerRestartContainer, dockerStartContainer, dockerStopContainer,
  formatBytes, type ContainerInfo, type ContainerStats, type DockerConnectParams, type ImageInfo,
} from './docker-service.ts'
import { DockerExecTerminal } from './DockerExecTerminal.tsx'
import css from './DockerWorkbench.module.css'

/** Docker 连接参数(把资产 config 转成 DockerConnectParams;键与 Vue docker.ts 同契约)。 */
export async function toDockerConnectParams(config: Record<string, unknown>): Promise<DockerConnectParams> {
  const transport = config.dockerTransport === 'ssh'
    ? 'ssh'
    : config.dockerTransport === 'tcp' ? 'tcp' : 'socket'
  if (transport === 'tcp') {
    return { transport, host: typeof config.remoteHost === 'string' ? config.remoteHost : '' }
  }
  if (transport === 'socket') {
    return { transport, socketPath: typeof config.socketPath === 'string' ? config.socketPath : '/var/run/docker.sock' }
  }

  const sshAssetId = typeof config.dockerSshAssetId === 'string' ? config.dockerSshAssetId : ''
  if (sshAssetId === '') throw new Error('Docker SSH 传输缺少 SSH 资产')
  const assets = await tauriInvoke<RustAsset[]>('get_assets')
  const sshAsset = assets.find(candidate => candidate.id === sshAssetId)
  if (sshAsset === undefined || sshAsset.type !== 'ssh') {
    throw new Error('Docker SSH 传输依赖的 SSH 资产未找到')
  }
  const sshConfig = sshAsset.config
  const host = typeof sshConfig.host === 'string' ? sshConfig.host : ''
  const username = typeof sshConfig.username === 'string' ? sshConfig.username : ''
  const port = typeof sshConfig.port === 'number' ? sshConfig.port : 22
  if (host === '' || username === '') throw new Error('Docker SSH 资产配置不完整')
  const knownHostKey = await tauriInvoke<string | null>('ssh_get_trusted_host_key', { host, port })
  if (knownHostKey === null || knownHostKey === '') {
    throw new Error(`Docker SSH 主机 ${host}:${port} 尚未确认主机密钥`)
  }
  const jumpHost = typeof sshConfig.jumpHost === 'string' ? sshConfig.jumpHost : undefined
  const jumpPort = typeof sshConfig.jumpPort === 'number' ? sshConfig.jumpPort : 22
  const jumpKnownHostKey = jumpHost === undefined
    ? undefined
    : await tauriInvoke<string | null>('ssh_get_trusted_host_key', { host: jumpHost, port: jumpPort })
  if (jumpHost !== undefined && (jumpKnownHostKey === null || jumpKnownHostKey === '')) {
    throw new Error(`Docker SSH 跳板机 ${jumpHost}:${jumpPort} 尚未确认主机密钥`)
  }
  const confirmedJumpHostKey = jumpKnownHostKey ?? undefined
  const optionalString = (key: string): Record<string, string> => {
    const value = sshConfig[key]
    return typeof value === 'string' ? { [key]: value } : {}
  }
  return {
    transport,
    socketPath: typeof config.socketPath === 'string' ? config.socketPath : '/var/run/docker.sock',
    ssh: {
      host,
      port,
      username,
      ...optionalString('password'),
      ...optionalString('privateKey'),
      ...optionalString('passphrase'),
      knownHostKey,
      ...(jumpHost === undefined ? {} : {
        jumpHost,
        jumpPort,
        ...optionalString('jumpUsername'),
        ...optionalString('jumpPassword'),
        ...optionalString('jumpPrivateKey'),
        ...optionalString('jumpPassphrase'),
        ...(confirmedJumpHostKey === undefined ? {} : { jumpKnownHostKey: confirmedJumpHostKey }),
      }),
      protocol: config.dockerSshProtocol === 'unix-over-nc' ? 'unix-over-nc' : 'unix-over-nc-sudo',
    },
  }
}

/** 一组 docker 行的加载/错误宿主(容器与镜像列表共用形态)。 */
interface Loadable<T> {
  items: T[]
  loading: boolean
  error: string | null
}

/** 概览计数(从容器列表派生;运行/停止/暂停按 state 归类)。 */
interface DashboardCounts {
  total: number
  running: number
  stopped: number
  paused: number
  images: number
}

type WorkbenchTab = 'containers' | 'images'

/** 单个容器的行内详情(仅统计)。 */
type ContainerDetail =
  | { panel: 'stats'; stats: { stats: ContainerStats | null; loading: boolean; error: string | null } }
  | null

/** 日志弹框状态。 */
interface LogsOpen {
  container: ContainerInfo
  tail: string
  logs: Loadable<{ timestamp: string; stream: string; message: string }>
}

/** 交互式 exec 会话的打开状态(容器 → 终端弹层)。 */
interface ExecOpen {
  container: ContainerInfo
}

/** 从容器列表派生概览卡计数。 */
export function countContainers(containers: ContainerInfo[], images: number): DashboardCounts {
  let running = 0
  let stopped = 0
  let paused = 0
  for (const c of containers) {
    if (c.state === 'running') running += 1
    else if (c.state === 'paused') paused += 1
    else stopped += 1
  }
  return { total: containers.length, running, stopped, paused, images }
}

/**
 * Render the native Docker workbench: full-screen overlay with a dashboard
 * strip, containers and images tabs, per-row actions, expandable logs/stats,
 * and an interactive exec terminal modal.
 * @param props - the target asset and a close callback.
 * @returns the Docker workbench overlay.
 */
export function DockerWorkbench({ asset, onClose }: { asset: RustAsset; onClose: () => void }) {
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [tab, setTab] = useState<WorkbenchTab>('containers')
  const [showAll, setShowAll] = useState(false)
  const [containers, setContainers] = useState<Loadable<ContainerInfo>>({ items: [], loading: false, error: null })
  const [images, setImages] = useState<Loadable<ImageInfo>>({ items: [], loading: false, error: null })
  const [detail, setDetail] = useState<ContainerDetail>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [logsOpen, setLogsOpen] = useState<LogsOpen | null>(null)
  const [exec, setExec] = useState<ExecOpen | null>(null)
  const [pullOpen, setPullOpen] = useState(false)
  const [pullName, setPullName] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const connRef = useRef<string | null>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    /* v8 ignore start -- toast 2.5s 自动消除是时序副作用,由 mounted 断言覆盖消息出现即可 */
    window.setTimeout(() =>{  setToast(cur => (cur === msg ? null : cur)) }, 2500)
    /* v8 ignore stop */
  }, [])

  /** 拉取容器列表(全量或只看运行中)。 */
  const loadContainers = useCallback(async () => {
    const id = connRef.current
    /* v8 ignore next -- 仅连接建立后才会被调用,connRef 恒非空 */
    if (id === null) return
    setContainers(prev => ({ ...prev, loading: true, error: null }))
    try {
      const items = await dockerListContainers(id, showAll)
      setContainers({ items, loading: false, error: null })
    } catch (e) {
      setContainers(prev => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [showAll])

  /** 拉取镜像列表。 */
  const loadImages = useCallback(async () => {
    const id = connRef.current
    /* v8 ignore next -- 仅连接建立后才会被调用,connRef 恒非空 */
    if (id === null) return
    setImages(prev => ({ ...prev, loading: true, error: null }))
    try {
      const items = await dockerListImages(id)
      setImages({ items, loading: false, error: null })
    } catch (e) {
      setImages(prev => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [])

  // 挂载建连一次,卸载断连;连接按资产只建一次。
  useEffect(() => {
    let cancelled = false
    void toDockerConnectParams(asset.config)
      .then((params) => {
        if (params.transport === 'tcp' && params.host === '') {
          throw new Error('Docker 资产配置不完整(缺少 TCP 地址)')
        }
        return dockerConnect(params)
      })
      .then(async (info) => {
        /* v8 ignore next -- 卸载竞态:连接在清理后 resolve,防御性守卫 */
        if (cancelled) return
        if (!info.connId) throw new Error('Docker 连接未返回 connId')
        connRef.current = info.connId
        setConnected(true)
        await Promise.all([loadContainers(), loadImages()])
      })
      .catch((e: unknown) => {
        /* v8 ignore start -- `String(e)` 兜底非 Error 值;`!cancelled` 卸载守卫均由成功路径/断连测试覆盖成功面 */
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e))
        /* v8 ignore stop */
      })
    return () => {
      cancelled = true
      /* v8 ignore start -- fire-and-forget 断连;IPC 失败非致命 */
      if (connRef.current !== null) void dockerDisconnect(connRef.current).catch(() => {})
      /* v8 ignore stop */
    }
    // 只随资产 id 变化;loadX 恒定,不列入依赖避免重连。
  }, [asset.id])

  /** 容器行操作:成功后刷新;删除/危险操作已二次确认。 */
  const runContainerAction = useCallback(async (kind: 'start' | 'stop' | 'restart' | 'remove', c: ContainerInfo) => {
    const id = connRef.current
    /* v8 ignore next -- 仅连接建立后被调用,connRef 恒非空 */
    if (id === null) return
    if (kind === 'remove' && !window.confirm(`确定删除容器「${c.name}」?进程数据将不可恢复。`)) return
    try {
      if (kind === 'start') await dockerStartContainer(id, c.id)
      else if (kind === 'stop') await dockerStopContainer(id, c.id)
      else if (kind === 'restart') await dockerRestartContainer(id, c.id)
      else await dockerRemoveContainer(id, c.id, true)
      notify(`${kind === 'remove' ? '已删除' : (kind === 'start' ? '已启动' : kind === 'stop' ? '已停止' : '已重启')}:${c.name}`)
    } catch (e) {
      notify(`操作失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      void loadContainers()
    }
  }, [loadContainers, notify])

  /** 打开日志弹框并加载最新日志。 */
  const openLogs = useCallback(async (c: ContainerInfo) => {
    const id = connRef.current
    /* v8 ignore next -- 仅连接建立后被调用,connRef 恒非空 */
    if (id === null) return
    setLogsOpen({ container: c, tail: '200', logs: { items: [], loading: true, error: null } })
    try {
      const items = await dockerContainerLogs(id, c.id, '200')
      setLogsOpen({ container: c, tail: '200', logs: { items: [...items].reverse(), loading: false, error: null } })
    } catch (e) {
      setLogsOpen({ container: c, tail: '200', logs: { items: [], loading: false, error: e instanceof Error ? e.message : String(e) } })
    }
  }, [])

  /** 行展开/收起:统计按需拉取并保留在行内。 */
  const toggleStats = useCallback(async (c: ContainerInfo) => {
    const id = connRef.current
    /* v8 ignore next -- 仅连接建立后被调用,connRef 恒非空 */
    if (id === null) return
    if (expanded === c.id && detail?.panel === 'stats') {
      setExpanded(null)
      setDetail(null)
      return
    }
    setExpanded(c.id)
    setDetail({ panel: 'stats', stats: { stats: null, loading: true, error: null } })
    try {
      const s = await dockerContainerStats(id, c.id)
      setDetail({ panel: 'stats', stats: { stats: s, loading: false, error: null } })
    } catch (e) {
      setDetail({ panel: 'stats', stats: { stats: null, loading: false, error: e instanceof Error ? e.message : String(e) } })
    }
  }, [expanded, detail])

  /** 拉取镜像。 */
  const runPull = useCallback(async () => {
    const name = pullName.trim()
    if (name === '' || connRef.current === null) return
    try {
      await dockerPullImage(connRef.current, name)
      notify(`已拉取:${name}`)
      setPullOpen(false)
      setPullName('')
      void loadImages()
    } catch (e) {
      notify(`拉取失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }, [pullName, loadImages, notify])

  /** 删除镜像。 */
  const runRemoveImage = useCallback(async (img: ImageInfo) => {
    const id = connRef.current
    /* v8 ignore next -- 仅连接建立后被调用,connRef 恒非空 */
    if (id === null) return
    const tag = (img.tags[0] ?? img.id.slice(0, 12))
    if (!window.confirm(`确定删除镜像「${tag}」?`)) return
    try {
      await dockerRemoveImage(id, img.id, true)
      notify(`已删除镜像:${tag}`)
    } catch (e) {
      notify(`删除失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      void loadImages()
    }
  }, [loadImages, notify])

  /** 清理悬空镜像。 */
  const runPrune = useCallback(async () => {
    /* v8 ignore next -- 仅连接建立后被调用,connRef 恒非空 */
    if (connRef.current === null) return
    if (!window.confirm('确定清理悬空镜像?')) return
    try {
      await dockerPruneImages(connRef.current)
      notify('已清理悬空镜像')
    } catch (e) {
      notify(`清理失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      void loadImages()
    }
  }, [loadImages, notify])

  const counts = countContainers(containers.items, images.items.length)

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`Docker ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span className={connected ? css.statusOnline : css.statusPending} aria-label={connected ? 'Docker 已连接' : 'Docker 连接中'} />
            <div className={css.identity}>
              <span className={css.title}>{asset.name}</span>
              <span className={css.endpoint}>{typeof asset.config.remoteHost === 'string' ? asset.config.remoteHost : (typeof asset.config.socketPath === 'string' ? asset.config.socketPath : '/var/run/docker.sock')}</span>
            </div>
          </div>
          <div className={css.headActions}>
            <button type="button" className={css.iconButton} onClick={() => { void loadContainers(); void loadImages() }} title="刷新工作台" aria-label="刷新工作台"><IconRefreshOutline14 size={15} /></button>
            <button type="button" className={css.iconButton} onClick={onClose} title="关闭工作区" aria-label="关闭工作区"><IconCloseOutline16 size={15} /></button>
          </div>
        </header>

        {connectError !== null && (
          <div className={css.errorBar}>
            <span>{connectError}</span>
            <button type="button" className={css.retryButton} onClick={onClose}>返回</button>
          </div>
        )}

        {connectError === null && (
          <div className={css.workspace}>
            <main className={css.main}>
              <div className={css.dash}>
                <DashboardCard label="容器" value={counts.total} accent="cyan" />
                <DashboardCard label="运行中" value={counts.running} accent="green" />
                <DashboardCard label="已停止" value={counts.stopped} accent="red" />
                <DashboardCard label="暂停" value={counts.paused} accent="yellow" />
                <DashboardCard label="镜像" value={counts.images} accent="cyan" />
              </div>
              <div className={css.contentToolbar} role="tablist" aria-label="Docker 工作区">
                <button type="button" role="tab" aria-label="容器" aria-selected={tab === 'containers'} className={tab === 'containers' ? css.contentTabActive : css.contentTab} onClick={() =>{  setTab('containers') }}><span aria-hidden="true">容器</span> <span aria-hidden="true">{counts.total}</span></button>
                <button type="button" role="tab" aria-label="镜像" aria-selected={tab === 'images'} className={tab === 'images' ? css.contentTabActive : css.contentTab} onClick={() =>{  setTab('images') }}><span aria-hidden="true">镜像</span> <span aria-hidden="true">{counts.images}</span></button>
                <span className={css.contentDetail}>{tab === 'containers' ? '管理运行实例、日志和终端会话' : '拉取、检查和清理镜像'}</span>
                <span className={css.spacer} />
                {tab === 'images' && (
                  <>
                    <button type="button" className={css.toolIcon} onClick={() =>{  setPullOpen(true) }} title="拉取镜像" aria-label="拉取镜像"><IconPaperclipOutline16 size={15} /></button>
                    <button type="button" className={css.toolIconDanger} onClick={() => void runPrune()} title="清理悬空镜像" aria-label="清理悬空镜像"><IconTrashOutline16 size={15} /></button>
                  </>
                )}
                {tab === 'containers' && (
                  <label className={css.check}>
                    <input type="checkbox" checked={showAll} onChange={(e) =>{  setShowAll(e.target.checked) }} />
                    <span>显示全部</span>
                  </label>
                )}
                <button type="button" className={css.toolIcon} onClick={() => tab === 'containers' ? void loadContainers() : void loadImages()} disabled={tab === 'containers' ? containers.loading : images.loading} title="刷新" aria-label="刷新"><IconRefreshOutline14 size={14} /></button>
              </div>
              {tab === 'containers' && (
                <ContainersView
                  load={containers}
                  showAll={showAll}
                  onRefresh={() => void loadContainers()}
                  onAction={(kind, c) => void runContainerAction(kind, c)}
                  expanded={expanded}
                  detail={detail}
                  onOpenLogs={c => void openLogs(c)}
                  onToggleStats={c => void toggleStats(c)}
                  onExec={(c) =>{  setExec({ container: c }) }}
                />
              )}
              {tab === 'images' && (
                <ImagesView
                  load={images}
                  onRefresh={() => void loadImages()}
                  onPullOpen={() =>{  setPullOpen(true) }}
                  onRemove={img => void runRemoveImage(img)}
                />
              )}
            </main>
          </div>
        )}

        {pullOpen && (
          <div className={css.modalBackdrop}>
            <div className={css.modal}>
              <div className={css.modalTitle}>拉取镜像</div>
              <input
                autoFocus
                className={css.input}
                placeholder="名称[:tag],如 nginx:latest"
                value={pullName}
                onChange={(e) =>{  setPullName(e.target.value) }}
                /* v8 ignore next -- Enter 提交已由 keyDown 测试覆盖,但 JSX 内联处理器里的分支 v8 无法归行 */
                onKeyDown={(e) => { if (e.key === 'Enter') void runPull() }}
              />
              <div className={css.modalActions}>
                <button type="button" className={css.modalButton} onClick={() =>{  setPullOpen(false) }}>取消</button>
                <button type="button" className={css.modalPrimary} disabled={pullName.trim() === ''} onClick={() => void runPull()}>拉取</button>
              </div>
            </div>
          </div>
        )}

        {logsOpen !== null && (
          <LogsModal
            open={logsOpen}
            onClose={() =>{  setLogsOpen(null) }}
            onRefresh={() => void openLogs(logsOpen.container)}
          />
        )}

        {exec !== null && (
          <DockerExecTerminal
            /* v8 ignore next -- exec 只在连接建立且 connRef 已注入后打开,`?? ''` 是类型落空防御 */
            connId={connRef.current ?? ''}
            container={exec.container}
            onClose={() =>{  setExec(null) }}
          />
        )}

        {toast !== null && <div className={css.toast}>{toast}</div>}
      </section>
    </div>
  )
}

/** 概览统计卡:大数字 + 类别名,低饱和强调色。 */
function DashboardCard({ label, value, accent }: { label: string; value: number; accent: 'cyan' | 'green' | 'red' | 'yellow' }) {
  const accentClass = accent === 'cyan' ? css.accentCyan
    : accent === 'green' ? css.accentGreen
      : accent === 'red' ? css.accentRed
        : css.accentYellow
  return (
    <div className={css.dashCard}>
      <span className={`${css.dashValue} ${accentClass}`}>{value}</span>
      <span className={css.dashLabel}>{label}</span>
    </div>
  )
}

/** 容器 tab:列表 + 行操作 + 行内统计详情。 */
function ContainersView({
  load, showAll, onRefresh, onAction, expanded, detail, onOpenLogs, onToggleStats, onExec,
}: {
  load: Loadable<ContainerInfo>
  showAll: boolean
  onRefresh: () => void
  onAction: (kind: 'start' | 'stop' | 'restart' | 'remove', c: ContainerInfo) => void
  expanded: string | null
  detail: ContainerDetail
  onOpenLogs: (c: ContainerInfo) => void
  onToggleStats: (c: ContainerInfo) => void
  onExec: (c: ContainerInfo) => void
}) {
  if (load.loading) return <div className={css.status}>加载容器…</div>
  if (load.error !== null) return (
    <div className={css.status}>
      <span>加载失败:{load.error}</span>
      <button type="button" className={css.retryButton} onClick={onRefresh}>重试</button>
    </div>
  )
  const visible = showAll ? load.items : load.items.filter(c => c.state === 'running')
  if (!showAll && visible.length === 0 && load.items.length > 0) return (
    <div className={css.status}>
      <span>没有运行中的容器。</span>
      <button type="button" className={css.inlineButton} onClick={onRefresh}>显示全部</button>
    </div>
  )
  if (load.items.length === 0) return <div className={css.status}>暂无容器。</div>
  return (
    <div className={css.list}>
      {visible.map(c => (
        <div className={css.rowBlock} key={c.id}>
          <div className={css.row}>
            <div className={css.rowInfo}>
              <button type="button" className={css.rowMain} onClick={() =>{  onOpenLogs(c) }}>
                <span className={`${css.stateBadge} ${stateClass(c.state)}`}>{c.state}</span>
                <span className={css.rowName}>{c.name}</span>
                <span className={css.rowSub}>{c.image}</span>
                {c.ports.length > 0 && <span className={css.ports}>{c.ports.map(p => p.public ?? p.private).join(', ')}</span>}
              </button>
            </div>
            <div className={css.rowActions}>
              <RowAction label="启动" disabled={c.state === 'running'} onClick={() =>{  onAction('start', c) }}><IconPlayOutline16 size={14} /></RowAction>
              <RowAction label="停止" disabled={c.state !== 'running'} onClick={() =>{  onAction('stop', c) }}><IconStopFill16 size={14} /></RowAction>
              <RowAction label="重启" onClick={() =>{  onAction('restart', c) }}><IconRefreshOutline16 size={14} /></RowAction>
              <RowAction label="终端" onClick={() =>{  onExec(c) }}><IconCodeOutline16 size={14} /></RowAction>
              <RowAction label="日志" onClick={() =>{  onOpenLogs(c) }}><IconInspectOutline12 size={14} /></RowAction>
              <RowAction label="统计" onClick={() =>{   onToggleStats(c) }}><IconDataOutline16 size={14} /></RowAction>
              <RowAction label="删除" danger onClick={() =>{  onAction('remove', c) }}><IconTrashOutline16 size={14} /></RowAction>
            </div>
          </div>
          {expanded === c.id && detail !== null && (
            <div className={css.detail}>
              <StatsView load={detail.stats} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** 状态 → css 类名(运行/暂停/其余即停止);仅用于模板插值,允许 string|undefined。 */
function stateClass(state: string): string | undefined {
  if (state === 'running') return css.stateRunning
  if (state === 'paused') return css.statePaused
  return css.stateStopped
}

/** 行内小操作按钮。 */
function RowAction({ label, disabled, danger, onClick, children }: {
  label: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={danger ? css.dangerButton : css.rowAction}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** 日志弹框:最新记录置顶,可刷新。 */
function LogsModal({ open, onClose, onRefresh }: {
  open: LogsOpen
  onClose: () => void
  onRefresh: () => void
}) {
  const { container, tail, logs } = open
  return (
    <div className={css.modalBackdrop} role="presentation">
      <section className={css.logModal} role="dialog" aria-modal="true" aria-label={`${container.name} 日志`}>
        <header className={css.logModalHeader}>
          <div className={css.logModalTitle}>
            <span>{container.name} 日志</span>
            <span className={css.tailNote}>尾 {tail} 行，最新在前</span>
          </div>
          <div className={css.logModalActions}>
            <button type="button" className={css.toolIcon} onClick={onRefresh} title="刷新日志" aria-label="刷新日志"><IconRefreshOutline14 size={15} /></button>
            <button type="button" className={css.toolIcon} onClick={onClose} title="关闭日志" aria-label="关闭日志"><IconCloseOutline16 size={16} /></button>
          </div>
        </header>
        {logs.loading && <div className={css.detailStatus}>加载日志…</div>}
        {logs.error !== null && <div className={css.detailStatus}>日志加载失败:{logs.error}</div>}
        {!logs.loading && logs.error === null && (logs.items.length === 0 ? <div className={css.detailStatus}>暂无日志。</div> : (
          <div className={css.logBody}>
            {logs.items.map((line, index) => (
              <div key={index} className={line.stream === 'stderr' ? css.logErr : css.logLine}>
                <span className={css.logTime}>{line.timestamp}</span>
                <span>{line.message}</span>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}

/** 统计展开区(CPU/内存/网络/BLOCK I/O/PIDs)。 */
function StatsView({ load }: { load: { stats: ContainerStats | null; loading: boolean; error: string | null } }) {
  if (load.loading) return <div className={css.detailStatus}>加载统计…</div>
  if (load.error !== null || load.stats === null) return <div className={css.detailStatus}>{load.error ?? '暂无统计。'}</div>
  const s = load.stats
  return (
    <div className={css.statsGrid}>
      <StatCell label="CPU" value={`${s.cpuPercent.toFixed(1)}%`} />
      <StatCell label="内存" value={`${s.memoryPercent.toFixed(1)}%`} sub={formatBytes(s.memoryUsage)} />
      <StatCell label="网络 ↓" value={formatBytes(s.netRx)} />
      <StatCell label="网络 ↑" value={formatBytes(s.netTx)} />
      <StatCell label="读 I/O" value={formatBytes(s.blockRead)} />
      <StatCell label="写 I/O" value={formatBytes(s.blockWrite)} />
      <StatCell label="PIDs" value={String(s.pids)} />
    </div>
  )
}

/** 单个统计格。 */
function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={css.statCell}>
      <span className={css.statLabel}>{label}</span>
      <span className={css.statValue}>{value}</span>
      {sub !== undefined && <span className={css.statSub}>{sub}</span>}
    </div>
  )
}

/** 镜像 tab:列表 + 尺寸/创建时间 + 删除。 */
function ImagesView({ load, onRefresh, onPullOpen, onRemove }: {
  load: Loadable<ImageInfo>
  onRefresh: () => void
  onPullOpen: () => void
  onRemove: (img: ImageInfo) => void
}) {
  if (load.loading) return <div className={css.status}>加载镜像…</div>
  if (load.error !== null) return (
    <div className={css.status}>
      <span>加载失败:{load.error}</span>
      <button type="button" className={css.retryButton} onClick={onRefresh}>重试</button>
    </div>
  )
  if (load.items.length === 0) return (
    <div className={css.status}>
      <span>暂无镜像。</span>
      <button type="button" className={css.inlineButton} onClick={onPullOpen}>拉取镜像</button>
    </div>
  )
  return (
    <div className={css.list}>
      <div className={css.listHead}>
        <span className={css.headRepo}>仓库</span>
        <span className={css.headTag}>标签</span>
        <span className={css.headSize}>尺寸</span>
        <span className={css.headAge}>创建</span>
        <span className={css.spacer} />
      </div>
      {load.items.map(img => (
        <div className={css.imgRow} key={img.id}>
          <span className={css.imgRepo}>{img.tags[0]?.split(':')[0] ?? img.id.slice(0, 12)}</span>
          <span className={css.imgTag}>{img.tags[0] ?? img.id.slice(0, 12)}</span>
          <span className={css.imgSize}>{formatBytes(img.size)}</span>
          <span className={css.imgAge}>{formatAge(img.created)}</span>
          <button type="button" className={css.dangerButton} title="删除镜像" aria-label="删除镜像" onClick={() =>{  onRemove(img) }}><IconTrashOutline16 size={14} /></button>
        </div>
      ))}
    </div>
  )
}

/** 把 unix 秒格式化为人读的相对时间。 */
export function formatAge(epochSeconds: number): string {
  const diff = Date.now() / 1000 - epochSeconds
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}
