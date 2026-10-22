import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskAdherence } from '../packages/core/agent-community/src/adherence.ts'
import type { RoomTaskAssignment } from '../packages/core/agent-community/src/types.ts'

function row(status: RoomTaskAssignment['status']): RoomTaskAssignment {
  return { id: status ?? 'x', botId: 'b' as RoomTaskAssignment['botId'], task: 't', at: '2026-01-01T00:00:00Z', status }
}

test('empty board is zero, not a failure', () => {
  const a = taskAdherence({ assignments: [], finished: undefined })
  assert.equal(a.assigned, 0)
  assert.equal(a.coverage, 0)
  assert.equal(a.score, 0)
  assert.deepEqual(a.issues, ['任务尚未收尾'])
})

test('coverage plus verified finish', () => {
  const a = taskAdherence({
    assignments: [row('done'), row('done'), row('blocked')],
    finished: { report: 'ok', at: 'x', gate: 'passed', evidence: [{ kind: 'task', taskId: 't' }] },
  })
  assert.equal(a.assigned, 3)
  assert.equal(a.done, 2)
  assert.equal(a.failed, 1)
  assert.equal(a.pending, 0)
  assert.ok(Math.abs(a.coverage - 2 / 3) < 1e-9)
  assert.equal(a.verifiedFinish, true)
  assert.equal(a.evidenceCount, 1)
  assert.equal(a.score, 77) // round(46.67 + 30)
  assert.deepEqual(a.issues, ['1 个任务未完成'])
})

test('bypassed finish is penalized and reported', () => {
  const a = taskAdherence({
    assignments: [row('done')],
    finished: { report: 'ok', at: 'x', gate: 'bypassed' },
  })
  assert.equal(a.verifiedFinish, false)
  assert.equal(a.bypassed, true)
  assert.equal(a.score, 55) // 70 - 15
  assert.ok(a.issues.some(issue => issue.includes('bypass')))
  assert.ok(a.issues.some(issue => issue.includes('证据')))
})

test('pending statuses stay pending and closed-without-gate is not verified', () => {
  const a = taskAdherence({
    assignments: [row('working'), row('reported'), row('assigned')],
    finished: { report: 'ok', at: 'x' },
  })
  assert.equal(a.pending, 3)
  assert.equal(a.done, 0) // reported is not accepted completion
  assert.equal(a.verifiedFinish, false)
  assert.ok(a.issues.includes('完成未经证据门验证'))
})
