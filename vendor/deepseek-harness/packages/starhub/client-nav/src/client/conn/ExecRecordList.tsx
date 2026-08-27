/**
 * SSH 执行记录列表(v0.100.0,v0.100.1 行内断开):
 * 工具抽屉(StarHubToolWorkspace)里的执行记录视图——记录默认全部收起
 * (资产行),点击行展开该连接最近一次命令的完整输出,再次点击收起;记录
 * 多时容器纵向滚动。每行行尾有「断开连接」按钮:关闭该记录对应的 SSH 连接
 * 并移除记录(桥层 removeSession);之后的静默执行会重新建连并出现新记录。
 *
 * 纯展示组件:数据与写入回调经 props 注入(records / onClose / onClear /
 * onDisconnect),不直接摸 Tauri / 桥,便于组件测试与 HMR。records 已由
 * 桥按「当前会话」过滤过,本组件不做二次筛选。
 */
import { useState } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14,
  IconCloseOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExecRecord } from './exec-records.ts'
import css from './ExecRecordList.module.css'

/** sessionId → 行首展示名:`dsh:{assetId}:ssh` → `assetId`。 */
function assetName(sessionId: string): string {
  return sessionId.replace(/^dsh:/, '').replace(/:ssh$/, '')
}

/** 记录时间展示(HH:MM:SS)。 */
function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 渲染 SSH 执行记录视图(工具抽屉内)。
 * @param props.records - 当前会话的记录(最新在上;空数组渲染空态)。
 * @param props.onClose - 返回资产列表(关闭执行记录视图)。
 * @param props.onClear - 清空当前会话的记录。
 * @param props.onDisconnect - 断开一条连接并移除其记录(入参为连接 id)。
 * @returns 视图内容(替换抽屉主体)。
 */
export function ExecRecordList({ records, onClose, onClear, onDisconnect }: {
  records: readonly ExecRecord[]
  onClose: () => void
  onClear: () => void
  onDisconnect: (sessionId: string) => void
}) {
  /** 展开中的会话 id 集合(默认全收起;同一会话只保留最近一条记录)。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = (sessionId: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  return (
    <>
      <header className={css.header}>
        <span className={css.title}>SSH 执行记录</span>
        {records.length > 0 && <span className={css.count}>{records.length}</span>}
        <span className={css.spacer} />
        <button
          type="button"
          className={css.textButton}
          disabled={records.length === 0}
          onClick={onClear}
        >
          清空
        </button>
        <button
          type="button"
          className={css.closeButton}
          title="返回资产列表"
          aria-label="返回资产列表"
          onClick={onClose}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </header>
      <div className={css.list} role="region" aria-label="SSH 执行记录列表">
        {records.length === 0 && (
          <div className={css.status}>
            暂无记录。当前会话中,AI 通过 @ 绑定的 SSH 资产静默执行命令后,每次完成都会在这里出现一条。
          </div>
        )}
        {records.map(record => {
          const open = expanded.has(record.sessionId)
          const name = assetName(record.sessionId)
          return (
            <section key={record.sessionId} className={css.item}>
              {/* 展开钮与断开钮并列一行(button 不能嵌套,外面包一层 flex)。 */}
              <div className={css.rowLine}>
                <button
                  type="button"
                  className={`${css.rowHead} ${open ? css.rowHeadOpen : ''}`}
                  aria-expanded={open}
                  title={`${name}(点击${open ? '收起' : '展开'})`}
                  onClick={() => toggle(record.sessionId)}
                >
                  <span className={css.chevron}>
                    {open ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
                  </span>
                  <span className={css.badge}>{name}</span>
                  <span className={css.command}>$ {record.command}</span>
                  <span className={css.time}>{timeLabel(record.at)}</span>
                </button>
                <button
                  type="button"
                  className={css.disconnect}
                  title={`断开 ${name} 的 SSH 连接并移除记录`}
                  aria-label={`断开 ${name} 的连接并移除记录`}
                  onClick={() => onDisconnect(record.sessionId)}
                >
                  <IconCloseOutline16 size={12} />
                </button>
              </div>
              {open && (
                <div className={css.body}>
                  <pre className={css.output}>{record.output}</pre>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}
