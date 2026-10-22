/**
 * OP-16: selective audit sampling.
 *
 * Not every run deserves a human's time. The auditor ranks runs by how much a reader would
 * learn (failure + unknown attribution + empty finish + tool failures), samples a few,
 * de-duplicates per room and per failure type, and produces one short Chinese notice with ids
 * only — never prompt text, reasoning or tool output.
 *
 * Run with: node --test tests/handoff-audit.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUDIT_WEIGHTS,
  auditNotice,
  auditPriority,
  selectAuditSamples,
  type AuditRunLike,
} from '../packages/core/agent-community/src/handoff-audit.ts'

function run(overrides: Partial<AuditRunLike> = {}): AuditRunLike {
  return {
    id: 'run-1',
    roomId: 'room-1',
    status: 'completed',
    ...overrides,
  }
}

// ── priority ───────────────────────────────────────────────────────────────

test('a normal completed run has zero priority (not audited)', () => {
  const priority = auditPriority(run({ evidence: { finishPath: 'reply', toolCalls: 3, toolFailures: 0 } }))
  assert.equal(priority, 0)
})

test('a failed run outranks a clean one, and an unknown attribution outranks a known one', () => {
  const clean = auditPriority(run())
  const failedUnknown = auditPriority(run({ status: 'failed', faultSide: 'unknown', evidence: { finishPath: 'failed' } }))
  const failedModel = auditPriority(run({ status: 'failed', faultSide: 'model', evidence: { finishPath: 'failed' } }))
  assert.ok(failedUnknown > failedModel)
  assert.ok(failedModel > clean)
  assert.equal(failedUnknown, AUDIT_WEIGHTS.failed + AUDIT_WEIGHTS.faultUnknown + AUDIT_WEIGHTS.finishFailed)
})

test('an empty finish and an evidence-less run get extra priority', () => {
  const empty = auditPriority(run({ evidence: { finishPath: 'empty' } }))
  const missing = auditPriority(run())
  assert.equal(empty, AUDIT_WEIGHTS.finishEmpty)
  assert.equal(missing, AUDIT_WEIGHTS.faultEvidenceMissing)
})

test('high tool failure counts are prioritized, and capped', () => {
  const few = auditPriority(run({ evidence: { finishPath: 'reply', toolCalls: 5, toolFailures: 1 } }))
  const many = auditPriority(run({ evidence: { finishPath: 'reply', toolCalls: 20, toolFailures: 10 } }))
  assert.equal(few, AUDIT_WEIGHTS.toolFailureEach)
  assert.equal(many, AUDIT_WEIGHTS.toolFailureCap)
})

test('interrupted/non-completed runs are lower priority than failed ones', () => {
  assert.ok(auditPriority(run({ status: 'interrupted' })) > 0)
  assert.ok(auditPriority(run({ status: 'failed' })) > auditPriority(run({ status: 'interrupted' })))
})

// ── sampling ───────────────────────────────────────────────────────────────

test('no failures means no samples', () => {
  assert.deepEqual(selectAuditSamples({ runs: [] }), [])
  assert.deepEqual(selectAuditSamples({
    runs: [
      run({ id: 'a', roomId: 'r1', evidence: { finishPath: 'reply' } }),
      run({ id: 'b', roomId: 'r2', evidence: { finishPath: 'finish_task' } }),
    ],
  }), [])
})

test('samples are ranked by priority', () => {
  const samples = selectAuditSamples({
    runs: [
      run({ id: 'low', roomId: 'r1', evidence: { finishPath: 'empty' } }), // 25
      run({ id: 'high', roomId: 'r2', status: 'failed', faultSide: 'unknown', evidence: { finishPath: 'failed' } }),
    ],
  })
  assert.equal(samples[0]!.runId, 'high')
  assert.ok(samples.length <= 5)
  assert.ok(samples[0]!.priority > 0)
})

test('at most one sample per room (the same cause is one lesson)', () => {
  const samples = selectAuditSamples({
    runs: [
      run({ id: 'a', roomId: 'room-1', status: 'failed', faultSide: 'harness', evidence: { finishPath: 'timeout' } }),
      run({ id: 'b', roomId: 'room-1', status: 'failed', faultSide: 'memory', evidence: { finishPath: 'failed' } }),
      run({ id: 'c', roomId: 'room-2', status: 'failed', faultSide: 'tool', evidence: { finishPath: 'failed' } }),
    ],
  })
  assert.equal(samples.filter(sample => sample.roomId === 'room-1').length, 1)
  assert.ok(samples.some(sample => sample.runId === 'c'))
})

test('at most one sample per failure type', () => {
  const samples = selectAuditSamples({
    runs: [
      run({ id: 'a', roomId: 'room-1', status: 'failed', faultSide: 'unknown', evidence: { finishPath: 'failed' } }),
      run({ id: 'b', roomId: 'room-2', status: 'failed', faultSide: 'unknown', evidence: { finishPath: 'failed' } }),
      run({ id: 'c', roomId: 'room-3', status: 'failed', faultSide: 'harness', evidence: { finishPath: 'timeout' } }),
    ],
  })
  assert.equal(samples.filter(sample => sample.reason.includes('归因未知')).length, 1)
  assert.ok(samples.some(sample => sample.runId === 'c'))
})

test('the limit is honoured and defaults to five', () => {
  // Distinct failure types (the sampler de-duplicates by type) so the limit is what binds.
  const sides = ['unknown', 'harness', 'memory', 'tool', 'model', 'room-goal'] as const
  const many = Array.from({ length: 12 }, (_v, i) => run({
    id: `run-${i}`,
    roomId: `room-${i}`,
    status: 'failed',
    faultSide: sides[i % sides.length]!,
    evidence: { finishPath: 'failed' },
  }))
  assert.equal(selectAuditSamples({ runs: many }).length, 5)
  assert.equal(selectAuditSamples({ runs: many, limit: 2 }).length, 2)
  assert.deepEqual(selectAuditSamples({ runs: many, limit: 0 }), [])
})

test('a sample names the run, the room, the reason and the source message when known', () => {
  const samples = selectAuditSamples({
    runs: [run({
      id: 'run-9',
      roomId: 'room-9',
      status: 'failed',
      faultSide: 'unknown',
      rootMessageId: 'msg-7',
      evidence: { finishPath: 'failed', toolCalls: 4, toolFailures: 2 },
    })],
  })
  assert.equal(samples.length, 1)
  const sample = samples[0]!
  assert.equal(sample.runId, 'run-9')
  assert.equal(sample.roomId, 'room-9')
  assert.equal(sample.messageId, 'msg-7')
  assert.match(sample.reason, /运行失败/u)
  assert.match(sample.reason, /归因未知/u)
  assert.match(sample.reason, /工具失败 2\/4 次/u)
})

// ── notice ─────────────────────────────────────────────────────────────────

test('the notice says what to look at and what will NOT happen automatically', () => {
  const notice = auditNotice({
    runId: 'run-1',
    roomId: 'room-1',
    reason: '运行失败；失败归因未知',
    priority: 70,
    messageId: 'msg-1',
  })
  assert.match(notice, /建议复盘/u)
  assert.match(notice, /run-1/u)
  assert.match(notice, /room-1/u)
  assert.match(notice, /失败归因未知/u)
  assert.match(notice, /msg-1/u)
  assert.match(notice, /不会自动重试/u)
  assert.match(notice, /不会自动修改代码/u)
})

test('the notice can never contain transcript text (the auditor input has no such field)', () => {
  // Even a caller that smuggles prose into an extra key cannot put it into the notice: only the
  // closed AuditSample fields are rendered.
  const smuggled = {
    id: 'run-2',
    roomId: 'room-2',
    status: 'failed',
    faultSide: 'unknown',
    prompt: '秘密的任务书内容',
    reply: '模型的回答正文',
    reasoning: '内部思考',
  } as unknown as AuditRunLike
  const [sample] = selectAuditSamples({ runs: [smuggled] })
  assert.ok(sample !== undefined)
  const notice = auditNotice(sample)
  assert.equal(notice.includes('秘密'), false)
  assert.equal(notice.includes('模型的回答'), false)
  assert.equal(notice.includes('内部思考'), false)
})
