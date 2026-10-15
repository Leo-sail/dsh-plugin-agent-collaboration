/**
 * Memory-store regression suite — the user's lifetime rules, on real files.
 *
 * The rules this file exists to keep:
 *   · clearing a room's messages does NOT clear its memory (the caller decides; the store is
 *     simply never told to delete anything there);
 *   · deleting a ROOM archives its partitions instead of deleting them;
 *   · deleting a BOT removes its own directory, and its GROUP partitions survive in `_archive/`;
 *   · nothing is silently dropped when a partition is full — the oldest move to an overflow file;
 *   · the global block lives inside a file the USER owns, and only the marked part is touched.
 *
 * Everything runs against a throwaway directory under the OS temp dir.
 *
 * Usage: node tests/memory-store.mjs
 */
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore, memoryPaths, parseRoomMemory, renderRoomMemory, withLearnedBlock, readLearnedLines,
  LEARNED_START, LEARNED_END,
} from '../packages/core/agent-community/src/memory-store.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const exists = async (p) => { try { await stat(p); return true } catch { return false } }

const root = await mkdtemp(join(tmpdir(), 'ac-memory-'))
const store = new MemoryStore(root)
const meta = (roomId, kind = 'group', name = '设计群') => ({ roomId, roomName: name, botId: 'botA', kind })
const entry = (at, text, runId) => ({ id: `e${at}`, kind: 'task', at, text, ...(runId ? { runId } : {}) })

// ── 1. 写入即落盘，读回一致 ──────────────────────────────────────────────────
const first = await store.append({ meta: meta('roomA'), entry: entry('2026-10-15T10:00:00.000Z', '任务：改首页 → 结果：改完了', 'r1'), maxEntries: 12, now: '2026-10-15T10:00:00.000Z' })
check(first.stored === true && await exists(first.path), 'append 真的写出文件', first.path)
const back = await store.read('roomA', 'botA')
check(back.length === 1 && back[0].text.includes('改首页'), '读回同一条')
check(back[0].runId === 'r1', 'runId 保留（证据链）')
const raw = await readFile(first.path, 'utf8')
check(raw.includes('只属于这个房间'), '文件里写明"只属于这个房间"')
check(raw.includes('kind: group') && raw.includes('room: roomA'), '文件头记录房间与类型')

// ── 2. 一个房间一个文件：互不干扰 ────────────────────────────────────────────
await store.append({ meta: meta('roomB', 'direct', '小艾'), entry: entry('2026-10-15T10:01:00.000Z', '任务：单聊的事 → 结果：done', 'r2'), maxEntries: 12, now: '2026-10-15T10:01:00.000Z' })
const a = await store.read('roomA', 'botA')
const b = await store.read('roomB', 'botA')
check(a.length === 1 && b.length === 1 && !JSON.stringify(a).includes('单聊的事') && !JSON.stringify(b).includes('改首页'),
  '两个房间各写各的文件，互不可见')

// ── 3. 外部编辑 → 缓存失效（人可以手改文件）────────────────────────────────
const pA = memoryPaths(root, 'botA', 'roomA').roomFile
const edited = renderRoomMemory(meta('roomA'), [entry('2026-10-15T10:00:00.000Z', '任务：用户手改过的内容 → 结果：x', 'r1')])
await writeFile(pA, edited, 'utf8')
const afterEdit = await store.read('roomA', 'botA')
check(afterEdit[0].text.includes('用户手改过'), '外部编辑后重新解析（缓存按 mtime/size 失效）')

// ── 4. 超限：旧条目移入 overflow，不删除 ─────────────────────────────────────
for (let i = 0; i < 5; i += 1) {
  await store.append({ meta: meta('roomA'), entry: entry(`2026-10-15T11:0${i}:00.000Z`, `任务：第 ${i} 件 → 结果：ok`, `r${i}`), maxEntries: 3, now: `2026-10-15T11:0${i}:00.000Z` })
}
const capped = await store.read('roomA', 'botA')
check(capped.length === 3, '分区被限制在 maxEntries', String(capped.length))
const overflow = await readFile(memoryPaths(root, 'botA', 'roomA').overflowFile, 'utf8')
check(overflow.includes('第 0 件') || overflow.includes('第 1 件'), '被挤出的旧条目进了 overflow（只移不删）')

