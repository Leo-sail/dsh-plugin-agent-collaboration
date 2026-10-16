/**
 * Group-creation regression suite — 「一句话建出两个群」 and the proposal defects around it.
 *
 * Runs against the REAL modules:
 *   · core/agent-community/src/room-guard.ts    — who may create which room
 *   · core/agent-community/src/group-flow.ts    — propose → confirm, with a fake port
 *
 * The bug it locks down: for one direct-chat message, TWO independent writers created a room —
 * the panel's post-send analysis recorded a proposal the user confirmed, and the direct-chat bot,
 * still inside its own turn, called `agent_community_create_room` and built a second group. The
 * bot's own answer even named the room it had made, while the confirmed group got a different
 * name; the other bot answered in both. Fixes under test:
 *   · a Bot actor may not create a GROUP room at all (room-guard);
 *   · the tool-written proposal goes through the group flow, so it carries the source message,
 *     the real task text and an expiry — and the panel's dialog actually appears;
 *   · a pending proposal is never overwritten by a second writer.
 *
 * Usage: node tests/group-dedupe.mjs
 */
import { screenRoomCreation, isGroupCreation, crossRoomError } from '../packages/core/agent-community/src/room-guard.ts'
import { GroupFlowService } from '../packages/core/agent-community/src/group-flow.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const T = n => new Date(Date.UTC(2026, 9, 15, 12, 50, n)).toISOString()
const DM = 'dm-room'
const USER_TEXT = '你们两个拉个群打个招呼'

/** In-memory stand-in for the host service. The flow under test is real; only storage is fake. */
function makeHarness() {
  const bots = [
    { id: 'botA', name: 'sfasfgs', description: '' },
    { id: 'botB', name: 'tsgreafw', description: '' },
  ]
  const state = {
    rooms: [{
      id: DM, name: 'sfasfgs', directBotId: 'botA', memberIds: ['botA'],
      mentionOnly: false, sequence: 0, connection: 'disconnected', createdAt: T(0), updatedAt: T(0),
    }],
    messages: [],
    created: [],
    runs: [],
    notes: [],
  }
  let seq = 0
  const port = {
    getRoom: id => state.rooms.find(r => r.id === id),
    listRooms: () => state.rooms,
    saveRoom: (room) => {
      const i = state.rooms.findIndex(r => r.id === room.id)
      if (i >= 0) state.rooms[i] = room
    },
    listBots: () => bots,
    getBot: id => bots.find(b => b.id === id),
    getMessage: id => state.messages.find(m => m.id === id),
    createRoom: async (input) => {
      const room = {
        id: `new-room-${state.created.length + 1}`,
        name: input.name,
        memberIds: [...(input.memberIds ?? [])],
        ...(input.directBotId !== undefined ? { directBotId: input.directBotId } : {}),
        ...(input.team !== undefined ? { team: input.team } : {}),
        createdAt: T(30), updatedAt: T(30),
      }
      state.rooms = [...state.rooms, room]
      state.created.push(room)
      return room
    },
    appendMessage: (m) => { state.messages = [...state.messages, m] },
    note: (roomId, text) => { state.notes.push({ roomId, text }) },
    queueRun: (input) => { state.runs.push(input) },
    deleteRoom: async (id) => { state.rooms = state.rooms.filter(r => r.id !== id) },
    nudge: () => {},
    resumeSoloTurn: () => {},
    // No model consult in these tests: every proposal supplies its members explicitly, which is
    // exactly the path a bot's `propose_group` takes.
    stream: () => undefined,
    nextId: () => `id-${++seq}`,
    now: () => T(20),
    logger: { warn: () => {} },
  }
  return { port, state, bots }
}

// ── 1. the guard ─────────────────────────────────────────────────────────────
check(isGroupCreation({ memberIds: ['botA', 'botB'] }) === true, '两个成员的房间 = 群')
check(isGroupCreation({ directBotId: 'botA', memberIds: ['botA'] }) === false, '单聊房间不是群')

const asUser = { kind: 'user' }
const asBotInDm = { kind: 'bot', roomKind: 'direct' }
const asBotInGroup = { kind: 'bot', roomKind: 'group' }

