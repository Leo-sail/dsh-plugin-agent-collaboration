/**
 * Tests for the historical-collaboration priors and difficulty budget (OP-11).
 *
 * Three deterministic rules:
 *   · `classifyTaskDifficulty` — short+marker-free = simple; long or multi-marker = complex;
 *   · `rosterBudget` — simple 2 / standard 3 / complex 4 (the caller clamps);
 *   · `historicalMemberPriors` + `rankWithPriors` — boards' done/failed history is a NEAR-TIE
 *     tie-break only, never able to outrank a strong capability match, and absent history
 *     changes nothing.
 *
 * Run with: node --test tests/collaboration-priors.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MIN_PRIOR_SAMPLES,
  PRIOR_TIE_WINDOW,
  classifyTaskDifficulty,
  historicalMemberPriors,
  rankWithPriors,
  rosterBudget,
} from '../packages/core/agent-community/src/collaboration-priors.ts'
import type { MemberPrior, PriorRoomInput } from '../packages/core/agent-community/src/collaboration-priors.ts'
import type { RankedCandidate } from '../packages/core/agent-community/src/capability.ts'

// ── difficulty classification ───────────────────────────────────────────────

test('a short, single-request sentence is simple', () => {
  assert.equal(classifyTaskDifficulty('帮我把这句话翻译成英文'), 'simple')
  assert.equal(classifyTaskDifficulty('总结一下今天的会议要点'), 'simple')
})

test('empty or whitespace-only text stays standard (historical behaviour)', () => {
  assert.equal(classifyTaskDifficulty(''), 'standard')
  assert.equal(classifyTaskDifficulty('   \n\t '), 'standard')
})

test('a longer request without heavy language is standard', () => {
  const text = '请帮我看一下这份材料里关于用户增长的部分，如果有不清楚的地方标出来，并在旁边写上你的判断和依据'
  assert.ok(text.length > 40)
  assert.equal(classifyTaskDifficulty(text), 'standard')
})

test('one heavy marker alone is not enough to be complex', () => {
  // A single specialised job ("break this article down") is one specialist's work, not a project.
  assert.equal(classifyTaskDifficulty('把这篇公众号拆解一下'), 'standard')
})

test('several heavy markers or a very long request is complex', () => {
  assert.equal(classifyTaskDifficulty('调研并评估竞品的多文件交付方案'), 'complex')
  assert.equal(classifyTaskDifficulty('数据'.repeat(60)), 'complex', 'length alone is multi-artifact')
})

test('the roster budget follows the difficulty and never exceeds the old width', () => {
  assert.equal(rosterBudget('simple'), 2)
  assert.equal(rosterBudget('standard'), 3)
  assert.equal(rosterBudget('complex'), 4)
})

// ── historical member priors ────────────────────────────────────────────────

function assignment(botId: string, status?: string): { botId: string; status?: string } {
  return status === undefined ? { botId } : { botId, status }
}

test('priors count decided outcomes across every room board', () => {
  const rooms: PriorRoomInput[] = [
    {
      taskState: {
        assignments: [
          assignment('a', 'done'),
          assignment('a', 'done'),
          assignment('b', 'blocked'),
          assignment('b', 'cancelled'),
          assignment('c', 'done'),
          assignment('a', 'working'),
        ],
      },
    },
    {
      taskState: {
        assignments: [
          assignment('d', 'done'),
          assignment('d', 'blocked'),
          assignment('d', 'reported'),
        ],
      },
    },
    {},
  ]
  const priors = historicalMemberPriors(rooms)
  assert.deepEqual(priors.get('a'), { done: 2, failed: 0, samples: 2, rate: 1 })
  assert.deepEqual(priors.get('b'), { done: 0, failed: 2, samples: 2, rate: 0 })
  assert.deepEqual(priors.get('d'), { done: 1, failed: 1, samples: 2, rate: 0.5 })
  assert.equal(priors.has('c'), false, 'a single sample proves nothing')
})

test('empty input and un-decided assignments produce no priors', () => {
  assert.equal(historicalMemberPriors([]).size, 0)
  const openOnly: PriorRoomInput[] = [{
    taskState: {
      assignments: [
        assignment('x', 'open'),
        assignment('x', 'assigned'),
        assignment('x', 'reported'),
        assignment('', 'done'),
      ],
    },
  }]
  assert.equal(historicalMemberPriors(openOnly).size, 0)
})

test('the sample floor is exactly two', () => {
  assert.equal(MIN_PRIOR_SAMPLES, 2)
  const one: PriorRoomInput[] = [{ taskState: { assignments: [assignment('bot', 'done')] } }]
  assert.equal(historicalMemberPriors(one).size, 0)
  const two: PriorRoomInput[] = [{
    taskState: { assignments: [assignment('bot', 'done'), assignment('bot', 'blocked')] },
  }]
  assert.equal(historicalMemberPriors(two).size, 1)
})

// ── ranking with priors ─────────────────────────────────────────────────────

const candidate = (botId: string, score: number): RankedCandidate => ({ botId, score, matched: [] })
const prior = (done: number, failed: number): MemberPrior => {
  const samples = done + failed
  return { done, failed, samples, rate: done / samples }
}
const ids = (list: readonly RankedCandidate[]): string[] => list.map(item => item.botId)

test('within a near-tie, the better historical record wins', () => {
  assert.equal(PRIOR_TIE_WINDOW, 1)
  const ranked = rankWithPriors(
    [candidate('fresh', 3), candidate('proven', 2.5)],
    new Map([['fresh', prior(0, 2)], ['proven', prior(2, 0)]]),
  )
  assert.deepEqual(ids(ranked), ['proven', 'fresh'])
})

test('a clearly better fit is never displaced by history', () => {
  const ranked = rankWithPriors(
    [candidate('strong-fit', 4), candidate('proven', 2)],
    new Map([['strong-fit', prior(0, 2)], ['proven', prior(2, 0)]]),
  )
  assert.deepEqual(ids(ranked), ['strong-fit', 'proven'])
})

test('equal rates fall back to more samples, then input order', () => {
  const ranked = rankWithPriors(
    [candidate('few', 3), candidate('many', 3)],
    new Map([['few', prior(1, 1)], ['many', prior(3, 3)]]),
  )
  assert.deepEqual(ids(ranked), ['many', 'few'])
  const noHistory = rankWithPriors([candidate('b', 3), candidate('a', 3)], new Map())
  assert.deepEqual(ids(noHistory), ['b', 'a'], 'with no priors the caller order is preserved')
})

test('a candidate without history ranks below a proven one but above a proven failure', () => {
  const ranked = rankWithPriors(
    [candidate('unknown', 3), candidate('proven', 3), candidate('failed', 3)],
    new Map([['proven', prior(2, 0)], ['failed', prior(0, 2)]]),
  )
  assert.deepEqual(ids(ranked), ['proven', 'unknown', 'failed'])
})

test('output is still ordered by score first', () => {
  const ranked = rankWithPriors(
    [candidate('low', 1), candidate('high', 3), candidate('mid', 2)],
    new Map([['low', prior(5, 0)]]),
  )
  assert.deepEqual(ids(ranked), ['high', 'mid', 'low'])
})
