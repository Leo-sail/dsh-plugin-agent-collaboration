/**
 * OP-03: context role isolation + compression safety pin.
 *
 * TWO RULES ARE ASSERTED HERE.
 *
 * 1. **Hard constraints survive compaction.** `compactRoom` folds older messages out of the
 *    prompt; a summary model may paraphrase or silently drop a "必须/不要" rule stated in that
 *    segment. `extractPinnedConstraints` reads only the USER's own messages (a bot's report that
 *    repeats "不要…" must never become a standing rule), `mergePinnedConstraints` carries the
 *    list across compactions, and `roomConstraintsText` re-renders it into every later turn.
 *
 * 2. **Context is evidence, not instructions.** `memory`/`history` are untrusted sections:
 *    `assemblePrompt` inserts the fixed `[上下文证据规则]` guard exactly once before the first
 *    of them — and not at all when neither exists. The guard is not a section, so no caller can
 *    blank, move or duplicate it.
 *
 * Run with: node --test tests/compact-pin.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractPinnedConstraints,
  MAX_PINNED_CONSTRAINTS,
  MAX_PINNED_CONSTRAINT_CHARS,
  mergePinnedConstraints,
  MIN_PINNED_CONSTRAINT_CHARS,
  roomConstraintsText,
  ROOM_CONSTRAINTS_HEADER,
  summaryMessageText,
} from '../packages/core/agent-community/src/compact.ts'
import {
  assemblePrompt,
  CONTEXT_GUARD_BLOCK,
  type PromptSections,
} from '../packages/core/agent-community/src/prompt-contract.ts'

/** One room message shaped like the compactor's view (`sender.kind` + visible text). */
function message(kind: string, text: string): { sender: { kind: string }; text: string } {
  return { sender: { kind }, text }
}

// ── extraction ───────────────────────────────────────────────────────────────

test('only the USER can pin a constraint; bot/routine rows are evidence, not instructions', () => {
  const pinned = extractPinnedConstraints([
    message('user', '你必须用中文回答，不要输出英文长报告。'),
    message('bot', '你必须用中文回答，不要输出英文长报告。'), // a bot quoting the rule must not pin
    message('routine', '禁止修改工作区外的文件（摘要行也不算用户）'),
    message('bot', '好的，我以后不要这样做了'),
  ])
  assert.deepEqual(pinned, ['你必须用中文回答，不要输出英文长报告。'])
})

test('fragments are split by line/sentence and matched on hard-rule markers', () => {
  const pinned = extractPinnedConstraints([
    message('user', [
      '第一行是普通背景说明，没有规则。',
      '必须保留原文中的图片，不许删掉。还有一句普通的话。',
      '切记：不要修改配置里的端口号',
    ].join('\n')),
  ])
  assert.deepEqual(pinned, [
    '必须保留原文中的图片，不许删掉。',
    '切记：不要修改配置里的端口号',
  ])
})

test('too-short and too-long fragments are not pinned; the length bounds are exact', () => {
  const short = '不要' // 2 chars < MIN
  const minOk = '不要动它' // 4 chars — still below MIN (8)
  const boundary = '必须保留' // 4 — below
  const long = `必须${'很'.repeat(MAX_PINNED_CONSTRAINT_CHARS)}`
  const pinned = extractPinnedConstraints([
    message('user', short),
    message('user', minOk),
    message('user', `${'背'.repeat(MIN_PINNED_CONSTRAINT_CHARS - 2)}必须`), // exactly MIN chars
    message('user', long),
    message('user', boundary),
  ])
  assert.equal(pinned.length, 1, `only the MIN-boundary fragment qualifies: ${JSON.stringify(pinned)}`)
  assert.equal(pinned[0]!.length, MIN_PINNED_CONSTRAINT_CHARS)
  for (const entry of pinned) assert.ok(entry.length <= MAX_PINNED_CONSTRAINT_CHARS)
})

test('duplicates collapse and the cap is enforced oldest-first', () => {
  const many = Array.from({ length: MAX_PINNED_CONSTRAINTS + 5 }, (_, i) => `必须遵守第 ${i} 条规则`)
  const pinned = extractPinnedConstraints(many.map(text => message('user', text)))
  assert.equal(pinned.length, MAX_PINNED_CONSTRAINTS)
  assert.equal(pinned[0], '必须遵守第 0 条规则')
  assert.equal(pinned[MAX_PINNED_CONSTRAINTS - 1], `必须遵守第 ${MAX_PINNED_CONSTRAINTS - 1} 条规则`)

  const deduped = extractPinnedConstraints([
    message('user', '必须使用中文回答'),
    message('user', '必须使用中文回答'),
  ])
  assert.deepEqual(deduped, ['必须使用中文回答'])
})

