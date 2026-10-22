/**
 * Tests for the consult-skip policy and the model-answer validation (OP-10).
 *
 * `shouldSkipModelConsult` is the cost-saving half of the proposal path: it may answer "the
 * ranking already names the roster" only for the narrow, unambiguous shape (shortlist of exactly
 * source + one clear fit, simple task). Everything else must keep the model call.
 *
 * `validateConsultDecision` is the safety half: whether the roster came from the shortcut or from
 * the model, it is accepted only if its members were actually offered and a leader resolves.
 *
 * Run with: node --test tests/proposal-policy.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DETERMINISTIC_SELECTION_REASON,
  SKIP_CONSULT_FIT_FLOOR,
  shouldSkipModelConsult,
  validateConsultDecision,
} from '../packages/core/agent-community/src/proposal-policy.ts'
import { GroupFlowService } from '../packages/core/agent-community/src/group-flow.ts'

const SIMPLE_TASK = '帮我把这句话翻译成英文'
const STANDARD_TASK = '请帮我看一下这份材料里关于用户增长的部分，如果有不清楚的地方标出来，并在旁边写上你的判断和依据'

interface SkipInput {
  shortlist: readonly { botId: string; score: number }[]
  directBotId?: string
  taskText: string
  maxMembers: number
}

function skipInput(overrides: Partial<SkipInput> = {}): SkipInput {
  return {
    shortlist: [
      { botId: 'source', score: 3 },
      { botId: 'specialist', score: 3 },
    ],
    directBotId: 'source',
    taskText: SIMPLE_TASK,
    maxMembers: 4,
    ...overrides,
  }
}

// ── shouldSkipModelConsult ──────────────────────────────────────────────────

test('a simple task with an unambiguous shortlist skips the model consult', () => {
  const result = shouldSkipModelConsult(skipInput())
  assert.notEqual(result, false)
  assert.ok(result !== false)
  assert.equal(result.skip, true)
  assert.equal(result.reason, DETERMINISTIC_SELECTION_REASON)
  assert.deepEqual([...result.selection!.members], ['source', 'specialist'])
  assert.equal(result.selection!.leaderId, 'source', 'the source bot stays the default leader')
})

test('a borderline candidate score keeps the model call', () => {
  assert.equal(SKIP_CONSULT_FIT_FLOOR, 2)
  const result = shouldSkipModelConsult(skipInput({
    shortlist: [{ botId: 'source', score: 3 }, { botId: 'marginal', score: SKIP_CONSULT_FIT_FLOOR - 0.5 }],
  }))
  assert.equal(result, false)
})

test('an ambiguous task keeps the model call even with a two-bot shortlist', () => {
  assert.equal(shouldSkipModelConsult(skipInput({ taskText: STANDARD_TASK })), false)
})

test('a larger shortlist keeps the model call', () => {
  assert.equal(shouldSkipModelConsult(skipInput({
    shortlist: [
      { botId: 'source', score: 3 },
      { botId: 'specialist', score: 3 },
      { botId: 'third', score: 2 },
    ],
  })), false)
})

test('a shortlist without the source bot is not a skip', () => {
  assert.equal(shouldSkipModelConsult(skipInput({
    shortlist: [{ botId: 'specialist', score: 3 }, { botId: 'other', score: 2 }],
  })), false)
})

test('empty text and impossible caps are not skips', () => {
  assert.equal(shouldSkipModelConsult(skipInput({ taskText: '   ' })), false)
  assert.equal(shouldSkipModelConsult(skipInput({ maxMembers: 1 })), false)
  assert.equal(shouldSkipModelConsult(skipInput({ directBotId: undefined })), false)
})

test('the source bot keeps the leader role regardless of shortlist order', () => {
  const result = shouldSkipModelConsult(skipInput({
    shortlist: [{ botId: 'specialist', score: 3 }, { botId: 'source', score: 3 }],
  }))
  assert.ok(result !== false && result.selection !== undefined)
  assert.equal(result.selection.leaderId, 'source')
})

// ── validateConsultDecision ─────────────────────────────────────────────────

const ALLOWED = ['source', 'specialist', 'third'] as const

test('a model selection inside the shortlist is accepted', () => {
  const checked = validateConsultDecision(
    { members: ['source', 'specialist'], leaderId: 'specialist' },
    ALLOWED,
    'source',
    4,
  )
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.deepEqual([...checked.selection.members], ['source', 'specialist'])
  assert.equal(checked.selection.leaderId, 'specialist')
})

test('a leader outside the members is forced to a valid member', () => {
  const checked = validateConsultDecision(
    { members: ['source', 'specialist'], leaderId: 'stranger' },
    ALLOWED,
    'source',
    4,
  )
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.equal(checked.selection.leaderId, 'source', 'falls back to the source bot')
})

test('members that were never offered are dropped and reported', () => {
  const checked = validateConsultDecision(
    { members: ['source', 'ghost'], leaderId: 'ghost' },
    ALLOWED,
    'source',
    4,
  )
  assert.equal(checked.ok, false)
  if (checked.ok) return
  assert.deepEqual([...checked.dropped], ['ghost'])
  assert.match(checked.reason, /不在候选名单/u)
})

test('too few valid members is a rejection, not a smaller group', () => {
  const checked = validateConsultDecision({ members: ['source'] }, ALLOWED, 'source', 4)
  assert.equal(checked.ok, false)
  if (checked.ok) return
  assert.match(checked.reason, /不足 2 个/u)
})

test('the caller cap and de-duplication still apply to a valid selection', () => {
  const capped = validateConsultDecision(
    { members: ['source', 'source', 'specialist', 'third'], leaderId: 'source' },
    ALLOWED,
    'source',
    2,
  )
  assert.equal(capped.ok, true)
  if (!capped.ok) return
  assert.deepEqual([...capped.selection.members], ['source', 'specialist'])
})

// ── group-flow wiring (the shortcut must actually be used) ──────────────────

/**
 * Minimal host for `propose()`: one direct chat with the source bot and one translator whose
 * description matches the task. Only the port members `propose()` touches are real; the model
 * stream is ABSENT on purpose, so a non-skipped consult must surface as the fallback reason.
 */
