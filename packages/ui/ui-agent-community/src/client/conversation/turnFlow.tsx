/**
 * Turn flow — the items a bot turn renders under its name row, in the native
 * vertical order, each with the gap that precedes it.
 *
 * Split out of MessageRows.tsx: `BotTurn` keeps the derived turn state (is the
 * run live, how did it settle, is the work section open) and passes each value
 * to the item component that reads it; the item markup itself lives here.
 *
 * @module
 */
import type { ReactNode } from 'react'
import type { LedgerEntry, TokenUsage } from './types.ts'
import type { FlowKind } from './styles.ts'
import { flowGapAfter, bodyText, mutedText, cardSurface, shimmerKeyframes, spinKeyframes, pulseKeyframes } from './styles.ts'
import { Markdown } from './Markdown.tsx'
import { MiniSpinner, StreamingText } from './SimpleRows.tsx'
import { Chevron, MessageIconActions } from './messageActions.tsx'
import { ProcessGroup, processCounts, type ProcessKind } from './processSteps.tsx'
import { ToolRowFromLedger } from './ToolRow.tsx'
import { UsageControl } from './UsageControl.tsx'
import { fmtUsage } from './format.ts'
import { DeepDiving } from './DeepDiving.tsx'
import {
  WORK_LIVE, formatRunDuration, turnStatusLabel,
  TURN_WORKED, TURN_FAILED } from './nativeStrings.ts'

// ── flow list ─────────────────────────────────────────────────────────────────

/** One item of the turn's flow: the native `data-chat-flow-kind` plus its node. */
export interface TurnFlowItem {
  kind: FlowKind
  node: ReactNode
}

// Inject keyframes once, for the animated pieces rendered below
// (`StreamingText`'s shimmer, `MiniSpinner`'s spin).
let _keyframesInjected = false
function ensureKeyframes() {
  if (_keyframesInjected || typeof document === 'undefined') return
  _keyframesInjected = true
  const style = document.createElement('style')
  style.textContent = shimmerKeyframes + spinKeyframes + pulseKeyframes
  document.head.appendChild(style)
}

/**
 * The turn's flow items, laid out in the native vertical order (§1.2):
 *
 * ```
 * [reasoning] → [turn-process] → [response] → [turn-tail] → [running]
 * ```
 *
 * Each item's `margin-top` is the native `--dsh-chat-flow-gap` of the item
 * before it (see {@link flowGapAfter}).
 */
export function TurnFlow({ items }: { items: ReadonlyArray<TurnFlowItem> }) {
  ensureKeyframes()
  return (
    <>
      {items.map((item, index) => (
        <div
          key={item.kind}
          data-flow-kind={item.kind}
          style={{ marginTop: index === 0 ? 0 : flowGapAfter(items[index - 1]!.kind) }}
        >
          {item.node}
        </div>
      ))}
    </>
  )
}

// ── process (work steps) ──────────────────────────────────────────────────────

/** Native reason switch for a settled turn, computed by `BotTurn`. */
export type SettledReason = 'aborted' | 'error' | 'timed' | 'other'

/**
 * Native `TurnProcessNodeView`: a 33px row with a .5px bottom rule, tertiary
 * label, and the chevron pinned to the right of the label.
 *
 * The settled label carries the run duration, exactly as the native component
 * does: `label` followed by the duration segments, numeric ones in the code
 * font. This row is the one that sits directly under the bot's name and above
 * the message.
 */
