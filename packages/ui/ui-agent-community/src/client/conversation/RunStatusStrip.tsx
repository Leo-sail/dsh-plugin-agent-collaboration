/**
 * RunStatusStrip — one quiet line above the transcript about the room's CURRENT run.
 *
 * WHY IT EXISTS. The transcript's deep-diving row only exists while a run streams, and the
 * queue banner only speaks for parked runs. There was no place that answered, for a room the
 * user just came back to: how long has this been running, when is its deadline, and why did
 * the previous one stop? S8 persisted `deadlineAt` / `lastProgressAt` / `failureKind` on the
 * run records for exactly this, so the strip renders from `snapshot.runs` — no new RPC.
 *
 * It is a SIBLING of the transcript scroller (not a row inside it), for the same reason the
 * goal strip is: the line must stay put while the conversation scrolls. The clock is local to
 * this component and ticks every 30 s — the label includes a minute-resolution duration, so a
 * faster timer would only re-render text that cannot have changed.
 *
 * @module
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { BotRun } from '@dsh-plugin-agent-community/agent-community'
import { formatRunStatus, latestRunFor } from './runStatusView.ts'

/** How often a live run's elapsed/deadline line is re-read (minutes resolution). */
const REFRESH_MS = 30_000

export interface RunStatusStripProps {
  /** The room on screen; only its runs are considered. */
  roomId: string
  /** The snapshot's run records (the shell already polls these). */
  runs: readonly BotRun[]
}

/** The banner row: one line, quiet, directly under the goal strip. */
const stripStyle: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 12px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  fontSize: 12,
  lineHeight: '18px',
}

/** The dot carries the tone; the text stays in the normal label colours. */
const dotStyle: CSSProperties = {
  flex: 'none',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'currentColor',
}

const labelStyle: CSSProperties = {
  flexShrink: 0,
  color: 'var(--dsw-alias-label-primary)',
}

/** The reason / countdown half: one clipped line, full text on hover. */
const detailStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** The dot's tone reads at a glance: green while live, red on failure, grey on a stop. */
const toneColor: Readonly<Record<'running' | 'error' | 'muted', CSSProperties>> = {
  running: { color: 'var(--dsw-alias-state-success-primary)' },
  error: { color: 'var(--dsw-alias-state-error-primary)' },
  muted: { color: 'var(--dsw-alias-label-tertiary)' },
}

export function RunStatusStrip({ roomId, runs }: RunStatusStripProps) {
  // `nowMs` is state, not `Date.now()` read during render: the 30 s tick is what makes the
  // elapsed time and the countdown move without any snapshot arriving.
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const run = latestRunFor(roomId, runs)
  const view = run === undefined ? undefined : formatRunStatus(run, nowMs)
  const ticking = view !== undefined && view.tone === 'running'
  const runId = run?.id
  const tone = view?.tone

  // A new run (or a status change) makes the held clock wrong: reset it so a freshly started
  // run reads "已用 0s" instead of the age of the previous one.
  useEffect(() => { setNowMs(Date.now()) }, [roomId, runId, tone])

  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => {
      // A hidden window needs no repaint; the next visible tick catches up.
      if (typeof document !== 'undefined' && document.hidden === true) return
      setNowMs(Date.now())
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [ticking, roomId, runId])

  // Nothing worth a line: no run at all, or the current one finished cleanly.
  if (run === undefined || view === undefined || view.tone === 'hidden') return null
  const toneKey = view.tone === 'running' ? 'running' : view.tone === 'error' ? 'error' : 'muted'

  return (
    <div
      style={{ ...stripStyle, ...toneColor[toneKey] }}
      data-run-strip=""
      data-run-tone={view.tone}
      data-run-status={run.status}
      data-run-id={run.id}
      role="status"
    >
      <span style={{ ...dotStyle }} aria-hidden="true" />
      <span style={labelStyle}>{view.label}</span>
      {view.detail !== undefined && (
        <span style={detailStyle} title={view.detail}>{view.detail}</span>
      )}
    </div>
  )
}
