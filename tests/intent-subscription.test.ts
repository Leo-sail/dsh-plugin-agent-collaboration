/**
 * Unit tests for OP-18 intent subscriptions and their place in routing.
 *
 * Covered: normalization limits, case-insensitive containment matching, per-bot/overall caps,
 * and the router's precedence — explicit `@`/`@all` beat subscriptions, subscriptions beat the
 * lexical fallback, and a subscription for a non-member changes nothing.
 *
 * Run with: node --test tests/intent-subscription.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SUBSCRIPTIONS,
  MAX_SUBSCRIPTION_CHARS,
  matchSubscriptionTerms,
  matchSubscriptions,
  normalizeSubscriptions,
} from '../packages/core/agent-community/src/intent-subscription.ts'
import { routeMessage } from '../packages/core/agent-community/src/routing.ts'
import type { RouteInput } from '../packages/core/agent-community/src/routing.ts'

// ── normalization ───────────────────────────────────────────────────────────

test('subscriptions are trimmed, emptied, deduplicated and clipped', () => {
  assert.deepEqual(normalizeSubscriptions(undefined), [])
  assert.deepEqual(normalizeSubscriptions([]), [])
  assert.deepEqual(
    normalizeSubscriptions([' 数据 ', '', '   ', '图表', '数据', 'DATA', 'data']),
    ['数据', '图表', 'DATA'],
  )
  const long = '长'.repeat(MAX_SUBSCRIPTION_CHARS + 10)
  const clipped = normalizeSubscriptions([long])[0] ?? ''
  assert.equal([...clipped].length, MAX_SUBSCRIPTION_CHARS)
})

test('a bot can declare at most MAX_SUBSCRIPTIONS entries, in input order', () => {
  const input = Array.from({ length: MAX_SUBSCRIPTIONS + 5 }, (_, i) => `关键词${i}`)
  const normalized = normalizeSubscriptions(input)
  assert.equal(normalized.length, MAX_SUBSCRIPTIONS)
  assert.equal(normalized[0], '关键词0')
  assert.equal(normalized[MAX_SUBSCRIPTIONS - 1], `关键词${MAX_SUBSCRIPTIONS - 1}`)
})

// ── matching ────────────────────────────────────────────────────────────────

test('matching is case-insensitive containment and reports at most three terms', () => {
  assert.deepEqual(matchSubscriptionTerms(['Data', '图表', 'PPT'], '请把 DATA 做成图表，附 PPT'), ['Data', '图表', 'PPT'])
  assert.deepEqual(matchSubscriptionTerms(['数据', '图表'], '今天天气不错'), [])
  assert.deepEqual(matchSubscriptionTerms(undefined, '数据'), [])
  assert.deepEqual(matchSubscriptionTerms(['数据'], '   '), [])
  assert.deepEqual(
    matchSubscriptionTerms(['a1', 'b2', 'c3', 'd4', 'e5'], 'a1 b2 c3 d4 e5'),
    ['a1', 'b2', 'c3'],
  )
})

test('bots are ranked by hit count, ties keep the caller order, at most three bots', () => {
  const bots = [
    { id: 'one', subscriptions: ['数据'] },
    { id: 'two', subscriptions: ['数据', '报表'] },
    { id: 'three', subscriptions: [] },
    { id: 'four', subscriptions: ['数据'] },
    { id: 'five', subscriptions: ['数据'] },
  ]
  const matches = matchSubscriptions(bots, '帮我整理数据和报表')
  assert.deepEqual(matches.map(match => match.botId), ['two', 'one', 'four'])
  assert.deepEqual(matches[0]?.terms, ['数据', '报表'])
})

// ── routing precedence ─────────────────────────────────────────────────────

/** Two members plus a leader; `one` and `two` subscribe to 图表. */
function routeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  const members = [
    { id: 'leader', name: 'leader', description: '协调者' },
    { id: 'one', name: 'one', description: '数据' },
    { id: 'two', name: 'two', description: '设计' },
  ]
  return {
    members,
    message: { text: '把这份图表的数据整理一下', mentions: [] },
    leaderId: 'leader',
    subscriptions: { one: ['图表'], two: ['图表'] },
    ...overrides,
  }
}

test('an explicit @mention outranks a subscription match', () => {
  const decision = routeMessage(routeInput({
    message: { text: '把这份图表给 two 看', mentions: ['two'], mentionedIds: ['two'] },
  }))
  assert.equal(decision.reason, 'mention')
  assert.deepEqual(decision.targets, ['two'])
})

test('@all outranks a subscription match', () => {
  const decision = routeMessage(routeInput({ allMentioned: true }))
  assert.equal(decision.reason, 'all')
  assert.deepEqual(decision.targets, ['leader', 'one', 'two'])
})

test('without an explicit mention, subscriptions pick the targets', () => {
  const decision = routeMessage(routeInput())
  assert.equal(decision.reason, 'subscription')
  assert.deepEqual(decision.targets, ['one', 'two'])
  assert.deepEqual(decision.matched['one'], ['图表'])
})

test('at most two subscriber targets are woken, in member order', () => {
  const decision = routeMessage(routeInput({
    members: [
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
      { id: 'c', name: 'c' },
    ],
    leaderId: 'a',
    subscriptions: { c: ['图表'], b: ['图表'], a: ['图表'] },
  }))
  assert.equal(decision.reason, 'subscription')
  assert.deepEqual(decision.targets, ['a', 'b'])
})

test('a subscription held by a non-member is ignored; no match keeps the old routing', () => {
  const input = routeInput({
    // `three` is not a member, so its subscription can never route into this room.
    subscriptions: { three: ['图表'] },
  })
  const decision = routeMessage(input)
  assert.notEqual(decision.reason, 'subscription')
  // `one`'s role is 数据 and the text says 数据, so the role matcher still answers.
  assert.deepEqual(decision.targets, ['one'])
})

test('leaving subscriptions out keeps the pre-subscription routing exactly', () => {
  const withoutSubscriptions = routeMessage({
    members: [
      { id: 'leader', name: 'leader', description: '协调者' },
      { id: 'one', name: 'one', description: '数据' },
    ],
    message: { text: '把这份图表的数据整理一下', mentions: [] },
    leaderId: 'leader',
  })
  assert.equal(withoutSubscriptions.reason, 'matched')
  assert.deepEqual(withoutSubscriptions.targets, ['one'])
})
