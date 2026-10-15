/**
 * Routing regression suite — 「群里到底谁运行」.
 *
 * The user's rules, which this file exists to keep true:
 *   · the CONTENT decides how many bots answer: one (a request one bot owns), several (a
 *     request several own), or all (a greeting, or the room addressed in words like 大家/一起);
 *   · `@all` / `@所有人` is the ONE way to ask the whole room;
 *   · a written-out name addresses that member; the BEST role match wins, ties keep all;
 *   · "把 A 踢出去" belongs to the leader, never to the bot it names;
 *   · nothing may wake a run outside this decision (the plugin used to have a second,
 *     unconditionally dead path that also enqueued runs for a user message).
 *
 * Pure module, no runtime needed: `node tests/routing.mjs`.
 */
import { routeMessage, mentionsEveryone, namedBotIdsIn }
  from '../packages/core/agent-community/src/routing.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const bot = (id, name, description) => ({ id, name, ...(description !== undefined ? { description } : {}) })
const MEMBERS = [
  bot('a', '小艾', '你是一名前端开发工程师，负责 UI 与交互'),
  bot('b', '小毕', '你是一名漫画家，负责分镜与角色设计稿'),
  bot('c', '小西', '你是一名测试工程师，负责回归与验收'),
]
const route = (text, extra = {}) => routeMessage({
  members: MEMBERS,
  message: { text, mentions: [], mentionedIds: [] },
  ...extra,
})
const ids = (d) => [...d.targets].sort().join(',')

// ── 1. 单聊 ─────────────────────────────────────────────────────────────────
const dm = routeMessage({
  members: [MEMBERS[0]],
  message: { text: '你好', mentions: [], mentionedIds: [] },
  directBotId: 'a',
})
check(ids(dm) === 'a' && dm.reason === 'direct', '单聊 → 该 Bot（reason=direct）')

// ── 2. @all / @所有人 ───────────────────────────────────────────────────────
check(mentionsEveryone('@all 大家各说一句') === true, '识别 @all')
check(mentionsEveryone('@所有人 各说一句') === true, '识别 @所有人')
check(mentionsEveryone('@allow 这个不是广播') === false, '@all 不是 @allow 的前缀')
check(mentionsEveryone('大家看一下这个设计') === false, '普通文本"大家"不触发全员')
const all = route('@所有人 各说一句', { allMentioned: true })
check(ids(all) === 'a,b,c' && all.reason === 'all', '@所有人 → 全员（reason=all）')

// ── 3. @ 点名 ───────────────────────────────────────────────────────────────
const mention = routeMessage({
  members: MEMBERS,
  message: { text: '@小毕 画个分镜', mentions: [], mentionedIds: ['b'] },
})
check(ids(mention) === 'b' && mention.reason === 'mention', '@某人 → 只有那个人')
const mentionTwo = routeMessage({
  members: MEMBERS,
  message: { text: '@小毕 @小西 一起看', mentions: [], mentionedIds: ['b', 'c'] },
})
check(ids(mentionTwo) === 'b,c', '@两个人 → 两个都运行，且按成员顺序')

// ── 4. 管理指令 → leader ────────────────────────────────────────────────────
const kick = route('把小毕踢出去', { leaderId: 'a' })
check(ids(kick) === 'a' && kick.reason === 'coordinator', '"把 A 踢出去" → leader，而不是 A 本人')
const kickNoLeader = route('把小毕踢出去')
check(!kickNoLeader.targets.includes('b'), '无 leader 时也不会叫被踢的那个人')

// ── 5. 写出名字 → 那个人 ────────────────────────────────────────────────────
const named = route('让小毕画一张封面')
check(ids(named) === 'b' && named.reason === 'matched', '写出名字 → 那个人（reason=matched）', ids(named))
const namedTwo = route('让小毕和小西一起看')
check(ids(namedTwo) === 'b,c', '写出两个名字 → 两个都运行')

