/**
 * The snapshot must carry what the panel uses and nothing heavy.
 *
 * The panel polls a snapshot every 400 ms while a run is live, and the payload used to include
 * every message's reasoning / tool cards / deliverables / token usage and every run's full
 * prompt — several megabytes per poll, most of it never read. These assertions pin the
 * contract: the named fields survive, the heavy ones cannot leak, long text is clipped, and the
 * serialized payload is dramatically smaller.
 *
 * Run with: node --test tests/snapshot-lite.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clipSnapshotText,
  summarizeSnapshotMessage,
  summarizeSnapshotMessages,
  summarizeSnapshotRun,
  summarizeSnapshotRuns,
  SNAPSHOT_TEXT_LIMIT,
} from '../packages/core/agent-community/src/snapshot-lite.ts'
import type { BotMessage, BotRun } from '../packages/core/agent-community/src/types.ts'

const T0 = '2026-10-22T00:00:00.000Z'

/** A message with every heavy field the snapshot used to serialize. */
function heavyMessage(i: number): BotMessage {
  return {
    id: `msg-${i}` as BotMessage['id'],
    roomId: 'room-1' as BotMessage['roomId'],
    sender: { kind: 'bot', botId: 'bot-1' as NonNullable<BotMessage['sender']['botId']>, name: '小董' },
    text: `第 ${i} 条消息：` + '很长的正文'.repeat(4_000),
    modelText: '展开后的技能正文'.repeat(2_000),
    reasoning: '思考过程'.repeat(5_000),
    toolActivity: Array.from({ length: 40 }, (_v, n) => ({ name: `tool-${n}`, status: 'ok', detail: '输出'.repeat(200) })),
    deliverables: [{ path: '/tmp/out.md', name: 'out.md', description: '报告', size: 1024 }],
    usage: { uncachedInputTokens: 1000, outputTokens: 2000, totalTokens: 3000 },
    sessionSeq: 42 as BotMessage['sessionSeq'],
    attachments: [{ name: 'a.png', size: 100, mime: 'image/png', kind: 'image' }],
    mentions: ['bot-2' as BotMessage['id']],
    createdAt: T0,
    sequence: i,
    runId: `run-${i}` as BotMessage['runId'],
    sessionId: 'sess-1' as BotMessage['sessionId'],
  } as BotMessage
}

/** A run with the heavy prompt and the internal lease bookkeeping. */
function heavyRun(i: number): BotRun {
  return {
    id: `run-${i}` as BotRun['id'],
    botId: 'bot-1' as BotRun['botId'],
    roomId: 'room-1' as BotRun['roomId'],
    sessionId: 'sess-1' as BotRun['sessionId'],
    origin: 'user',
    prompt: '任务书'.repeat(10_000),
    status: 'failed',
    controlRevision: 7,
    attempt: 1,
    maxAttempts: 3,
    createdAt: T0,
    updatedAt: T0,
    startedAt: T0,
    finishedAt: T0,
    error: '运行超时，已停止',
    lastError: '运行超时，已停止',
    deadlineAt: T0,
    lastProgressAt: T0,
    extensions: 1,
    failureKind: 'timeout',
    leaseOwner: 'owner-uuid',
    leaseExpiresAt: T0,
    assignment: { subject: '写周报', fromName: '小马' },
  } as BotRun
}

test('clipSnapshotText leaves short text alone and clips long text with a marker', () => {
  assert.equal(clipSnapshotText('你好'), '你好')
  assert.equal(clipSnapshotText('x'.repeat(SNAPSHOT_TEXT_LIMIT)), 'x'.repeat(SNAPSHOT_TEXT_LIMIT))
  const clipped = clipSnapshotText('y'.repeat(SNAPSHOT_TEXT_LIMIT + 500))
  assert.equal(Array.from(clipped).length, SNAPSHOT_TEXT_LIMIT)
  assert.ok(clipped.endsWith('…'))
  assert.equal(clipSnapshotText('abc', 0), '')
})

