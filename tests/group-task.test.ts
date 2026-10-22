/**
 * Unit tests for the group-task driver's orchestration half (group-task.ts).
 *
 * These are the rules that used to have no caller at all — the no-progress guard, the round
 * budget mirror, the "a new instruction starts a new task" reset, and "a removed member must
 * not hang the fan-out for ever". They are pure driver behaviour, so a fake accessor is
 * enough: no service, no host, no model.
 *
 * Run with: node --test tests/group-task.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GroupTaskDriver } from '../packages/core/agent-community/src/group-task.ts'
import type { GroupTaskAccessor, GroupTaskState } from '../packages/core/agent-community/src/group-task.ts'

interface EnqueueCall {
  readonly roomId: string
  readonly botId: string
  readonly prompt: string
  readonly internal: boolean
}

interface Harness {
  readonly driver: GroupTaskDriver
  readonly calls: EnqueueCall[]
  readonly boards: Map<string, GroupTaskState>
  readonly roomId: string
  /** Flip whether the accessor accepts a run (false = the enqueue is refused). */
  setAcceptRuns(accept: boolean): void
  /** A run is live in the room (an idle leader turn must not count as a stall then). */
  setLiveRun(live: boolean): void
  /** The room's newest user instruction timestamp. */
  setLastMessage(at: string | undefined): void
  /** Simulate leadership hand-off after a leader was removed. */
  setLeader(botId: string): void
}

function makeHarness(options: { members?: readonly string[]; leader?: string } = {}): Harness {
  const roomId = 'room-1'
  const members = options.members ?? ['leader', 'member-a', 'member-b']
  let leader = options.leader ?? 'leader'
  let acceptRuns = true
  let liveRun = false
  let lastMessageAt: string | undefined
  const calls: EnqueueCall[] = []
  const boards = new Map<string, GroupTaskState>()

  const accessor: GroupTaskAccessor = {
    enqueueRun: (runRoomId, botId, prompt, enqueueOptions) => {
      if (!acceptRuns) return false
      calls.push({ roomId: runRoomId, botId, prompt, internal: enqueueOptions?.internal === true })
      return true
    },
    roomById: id => (id === roomId ? { memberIds: [...members] } : undefined),
    leaderOf: id => (id === roomId && members.includes(leader) ? leader : undefined),
    botName: id => id,
    hasLiveRun: () => liveRun,
    isCompacting: () => false,
    postReport: () => undefined,
    saveTaskState: (id, state) => { boards.set(id, state) },
    lastUserMessageAt: () => lastMessageAt,
    loadTaskState: id => boards.get(id),
  }

  return {
    driver: new GroupTaskDriver(accessor),
    calls,
    boards,
    roomId,
    setAcceptRuns: (accept) => { acceptRuns = accept },
    setLiveRun: (live) => { liveRun = live },
    setLastMessage: (at) => { lastMessageAt = at },
    setLeader: (botId) => { leader = botId },
  }
}

const leaderCalls = (h: Harness): EnqueueCall[] => h.calls.filter(call => call.botId === 'leader')
const callsFor = (h: Harness, botId: string): EnqueueCall[] => h.calls.filter(call => call.botId === botId)

// ── the fan-out → integrate path ────────────────────────────────────────────

test('a member run is visible; integration waits for the whole fan-out and is internal', async () => {
  const h = makeHarness()
  const assigned = h.driver.assign({ roomId: h.roomId, botIds: ['member-a', 'member-b'], task: '写一段' })
  assert.deepEqual(assigned.assigned, ['member-a', 'member-b'])
  assert.deepEqual(callsFor(h, 'member-a').map(c => c.internal), [false])
  assert.deepEqual(callsFor(h, 'member-b').map(c => c.internal), [false])

  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-a', text: 'A 完成', ok: true })
  assert.equal(leaderCalls(h).length, 0, 'one member still running: no integration yet')

  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-b', text: 'B 完成', ok: true })
  const integration = leaderCalls(h)
  assert.equal(integration.length, 1)
  assert.equal(integration[0]!.internal, true, 'the integrate turn is coordination, never an answer')
  assert.match(integration[0]!.prompt, /成员汇报/u)
  assert.match(integration[0]!.prompt, /A 完成/u)
})

