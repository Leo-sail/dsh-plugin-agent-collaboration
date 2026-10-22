/**
 * OP-04: run evidence + failure attribution.
 *
 * A failed run should say WHERE it failed (model / harness / tool / memory / room-goal / user)
 * and every settled run should carry a small measurable record (counters, token usage, finish
 * path) — WITHOUT storing prompt text, reasoning or tool output. These tests pin the
 * classification rules, the finish-path vocabulary, the merge/normalisation of the evidence
 * record, and the fact that the panel snapshot keeps the useful numbers but never prose.
 *
 * Run with: node --test tests/run-evidence.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildRunEvidence,
  classifyFaultSide,
  countToolActivity,
  finishPathOf,
} from '../packages/core/agent-community/src/run-evidence.ts'
import { summarizeSnapshotRun } from '../packages/core/agent-community/src/snapshot-lite.ts'
import type { BotRun, RunEvidence, RunFaultSide } from '../packages/core/agent-community/src/types.ts'

// ── classifyFaultSide: the attribution table ───────────────────────────────

test('classifyFaultSide: budget outcomes belong to the harness', () => {
  assert.equal(classifyFaultSide({ failureKind: 'timeout' }), 'harness')
  assert.equal(classifyFaultSide({ failureKind: 'no-progress' }), 'harness')
  assert.equal(classifyFaultSide({ finishPath: 'timeout' }), 'harness')
  assert.equal(classifyFaultSide({ finishPath: 'no-progress' }), 'harness')
})

test('classifyFaultSide: a user stop belongs to the user', () => {
  assert.equal(classifyFaultSide({ finishPath: 'stopped' }), 'user')
  assert.equal(classifyFaultSide({ failureKind: 'user-cancel' }), 'user')
})

test('classifyFaultSide: transport/provider failures belong to the model', () => {
  const modelErrors = [
    'ECONNRESET while streaming',
    'network error: socket hang up',
    'provider returned 503',
    'rate limit exceeded, retry later',
    'transport closed unexpectedly',
    'ETIMEDOUT connecting to api host',
  ]
  for (const error of modelErrors) {
    assert.equal(classifyFaultSide({ error }), 'model', error)
  }
})

test('classifyFaultSide: tool/sandbox/permission/approval failures belong to the tool layer', () => {
  const toolErrors = [
    'tool read_file failed',
    'sandbox denied write access',
    'permission denied: /etc/hosts',
    'approval rejected by the user',
    'EACCES opening report.md',
  ]
  for (const error of toolErrors) {
    assert.equal(classifyFaultSide({ error }), 'tool', error)
  }
})

test('classifyFaultSide: memory/context/compaction failures belong to memory', () => {
  assert.equal(classifyFaultSide({ error: 'context window overflow' }), 'memory')
  assert.equal(classifyFaultSide({ error: 'memory store failed' }), 'memory')
  assert.equal(classifyFaultSide({ error: 'compaction produced an empty summary' }), 'memory')
  assert.equal(classifyFaultSide({ error: '上下文超限' }), 'memory')
})

test('classifyFaultSide: room/goal/leader/stall failures belong to room-goal', () => {
  assert.equal(classifyFaultSide({ error: 'room goal stalled after 3 rounds' }), 'room-goal')
  assert.equal(classifyFaultSide({ error: 'leader not a member of the room' }), 'room-goal')
  assert.equal(classifyFaultSide({ error: '目标推进停滞' }), 'room-goal')
})

test('classifyFaultSide: explicit failure kinds map without reading message text', () => {
  assert.equal(classifyFaultSide({ failureKind: 'provider' }), 'model')
  assert.equal(classifyFaultSide({ failureKind: 'tool' }), 'tool')
  assert.equal(classifyFaultSide({ failureKind: 'lease-lost' }), 'harness')
  assert.equal(classifyFaultSide({ failureKind: 'unknown' }), 'unknown')
})

test('classifyFaultSide: unmatched and empty errors stay unknown', () => {
  assert.equal(classifyFaultSide({}), 'unknown')
  assert.equal(classifyFaultSide({ error: '' }), 'unknown')
  assert.equal(classifyFaultSide({ error: 'something odd happened' }), 'unknown')
})

test('classifyFaultSide: an explicit failure kind wins over generic error text', () => {
  // A timeout whose message also mentions the provider must still be a harness outcome:
  // the budget killed the turn, not the provider.
  assert.equal(classifyFaultSide({ failureKind: 'timeout', error: 'provider stream idle' }), 'harness')
  assert.equal(classifyFaultSide({ failureKind: 'user-cancel', error: 'tool was mid-call' }), 'user')
})

test('classifyFaultSide: every result is one of the closed vocabulary', () => {
  const allowed = new Set<RunFaultSide>(['model', 'harness', 'tool', 'memory', 'room-goal', 'user', 'unknown'])
  const samples = [
    {}, { failureKind: 'timeout' as const }, { error: 'ECONNRESET' }, { error: 'tool failed' },
    { error: 'context overflow' }, { error: 'goal stalled' }, { finishPath: 'stopped' as const },
  ]
  for (const sample of samples) assert.ok(allowed.has(classifyFaultSide(sample)))
})

// ── finishPathOf: the closed finish vocabulary ─────────────────────────────

test('finishPathOf: stops and budget verdicts win over the status', () => {
  assert.equal(finishPathOf({ status: 'interrupted', stopped: true }), 'stopped')
  assert.equal(finishPathOf({ status: 'completed', failureKind: 'timeout' }), 'timeout')
  assert.equal(finishPathOf({ status: 'completed', failureKind: 'no-progress' }), 'no-progress')
  assert.equal(finishPathOf({ status: 'interrupted' }), 'stopped')
})

test('finishPathOf: delivery paths are finish_task then reply then empty', () => {
  assert.equal(finishPathOf({ status: 'completed', finishReport: '做完了', replyText: '好的' }), 'finish_task')
  assert.equal(finishPathOf({ status: 'completed', replyText: '好的' }), 'reply')
  assert.equal(finishPathOf({ status: 'completed' }), 'empty')
  assert.equal(finishPathOf({ status: 'completed', replyText: '   ' }), 'empty')
})

test('finishPathOf: failures and unknown statuses are named as such', () => {
  assert.equal(finishPathOf({ status: 'failed', replyText: 'partial' }), 'failed')
  assert.equal(finishPathOf({ status: 'queued' }), 'unknown')
  assert.equal(finishPathOf({ status: 'cancelled' }), 'stopped')
})

// ── tool counters ──────────────────────────────────────────────────────────

test('countToolActivity counts calls and only real failure statuses', () => {
  assert.deepEqual(countToolActivity(undefined), { toolCalls: 0, toolFailures: 0 })
  assert.deepEqual(countToolActivity([]), { toolCalls: 0, toolFailures: 0 })
  assert.deepEqual(countToolActivity([
    { name: 'read_file', status: 'ok' },
    { name: 'write_file', status: 'failed' },
    { name: 'bash', status: 'error' },
    { name: 'search', status: 'blocked' },
    { name: 'deliver', status: 'ok' },
  ]), { toolCalls: 5, toolFailures: 3 })
})

// ── evidence merge ─────────────────────────────────────────────────────────

test('buildRunEvidence keeps counters, usage, finish path and fault side', () => {
  const evidence = buildRunEvidence({
    durationMs: 12_345,
    promptChars: 6_789,
    toolCalls: 4,
    toolFailures: 1,
    deliverableCount: 2,
    contextWindowMessages: 10,
    approvalRequests: 1,
    usage: { uncachedInputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
    finishPath: 'reply',
    faultSide: 'unknown',
  })
  assert.deepEqual(evidence, {
    durationMs: 12_345,
    promptChars: 6_789,
    toolCalls: 4,
    toolFailures: 1,
    deliverableCount: 2,
    contextWindowMessages: 10,
    approvalRequests: 1,
    usage: { uncachedInputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
    finishPath: 'reply',
    faultSide: 'unknown',
  })
})

test('buildRunEvidence derives tool counts from cards and prefers explicit counts', () => {
  const derived = buildRunEvidence({
    toolActivity: [{ status: 'ok' }, { status: 'failed' }, { status: 'ok' }],
  })
  assert.equal(derived.toolCalls, 3)
  assert.equal(derived.toolFailures, 1)

  const explicit = buildRunEvidence({
    toolCalls: 9,
    toolFailures: 0,
    toolActivity: [{ status: 'failed' }],
  })
  assert.equal(explicit.toolCalls, 9)
  assert.equal(explicit.toolFailures, 0)
})

test('buildRunEvidence normalises numbers and omits unusable ones', () => {
  const evidence = buildRunEvidence({
    durationMs: -5,
    promptChars: Number.NaN,
    toolCalls: 2.6,
    deliverableCount: Number.POSITIVE_INFINITY,
    usage: { uncachedInputTokens: 10, outputTokens: -1, totalTokens: 10 },
  })
  assert.equal(evidence.durationMs, undefined)
  assert.equal(evidence.promptChars, undefined)
  assert.equal(evidence.toolCalls, 3) // rounded to a whole counter
  assert.equal(evidence.deliverableCount, undefined)
  assert.equal(evidence.usage, undefined) // one bad number drops the whole usage record
})

test('evidence is a fixed-key record: no field can carry prose', () => {
  const evidence = buildRunEvidence({
    // Even if a caller smuggled extra keys through a cast, only known keys survive.
    ...({ prompt: '秘密的任务书', reasoning: '内心独白', toolDetail: 'bash 输出' } as object),
    promptChars: 5,
  } as Parameters<typeof buildRunEvidence>[0])
  const keys = Object.keys(evidence).sort()
  assert.deepEqual(keys, ['promptChars', 'toolCalls', 'toolFailures'])
  const json = JSON.stringify(evidence)
  assert.equal(json.includes('秘密'), false)
  assert.equal(json.includes('内心'), false)
  // There is no free-text field at all: every value here is a number.
  assert.ok(Object.values(evidence).every(value => typeof value !== 'string'))
})

test('duration is carried through as measured wall-clock time', () => {
  const evidence = buildRunEvidence({ durationMs: 987, promptChars: 1 })
  assert.equal(evidence.durationMs, 987)
  assert.equal(evidence.promptChars, 1)
})

// ── snapshot: keep the numbers, never the prose ────────────────────────────

const TEST_EVIDENCE: RunEvidence = {
  durationMs: 2_500,
  promptChars: 900,
  toolCalls: 3,
  toolFailures: 1,
  deliverableCount: 1,
  usage: { uncachedInputTokens: 500, outputTokens: 100, totalTokens: 600 },
  finishPath: 'reply',
  faultSide: 'tool',
}

test('snapshot keeps each evidence counter and the fault side', () => {
  const run = {
    id: 'run-1', botId: 'bot-1', roomId: 'room-1', sessionId: 'sess-1', origin: 'user',
    prompt: '任务书'.repeat(1000), status: 'failed', controlRevision: 1, attempt: 0, maxAttempts: 3,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:03.000Z',
    startedAt: '2026-10-22T00:00:00.000Z', finishedAt: '2026-10-22T00:00:02.500Z',
    error: 'tool read_file failed', failureKind: 'tool-failure',
    evidence: TEST_EVIDENCE, faultSide: 'tool',
  } as unknown as BotRun
  const lite = summarizeSnapshotRun(run)
  assert.deepEqual(lite.evidence, TEST_EVIDENCE)
  assert.equal(lite.faultSide, 'tool')
  assert.equal(lite.evidence?.finishPath, 'reply')
  // The evidence record itself carries no prose; the run strip's error wording stays a
  // separate (pre-existing) snapshot field, not part of OP-04 evidence.
  const evidenceJson = JSON.stringify(lite.evidence)
  assert.equal(evidenceJson.includes('read_file'), false)
  assert.equal(evidenceJson.includes('任务书'), false)
  const json = JSON.stringify(lite)
  assert.equal(json.includes('任务书'), false) // the prompt never enters the payload
  assert.ok(json.length < 1_000, `snapshot run row=${json.length}`)
})

test('old runs without evidence/faultSide omit both fields', () => {
  const run = {
    id: 'run-2', botId: 'bot-1', roomId: 'room-1', sessionId: 'sess-1', origin: 'user',
    prompt: 'hi', status: 'completed', controlRevision: 0, attempt: 0, maxAttempts: 3,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:01.000Z',
  } as unknown as BotRun
  const lite = summarizeSnapshotRun(run)
  assert.equal(lite.evidence, undefined)
  assert.equal(lite.faultSide, undefined)
  const json = JSON.stringify(lite)
  assert.equal(json.includes('evidence'), false)
  assert.equal(json.includes('faultSide'), false)
})
