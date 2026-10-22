/**
 * Tests for the proposal-selection slice (S7, problem 4: "the group pulled in bots that did
 * not fit the task").
 *
 * Two layers:
 *   · `capability.ts` — the deterministic card / ranking / shortlist / leader rules;
 *   · `group-flow.ts` — the proposal flow around them, driven through a fake port: a pending
 *     proposal for ANOTHER message is never reused, and a model that cannot be asked falls
 *     back to the ranked shortlist instead of naming nobody.
 *
 * Run with: node --test tests/capability-proposal.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCapabilityCard,
  chooseValidLeader,
  defaultProposalLeader,
  fallbackSelection,
  rankCandidates,
  sanitizeCollaborateSelection,
  shortlistFor,
} from '../packages/core/agent-community/src/capability.ts'
import type { CapabilityCard } from '../packages/core/agent-community/src/capability.ts'
import {
  GroupFlowService,
  parseProposalAnswer,
  parseProposalDecision,
} from '../packages/core/agent-community/src/group-flow.ts'
import type { GroupFlowPort } from '../packages/core/agent-community/src/group-flow.ts'
import type {
  BotIdentity,
  BotMessage,
  BotRoom,
  PendingGroupProposal,
  ProposeGroupRequest,
} from '../packages/core/agent-community/src/types.ts'

// ── sample team: one specialist per task family ─────────────────────────────

const BOTS = [
  {
    id: 'intel',
    name: '小刘-信息分析师',
    description: 'AI 情报与信息分析师：只做实时情报，自动归档 Obsidian，产出结构化日报与深度简报。',
    systemPrompt: '# 岗位职责\n- 每天扫一手信源，产出日报\n\n# 边界\n- 不写正文、不替老板拍板\n- 只做情报，不碰研究与内容创作\n',
  },
  {
    id: 'paper',
    name: '小赵-AI前沿科学研究员',
    description: 'AI 科研研究员：论文雷达 + 论文库分级管理；每篇论文夹含原文、PDF 与插图，证据化分析，禁止编造。',
    systemPrompt: '# 产出\n- 论文卡、原文与插图\n\n# 边界\n- 不编造、不臆测\n',
  },
  {
    id: 'content',
    name: '小钱-内容分析师',
    description: '内容分析师：拆解公众号/小红书/视频内容，按 20 个节点产出拆解卡并沉淀爆款结构与复盘三库。',
    systemPrompt: '# 交付\n- 拆解卡、结构库\n\n# 边界\n- 只拆不抄，不写正文\n',
  },
  {
    id: 'illust',
    name: '小孙-插图师',
    description: '插画与封面策划：读初稿与拆解卡，定 3–5 个配图位、写 gpt-image 提示词、出封面方案；不发布。',
    systemPrompt: '# 输出\n- 封面方案、配图提示词\n\n# 边界\n- 不发布、不复制画面\n',
  },
]

const CARDS: CapabilityCard[] = BOTS.map(bot => buildCapabilityCard({
  ...bot,
  skillProfile: { names: bot.id === 'illust' ? ['gpt-image', '插画'] : [] },
}))

const ids = (list: readonly { readonly botId: string }[]): string[] => list.map(item => item.botId)

/** The illustrator bot, used by the card test (kept as a variable: Node's parser dislikes `x[3]!`). */
const ILLUST_BOT = BOTS[3] as (typeof BOTS)[number]

// ── capability cards ────────────────────────────────────────────────────────

test("a card is a deterministic, capped summary of the bot's own text", () => {
  const card = buildCapabilityCard({ ...ILLUST_BOT, skillProfile: { names: ['gpt-image', '插画'] } })
  assert.deepEqual(card.skills, ['gpt-image', '插画'])
  // 边界 lines are recognized in both the section and the role sentence.
  assert.ok(card.boundaries.some(tag => tag.includes('发布')), JSON.stringify(card.boundaries))
  // 产出 lines are separated from the capability domains.
  assert.ok(card.deliverables.some(tag => tag.includes('封面')), JSON.stringify(card.deliverables))
  const tags = card.domains.length + card.deliverables.length + card.skills.length + card.boundaries.length
  assert.ok(tags <= 20, `a card must stay small (got ${tags})`)
  // Deterministic: the same bot always yields the same card.
  assert.deepEqual(
    buildCapabilityCard({ ...ILLUST_BOT, skillProfile: { names: ['gpt-image', '插画'] } }),
    card,
  )
})

// ── ranking + shortlist ─────────────────────────────────────────────────────

