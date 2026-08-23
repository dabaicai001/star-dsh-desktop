/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — every piece of text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve to that content (trigger: its own text; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconChevronDownOutline14, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

/** 导航条目:平铺行或可折叠分组(组内成员共享 group key)。 */
type NavItem =
  | { kind: 'row'; row: SettingsSectionRow }
  | { kind: 'group'; key: string; label: string; rows: SettingsSectionRow[] }

/** 把 ledger rows 投影为排序后的导航条目:无 group 平铺,有 group 聚合。
 *  分组头顺序 = 组内最小 order,组之间按该 order 与平铺行统一排序。 */
function buildNavItems(rows: readonly SettingsSectionRow[]): NavItem[] {
  const plain: NavItem[] = []
  const byGroup = new Map<string, { label: string; order: number; rows: SettingsSectionRow[] }>()
  for (const row of rows) {
    if (row.group === undefined) {
      plain.push({ kind: 'row', row })
      continue
    }
    const entry = byGroup.get(row.group) ?? {
      label: row.groupLabel ?? row.group, order: row.order, rows: [],
    }
    entry.rows.push(row)
    entry.order = Math.min(entry.order, row.order)
    byGroup.set(row.group, entry)
  }
  const groups: NavItem[] = Array.from(byGroup.entries()).map(([key, g]) => ({
    kind: 'group', key, label: g.label,
    rows: [...g.rows].sort((a, b) => a.order - b.order),
  }))
  const orderOf = (item: NavItem) => item.kind === 'row' ? item.row.order : (item.rows[0]?.order ?? 0)
  return [...plain, ...groups].sort((a, b) => orderOf(a) - orderOf(b))
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  // 分组折叠态(组件局部;默认展开)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const items = useMemo(() => buildNavItems(rows), [rows])
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {items.map(item => item.kind === 'group' ? (
              <Fragment key={item.key}>
                <button
                  type="button"
                  className={css.navGroup}
                  aria-expanded={!collapsedGroups.has(item.key)}
                  onClick={() => { toggleGroup(item.key) }}
                >
                  <IconChevronDownOutline14
                    size={12}
                    className={collapsedGroups.has(item.key) ? css.chevron : css.chevronOpen}
                  />
                  <span className={css.navGroupLabel}>{item.label}</span>
                </button>
                {!collapsedGroups.has(item.key) && item.rows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    className={clsx(css.navCell, css.navSub, row.id === active && css.active)}
                    aria-current={row.id === active ? 'true' : undefined}
                    onClick={() => { onSelect(row.id) }}
                  >
                    {navIcon(row.id)}
                    <span className={css.navLabel}>{row.label}</span>
                  </button>
                ))}
              </Fragment>
            ) : (
              <button
                key={item.row.id}
                type="button"
                className={clsx(css.navCell, item.row.id === active && css.active)}
                aria-current={item.row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(item.row.id) }}
              >
                {navIcon(item.row.id)}
                <span className={css.navLabel}>{item.row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSections, useOnboardingSteps, useSessions, renderSlot } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
