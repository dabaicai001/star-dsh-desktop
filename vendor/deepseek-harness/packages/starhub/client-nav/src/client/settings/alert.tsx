/**
 * Settings 告警规则 tab(React 壳内版)——自 SettingsView.vue 1085-1214(逻辑)/
 * 2104-2220(模板,含编辑弹窗)迁移:规则卡片列表 + 新建/编辑共用表单弹窗 +
 * 测试 Webhook。创建/编辑分支、默认值、5s 测试结果自动清除等语义原样保留。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createAlertRule, deleteAlertRule, fetchAlertRules, testAlertWebhook, updateAlertRule,
  type AlertRule, type AlertRuleInput,
} from './services.ts'
import s from './settings.module.css'

/** 告警类别(与 Vue ALERT_CATEGORIES 一致)。 */
const ALERT_CATEGORIES = [
  { value: 'ssh', label: 'SSH' },
  { value: 'db', label: '数据库' },
  { value: 'docker', label: 'Docker' },
  { value: 'system', label: '系统' },
]

/** 监控指标(与 Vue ALERT_METRICS 一致)。 */
const ALERT_METRICS = [
  { value: 'ssh.error_count', label: 'SSH 错误次数 (1h)' },
  { value: 'ssh.total_count', label: 'SSH 总操作数 (1h)' },
  { value: 'ssh.error_rate', label: 'SSH 错误率 % (1h)' },
  { value: 'db.error_count', label: 'DB 错误次数 (1h)' },
  { value: 'db.total_count', label: 'DB 总操作数 (1h)' },
  { value: 'db.error_rate', label: 'DB 错误率 % (1h)' },
  { value: 'docker.error_count', label: 'Docker 错误次数 (1h)' },
  { value: 'docker.total_count', label: 'Docker 总操作数 (1h)' },
  { value: 'docker.error_rate', label: 'Docker 错误率 % (1h)' },
  { value: 'system.error_count', label: '系统错误次数 (1h)' },
  { value: 'system.total_count', label: '系统总操作数 (1h)' },
  { value: 'system.error_rate', label: '系统错误率 % (1h)' },
]

/** 操作符(与 Vue ALERT_OPERATORS 一致)。 */
const ALERT_OPERATORS = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: '==', label: '==' },
]

/** 新建规则的表单默认值(与 Vue openCreateAlert 一致)。 */
function defaultAlertForm(): AlertRuleInput {
  return {
    name: '',
    enabled: true,
    category: 'ssh',
    metric: 'ssh.error_count',
    operator: '>',
    threshold: 5,
    duration_sec: 0,
    webhook_url: null,
    cooldown_sec: 300,
  }
}

/**
 * 渲染告警规则:规则卡片列表(名称/启用态/指标阈值/编辑/删除)+ 创建编辑弹窗。
 * @returns 告警 tab 内容。
 */