test('拆解 + 配图 ranks the content analyst and the illustrator on top', () => {
  const ranked = rankCandidates('把这个链接里的内容拆解一下，再做一张封面配图', CARDS)
  const top2 = ids(ranked).slice(0, 2).sort()
  assert.deepEqual(top2, ['content', 'illust'])
  const illus = ranked.find(candidate => candidate.botId === 'illust')
  assert.ok(illus !== undefined && illus.score > 0)
  assert.ok(illus.matched.includes('封面') && illus.matched.includes('配图'))
})

test('查最新论文 ranks the research bot, 写日报 ranks the intelligence bot', () => {
  const paper = rankCandidates('帮我查一下最新的 AI 论文', CARDS)
  assert.equal(paper[0]!.botId, 'paper')
  assert.ok(paper[0]!.matched.includes('论文'))

  const daily = rankCandidates('写一份今天的日报', CARDS)
  assert.equal(daily[0]!.botId, 'intel')
  assert.ok(daily[0]!.matched.includes('日报'))
})

test('the shortlist always contains the source bot and never exceeds the cap', () => {
  for (const task of ['把我这篇公众号内容拆解一下', '帮我查最新论文', '你好呀']) {
    const shortlist = shortlistFor(task, CARDS, 'content', 4)
    assert.ok(ids(shortlist).includes('content'), `source missing for task: ${task}`)
    assert.ok(shortlist.length <= 4)
    assert.ok(shortlist.length >= 2)
  }
})

test('an unrelated task still yields a usable shortlist instead of nothing', () => {
  // No term matches: the order falls back to the name tie-break, and the source bot is kept.
  const shortlist = shortlistFor('你好呀', CARDS, 'content', 4)
  assert.equal(shortlist[0]!.botId, 'content')
  assert.ok(shortlist.every(candidate => candidate.score === 0))
  const fallback = fallbackSelection(shortlist, 'content')
  assert.ok(fallback !== undefined)
  assert.ok(fallback.members.includes('content'))
  assert.equal(fallback.leaderId, 'content')
  assert.ok(fallback.members.length >= 2 && fallback.members.length <= 3)
})

test('fallbackSelection refuses a one-bot shortlist (no group to fall back to)', () => {
  assert.equal(fallbackSelection([{ botId: 'content', score: 1, matched: ['拆解'] }], 'content'), undefined)
})

// ── leader + model-answer validation ───────────────────────────────────────

test('chooseValidLeader keeps a valid pick and falls back to the source bot', () => {
  const members = ['intel', 'content', 'illust']
  assert.equal(chooseValidLeader({ leaderId: 'illust', sourceBotId: 'content', members }), 'illust')
  // Invalid (not a member): the source bot is next, because it holds the task context.
  assert.equal(chooseValidLeader({ leaderId: 'stranger', sourceBotId: 'content', members }), 'content')
  // Invalid and no source in the room: the first member.
  assert.equal(chooseValidLeader({ leaderId: 'stranger', sourceBotId: 'gone', members }), 'intel')
  // The confirm path uses the proposal's leader as its second candidate.
  assert.equal(chooseValidLeader({ leaderId: 'stranger', fallbackLeaderId: 'illust', members }), 'illust')
})

test('a model selection outside the shortlist is rejected, never proposed', () => {
  const allowed = ['content', 'illust', 'intel', 'paper']
  const accepted = sanitizeCollaborateSelection(
    { members: ['content', 'illust'], leaderId: 'illust' },
    allowed,
    'content',
    4,
  )
  assert.deepEqual(accepted, { members: ['content', 'illust'], leaderId: 'illust' })

  // One member was never offered → dropped; only one offered member remains → not a group.
  assert.equal(sanitizeCollaborateSelection(
    { members: ['content', 'stranger'], leaderId: 'content' },
    allowed,
    'content',
    4,
  ), undefined)

  // An invalid leader never leaves a proposal without one.
  assert.equal(sanitizeCollaborateSelection(
    { members: ['content', 'illust'], leaderId: 'stranger' },
    allowed,
    'content',
    4,
  )?.leaderId, 'content')
})

