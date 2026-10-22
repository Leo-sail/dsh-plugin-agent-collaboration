/**
 * Unit tests for the publish policy (packages/core/agent-community/src/publish-policy.ts).
 *
 * These are the whole rule set behind "the group answered once": which runs may render,
 * and what single body a settled run delivers when both a reply and a `finish_task`
 * report exist. The service and the ledger projection both call these pure functions, so
 * if they are right the duplicate cannot be reintroduced by either side drifting.
 *
 * Run with: node --test tests/publish-policy.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_RUN_PUBLISH,
  chooseFinalDelivery,
  publishOf,
  shouldPublishRun,
} from '../packages/core/agent-community/src/publish-policy.ts'
import { routeMessage } from '../packages/core/agent-community/src/routing.ts'

// ── shouldPublishRun / publishOf ─────────────────────────────────────────────

test('a run with no publish flag is visible (historical behaviour)', () => {
  assert.equal(shouldPublishRun(undefined), true)
  assert.equal(shouldPublishRun({}), true)
  assert.equal(publishOf(undefined), DEFAULT_RUN_PUBLISH)
  assert.equal(publishOf({}), 'visible')
})

test('only publish:internal suppresses rendering', () => {
  assert.equal(shouldPublishRun({ publish: 'internal' }), false)
  assert.equal(publishOf({ publish: 'internal' }), 'internal')
  assert.equal(shouldPublishRun({ publish: 'visible' }), true)
  assert.equal(publishOf({ publish: 'visible' }), 'visible')
})

// ── chooseFinalDelivery: visible runs ────────────────────────────────────────

test('visible run with text publishes its reply', () => {
  const delivery = chooseFinalDelivery({ replyText: '做完了，产出在 a.md', publish: 'visible' })
  assert.deepEqual(delivery, { text: '做完了，产出在 a.md', publishFinal: true })
})

test('visible run with no text falls back to the finish report', () => {
  // A tool-only turn that called finish_task has no reply of its own; the report IS the
  // delivery, and dropping it is the "task finished but the room is silent" defect.
  const delivery = chooseFinalDelivery({ replyText: '   ', finishReport: '最终汇报：全部完成', publish: 'visible' })
  assert.deepEqual(delivery, { text: '最终汇报：全部完成', publishFinal: true })
})

test('visible run with reply text and a report delivers the reply ONCE', () => {
  // Both describe the same delivery. Publishing both is exactly the duplicate this module
  // forbids, so the report must not appear anywhere in the result.
  const delivery = chooseFinalDelivery({
    replyText: '结论：已完成',
    finishReport: '结论：已完成（报告副本）',
    publish: 'visible',
  })
  assert.equal(delivery.publishFinal, true)
  assert.equal(delivery.text, '结论：已完成')
  assert.ok(!delivery.text.includes('报告副本'))
})

// ── chooseFinalDelivery: internal runs ───────────────────────────────────────

test('internal run with a finish report still delivers the report', () => {
  // The leader's integrate turn is coordination, but when it finishes the task it owes
  // the user the result — that single row is the only thing this turn may publish.
  const delivery = chooseFinalDelivery({ replyText: '我把大家的结论总结一下…', finishReport: '最终交付：…', publish: 'internal' })
  assert.deepEqual(delivery, { text: '最终交付：…', publishFinal: true })
})

test('internal run without a report publishes nothing (no restated answer)', () => {
  // This is the duplicate the user saw: the integrate turn restating what the members
  // already said in the room. Its text must not reach the transcript.
  const delivery = chooseFinalDelivery({ replyText: '各位成员已完成，我来汇总：…', publish: 'internal' })
  assert.deepEqual(delivery, { text: '', publishFinal: false })
})

test('internal run prefers the report over its own prose even when both exist', () => {
  const delivery = chooseFinalDelivery({
    replyText: '汇总一下成员的结果：A 做了…',
    finishReport: '最终交付：A 完成接口、B 完成测试',
    publish: 'internal',
  })
  assert.equal(delivery.publishFinal, true)
  assert.equal(delivery.text, '最终交付：A 完成接口、B 完成测试')
})

// ── chooseFinalDelivery: nothing to say ──────────────────────────────────────

test('no text and no report publishes nothing', () => {
  assert.deepEqual(chooseFinalDelivery({}), { text: '', publishFinal: false })
  assert.deepEqual(
    chooseFinalDelivery({ replyText: ' ', finishReport: '\n\t' }),
    { text: '', publishFinal: false },
  )
  assert.deepEqual(
    chooseFinalDelivery({ replyText: '', finishReport: '', publish: 'internal' }),
    { text: '', publishFinal: false },
  )
})

// ── the invariant both call sites rely on ────────────────────────────────────

test('a delivery is never the reply AND the report at once', () => {
  for (const publish of ['visible', 'internal'] as const) {
    const delivery = chooseFinalDelivery({ replyText: 'reply', finishReport: 'report', publish })
    assert.equal(delivery.publishFinal, true)
    assert.equal(delivery.text === 'reply' && delivery.text === 'report', false)
    assert.ok(delivery.text === 'reply' || delivery.text === 'report')
  }
})

// ── the routing half of the same defect (one message must not wake two bots) ──
//
// The duplicate this slice removes was reproduced by two bots whose role prompts both
// contained 「确认」: one short message tied at one hit each and woke both. The tie rule
// now sends the inference to ONE bot (the leader), while every EXPLICIT way of addressing
// several bots keeps working — those are the cases the user actually asked for.

const routeMembers = [
  {
    id: 'leader',
    name: '小马-商业顾问',
    description: '商业顾问：为一人公司做流程/岗位/协作设计与缺岗诊断',
    systemPrompt: '出任务书与验收标准；确认后派给执行者。',
  },
  {
    id: 'writer',
    name: '小董',
    description: 'Bot 提示词工程师：把模糊需求拆成需求/能力/任务/流程',
    systemPrompt: '写可落地的 agent 系统提示词；确认后应用。',
  },
]
const routeBase = {
  members: routeMembers,
  message: { text: '', mentions: [] },
  namedBotIds: [] as string[],
  leaderId: 'leader',
}

test('a role-keyword tie wakes the leader only, not every tied member', () => {
  const decision = routeMessage({ ...routeBase, message: { text: '1、允许；2、确认。', mentions: [] } })
  assert.deepEqual([...decision.targets], ['leader'])
  assert.equal(decision.reason, 'matched')
})

test('explicitly written names still wake both named members', () => {
  const decision = routeMessage({ ...routeBase, message: { text: '小马和小董都看一下', mentions: [] } })
  assert.deepEqual([...decision.targets].sort(), ['leader', 'writer'])
})

test('@all and collective words still wake the whole room', () => {
  const all = routeMessage({ ...routeBase, allMentioned: true, message: { text: '@all 你们好', mentions: [] } })
  assert.deepEqual([...all.targets].sort(), ['leader', 'writer'])
  const collective = routeMessage({ ...routeBase, message: { text: '大家一起看一下', mentions: [] } })
  assert.deepEqual([...collective.targets].sort(), ['leader', 'writer'])
})
