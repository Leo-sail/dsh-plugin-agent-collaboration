/**
 * OP-08: memory quality labels, three-state lifecycle and poisoning governance.
 *
 * The assertions follow the lifecycle from write to prompt:
 *
 *   1. PROVENANCE — a user-driven run is active/positive; a peer-woken or timer turn is
 *      probation/unknown; the bot's own note is active but never promotable.
 *   2. LEGACY — a pre-OP-08 partition (no metadata) parses with the documented defaults, and an
 *      old run-backed task line keeps promoting exactly as before.
 *   3. INJECTION — probation/decayed entries stay out of the main prompt block and out of the
 *      delta boundary, so they can never block a later active entry.
 *   4. DECAY — a user correction decays the task it was reacting to (same task family, newest
 *      three tasks only); the id survives so the delta boundary survives.
 *   5. PROMOTION — the scanner only promotes active/positive/run entries; note/a2a/routine/
 *      negative/decayed never reach the learned file.
 *   6. FILE FORMAT — metadata round-trips, old lines still parse, and a lifecycle change never
 *      changes the stable id.
 *
 * Run with: node --test tests/memory-lifecycle.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bumpMaintain,
  confidenceOf,
  DECAY_FAMILY_SIMILARITY,
  DECAY_WINDOW_TASKS,
  decayForCorrections,
  entryMetaForNote,
  entryMetaForRun,
  isCorrectionText,
  isInjectable,
  MAINTAIN_CONFIDENCE_CAP,
  outcomeOf,
  promotable,
  sourceOf,
  statusOf,
  textSimilarity,
  taskSignature,
} from '../packages/core/agent-community/src/memory-lifecycle.ts'
import {
  renderMemoryBlock,
  renderMemoryDelta,
  searchMemory,
} from '../packages/core/agent-community/src/bot-memory.ts'
import {
  parseRoomMemory,
  renderRoomMemory,
} from '../packages/core/agent-community/src/memory-store.ts'
import { scanPromotions } from '../packages/core/agent-community/src/memory-promote.ts'
import type { BotMemoryEntry, BotMessage } from '../packages/core/agent-community/src/types.ts'

const T = (n: number): string => new Date(Date.parse('2026-10-22T00:00:00.000Z') + n * 60_000).toISOString()

function entry(over: Partial<BotMemoryEntry> & Pick<BotMemoryEntry, 'id'>): BotMemoryEntry {
  return { kind: 'task', text: `任务：做第 ${over.id} 件事 → 结果：已做完`, at: T(0), ...over }
}

function userMessage(text: string, at: string): Pick<BotMessage, 'sender' | 'text' | 'createdAt'> {
  return { sender: { kind: 'user', name: 'user' }, text, createdAt: at }
}

const META = { roomId: 'room-1', roomName: '测试房间', botId: 'bot-1', kind: 'group' as const }

// ── provenance ───────────────────────────────────────────────────────────────

test('run origins map to explicit provenance/state/confidence/outcome', () => {
  assert.deepEqual(entryMetaForRun('user'), { source: 'run', status: 'active', confidence: 0.7, outcome: 'positive' })
  assert.deepEqual(entryMetaForRun('a2a'), { source: 'a2a', status: 'probation', confidence: 0.35, outcome: 'unknown' })
  assert.deepEqual(entryMetaForRun('bot-message'), { source: 'a2a', status: 'probation', confidence: 0.35, outcome: 'unknown' })
  assert.deepEqual(entryMetaForRun('routine'), { source: 'routine', status: 'probation', confidence: 0.3, outcome: 'unknown' })
  assert.deepEqual(entryMetaForRun('something-new'), { source: 'unknown', status: 'probation', confidence: 0.3, outcome: 'unknown' })
  assert.equal(entryMetaForRun('').source, 'unknown')
})

test('a note is active but never promotable (self-report is not evidence)', () => {
  const meta = entryMetaForNote()
  assert.deepEqual(meta, { source: 'note', status: 'active', confidence: 0.5, outcome: 'unknown' })
  const note = entry({ id: 'n1', kind: 'note', runId: 'run-x', ...meta })
  assert.equal(isInjectable(note), true)
  assert.equal(promotable(note), false)
})

// ── legacy defaults + predicates ─────────────────────────────────────────────

test('pre-OP-08 entries parse as active; a run-backed task stays positive/run', () => {
  const legacyRun = entry({ id: 'legacy-run', runId: 'run-old' })
  assert.equal(statusOf(legacyRun), 'active')
  assert.equal(sourceOf(legacyRun), 'run')
  assert.equal(outcomeOf(legacyRun), 'positive')
  assert.equal(promotable(legacyRun), true, 'old run-backed task lines keep promoting')
  assert.equal(confidenceOf(legacyRun), 0.5, 'default confidence')

  const legacyFree = entry({ id: 'legacy-free' })
  assert.equal(sourceOf(legacyFree), 'unknown')
  assert.equal(outcomeOf(legacyFree), 'unknown')
  assert.equal(promotable(legacyFree), false)
})

test('confidenceOf clamps and defaults; status/source/outcome predicates are total', () => {
  assert.equal(confidenceOf({}), 0.5)
  assert.equal(confidenceOf({ confidence: Number.NaN }), 0.5)
  assert.equal(confidenceOf({ confidence: 1.7 }), 1)
  assert.equal(confidenceOf({ confidence: -2 }), 0)
  assert.equal(confidenceOf({ confidence: 0 }), 0)
  for (const status of [undefined, 'active'] as const) assert.equal(isInjectable({ status }), true)
  for (const status of ['probation', 'decayed'] as const) {
    assert.equal(isInjectable({ status }), false)
    assert.equal(promotable(entry({ id: `p-${status}`, runId: 'r', status })), false)
  }
  // A2a + positive is still not promotable: provenance must be a USER run.
  assert.equal(promotable(entry({ id: 'a2a-pos', runId: 'r', source: 'a2a', status: 'active', outcome: 'positive' })), false)
})

// ── injection ────────────────────────────────────────────────────────────────

test('the prompt block renders only active entries', () => {
  const block = renderMemoryBlock([
    entry({ id: 'a1', text: '活跃记忆一', at: T(0) }),
    entry({ id: 'p1', text: '待确认记忆', at: T(1), status: 'probation' }),
    entry({ id: 'd1', text: '已衰减记忆', at: T(2), status: 'decayed' }),
  ])
  assert.ok(block !== undefined)
  assert.ok(block!.includes('活跃记忆一'))
  assert.equal(block!.includes('待确认记忆'), false)
  assert.equal(block!.includes('已衰减记忆'), false)
  assert.equal(renderMemoryBlock([entry({ id: 'p', status: 'probation' })]), undefined)
})

test('a probation entry cannot block the delta of a later active entry', () => {
  const activeA = entry({ id: 'a', at: T(0), text: '任务甲 → 结果：完成' })
  const probation = entry({ id: 'p', at: T(1), status: 'probation', text: '任务乙 → 结果：做了' })
  const activeB = entry({ id: 'b', at: T(2), text: '任务丙 → 结果：完成' })
  const delta = renderMemoryDelta([activeA, probation, activeB], 'a')
  assert.equal(delta.block !== undefined, true, 'the active entry after the probation one is delivered')
  assert.ok(delta.block!.includes('任务丙'))
  assert.equal(delta.block!.includes('任务乙'), false, 'probation is not injected')
  assert.equal(delta.newestId, 'b', 'the boundary is the newest INJECTED entry')
  // Nothing injectable → no block, boundary unchanged.
  const none = renderMemoryDelta([probation], undefined)
  assert.equal(none.block, undefined)
  assert.equal(none.newestId, undefined)
})

test('recall searches everything but labels unconfirmed/decayed entries', () => {
  const hits = searchMemory([
    entry({ id: 'a', text: '超时设置是 30 秒' }),
    entry({ id: 'p', text: '超时改成 60 秒（待确认）', status: 'probation' }),
    entry({ id: 'd', text: '超时改回 10 秒（纠正过）', status: 'decayed' }),
  ], '超时')
  const byId = new Map(hits.map(hit => [hit.entry.id, hit]))
  assert.equal(byId.get('a')?.label, undefined)
  assert.equal(byId.get('p')?.label, '[待确认]')
  assert.equal(byId.get('d')?.label, '[已衰减]')
})

// ── decay ────────────────────────────────────────────────────────────────────

const CORRECTION = '不对，应该改成 30 秒'
const TASK = '任务：把配置超时改成30秒 → 结果：已改好'
const REDO = '任务：把配置超时改成30秒 → 结果：改好了'

test('a user correction decays the task it was reacting to (same family, id preserved)', () => {
  const target = entry({ id: 't1', text: TASK, at: T(0), confidence: 0.7, status: 'active' })
  const redo = entry({ id: 't2', text: REDO, at: T(4) })
  const result = decayForCorrections(
    [target, redo],
    [userMessage(CORRECTION, T(2))],
    T(9),
  )
  assert.equal(result.changed, 1)
  const decayed = result.entries.find(e => e.id === 't1')!
  assert.equal(decayed.status, 'decayed')
  assert.equal(decayed.outcome, 'negative')
  assert.equal(decayed.id, target.id, 'the stable id survives the lifecycle change')
  assert.ok(Math.abs(confidenceOf(decayed) - 0.3) < 1e-9, `confidence -0.4 (got ${confidenceOf(decayed)})`)
  assert.equal(decayed.updatedAt, T(9))
  assert.equal(statusOf(result.entries.find(e => e.id === 't2')!), 'active', 'the redo is not decayed')
})

test('a correction followed by an UNRELATED task does not decay anything', () => {
  const target = entry({ id: 't1', text: TASK, at: T(0) })
  const unrelated = entry({ id: 't2', text: '任务：帮我写一份周报 → 结果：写好了', at: T(4) })
  const result = decayForCorrections([target, unrelated], [userMessage(CORRECTION, T(2))], T(9))
  assert.equal(result.changed, 0)
  assert.equal(result.entries.find(e => e.id === 't1')!.status, undefined)
})

test('only the newest three task entries are decay candidates', () => {
  const old = entry({ id: 'old', text: TASK, at: T(0) })
  // Three newer tasks push `old` out of the window; the correction right after `old` targets it.
  const newer = Array.from({ length: DECAY_WINDOW_TASKS }, (_, i) =>
    entry({ id: `n${i}`, text: `任务：做第 ${i} 件别的事 → 结果：完成`, at: T(10 + i * 10) }))
  const result = decayForCorrections([old, ...newer], [userMessage(CORRECTION, T(5))], T(60))
  assert.equal(result.changed, 0, 'outside the bounded window → untouched')
})

test('a correction with no redo decays the latest task before it; probation is untouched', () => {
  const active = entry({ id: 'a', text: TASK, at: T(0) })
  const result = decayForCorrections([active], [userMessage(CORRECTION, T(2))], T(9))
  assert.equal(result.changed, 1)

  const probation = entry({ id: 'p', text: TASK, at: T(0), status: 'probation' })
  assert.equal(decayForCorrections([probation], [userMessage(CORRECTION, T(2))], T(9)).changed, 0)

  // A bot saying "不对" is not a user correction.
  const botMessage = { sender: { kind: 'bot', name: '小董' }, text: CORRECTION, createdAt: T(2) }
  assert.equal(decayForCorrections([entry({ id: 'b', text: TASK, at: T(0) })], [botMessage], T(9)).changed, 0)
})

test('the confidence floor is 0.1 and the correction detector is shared semantics', () => {
  const target = entry({ id: 't', text: TASK, at: T(0), confidence: 0.2 })
  const decayed = decayForCorrections([target], [userMessage(CORRECTION, T(1))], T(9)).entries[0]!
  assert.equal(confidenceOf(decayed), 0.1)
  assert.equal(isCorrectionText('不对，重做'), true)
  assert.equal(isCorrectionText('好的，谢谢'), false)
  assert.equal(textSimilarity(taskSignature(TASK), taskSignature(REDO)), 1)
  assert.ok(textSimilarity(taskSignature(TASK), taskSignature('任务：写周报 → 结果：完成')) < DECAY_FAMILY_SIMILARITY)
})

// ── maintain (opt-in) ────────────────────────────────────────────────────────

test('bumpMaintain raises confidence for the same task family only, capped', () => {
  const same = entry({ id: 's', text: TASK, at: T(0), confidence: 0.7, status: 'active' })
  const other = entry({ id: 'o', text: '任务：写周报 → 结果：完成', at: T(0), confidence: 0.7, status: 'active' })
  const result = bumpMaintain([same, other], TASK, T(9))
  assert.equal(result.changed, 1)
  assert.ok(Math.abs(confidenceOf(result.entries.find(e => e.id === 's')!) - 0.8) < 1e-9)
  assert.equal(confidenceOf(result.entries.find(e => e.id === 'o')!), 0.7)
  // Cap at 0.95.
  const high = entry({ id: 'h', text: TASK, at: T(0), confidence: 0.94, status: 'active' })
  assert.equal(confidenceOf(bumpMaintain([high], TASK, T(9)).entries[0]!), MAINTAIN_CONFIDENCE_CAP)
})

// ── promotion gate ───────────────────────────────────────────────────────────

/** Two successful attempts at the same request — the repetition channel's minimum evidence. */
function repeatableEntries(): BotMemoryEntry[] {
  return [
    entry({ id: 'r1', text: '任务：把配置超时改成30秒 → 结果：已改好', at: T(1), runId: 'run-1' }),
    entry({ id: 'r2', text: '任务：把配置超时改成30秒 → 结果：改好了', at: T(3), runId: 'run-2' }),
  ]
}