test('a message summary keeps the fields the panel uses and drops every heavy one', () => {
  const lite = summarizeSnapshotMessage(heavyMessage(3))
  assert.equal(lite.id, 'msg-3')
  assert.equal(lite.roomId, 'room-1')
  assert.deepEqual(lite.sender, { kind: 'bot', botId: 'bot-1', name: '小董' })
  assert.equal(lite.createdAt, T0)
  assert.equal(lite.sequence, 3)
  assert.ok(Array.from(lite.text).length <= SNAPSHOT_TEXT_LIMIT)
  assert.ok(lite.text.endsWith('…'))
  // THE CONTRACT: only the named lightweight fields exist on the wire object.
  assert.deepEqual(Object.keys(lite).sort(), ['createdAt', 'id', 'mentions', 'roomId', 'sender', 'sequence', 'text'].sort())
  const serialized = JSON.stringify(lite)
  for (const leaked of ['reasoning', 'toolActivity', 'deliverables', 'usage', 'sessionSeq', 'modelText', 'attachments', 'runId', 'sessionId']) {
    assert.equal(serialized.includes(leaked), false, `${leaked} leaked into the snapshot`)
  }
})

test('optional fields are omitted, not written as undefined', () => {
  const base = heavyMessage(0)
  const sparse = summarizeSnapshotMessage({
    id: base.id,
    roomId: base.roomId,
    sender: { kind: 'user', name: 'user' },
    text: '你好',
    createdAt: T0,
  } as BotMessage)
  assert.deepEqual(Object.keys(sparse).sort(), ['createdAt', 'id', 'roomId', 'sender', 'text'].sort())
  assert.equal(JSON.stringify(sparse).includes('undefined'), false)
})

test('message arrays map in order and an empty array stays empty', () => {
  assert.deepEqual(summarizeSnapshotMessages([]), [])
  const lite = summarizeSnapshotMessages([heavyMessage(1), heavyMessage(2)])
  assert.equal(lite.length, 2)
  assert.deepEqual(lite.map(m => m.id), ['msg-1', 'msg-2'])
  assert.deepEqual(lite.map(m => m.sequence), [1, 2])
})

test('a run summary keeps scheduling/status/failure fields and drops prompt + lease internals', () => {
  const lite = summarizeSnapshotRun(heavyRun(5))
  assert.equal(lite.id, 'run-5')
  assert.equal(lite.botId, 'bot-1')
  assert.equal(lite.status, 'failed')
  assert.equal(lite.controlRevision, 7)
  assert.equal(lite.startedAt, T0)
  assert.equal(lite.finishedAt, T0)
  assert.equal(lite.deadlineAt, T0)
  assert.equal(lite.failureKind, 'timeout')
  assert.equal(lite.error, '运行超时，已停止')
  const serialized = JSON.stringify(lite)
  for (const leaked of ['prompt', 'leaseOwner', 'leaseExpiresAt', 'assignment', 'sessionId']) {
    assert.equal(serialized.includes(leaked), false, `${leaked} leaked into the snapshot`)
  }
})

test('run arrays map in order and an empty array stays empty', () => {
  assert.deepEqual(summarizeSnapshotRuns([]), [])
  assert.deepEqual(summarizeSnapshotRuns([heavyRun(1), heavyRun(2)]).map(r => r.id), ['run-1', 'run-2'])
})

test('the slim payload is an order of magnitude smaller than the full state it replaces', () => {
  const messages = Array.from({ length: 120 }, (_v, i) => heavyMessage(i))
  const runs = Array.from({ length: 60 }, (_v, i) => heavyRun(i))
  const full = JSON.stringify({ messages, runs })
  const slim = JSON.stringify({
    messages: summarizeSnapshotMessages(messages),
    runs: summarizeSnapshotRuns(runs),
  })
  assert.ok(slim.length < full.length / 10, `slim=${slim.length} full=${full.length}`)
  // And the absolute size is bounded by the clip, not by the input text size.
  const perMessage = JSON.stringify(summarizeSnapshotMessages([heavyMessage(0)])[0]).length
  assert.ok(perMessage < 1_000, `per-message snapshot row=${perMessage}`)
})

test('the unread planner still has its anchor fields on the lite message', () => {
  // `planMarkRead` filters by room and compares createdAt; both must survive the summary.
  const lite = summarizeSnapshotMessage(heavyMessage(9))
  assert.equal(typeof lite.id, 'string')
  assert.equal(typeof lite.roomId, 'string')
  assert.equal(typeof lite.createdAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(lite.createdAt)))
})