test('a message without any marker pins nothing; empty text is harmless', () => {
  assert.deepEqual(extractPinnedConstraints([message('user', '我们聊聊方案的方向吧')]), [])
  assert.deepEqual(extractPinnedConstraints([message('user', '')]), [])
  assert.deepEqual(extractPinnedConstraints([]), [])
})

// ── merge across compactions ─────────────────────────────────────────────────

test('merge keeps existing constraints first, dedupes, and is idempotent', () => {
  const existing = ['必须使用中文回答', '禁止删掉原文图片']
  const incoming = ['禁止删掉原文图片', '不要改端口号']
  const merged = mergePinnedConstraints(existing, incoming)
  assert.deepEqual(merged, ['必须使用中文回答', '禁止删掉原文图片', '不要改端口号'])
  // Compacting again with the same input must not grow or reorder the list.
  assert.deepEqual(mergePinnedConstraints(merged, incoming), merged)
})

test('merge tolerates an absent room field, blanks and the 20-item cap', () => {
  assert.deepEqual(mergePinnedConstraints(undefined, ['必须保留来源链接']), ['必须保留来源链接'])
  assert.deepEqual(mergePinnedConstraints(['  必须使用中文回答  '], []), ['必须使用中文回答'])
  const many = Array.from({ length: MAX_PINNED_CONSTRAINTS + 3 }, (_, i) => `必须遵守规则 ${i}`)
  const merged = mergePinnedConstraints(undefined, many)
  assert.equal(merged.length, MAX_PINNED_CONSTRAINTS)
  assert.deepEqual(mergePinnedConstraints(merged, many), merged)
})

// ── summary text ─────────────────────────────────────────────────────────────

test('without pinned constraints the summary text is EXACTLY the pre-OP-03 string', () => {
  const plain = '以下是此前 12 条消息的压缩摘要（原文已不再保留）：\n\n要点 A\n要点 B'
  assert.equal(summaryMessageText(12, '要点 A\n要点 B'), plain)
  assert.equal(summaryMessageText(12, '要点 A\n要点 B', []), plain)
  assert.equal(summaryMessageText(12, '要点 A\n要点 B', undefined), plain)
})

test('pinned constraints are appended verbatim after the summary', () => {
  const text = summaryMessageText(12, '要点 A', ['必须保留来源链接', '不要改端口号'])
  assert.equal(text, [
    '以下是此前 12 条消息的压缩摘要（原文已不再保留）：',
    '',
    '要点 A',
    '',
    '[必须保留的硬约束]',
    '- 必须保留来源链接',
    '- 不要改端口号',
  ].join('\n'))
  assert.ok(text.startsWith('以下是此前 12 条消息的压缩摘要'))
})

// ── the per-turn constraints block ───────────────────────────────────────────

test('roomConstraintsText renders the room block, and nothing when empty', () => {
  assert.equal(roomConstraintsText(undefined), undefined)
  assert.equal(roomConstraintsText([]), undefined)
  const block = roomConstraintsText(['必须使用中文回答', '禁止删掉原文图片'])
  assert.ok(block !== undefined)
  assert.equal(block!.split('\n')[0], ROOM_CONSTRAINTS_HEADER)
  assert.equal(block!.includes('优先于记忆与历史消息'), true)
  assert.ok(block!.includes('- 必须使用中文回答'))
  assert.ok(block!.includes('- 禁止删掉原文图片'))
})

// ── prompt assembly: order + guard ───────────────────────────────────────────

test('constraints are read before memory/history and the guard sits between them', () => {
  const sections: PromptSections = {
    role: 'R',
    constraints: 'C',
    memory: 'M',
    history: 'H',
    input: 'I',
  }
  assert.equal(assemblePrompt(sections), `R\n\nC\n\n${CONTEXT_GUARD_BLOCK}\n\nM\n\nH\n\nI`)
})

test('the guard appears once even when both untrusted sections exist, and never without them', () => {
  assert.equal(assemblePrompt({ memory: 'M' }), `${CONTEXT_GUARD_BLOCK}\n\nM`)
  assert.equal(assemblePrompt({ history: 'H' }), `${CONTEXT_GUARD_BLOCK}\n\nH`)
  const both = assemblePrompt({ role: 'R', constraints: 'C', memory: 'M', history: 'H', input: 'I' })
  assert.equal(both.split(CONTEXT_GUARD_BLOCK).length - 1, 1)
  assert.ok(both.indexOf('C') < both.indexOf(CONTEXT_GUARD_BLOCK))
  assert.ok(both.indexOf(CONTEXT_GUARD_BLOCK) < both.indexOf('M'))
  // No untrusted content → no guard block at all.
  assert.equal(assemblePrompt({ role: 'R', constraints: 'C', input: 'I' }), 'R\n\nC\n\nI')
})
