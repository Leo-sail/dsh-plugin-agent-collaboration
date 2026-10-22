/**
 * OP-17: parallel bidding is an OPT-IN, PURE policy.
 *
 * The tests pin the three things that make such a policy safe to leave in the codebase:
 *   · the gate refuses unless EVERY condition holds (complex + ambiguous + ≥2 members + budget);
 *   · the score is deterministic (same input → same number) and evidence/finish/failures move it
 *     in the expected direction;
 *   · a near-tie keeps the FIRST candidate (no randomness), so the same round can never disagree
 *     with itself.
 *
 * Run with: node --test tests/bidding.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BID_TIE_WINDOW,
  bidBudget,
  PARALLEL_BID_DEFAULT_BUDGET_TOKENS,
  PARALLEL_BID_MAX_BIDS,
  PARALLEL_BID_MIN_BUDGET_TOKENS,
  scoreBid,
  scoreBidDetailed,
  selectWinningBid,
  shouldRunParallelBids,
  type BidCandidate,
} from '../packages/core/agent-community/src/bidding.ts'

const ELIGIBLE = {
  difficulty: 'complex' as const,
  ambiguity: 0.8,
  memberCount: 3,
  budgetTokens: 100_000,
}

function bid(over: Partial<BidCandidate>): BidCandidate {
  return { text: '答案正文 '.repeat(20), evidenceCount: 1, finishPath: 'natural', toolFailures: 0, ...over }
}

// ── gate ─────────────────────────────────────────────────────────────────────

test('an eligible round is the only one that runs', () => {
  assert.deepEqual(shouldRunParallelBids(ELIGIBLE), { run: true, reason: 'eligible' })
  // Boundary values are inclusive.
  assert.equal(shouldRunParallelBids({ ...ELIGIBLE, ambiguity: 0.6 }).run, true)
  assert.equal(shouldRunParallelBids({ ...ELIGIBLE, memberCount: 2 }).run, true)
  assert.equal(shouldRunParallelBids({ ...ELIGIBLE, budgetTokens: PARALLEL_BID_MIN_BUDGET_TOKENS }).run, true)
})

test('each missing condition refuses the round, and says which one', () => {
  const cases: Array<[Parameters<typeof shouldRunParallelBids>[0], string]> = [
    [{ ...ELIGIBLE, difficulty: 'simple' }, 'difficulty-not-complex'],
    [{ ...ELIGIBLE, difficulty: 'standard' }, 'difficulty-not-complex'],
    [{ ...ELIGIBLE, ambiguity: 0.59 }, 'ambiguity-below-threshold'],
    [{ ...ELIGIBLE, ambiguity: Number.NaN }, 'ambiguity-below-threshold'],
    [{ ...ELIGIBLE, memberCount: 1 }, 'not-enough-members'],
    [{ ...ELIGIBLE, memberCount: Number.NaN }, 'not-enough-members'],
    [{ ...ELIGIBLE, budgetTokens: undefined }, 'budget-not-stated'],
    [{ ...ELIGIBLE, budgetTokens: PARALLEL_BID_MIN_BUDGET_TOKENS - 1 }, 'budget-insufficient'],
    [{ ...ELIGIBLE, budgetTokens: Number.POSITIVE_INFINITY }, 'budget-insufficient'],
  ]
  for (const [input, reason] of cases) {
    const decision = shouldRunParallelBids(input)
    assert.equal(decision.run, false, JSON.stringify(input))
    assert.ok(decision.reason.startsWith(reason), `${decision.reason} should start with ${reason}`)
  }
})

test('the default path is OFF: a simple task never bids, however ambiguous', () => {
  assert.equal(shouldRunParallelBids({ ...ELIGIBLE, difficulty: 'simple', ambiguity: 1 }).run, false)
})

// ── scoring ──────────────────────────────────────────────────────────────────

test('scoring is deterministic and total (0..100, integer)', () => {
  const candidate = bid({})
  assert.equal(scoreBid(candidate), scoreBid(candidate))
  const detailed = scoreBidDetailed(candidate)
  assert.equal(detailed.score, scoreBid(candidate))
  assert.equal(Number.isInteger(detailed.score), true)
  assert.ok(detailed.score >= 0 && detailed.score <= 100)
  // Extremes stay in range.
  assert.ok(scoreBid(bid({ text: '', evidenceCount: 0, finishPath: 'failed', toolFailures: 99 })) >= 0)
  assert.ok(scoreBid(bid({ text: '长'.repeat(10_000), evidenceCount: 99, finishPath: 'finish_task' })) <= 100)
})

test('evidence, finish path, answer size and tool failures move the score in order', () => {
  const base = bid({ evidenceCount: 0, finishPath: 'none', toolFailures: 0, text: 'x'.repeat(10) })
  assert.ok(scoreBid(bid({ ...base, evidenceCount: 3 })) > scoreBid(base), 'evidence adds')
  assert.ok(scoreBid(bid({ ...base, finishPath: 'finish_task' })) > scoreBid(bid({ ...base, finishPath: 'natural' })))
  assert.ok(scoreBid(bid({ ...base, finishPath: 'natural' })) > scoreBid(bid({ ...base, finishPath: 'none' })))
  assert.ok(scoreBid(bid({ ...base, finishPath: 'failed' })) < scoreBid(base), 'a failed turn is a real penalty')
  assert.ok(scoreBid(bid({ ...base, text: 'x'.repeat(200) })) > scoreBid(base), 'a larger answer earns up to 10')
  assert.ok(scoreBid(bid({ ...base, toolFailures: 2 })) < scoreBid(base), 'tool failures subtract')
})

// ── selection ───────────────────────────────────────────────────────────────

test('the highest score wins and the result is stable', () => {
  const strong = bid({ id: 'strong', evidenceCount: 4, finishPath: 'finish_task' })
  const weak = bid({ id: 'weak', evidenceCount: 0, finishPath: 'failed' })
  const selection = selectWinningBid([weak, strong])
  assert.equal(selection.tie, false)
  assert.equal(selection.winner?.id, 'strong')
  assert.deepEqual(selectWinningBid([weak, strong]), selection, 'same input, same selection')
  assert.deepEqual(selectWinningBid([]), { winner: undefined, tie: false, scored: [] })
  const single = selectWinningBid([weak])
  assert.equal(single.winner, weak)
  assert.equal(single.tie, false)
})

test('a near tie (<5 points) keeps the FIRST candidate, deterministically', () => {
  // Identical evidence, same finish path; only the answer size differs by one 5-point step
  // → the second is 5 points ahead, which is NOT a tie.
  const shorter = bid({ id: 'shorter', text: 'x'.repeat(80) })
  const longer = bid({ id: 'longer', text: 'x'.repeat(160) })
  const notTie = selectWinningBid([shorter, longer])
  assert.equal(notTie.tie, false)
  assert.equal(notTie.winner?.id, 'longer')
  assert.equal(BID_TIE_WINDOW, 5)

  // A natural finish is worth exactly 4 more than "none" → within the tie window. The second
  // candidate scores higher, yet the FIRST is kept.
  const first = bid({ id: 'first', finishPath: 'none', text: 'x'.repeat(80) })
  const second = bid({ id: 'second', finishPath: 'natural', text: 'x'.repeat(80) })
  const tie = selectWinningBid([first, second])
  assert.equal(tie.tie, true)
  assert.equal(tie.winner?.id, 'first')
  assert.ok(scoreBid(second) > scoreBid(first))
  // Repeating the call never flips the winner.
  assert.deepEqual(selectWinningBid([first, second]), tie)
})

// ── budget ──────────────────────────────────────────────────────────────────

test('bidBudget caps the round at two candidates and splits the token budget', () => {
  const defaults = bidBudget()
  assert.equal(defaults.maxBids, PARALLEL_BID_MAX_BIDS)
  assert.equal(defaults.totalTokens, PARALLEL_BID_DEFAULT_BUDGET_TOKENS)
  assert.equal(defaults.perBidTokens, Math.floor(PARALLEL_BID_DEFAULT_BUDGET_TOKENS / 2))
  assert.deepEqual(defaults.candidates.map(c => c.index), [0, 1])
  assert.ok(defaults.candidates.every(c => c.tokenCap === defaults.perBidTokens))

  assert.equal(bidBudget({ maxBids: 5 }).maxBids, 2, 'never more than two candidates')
  assert.equal(bidBudget({ maxBids: 0 }).maxBids, 1, 'clamped to at least one')
  const custom = bidBudget({ maxBids: 2, totalTokens: 9_000 })
  assert.equal(custom.perBidTokens, 4_500)
  assert.equal(bidBudget({ maxBids: Number.NaN, totalTokens: -5 }).totalTokens, PARALLEL_BID_DEFAULT_BUDGET_TOKENS)
})

test('the policy module is side-effect free (inputs untouched, no persistence)', () => {
  const input = { ...ELIGIBLE }
  const frozen = JSON.stringify(input)
  shouldRunParallelBids(input)
  selectWinningBid([bid({ id: 'a' }), bid({ id: 'b' })])
  bidBudget({ maxBids: 2, totalTokens: 10_000 })
  assert.equal(JSON.stringify(input), frozen)
})
