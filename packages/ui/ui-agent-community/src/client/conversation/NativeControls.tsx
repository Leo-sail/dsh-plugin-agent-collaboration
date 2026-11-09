/**
 * Native form controls that the typed primitives surface does not expose.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` ships `Input`, `Button`, `Pill` and `Modal` with
 * types, but the runtime bundle this app loads also has `Checkbox`, `SegmentedControl` and
 * `SegmentedTabs` — and the version this package can type against does not declare them.
 * Importing an undeclared name would be a compile error, and importing the package at all
 * would pull `.css` files into every Node test.
 *
 * So these two are transcribed from the shipped app instead, CSS byte-for-byte:
 *   • `Checkbox`          ← lib/Checkbox.js + Checkbox.module.css
 *   • `SegmentedControl`  ← lib/SegmentedControl.js + SegmentedControl.module.css
 * Same markup, same custom properties, same focus rings, same reduced-motion handling.
 */
import type { ReactNode } from 'react'
import { css } from '../styles.ts'

/** Controlled native checkbox with the primitive's label wrapper. */
export function NativeCheckbox({ checked, onChange, label, disabled = false, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  disabled?: boolean | undefined
  className?: string | undefined
}): ReactNode {
  return (
    <label className={className === undefined ? css.checkbox : `${css.checkbox} ${className}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export interface SegmentedOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
}

/**
 * The native segmented control: an equal-width track with one raised indicator that slides
 * under the selection. The indicator's width and offset come from two custom properties
 * (segment count and index) rather than from measuring the DOM, exactly as upstream.
 */
export function NativeSegmentedControl({ id, value, options, onChange, label, disabled = false, className }: {
  id: string
  value: string
  options: readonly SegmentedOption[]
  onChange: (next: string) => void
  label: string
  disabled?: boolean | undefined
  className?: string | undefined
}): ReactNode {
  const selected = options.findIndex(option => option.value === value)
  return (
    <div
      role="tablist"
      aria-label={label}
      className={className === undefined ? css.segctl : `${css.segctl} ${className}`}
      style={{
        '--dsh-segment-count': String(options.length),
        '--dsh-segment-index': String(selected),
      } as never}
    >
      <span aria-hidden="true" className={css.segctlIndicator} />
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-${option.value}-panel`}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled === true}
            {...(option.title !== undefined ? { title: option.title } : {})}
            className={css.segctlTab}
            onClick={() => { if (!active) onChange(option.value) }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