// ── 5. 删房间：归档，源文件消失、归档存在 ────────────────────────────────────
const moved = await store.archiveRoom('roomB', ['botA'])
check(moved.length === 1 && await exists(moved[0]), '删房间 → 分区移到归档', moved[0])
check(!await exists(memoryPaths(root, 'botA', 'roomB').roomFile), '原分区文件已移走')
check((await store.read('roomB', 'botA')).length === 0, '归档后不再作为活分区被读到')
check(JSON.stringify(moved[0]).includes('_archive'), '归档路径在 _archive/ 下（不在 Bot 目录里）')

// ── 6. 删 Bot：两步走 —— 群分区先归档，目录再删 ──────────────────────────────
await store.append({ meta: meta('roomG'), entry: entry('2026-10-15T12:00:00.000Z', '任务：群里的事 → 结果：ok', 'r9'), maxEntries: 12, now: '2026-10-15T12:00:00.000Z' })
await store.archiveRoom('roomG', ['botA'])
await store.deleteBot('botA')
check(!await exists(memoryPaths(root, 'botA', 'x').botDir), 'Bot 自己的记忆目录被彻底删除')
check(await exists(memoryPaths(root, 'botA', 'roomG').archiveFile), '它在群里的分区仍在归档里（不被连带删除）')

// ── 7. 索引：派生、可重建 ────────────────────────────────────────────────────
const store2 = new MemoryStore(root)
await store2.append({ meta: { roomId: 'roomI', roomName: '索引群', botId: 'botZ', kind: 'group' }, entry: entry('2026-10-15T13:00:00.000Z', '任务：x → 结果：y', 'rz'), maxEntries: 12, now: '2026-10-15T13:00:00.000Z' })
const index = await readFile(memoryPaths(root, 'botZ', 'x').indexPath, 'utf8')
check(index.includes('roomI'), '索引列出该 Bot 的分区')
await rm(memoryPaths(root, 'botZ', 'x').indexPath)
await store2.rebuildIndex('botZ')
check((await readFile(memoryPaths(root, 'botZ', 'x').indexPath, 'utf8')).includes('roomI'), '索引删掉后可从正文重建')

// ── 8. 全局托管区：只碰标记之间，其余是用户的 ────────────────────────────────
const ws = join(root, 'workspace')
await mkdir(ws, { recursive: true })
await writeFile(join(ws, 'AGENTS.md'), '# 我的机器人\n\n用户自己写的规则，插件不许动。\n', 'utf8')
const r1 = await store2.appendLearned(ws, ['- [procedure] 当用户要求「X」时：做法 = Y'])
check(r1.stored && r1.added.length === 1, '首次晋升写入托管区')
const afterLearn = await readFile(join(ws, 'AGENTS.md'), 'utf8')
check(afterLearn.includes('用户自己写的规则，插件不许动。'), '用户原有内容原样保留')
check(afterLearn.includes(LEARNED_START) && afterLearn.includes(LEARNED_END), '托管区带起止标记')
const r2 = await store2.appendLearned(ws, ['- [procedure] 当用户要求「X」时：做法 = Y'])
check(r2.added.length === 0, '同一条不重复写')
const r3 = await store2.appendLearned(ws, ['- [lesson] 新的一条'])
check(r3.added.length === 1 && afterLearn.split(LEARNED_START).length === 2, '只保留一个托管区块')
const lines = readLearnedLines(await readFile(join(ws, 'AGENTS.md'), 'utf8'))
check(lines.length === 2, '块内两条', String(lines.length))

// 用户删掉标记 → 再次晋升只产生一个新块
await writeFile(join(ws, 'AGENTS.md'), '用户删掉了标记。\n', 'utf8')
await store2.appendLearned(ws, ['- [lesson] 重建'])
const rebuilt = await readFile(join(ws, 'AGENTS.md'), 'utf8')
check(rebuilt.split(LEARNED_START).length === 2, '标记被删后重新追加，且只有一个块')
check(rebuilt.includes('用户删掉了标记。'), '仍然不碰用户内容')

// ── 9. 纯渲染/解析：往返一致 ─────────────────────────────────────────────────
const roundTrip = parseRoomMemory(renderRoomMemory(meta('roomR'), [
  entry('2026-10-15T14:00:00.000Z', '任务：a → 结果：b', 'r1'),
  { id: 'n1', kind: 'note', at: '2026-10-15T14:01:00.000Z', text: '用户偏好：中文' },
]))
check(roundTrip.length === 2 && roundTrip[1].kind === 'note' && roundTrip[0].runId === 'r1', '渲染→解析往返一致')
check(withLearnedBlock('', ['- x']).startsWith(LEARNED_START), '空文件也能落块')

await rm(root, { recursive: true, force: true })
console.log(`\n[memory-store] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
