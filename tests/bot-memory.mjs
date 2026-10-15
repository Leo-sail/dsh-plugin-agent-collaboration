/**
 * Per-(room, bot) memory regression suite — the isolation rule, the caps, and the prompt block.
 *
 * The rule under test is the user's: a Bot carries what it did in a direct chat and in each group
 * it belongs to, and those memories never mix — 不能将单聊中的任务发到群聊内，也不能将群聊内的任务发到
 * 单聊中，也不能将A群聊的任务发到B群聊中. The structural half of that rule lives in `bot-memory.ts`:
 * every function takes the (roomId, botId) PAIR and there is no accessor that returns a bot's
 * memories across rooms, so no caller can mix them even by mistake.
 *
 * Usage: node tests/bot-memory.mjs
 */
import {
  clip, taskMemoryText, appendEntry, entriesFor, memoryFor, renderMemoryBlock,
  dropRoom, dropBot, dropBotFromRoom,
  DEFAULT_MAX_ENTRIES, MAX_ENTRY_CHARS,
} from '../packages/core/agent-community/src/bot-memory.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const DM = 'room-dm'
const GROUP_A = 'room-group-a'
const GROUP_B = 'room-group-b'
const BOT = 'bot-1'
const OTHER = 'bot-2'
const at = n => new Date(Date.UTC(2026, 9, 15, 11, 0, n)).toISOString()
const entry = (id, text, second) => ({ id, kind: 'task', text, at: at(second) })

// ── 1. text shaping ──────────────────────────────────────────────────────────
check(clip('  a   b  ', 20) === 'a b', 'clip 折叠空白')
check(clip('abcdef', 4) === 'abc…', 'clip 超长加省略号', clip('abcdef', 4))
check(taskMemoryText('[来自 X] 把报告写完', '写完了，见附件').startsWith('任务：把报告写完'),
  'taskMemoryText 去掉 [来自 X] 前缀，任务在前')
check(taskMemoryText('做件事', '结果').includes('→ 结果：结果'), 'taskMemoryText 带上结果')
check(taskMemoryText('x'.repeat(500), 'y'.repeat(500)).length <= MAX_ENTRY_CHARS,
  '单条记忆不超过上限', String(taskMemoryText('x'.repeat(500), 'y'.repeat(500)).length))

// ── 2. one partition per (room, bot) ─────────────────────────────────────────
let records = []
records = appendEntry({ records, roomId: DM, botId: BOT, entry: entry('e1', '任务：单聊里的事', 1), now: at(1) })
records = appendEntry({ records, roomId: GROUP_A, botId: BOT, entry: entry('e2', '任务：A 群里的事', 2), now: at(2) })
records = appendEntry({ records, roomId: GROUP_B, botId: BOT, entry: entry('e3', '任务：B 群里的事', 3), now: at(3) })
records = appendEntry({ records, roomId: GROUP_A, botId: OTHER, entry: entry('e4', '任务：别人的事', 4), now: at(4) })

check(records.length === 4, '每个 (房间, Bot) 一对，各自一条记录', `records=${records.length}`)
check(entriesFor(records, DM, BOT).length === 1 && entriesFor(records, DM, BOT)[0].text === '任务：单聊里的事',
  '单聊分区只含单聊的事')
check(entriesFor(records, GROUP_A, BOT)[0].text === '任务：A 群里的事', 'A 群分区只含 A 群的事')
check(entriesFor(records, GROUP_B, BOT)[0].text === '任务：B 群里的事', 'B 群分区只含 B 群的事')
check(entriesFor(records, GROUP_A, OTHER)[0].text === '任务：别人的事', '同一群里不同 Bot 的记忆也分开')
check(!JSON.stringify(entriesFor(records, GROUP_B, BOT)).includes('A 群'), 'B 群里看不到 A 群的内容')
check(!JSON.stringify(entriesFor(records, DM, BOT)).includes('群'), '单聊里看不到任何群的内容')
check(entriesFor(records, 'no-such-room', BOT).length === 0, '没有记录的 (房间, Bot) 为空')