test('legacy run-backed repetition still promotes (no regression)', () => {
  const candidates = scanPromotions({ entries: repeatableEntries(), messages: [], alreadyLearned: [] })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.kind, 'procedure')
})

test('probation, note, negative and decayed entries never promote', () => {
  const cases: Array<Partial<BotMemoryEntry>> = [
    { status: 'probation' },
    { status: 'decayed', outcome: 'negative' },
    { outcome: 'unknown' },
    { outcome: 'negative' },
    { source: 'a2a', outcome: 'positive' },
    { source: 'routine', outcome: 'positive' },
  ]
  for (const over of cases) {
    const entries = repeatableEntries().map(e => ({ ...e, ...over }))
    assert.equal(
      scanPromotions({ entries, messages: [], alreadyLearned: [] }).length,
      0,
      `must not promote ${JSON.stringify(over)}`,
    )
  }
  const notes = repeatableEntries().map(e => ({ ...e, kind: 'note' as const }))
  assert.equal(scanPromotions({ entries: notes, messages: [], alreadyLearned: [] }).length, 0)
})

// ── file format ──────────────────────────────────────────────────────────────

test('metadata round-trips through the partition file, id unchanged by status', () => {
  const active = entry({
    id: 'x1', text: '任务：保留原文 → 结果：完成', at: T(1), runId: 'run-9',
    source: 'run', status: 'active', outcome: 'positive', confidence: 0.7,
  })
  const file = renderRoomMemory(META, [active])
  assert.ok(file.includes('source=run'))
  assert.ok(file.includes('status=active'))
  assert.ok(file.includes('outcome=positive'))
  assert.ok(file.includes('confidence=0.7'))
  const parsed = parseRoomMemory(file)
  assert.equal(parsed.length, 1)
  assert.deepEqual(
    { source: parsed[0]!.source, status: parsed[0]!.status, outcome: parsed[0]!.outcome, confidence: parsed[0]!.confidence },
    { source: 'run', status: 'active', outcome: 'positive', confidence: 0.7 },
  )
  // The id depends on kind+at+text only: a decayed copy is the SAME entry.
  const decayedFile = renderRoomMemory(META, [{ ...active, status: 'decayed', outcome: 'negative' }])
  assert.equal(parseRoomMemory(decayedFile)[0]!.id, parsed[0]!.id)
})

