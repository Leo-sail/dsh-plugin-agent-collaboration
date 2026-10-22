/**
 * Unit tests for the ledger window rules (conversation/ledgerWindow.ts).
 *
 * These reproduce the transcript bug the window fix is about, without React and
 * without a host: a tool-heavy turn reserves its answer row first (smallest
 * `sequence`) and appends tool rows after it, so the newest page can end before the
 * answer. The pure functions must then (a) notice the missing answer, (b) hand back
 * the cursor for the next backwards page, and (c) never duplicate a row while doing
 * it.
 *
 * Run with: node --test tests/ledger-window.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MISSING_RUN_WINDOW,
  mergeLedgerEntries,
  missingAnswerRunIds,
  nextBackfillPage,
} from '../packages/ui/ui-agent-community/src/client/conversation/ledgerWindow.ts'
import type { LedgerEntry } from '../packages/ui/ui-agent-community/src/client/conversation/types.ts'
import type { RunStatusLike } from '../packages/ui/ui-agent-community/src/client/conversation/ledgerWindow.ts'

const PAGE_SIZE = 50
const BASE_MS = Date.parse('2026-10-22T00:00:00.000Z')

/** Stable ISO timestamp `offsetMs` after the fixture epoch. */
function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString()
}

/** A minimal ledger row; every field the window rules read is explicit. */
function entry(
  id: string,
  sequence: number,
  at: string,
  extra: Partial<LedgerEntry> = {},
): LedgerEntry {
  return {
    id,
    type: 'tool-call',
    roomId: 'room-1',
    at,
    sequence,
    ...extra,
  }
}

/** One bot turn in LIVE ledger order: user → answer row → tool rows. */
function toolHeavyTurn(runId: string, tools: number): LedgerEntry[] {
  const rows: LedgerEntry[] = [entry('user-1', 1, iso(0), { type: 'user', text: 'go' })]
  // The answer row is RESERVED when the run starts: smallest sequence of the turn.
  rows.push(entry('answer-1', 2, iso(1_000), {
    type: 'bot-text',
    runId,
    text: '',
    streaming: true,
    rev: 1,
  }))
  for (let i = 0; i < tools; i++) {
    rows.push(entry(`tool-${i}`, 3 + i, iso(2_000 + i), {
      type: 'tool-call',
      runId,
      callId: `call-${i}`,
      rev: 1,
    }))
  }
  // The settle patches the SAME row in place: sequence never moves, rev grows.
  rows[1] = { ...rows[1]!, text: 'final answer', streaming: false, rev: 2 }
  return rows
}

/** Exactly what `LedgerStore.listLedger({ beforeSequence, limit })` returns. */
function hostBackPage(rows: readonly LedgerEntry[], beforeSequence: number, limit: number): LedgerEntry[] {
  return rows.filter(row => row.sequence < beforeSequence).slice(-limit)
}

// ── the bug: the answer row is behind the newest page ─────────────────────────

test('a reply 60 rows behind the newest page is detected as missing, then found by paging back', () => {
  const rows = toolHeavyTurn('run-1', 60) // 62 rows: answer row at index 1, 60 rows after it
  const runs: RunStatusLike[] = [{ id: 'run-1', status: 'completed' }]

  // First screen = the newest PAGE_SIZE rows (what loadInitial asks for).
  let window: LedgerEntry[] = mergeLedgerEntries([], rows.slice(-PAGE_SIZE))
  assert.equal(window.length, PAGE_SIZE)
  assert.equal(window.some(row => row.id === 'answer-1'), false, 'answer row is not on the first page')
  assert.deepEqual(missingAnswerRunIds(window, runs), ['run-1'])

  // One backwards page from the oldest loaded row is enough for this turn.
  const cursor = nextBackfillPage(window, PAGE_SIZE)
  assert.ok(cursor !== undefined)
  assert.equal(cursor.beforeSequence, rows[12]!.sequence)
  window = mergeLedgerEntries(window, hostBackPage(rows, cursor.beforeSequence, cursor.limit))

  assert.equal(window.length, rows.length, 'every row merged exactly once')
  assert.equal(window.some(row => row.id === 'answer-1'), true)
  assert.equal(window.find(row => row.id === 'answer-1')?.text, 'final answer')
  assert.deepEqual(missingAnswerRunIds(window, runs), [])
})

test('an 89-tool turn is recovered within the backfill page budget and keeps one row per id', () => {
  // 91 rows here; in the real ledger each tool writes a call AND a result row, so an
  // 89-tool turn reserves its answer ~180 rows behind the newest page.
  const rows = toolHeavyTurn('run-1', 89)
  const runs: RunStatusLike[] = [{ id: 'run-1', status: 'completed' }]
  const MAX_BACKFILL_PAGES = 8

  let window: LedgerEntry[] = mergeLedgerEntries([], rows.slice(-PAGE_SIZE))
  assert.deepEqual(missingAnswerRunIds(window, runs), ['run-1'])

  let pages = 0
  while (missingAnswerRunIds(window, runs).length > 0 && pages < MAX_BACKFILL_PAGES) {
    const cursor = nextBackfillPage(window, PAGE_SIZE)
    if (cursor === undefined) break
    const page = hostBackPage(rows, cursor.beforeSequence, cursor.limit)
    if (page.length === 0) break
    window = mergeLedgerEntries(window, page)
    pages += 1
  }
  assert.ok(pages <= MAX_BACKFILL_PAGES, `needed ${pages} pages`)
  assert.equal(missingAnswerRunIds(window, runs).length, 0)
  // Idempotent merge: replaying the same pages must not duplicate anything.
  const replayed = mergeLedgerEntries(window, [...rows].reverse())
  assert.equal(replayed.length, rows.length)
  assert.equal(new Set(replayed.map(row => row.id)).size, rows.length)
})

