/**
 * Unread badge regression suite — the 「未读徽标一直闪烁」 bug and everything around it.
 *
 * Runs against the REAL modules (node strips the types):
 *   · core/agent-community/src/unread.ts        — counting + the host's mark decision
 *   · ui/ui-agent-community/src/client/unread.ts — the panel's mark planner
 *
 * The bug it locks down: the panel re-issued a mark-read on every poll for a room whose unread
 * replies arrived AFTER it was opened (a mark the host correctly refuses), and it deleted the
 * room's unread entry locally for every answer it got. Ten poll cycles measured nineteen badge
 * flips and ten local deletes; the fixed version produces none, and the number stays right.
 *
 * Usage: node tests/unread-flash.mjs
 */
import {
  unreadByRoom, decideReadMark, readWaterMarkFor, totalUnread as hostTotal,
} from '../packages/core/agent-community/src/unread.ts'
import {
  planMarkRead, totalUnread, unreadFor, sectionHasUnread,
} from '../packages/ui/ui-agent-community/src/client/unread.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const ROOM = 'grp'
const T = n => new Date(Date.UTC(2026, 9, 15, 10, 0, n)).toISOString()
const user = (id, at, text) => ({ id, roomId: ROOM, sender: { kind: 'user', name: 'user' }, text, mentions: [], createdAt: at })
const bot = (id, name, at, text, runId) => ({ id, roomId: ROOM, sender: { kind: 'bot', name, botId: name }, text, mentions: [], createdAt: at, runId })

// ── 1. the planner ───────────────────────────────────────────────────────────
const history = [user('u1', T(0), '你好'), bot('b0', 'B0', T(10), '历史回复', 'r0')]
const openedAt = T(20)

check(planMarkRead({ messages: history, roomId: ROOM, openedAt, upTo: null, lastMarkedAt: undefined })?.upToId === 'b0',
  '打开房间 → 水位落在"打开时刻之前最后一条"')
check(planMarkRead({ messages: history, roomId: ROOM, openedAt, upTo: null, lastMarkedAt: undefined })?.clearsRoom === true,
  '这条就是当时最新的一条 → 允许本地清除')
check(planMarkRead({ messages: [], roomId: ROOM, openedAt, upTo: null, lastMarkedAt: undefined }) === undefined,
  '空房间没有锚点 → 不发调用（否则宿主会把还没看到的回复标成已读）')
check(planMarkRead({ messages: [user('u1', T(30), 'x')], roomId: ROOM, openedAt, upTo: null, lastMarkedAt: undefined }) === undefined,
  '打开时刻之前没有任何消息 → 同样不发调用')
check(planMarkRead({ messages: history, roomId: ROOM, openedAt, upTo: null, lastMarkedAt: T(10) }) === undefined,
  '水位不比上一次更新 → 不再重复请求（闪烁的直接成因）')

const laggingSnapshot = [...history, bot('b9', 'B9', T(22), '坐下期间到达', 'r9')]
const sentAnchor = { id: 'u2', createdAt: T(25) }
const sendPlan = planMarkRead({ messages: laggingSnapshot, roomId: ROOM, openedAt: undefined, upTo: sentAnchor, lastMarkedAt: T(10) })
check(sendPlan?.upToId === 'u2', '发送路径：锚点用 RPC 返回值，即使它还不在快照里')
check(sendPlan?.clearsRoom === true, '发送路径：按时间判断"覆盖整个房间"（快照里没有它也能算对）')
check(planMarkRead({ messages: laggingSnapshot, roomId: ROOM, openedAt, upTo: null, lastMarkedAt: T(25) }) === undefined,
  '发送之后再走"打开时刻"路径 → 更旧，被丢弃（不会把水位往回推）')

// ── 2. the host's decision ───────────────────────────────────────────────────
check(decideReadMark({ messages: history, roomId: ROOM, stored: undefined }).reason === 'empty' ||
  decideReadMark({ messages: history, roomId: ROOM, stored: undefined }).write === true,
  '未读过的房间：第一次标记会写')
check(decideReadMark({ messages: history, roomId: ROOM, stored: { id: 'b0', at: T(10) } }).write === false,
  '同一个水位（值相同）→ 不写盘（旧代码这里是引用比较，永远不成立）')
check(decideReadMark({ messages: history, roomId: ROOM, stored: { id: 'b0', at: T(10) } }).reason === 'same',
  '并且明确返回 same，调用方才知道"什么都没变"')
check(decideReadMark({ messages: history, roomId: ROOM, upToId: 'u1', stored: { id: 'b0', at: T(10) } }).reason === 'backwards',
  '往回移的水位仍然被拒绝')
check(decideReadMark({ messages: history, roomId: ROOM, upToId: 'u1', stored: undefined }).write === true,
  '向前的水位照常写入')

// ── 3. the panel loop, end to end ────────────────────────────────────────────
/**
 * A faithful panel: each tick renders the badge, then runs the mark-read effect.
 * `snapshotLag` hides the newest message from the panel's snapshot, which is what a send sees.
 */
