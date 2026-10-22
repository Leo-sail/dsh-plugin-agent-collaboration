/**
 * The ATA policy: a deadline derived from measured task time, not a constant.
 *
 * The user's rule is one sentence — "runTimeout 需要根据实际任务时间来配置，不能写死" — and these
 * assertions are that rule made executable: percentile maths, the four sample fallbacks, the
 * clamp, the no-progress window, the bounded extension chain, and the retry classification
 * that keeps a user stop from ever being retried.
 *
 * Run with: node --test tests/run-budget.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  clamp,
  classifyFailure,
  deriveDeadlineBudget,
  isRetryableFailureKind,
  median,
  nextExtensionDeadline,
  noProgressLimitMs,
  percentile,
  progressIsRecent,
  resolveRetryPolicy,
  resolveTimeoutPolicy,
  retryBackoffMs,
  shouldExtend,
  taskClassOf,
  DEFAULT_RUN_RETRY_POLICY,
  DEFAULT_RUN_TIMEOUT_POLICY,
  MIN_SAMPLE_SIZE,
} from '../packages/core/agent-community/src/run-budget.ts'
import type { RunTimeoutPolicy } from '../packages/core/agent-community/src/run-budget.ts'

const policy = resolveTimeoutPolicy(undefined)
const SEC = 1_000
const MIN = 60 * SEC

/** Durations measured on this deployment (seconds → ms), per bot/origin spread. */
const REAL_HISTORY_MS = [82, 261, 317, 606, 1516, 1931, 5052].map(s => s * SEC)

// ── percentile / median ─────────────────────────────────────────────────────

test('percentile is nearest-rank and handles the edges', () => {
  assert.equal(percentile([], 0.95), undefined)
  assert.equal(percentile([42], 0.95), 42)
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20)
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40)
  // 20 samples, nearest-rank p95 = the 19th (not 20th, not interpolated).
  const twenty = Array.from({ length: 20 }, (_v, i) => (i + 1) * 1_000)
  assert.equal(percentile(twenty, 0.95), 19_000)
  // Unsorted input, ignored non-finite values.
  assert.equal(percentile([30, 10, Number.NaN, 20], 0.95), 30)
})

test('median handles even and odd samples', () => {
  assert.equal(median([]), undefined)
  assert.equal(median([5]), 5)
  assert.equal(median([1, 3, 5]), 3)
  assert.equal(median([1, 2, 3, 4]), 2.5)
})

// ── task classification ─────────────────────────────────────────────────────

test('taskClassOf reads the prompt prefix first, then the origin', () => {
  assert.equal(taskClassOf('[继续目标] 把论文读完', 'routine'), 'goal-continuation')
  assert.equal(taskClassOf('[成员汇报] 我做完了', 'bot-message'), 'member-report')
  assert.equal(taskClassOf('[任务] 写周报', 'routine'), 'task-board')
  assert.equal(taskClassOf('[来自 小马] 你好', 'a2a'), 'a2a')
  assert.equal(taskClassOf('定时任务触发：AI 日报', 'routine'), 'schedule')
  assert.equal(taskClassOf('普通一句话', 'routine'), 'schedule')
  assert.equal(taskClassOf('成员消息', 'bot-message'), 'member-report')
  assert.equal(taskClassOf('同伴消息', 'a2a'), 'a2a')
  assert.equal(taskClassOf('你好', 'user'), 'user-task')
  assert.equal(taskClassOf('你好', 'team-report'), 'unknown')
})

// ── deadline budget: four sources + clamp ──────────────────────────────────

test('a well-sampled key uses its own p95 × safety factor', () => {
  const budget = deriveDeadlineBudget({
    durationsMs: [600 * SEC, 600 * SEC, 600 * SEC, 600 * SEC, 600 * SEC],
    originDurationsMs: [],
    allDurationsMs: [],
    policy,
  })
  assert.equal(budget.source, 'key')
  assert.equal(budget.samples, 5)
  // p95 = 600 s × 1.5 = 900 s, but the clamp raises it to 3×median = 1 800 s: five equal
  // 600 s runs are not evidence that 600 s is a ceiling.
  assert.equal(budget.budgetMs, 1_800 * SEC)
})

test('the floor (and 3×median) stops a fast sample from killing a slower task', () => {
  const budget = deriveDeadlineBudget({
    durationsMs: [10 * SEC, 10 * SEC, 10 * SEC, 10 * SEC, 10 * SEC],
    originDurationsMs: [],
    allDurationsMs: [],
    policy,
  })
  // raw = 10 s × 1.5 = 15 s → floor 180 s wins.
  assert.equal(budget.budgetMs, policy.floorMs)
  const custom: RunTimeoutPolicy = { ...policy, floorMs: 1_000, capMs: 10 * MIN }
  const noisy = deriveDeadlineBudget({
    durationsMs: [100, 100, 100, 100, 100, 600_000],
    originDurationsMs: [],
    allDurationsMs: [],
    policy: custom,
  })
  // median 100 → 3×median = 300; floor 1 000 wins; raw p95×1.5 is large, so cap does not bind.
  assert.ok(noisy.budgetMs >= 1_000)
})