function makeProposalHarness(): {
  port: never
  roomId: string
  messageId: string
  saved: unknown[]
} {
  const now = '2026-10-22T00:00:00.000Z'
  const bots = [
    {
      id: 'writer',
      name: '写手',
      description: '内容分析师：拆解公众号文章，整理结构清单。',
      systemPrompt: '# 边界\n- 不写正文\n',
    },
    {
      id: 'translator',
      name: '译者',
      description: '中英互译：把文案翻译成英文，保留语气与术语一致。',
      systemPrompt: '# 产出\n- 英文译文\n',
    },
  ]
  const room = {
    id: 'dm-1',
    name: '和写手的单聊',
    directBotId: 'writer',
    memberIds: ['writer'],
    mentionOnly: false,
    sequence: 0,
    connection: 'connected',
    createdAt: now,
    updatedAt: now,
  }
  const message = {
    id: 'message-1',
    roomId: 'dm-1',
    sender: { kind: 'user', name: 'user' },
    text: SIMPLE_TASK,
    mentions: [],
    createdAt: now,
  }
  const messages = new Map([['message-1', message]])
  const saved: unknown[] = []
  const port = {
    getRoom: (id: string) => (id === room.id ? room : undefined),
    listRooms: () => [room],
    saveRoom: (room: unknown) => { saved.push(room) },
    listBots: () => bots,
    getBot: (id: string) => bots.find(bot => bot.id === id),
    getMessage: (id: string) => messages.get(id),
    stream: () => undefined,
    nextId: () => 'proposal-1',
    now: () => now,
    logger: { info: () => undefined, warn: () => undefined },
  }
  return { port: port as never, roomId: room.id, messageId: message.id, saved }
}

test('group-flow proposes the deterministic roster for a simple unambiguous task', async () => {
  const harness = makeProposalHarness()
  const flow = new GroupFlowService(harness.port, { now: () => Date.parse('2026-10-22T00:00:00.000Z') })
  const result = await flow.propose({ roomId: harness.roomId, messageId: harness.messageId } as never) as {
    suggestedMemberIds?: readonly string[]
    suggestedLeaderId?: string
    reason?: string
  } | undefined
  assert.ok(result !== undefined)
  assert.deepEqual([...(result.suggestedMemberIds ?? [])], ['writer', 'translator'])
  assert.equal(result.suggestedLeaderId, 'writer')
  assert.equal(result.reason, DETERMINISTIC_SELECTION_REASON, 'the shortcut really was used')
  assert.equal(harness.saved.length, 1, 'the proposal is still persisted normally')
})

test('group-flow keeps the model path for an ambiguous task on the same shortlist', async () => {
  const harness = makeProposalHarness()
  const room = (harness.port as unknown as { getRoom(id: string): Record<string, unknown> }).getRoom('dm-1')
  // Swap the message text for a standard-length request: the same two bots still fit, but the
  // policy is not allowed to call this unambiguous.
  const messages = (harness.port as unknown as { getMessage(id: string): Record<string, unknown> }).getMessage
  const original = messages('message-1')
  original['text'] = STANDARD_TASK
  assert.equal(room['directBotId'], 'writer')
  const flow = new GroupFlowService(harness.port, { now: () => Date.parse('2026-10-22T00:00:00.000Z') })
  const result = await flow.propose({ roomId: harness.roomId, messageId: harness.messageId } as never) as {
    reason?: string
  } | undefined
  assert.ok(result !== undefined)
  assert.notEqual(result.reason, DETERMINISTIC_SELECTION_REASON, 'no skip for an ambiguous task')
})