test('parseProposalDecision separates "no group" from "unreadable"', () => {
  assert.deepEqual(parseProposalDecision('{"collaborate":false}'), { kind: 'no-group' })
  assert.deepEqual(parseProposalDecision('抱歉我无法判断'), { kind: 'unreadable' })
  assert.deepEqual(parseProposalDecision('{"collaborate":true,"members":[]}'), { kind: 'unreadable' })
  const decided = parseProposalDecision('{"collaborate":true,"members":["content","illust"],"leader":"illust","name":"拆解群","reason":"需要拆解和配图"}')
  assert.equal(decided.kind, 'collaborate')
  assert.deepEqual(decided.kind === 'collaborate' ? decided.members : [], ['content', 'illust'])
  assert.equal(decided.kind === 'collaborate' ? decided.leaderId : undefined, 'illust')
  // The historical helper keeps its shape: "no group"/malformed still mean undefined.
  assert.equal(parseProposalAnswer('{"collaborate":false}'), undefined)
  assert.equal(parseProposalAnswer('not json'), undefined)
})

// ── the proposal flow around the pure functions ─────────────────────────────

interface FakePort extends GroupFlowPort {
  readonly savedRooms: BotRoom[]
  readonly createdRooms: Array<{
    readonly name: string
    readonly memberIds: readonly string[]
    readonly team?: { readonly leaderBotId?: string | undefined } | undefined
  }>
  readonly queuedRuns: Array<{ readonly roomId: string; readonly botId: string; readonly prompt: string }>
}

interface FakeHarness {
  readonly port: FakePort
  readonly room: BotRoom
  readonly messages: Map<string, BotMessage>
}

/**
 * A fake port for the proposal flow: one direct room, the sample bots, and NO model stream.
 *
 * No stream means `consultModel` returns "failed", which exercises the deterministic fallback
 * path end to end — exactly what happens on a host where the provider is unavailable.
 */
function makePort(options: { readonly pending?: PendingGroupProposal | undefined } = {}): FakeHarness {
  const messages = new Map<string, BotMessage>()
  const rooms: BotRoom[] = []
  const savedRooms: BotRoom[] = []
  const createdRooms: FakePort['createdRooms'] = []
  const queuedRuns: FakePort['queuedRuns'] = []
  const now = '2026-10-22T00:00:00.000Z'
  const directRoom = {
    id: 'dm-1',
    name: '小钱-内容分析师',
    directBotId: 'content',
    memberIds: ['content'],
    mentionOnly: false,
    sequence: 0,
    connection: 'connected',
    createdAt: now,
    updatedAt: now,
    ...(options.pending !== undefined ? { pendingGroupProposal: options.pending } : {}),
  } as unknown as BotRoom
  rooms.push(directRoom)
  const identities = BOTS.map(bot => ({
    id: bot.id,
    name: bot.name,
    description: bot.description,
    systemPrompt: bot.systemPrompt,
    skillProfile: bot.id === 'illust' ? { names: ['gpt-image', '插画'], signature: 'sig' } : undefined,
  })) as unknown as BotIdentity[]
  let nextId = 0
  const port: FakePort = {
    savedRooms,
    createdRooms,
    queuedRuns,
    getRoom: id => rooms.find(room => room.id === id),
    listRooms: () => rooms,
    saveRoom: (room) => {
      savedRooms.push(room)
      const index = rooms.findIndex(existing => existing.id === room.id)
      if (index >= 0) rooms[index] = room
      else rooms.push(room)
    },
    listBots: () => identities,
    getBot: id => identities.find(bot => bot.id === id),
    getMessage: id => messages.get(id),
    createRoom: async (input) => {
      createdRooms.push({
        name: input.name,
        memberIds: input.memberIds,
        ...(input.team !== undefined ? { team: { leaderBotId: input.team.leaderBotId as unknown as string } } : {}),
      })
      const created = {
        id: `group-${++nextId}`,
        name: input.name,
        memberIds: input.memberIds,
        mentionOnly: false,
        sequence: 0,
        connection: 'connected',
        createdAt: now,
        updatedAt: now,
        // Mirrors the real service's `buildTeam`: the room carries the normalized BotTeam.
        team: input.team === undefined
          ? undefined
          : { leader: { kind: 'bot', botId: input.team.leaderBotId }, leaderName: input.team.leaderName, status: 'active' },
      } as unknown as BotRoom
      rooms.push(created)
      return created
    },
    appendMessage: () => undefined,
    note: () => undefined,
    queueRun: (input) => { queuedRuns.push({ roomId: input.roomId, botId: input.botId, prompt: input.prompt }) },
    deleteRoom: async () => undefined,
    nudge: () => undefined,
    resumeSoloTurn: () => undefined,
    stream: () => undefined,
    nextId: () => `id-${++nextId}`,
    now: () => now,
  }
  return { port, room: directRoom, messages }
}

/** Register one user message the port can look up by id. */
function seedMessage(harness: FakeHarness, id: string, text: string): BotMessage {
  const message = {
    id,
    roomId: harness.room.id,
    sender: { kind: 'user', name: 'user' },
    text,
    mentions: [],
    createdAt: '2026-10-22T00:00:00.000Z',
  } as unknown as BotMessage
  harness.messages.set(id, message)
  return message
}