test('falls back: key → origin → all → bootstrap', () => {
  const origin = deriveDeadlineBudget({
    durationsMs: [SEC],
    originDurationsMs: Array.from({ length: MIN_SAMPLE_SIZE }, () => 400 * SEC),
    allDurationsMs: [SEC, SEC, SEC, SEC, SEC],
    policy,
  })
  assert.equal(origin.source, 'origin')
  assert.equal(origin.budgetMs, 1_200 * SEC)   // 400 s × 3 (median clamp)

  const all = deriveDeadlineBudget({
    durationsMs: [],
    originDurationsMs: [SEC],
    allDurationsMs: Array.from({ length: MIN_SAMPLE_SIZE }, () => 200 * SEC),
    policy,
  })
  assert.equal(all.source, 'all')
  assert.equal(all.budgetMs, 600 * SEC)        // 200 s × 3 (median clamp)

  const cold = deriveDeadlineBudget({ durationsMs: [], originDurationsMs: [], allDurationsMs: [], policy })
  assert.equal(cold.source, 'bootstrap')
  assert.equal(cold.samples, 0)
  assert.equal(cold.budgetMs, policy.bootstrapMs)
  // The bootstrap is CONFIG (15 min here), not a hidden constant in the code path.
  assert.equal(cold.budgetMs, 900 * SEC)
})

test('the cap bounds the long tail instead of a literal 600 000 deadline', () => {
  const budget = deriveDeadlineBudget({
    durationsMs: REAL_HISTORY_MS,
    originDurationsMs: [],
    allDurationsMs: [],
    policy,
  })
  // p95 of 7 samples is the largest (5 052 s) × 1.5 = 7 578 s > 2 h cap → cap wins.
  assert.equal(budget.source, 'key')
  assert.equal(budget.budgetMs, policy.capMs)
  // The point of the whole module: the budget is larger than the longest real run and is
  // nowhere near a fixed 600 s.
  assert.ok(budget.budgetMs > 5_052 * SEC)
  assert.notEqual(budget.budgetMs, 600_000)
  assert.ok(REAL_HISTORY_MS.filter(d => d > 600_000).length >= 3)
})

test('a partial policy overrides the defaults and is clamped', () => {
  const resolved = resolveTimeoutPolicy({ bootstrapMs: 1_000, floorMs: 99_000_000, capMs: 2_000_000 })
  assert.equal(resolved.capMs, 2_000_000)
  assert.equal(resolved.floorMs, 2_000_000)      // floor never exceeds cap
  assert.equal(resolved.bootstrapMs, 1_000)
  assert.equal(resolved.safetyFactor, DEFAULT_RUN_TIMEOUT_POLICY.safetyFactor)
})

// ── no-progress ─────────────────────────────────────────────────────────────

test('no-progress window is floor, measured p95 × factor, then cap', () => {
  assert.equal(noProgressLimitMs(policy), policy.noProgressFloorMs)                 // no data → 120 s
  assert.equal(noProgressLimitMs(policy, 10 * SEC), policy.noProgressFloorMs)       // 30 s → floor
  assert.equal(noProgressLimitMs(policy, 300 * SEC), 900 * SEC)                     // 300 × 3
  assert.equal(noProgressLimitMs(policy, 3_600 * SEC), policy.noProgressCapMs)      // capped 30 min
})

test('progressIsRecent follows the no-progress window', () => {
  const now = 10_000_000
  assert.equal(progressIsRecent(now, undefined, policy), false)
  assert.equal(progressIsRecent(now, now - 60 * SEC, policy), true)
  assert.equal(progressIsRecent(now, now - 10 * MIN, policy), false)
  // A timestamp in the future (clock skew) is not proof of progress.
  assert.equal(progressIsRecent(now, now + 5 * SEC, policy), false)
})

// ── extension chain ────────────────────────────────────────────────────────

const START = 1_000_000
const BASE = 900 * SEC
const DEADLINE = START + BASE
const baseInput = {
  nowMs: DEADLINE,
  deadlineAtMs: DEADLINE,
  lastProgressAtMs: DEADLINE - 10 * SEC,  // progressing right up to the deadline
  policy,
  extensions: 0,
  startedAtMs: START,
  baseBudgetMs: BASE,
}

test('before the deadline the verdict is ok', () => {
  assert.equal(shouldExtend({ ...baseInput, nowMs: DEADLINE - 1 }), 'ok')
})

test('at the deadline with recent progress: extend; without progress: timed-out', () => {
  assert.equal(shouldExtend(baseInput), 'extend')
  assert.equal(shouldExtend({ ...baseInput, lastProgressAtMs: DEADLINE - 20 * MIN }), 'timed-out')
  assert.equal(shouldExtend({ ...baseInput, lastProgressAtMs: undefined }), 'timed-out')
})

