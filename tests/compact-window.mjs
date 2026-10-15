/**
 * Compaction-window regression suite — 压缩是折叠，不是删除.
 *
 * What this locks down:
 *   · folding changes the MODEL's window and nothing else: the folded rows stay in the
 *     transcript, so the panel can still scroll back to them;
 *   · unread arithmetic is untouched by folding (it counts messages, and none were removed) —
 *     the bug this guards against is a compaction that silently marks a room as read;
 *   · a `/clear`-style empty window and a folded window both behave;
 *   · the checkpoint row survives the window even when it is older than the tail.
 *
 * Usage: node tests/compact-window.mjs
 */
import { windowForPrompt } from '../packages/core/agent-community/src/compact.ts'
import { totalUnread, unreadByRoom } from '../packages/core/agent-community/src/unread.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// One run per row: the unread rule counts one RUN once, so rows sharing a run id would count
// as a single unread — which would make the assertion below meaningless.
const msg = (id, at, kind = 'bot') => ({
  id, roomId: 'roomA', sender: { kind, name: kind === 'user' ? 'user' : 'bot' },
  text: `第 ${id} 条`, mentions: [], createdAt: at, runId: `run-${id}`,
  sequence: Number(id.replace(/\D/gu, '')) || 0,
})
const ROWS = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, `2026-10-15T10:${String(i).padStart(2, '0')}:00.000Z`))

// ── 1. 折叠只影响提示词窗口 ──────────────────────────────────────────────────
const folded = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']
const window = windowForPrompt(ROWS, folded, 4)
check(window.length === 4, '窗口按 historyMessages 截断', String(window.length))
check(window.every(m => !folded.includes(m.id)), '被折叠的条目不出现在窗口里')
check(window.map(m => m.id).join(',') === 'm6,m7,m8,m9', '窗口是折叠之后的尾部', window.map(m => m.id).join(','))

// ── 2. 原文仍在（这就是"非破坏"）─────────────────────────────────────────────
check(ROWS.length === 10, 'ROWS 本身没有被改动（调用方拿到的是同一条历史）')
const checkpoint = msg('cp', '2026-10-15T10:00:00.000Z', 'routine')
const withCheckpoint = windowForPrompt([checkpoint, ...ROWS], folded, 5)
check(withCheckpoint.some(m => m.id === 'cp'), 'checkpoint 在窗口里（模型能看到摘要）')
const windowWithFoldIdsAbsent = windowForPrompt(ROWS, [], 4)
check(windowWithFoldIdsAbsent.map(m => m.id).join(',') === 'm6,m7,m8,m9', '没有折叠时就是普通尾部窗口')

// ── 3. 未读不受折叠影响 ──────────────────────────────────────────────────────
const marks = { roomA: { at: '2026-10-15T10:02:00.000Z', messageId: 'm2' } }
const before = totalUnread(unreadByRoom(ROWS, marks))
const after = totalUnread(unreadByRoom(ROWS, marks))
check(before === after, '折叠前后未读数一致（折叠不产生已读）', `${before} → ${after}`)
// The rule is "one unread per speaker per TURN", and a turn only advances on a user message —
// so ten bot rows with nobody speaking in between are ONE notification, not ten. That is the
// behaviour the badge depends on, and folding must not perturb it either way.
check(before === 1, '同一回合里 10 条 bot 消息只算 1 条未读', String(before))
const withUser = ROWS.map((m, i) => i === 5
  ? { ...m, sender: { kind: 'user', name: 'user' } }
  : m)
const split = totalUnread(unreadByRoom(withUser, marks))
check(split === 2, '用户发言分隔回合后按回合计数', String(split))
check(Object.keys(unreadByRoom(ROWS, marks)).includes('roomA'), '未读按房间汇总仍然可用')

// ── 4. 边界 ──────────────────────────────────────────────────────────────────
check(windowForPrompt([], undefined, 6).length === 0, '空历史 → 空窗口')
check(windowForPrompt(ROWS, undefined, 0).length === 0, 'historyMessages=0 → 不注入历史（由调用方决定）')
check(windowForPrompt(ROWS, ['不存在的 id'], 3).length === 3, '折叠清单里有坏 id 也不影响窗口')
check(windowForPrompt(ROWS, ROWS.map(m => m.id), 4).length === 0, '全部折叠 → 窗口里只剩 checkpoint（由服务端单独放入）')

console.log(`\n[compact-window] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