check(screenRoomCreation({ memberIds: ['a', 'b'] }, asUser).allow === true, '用户建群 → 允许')
const dmRefusal = screenRoomCreation({ memberIds: ['botA', 'botB'] }, asBotInDm)
check(dmRefusal.allow === false, 'Bot 在单聊里建群 → 拒绝（这就是第二个群的来源）')
check(dmRefusal.reason.includes('propose_group'), '拒绝理由告诉它改走 propose_group', dmRefusal.reason)
const groupRefusal = screenRoomCreation({ memberIds: ['botA', 'botB'] }, asBotInGroup)
check(groupRefusal.allow === false, 'Bot 在群里建群 → 拒绝')
check(groupRefusal.reason.includes('界面'), '拒绝理由指向让用户在界面新建', groupRefusal.reason)
check(screenRoomCreation({ directBotId: 'botB' }, asBotInDm).allow === true, 'Bot 建单聊房间 → 允许（不是团队决策）')
check(screenRoomCreation({ memberIds: ['botA'] }, asBotInDm).allow === true, 'Bot 建只有一个成员的房间 → 允许')
// 实测（2026-10-16）：界面能建出 0 成员的群，而那种群永远没有 leader、没人能回答 —— 在这里拦掉
const emptyRoom = screenRoomCreation({ memberIds: [] }, asUser)
check(emptyRoom.allow === false, '0 成员的群 → 拒绝创建')
check(String(emptyRoom.reason).includes('至少'), '拒绝理由说明要有成员', String(emptyRoom.reason))
check(screenRoomCreation({ memberIds: ['botA'] }, asUser).allow === true, '1 个成员的群仍然允许')

// ── 1b. cross-room isolation (「不能将 A 群聊的任务发到 B 群聊中」) ──────────
check(crossRoomError('roomA', 'roomA') === undefined, 'Bot 在自己房间里操作 → 放行')
check(crossRoomError(undefined, 'anything') === undefined, '没有插件会话的调用方（用户）→ 不限制')
check(typeof crossRoomError('roomA', 'roomB') === 'string', 'A 群的 Bot 去读/写 B 群 → 拒绝')
check(crossRoomError('roomA', 'roomB').includes('roomA'), '拒绝理由说出它当前在哪个房间')

// ── 2. propose → confirm, and the fields the old tool path lost ──────────────
const h = makeHarness()
const flow = new GroupFlowService(h.port, { proposalTimeoutMs: 120_000 })
h.state.messages.push({
  id: 'm1', roomId: DM, sender: { kind: 'user', name: 'user' }, text: USER_TEXT, mentions: [], createdAt: T(16),
})

const proposed = await flow.propose({ roomId: DM, messageId: 'm1', name: '打招呼群', memberIds: ['botB'], leaderId: 'botA', reason: '需要双方参与' })
const stored = h.state.rooms[0].pendingGroupProposal
check(proposed?.sourceMessageId === 'm1', '提议记住了来源消息（面板靠它才会弹窗）')
check(stored?.taskText === USER_TEXT, '提议带着用户原话（旧实现是空字符串）', JSON.stringify(stored?.taskText))
check(typeof stored?.expiresAt === 'string', '提议带过期时间（旧实现永不过期）')
check(stored?.leaderId === 'botA', '提议者当 leader')
check(JSON.stringify(stored?.memberIds) === JSON.stringify(['botA', 'botB']), '成员 = 单聊 Bot + 被点名的 Bot，顺序稳定')

// A second writer (the panel's analysis, or a second tool call) must not clobber it.
h.state.messages.push({ id: 'm2', roomId: DM, sender: { kind: 'user', name: 'user' }, text: '再来一个群', mentions: [], createdAt: T(18) })
const again = await flow.propose({ roomId: DM, messageId: 'm2', name: '另一个群', memberIds: ['botB'], leaderId: 'botA', reason: 'x' })
check(again?.id === proposed?.id, '已有待确认提议时不覆盖（覆盖会让正在看的弹窗点确认时报"找不到提议"）')
check(h.state.rooms[0].pendingGroupProposal?.taskText === USER_TEXT, '原提议的任务文本保持不变')

const group = await flow.confirm({ proposalId: proposed.id, memberIds: [] })
check(h.state.created.length === 1, '确认之后恰好创建一个群（不是两个）', `created=${h.state.created.length}`)
check(group.memberIds.length === 2, '新群有两个成员')
check(group.team?.leaderName === 'sfasfgs', '新群的 leader 是提议者')
const replayed = h.state.messages.filter(m => m.roomId === group.id && m.sender.kind === 'user')
check(replayed.length === 1 && replayed[0].text === USER_TEXT, '群里的任务 = 用户原话（旧实现重放的是空消息）', JSON.stringify(replayed[0]?.text))
check(h.state.runs.length === 1 && h.state.runs[0].botId === 'botA', '只给 leader 起一轮（不是全体各跑一次）', JSON.stringify(h.state.runs.map(r => r.botId)))

// The bot's own create_room attempt, in the same scenario, is what the guard refuses.
const botWouldCreate = screenRoomCreation({ name: '打招呼群', memberIds: ['botA', 'botB'] }, asBotInDm)
check(botWouldCreate.allow === false, '同一时刻 Bot 的 create_room 被守卫拦下 → 总共只有一个群')
check(h.state.created.length === 1, '整个场景结束后房间数仍为 1')

