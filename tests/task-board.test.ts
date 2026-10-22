/**
 * OP-07: the room task board is a versioned, role-contracted state machine.
 *
 * These tests pin the three properties that scattered inline writers could not guarantee:
 * STRUCTURE (validateTaskBoard), AUTHORITY (who may write which row / operation) and
 * ATOMICITY (version mismatch refused; a multi-operation transaction applies all or nothing).
 * The module is pure — clock and actor are injected — so the whole rule set is asserted without
 * a host, a room store or a persistence layer.
 *
 * Run with: node --test tests/task-board.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyTaskBoardOperation,
  applyTaskBoardTransaction,
  TASK_BOARD_SCHEMA_VERSION,
  validateTaskBoard,
  type TaskBoardContext,
  type TaskBoardOperation,
} from '../packages/core/agent-community/src/task-board.ts'
import type {
  BotId,
  FinishEvidence,
  RoomTaskAssignment,
  RoomTaskState,
} from '../packages/core/agent-community/src/types.ts'

const NOW = '2026-10-22T00:00:00.000Z'
const LATER = '2026-10-22T00:01:00.000Z'

function board(overrides: Partial<RoomTaskState> = {}): RoomTaskState {
  return {
    round: 0,
    maxRounds: 3,
    assignments: [],
    schemaVersion: TASK_BOARD_SCHEMA_VERSION,
    version: 0,
    updatedAt: NOW,
    ...overrides,
  }
}

function row(overrides: Partial<RoomTaskAssignment> = {}): RoomTaskAssignment {
  return {
    id: 'task-1',
    botId: 'bot-1' as BotId,
    task: '写方案',
    at: NOW,
    status: 'assigned',
    ...overrides,
  }
}

function context(overrides: Partial<TaskBoardContext> = {}): TaskBoardContext {
  return {
    actor: 'leader',
    actorBotId: 'leader-1',
    memberIds: ['leader-1', 'bot-1', 'bot-2'],
    now: NOW,
    ...overrides,
  }
}

function apply(boardState: RoomTaskState, operation: TaskBoardOperation, overrides: Partial<TaskBoardContext> = {}) {
  return applyTaskBoardOperation(boardState, operation, context(overrides))
}

function applyOk(boardState: RoomTaskState, operation: TaskBoardOperation, overrides: Partial<TaskBoardContext> = {}) {
  const result = apply(boardState, operation, overrides)
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.reason}`)
  if (!result.ok) throw new Error('unreachable')
  return result
}

function applyFail(
  boardState: RoomTaskState,
  operation: TaskBoardOperation,
  overrides: Partial<TaskBoardContext> = {},
): { code: string; reason: string } {
  const result = apply(boardState, operation, overrides)
  assert.equal(result.ok, false, 'expected the operation to be refused')
  if (result.ok) throw new Error('unreachable')
  return { code: result.code, reason: result.reason }
}

// ── schema validation ──────────────────────────────────────────────────────

test('validateTaskBoard accepts a well-formed board (and a pre-versioning one)', () => {
  assert.deepEqual(validateTaskBoard(board({ assignments: [row()] })), [])
  // Boards written before OP-07 have no schemaVersion/version: they are valid v1 boards.
  assert.deepEqual(validateTaskBoard({ round: 0, maxRounds: 3, assignments: [] }), [])
})

test('validateTaskBoard reports structural damage', () => {
  assert.deepEqual(validateTaskBoard(undefined), ['任务板不存在'])
  assert.match(validateTaskBoard(board({ schemaVersion: 99 })).join('|'), /不支持的 schemaVersion/u)
  assert.match(validateTaskBoard(board({ schemaVersion: 0 })).join('|'), /schemaVersion 非法/u)
  assert.match(validateTaskBoard(board({ round: -1 })).join('|'), /round 非法/u)
  assert.match(validateTaskBoard(board({ maxRounds: 1.5 })).join('|'), /maxRounds 非法/u)
  assert.match(validateTaskBoard(board({ version: -2 })).join('|'), /version 非法/u)
  assert.match(validateTaskBoard(board({ assignments: [row(), row()] })).join('|'), /id 重复/u)
  assert.match(validateTaskBoard(board({ assignments: [row({ task: '  ' })] })).join('|'), /缺少 task/u)
  assert.match(
    validateTaskBoard(board({ assignments: [row({ status: 'nonsense' as never })] })).join('|'),
    /status 非法/u,
  )
  assert.match(
    validateTaskBoard(board({ finished: { report: '', at: NOW } })).join('|'),
    /finished 缺少 report/u,
  )
})

// ── versioning ─────────────────────────────────────────────────────────────

test('a successful operation bumps version, stamps schemaVersion and updatedAt', () => {
  const result = applyOk(board(), { kind: 'assign', botId: 'bot-1', task: '写方案' }, { now: LATER })
  assert.equal(result.state.version, 1)
  assert.equal(result.state.schemaVersion, TASK_BOARD_SCHEMA_VERSION)
  assert.equal(result.state.updatedAt, LATER)
  // The input board is never mutated (pure state machine).
  assert.equal(board().version, 0)
})

test('a stale expectedVersion is refused without touching the board', () => {
  const stale = applyFail(board({ version: 3 }), { kind: 'advance' }, { expectedVersion: 2 })
  assert.equal(stale.code, 'stale-version')
  assert.match(stale.reason, /期望 version=2/u)
})

test('no expectedVersion means "write regardless" (internal/system writes)', () => {
  const result = applyOk(board({ version: 3 }), { kind: 'advance' }, { expectedVersion: undefined })
  assert.equal(result.state.version, 4)
})

// ── assign ─────────────────────────────────────────────────────────────────

test('leader and system may assign; the assignment starts as "assigned"', () => {
  for (const actor of ['leader', 'system'] as const) {
    const result = applyOk(board(), { kind: 'assign', botId: 'bot-1', task: '写方案' }, { actor, actorBotId: undefined })
    assert.equal(result.state.assignments.length, 1)
    assert.equal(result.state.assignments[0]!.status, 'assigned')
    assert.equal(result.state.assignments[0]!.task, '写方案')
    assert.equal(result.events[0]!.kind, 'assign')
  }
})

test('assign is refused for members, users and invalid targets', () => {
  assert.equal(applyFail(board(), { kind: 'assign', botId: 'bot-1', task: 'x' }, { actor: 'member', actorBotId: 'bot-1' }).code, 'forbidden')
  assert.equal(applyFail(board(), { kind: 'assign', botId: 'bot-1', task: 'x' }, { actor: 'user', actorBotId: undefined }).code, 'forbidden')
  assert.equal(applyFail(board(), { kind: 'assign', botId: 'outsider', task: 'x' }).code, 'forbidden')
  assert.equal(applyFail(board(), { kind: 'assign', botId: 'bot-1', task: '   ' }).code, 'invalid-operation')
  assert.equal(applyFail(board(), { kind: 'assign', botId: '', task: 'x' }).code, 'invalid-operation')
})

test('two assignments in a row get distinct ids', () => {
  const first = applyOk(board(), { kind: 'assign', botId: 'bot-1', task: 'A' })
  const second = applyOk(first.state, { kind: 'assign', botId: 'bot-2', task: 'B' }, { expectedVersion: 1 })
  assert.notEqual(first.state.assignments[0]!.id, second.state.assignments[1]!.id)
})

// ── report: authority ──────────────────────────────────────────────────────

test('a member may write its own row; the leader may write any row', () => {
  const own = applyOk(
    board({ assignments: [row()] }),
    { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: '进行中' },
    { actor: 'member', actorBotId: 'bot-1' },
  )
  assert.equal(own.state.assignments[0]!.status, 'working')
  assert.deepEqual(own.state.assignments[0]!.report, { text: '进行中', at: NOW })

  const byLeader = applyOk(
    board({ assignments: [row()] }),
    { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: 'leader 代写' },
    { actor: 'leader' },
  )
  assert.equal(byLeader.state.assignments[0]!.status, 'working')
})

test("a member may not write someone else's row", () => {
  const refused = applyFail(
    board({ assignments: [row()] }),
    { kind: 'report', taskId: 'task-1', botId: 'bot-2', text: 'x' },
    { actor: 'member', actorBotId: 'bot-2' },
  )
  assert.equal(refused.code, 'forbidden')

  // Writing own row but carrying another owner id is refused too (ownership cannot move).
  const mixed = applyFail(
    board({ assignments: [row()] }),
    { kind: 'report', taskId: 'task-1', botId: 'bot-2', text: 'x' },
    { actor: 'member', actorBotId: 'bot-1' },
  )
  assert.equal(mixed.code, 'forbidden')
})

test('users may not write the internal board at all', () => {
  const refused = applyFail(
    board({ assignments: [row()] }),
    { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: 'x' },
    { actor: 'user', actorBotId: undefined },
  )
  assert.equal(refused.code, 'forbidden')
  assert.match(refused.reason, /system 路径/u)
})

test('reporting a missing task is not-found', () => {
  assert.equal(
    applyFail(board(), { kind: 'report', taskId: 'nope', botId: 'bot-1', text: 'x' }).code,
    'not-found',
  )
})

// ── report: state machine ──────────────────────────────────────────────────

test('the promised flow assigned → working → reported → done applies', () => {
  const assigned = board({ assignments: [row()] })
  const working = applyOk(assigned, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: '开始', status: 'working' })
  assert.equal(working.state.assignments[0]!.status, 'working')
  const reported = applyOk(working.state, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: '好了', status: 'reported' })
  assert.equal(reported.state.assignments[0]!.status, 'reported')
  const done = applyOk(reported.state, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: '完成', status: 'done' })
  assert.equal(done.state.assignments[0]!.status, 'done')
})

test('done is terminal: done → working / reported is refused', () => {
  const doneBoard = board({ assignments: [row({ status: 'done' })] })
  for (const status of ['working', 'reported'] as const) {
    const refused = applyFail(doneBoard, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: 'x', status })
    assert.equal(refused.code, 'invalid-transition')
  }
  // Repeating "done" is idempotent and allowed.
  assert.equal(
    applyOk(doneBoard, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: 'again', status: 'done' }).state.assignments[0]!.status,
    'done',
  )
})

test('reported may not go back to working, and failed maps to blocked then re-opens', () => {
  const reported = board({ assignments: [row({ status: 'reported' })] })
  assert.equal(
    applyFail(reported, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: 'x', status: 'working' }).code,
    'invalid-transition',
  )
  const working = board({ assignments: [row({ status: 'working' })] })
  const failed = applyOk(working, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: '挂了', status: 'failed' })
  assert.equal(failed.state.assignments[0]!.status, 'blocked')
  const reopened = applyOk(failed.state, { kind: 'report', taskId: 'task-1', botId: 'bot-1', text: '重试', status: 'working' })
  assert.equal(reopened.state.assignments[0]!.status, 'working')
})

// ── advance / finish / fail ────────────────────────────────────────────────

test('advance is leader-only and increments the round', () => {
  const result = applyOk(board({ round: 1 }), { kind: 'advance' })
  assert.equal(result.state.round, 2)
  assert.equal(result.state.finished, undefined)
  assert.equal(applyFail(board(), { kind: 'advance' }, { actor: 'member', actorBotId: 'bot-1' }).code, 'forbidden')
  assert.equal(applyFail(board(), { kind: 'advance' }, { actor: 'user', actorBotId: undefined }).code, 'forbidden')
})

test('advancing past maxRounds finalises the board with the existing wording', () => {
  const result = applyOk(board({ round: 3, maxRounds: 3 }), { kind: 'advance' })
  assert.equal(result.state.round, 4)
  assert.equal(result.state.finished?.report, '已达轮次上限 3，收尾')
  assert.equal(result.events[0]!.kind === 'advance' && result.events[0]!.finished, true)
})

test('finish is leader-only, requires a report, and keeps evidence/gate', () => {
  const evidence: readonly FinishEvidence[] = [{ kind: 'file', path: 'out/report.md' }]
  const result = applyOk(board({ assignments: [row()] }), {
    kind: 'finish',
    report: '全部完成',
    evidence,
    gate: 'passed',
  })
  assert.equal(result.state.finished?.report, '全部完成')
  assert.deepEqual(result.state.finished?.evidence, evidence)
  assert.equal(result.state.finished?.gate, 'passed')
  assert.equal(result.events[0]!.kind, 'finish')

  assert.equal(applyFail(board(), { kind: 'finish', report: '  ' }).code, 'invalid-operation')
  assert.equal(applyFail(board(), { kind: 'finish', report: 'x' }, { actor: 'member', actorBotId: 'bot-1' }).code, 'forbidden')
})

test('fail closes the board with the reason (or a default one)', () => {
  const withReason = applyOk(board(), { kind: 'fail', reason: '  证据不足  ' })
  assert.equal(withReason.state.finished?.report, '证据不足')
  assert.equal(withReason.events[0]!.kind, 'fail')

  const defaulted = applyOk(board(), { kind: 'fail' })
  assert.equal(defaulted.state.finished?.report, '任务板已失败收尾')
  assert.equal(applyFail(board(), { kind: 'fail' }, { actor: 'user', actorBotId: undefined }).code, 'forbidden')
})

test('a finished board refuses every later write', () => {
  const finished = board({ finished: { report: 'done', at: NOW } })
  const refused = applyFail(finished, { kind: 'assign', botId: 'bot-1', task: 'x' })
  assert.equal(refused.code, 'finished')
  assert.match(refused.reason, /已收尾/u)
})

// ── transactions ───────────────────────────────────────────────────────────

test('a transaction applies operations in order and reports their events', () => {
  const operations: TaskBoardOperation[] = [
    { kind: 'assign', botId: 'bot-1', task: 'A' },
    { kind: 'report', taskId: 'bot-1:2026-10-22T00:00:00.000Z:0', botId: 'bot-1', text: '开始' },
    { kind: 'advance' },
  ]
  const result = applyTaskBoardTransaction(board(), operations, context())
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.state.version, 3)
  assert.equal(result.state.round, 1)
  assert.equal(result.state.assignments[0]!.status, 'working')
  assert.deepEqual(result.events.map(event => event.kind), ['assign', 'report', 'advance'])
})

test('a transaction is all-or-nothing: one failure leaves the input untouched', () => {
  const operations: TaskBoardOperation[] = [
    { kind: 'assign', botId: 'bot-1', task: 'A' },
    { kind: 'report', taskId: 'missing-task', botId: 'bot-1', text: 'x' },
    { kind: 'advance' },
  ]
  const original = board()
  const result = applyTaskBoardTransaction(original, operations, context())
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'not-found')
  assert.match(result.reason, /第 2 个操作失败/u)
  assert.deepEqual(original, board()) // no partial mutation reached the caller
})

test('the transaction checks expectedVersion once against the original board', () => {
  // Two operations: the second must not compare against the version the first just wrote.
  const result = applyTaskBoardTransaction(
    board({ version: 5 }),
    [{ kind: 'assign', botId: 'bot-1', task: 'A' }, { kind: 'advance' }],
    context({ expectedVersion: 5 }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.state.version, 7)

  const stale = applyTaskBoardTransaction(board({ version: 5 }), [{ kind: 'advance' }], context({ expectedVersion: 4 }))
  assert.equal(stale.ok, false)
  if (stale.ok) throw new Error('unreachable')
  assert.equal(stale.code, 'stale-version')
})

test('an empty transaction is a successful no-op', () => {
  const original = board()
  const result = applyTaskBoardTransaction(original, [], context())
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.deepEqual(result.state, original)
  assert.deepEqual(result.events, [])
})

test('an invalid board is refused before any operation runs', () => {
  const damaged = board({ assignments: [row(), row()] })
  const result = applyTaskBoardTransaction(damaged, [{ kind: 'advance' }], context())
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'invalid-board')
  assert.match(result.reason, /id 重复/u)
})