const beforeA = memoryFor(records, GROUP_A, BOT)
const afterOtherWrite = appendEntry({ records, roomId: DM, botId: BOT, entry: entry('e5', '再记一条', 5), now: at(5) })
check(memoryFor(afterOtherWrite, GROUP_A, BOT) === beforeA,
  '写一个分区不会重建另一个分区的对象（两个房间并发时互不影响）')

// ── 3. caps and trimming ─────────────────────────────────────────────────────
let many = []
for (let i = 0; i < DEFAULT_MAX_ENTRIES + 5; i += 1) {
  many = appendEntry({ records: many, roomId: DM, botId: BOT, entry: entry(`m${i}`, `第 ${i} 条`, i), now: at(i) })
}
const kept = entriesFor(many, DM, BOT)
check(kept.length === DEFAULT_MAX_ENTRIES, `每分区最多 ${DEFAULT_MAX_ENTRIES} 条`, `kept=${kept.length}`)
check(kept[kept.length - 1].text === `第 ${DEFAULT_MAX_ENTRIES + 4} 条`, '保留最新的一条')
check(!kept.some(e => e.text === '第 0 条'), '最旧的被丢掉')
check(appendEntry({ records: many, roomId: DM, botId: BOT, entry: entry('long', 'x'.repeat(900), 99), now: at(99) })
  .find(r => r.roomId === DM && r.botId === BOT).entries.at(-1).text.length <= MAX_ENTRY_CHARS,
'写入时超长内容被裁剪')

// ── 4. the prompt block ──────────────────────────────────────────────────────
const block = renderMemoryBlock(entriesFor(records, GROUP_A, BOT))
check(block !== undefined && block.startsWith('[本房间记忆]'), '渲染出 [本房间记忆] 块')
check(block.includes('只属于这个房间'), '块里写明"只属于这个房间"')
check(block.includes('A 群里的事') && !block.includes('B 群里的事'), '块里只有本房间的内容')
check(renderMemoryBlock([]) === undefined, '没有记忆就不渲染（不发空块）')

const long = Array.from({ length: 20 }, (_, i) => ({ text: `第 ${i} 条 ${'内'.repeat(120)}`, at: at(i) }))
const budgeted = renderMemoryBlock(long, { limit: 8, budget: 600 })
check(budgeted.split('\n').length - 2 <= 8, '条数受 limit 限制', String(budgeted.split('\n').length - 2))
check(budgeted.length < 900, '总长度受预算限制', String(budgeted.length))
check(budgeted.includes('第 19 条'), '预算不足时先保留最新的')
check(!budgeted.includes('第 0 条'), '最旧的先被挤掉')
const limited = renderMemoryBlock(long, { limit: 3, budget: 10_000 })
check(limited.split('\n').length - 2 === 3, 'limit=3 时只渲染 3 条')
check(limited.includes('第 17 条') && limited.includes('第 19 条'), '渲染的是最近三条')

// ── 5. lifecycle ─────────────────────────────────────────────────────────────
check(dropRoom(records, GROUP_A).every(r => r.roomId !== GROUP_A), '删房间 → 清掉该房间的全部分区')
check(dropRoom(records, GROUP_A).length === 2, '删 A 群不影响单聊与 B 群')
check(dropBot(records, BOT).every(r => r.botId !== BOT), '删 Bot → 清掉它在所有房间的分区')
check(dropBot(records, BOT).length === 1, '删 Bot 后只留下别的 Bot 的分区')
const kicked = dropBotFromRoom(records, GROUP_A, new Set([BOT]))
check(kicked.every(r => !(r.roomId === GROUP_A && r.botId === BOT)), '踢人 → 只清该房间该 Bot 的分区')
check(kicked.some(r => r.roomId === GROUP_A && r.botId === OTHER), '同群其他成员的分区保留')
check(kicked.some(r => r.roomId === GROUP_B && r.botId === BOT), '同一 Bot 在别的群的记忆保留')

console.log(`\n[bot-memory] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