test('a member woken without a hand-off never triggers integration', async () => {
  const h = makeHarness()
  // An @mention answer: no assignment row and no leader hand-off.
  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-a', text: '回答', ok: true })
  assert.equal(leaderCalls(h).length, 0)
})

// ── a removed member must not hang the fan-out ──────────────────────────────

test('forgetMember clears the member and wakes the leader once the fan-out is empty', async () => {
  const h = makeHarness()
  h.driver.assign({ roomId: h.roomId, botIds: ['member-a', 'member-b'], task: '并行做' })

  h.driver.forgetMember(h.roomId, 'member-a')
  assert.equal(leaderCalls(h).length, 0, 'member-b is still running')

  h.driver.forgetMember(h.roomId, 'member-b')
  const integration = leaderCalls(h)
  assert.equal(integration.length, 1)
  assert.equal(integration[0]!.internal, true)

  const board = h.boards.get(h.roomId)
  assert.ok(board !== undefined)
  assert.deepEqual(board.assignments.map(a => a.status), ['failed', 'failed'])
})

test('forgetMember drops the removed member report instead of integrating it', async () => {
  const h = makeHarness()
  h.driver.assign({ roomId: h.roomId, botIds: ['member-a', 'member-b'], task: '并行做' })
  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-a', text: 'A 的汇报', ok: true })

  h.driver.forgetMember(h.roomId, 'member-a')
  h.driver.forgetMember(h.roomId, 'member-b')
  const integration = leaderCalls(h)
  assert.equal(integration.length, 1)
  assert.doesNotMatch(integration[0]!.prompt, /A 的汇报/u)
})

test('forgetMember does not wake the leader for an idle member (nothing outstanding)', async () => {
  const h = makeHarness()
  h.driver.forgetMember(h.roomId, 'member-b')
  assert.equal(h.calls.length, 0)
})

test('removing the leader hands the integrate turn to the new leader', async () => {
  const h = makeHarness()
  h.driver.assign({ roomId: h.roomId, botIds: ['member-a'], task: '活' })
  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-a', text: '完成', ok: true })
  // The integration turn is now running as the OLD leader; then the leader is removed and
  // leadership moves to member-b (groupFlow writes this before calling forgetMember).
  assert.equal(leaderCalls(h).length, 1)
  h.setLeader('member-b')
  h.driver.forgetMember(h.roomId, 'leader')
  const toNewLeader = h.calls.filter(call => call.botId === 'member-b')
  assert.equal(toNewLeader.length, 1)
  assert.equal(toNewLeader[0]!.internal, true)
})

// ── stop closes the task for good ───────────────────────────────────────────

test('stop closes the board and suppresses every later integration', async () => {
  const h = makeHarness()
  h.driver.assign({ roomId: h.roomId, botIds: ['member-a', 'member-b'], task: '做' })
  h.driver.stop(h.roomId, '已达轮次上限 3 轮，协作已暂停')

  const board = h.boards.get(h.roomId)
  assert.ok(board !== undefined)
  assert.equal(board.finished?.report, '已达轮次上限 3 轮，协作已暂停')
  assert.deepEqual(board.assignments.map(a => a.status), ['failed', 'failed'])
  assert.equal(leaderCalls(h).length, 0)

  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-a', text: '还是做完了', ok: true })
  h.driver.forgetMember(h.roomId, 'member-b')
  assert.equal(leaderCalls(h).length, 0, 'a closed task never integrates again')
})

test('a closed task is reported finished (so it spends no more rounds)', () => {
  const h = makeHarness()
  h.setLastMessage('2026-10-22T00:00:00.000Z')
  assert.equal(h.driver.isFinished(h.roomId), false)
  h.driver.stop(h.roomId, '连续3轮没有进展')
  assert.equal(h.driver.isFinished(h.roomId), true)
  // A new instruction closes the previous task and opens a fresh one.
  h.setLastMessage('2026-10-22T00:10:00.000Z')
  h.driver.beginTask(h.roomId)
  assert.equal(h.driver.isFinished(h.roomId), false)
})

