/**
 * The S3 rule set: a room goal may continue itself ONLY inside a live user grant.
 *
 * These are the whole authorization semantics of "the bot started working without me":
 *
 *   · a Bot's `set`/`resume` is a PROPOSAL, never a grant;
 *   · a goal continues only while the user's grant has rounds left;
 *   · a Bot refreshing its progress text must not reset the spent rounds;
 *   · a pause/finish from the user keeps the grant (so resume is not a silent top-up).
 *
 * The service (`index.ts`) is now a thin shell around these functions, so if these pass the
 * automatic-run gate cannot be reopened by a caller that forgets a condition.
 *
 * Run with: node --test tests/room-goal.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyBotGoalChange,
  applyUserGoalChange,
  authorizeGoal,
  authorizedRoundBudget,
  canEditGoal,
  clampRoundBudget,
  describeGoal,
  goalAuthorizationUsable,
  goalContinuationDecision,
  goalStatusLabel,
  pauseGoal,
  resumeGoal,
  shouldContinueGoal,
  DEFAULT_GOAL_MAX_ROUNDS,
  GOAL_MAX_ROUNDS_LIMIT,
} from '../packages/core/agent-community/src/room-goal.ts'
import type { RoomGoal, RoomGoalAuthorization } from '../packages/core/agent-community/src/types.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:10:00.000Z'
const FUTURE = '2026-10-23T00:00:00.000Z'
const PAST = '2026-10-21T00:00:00.000Z'
const NOW = Date.parse(T1)

function grant(overrides: Partial<RoomGoalAuthorization> = {}): RoomGoalAuthorization {
  return { grantedBy: 'user', maxRounds: 3, roundsUsed: 0, grantedAt: T0, ...overrides }
}

function goal(overrides: Partial<RoomGoal> = {}): RoomGoal {
  return { text: '把论文库全部精读完', status: 'active', createdAt: T0, updatedAt: T0, authorization: grant(), ...overrides }
}

// ── continuation decision ───────────────────────────────────────────────────

test('no grant: a goal can never continue itself, even with tool activity and rounds left', () => {
  assert.equal(goalContinuationDecision({ goal: goal({ authorization: undefined }), hadToolActivity: true }), false)
  // An ACTIVE goal with a legacy counter but no grant is exactly the old unbounded loop:
  // it must be stopped, not resumed.
  assert.equal(goalContinuationDecision({ goal: goal({ authorization: undefined, continuations: 0 }), hadToolActivity: true }), false)
})

test('granted goal with rounds left and tool activity continues', () => {
  assert.equal(goalContinuationDecision({ goal: goal(), hadToolActivity: true }), true)
  assert.equal(goalContinuationDecision({ goal: goal({ authorization: grant({ roundsUsed: 2 }) }), hadToolActivity: true }), true)
})

test('granted goal with the budget spent does not continue', () => {
  assert.equal(goalContinuationDecision({ goal: goal({ authorization: grant({ roundsUsed: 3 }) }), hadToolActivity: true }), false)
  assert.equal(goalContinuationDecision({ goal: goal({ authorization: grant({ roundsUsed: 9 }) }), hadToolActivity: true }), false)
})

test('a round with no tool activity is a stall, not progress', () => {
  assert.equal(goalContinuationDecision({ goal: goal(), hadToolActivity: false }), false)
})

test('only ACTIVE goals continue: proposed / paused / done are inert', () => {
  for (const status of ['proposed', 'paused', 'done'] as const) {
    assert.equal(goalContinuationDecision({ goal: goal({ status }), hadToolActivity: true }), false)
  }
})

test('an expired grant cannot continue; a live one can', () => {
  assert.equal(goalContinuationDecision({
    goal: goal({ authorization: grant({ expiresAt: PAST }) }),
    hadToolActivity: true,
    nowMs: NOW,
  }), false)
  assert.equal(goalContinuationDecision({
    goal: goal({ authorization: grant({ expiresAt: FUTURE }) }),
    hadToolActivity: true,
    nowMs: NOW,
  }), true)
})

test('a caller-supplied round counter overrides the stored one for the decision', () => {
  assert.equal(goalContinuationDecision({ goal: goal(), hadToolActivity: true, roundsUsed: 3 }), false)
  assert.equal(goalContinuationDecision({ goal: goal({ authorization: grant({ roundsUsed: 3 }) }), hadToolActivity: true, roundsUsed: 0 }), true)
})

test('legacy shouldContinueGoal wrapper can only tighten the grant, never bypass it', () => {
  const legacy = { goalDriven: true, hadToolActivity: true, continuations: 0 }
  // No grant → false, whatever the old flags say.
  assert.equal(shouldContinueGoal({ ...legacy, goal: goal({ authorization: undefined }) }), false)
  // Grant → the old ceiling may only shorten it.
  assert.equal(shouldContinueGoal({ ...legacy, goal: goal(), maxContinuations: 3 }), true)
  assert.equal(shouldContinueGoal({ ...legacy, goal: goal({ authorization: grant({ roundsUsed: 2 }) }), continuations: 2, maxContinuations: 3 }), true)
  assert.equal(shouldContinueGoal({ ...legacy, goal: goal(), continuations: 3, maxContinuations: 3 }), false)
})

// ── budget helpers ─────────────────────────────────────────────────────────

test('authorizedRoundBudget reports the grant, or nothing when there is no user grant', () => {
  assert.equal(authorizedRoundBudget(undefined), undefined)
  assert.equal(authorizedRoundBudget(goal({ authorization: undefined })), undefined)
  assert.deepEqual(authorizedRoundBudget(goal({ authorization: grant({ maxRounds: 3, roundsUsed: 1 }) })), {
    maxRounds: 3,
    roundsUsed: 1,
    remaining: 2,
  })
})

test('clampRoundBudget keeps a grant between 1 and the hard ceiling, default otherwise', () => {
  assert.equal(clampRoundBudget(undefined), DEFAULT_GOAL_MAX_ROUNDS)
  assert.equal(clampRoundBudget(Number.NaN), DEFAULT_GOAL_MAX_ROUNDS)
  assert.equal(clampRoundBudget(0), 1)
  assert.equal(clampRoundBudget(7), 7)
  assert.equal(clampRoundBudget(999), GOAL_MAX_ROUNDS_LIMIT)
})

test('goalAuthorizationUsable rejects missing, foreign and expired grants', () => {
  assert.equal(goalAuthorizationUsable(undefined), false)
  assert.equal(goalAuthorizationUsable(goal({ authorization: undefined })), false)
  assert.equal(goalAuthorizationUsable(goal()), true)
  assert.equal(goalAuthorizationUsable(goal({ authorization: grant({ expiresAt: PAST }) }), NOW), false)
  assert.equal(goalAuthorizationUsable(goal({ authorization: grant({ expiresAt: FUTURE }) }), NOW), true)
})

// ── a BOT may propose, never grant ─────────────────────────────────────────

test('a bot setting a goal with no previous goal produces a proposal with no grant', () => {
  const change = applyBotGoalChange(undefined, { action: 'set', text: '把论文读完', now: T0, botId: 'bot-a' as never })
  assert.ok(change !== undefined)
  assert.equal(change.outcome, 'proposed')
  assert.equal(change.goal.status, 'proposed')
  assert.equal(change.goal.authorization, undefined)
  assert.equal(change.goal.ownerBotId, 'bot-a')
  assert.equal(goalContinuationDecision({ goal: change.goal, hadToolActivity: true }), false)
})

test('a bot cannot pause/resume/finish a goal that does not exist', () => {
  for (const action of ['pause', 'resume', 'done'] as const) {
    assert.equal(applyBotGoalChange(undefined, { action, now: T0 }), undefined)
  }
})

test('a bot set on an AUTHORIZED ACTIVE goal only refreshes the text — budget is preserved', () => {
  const previous = goal({ authorization: grant({ roundsUsed: 2 }) })
  const change = applyBotGoalChange(previous, { action: 'set', text: '进度 815/831', now: T1, botId: 'bot-a' as never })
  assert.ok(change !== undefined)
  assert.equal(change.outcome, 'active')
  assert.equal(change.goal.status, 'active')
  assert.equal(change.goal.text, '进度 815/831')
  assert.equal(change.goal.authorization?.roundsUsed, 2)
  assert.equal(change.goal.authorization?.maxRounds, 3)
  // The decisive assertion: a progress update every round cannot reopen the budget.
  assert.equal(goalContinuationDecision({ goal: change.goal, hadToolActivity: true }), true)
  const next = applyBotGoalChange(change.goal, { action: 'set', text: '进度 831/831', now: T1 })
  assert.equal(next?.goal.authorization?.roundsUsed, 2)
})

test('a bot set on a PAUSED or PROPOSED goal becomes a new proposal without a grant', () => {
  for (const status of ['paused', 'proposed', 'done'] as const) {
    const previous = goal({ status })
    const change = applyBotGoalChange(previous, { action: 'set', text: '新目标', now: T1, botId: 'bot-a' as never })
    assert.ok(change !== undefined)
    assert.equal(change.outcome, 'proposed')
    assert.equal(change.goal.authorization, undefined)
  }
})

test('a bot resume NEVER re-arms continuation: it is always a proposal', () => {
  // Even on an active, user-authorized goal: re-arming is the user's decision.
  const active = applyBotGoalChange(goal({ authorization: grant({ roundsUsed: 1 }) }), { action: 'resume', now: T1 })
  assert.equal(active?.outcome, 'proposed')
  assert.equal(active?.goal.status, 'proposed')
  assert.equal(active?.goal.authorization, undefined)
  assert.equal(goalContinuationDecision({ goal: active?.goal, hadToolActivity: true }), false)
  // From paused, same rule.
  const paused = applyBotGoalChange(goal({ status: 'paused', authorization: grant({ roundsUsed: 1 }) }), { action: 'resume', now: T1 })
  assert.equal(paused?.outcome, 'proposed')
  assert.equal(paused?.goal.authorization, undefined)
})

test('a bot may pause or finish an existing goal (authority over the objective stays)', () => {
  const paused = applyBotGoalChange(goal(), { action: 'pause', now: T1 })
  assert.equal(paused?.goal.status, 'paused')
  // The grant survives a pause so resuming is not a silent top-up.
  assert.equal(paused?.goal.authorization?.roundsUsed, 0)
  const done = applyBotGoalChange(goal(), { action: 'done', now: T1 })
  assert.equal(done?.goal.status, 'done')
})

// ── the USER is the authorizer ─────────────────────────────────────────────

test('the user setting an active goal writes a fresh grant', () => {
  const change = applyUserGoalChange(undefined, { status: 'active', text: '把论文读完', now: T0 })
  assert.ok(change !== undefined)
  assert.equal(change.outcome, 'active')
  assert.equal(change.goal.status, 'active')
  assert.deepEqual(change.goal.authorization !== undefined && {
    grantedBy: change.goal.authorization.grantedBy,
    maxRounds: change.goal.authorization.maxRounds,
    roundsUsed: change.goal.authorization.roundsUsed,
  }, { grantedBy: 'user', maxRounds: DEFAULT_GOAL_MAX_ROUNDS, roundsUsed: 0 })
  assert.equal(goalContinuationDecision({ goal: change.goal, hadToolActivity: true }), true)
})

test('the user may set the round budget; it is clamped', () => {
  const wide = applyUserGoalChange(undefined, { status: 'active', text: 'x', now: T0, maxRounds: 99 })
  assert.equal(wide?.goal.authorization?.maxRounds, GOAL_MAX_ROUNDS_LIMIT)
  const tiny = applyUserGoalChange(undefined, { status: 'active', text: 'x', now: T0, maxRounds: 0 })
  assert.equal(tiny?.goal.authorization?.maxRounds, 1)
})

test('the user pausing keeps the grant and its spent rounds (resume is not a top-up)', () => {
  const previous = goal({ authorization: grant({ roundsUsed: 2 }) })
  const paused = applyUserGoalChange(previous, { status: 'paused', now: T1 })
  assert.equal(paused?.goal.status, 'paused')
  assert.equal(paused?.goal.authorization?.roundsUsed, 2)
  const done = applyUserGoalChange(previous, { status: 'done', now: T1 })
  assert.equal(done?.goal.status, 'done')
  assert.equal(done?.goal.authorization?.roundsUsed, 2)
})

test('a user state change with no text and no previous goal is refused', () => {
  assert.equal(applyUserGoalChange(undefined, { status: 'paused', now: T0 }), undefined)
  assert.equal(applyUserGoalChange(undefined, { status: 'active', text: '   ', now: T0 }), undefined)
})

test('authorizeGoal re-arms with a fresh budget and keeps the objective text', () => {
  const previous = goal({ authorization: grant({ roundsUsed: 3 }) })
  const authorized = authorizeGoal(previous, { now: T1, maxRounds: 5 })
  assert.equal(authorized.status, 'active')
  assert.equal(authorized.text, previous.text)
  assert.equal(authorized.authorization?.maxRounds, 5)
  assert.equal(authorized.authorization?.roundsUsed, 0)
})

test('pauseGoal keeps the grant; resumeGoal spends the old grant, or issues a fresh one when spent', () => {
  const pausedAffordable = pauseGoal(goal({ authorization: grant({ roundsUsed: 1 }) }), T1)
  const resumed = resumeGoal(pausedAffordable, { now: T1 })
  assert.equal(resumed.status, 'active')
  assert.equal(resumed.authorization?.roundsUsed, 1)

  const pausedExhausted = pauseGoal(goal({ authorization: grant({ roundsUsed: 3 }) }), T1)
  const fresh = resumeGoal(pausedExhausted, { now: T1 })
  assert.equal(fresh.status, 'active')
  assert.equal(fresh.authorization?.roundsUsed, 0)

  const pausedExpired = pauseGoal(goal({ authorization: grant({ expiresAt: PAST }) }), T1)
  assert.equal(resumeGoal(pausedExpired, { now: T1 }).authorization?.roundsUsed, 0)
})

// ── prompt / authority surface ─────────────────────────────────────────────

test('describeGoal labels a proposal honestly (never as running work)', () => {
  assert.equal(describeGoal(goal({ status: 'proposed', text: '建议' })), '[待确认] 建议')
  assert.equal(describeGoal(goal({ status: 'active', text: '目标' })), '[进行中] 目标')
  assert.equal(describeGoal(goal({ status: 'paused', text: '目标' })), '[已暂停] 目标')
  assert.equal(describeGoal(goal({ status: 'done', text: '目标' })), '[已完成] 目标')
})

test('goalStatusLabel covers every status', () => {
  assert.equal(goalStatusLabel('active'), '进行中')
  assert.equal(goalStatusLabel('paused'), '已暂停')
  assert.equal(goalStatusLabel('proposed'), '待确认')
  assert.equal(goalStatusLabel('done'), '已完成')
})

test('canEditGoal keeps the existing room authority model', () => {
  assert.equal(canEditGoal({ kind: 'user' }, undefined), true)
  assert.equal(canEditGoal({ kind: 'bot', botId: 'bot-a', roomKind: 'direct' }, 'bot-a'), true)
  assert.equal(canEditGoal({ kind: 'bot', botId: 'bot-b', roomKind: 'group' }, 'bot-a'), false)
})

// ── end-to-end (pure) replay of the loop the user reported ─────────────────

test('a bot updating its progress text every round cannot extend the user budget', () => {
  // The real incident: 38 automatic runs from ONE user message. Replay it at the pure level:
  // every round the bot refreshes the goal text (as it did), and the budget must still end at 3.
  let current: RoomGoal = goal({ authorization: grant({ maxRounds: 3 }) })
  const continued: number[] = []
  for (let round = 1; round <= 10; round++) {
    if (!goalContinuationDecision({ goal: current, hadToolActivity: true })) break
    continued.push(round)
    const updated = applyBotGoalChange(current, { action: 'set', text: `进度 ${round * 20}/200`, now: T1 })
    assert.ok(updated !== undefined)
    assert.equal(updated.outcome, 'active')
    // The grant survives the progress update, with the round this loop is about to spend.
    current = {
      ...updated.goal,
      authorization: updated.goal.authorization === undefined
        ? undefined
        : { ...updated.goal.authorization, roundsUsed: round },
    }
  }
  assert.deepEqual(continued, [1, 2, 3])
  assert.equal(goalContinuationDecision({ goal: current, hadToolActivity: true }), false)
})