test('a re-seeded turn whose rows arrive with fresh sequence numbers still merges by id', () => {
  const rows = toolHeavyTurn('run-1', 30)
  const held = mergeLedgerEntries([], rows.slice(-PAGE_SIZE))
  // Re-seed: same ids, same content, DIFFERENT (bigger) sequence numbers and rev.
  const reseeded = rows.map(row => ({ ...row, sequence: row.sequence + 1_000, rev: (row.rev ?? 1) + 1 }))
  const merged = mergeLedgerEntries(held, reseeded)
  assert.equal(merged.length, rows.length)
  assert.equal(merged.find(row => row.id === 'answer-1')?.rev, 3)
  assert.equal(merged.some(row => row.id === 'answer-1'), true)
})

// ── rev / dedupe semantics ────────────────────────────────────────────────────

test('a greater rev wins and a stale copy never regresses a row', () => {
  const at = iso(1_000)
  const held = mergeLedgerEntries([], [entry('row-a', 1, at, { rev: 1, text: 'v1' })])
  assert.equal(held.length, 1)

  const updated = mergeLedgerEntries(held, [entry('row-a', 1, at, { rev: 2, text: 'v2' })])
  assert.notEqual(updated, held)
  assert.equal(updated[0]!.text, 'v2')

  const stale = mergeLedgerEntries(updated, [entry('row-a', 1, at, { rev: 1, text: 'old' })])
  assert.equal(stale, updated, 'no change returns the SAME array reference')
  assert.equal(stale[0]!.text, 'v2')
})

test('duplicate ids inside one page keep the newest copy only', () => {
  const at = iso(1_000)
  const merged = mergeLedgerEntries([], [
    entry('dup', 1, at, { rev: 1, text: 'first' }),
    entry('dup', 1, at, { rev: 2, text: 'second' }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.text, 'second')
})

test('merging the newest page twice does not change the array reference', () => {
  const rows = toolHeavyTurn('run-1', 10)
  const first = mergeLedgerEntries([], rows)
  assert.equal(mergeLedgerEntries(first, rows), first)
  assert.equal(mergeLedgerEntries(first, []), first)
})

// ── ordering ─────────────────────────────────────────────────────────────────

test('rows order by at, then sequence; a missing at sorts by sequence only', () => {
  const at = iso(5_000)
  const merged = mergeLedgerEntries([], [
    entry('late-seq', 9, at),
    entry('early-seq', 4, at), // same `at` (seeded turn) → sequence decides
    entry('no-at', 7, ''),
    entry('older', 1, iso(1_000)),
  ])
  assert.deepEqual(merged.map(row => row.id), ['no-at', 'older', 'early-seq', 'late-seq'])
})

// ── missing-answer detection ────────────────────────────────────────────────

test('only terminal runs are reported, and only the newest window of them', () => {
  const entries = [entry('answer-r3', 1, iso(1_000), { type: 'bot-text', runId: 'r3' })]
  const runs: RunStatusLike[] = [
    { id: 'r1', status: 'completed' }, // oldest terminal — outside the window
    { id: 'r2', status: 'completed' },
    { id: 'r3', status: 'completed' }, // has its answer row
    { id: 'r4', status: 'running' }, // not terminal — ignored
    { id: 'r4b', status: 'queued' }, // not terminal — ignored
    { id: 'r5', status: 'failed' },
    { id: 'r6', status: 'cancelled' },
    { id: 'r7', status: 'interrupted' },
  ]
  assert.equal(MISSING_RUN_WINDOW, 5)
  assert.deepEqual(missingAnswerRunIds(entries, runs), ['r2', 'r5', 'r6', 'r7'])
  assert.deepEqual(
    missingAnswerRunIds(entries, runs, 10),
    ['r1', 'r2', 'r5', 'r6', 'r7'],
    'a wider window reaches further back',
  )
  assert.deepEqual(
    missingAnswerRunIds(entries, runs, 0),
    ['r1', 'r2', 'r5', 'r6', 'r7'],
  )
  assert.deepEqual(missingAnswerRunIds(entries, []), [])
})

// ── backfill cursor ─────────────────────────────────────────────────────────

test('the backfill cursor is the oldest held sequence; empty window has none', () => {
  assert.equal(nextBackfillPage([], PAGE_SIZE), undefined)
  const window = [
    entry('old', 13, iso(1_000)),
    entry('new', 14, iso(2_000)),
  ]
  assert.deepEqual(nextBackfillPage(window, PAGE_SIZE), { beforeSequence: 13, limit: PAGE_SIZE })
  assert.equal(nextBackfillPage([entry('x', 13, iso(0))], 0), undefined)
  assert.equal(nextBackfillPage([entry('x', 13, iso(0))], Number.NaN), undefined)
})
