/**
 * Room-goal regression suite — the user's four isolation rules.
 *
 *   · a DM's goal must not affect a group's goal
 *   · a group's goal must not affect a DM's bot
 *   · one group's goal must not affect another group
 *   · one bot's DM goal must not affect another bot's DM
 *
 * All four come from one structural decision — the goal is keyed by `roomId` and nothing else,
 * and every helper takes the room it was given — so this file asserts the helpers cannot be
 * asked for anything else, plus the authority matrix and the progress/stall rules.
 *
 * Usage: node tests/room-goal.mjs
 */
import {
  canEditGoal, canReadGoal, describeGoal, goalPromptBlock, shouldContinueGoal,
  GOAL_STALL_LIMIT, MAX_GOAL_CHARS,
} from '../packages/core/agent-community/src/room-goal.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const goal = (text, status = 'active', extra = {}) => ({
  text, status, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:05:00.000Z', ...extra,
})

// ── 1. 隔离：目标只属于它所在的房间 ──────────────────────────────────────────
// 四份目标，四个房间（两个单聊、两个群），彼此独立存在。
const goals = {
  dmA: goal('单聊 A 的目标：把首页改完'),
  dmB: goal('单聊 B 的目标：整理数据'),
  groupA: goal('群 A 的目标：做一版新设计'),
  groupB: goal('群 B 的目标：写一份报告'),
}
const blocks = {
  dmA: goalPromptBlock(goals.dmA, '小艾'),
  dmB: goalPromptBlock(goals.dmB, '小毕'),
  groupA: goalPromptBlock(goals.groupA, '设计群'),
  groupB: goalPromptBlock(goals.groupB, '报告群'),
}
check(blocks.dmA.includes('单聊 A 的目标') && !blocks.dmA.includes('单聊 B'), '单聊 A 的注入里没有单聊 B 的内容')
check(blocks.dmB.includes('单聊 B 的目标') && !blocks.dmB.includes('群 A'), '另一个 Bot 的单聊里没有别处的内容')
check(blocks.groupA.includes('做一版新设计') && !blocks.groupA.includes('写一份报告'), '群 A 的注入里没有群 B 的内容')
check(blocks.groupB.includes('写一份报告') && !blocks.groupB.includes('单聊'), '群 B 的注入里没有任何单聊内容')
check(Object.values(blocks).every(b => b.includes('只属于这个房间')), '每个注入块都写明"只属于这个房间"')
check(goalPromptBlock(undefined, 'x') === undefined, '没有目标就不注入（不发空块）')

// ── 2. 描述与裁剪 ────────────────────────────────────────────────────────────
check(describeGoal(goal('做一件事')) === '[进行中] 做一件事', '进行中')
check(describeGoal(goal('做一件事', 'paused')) === '[已暂停] 做一件事', '已暂停')
check(describeGoal(goal('做一件事', 'done')) === '[已完成] 做一件事', '已完成')
const long = describeGoal(goal('长'.repeat(1000)))
check(long.length <= MAX_GOAL_CHARS + 8, '超长目标被裁剪', String(long.length))
check(describeGoal(goal('   ')) === undefined, '空文本不渲染')

// ── 3. 权限矩阵 ──────────────────────────────────────────────────────────────
const user = { kind: 'user' }
const leader = { kind: 'bot', botId: 'botA', roomKind: 'group' }
const member = { kind: 'bot', botId: 'botB', roomKind: 'group' }
const dmBot = { kind: 'bot', botId: 'botA', roomKind: 'direct' }
check(canEditGoal(user, 'botA') === true, '用户可以改任何房间的目标')
check(canEditGoal(leader, 'botA') === true, '群 leader 可以改本群目标')
check(canEditGoal(member, 'botA') === false, '群成员不能改本群目标')
check(canEditGoal(dmBot, 'botA') === true, '单聊里该 Bot 可以改自己的目标')
check(canEditGoal(dmBot, 'botB') === false, '单聊 Bot 不能改别人的目标（leader 不是它）')
check(canEditGoal({ kind: 'bot', botId: 'x', roomKind: 'group' }, undefined) === false, '没有 leader 时 Bot 不能改目标')

check(canReadGoal(user, ['botA']) === true, '用户可以读')
check(canReadGoal(leader, ['botA', 'botB']) === true, '成员可以读本房间目标')
check(canReadGoal({ kind: 'bot', botId: 'botC', roomKind: 'group' }, ['botA', 'botB']) === false, '不在房间里就读不到')

// ── 4. 续跑与停摆 ────────────────────────────────────────────────────────────
check(shouldContinueGoal({ goal: goal('x'), goalDriven: true, hadToolActivity: true, continuations: 0 }) === true,
  '有实际进展 → 继续下一轮')
check(shouldContinueGoal({ goal: goal('x'), goalDriven: true, hadToolActivity: false, continuations: 0 }) === false,
  '没有进展 → 不继续（避免空烧 token）')
check(shouldContinueGoal({ goal: goal('x', 'paused'), goalDriven: true, hadToolActivity: true, continuations: 0 }) === false,
  '目标已暂停 → 不继续')
check(shouldContinueGoal({ goal: goal('x', 'done'), goalDriven: true, hadToolActivity: true, continuations: 0 }) === false,
  '目标已完成 → 不继续')
check(shouldContinueGoal({ goal: goal('x'), goalDriven: true, hadToolActivity: true, continuations: 3 }) === false,
  '续跑次数用尽 → 停下来等用户')
check(GOAL_STALL_LIMIT === 3, '无进展上限是 3 轮（与方案一致）')

console.log(`\n[room-goal] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
