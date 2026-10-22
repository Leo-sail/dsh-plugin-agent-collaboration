/**
 * Unit tests for the plugin's compaction fold (core/compact.ts) and for the way a
 * compaction checkpoint reaches the panel (core/ledger.ts `seedRoom`).
 *
 * THE BUG THESE COVER. `compactRoom` reported `compacted: true` while nothing was folded:
 * `foldedIds` was recomputed as `message.createdAt < summaryMessage.createdAt`, but the
 * summary is deliberately stamped with the OLDEST replaced message's time (so the panel
 * sorts the checkpoint where the replaced messages were) — the two conditions can never
 * both hold, so the prompt kept replaying every message the summary had replaced. The
 * split already knows exactly which messages were replaced; `foldedMessageIds(older)` is
 * that answer.
 *
 * `windowForPrompt` is the same rule the production prompt applies: `buildPrompt`
 * (runs.ts) filters `room.foldedSeqs` (now exactly `older.map(id)`) out of the message list
 * before `buildHistoryWindow`, so the fold set proved here is the one the model sees.
 *
 * The second half is the panel: the summary message has no runId, and `seedRoom`'s
 * "a bot message without a runId is a coordination post, never render it" rule skipped
 * it, so a compressed room looked untouched. It is seeded as an explicit `actor:
 * 'summary'` item and renders as the same grey `dispatch` divider a durable notice uses.
 *
 * Run with: node --test tests/compact-fold.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  foldedMessageIds,
  splitForCompaction,
  summaryMessageText,
  summarySeedItem,
  windowForPrompt,
} from '../packages/core/agent-community/src/compact.ts'
import { LedgerProjector, type SeedRoomItem } from '../packages/core/agent-community/src/ledger.ts'

// `ledger.ts` allocates ids through `require('node:crypto')` (the shipped bundle supplies a
// `createRequire` shim; Node's type stripping does not), so provide the global for this file.
;(globalThis as typeof globalThis & { require?: NodeRequire }).require
  ??= createRequire(import.meta.url)

const BASE_MS = Date.parse('2026-10-22T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(BASE_MS + offsetMs).toISOString()

interface Message {
  readonly id: string
  readonly at: string
  readonly text: string
}

/** A room's messages in stored (append) order. */
function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    at: iso(i * 60_000),
    text: `消息 ${i + 1}`,
  }))
}

/** What `compactRoom` persists for a summary: no runId, kind summary, oldest replaced time. */
function summaryMessage(id: string, older: readonly Message[], summary: string): Message {
  return { id, at: older[0]!.at, text: summaryMessageText(older.length, summary) }
}

