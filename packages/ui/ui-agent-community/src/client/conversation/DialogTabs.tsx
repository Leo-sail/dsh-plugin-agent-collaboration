/**
 * The tabbed-dialog pattern of DSH, transcribed.
 *
 * PROVENANCE — everything here is a copy, not an invention:
 *   • component: `dsh-client-ui-primitives/lib/SegmentedTabs.js` (the shipped app bundle)
 *   • styles:    `dsh-client-ui-primitives/lib/SegmentedTabs.module.css`
 *   • usage:     the native `PresetGuideDialog` in `dsh-client-ui-agent-preset`:
 *                  <SegmentedTabs label value onChange items={[{ value, label, id, panelId }]} />
 *                  <div id={panelId} role="tabpanel" aria-labelledby={tabId}>…</div>
 *
 * WHY A COPY AND NOT AN IMPORT: the primitives version this package can type against
 * (`0.0.1-rc.1`) does not declare `SegmentedTabs`, and the package imports `.css` files,
 * so importing it would make every test that touches a dialog unrunnable under Node. The
 * tab strip therefore uses a plain button carrying the Pill base styles plus the tab
 * overrides — the same computed result, byte-identical rules.
 *
 * BEHAVIOUR KEPT VERBATIM: `role="tablist"` + `aria-label`, an absolutely positioned
 * indicator that slides with `translateX(selectedIndex * 100%)`, roving `tabIndex`, and
 * ArrowLeft / ArrowRight / Home / End moving focus AND selection together.
 *
 * ONE DELIBERATE DIFFERENCE from the native component: inactive panels are HIDDEN, never
 * unmounted. A dialog submits ONE form, and a required field living in the tab the user is
 * not looking at must still be validated and sent.
 */
import type { ReactNode } from 'react'
import { css } from '../styles.ts'

/** One tab: a stable value, the label in the strip, and its panel content. */
export interface DialogTab {
  readonly value: string
  readonly label: string
  readonly content: ReactNode
}

interface TabItem {
  readonly value: string
  readonly label: string
  readonly id: string
  readonly panelId: string
}

/**
 * The segmented tab strip.
 *
 * Exported because it carries the whole interaction worth testing, and because it must
 * stay free of any dependency that only exists inside the browser.
 */
export function NativeTabs({ items, value, onChange, label, className }: {
  items: readonly TabItem[]
  value: string
  onChange: (next: string) => void
  label: string
  className?: string | undefined
}): ReactNode {
  const selectedIndex = items.findIndex(item => item.value === value)

  const move = (event: { key: string; preventDefault(): void; stopPropagation(): void; currentTarget: { parentElement: { querySelectorAll(sel: string): { item(i: number): { focus(): void } | null } } | null } }, index: number): void => {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (index + items.length - 1) % items.length; break
      case 'ArrowRight': next = (index + 1) % items.length; break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    const nextItem = items[next]
    // Focus first, then select — the native order, so the roving tabIndex and the visible
    // indicator can never disagree with the focused tab.
    if (event.currentTarget.parentElement === null || nextItem === undefined) return
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]').item(next)?.focus()
    onChange(nextItem.value)
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={className === undefined ? css.segctl : `${css.segctl} ${className}`}
      style={{ gridAutoFlow: 'column', gridAutoColumns: 'minmax(0, 1fr)', display: 'inline-grid' }}
    >
      <span
        className={css.segctlIndicator}
        aria-hidden="true"
        style={{
          width: `calc((100% - 8px - 2px * (${items.length} - 1)) / ${items.length})`,
          transform: `translateX(calc(${selectedIndex} * (100% + 2px)))`,
        }}
      />
      {items.map((item, index) => (
        <button
          key={item.value}
          id={item.id}
          type="button"
          role="tab"
          className={css.segctlTab}
          aria-selected={value === item.value}
          aria-controls={item.panelId}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={event => move(event as never, index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** The strip plus its panels, wired by `id`/`aria-controls`/`aria-labelledby`. */
export function DialogTabs({ label, value, onChange, tabs, idPrefix }: {
  label: string
  value: string
  onChange: (next: string) => void
  tabs: readonly DialogTab[]
  idPrefix: string
}): ReactNode {
  return (
    <>
      <NativeTabs
        className={css.dialogTabs}
        label={label}
        value={value}
        onChange={onChange}
        items={tabs.map(tab => ({
          value: tab.value,
          label: tab.label,
          id: `${idPrefix}-${tab.value}-tab`,
          panelId: `${idPrefix}-${tab.value}-panel`,
        }))}
      />
      {tabs.map(tab => (
        <div
          key={tab.value}
          id={`${idPrefix}-${tab.value}-panel`}
          className={css.dialogPanel}
          role="tabpanel"
          aria-labelledby={`${idPrefix}-${tab.value}-tab`}
          hidden={tab.value !== value}
        >
          {tab.content}
        </div>
      ))}
    </>
  )
}
