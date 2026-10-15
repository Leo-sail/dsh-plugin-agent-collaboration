/**
 * Promotion regression suite — the two channels, and the user's definition of 有效经验.
 *
 * Repetition: the same request handled successfully twice → remember how it is done.
 * Correction: something kept going wrong, the user pushed back (and ideally said what to do
 * instead), and then it was done right → remember BOTH halves. The user's words:
 * 「一直犯错，被用户反复提醒，然后经过用户干预后做对了，这个就是有效经验」.
 *
 * Usage: node tests/memory-promote.mjs
 */
import {
  scanPromotions, signatureOf, similarity, isCorrection, isIntervention, SIMILARITY_THRESHOLD,
} from '../packages/core/agent-community/src/memory-promote.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const user = (at, text) => ({ id: `u${at}`, roomId: 'r', sender: { kind: 'user', name: 'user' }, text, mentions: [], createdAt: at })
const task = (at, text, runId) => ({ id: `t${at}`, kind: 'task', at, text, runId })
const note = (at, text) => ({ id: `n${at}`, kind: 'note', at, text })

// ── 1. 相似度与签名 ──────────────────────────────────────────────────────────
check(signatureOf('任务：把配置超时改成 30s → 结果：done') === '把配置超时改成30s', '签名去掉框架与结果', signatureOf('任务：把配置超时改成 30s → 结果：done'))
check(similarity('把超时改成30s', '把超时改成30s') === 1, '完全相同 → 1')
check(similarity('把配置超时改成30s', '把配置里的超时改成 30s') >= SIMILARITY_THRESHOLD, '措辞略有出入 → 判为同一件事',
  similarity('把配置超时改成30s', '把配置里的超时改成 30s').toFixed(2))
check(similarity('改超时', '写周报') < 0.3, '不同的事 → 低相似度')
check(isCorrection('不对，别改常量') && !isCorrection('好的谢谢'), '纠正词识别')
check(isIntervention('应该改成配置文件里的字段') && !isIntervention('不对'), '干预（说了怎么做）与单纯否定区分')

// ── 2. A 通道：重复成功 → procedure ─────────────────────────────────────────
const repeat = scanPromotions({
  entries: [
    task('2026-10-15T10:00:00.000Z', '任务：把超时改成30s → 结果：改好了，测试通过', 'r1'),
    task('2026-10-15T11:00:00.000Z', '任务：把配置里的超时改成 30s → 结果：完成，pnpm test 通过', 'r2'),
  ],
  messages: [user('2026-10-15T10:30:00.000Z', '好，谢谢')],
  alreadyLearned: [],
})
check(repeat.length === 1 && repeat[0].kind === 'procedure', '同请求两次成功 → procedure', JSON.stringify(repeat.map(c => c.kind)))
check(repeat[0].line.includes('r1') && repeat[0].line.includes('r2'), '带上两次的 run 证据')
check(repeat[0].strong === true, '有 run 支撑 → 强证据（可进全局记忆）')

// ── 3. A 通道：中间被纠正过 → 第一次不算"正确做法" ──────────────────────────
const correctedRepeat = scanPromotions({
  entries: [
    task('2026-10-15T10:00:00.000Z', '任务：把超时改成30s → 结果：改了常量', 'r1'),
    task('2026-10-15T11:00:00.000Z', '任务：把超时改成30s → 结果：改好了', 'r2'),
  ],
  messages: [user('2026-10-15T10:30:00.000Z', '不对，别改常量')],
  alreadyLearned: [],
})
check(correctedRepeat.filter(c => c.kind === 'procedure').length === 0,
  '两次成功之间用户纠正过 → 不当作 procedure 晋升（应走纠错通道）')

// ── 4. B 通道：反复犯错 → 用户干预 → 做对 = lesson（负例+正例）──────────────
const lesson = scanPromotions({
  entries: [
    task('2026-10-15T10:00:00.000Z', '任务：改配置超时 → 结果：直接改了代码常量并重启', 'r1'),
    task('2026-10-15T10:20:00.000Z', '任务：改配置超时 → 结果：又改了常量', 'r2'),
    task('2026-10-15T10:40:00.000Z', '任务：改配置超时 → 结果：改了 src/config.ts 的 timeout 字段，pnpm test 通过', 'r3'),
  ],
  messages: [
    user('2026-10-15T10:10:00.000Z', '不对，别改常量'),
    user('2026-10-15T10:30:00.000Z', '还是不对，应该改成配置文件里的字段'),
  ],
  alreadyLearned: [],
})
check(lesson.length === 1 && lesson[0].kind === 'lesson', '纠错链 → lesson', JSON.stringify(lesson.map(c => c.kind)))
check(lesson[0].line.includes('✗'), 'lesson 写负例（不要做什么）')
check(lesson[0].line.includes('✓'), 'lesson 写正例（正确做法）')
check(lesson[0].line.includes('r1') && lesson[0].line.includes('r3'), '证据链覆盖错误与做对两次 run')
check(lesson[0].strong === true, '纠错链是强证据')

// ── 5. 单次否定且没说怎么做 → 还不够（不到"反复提醒"）──────────────────────
const weak = scanPromotions({
  entries: [
    task('2026-10-15T10:00:00.000Z', '任务：改超时 → 结果：改了常量', 'r1'),
    task('2026-10-15T10:20:00.000Z', '任务：改超时 → 结果：改了字段', 'r2'),
  ],
  messages: [user('2026-10-15T10:10:00.000Z', '不对')],
  alreadyLearned: [],
})
check(weak.filter(c => c.kind === 'lesson').length === 0, '单次"不对"且未说明做法 → 先不晋升')

// ── 6. 做法没变 → 没学到东西 ─────────────────────────────────────────────────
const same = scanPromotions({
  entries: [
    task('2026-10-15T10:00:00.000Z', '任务：改超时 → 结果：改了常量', 'r1'),
    task('2026-10-15T10:20:00.000Z', '任务：改超时 → 结果：改了常量', 'r2'),
  ],
  messages: [
    user('2026-10-15T10:10:00.000Z', '不对，应该改配置文件'),
    user('2026-10-15T10:15:00.000Z', '还是不对，应该改配置文件'),
  ],
  alreadyLearned: [],
})
check(same.filter(c => c.kind === 'lesson').length === 0, '干预前后的做法一样 → 没学到东西，不晋升')

// ── 7. 去重与弱证据 ──────────────────────────────────────────────────────────
const line = lesson[0].line
const dup = scanPromotions({
  entries: [
    task('2026-10-15T10:00:00.000Z', '任务：改配置超时 → 结果：直接改了代码常量并重启', 'r1'),
    task('2026-10-15T10:40:00.000Z', '任务：改配置超时 → 结果：改了 src/config.ts 的 timeout 字段，pnpm test 通过', 'r3'),
  ],
  messages: [user('2026-10-15T10:30:00.000Z', '还是不对，应该改成配置文件里的字段')],
  alreadyLearned: [line],
})
check(dup.length === 0, '已经在托管区里的条目不再晋升（去重）')
const noRun = scanPromotions({
  entries: [note('2026-10-15T10:00:00.000Z', '我觉得用户可能想改超时')],
  messages: [],
  alreadyLearned: [],
})
check(noRun.length === 0, '没有 run 的自述不产生任何晋升（弱证据）')

console.log(`\n[memory-promote] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