const PENDING_FOR_A: PendingGroupProposal = {
  id: 'proposal-a',
  roomId: 'dm-1' as never,
  sourceMessageId: 'message-a' as never,
  taskText: '把这篇公众号拆解一下',
  name: '拆解群',
  memberIds: ['content', 'illust'] as never[],
  leaderId: 'content' as never,
  reason: '需要拆解',
  status: 'pending',
  createdAt: '2026-10-22T00:00:00.000Z',
  expiresAt: '2999-01-01T00:00:00.000Z',
}

function makePropose(harness: FakeHarness): (messageId: string) => Promise<unknown> {
  const flow = new GroupFlowService(harness.port, { now: () => Date.parse('2026-10-22T00:00:00.000Z') })
  return messageId => flow.propose({ roomId: harness.room.id, messageId } as unknown as ProposeGroupRequest)
}

test('a pending proposal for ANOTHER message is never reused for a new task', async () => {
  const harness = makePort({ pending: PENDING_FOR_A })
  seedMessage(harness, 'message-b', '帮我查一下最新的 AI 论文')
  const result = await makePropose(harness)('message-b')
  assert.equal(result, undefined, 'the new message must not inherit the old task text')
  assert.equal(harness.port.savedRooms.length, 0, 'nothing may be overwritten while the dialog is open')
})

test('the SAME message may refresh the pending proposal (idempotent for both writers)', async () => {
  const harness = makePort({ pending: PENDING_FOR_A })
  seedMessage(harness, 'message-a', '把这篇公众号拆解一下')
  const result = await makePropose(harness)('message-a') as { id?: string } | undefined
  assert.equal(result?.id, 'proposal-a')
  assert.equal(harness.port.savedRooms.length, 0)
})

test('a model that cannot be asked falls back to the ranked shortlist, with the source as leader', async () => {
  const harness = makePort()
  seedMessage(harness, 'message-c', '把这个链接里的内容拆解一下，再做一张封面配图')
  const result = await makePropose(harness)('message-c') as {
    suggestedMemberIds?: readonly string[]
    suggestedLeaderId?: string
  } | undefined
  assert.ok(result !== undefined, 'a failed model call must still produce a proposal')
  const members = result.suggestedMemberIds ?? []
  assert.ok(members.includes('content'), 'the source bot is always in the group')
  assert.ok(members.includes('illust'), 'the illustrator fits the task and must be shortlisted')
  assert.ok(members.length >= 2 && members.length <= 4)
  assert.equal(result.suggestedLeaderId, 'content', 'leader defaults to the source bot when valid')
})

test('confirm honours the user-picked leader and ignores an invalid one', async () => {
  const pending = {
    ...PENDING_FOR_A,
    memberIds: ['content', 'illust', 'intel'] as never[],
    leaderId: 'content' as never,
  }
  const first = makePort({ pending })
  const flow = new GroupFlowService(first.port, { now: () => Date.parse('2026-10-22T00:00:00.000Z') })
  const room = await flow.confirm({
    proposalId: pending.id,
    memberIds: ['content', 'illust'] as never,
    leaderId: 'illust',
  } as never)
  assert.equal(room.team?.leader.botId, 'illust')
  assert.equal(first.port.createdRooms[0]?.team?.leaderBotId, 'illust')

  const second = makePort({ pending: { ...pending, id: 'proposal-2' } })
  const flow2 = new GroupFlowService(second.port, { now: () => Date.parse('2026-10-22T00:00:00.000Z') })
  const room2 = await flow2.confirm({
    proposalId: 'proposal-2',
    memberIds: ['content', 'illust'] as never,
    leaderId: 'stranger',
  } as never)
  // The invalid pick falls back to the proposal's leader, not to a random member.
  assert.equal(room2.team?.leader.botId, 'content')
})

test('a model-driven proposal starts with the source bot as leader, but an explicit caller can choose', () => {
  assert.equal(defaultProposalLeader(['source', 'other'], 'source'), 'source')
  assert.equal(defaultProposalLeader(['other', 'third'], 'source'), 'other')
  assert.equal(defaultProposalLeader([], 'source'), undefined)
  // The helper does not override an explicit choice; the proposal flow only applies it to the
  // model path (see group-flow.ts).
  assert.equal(chooseValidLeader({ leaderId: 'other', members: ['source', 'other'], sourceBotId: 'source' }), 'other')
})