// ── the no-progress guard ───────────────────────────────────────────────────

test('onLeaderIdle stalls only after three consecutive rounds without progress', async () => {
  const h = makeHarness()
  h.setLastMessage('2026-10-22T00:00:00.000Z')

  const first = await h.driver.onLeaderIdle({ roomId: h.roomId, producedText: false })
  const second = await h.driver.onLeaderIdle({ roomId: h.roomId, producedText: false })
  const third = await h.driver.onLeaderIdle({ roomId: h.roomId, producedText: false })
  assert.equal(first.stalled, false)
  assert.equal(second.stalled, false)
  assert.equal(third.stalled, true)
  assert.equal(third.stalledRounds, 3)
})

test('onLeaderIdle counts a still-running member, a live run or text as progress', async () => {
  // Running member.
  const running = makeHarness()
  running.driver.assign({ roomId: running.roomId, botIds: ['member-a'], task: '做' })
  assert.equal((await running.driver.onLeaderIdle({ roomId: running.roomId, producedText: false })).stalled, false)

  // A live run in the room (the leader's own turn or a queued one).
  const live = makeHarness()
  live.setLiveRun(true)
  assert.equal((await live.driver.onLeaderIdle({ roomId: live.roomId, producedText: false })).stalled, false)

  // Text produced resets the counter.
  const spoke = makeHarness()
  spoke.setLastMessage('2026-10-22T00:00:00.000Z')
  await spoke.driver.onLeaderIdle({ roomId: spoke.roomId, producedText: false })
  const reset = await spoke.driver.onLeaderIdle({ roomId: spoke.roomId, producedText: true })
  assert.deepEqual(reset, { stalled: false, stalledRounds: 0 })
})

test('pending reports count as progress even when no run could be started', async () => {
  const h = makeHarness()
  h.driver.assign({ roomId: h.roomId, botIds: ['member-a', 'member-b'], task: '做' })
  // The integration enqueue is refused (room paused / executor unavailable): the reports
  // stay queued in the driver, and the next idle turn must NOT be counted as a stall.
  h.setAcceptRuns(false)
  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-a', text: 'A', ok: true })
  await h.driver.onMemberFinished({ roomId: h.roomId, botId: 'member-b', text: 'B', ok: true })
  assert.equal(leaderCalls(h).length, 0)
  h.setAcceptRuns(true)
  const idle = await h.driver.onLeaderIdle({ roomId: h.roomId, producedText: false })
  assert.equal(idle.stalled, false)
  assert.equal(idle.stalledRounds, 0)
})

// ── budget + new-task bookkeeping ───────────────────────────────────────────

test('adoptRound mirrors the board so a later save cannot roll the budget back', () => {
  const h = makeHarness()
  h.driver.adoptRound(h.roomId, 7)
  assert.equal(h.boards.get(h.roomId)?.round, 7)
  // A normal save (a member finishes) must keep the mirrored round.
  h.driver.assign({ roomId: h.roomId, botIds: ['member-a'], task: '做' })
  assert.equal(h.boards.get(h.roomId)?.round, 7)
})

test('beginTask starts a new task: fresh round, cleared finish, cleared reports', async () => {
  const h = makeHarness()
  h.setLastMessage('2026-10-22T00:00:00.000Z')
  h.driver.adoptRound(h.roomId, 5)
  h.driver.stop(h.roomId, '上一轮已收尾')
  assert.equal(h.boards.get(h.roomId)?.round, 5)
  assert.ok(h.boards.get(h.roomId)?.finished !== undefined)

  h.setLastMessage('2026-10-22T00:05:00.000Z')
  h.driver.beginTask(h.roomId)
  const board = h.boards.get(h.roomId)
  assert.ok(board !== undefined)
  assert.equal(board.round, 0)
  assert.equal(board.finished, undefined)
})