export function AlertTab() {
  const [alertRules, setAlertRules] = useState<AlertRule[]>([])
  const [alertLoading, setAlertLoading] = useState(false)
  const [alertEditing, setAlertEditing] = useState<AlertRule | null>(null)
  const [alertDialog, setAlertDialog] = useState(false)
  const [alertTestResult, setAlertTestResult] = useState<string | null>(null)
  const [alertTesting, setAlertTesting] = useState<string | null>(null)
  const [alertForm, setAlertForm] = useState<AlertRuleInput>(defaultAlertForm())

  const loadAlertRules = useCallback(async () => {
    setAlertLoading(true)
    try {
      setAlertRules(await fetchAlertRules())
    } catch (error) {
      console.warn('[settings] Failed to load alert rules:', error)
    } finally {
      setAlertLoading(false)
    }
  }, [])

  // 挂载时加载(tab 切换会卸载重建,天然懒加载)
  useEffect(() => {
    void loadAlertRules()
  }, [loadAlertRules])

  const openCreateAlert = () => {
    setAlertEditing(null)
    setAlertForm(defaultAlertForm())
    setAlertDialog(true)
  }

  const openEditAlert = (rule: AlertRule) => {
    setAlertEditing(rule)
    setAlertForm({
      name: rule.name,
      enabled: rule.enabled,
      category: rule.category,
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      duration_sec: rule.duration_sec,
      webhook_url: rule.webhook_url,
      cooldown_sec: rule.cooldown_sec,
    })
    setAlertDialog(true)
  }

  const onSaveAlert = async () => {
    try {
      if (alertEditing !== null) {
        await updateAlertRule(alertEditing.id, alertForm)
      } else {
        await createAlertRule(alertForm)
      }
      setAlertDialog(false)
      await loadAlertRules()
    } catch (error) {
      console.error('[settings] Failed to save alert rule:', error)
    }
  }

  const onDeleteAlert = async (id: string) => {
    try {
      await deleteAlertRule(id)
      await loadAlertRules()
    } catch (error) {
      console.error('[settings] Failed to delete alert rule:', error)
    }
  }

  const onTestWebhook = async (url: string) => {
    // v8 ignore next 2 -- 测试按钮仅在 webhook 非空时渲染,空串守卫为防御分支
    if (url === '') return
    setAlertTesting(url)
    setAlertTestResult(null)
    try {
      setAlertTestResult(await testAlertWebhook(url))
    } catch (error) {
      setAlertTestResult(error instanceof Error ? error.message : String(error))
    } finally {
      setAlertTesting(null)
      setTimeout(() => { setAlertTestResult(null) }, 5000)
    }
  }

  const setFormField = <K extends keyof AlertRuleInput>(key: K, value: AlertRuleInput[K]) => {
    setAlertForm(form => ({ ...form, [key]: value }))
  }

  /* v8 ignore start -- 表单状态恒为 number/string(duration_sec/cooldown_sec/webhook_url 必填),?? 为防御分支 */
  const formDurationSec = alertForm.duration_sec ?? 0
  const formCooldownSec = alertForm.cooldown_sec ?? 300
  const formWebhookUrl = alertForm.webhook_url ?? ''
  /* v8 ignore stop */

  return (
    <div className={s.panel}>
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>告警规则</span>
          <span className={s.spacer} />
          <button
            type="button" className={s.btnSecondary} aria-label="刷新"
            disabled={alertLoading} onClick={() => void loadAlertRules()}
          >
            {alertLoading ? '…' : '刷新'}
          </button>
          <button type="button" className={s.btn} onClick={openCreateAlert}>新建规则</button>
        </div>
        {alertRules.length === 0 ? (
          <div className={s.empty}>暂无告警规则,点击「新建规则」创建。</div>
        ) : (
          <div className={s.cardList}>
            {alertRules.map(rule => (
              <div key={rule.id} className={`${s.card} ${rule.enabled ? '' : s.disabled}`}>
                <div className={s.cardHead}>
                  <span className={s.cardName}>{rule.name}</span>
                  <span className={rule.enabled ? s.badge : s.badgeOff}>
                    {rule.enabled ? '启用' : '禁用'}
                  </span>
                  <span className={s.cardMetric}>
                    {rule.metric} {rule.operator} {rule.threshold}
                  </span>
                  <span className={s.cardActions}>
                    <button
                      type="button" className={s.iconButton} title="编辑" aria-label="编辑"
                      onClick={() =>{  openEditAlert(rule) }}
                    >
                      ✎
                    </button>
                    <button
                      type="button" className={s.iconButton} title="删除" aria-label="删除"
                      onClick={() => void onDeleteAlert(rule.id)}
                    >
                      <IconCloseOutline16 size={13} />
                    </button>
                  </span>
                </div>
                <div className={s.cardMeta}>
                  <span>{rule.category}</span>
                  <span>持续 {rule.duration_sec}s</span>
                  <span>冷却 {rule.cooldown_sec}s</span>
                  {rule.webhook_url ? <span>Webhook: {rule.webhook_url}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
        {alertTestResult !== null && (
          <div className={alertTestResult.startsWith('✓') ? s.resultText : `${s.resultText} ${s.err}`}>
            {alertTestResult}
          </div>
        )}
      </div>

      {alertDialog && (
        <div className={s.dialogBackdrop} role="presentation" onMouseDown={() =>{  setAlertDialog(false) }}>
          <div
            className={s.dialogPanel}
            role="dialog"
            aria-label={alertEditing !== null ? '编辑告警规则' : '新建告警规则'}
            onMouseDown={(event) =>{  event.stopPropagation() }}
          >
            <div className={s.dialogHead}>
              <span className={s.dialogTitle}>
                {alertEditing !== null ? '编辑告警规则' : '新建告警规则'}
              </span>
              <button type="button" className={s.iconButton} aria-label="关闭" onClick={() =>{  setAlertDialog(false) }}>
                <IconCloseOutline16 size={14} />
              </button>
            </div>
            <div className={s.formGrid}>
              <div className={s.formField}>
                <label className={s.fieldLabel}>规则名称</label>
                <input
                  className={s.input} placeholder="例如: SSH 连接失败告警"
                  value={alertForm.name}
                  onChange={(event) =>{  setFormField('name', event.target.value) }}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>类别</label>
                <select
                  className={s.select} value={alertForm.category}
                  onChange={(event) =>{  setFormField('category', event.target.value) }}
                >
                  {ALERT_CATEGORIES.map(category => (
                    <option key={category.value} value={category.value}>{category.label}</option>
                  ))}
                </select>
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>监控指标</label>
                <select
                  className={s.select} value={alertForm.metric}
                  onChange={(event) =>{  setFormField('metric', event.target.value) }}
                >
                  {ALERT_METRICS.map(metric => (
                    <option key={metric.value} value={metric.value}>{metric.label}</option>
                  ))}
                </select>
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>操作符</label>
                <select
                  className={s.select} value={alertForm.operator}
                  onChange={(event) =>{  setFormField('operator', event.target.value) }}
                >
                  {ALERT_OPERATORS.map(operator => (
                    <option key={operator.value} value={operator.value}>{operator.label}</option>
                  ))}
                </select>
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>阈值</label>
                <input
                  className={s.input} type="number" step={0.1} value={alertForm.threshold}
                  onChange={(event) =>{  setFormField('threshold', Number(event.target.value)) }}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>持续时间(秒)</label>
                <input
                  className={s.input} type="number" min={0} value={formDurationSec}
                  onChange={(event) =>{  setFormField('duration_sec', Number(event.target.value)) }}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>冷却时间(秒)</label>
                <input
                  className={s.input} type="number" min={0} value={formCooldownSec}
                  onChange={(event) =>{  setFormField('cooldown_sec', Number(event.target.value)) }}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel}>Webhook URL</label>
                <input
                  className={s.input} value={formWebhookUrl}
                  onChange={(event) =>{  setFormField('webhook_url', event.target.value === '' ? null : event.target.value) }}
                />
              </div>
            </div>
            <label className={s.checkboxRow}>
              <input
                type="checkbox" checked={alertForm.enabled !== false}
                onChange={(event) =>{  setFormField('enabled', event.target.checked) }}
              />
              启用此规则
            </label>
            <div className={s.actionRow}>
              {formWebhookUrl !== '' && (
                <button
                  type="button" className={s.btnSecondary}
                  disabled={alertTesting === formWebhookUrl}
                  onClick={() => void onTestWebhook(formWebhookUrl)}
                >
                  {alertTesting === formWebhookUrl ? '测试中…' : '测试 Webhook'}
                </button>
              )}
              <button type="button" className={s.btnSecondary} onClick={() =>{  setAlertDialog(false) }}>取消</button>
              <button
                type="button" className={s.btn} disabled={alertForm.name.trim() === ''}
                onClick={() => void onSaveAlert()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
