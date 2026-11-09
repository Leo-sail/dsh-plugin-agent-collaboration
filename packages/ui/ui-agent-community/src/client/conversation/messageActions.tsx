/**
 * Message action chrome — the copy / branch / clock row under a message, plus the tiny
 * disclosure chevron the reasoning and process headers share.
 *
 * Split out of MessageRows.tsx. Copy feedback is NOT reimplemented here: it comes from the
 * tool-row primitives (`useCopy`, the `useCopyFeedback` replica), which owns the native
 * `window.setTimeout(…, 1e3)` revert — `chat:1138-1141`. The duplicate hook this file used to
 * carry leaked its revert timer, so it was dropped rather than moved.
 *
 * @module
 */
import type { ReactNode } from 'react'
import { fmtClock } from './format.ts'
import { Tooltip } from './Tooltip.tsx'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  IconCopyOutlineRegular,
} from './NativeIcons.tsx'
import { ACTION_BRANCH, ACTION_COPIED, ACTION_COPY } from './nativeStrings.ts'
import { useCopy } from './tool/primitives.tsx'

// ── MessageIconActions ────────────────────────────────────────────────────────

interface MessageIconActionsProps {
  /** Raw text the copy button puts on the clipboard. */
  text: string
  /** Epoch ms (ISO string from the ledger) of the message event. */
  time?: string | undefined
  /** Which side the clock sits on: user chrome = start, assistant tail = end. */
  clock: 'start' | 'end'
  /** Wired only when the caller can actually branch. */
  onBranch?: (() => void) | undefined
  /** When true the branch action is NOT rendered at all (a visible dead button is worse). */
  branchUnavailable?: boolean
  className?: string | undefined
  /** Extra plugin actions, rendered between copy and branch (native slot). */
  extraActions?: ReactNode
  /** The usage trigger; on the assistant side it sits inside `endInfo`. */
  usageAction?: ReactNode
}

/**
 * Copy / branch / clock action row — a line-for-line port of the native
 * `MessageIconActions` (`chat:1117-1190`, §2.1) including its DOM order:
 *
 * ```
 * [clock(start)] → copy → extraActions → branch → sr-only reason → [usage+clock(end)]
 * ```
 *
 * Sizing/hover/reveal live in `styles.ts` (`MessageIconActions.module.css`,
 * `chat:1093`): 28×28 buttons, 6px padding, 15px icons — **17px when the row is
 * `data-clock="end"`** — hover surface + `.4` opacity while unavailable.
 */
export function MessageIconActions({
  text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction,
}: MessageIconActionsProps) {
  const [copied, copy] = useCopy(text)
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? 'ac-time-start' : 'ac-time-end'}>{fmtClock(time)}</span>
  )
  const copyLabel = copied ? ACTION_COPIED : ACTION_COPY
  /**
   * The branch affordance exists ONLY when it can do something.
   *
   * This used to be a native-shaped `aria-disabled` button whose `onClick` was
   * `undefined` while `branchUnavailable` was set: it still looked (and hovered) like a
   * control, so clicking it did nothing with no explanation — the reported 「『在新对话中
   * 分支』点了没效果」. Native has a slot for that state; this panel does not need one:
   * an action that cannot run is simply not offered, so every visible branch button forks.
   */
  const branchAction = onBranch !== undefined && !branchUnavailable
    ? (
      <Tooltip label={ACTION_BRANCH} side="bottom">
        <button
          type="button"
          className="ac-action"
          aria-label={ACTION_BRANCH}
          onClick={onBranch}
        >
          <IconBranchOutlineRegular />
        </button>
      </Tooltip>
    )
    : null

  return (
    <div
      className={className === undefined ? 'ac-actions' : `ac-actions ${className}`}
      data-clock={clock}
    >
      {clock === 'start' ? clockEl : null}

      <Tooltip label={copyLabel} side="bottom">
        <button
          type="button"
          className="ac-action"
          aria-label={copyLabel}
          onClick={copy}
        >
          {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        </button>
      </Tooltip>

      {extraActions}

      {branchAction}

      {clock === 'end' ? (
        <span className="ac-end-info">
          {usageAction}
          {clockEl}
        </span>
      ) : usageAction}
    </div>
  )
}

// ── Chevron ───────────────────────────────────────────────────────────────────

export function Chevron({ open }: { open: boolean }) {
  return open
    ? <IconChevronUpOutlineRegular size={14} className="ac-chevron" />
    : <IconChevronDownOutlineRegular size={14} className="ac-chevron" />
}
