/**
 * Unit tests for OP-18 reputation statistics and the throttled watchdog.
 *
 * Covered: board aggregation (done/failed/reported/samples/rate), the rate floor, the watchdog
 * thresholds and ordering, the exact reminder wording, and the once-per-room cooldown.
 *
 * Run with: node --test tests/reputation.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPUTATION_NOTICE_COOLDOWN_MS,
  ReputationWatchdog,
  botReputations,
  reputationNoticeText,
  reputationWatch,
} from '../packages/core/agent-community/src/reputation.ts'
import type { RoomReputationSource } from '../packages/core/agent-community/src/reputation.ts'

/** One room board from (botId, status) pairs. */
function room(rows: ReadonlyArray<readonly [string, string]>): RoomReputationSource {
  return { taskState: { assignments: rows.map(([botId, status]) => ({ botId, status })) } }
}

test('the board aggregates per bot across rooms, whatever order the rows arrive in', () => {
  const rooms: RoomReputationSource[] = [
    room([['a', 'done'], ['b', 'done'], ['a', 'blocked']]),
    room([['a', 'done'], ['b', 'failed']]),
  ]
  const reps = botReputations(rooms)
  assert.deepEqual(reps.map(rep => rep.botId), ['a', 'b'])
  const a = reps[0]!
  assert.equal(a.done, 2)
  assert.equal(a.failed, 1)
  assert.equal(a.samples, 3)
  assert.equal(a.successRate, 2 / 3)
})

test('reported counts independently of done/failed, and no board yields no rows', () => {
  const rooms: RoomReputationSource[] = [
    {
      taskState: {
        assignments: [
          { botId: 'a', status: 'reported', report: { text: '完成了一部分', at: '2026-10-22T00:00:00.000Z' } },
          { botId: 'a', status: 'working', report: { text: '在做了', at: '2026-10-22T00:01:00.000Z' } },
          { botId: 'a', status: 'cancelled' },
        ],
      },
    },
  ]
  const rep = botReputations(rooms)[0]!
  assert.equal(rep.done, 0)
  assert.equal(rep.failed, 1)
  assert.equal(rep.reported, 2)
  assert.equal(rep.samples, 1)
  assert.deepEqual(botReputations([]), [])
})

test('a completion rate needs two settled rows; below that it stays undefined', () => {
  const oneDone = botReputations([room([['a', 'done'], ['b', 'blocked']])])
  for (const rep of oneDone) {
    assert.equal(rep.samples, 1)
    assert.equal(rep.successRate, undefined)
  }
  const twoRows = botReputations([room([['a', 'done'], ['a', 'failed']])])[0]!
  assert.equal(twoRows.successRate, 0.5)
})

// ── watchdog thresholds ────────────────────────────────────────────────────

/** Build a reputation row directly, for threshold arithmetic. */
function rep(botId: string, done: number, failed: number) {
  const samples = done + failed
  return {
    botId,
    done,
    failed,
    reported: 0,
    samples,
    ...(samples >= 2 ? { successRate: done / samples } : {}),
  }
}

test('only low-rate bots with enough samples are reported, worst first', () => {
  const low = reputationWatch([
    rep('thin', 1, 2), // 33% but only 3 samples → below the 4-row floor
    rep('low', 1, 4), // 20% over 5 → reported
    rep('lower', 0, 4), // 0% over 4 → reported, worst
    rep('ok', 4, 4), // 50% → not reported
  ])
  assert.deepEqual(low.map(item => item.botId), ['lower', 'low'])
})

test('the thresholds are overridable for other policies', () => {
  const rows = [rep('a', 1, 2), rep('b', 4, 1)]
  assert.deepEqual(reputationWatch(rows).map(item => item.botId), [])
  assert.deepEqual(
    reputationWatch(rows, { minSamples: 2, lowRate: 0.5 }).map(item => item.botId),
    ['a'],
  )
})

test('the notice names the bot, the ratio and the two suggested actions', () => {
  const text = reputationNoticeText('小赵', rep('x', 1, 4))
  assert.equal(text, '声誉观察：小赵 最近完成率偏低（1/5），建议换人或补上下文。')
})

// ── cooldown ───────────────────────────────────────────────────────────────

test('the watchdog speaks at most once per room per cooldown, and re-arms afterwards', () => {
  const bad = room([['a', 'failed'], ['a', 'failed'], ['a', 'failed'], ['a', 'done']]) // 25% / 4
  const watchdog = new ReputationWatchdog(1000)
  const base = 1_000_000
  const check = (nowMs: number) => watchdog.check({
    roomId: 'r1',
    rooms: [bad],
    botName: botId => (botId === 'a' ? '阿宝' : botId),
    nowMs,
  })
  assert.equal(check(base), '声誉观察：阿宝 最近完成率偏低（1/4），建议换人或补上下文。')
  assert.equal(check(base + 500), undefined, 'inside the cooldown')
  assert.equal(check(base + 1000), '声誉观察：阿宝 最近完成率偏低（1/4），建议换人或补上下文。')
  // A different room has its own window.
  assert.ok(watchdog.check({
    roomId: 'r2',
    rooms: [bad],
    botName: botId => botId,
    nowMs: base + 1000,
  }) !== undefined)
})

test('a quiet board does not consume the cooldown window', () => {
  const good = room([['a', 'done'], ['a', 'done'], ['a', 'done'], ['a', 'done']])
  const bad = room([['a', 'failed'], ['a', 'failed'], ['a', 'failed'], ['a', 'done']])
  const watchdog = new ReputationWatchdog(REPUTATION_NOTICE_COOLDOWN_MS)
  const base = 5_000_000
  assert.equal(watchdog.check({ roomId: 'r1', rooms: [good], botName: botId => botId, nowMs: base }), undefined)
  assert.notEqual(
    watchdog.check({ roomId: 'r1', rooms: [bad], botName: botId => botId, nowMs: base + 60_000 }),
    undefined,
    'the first real signal right after a quiet check is still spoken',
  )
})
