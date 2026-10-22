/**
 * Unit tests for the ledger's change cursor (core/ledger.ts) and the UI merge that
 * consumes it (client/conversation/ledgerWindow.ts).
 *
 * THE BUG THESE COVER. A turn reserves its answer row when the run STARTS (small
 * `sequence`) and writes the final text/duration when it settles (a PATCH — sequence
 * stays put). The panel polled with `changedAfterSequence`, which can only deliver new
 * rows, so the settled reply never arrived: the transcript showed the work steps but no
 * answer. `changeSeq` is bumped by every push and every patch, and
 * `listLedger({ changedAfterChangeSeq })` delivers a patched row regardless of how old
 * its sequence is. The UI merge/cursor helpers are asserted here too, because they are
 * what the panel actually runs.
 *
 * Run with: node --test tests/ledger-cursor.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { LedgerProjector } from '../packages/core/agent-community/src/ledger.ts'
import {
  ledgerCursor,
  mergeLedgerEntries,
} from '../packages/ui/ui-agent-community/src/client/conversation/ledgerWindow.ts'
import type { LedgerEntry } from '../packages/ui/ui-agent-community/src/client/conversation/types.ts'

// `ledger.ts` allocates ids through `require('node:crypto')` (the shipped bundle supplies a
// `createRequire` shim; Node's type stripping does not), so provide the global for this file.
;(globalThis as typeof globalThis & { require?: NodeRequire }).require
  ??= createRequire(import.meta.url)

const ROOM = 'room-1'
const BOT = 'bot-1'

function projector(): LedgerProjector {
  return new LedgerProjector({ getBot: () => ({ name: '小董' }) })
}

function iso(offsetMs: number): string {
  return new Date(Date.parse('2026-10-22T00:00:00.000Z') + offsetMs).toISOString()
}

test('a patched row below the sequence cursor is delivered by the change cursor', () => {
  const ledger = projector()
  ledger.push({ type: 'user', roomId: ROOM as never, text: 'go', senderName: '老板', at: iso(0) } as never)
  const liveId = ledger.reserveLiveRow(ROOM, BOT, '小董', 'run-1')
  ledger.push({
    type: 'tool-call',
    roomId: ROOM as never,
    botId: BOT as never,
    botName: '小董',
    runId: 'run-1' as never,
    callId: 'call-1',
    name: 'bash',
    args: '{}',
    at: iso(1_000),
  } as never)
  // What the panel holds, and the cursor it derived from it.
  const before = ledger.listLedger(ROOM, { force: true })
  const cursor = ledgerCursor(before)
  assert.equal(typeof cursor.changeSeq, 'number', 'the host now reports changeSeq')

  // The turn settles: the SAME row (sequence unchanged, below the tool row) is patched.
  ledger.patch(liveId, ROOM, { text: 'final answer', streaming: false, durationMs: 1_234 } as never)
  const answer = ledger.listLedger(ROOM, { force: true }).find(row => row.id === liveId)!
  assert.equal(answer.sequence, before.find(row => row.id === liveId)!.sequence, 'patch never moves sequence')
  assert.ok(answer.changeSeq > (before.find(row => row.id === liveId)!.changeSeq ?? 0), 'patch bumps changeSeq')

  // The old cursor cannot see it (its sequence is below the tool row's)...
  const bySequence = ledger.listLedger(ROOM, { changedAfterSequence: cursor.sequence })
  assert.equal(bySequence.some(row => row.id === liveId), false, 'sequence cursor misses the patched answer')
  // ...the change cursor does, with the settled text and the duration.
  const byChange = ledger.listLedger(ROOM, { changedAfterChangeSeq: cursor.changeSeq })
  const delivered = byChange.find(row => row.id === liveId)
  assert.ok(delivered !== undefined, 'change cursor delivers the patched row')
  assert.equal((delivered as { text?: string }).text, 'final answer')
  assert.equal((delivered as { durationMs?: number }).durationMs, 1_234)
})

test('settleRunEntries bumps changeSeq, so the duration/streaming flip reaches the client', () => {
  const ledger = projector()
  const liveId = ledger.reserveLiveRow(ROOM, BOT, '小董', 'run-2')
  const before = ledger.listLedger(ROOM, { force: true })
  const cursor = ledgerCursor(before)
  assert.ok(ledger.settleRunEntries('run-2', ROOM as never, 4_321) > 0)
  const delivered = ledger.listLedger(ROOM, { changedAfterChangeSeq: cursor.changeSeq! })
  const row = delivered.find(entry => entry.id === liveId)
  assert.ok(row !== undefined, 'settled row is within the change page')
  assert.equal((row as { streaming?: boolean }).streaming, false)
  assert.equal((row as { durationMs?: number }).durationMs, 4_321)
})

test('a stale cursor above the projector counter falls back to the newest page', () => {
  const ledger = projector()
  for (let i = 0; i < 5; i += 1) {
    ledger.push({ type: 'dispatch', roomId: ROOM as never, text: `n${i}`, at: iso(i) } as never)
  }
  const page = ledger.listLedger(ROOM, { changedAfterChangeSeq: 9_999, limit: 3 })
  assert.equal(page.length, 3)
  assert.deepEqual(page.map(row => (row as { text?: string }).text), ['n2', 'n3', 'n4'])
})

test('the change cursor returns the newest page, not the oldest, when many rows moved', () => {
  const ledger = projector()
  for (let i = 0; i < 40; i += 1) {
    ledger.push({ type: 'dispatch', roomId: ROOM as never, text: `n${i}`, at: iso(i) } as never)
  }
  const page = ledger.listLedger(ROOM, { changedAfterChangeSeq: 1, limit: 5 })
  assert.deepEqual(page.map(row => (row as { text?: string }).text), ['n35', 'n36', 'n37', 'n38', 'n39'])
})

test('a seeded room is ordered by time after merging with live rows', () => {
  const ledger = projector()
  ledger.push({
    type: 'bot-text',
    roomId: ROOM as never,
    botId: BOT as never,
    botName: '小董',
    runId: 'run-live' as never,
    text: 'live answer',
    streaming: false,
    at: iso(3_000),
  } as never)
  ledger.seedRoom(ROOM as never, [
    { id: 'm1', at: iso(0), kind: 'user', senderName: '老板', text: 'hello' },
    { id: 'm2', at: iso(1_000), kind: 'bot', senderName: '小董', text: 'hi', runId: 'run-old' },
    { id: 'm3', at: iso(2_000), kind: 'notice', senderName: '', text: 'notice' },
  ])
  const rows = ledger.listLedger(ROOM, { force: true, limit: 10 })
  const times = rows.map(row => Date.parse(row.at))
  const sorted = [...times].sort((a, b) => a - b)
  assert.deepEqual(times, sorted, 'the array the panel pages through is chronological')
  assert.equal(rows.some(row => (row as { text?: string }).text === 'live answer'), true, 'the live row survives the seed')
})

// ── UI half: the merge and the cursor the panel sends ─────────────────────────

function row(id: string, sequence: number, extra: Partial<LedgerEntry & { changeSeq?: number }> = {}): LedgerEntry {
  return {
    id,
    type: 'bot-text',
    roomId: ROOM,
    at: iso(sequence * 1_000),
    sequence,
    rev: 1,
    ...extra,
  } as LedgerEntry
}

test('ledgerCursor takes the MAX changeSeq and sequence, not the last row of the window', () => {
  const rows = [
    { ...row('a', 9), changeSeq: 3 },
    { ...row('b', 4), changeSeq: 12 },
    { ...row('c', 7), changeSeq: 8 },
  ] as LedgerEntry[]
  const cursor = ledgerCursor(rows)
  assert.equal(cursor.changeSeq, 12)
  assert.equal(cursor.sequence, 9)
})

test('the merge applies a patched old row (higher changeSeq, same sequence) and keeps one copy', () => {
  const live = { ...row('answer', 2), changeSeq: 2, streaming: true, text: '' } as LedgerEntry
  let window: LedgerEntry[] = mergeLedgerEntries([], [live])
  assert.equal(window.length, 1)
  const settled = { ...row('answer', 2), changeSeq: 5, streaming: false, text: 'final', rev: 2 } as LedgerEntry
  window = mergeLedgerEntries(window, [settled])
  assert.equal(window.length, 1, 'merged by id, not appended')
  assert.equal((window[0] as { text?: string }).text, 'final')
  assert.equal(ledgerCursor(window).changeSeq, 5)
  // A duplicate re-send of the same copy must not create a new array (no re-render storm).
  const same = mergeLedgerEntries(window, [settled])
  assert.equal(same, window, 'identical page returns the same reference')
})

test('an older host without changeSeq still merges by rev and falls back to the sequence cursor', () => {
  const live = row('answer', 2, { rev: 1 })
  let window: LedgerEntry[] = mergeLedgerEntries([], [live])
  const settled = row('answer', 2, { rev: 2, text: 'final' })
  window = mergeLedgerEntries(window, [settled])
  assert.equal((window[0] as { text?: string }).text, 'final')
  const cursor = ledgerCursor(window)
  assert.equal(cursor.changeSeq, undefined, 'no changeSeq on the wire → compatibility cursor')
  assert.equal(cursor.sequence, 2)
})
