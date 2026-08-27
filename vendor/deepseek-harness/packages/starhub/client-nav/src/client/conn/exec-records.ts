/**
 * SSH 执行记录状态桥(v0.100.0 重构,替代右下角浮层 BastionExecPanel):
 * 后端 `ssh_exec_core` 每次成功执行都广播通用 `ssh:exec-done`
 * (payload sessionId/command/output,输出已截断 4000 字符);头部「执行」
 * 按钮(conversation.session.header.actions)与工具抽屉的执行记录视图
 * (StarHubToolWorkspace 内)跨 scope 共享同一份记录——裸 source 桥范式
 * (one-handle-one-scope,同 fileTree / toolsPanel)。
 *
 * 事件订阅挂 apply 的 `ctx.effect`(插件生命周期常驻),不随抽屉/按钮的
 * 开关与重挂载丢失——与 StarHubConnCard 的组件级监听同因,但订阅点升到
 * 插件层:视图组件是纯展示,卸载不影响采集。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { tauriListen } from '../tauri.ts'

/** 单条 SSH 执行记录(每个会话连接保留最近一次命令)。 */
export interface ExecRecord {
  /** 会话连接 id(`dsh:{assetId}:ssh`)。 */
  readonly sessionId: string
  readonly command: string
  readonly output: string
  /** 记录写入时间(Date.now()),仅用于行内展示。 */
  readonly at: number
}

/** 执行记录桥状态:工具抽屉视图开合 + 记录列表(最新在上)。 */
export interface ExecRecordsState {
  /** 工具抽屉是否切到「SSH 执行记录」视图。 */
  viewOpen: boolean
  records: ExecRecord[]
}

/** AI 域工具会话前缀:只接管 `dsh:{assetId}:ssh` 形式的连接。 */
const AI_CONN_PREFIX = 'dsh:'

/**
 * 记录条数上限:超出淘汰最旧,避免长会话下列表与内存无限增长。
 */
const MAX_RECORDS = 50

/** 后端广播的执行完成事件形状(Rust `ssh_exec_core` emit 的 json)。 */
export interface SshExecDoneEvent {
  sessionId: string
  command: string
  output: string
}

/** 执行记录桥:apply 持有的裸 source + 写入回调。 */
export interface ExecRecordsBridge {
  /** 注入 hooks 舱位的裸 observable。 */
  readonly source: SnapshotStore<ExecRecordsState>
  /**
   * 写入一条执行完成事件:`dsh:` 以外的会话忽略;同连接替换旧条目并置顶;
   * 超出上限淘汰最旧。
   */
  readonly note: (event: SshExecDoneEvent) => void
  /** 清空全部记录(执行记录视图头部「清空」)。 */
  readonly clear: () => void
  /** 切到执行记录视图(头部「执行」按钮;视图互斥复位在注入回调层组合)。 */
  readonly openView: () => void
  /** 返回资产列表(关闭执行记录视图)。 */
  readonly closeView: () => void
}

/**
 * Create the apply-owned exec-records bridge.
 * @returns the bridge (bare source + note/clear/open/close callbacks).
 */
export function createExecRecordsBridge(): ExecRecordsBridge {
  const source = createSnapshotStore<ExecRecordsState>({ viewOpen: false, records: [] })
  return {
    source,
    note: (event) => {
      if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
      const rest = source.getSnapshot().records.filter(r => r.sessionId !== event.sessionId)
      const record: ExecRecord = {
        sessionId: event.sessionId,
        command: event.command,
        output: event.output,
        at: Date.now(),
      }
      const records = [record, ...rest].slice(0, MAX_RECORDS)
      source.update((draft) => { draft.records = records })
    },
    clear: () => { source.update((draft) => { draft.records = [] }) },
    openView: () => { source.update((draft) => { draft.viewOpen = true }) },
    closeView: () => { source.update((draft) => { draft.viewOpen = false }) },
  }
}

/**
 * Subscribe to the backend-wide `ssh:exec-done` broadcast through the injected
 * IPC bridge and feed qualifying events into `note`.
 *
 * 浏览器预览(无 Tauri internals)时 tauriListen 直接返回 noop disposer,
 * 本函数同样安全;invoke 注册阶段的异常无法恢复(收不到事件而已),记一条
 * console 即可不静默。
 * @param note - the bridge write callback.
 * @returns sync disposer completing the async unlisten on plugin unload.
 */
export function subscribeSshExecEvents(note: (event: SshExecDoneEvent) => void): () => void {
  let disposed = false
  let unlisten: (() => Promise<void>) | undefined
  void tauriListen<SshExecDoneEvent>('ssh:exec-done', (event) => {
    if (!event.sessionId.startsWith(AI_CONN_PREFIX)) return
    note(event)
  })
    .then((off) => {
      // 竞态兜底:插件先于订阅完成被卸载时立即反注册。
      if (disposed) void off()
      else unlisten = off
    })
    .catch((e: unknown) => {
      // Tauri 事件插件注册失败:浏览器预览外的极端场景,订阅不成立即无事件,
      // 无恢复动作可做;打日志避免完全静默。
      console.error('订阅 ssh:exec-done 失败:', e)
    })
  return () => {
    disposed = true
    void unlisten?.()
  }
}