// ── 3. an expired proposal may be replaced; a live one may not ───────────────
const h2 = makeHarness()
const expiredFlow = new GroupFlowService(h2.port, { proposalTimeoutMs: -1 })
h2.state.messages.push({ id: 'm1', roomId: DM, sender: { kind: 'user', name: 'user' }, text: USER_TEXT, mentions: [], createdAt: T(16) })
const dead = await expiredFlow.propose({ roomId: DM, messageId: 'm1', name: '过期群', memberIds: ['botB'], leaderId: 'botA', reason: 'r' })
check(expiredFlow.pending(DM) === undefined, '过期提议不再被认为是待确认的')
check(h2.state.rooms[0].pendingGroupProposal?.status === 'expired', '并且被标记为 expired（旧实现根本没有过期这条路）')
const fresh = await expiredFlow.propose({ roomId: DM, messageId: 'm1', name: '新群', memberIds: ['botB'], leaderId: 'botA', reason: 'r2' })
check(fresh !== undefined && fresh.id !== dead?.id, '过期之后可以再提一个新的')


// ── 9. 移除成员：队长可以移除自己（线上实测：用户要求移除队长时无路可走）────────
//
// The bot's own report from a live group: "用我的 bot id 再调 → you cannot remove yourself
// from the group … 我这边已经没有任何可执行的路径了". The user asked for it explicitly, so the
// coordinator executing it is not an accident — leadership passes to the next member.
const h3 = makeHarness()
h3.state.rooms = [...h3.state.rooms, {
  id: 'grp', name: '群', memberIds: ['botA', 'botB'],
  team: { leader: { kind: 'bot', botId: 'botA' } },
  mentionOnly: false, sequence: 0, connection: 'disconnected', createdAt: T(0), updatedAt: T(0),
}]
const remover = new GroupFlowService(h3.port, { proposalTimeoutMs: 120_000 })

const asLeaderRemovesOther = remover.remove({ roomId: 'grp', botIds: ['botB'], actorId: 'botA', reason: 'x' })
check(asLeaderRemovesOther.ok === true && asLeaderRemovesOther.removed.join(',') === 'botB',
  '队长移除别人 → 成功', JSON.stringify(asLeaderRemovesOther.removed))

const h4 = makeHarness()
h4.state.rooms = [...h4.state.rooms, {
  id: 'grp', name: '群', memberIds: ['botA', 'botB'],
  team: { leader: { kind: 'bot', botId: 'botA' } },
  mentionOnly: false, sequence: 0, connection: 'disconnected', createdAt: T(0), updatedAt: T(0),
}]
const selfRemover = new GroupFlowService(h4.port, { proposalTimeoutMs: 120_000 })
const selfRemoval = selfRemover.remove({ roomId: 'grp', botIds: ['botA'], actorId: 'botA', reason: '用户要求把队长移出' })
check(selfRemoval.ok === true && selfRemoval.removed.join(',') === 'botA',
  '队长移除自己 → 成功（用户明确要求时这是唯一出路）', JSON.stringify(selfRemoval.refused))
const afterSelf = h4.port.getRoom('grp')
check(afterSelf.memberIds.join(',') === 'botB', '移除后成员只剩另一个', afterSelf.memberIds.join(','))
// 领导权是**显式交接**的（不是靠回退），所以移除队长之后房间依然有队长。
check(selfRemover.leaderIdOf(afterSelf) === 'botB',
  '移除队长后领导权交接给剩下的成员', String(selfRemover.leaderIdOf(afterSelf)))

const h5 = makeHarness()
h5.state.rooms = [...h5.state.rooms, {
  id: 'grp', name: '群', memberIds: ['botA', 'botB'],
  team: { leader: { kind: 'bot', botId: 'botA' } },
  mentionOnly: false, sequence: 0, connection: 'disconnected', createdAt: T(0), updatedAt: T(0),
}]
const authority = new GroupFlowService(h5.port, { proposalTimeoutMs: 120_000 })
const memberTries = authority.remove({ roomId: 'grp', botIds: ['botA'], actorId: 'botB', reason: 'x' })
check(memberTries.ok === false && String(memberTries.error).includes('leader'),
  '非队长（成员）移除别人 → 仍然拒绝', String(memberTries.error))
const userRemoves = authority.remove({ roomId: 'grp', botIds: ['botA'], reason: '用户直接操作' })
check(userRemoves.ok === true && userRemoves.removed.join(',') === 'botA',
  '没有 actorId（用户/界面操作）→ 允许', JSON.stringify(userRemoves.removed))

console.log(`\n[group-dedupe] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