test('a pre-OP-08 file still parses with the documented legacy defaults', () => {
  const legacy = [
    '<!-- agent-community:room-memory v1 -->',
    '',
    '- [task 2026-10-20T00:00:00.000Z run=run-old] 任务：旧任务 → 结果：完成',
    '- [task 2026-10-20T01:00:00.000Z] 任务：没有 run 的旧行 → 结果：未知',
    '- [note 2026-10-20T02:00:00.000Z] 旧笔记',
    '',
  ].join('\n')
  const parsed = parseRoomMemory(legacy)
  assert.equal(parsed.length, 3)
  assert.deepEqual(
    { source: parsed[0]!.source, status: parsed[0]!.status, outcome: parsed[0]!.outcome },
    { source: 'run', status: 'active', outcome: 'positive' },
  )
  assert.equal(parsed[0]!.runId, 'run-old')
  assert.deepEqual(
    { source: parsed[1]!.source, status: parsed[1]!.status, outcome: parsed[1]!.outcome },
    { source: 'unknown', status: 'active', outcome: 'unknown' },
  )
  assert.deepEqual(
    { source: parsed[2]!.source, status: parsed[2]!.status, outcome: parsed[2]!.outcome },
    { source: 'note', status: 'active', outcome: 'unknown' },
  )
  assert.equal(promotable(parsed[0]!), true, 'legacy run-backed task still promotes')
  assert.equal(promotable(parsed[1]!), false)
})