// ── 6. 角色词：命中最多者胜，并列才全叫 ─────────────────────────────────────
const role = route('这个页面的交互要重做一下')
check(ids(role) === 'a', '角色词命中前端 → 只叫它', ids(role))
const tie = route('前端和测试都要看一下')
check(ids(tie) === 'a,c', '两个成员并列命中 → 都叫', ids(tie))

// ── 7. 内容决定人数：1 个 / 多个 / 全部 ─────────────────────────────────────
//
// The user's rule: the CONTENT decides how many bots answer — not a blanket "unaddressed
// messages go to the leader". A greeting addresses the room; a domain request aims at the bot
// that owns it; a collective request is the whole room.
const hello = route('你好', { leaderId: 'a' })
check(ids(hello) === 'a,b,c' && hello.reason === 'all', '「你好」→ 全员（打招呼是对着房间说的）', `${ids(hello)}/${hello.reason}`)
check(ids(route('大家好')) === 'a,b,c', '「大家好」→ 全员')
check(ids(route('你好呀~')) === 'a,b,c', '「你好呀~」→ 全员（残留字符不影响判定）')
check(ids(route('早上好，在吗')) === 'a,b,c', '「早上好，在吗」→ 全员')
// A request one bot owns answers alone. ("代码/设计" are deliberately NOT used here: the role
// texts make several bots match those words, which is the "several" case below, not this one.)
check(ids(route('帮我画一张分镜稿')) === 'b', '任务性质的内容只叫该领域的 1 个', ids(route('帮我画一张分镜稿')))
check(ids(route('这个分镜都改一下')) === 'b',
  '「都」指的是东西不是人 → 仍然只叫绘画那一个', ids(route('这个分镜都改一下')))
// Several: two domains are named, neither collectively, and they tie — so both answer.
const several = route('前端和测试分头看一下')
check(ids(several) === 'a,c', '内容落在两个成员身上且势均力敌 → 两个都回', ids(several))

// 集体语气（对房间说的邀请）→ 全员
for (const text of ['大家看一下这个设计', '各位给点意见', '你们一起看看', '都来说说想法', '所有人各写一句']) {
  const d = route(text)
  check(ids(d) === 'a,b,c' && d.reason === 'all', `「${text}」→ 全员`, `${ids(d)}/${d.reason}`)
}
// 但显式点名优先于集体语气
const namedBeatsAll = route('让 小毕 给大家说一下')
check(ids(namedBeatsAll) === 'b', '点名 + 集体语气 → 听点名的（只叫 b）', ids(namedBeatsAll))

// ── 8. 兜底：内容不指向任何人时，leader 接管 ────────────────────────────────
const unclear = route('那个事怎么样了', { leaderId: 'a' })
check(ids(unclear) === 'a' && unclear.reason === 'leader', '内容啥也不指向 → leader 接管', `${ids(unclear)}/${unclear.reason}`)
const unclearNoLeader = route('那个事怎么样了')
check(unclearNoLeader.targets.length === 1, '没有 leader 时也只叫 join order 第一个成员', ids(unclearNoLeader))
const empty = routeMessage({ members: [], message: { text: '你好', mentions: [], mentionedIds: [] } })
check(empty.targets.length === 0, '空房间 → 没有人运行（不报错）', empty.reason)

// ── 8. 名字解析（给"拉人"这类跨成员指令用） ─────────────────────────────────
check(namedBotIdsIn('把 小毕 拉进群', MEMBERS.map(m => ({ id: m.id, name: m.name }))).join(',') === 'b',
  'namedBotIdsIn 认得写出名字的成员')
check(namedBotIdsIn('把 outsider 拉进群', [{ id: 'x', name: 'outsider' }]).join(',') === 'x',
  'namedBotIdsIn 也认得不在房间里的 Bot（拉人场景）')

console.log(`\n[routing] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