test('the extension chain stops at maxExtensions and at the cap', () => {
  assert.equal(shouldExtend({ ...baseInput, extensions: policy.maxExtensions }), 'timed-out')
  // Two extensions of 450 s each are still far inside the 2 h cap from start.
  const first = nextExtensionDeadline(baseInput)
  assert.equal(first, DEADLINE + BASE * policy.extendFactor)
  const second = shouldExtend({
    ...baseInput, nowMs: first!, deadlineAtMs: first!, lastProgressAtMs: first! - 10 * SEC, extensions: 1,
  })
  assert.equal(second, 'extend')
  const secondDeadline = nextExtensionDeadline({
    ...baseInput, deadlineAtMs: first!, lastProgressAtMs: first! - 10 * SEC, extensions: 1,
  })
  assert.equal(secondDeadline, first! + BASE * policy.extendFactor)
  // A deadline already at the cap cannot be extended at all.
  const capped = shouldExtend({
    ...baseInput,
    nowMs: START + policy.capMs,
    deadlineAtMs: START + policy.capMs,
    lastProgressAtMs: START + policy.capMs - 10 * SEC,
    extensions: 0,
  })
  assert.equal(capped, 'timed-out')
  assert.equal(nextExtensionDeadline({
    ...baseInput,
    deadlineAtMs: START + policy.capMs,
  }), undefined)
})

test('an extension never overshoots the cap from the run start', () => {
  const capAt = START + policy.capMs
  const nearCap = capAt - 10_000
  const next = nextExtensionDeadline({ ...baseInput, deadlineAtMs: nearCap })
  assert.equal(next, capAt)
  // One millisecond later there is no room left: undefined, so the caller times out.
  assert.equal(nextExtensionDeadline({ ...baseInput, deadlineAtMs: capAt }), undefined)
})

// ── retry policy ───────────────────────────────────────────────────────────

test('retry backoff is exponential and bounded', () => {
  assert.equal(retryBackoffMs({ maxAttempts: 3, backoffMs: 5_000 }, 0), 5_000)
  assert.equal(retryBackoffMs({ maxAttempts: 3, backoffMs: 5_000 }, 1), 10_000)
  assert.equal(retryBackoffMs({ maxAttempts: 3, backoffMs: 5_000 }, 2), 20_000)
  // A corrupt attempt number must not overflow into an enormous wait.
  assert.ok(Number.isFinite(retryBackoffMs({ maxAttempts: 3, backoffMs: 5_000 }, 99)))
})

test('only transient failure kinds are retryable; a stop and a timeout are not', () => {
  for (const kind of ['provider', 'tool', 'lease-lost'] as const) {
    assert.equal(isRetryableFailureKind(kind), true)
  }
  for (const kind of ['timeout', 'no-progress', 'user-cancel', 'unknown'] as const) {
    assert.equal(isRetryableFailureKind(kind), false)
  }
})

test('classifyFailure maps the error text to a kind', () => {
  assert.equal(classifyFailure('interrupted', ''), 'user-cancel')
  assert.equal(classifyFailure('cancelled', ''), 'user-cancel')
  assert.equal(classifyFailure('failed', 'lease owner mismatch'), 'lease-lost')
  assert.equal(classifyFailure('failed', 'deadline exceeded'), 'timeout')
  assert.equal(classifyFailure('failed', 'no progress for 5 minutes'), 'no-progress')
  assert.equal(classifyFailure('failed', 'tool read failed'), 'tool')
  assert.equal(classifyFailure('failed', 'provider rejected the request'), 'provider')
  assert.equal(classifyFailure('failed', '模型请求失败'), 'provider')
  assert.equal(classifyFailure('failed', 'something odd'), 'unknown')
})

test('resolveRetryPolicy keeps the defaults usable', () => {
  assert.deepEqual(resolveRetryPolicy(undefined), DEFAULT_RUN_RETRY_POLICY)
  const custom = resolveRetryPolicy({ maxAttempts: 0, backoffMs: -1 })
  assert.equal(custom.maxAttempts, 1)
  assert.equal(custom.backoffMs, 0)
})

test('the runtime source carries no hardcoded 600 000 deadline', () => {
  // The user's correction verbatim: runTimeout must not be written as a constant. This is
  // the guard against someone reintroducing it while "keeping the old default".
  const files = ['run-budget.ts', 'runs.ts', 'index.ts', 'session-runner.ts', 'types.ts']
  const base = new URL('../packages/core/agent-community/src/', import.meta.url)
  for (const file of files) {
    const text = readFileSync(new URL(file, base), 'utf8')
    assert.equal(/600[_,]?000/.test(text), false, `${file} still contains a 600 000 literal`)
  }
})

test('clamp is total', () => {
  assert.equal(clamp(5, 1, 10), 5)
  assert.equal(clamp(-5, 1, 10), 1)
  assert.equal(clamp(50, 1, 10), 10)
  assert.equal(clamp(Number.NaN, 1, 10), 1)
  assert.equal(clamp(Number.POSITIVE_INFINITY, 1, 10), 1)
})
