/**
 * LedgerWindow — the pure half of the transcript's paging rules.
 *
 * The panel renders a WINDOW of a room's ledger: the first screen is the newest
 * `PAGE_SIZE` rows, "load earlier" pages backwards from it, and the incremental tick
 * advances a `sequence` cursor. That window is not turn-aligned, and the turn is
 * built asymmetrically:
 *
 *   · the answer row is reserved when the run STARTS (runs.ts `reserveLiveRow`), so
 *     its `sequence` is the smallest of the turn;
 *   · its reasoning/tool rows stream in AFTERWARDS (higher `sequence`);
 *   · the run settling only patches the answer row — `sequence` never moves, `rev`
 *     is what grows.
 *
 * A tool-heavy turn therefore pushes its own answer row out of the newest page, and
 * the incremental cursor (`changedAfterSequence` → rows at or after the newest
 * sequence the client holds) can never fetch a row below it. The reader saw the
 * turn's work steps but no reply, until 「加载更早」 asked for `beforeSequence`.
 *
 * These helpers are pure and DOM-free so the merge/backfill rules can be tested
 * without React: the panel owns the RPCs and the state, and asks these functions
 * what to keep, what is missing, and which page to fetch next.
 *
 * @module
 */
import type { LedgerEntry } from './types.ts'

/** Run statuses that can no longer produce ledger rows. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

/**
 * How many of the newest terminal runs the missing-answer check considers.
 *
 * Every room keeps its whole run history, and old runs whose answer row was never
 * persisted (a silent turn, a failed attempt) would otherwise be reported as
 * "missing" for ever, walking pages the answer can never be on. The first screen can
 * only be missing an answer of a run that is still recent, so five is plenty and
 * keeps a mount bounded.
 */
export const MISSING_RUN_WINDOW = 5

/** The minimum a host run record must expose for {@link missingAnswerRunIds}. */
export interface RunStatusLike {
  readonly id: string
  readonly status: string
}

/** The cursor for one backwards page; matches the panel's listLedger options. */
export interface BackfillCursor {
  readonly beforeSequence: number
  readonly limit: number
}

/**
 * The forward cursor the incremental poll sends.
 *
 * `changeSeq` is the room-wide change counter (bumped by every host push AND every
 * in-place patch). `sequence` is only the fallback for a host that does not report
 * `changeSeq` yet (an older build): it can express "new rows", never "rows that
 * changed", so a patched reply below it would never be re-delivered.
 */
export interface LedgerCursor {
  /** Highest `changeSeq` in the held window, or undefined when no row carries one. */
  readonly changeSeq?: number | undefined
  /** Highest `sequence` in the held window — the compatibility cursor. */
  readonly sequence: number
}

/** A row's `rev`, treating a missing/NaN value as 0 so ordering is total. */
function revisionOf(entry: LedgerEntry): number {
  const rev = entry.rev
  return typeof rev === 'number' && Number.isFinite(rev) ? rev : 0
}

/**
 * A row's global `changeSeq`, 0 when the host did not report one.
 *
 * The client's `LedgerEntry` type does not declare the field on purpose (it is optional
 * on the wire and the panel must keep working against an older host), so it is read
 * structurally here rather than added to the shared type.
 */