export function ProcessItem({
  toolCalls, resultByCallId, doneToolCount, approvals, questions,
  hasProcess, isLive, settledReason, durationMs, open, onToggle, liveActivity,
}: {
  toolCalls: ReadonlyArray<LedgerEntry>
  resultByCallId: ReadonlyMap<string | undefined, LedgerEntry>
  doneToolCount: number
  approvals: ReadonlyArray<LedgerEntry>
  questions: ReadonlyArray<LedgerEntry>
  /** Whether there is anything to fold; the row itself also shows for a bare duration. */
  hasProcess: boolean
  isLive: boolean
  settledReason: SettledReason
  durationMs: number | undefined
  open: boolean
  onToggle: () => void
  liveActivity: ProcessKind | undefined
}) {
  const toolCallCount = toolCalls.length
  // Spoken form is the neutral one even when the visible label shows a duration.
  const announcement = settledReason === 'error' ? TURN_FAILED : TURN_WORKED

  return (
    <div>
      {/* Native renders a polite, visually-hidden status next to the row so the
          spoken form stays neutral even when the label shows a duration. */}
      <span className="ac-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <button
        type="button"
        className="ac-process"
        data-turn-process=""
        data-turn-process-tool-calls={toolCallCount}
        onClick={onToggle}
        /* Native only sets `aria-expanded` when there is something to fold, and
           a turn that used no tools still shows the row (for its duration). */
        {...(hasProcess ? { 'aria-expanded': open } : { disabled: true })}
        {...(open ? { 'data-open': 'true' } : {})}
      >
        <span className="ac-process-label">
          {isLive ? (
            <>
              {WORK_LIVE}
              {toolCallCount > 0 && (
                <span className="ac-process-count">{doneToolCount}/{toolCallCount}</span>
              )}
            </>
          ) : (
            <>
              {/* Settled label + completion time, exactly as the native
                  TurnProcessNodeView composes them. */}
              {turnStatusLabel(settledReason)}
              {settledReason === 'timed' && durationMs !== undefined
                && formatRunDuration(durationMs).map((part, index) => (
                  <span key={index} className={part.numeric ? 'ac-process-duration-number' : undefined}>
                    {part.text}
                  </span>
                ))}
            </>
          )}
        </span>
        {isLive && <MiniSpinner />}
        {hasProcess && (
          <span className="ac-process-chevron" aria-hidden="true">
            <Chevron open={open} />
          </span>
        )}
      </button>
      {open && (
        <ProcessGroup
          counts={processCounts(toolCalls.map(tc => tc.name ?? ''))}
          live={isLive}
          {...(liveActivity === undefined ? {} : { activity: liveActivity })}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {toolCalls.map(tc => {
              const result = resultByCallId.get(tc.callId)
              return <ToolRowFromLedger key={tc.id} callEntry={tc} {...(result !== undefined ? { resultEntry: result } : {})} />
            })}
            {approvals.map(a => (
              <div key={a.id} style={{ ...cardSurface, padding: '6px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                审批：{a.toolName}{a.outcome !== undefined ? `（${a.outcome === 'allowed-once' ? '已允许' : '已拒绝'}）` : '（等待中）'}
              </div>
            ))}
            {questions.map(q => {
              const row = q as unknown as { questionId?: string; question?: string; status?: string; answer?: string }
              const mark = row.status === 'answered' ? `已答：${row.answer ?? ''}`
                : row.status === 'skipped' ? '已跳过'
                  : row.status === 'expired' ? '未回答（超时）'
                    : '等待回答'
              return (
                <div key={q.id} style={{ ...cardSurface, padding: '6px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                  提问：{String(row.question ?? '').slice(0, 60)}（{mark}）
                </div>
              )
            })}
          </div>
        </ProcessGroup>
      )}
    </div>
  )
}

// ── response ──────────────────────────────────────────────────────────────────

/**
 * Main text — rendered as Markdown so model formatting survives.
 *
 * Skipped entirely by the caller when there is nothing to show yet: during the
 * tool phase the run is live but no answer exists, and an empty block here
 * pushed the whale down and printed a placeholder the native transcript never
 * shows.
 */
export function ResponseItem({ text, hasText, isLive }: {
  /** Raw entry text; `hasText` is the trimmed test the caller gates on. */
  text: string
  hasText: boolean
  isLive: boolean
}) {
  return (
    <div>
      {hasText
        ? (isLive
          ? <StreamingText text={text} />
          : <div style={bodyText}><Markdown text={text} /></div>)
        : <span style={mutedText}>（处理中…）</span>
      }
    </div>
  )
}

// ── tail ──────────────────────────────────────────────────────────────────────

/**
 * Native `TurnTailNodeView`'s action row (§2.2). The caller decides *whether*
 * the tail exists (only once the turn has a closing event) and its reveal mode
 * (`always` when the turn ends with a visible response, `hover` otherwise);
 * this renders the row itself.
 */
export function TailItem({ text, at, usage, messageId, onFork, branchUnavailable }: {
  text: string
  at: string
  usage?: TokenUsage | undefined
  /** Fork FROM a message: receives that message's id. */
  messageId: string
  onFork?: ((messageId: string) => void) | undefined
  branchUnavailable: boolean
}) {
  return (
    <MessageIconActions
      text={text}
      time={at}
      clock="end"
      className="ac-actions-tail"
      {...(onFork !== undefined ? { onBranch: () => onFork(messageId) } : {})}
      branchUnavailable={branchUnavailable}
      usageAction={
        usage !== undefined
          ? <UsageControl usage={usage} {...(fmtUsage(usage) ?? { label: '', exact: '' })} />
          : undefined
      }
    />
  )
}

// ── running ───────────────────────────────────────────────────────────────────

/**
 * Native `RunningStatus` (§2.16): the deep-diving row is the turn's last flow
 * item and replaces the old "思考中…" label while the run is live.
 */
export function RunningItem({ startedAt }: { startedAt: number }) {
  return (
    <div className="ac-running-row">
      {/* DeepDiving carries `data-chat-running` on its own root. */}
      <DeepDiving {...(Number.isFinite(startedAt) ? { startedAt } : {})} />
    </div>
  )
}
