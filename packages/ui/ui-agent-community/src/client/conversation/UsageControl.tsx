/**
 * Turn-usage control — the `用量 N K tok` trigger and the breakdown popover it opens.
 *
 * Split out of MessageRows.tsx: {@link usageDetailRows} is the pure row builder and
 * {@link reduceUsagePopover} the open/close machine, so both can be reasoned about without a DOM;
 * the two components around them are the native `TurnUsagePanel` replica (§2.3).
 *
 * @module
 */
import { useEffect, useRef, useState } from 'react'
import type { TokenUsage, UsageDetailRow } from './types.ts'
import { fmtExact } from './format.ts'
import { Tooltip } from './Tooltip.tsx'
import { IconDatabaseOutlineRegular } from './NativeIcons.tsx'
import {
  USAGE_TITLE,
  USAGE_CACHE_READ, USAGE_CACHE_WRITE, USAGE_INPUT, USAGE_OUTPUT,
} from './nativeStrings.ts'

// ── UsageControl ──────────────────────────────────────────────────────────────

/** Everything that can happen to an open usage popover. */
type UsagePopoverAction = 'toggle' | 'escape' | 'outside'

/**
 * Pure core of {@link UsageControl} — the open/close machine, kept separate
 * from the DOM listeners the same way `resolveDisclosure` is kept
 * separate from `useStreamingDisclosure`.
 *
 * `toggle` flips the popover (the usage button); `escape` (Esc pressed) and
 * `outside` (pointer pressed outside the control) only ever dismiss.
 */
function reduceUsagePopover(open: boolean, action: UsagePopoverAction): boolean {
  if (action === 'toggle') return !open
  return false
}

/**
 * The clickable token-usage trigger — native `TurnUsagePanel` (§2.3,
 * `chat:6459-6470`): a `<button>` carrying `IconDatabaseOutlineRegular` plus the
 * `用量 N K tok` label, `aria-haspopup="dialog"` and `aria-expanded`, opening a
 * breakdown dialog above itself.
 *
 * Dismissal matches every native DSH floating surface: press Esc, or click
 * anywhere outside the control. Both listeners are only attached while the
 * popover is open, so a closed tail costs nothing.
 */
export function UsageControl({ usage, label, exact }: { usage: TokenUsage; label: string; exact: string }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Do not let Esc also reach whatever dialog/host shortcut is behind us.
      event.stopPropagation()
      setOpen(prev => reduceUsagePopover(prev, 'escape'))
    }
    const onMouseDown = (event: MouseEvent): void => {
      const wrap = wrapRef.current
      if (wrap !== null && event.target instanceof Node && !wrap.contains(event.target)) {
        setOpen(prev => reduceUsagePopover(prev, 'outside'))
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [open])

  return (
    <span ref={wrapRef} className="ac-usage-root ac-usage-pop-wrap">
      {/* The exact figures live in the native Tooltip bubble — no `title`
          attribute (native MessageIconActions / TurnUsagePanel carry none). */}
      <Tooltip label={exact === '' ? label : `${exact}（点击查看明细）`} side="bottom" align="end">
        <button
          type="button"
          className="ac-usage-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(prev => reduceUsagePopover(prev, 'toggle'))}
        >
          <IconDatabaseOutlineRegular />
          <span className="ac-usage-trigger-label">{label}</span>
        </button>
      </Tooltip>
      {open && <UsagePopover usage={usage} />}
    </span>
  )
}

// ── UsagePopover ──────────────────────────────────────────────────────────────

/**
 * This turn's token breakdown — `inputTokens / uncachedInputTokens /
 * outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens`.
 *
 * Only fields the ledger actually reported are listed; a missing (or zero)
 * count is dropped rather than printed as `0` / `undefined`.
 */
function UsagePopover({ usage }: { usage: TokenUsage | undefined }) {
  const rows = usageDetailRows(usage)
  if (rows.length === 0) return null
  const total = usage?.totalTokens
  return (
    <div className="ac-usage-pop" role="dialog" aria-label={USAGE_TITLE}>
      <div className="ac-usage-head">
        <span className="ac-usage-title-label">
          <IconDatabaseOutlineRegular size={14} />
          {USAGE_TITLE}
        </span>
        {total !== undefined && total > 0 && (
          <span className="ac-usage-title-value">{fmtExact(total)}</span>
        )}
      </div>
      {/* Native `-Fl-UW_titleRule` */}
      <div className="ac-usage-rule" aria-hidden="true" />
      <div className="ac-usage-rows">
        {rows.map(row => (
          <div key={row.key} className="ac-usage-row">
            <span className="ac-usage-label">{row.label}</span>
            <span className="ac-usage-value">{fmtExact(row.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Ordered rows of the breakdown, dropping every field that is absent or not a
 * usable count. Pure so the popover content can be asserted without a DOM.
 *
 * Labels are the native `message.turnUsage.*` strings: `未缓存输入` for the
 * uncached input, `缓存读取` for the cache-read tokens (native `缓存命中` is the
 * *percentage* row, which this plugin does not compute), `缓存写入` and `输出`.
 * `输入 tokens` / `总计` are plugin-only rows — the native dialog has no
 * total-input row and prints the total in its title instead (which this popover
 * now does too) — kept so no reported field goes unshown.
 */
function usageDetailRows(usage: TokenUsage | undefined): UsageDetailRow[] {
  if (usage === undefined) return []
  const rows: UsageDetailRow[] = []
  const add = (key: keyof TokenUsage, label: string, value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return
    rows.push({ key, label, value })
  }
  // Accounting order: what went in → what the cache did → what came out.
  add('inputTokens', '输入 tokens', usage.inputTokens)
  add('uncachedInputTokens', USAGE_INPUT, usage.uncachedInputTokens)
  add('cacheReadTokens', USAGE_CACHE_READ, usage.cacheReadTokens)
  add('cacheWriteTokens', USAGE_CACHE_WRITE, usage.cacheWriteTokens)
  add('outputTokens', USAGE_OUTPUT, usage.outputTokens)
  add('totalTokens', '总计', usage.totalTokens)
  return rows
}