test('the fold set is exactly the older segment the split chose (never a timestamp guess)', () => {
  const room = messages(12)
  const { older, tail } = splitForCompaction(room, 4)
  assert.equal(older.length, 8)
  assert.equal(tail.length, 4)
  assert.deepEqual(foldedMessageIds(older), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'])

  // The old rule: `createdAt < summary.createdAt`, where the summary carries older[0]'s time.
  const summary = summaryMessage('s1', older, '摘要正文')
  const timestampGuess = room.filter(m => m.at < summary.at).map(m => m.id)
  assert.deepEqual(timestampGuess, [], 'the timestamp rule produced an EMPTY fold set — the bug')
})

test('the folded window drops every replaced message and keeps the summary plus the tail', () => {
  const room = messages(12)
  const { older, tail } = splitForCompaction(room, 4)
  const summary = summaryMessage('s1', older, '摘要正文')
  const folded = foldedMessageIds(older)
  // `compactRoom` APPENDS the checkpoint; the prompt window sees it as the newest row.
  const stored = [...room, summary]
  const window = windowForPrompt(stored, folded, 10)

  assert.deepEqual(window.map(m => m.id), ['m9', 'm10', 'm11', 'm12', 's1'])
  for (const replaced of older) {
    assert.equal(window.some(m => m.id === replaced.id), false, `${replaced.id} must not reach the prompt`)
  }
  assert.equal(window.some(m => m.id === 's1'), true, 'the checkpoint is inside the window')
  assert.equal(window.some(m => m.text.includes('摘要正文')), true, 'its text reaches the model')
  // The tail is kept verbatim, in order.
  assert.deepEqual(window.filter(m => m.id !== 's1').map(m => m.id), tail.map(m => m.id))
})

test('a second compaction folds the first checkpoint once it has left the tail', () => {
  const room = messages(12)
  const first = splitForCompaction(room, 4)
  const summary1 = summaryMessage('s1', first.older, '第一份摘要')
  // Six new messages arrive; the first checkpoint is now part of the older segment.
  const later = [
    ...room,
    summary1,
    ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i + 1}`, at: iso((12 + i) * 60_000), text: `新消息 ${i + 1}` })),
  ]
  const second = splitForCompaction(later, 4)
  const folded = foldedMessageIds(second.older)
  const summary2 = summaryMessage('s2', second.older, '第二份摘要')

  assert.equal(folded.includes('s1'), true, 'the previous checkpoint is folded by the next one')
  assert.equal(folded.includes('s2'), false, 'a summary never folds itself')

  const window = windowForPrompt([...later, summary2], folded, 10)
  assert.equal(window.some(m => m.id === 's1'), false, 'the stale checkpoint is gone from the prompt')
  assert.equal(window.some(m => m.id === 's2'), true, 'the newest checkpoint is in the prompt')
  for (const replaced of second.older) {
    assert.equal(window.some(m => m.id === replaced.id), false)
  }
})

test('the summary text says how much it replaced and keeps the summary verbatim', () => {
  const text = summaryMessageText(8, '要点A\n要点B')
  assert.equal(text.startsWith('以下是此前 8 条消息的压缩摘要'), true)
  assert.equal(text.includes('要点A'), true)
  assert.equal(text.includes('要点B'), true)
})

// ── the panel half: the checkpoint must survive `seedRoom` ────────────────────

const ROOM = 'room-1'

function projector(): LedgerProjector {
  return new LedgerProjector({ getBot: () => ({ name: '小董' }) })
}

/** What `maintenance.seedLedgerRoom` emits for the same room. */
function seedItems(checkpointText = '摘要正文'): SeedRoomItem[] {
  return [
    { id: 'm1', at: iso(0), kind: 'user', senderName: '老板', text: '整理一下' },
    { id: 'm2', at: iso(60_000), kind: 'bot', senderName: '小董', text: '好的', runId: 'run-1' },
    // Exactly what `seedLedgerRoom` produces for a `kind: 'summary'` message.
    summarySeedItem({ id: 's1', createdAt: iso(120_000), text: checkpointText, senderName: '压缩摘要' }),
  ]
}

test('the summary seed item marks the checkpoint so seedRoom cannot treat it as chat', () => {
  const item = summarySeedItem({
    id: 's1',
    createdAt: iso(120_000),
    text: '摘要正文',
    senderName: '压缩摘要',
  })
  assert.equal(item.id, 's1', 'the row id is the summary MESSAGE id (stable across rebuilds)')
  assert.equal(item.kind, 'notice')
  assert.equal(item.actor, 'summary')
  assert.equal(item.text, '摘要正文')
  assert.equal(item.at, iso(120_000))
})

test('a summary item becomes ONE dispatch row, and a repeated seed does not duplicate it', () => {
  const ledger = projector()
  assert.equal(ledger.seedRoom(ROOM, seedItems()), 3)
  let rows = ledger.listLedger(ROOM, { force: true, limit: 10 })
  const dispatch = rows.filter(row => row.type === 'dispatch')
  assert.equal(dispatch.length, 1, 'the checkpoint renders as a system row')
  assert.equal(dispatch[0]!.id, 's1')
  assert.equal((dispatch[0] as { text?: string }).text, '摘要正文')
  assert.equal(rows.some(row => row.type === 'user'), true, 'the originals stay visible')
  assert.equal(rows.some(row => row.type === 'bot-text'), true)

  // The panel/`compactRoom` may rebuild the same room again; one row per message id.
  assert.equal(ledger.seedRoom(ROOM, seedItems()), 3)
  rows = ledger.listLedger(ROOM, { force: true, limit: 10 })
  assert.equal(rows.length, 3, 'no duplicated rows after a rebuild')
  assert.equal(rows.filter(row => row.id === 's1').length, 1)
  assert.equal(rows.filter(row => row.type === 'dispatch').length, 1)
})

test('duplicate summary items in one seed collapse to one row', () => {
  const ledger = projector()
  const items = [...seedItems(), seedItems()[2]!]
  assert.equal(ledger.seedRoom(ROOM, items), 3)
  const rows = ledger.listLedger(ROOM, { force: true, limit: 10 })
  assert.equal(rows.filter(row => row.id === 's1').length, 1)
})

test('without the `summary` actor a runId-less bot message is still a coordination post', () => {
  // This is the rule that hid the checkpoint: the SAME message, only without the actor.
  const ledger = projector()
  ledger.seedRoom(ROOM, [
    { id: 'm2', at: iso(0), kind: 'bot', senderName: '小董', text: '协调消息', runId: undefined },
    { id: 's1', at: iso(60_000), kind: 'bot', senderName: '压缩摘要', text: '摘要正文' },
  ])
  assert.deepEqual(ledger.listLedger(ROOM, { force: true, limit: 10 }), [])
})
