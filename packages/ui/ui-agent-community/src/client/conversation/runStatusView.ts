/**
 * runStatusView — the pure half of the run status strip.
 *
 * The panel's other live indicators answer "what is the bot saying" (the transcript's
 * deep-diving row) and "is anything running" (the queue banner). Neither answers the
 * questions the S8 adaptive-timeout work added: HOW LONG has this run been going, WHEN is
 * its deadline, and WHY did it end — a timed-out run, a stalled one, or a user stop all look
 * the same once the row settles. The strip reads the snapshot's run records (the host
 * persisted `deadlineAt` / `lastProgressAt` / `failureKind` for exactly this purpose) and this
 * module turns one run into the one line to show.
 *
 * It is pure and DOM-free so the rules stay testable without a host: which run is "the
 * current one", how a duration reads, and how each terminal reason is worded.
 *
 * @module
 */

/**
 * The run fields the strip reads.
 *
 * Structural rather than importing `BotRun` from the core package: this module is unit-tested
 * with `node --test` and no workspace links, and a type-only import of the host package would
 * still make the test depend on its resolution. A core `BotRun` satisfies this shape, so the
 * component passes the snapshot records straight through.
 */
export interface RunView {
  readonly id: string
  readonly roomId: string
  readonly status: string
  readonly createdAt?: string | undefined
  readonly updatedAt?: string | undefined
  readonly startedAt?: string | undefined
  readonly finishedAt?: string | undefined
  /** Wall-clock deadline derived from the deployment's history (S8). */
  readonly deadlineAt?: string | undefined
  /** Why a failed run failed; drives the wording, never the retry (the host owns that). */
  readonly failureKind?: string | undefined
  readonly error?: string | undefined
  readonly lastError?: string | undefined
}

/** How the strip paints the line. `hidden` means "render nothing". */
export type RunStatusTone = 'running' | 'error' | 'muted' | 'hidden'

export interface RunStatusView {
  readonly tone: RunStatusTone
  readonly label: string
  /** A quieter second half — the failure reason, or the deadline countdown. */
  readonly detail?: string | undefined
}

/** Epoch ms of an ISO timestamp, or undefined when absent/unparseable. */
export function parseTimeMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * How recent a run is, for "the current run of this room".
 *
 * `updatedAt` is the host's last-write stamp and is the primary key; the other timestamps are
 * fallbacks for states where a field may be missing (a queued run has no `startedAt`, a
 * restored record may only carry `createdAt`). Taking the maximum keeps a just-settled run
 * (fresh `finishedAt`) ahead of one that merely started later.
 */
function recencyOf(run: RunView): number {
  let newest = 0
  for (const value of [run.updatedAt, run.createdAt, run.finishedAt, run.startedAt]) {
    const ms = parseTimeMs(value)
    if (ms !== undefined && ms > newest) newest = ms
  }
  return newest
}

/**
 * The room's most recent run, or undefined when the room has none.
 *
 * Deliberately by recency, not by array order: `state.runs` is append-ordered, but a retry
 * reuses/updates a run and the snapshot is a fresh array each poll. A room with only old runs
 * still answers with its newest one — the strip decides from the status whether that is worth
 * showing.
 */
export function latestRunFor(roomId: string, runs: readonly RunView[]): RunView | undefined {
  let latest: RunView | undefined
  let latestAt = Number.NEGATIVE_INFINITY
  for (const run of runs) {
    if (run.roomId !== roomId) continue
    const at = recencyOf(run)
    if (latest === undefined || at > latestAt) {
      latest = run
      latestAt = at
    }
  }
  return latest
}

/**
 * A duration as the transcript's compact notation: `45s`, `3m 12s`, `1h 5m`.
 *
 * Seconds always render below a minute, minutes above it, hours above that — the same
 * progression DSH's native timer uses, without zero-padding the leading unit.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/** Local wall-clock `HH:mm` of an ISO timestamp, or undefined when unparseable. */
export function formatClock(value: string | undefined): string | undefined {
  const ms = parseTimeMs(value)
  if (ms === undefined) return undefined
  const date = new Date(ms)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** The failure message the host attached, if any. */
function failureDetail(run: RunView): string | undefined {
  const text = (run.error ?? run.lastError ?? '').trim()
  return text === '' ? undefined : text
}

/**
 * The one line for a run.
 *
 * Several callers pass `nowMs` explicitly (the component ticks it every 30 s, tests pin it), so
 * elapsed time and the deadline countdown are a function of a clock the caller owns — never of
 * `Date.now()` read deep inside the formatter.
 */
export function formatRunStatus(run: RunView, nowMs: number): RunStatusView {
  switch (run.status) {
    case 'running': {
      // `startedAt` is stamped when the run leaves the queue; before that the creation time is
      // the only honest origin (a restored or queued-then-started run may lack it).
      const startMs = parseTimeMs(run.startedAt) ?? parseTimeMs(run.createdAt) ?? nowMs
      const elapsed = Math.max(0, nowMs - startMs)
      const deadlineMs = parseTimeMs(run.deadlineAt)
      const deadline = formatClock(run.deadlineAt)
      const parts = ['运行中', `已用 ${formatDuration(elapsed)}`]
      if (deadline !== undefined) parts.push(`预计截止 ${deadline}`)
      const detail = deadlineMs === undefined
        ? undefined
        : deadlineMs > nowMs
          ? `剩余 ${formatDuration(deadlineMs - nowMs)}`
          : '已到预计截止，仍在运行'
      return { tone: 'running', label: parts.join(' · '), ...(detail !== undefined ? { detail } : {}) }
    }
    case 'queued': {
      const sinceMs = parseTimeMs(run.createdAt) ?? nowMs
      return { tone: 'muted', label: `排队中 · 已等待 ${formatDuration(Math.max(0, nowMs - sinceMs))}` }
    }
    case 'failed': {
      const detail = failureDetail(run)
      switch (run.failureKind) {
        case 'timeout':
          return { tone: 'error', label: '运行超时已停止', ...(detail !== undefined ? { detail } : {}) }
        case 'no-progress':
          return { tone: 'error', label: '无进展已停止', ...(detail !== undefined ? { detail } : {}) }
        case 'user-cancel':
          return { tone: 'muted', label: '已停止', ...(detail !== undefined ? { detail } : {}) }
        default:
          return { tone: 'error', label: '运行失败', ...(detail !== undefined ? { detail } : {}) }
      }
    }
    case 'interrupted':
    case 'cancelled': {
      const detail = failureDetail(run)
      return { tone: 'muted', label: '已停止', ...(detail !== undefined ? { detail } : {}) }
    }
    case 'completed':
      return { tone: 'hidden', label: '' }
    default:
      // An unknown status is not evidence of a problem; stay silent rather than guess.
      return { tone: 'hidden', label: '' }
  }
}