function changeSeqOf(entry: LedgerEntry): number {
  const value = (entry as LedgerEntry & { readonly changeSeq?: number }).changeSeq
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Epoch ms of a row's `at`, 0 when it is missing or unparseable. */
function timeOf(entry: LedgerEntry): number {
  const at = Date.parse(entry.at)
  return Number.isFinite(at) ? at : 0
}

/**
 * The incremental poll's cursor: the highest `changeSeq` held, plus the highest
 * `sequence` as the fallback for hosts that do not report `changeSeq`.
 *
 * The panel used to derive the cursor from the LAST row of the window, which is the
 * newest by event time, not by counter — after a re-seed mixed the two, the last row was
 * not the greatest sequence. Taking the max is the only value that cannot move backwards.
 */
export function ledgerCursor(entries: readonly LedgerEntry[]): LedgerCursor {
  let changeSeq: number | undefined
  let sequence = 0
  for (const entry of entries) {
    const change = changeSeqOf(entry)
    if (change > 0 && (changeSeq === undefined || change > changeSeq)) changeSeq = change
    if (typeof entry.sequence === 'number' && Number.isFinite(entry.sequence) && entry.sequence > sequence) {
      sequence = entry.sequence
    }
  }
  return changeSeq === undefined ? { sequence } : { changeSeq, sequence }
}

/**
 * The transcript's one ordering: event time first, ledger sequence second.
 *
 * `sequence` alone is not safe — it is a ledger-internal counter, and a re-seed
 * renumbers rows, which once sorted a tool row above the user message that preceded
 * it. `at` alone is not enough either: a seeded turn gives every row of one message
 * the same timestamp, so the second key is what keeps its reasoning → tools → answer
 * order. The id is the final tiebreaker so the comparator is a total order.
 */
function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  const byTime = timeOf(a) - timeOf(b)
  if (byTime !== 0) return byTime
  if (a.sequence !== b.sequence) return a.sequence - b.sequence
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Merge a fetched page into the window the panel already holds.
 *
 * Merge by id, never replace: the same row legitimately arrives many times (the
 * incremental cursor is inclusive, "load earlier" pages can overlap after a
 * re-seed, and a settled run re-sends its rows with fresh sequence numbers). A hard
 * replace used to reorder the whole transcript in one commit — the visible flash
 * and the duplicated row.
 *
 * Which copy wins: `changeSeq` when both copies carry one (the host bumps it on every
 * push AND every in-place patch), otherwise `rev` (bumped on every in-place update).
 * Either way a greater value is a strictly newer copy; an equal or lower one would
 * either regress the transcript or change nothing. When no row was added or updated the
 * SAME array reference is returned: the panel's poll runs up to 4×/s and a fresh array
 * would re-render the whole transcript on every tick.
 */
export function mergeLedgerEntries(
  prev: LedgerEntry[],
  incoming: readonly LedgerEntry[],
): LedgerEntry[] {
  if (incoming.length === 0) return prev
  const byId = new Map<string, LedgerEntry>()
  for (const entry of prev) byId.set(entry.id, entry)
  let changed = false
  for (const entry of incoming) {
    const before = byId.get(entry.id)
    if (before === undefined) {
      byId.set(entry.id, entry)
      changed = true
      continue
    }
    const incomingChange = changeSeqOf(entry)
    const beforeChange = changeSeqOf(before)
    // A `changeSeq` on either side means the host supports the change cursor, and the
    // higher one is newer. Both zero means an older host: fall back to `rev`.
    const newer = incomingChange !== 0 || beforeChange !== 0
      ? incomingChange > beforeChange
      : revisionOf(entry) > revisionOf(before)
    if (newer) {
      byId.set(entry.id, entry)
      changed = true
    }
  }
  if (!changed) return prev
  return Array.from(byId.values()).sort(compareEntries)
}

/**
 * Terminal runs whose answer row is not in the held window.
 *
 * The answer row is a `bot-text` row carrying the run id; its absence is the
 * signature of the window bug (the row is older than the newest page). Only the
 * newest {@link MISSING_RUN_WINDOW} terminal runs are considered — see the note on
 * that constant. Runs still running/queued are skipped: their row may not exist yet,
 * and their absence is not a defect.
 *
 * A failed run that produced no answer text has no `bot-text` row at all and will be
 * reported once per mount; the panel remembers which runs it already walked, so that
 * costs at most one bounded backfill attempt.
 */
export function missingAnswerRunIds(
  entries: readonly LedgerEntry[],
  runs: readonly RunStatusLike[],
  limit: number = MISSING_RUN_WINDOW,
): string[] {
  const terminal = runs.filter(run => TERMINAL_RUN_STATUSES.has(run.status))
  const recent = limit > 0 ? terminal.slice(-limit) : terminal
  if (recent.length === 0) return []
  const answered = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'bot-text' && entry.runId !== undefined) answered.add(entry.runId)
  }
  const missing: string[] = []
  for (const run of recent) {
    if (!answered.has(run.id)) missing.push(run.id)
  }
  return missing
}

/**
 * The next backwards page, or undefined when there is nowhere further back to go.
 *
 * `entries` must be in the window's order (oldest first, as {@link mergeLedgerEntries}
 * returns): its first row is the oldest and therefore has the smallest `sequence`
 * among the loaded rows, which is exactly the exclusive bound the host pages on.
 */
export function nextBackfillPage(
  entries: readonly LedgerEntry[],
  pageSize: number,
): BackfillCursor | undefined {
  const oldest = entries[0]
  if (oldest === undefined) return undefined
  const beforeSequence = oldest.sequence
  if (typeof beforeSequence !== 'number' || !Number.isFinite(beforeSequence)) return undefined
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined
  return { beforeSequence, limit: Math.floor(pageSize) }
}