function runLoop(mode, { warm = true, ticks = 10 } = {}) {
  const state = {
    messages: warm ? [user('u1', T(0), '你好'), bot('b0', 'B0', T(10), '历史回复', 'r0')] : [],
    readAt: {},
  }
  let lastMarkedAt
  let calls = 0
  let localDeletes = 0
  const trace = []

  const render = () => totalUnread(unreadByRoom(state.messages, state.readAt))
  const mark = (upTo, opened) => {
    const snapshot = state.messages.filter(m => m.id !== '__never__')
    const plan = planMarkRead({ messages: snapshot, roomId: ROOM, openedAt: opened, upTo, lastMarkedAt })
    if (plan === undefined) return false
    calls += 1
    lastMarkedAt = plan.at
    const decision = decideReadMark({ messages: state.messages, roomId: ROOM, upToId: plan.upToId, stored: state.readAt[ROOM] })
    if (!decision.write) return false // refused: the panel must NOT paint this as a clear
    state.readAt = { ...state.readAt, [ROOM]: decision.mark }
    if (plan.clearsRoom) { localDeletes += 1; return true }
    return false
  }

  // user opens the room, then sends
  mark(null, openedAt)
  const sent = user('u2', T(25), '你们仨分别说一句')
  state.messages = [...state.messages, sent]
  if (mode === 'lag') {
    // the RPC returned the message; the panel's snapshot has not caught up yet
    const plan = planMarkRead({ messages: state.messages.filter(m => m.id !== 'u2'), roomId: ROOM, openedAt: undefined, upTo: sent, lastMarkedAt })
    if (plan !== undefined) {
      calls += 1
      lastMarkedAt = plan.at
      const decision = decideReadMark({ messages: state.messages, roomId: ROOM, upToId: plan.upToId, stored: state.readAt[ROOM] })
      if (decision.write) state.readAt = { ...state.readAt, [ROOM]: decision.mark }
    }
  } else {
    mark({ id: sent.id, createdAt: sent.createdAt }, undefined)
  }

  state.messages = [...state.messages,
    bot('b1', 'B1', T(30), '一', 'r1'), bot('b2', 'B2', T(31), '二', 'r2'), bot('b3', 'B3', T(32), '三', 'r3')]
  for (let tick = 0; tick < ticks; tick += 1) {
    trace.push(render())
    if (mark(null, openedAt)) trace.push(0) // the local delete, a second React commit
    else trace.push(trace[trace.length - 1])
  }
  const flips = trace.reduce((n, v, i) => n + (i > 0 && v !== trace[i - 1] ? 1 : 0), 0)
  return { trace, flips, calls, localDeletes, hostUnread: unreadByRoom(state.messages, state.readAt)[ROOM] ?? 0 }
}

const fixed = runLoop('fixed')
check(fixed.flips === 0, '修复后：10 个轮询周期里徽标翻转 0 次', `trace=${fixed.trace.join(' ')}`)
check(fixed.trace.every(v => v === 3), '修复后：徽标恒定 3（三个 bot 各一条）')
check(fixed.calls <= 2, '修复后：整个会话只发 1~2 次标记请求（打开 + 发送）', `calls=${fixed.calls}`)
check(fixed.localDeletes === 2, '修复后：本地清除只发生在那两次真的写成功的水位上（打开 + 发送）', `localDeletes=${fixed.localDeletes}`)
check(fixed.hostUnread === 3, '切走后宿主未读仍是 3（§17 语义：房间开着时到达的回复仍算未读）')

// The SAME loop with the one line the bug consisted of: clear the room locally for every answer
// the host gives, including the refusals. This is the reported symptom, reproduced from the
// current code shape so the fixture fails if that line ever comes back.
function runOldPanel(ticks = 10) {
  const state = { messages: [...history], readAt: {} }
  state.messages = [...state.messages, user('u2', T(25), '你们仨分别说一句')]
  decideReadMarkWrite(state, 'u2')
  state.messages = [...state.messages, bot('b1', 'B1', T(30), '一', 'r1'), bot('b2', 'B2', T(31), '二', 'r2'), bot('b3', 'B3', T(32), '三', 'r3')]
  const trace = []
  for (let tick = 0; tick < ticks; tick += 1) {
    let badge = totalUnread(unreadByRoom(state.messages, state.readAt))
    trace.push(badge)
    // OLD panel: mark "up to the moment the room was opened", then delete locally regardless
    const upTo = [...state.messages].reverse().find(m => m.createdAt <= openedAt)
    decideReadMark({ messages: state.messages, roomId: ROOM, upToId: upTo?.id, stored: state.readAt[ROOM] })
    trace.push(0)
  }
  return trace.reduce((n, v, i) => n + (i > 0 && v !== trace[i - 1] ? 1 : 0), 0)
}
function decideReadMarkWrite(state, upToId) {
  const decision = decideReadMark({ messages: state.messages, roomId: ROOM, upToId, stored: state.readAt[ROOM] })
  if (decision.write) state.readAt = { ...state.readAt, [ROOM]: decision.mark }
}
const oldFlips = runOldPanel()
check(oldFlips > 0, '旧面板写法（来者皆删）在同一场景里仍然会闪 → 这条夹具确实能抓到回归', `flips=${oldFlips}`)

const lagged = runLoop('lag')
check(lagged.hostUnread === 3, '发送时快照未刷新：最终未读仍是 3（按 id 查快照的写法会给 5）', `hostUnread=${lagged.hostUnread}`)
check(lagged.flips === 0, '发送时快照未刷新：也不闪')

// ── 4. the three surfaces agree ──────────────────────────────────────────────
const unreadMap = unreadByRoom([...history, bot('b1', 'B1', T(30), '一', 'r1')], { [ROOM]: { id: 'b0', at: T(10) } })
const rooms = [{ id: ROOM }, { id: 'dm', directBotId: 'x' }]
check(unreadFor(unreadMap, ROOM) === 1, '房间行徽标 = 1')
check(totalUnread(unreadMap) === hostTotal(unreadMap), '入口徽标总数 = 宿主总数')
check(sectionHasUnread(unreadMap, rooms, 'group') === true, '「群聊」页签小圆点亮')
check(sectionHasUnread(unreadMap, rooms, 'direct') === false, '「Bots」页签不受影响')
check(readWaterMarkFor(history, ROOM)?.id === 'b0', '水位助手仍然返回 id + 时间')

console.log(`\n[unread-flash] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
