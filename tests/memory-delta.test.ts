/**
 * Unit tests for the memory partition's stable entry ids (core/memory-store.ts) and the
 * delta block that consumes them (core/bot-memory.ts).
 *
 * THE BUG THESE COVER. Entry ids used to be positional — `${at}#${index}` — and the
 * partition is capped at 12 entries: once full, every append trims the oldest entry, which
 * shifts the index of EVERY survivor. The executor remembers the id of the newest entry it
 * already showed the model (`injectedMemory`), so after a trim that id no longer parsed:
 * `renderMemoryDelta` took the "boundary is gone" branch and re-sent the whole 8-entry
 * baseline on every turn (measured live: `[本房间记忆]` reappeared in 20 of 25 turns and
 * grew to ~2 KB). A content hash keeps a survivor's id identical across trims, so the
 * delta stays a delta.
 *
 * Run with: node --test tests/memory-delta.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRoomMemory,
  renderRoomMemory,
  stableEntryId,
  stableHash,
} from '../packages/core/agent-community/src/memory-store.ts'
import { renderMemoryDelta } from '../packages/core/agent-community/src/bot-memory.ts'
import type { BotMemoryEntry } from '../packages/core/agent-community/src/types.ts'

const META = {
  roomId: 'room-1',
  roomName: '测试房间',
  botId: 'bot-1',
  kind: 'group' as const,
}

/** `count` distinct task entries, oldest first. */
function entries(count: number, offset = 0): BotMemoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i
    return {
      id: `fixture-${n}`,
      kind: 'task' as const,
      at: new Date(Date.parse('2026-10-21T00:00:00.000Z') + n * 60_000).toISOString(),
      runId: `run-${n}`,
      text: `任务 ${n} 的结果`,
    }
  })
}

function parse(rows: readonly BotMemoryEntry[]): BotMemoryEntry[] {
  return parseRoomMemory(renderRoomMemory(META, rows))
}

test('trimming the oldest entries keeps every survivor id identical', () => {
  const full = parse(entries(12))
  assert.equal(full.length, 12)
  assert.equal(new Set(full.map(entry => entry.id)).size, 12, 'ids are unique')

  // The 13th append trims the oldest: what the store writes is the last 12.
  const afterAppend = [...entries(13).slice(1)]
  const trimmed = parse(afterAppend)
  assert.equal(trimmed.length, 12)
  // Entries 1..11 are the survivors of the pre-append partition; the 12th is the new one.
  for (let i = 0; i < 11; i += 1) {
    assert.equal(trimmed[i]!.id, full[i + 1]!.id, `entry ${i} keeps its id after the trim`)
  }
  // The id is content-derived and carries no position.
  assert.equal(trimmed[0]!.id.includes('#1'), false)
  assert.equal(trimmed[0]!.id, stableEntryId({ kind: 'task', at: trimmed[0]!.at, text: trimmed[0]!.text }))
})

test('the same line parsed twice is one entry; a different text at the same time is another', () => {
  const at = '2026-10-21T00:00:00.000Z'
  const first: BotMemoryEntry = { id: 'a', kind: 'note', at, text: '同一句话' }
  const second: BotMemoryEntry = { id: 'b', kind: 'note', at, text: '另一句话' }
  const parsed = parseRoomMemory(renderRoomMemory(META, [first, first, second]))
  assert.equal(parsed.length, 2, 'duplicate render lines collapse to one entry')
  assert.equal(new Set(parsed.map(entry => entry.id)).size, 2)
  assert.equal(stableHash('同一句话'), stableHash('同一句话'), 'hash is deterministic')
  assert.notEqual(stableHash('a'), stableHash('b'))
})

test('renderMemoryDelta stays a delta after a trim (no baseline re-send)', () => {
  const full = parse(entries(12))
  const newestId = full[full.length - 1]!.id
  // Next turn: append entry 12 and trim the oldest — the boundary (entry 11) survives.
  const next = parse(entries(13).slice(1))
  const delta = renderMemoryDelta(next, newestId, { limit: 8 })
  assert.equal(delta.baseline, false, 'the boundary entry was found, so this is a delta')
  assert.ok(delta.block !== undefined)
  assert.ok(delta.block!.includes('任务 12 的结果'), 'only the new entry is re-sent')
  assert.equal(delta.block!.includes('任务 11 的结果'), false, 'already-shown entries are not repeated')
  assert.equal(delta.newestId, next[next.length - 1]!.id)
})

test('the previous positional id would have drifted with the trim; the stable id does not', () => {
  const full = parse(entries(12))
  const boundary = full[full.length - 1]!
  const next = parse(entries(13).slice(1))
  // The old scheme's id for the boundary entry was `${at}#12`; after the trim the SAME
  // line parses as `${at}#11` — the executor's remembered id matched nothing.
  const positionalBefore = `${boundary.at}#12`
  const positionalAfter = `${next[10]!.at}#11`
  assert.equal(next[10]!.at, boundary.at, 'the same line really survived')
  assert.notEqual(positionalBefore, positionalAfter, 'positional id drifts with the trim')
  // The stable id is unchanged, which is what the delta anchors on.
  assert.equal(next[10]!.id, boundary.id, 'stable id survives')
})

test('when the boundary entry itself was trimmed, the delta falls back to a baseline (documented)', () => {
  const full = parse(entries(12))
  const oldestShown = full[0]!.id
  const next = parse(entries(13).slice(1))
  const delta = renderMemoryDelta(next, oldestShown, { limit: 8 })
  assert.equal(delta.baseline, true, 'nothing to anchor to → baseline is the only correct answer')
  assert.ok(delta.block !== undefined)
})

test('renderMemoryDelta returns no block when nothing changed', () => {
  const current = parse(entries(5))
  const delta = renderMemoryDelta(current, current[current.length - 1]!.id, { limit: 8 })
  assert.equal(delta.block, undefined)
  assert.equal(delta.newestId, current[current.length - 1]!.id)
})
