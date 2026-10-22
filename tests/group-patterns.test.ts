/**
 * OP-09: group pattern cards — remember HOW a group delivered, deterministically.
 *
 * A card is built from the finish report (no model call): opening sentences → `approach`,
 * pitfall/risk lines → `pitfalls`, finish evidence → short references. Cards live per room,
 * de-duplicate by normalized task (newest wins), are capped, and render as the
 * `[本群经验卡]` prompt section.
 *
 * Run with: node --test tests/group-patterns.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGroupPatternCard,
  GROUP_PATTERNS_MAX,
  GROUP_PATTERNS_RENDER_LIMIT,
  mergeGroupPatterns,
  normalizePatternTask,
  renderGroupPatternsBlock,
} from '../packages/core/agent-community/src/group-patterns.ts'
import type { GroupPatternCard } from '../packages/core/agent-community/src/types.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T01:00:00.000Z'

function card(overrides: Partial<GroupPatternCard> = {}): GroupPatternCard {
  return {
    id: 'pattern:1',
    task: '交付方案',
    approach: '先拆解再写',
    createdAt: T0,
    source: 'finish',
    ...overrides,
  }
}

// ── normalization ──────────────────────────────────────────────────────────

test('normalizePatternTask trims, collapses whitespace and lowercases', () => {
  assert.equal(normalizePatternTask('  交付  Bots   插件方案 '), '交付 bots 插件方案')
  assert.equal(normalizePatternTask('交付 Bots 插件方案'), normalizePatternTask(' 交付 bots  插件方案 '))
})

// ── building a card ────────────────────────────────────────────────────────

test('a deterministic card keeps the approach, pitfalls and evidence', () => {
  const built = buildGroupPatternCard({
    task: '  交付 Bots 插件稳定性方案 ',
    report: '先拆解需求，再逐节写方案。注意：不要一次写太长，容易漏章节。最后自检输出。',
    evidence: ['out/plan.md', 'msg-1', 'task-9'],
    now: T0,
  })
  assert.equal(built.task, '交付 bots 插件稳定性方案')
  // Pitfall lines are split out of the approach (no duplicated sentence in the block).
  assert.equal(built.approach, '先拆解需求，再逐节写方案；最后自检输出')
  assert.deepEqual(built.pitfalls, ['注意：不要一次写太长，容易漏章节'])
  assert.deepEqual(built.evidence, ['out/plan.md', 'msg-1', 'task-9'])
  assert.equal(built.createdAt, T0)
  assert.equal(built.source, 'finish')
  assert.match(built.id, /交付-bots-插件稳定性方案/u)
})

test('the same input yields the same card (reproducible, no model involved)', () => {
  const input = { task: '写报告', report: '先查资料，再写。风险：数据可能过期。', now: T0 }
  assert.deepEqual(buildGroupPatternCard(input), buildGroupPatternCard(input))
})

test('an empty report still produces an explicit, unusable-free card', () => {
  const built = buildGroupPatternCard({ task: '任务', report: '   ', now: T0 })
  assert.equal(built.approach, '（无文字做法摘要）')
  assert.equal(built.pitfalls, undefined)
  assert.equal(built.evidence, undefined)
})

test('all fields are length-bounded', () => {
  const built = buildGroupPatternCard({
    task: '任务'.repeat(500),
    report: `${'做法'.repeat(500)}。${`风险${'大'.repeat(500)}`}。`,
    evidence: Array.from({ length: 20 }, (_v, i) => `e-${i}-${'x'.repeat(300)}`),
    now: T0,
  })
  assert.ok([...built.task].length <= 160)
  assert.ok([...built.approach].length <= 240)
  assert.ok((built.pitfalls ?? []).length <= 3)
  assert.ok((built.pitfalls ?? []).every(pitfall => [...pitfall].length <= 120))
  assert.ok((built.evidence ?? []).length <= 5)
  assert.ok((built.evidence ?? []).every(ref => [...ref].length <= 120))
})

// ── merging ────────────────────────────────────────────────────────────────

test('merge puts the newest card first and replaces the same task', () => {
  const older = card({ task: '交付方案', approach: '旧做法' })
  const other = card({ task: '写周报', approach: '先列要点', createdAt: T1 })
  const newest = card({ task: ' 交付方案 ', approach: '新做法', createdAt: T1 })
  const merged = mergeGroupPatterns([older, other], newest)
  assert.equal(merged.length, 2) // same normalized task replaced, not appended
  assert.equal(merged[0]!.approach, '新做法') // newest first
  assert.equal(merged[1]!.task, '写周报')
})

test('merge caps the list and tolerates a missing list', () => {
  const existing: GroupPatternCard[] = Array.from({ length: GROUP_PATTERNS_MAX }, (_v, i) => (
    card({ id: `p-${i}`, task: `任务 ${i}`, createdAt: T0 })
  ))
  const merged = mergeGroupPatterns(existing, card({ task: '新任务' }))
  assert.equal(merged.length, GROUP_PATTERNS_MAX)
  assert.equal(merged[0]!.task, '新任务')
  assert.equal(mergeGroupPatterns(undefined, card({ task: '第一个' })).length, 1)
  // A smaller explicit cap is honoured.
  assert.equal(mergeGroupPatterns(existing, card({ task: '新任务' }), 2).length, 2)
})

// ── rendering ──────────────────────────────────────────────────────────────

test('render includes the header, task/approach and pitfalls', () => {
  const block = renderGroupPatternsBlock([
    card({ task: '交付方案', approach: '先拆解再写', pitfalls: ['不要一次写太长', '先自检'] }),
  ])
  assert.equal(block, '[本群经验卡]\n· 交付方案：先拆解再写（坑：不要一次写太长；先自检）')
})

test('only active cards enter the prompt; a pending card waits for confirmation', () => {
  const block = renderGroupPatternsBlock([
    card({ task: '已确认任务', approach: '按 A 做', status: 'active' }),
    card({ task: '待确认任务', approach: '按 B 做', status: 'pending' }),
  ])!
  assert.match(block, /已确认任务/u)
  assert.doesNotMatch(block, /待确认任务/u)
  assert.equal(renderGroupPatternsBlock([card({ task: '只有待确认', status: 'pending' })]), undefined)
})

test('render returns undefined when there is nothing usable, and respects the limit', () => {
  assert.equal(renderGroupPatternsBlock(undefined), undefined)
  assert.equal(renderGroupPatternsBlock([]), undefined)
  assert.equal(renderGroupPatternsBlock([card({ approach: '  ' })]), undefined)
  assert.equal(renderGroupPatternsBlock([card({ task: '  ' })]), undefined)

  const many = Array.from({ length: 6 }, (_v, i) => card({ id: `p-${i}`, task: `任务 ${i}` }))
  const block = renderGroupPatternsBlock(many)!
  assert.equal(block.split('\n').length, 1 + GROUP_PATTERNS_RENDER_LIMIT)
  // newest first is preserved (the caller hands them newest-first).
  assert.match(block, /任务 0/u)
  assert.doesNotMatch(block, /任务 5/u)
})

test('rendered blocks contain only task/approach/pitfalls (evidence stays on the card)', () => {
  const block = renderGroupPatternsBlock([
    card({ task: '交付方案', approach: '先拆解', evidence: ['/secret/path/plan.md'] }),
  ])!
  assert.equal(block.includes('/secret/path/plan.md'), false)
})
