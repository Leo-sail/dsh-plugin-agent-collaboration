/**
 * Unit tests for the OP-14 / diagnostics display helpers (pure: no DOM, no host).
 *
 * Covered:
 *   · reply snippets (whitespace collapse, clipping, empty message fallback);
 *   · thread labels (thread wins over a bare reply pointer);
 *   · what a send carries (replyTo always; threadId/taskId only when the target had them);
 *   · audit/drift/finish-gate notice classification, including the plain-notice fallthrough;
 *   · context-section ordering, percentages and label mapping.
 *
 * Run with: node --test tests/thread-view.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_SECTION_LABELS,
  contextSectionRows,
  noticeKindLabel,
  noticeKindOf,
  replyTargetFor,
  shortId,
  threadLabel,
  threadSendFields,
  threadSnippet,
} from '../packages/ui/ui-agent-community/src/client/conversation/threadView.ts'

// ── snippets & ids ──────────────────────────────────────────────────────────

test('a snippet flattens whitespace and clips with an ellipsis', () => {
  assert.equal(threadSnippet('  你好   世界 \n第二行 '), '你好 世界 第二行')
  assert.equal(threadSnippet('short'), 'short')
  assert.equal(threadSnippet(''), '')
  assert.equal(threadSnippet('   \n\t '), '')
  const clipped = threadSnippet('abcdefghij', 6)
  assert.equal(clipped, 'abcde…')
  assert.equal([...clipped].length, 6)
  assert.equal(threadSnippet('abcdef', 6), 'abcdef', 'exactly max is not clipped')
})

test('short ids fit a badge and survive an already-prefixed id', () => {
  assert.equal(shortId('abc123456'), 'abc123')
  assert.equal(shortId('abc'), 'abc')
  assert.equal(shortId('#abc123456'), 'abc123')
  assert.equal(shortId('abcdef', 3), 'abc')
})

// ── thread labels & reply target ────────────────────────────────────────────

test('a thread wins over a bare reply pointer in the badge label', () => {
  assert.equal(threadLabel('msg-1', 'th-9'), '#th-9')
  assert.equal(threadLabel('msg-1', undefined), '回复 msg-1')
  assert.equal(threadLabel(undefined, undefined), undefined)
  assert.equal(threadLabel('', ''), undefined)
})

test('the reply target carries the parent snippet and its thread/task linkage', () => {
  const target = replyTargetFor({ id: 'm-1', text: '请把 报告   发我', threadId: 't-1', taskId: 'task-1' })
  assert.equal(target.id, 'm-1')
  assert.equal(target.text, '请把 报告 发我')
  assert.equal(target.threadId, 't-1')
  assert.equal(target.taskId, 'task-1')
})

test('an empty parent still yields a usable reply target and send fields', () => {
  const target = replyTargetFor({ id: 'attachment-only-message', text: '' })
  assert.match(target.text, /^#attach/)
  assert.equal(target.threadId, undefined)
  const fields = threadSendFields(target)
  assert.equal(fields.replyTo, 'attachment-only-message')
  assert.equal('threadId' in fields, false)
  assert.equal('taskId' in fields, false)
})

test('send fields pass through the target linkage without inventing a thread', () => {
  assert.deepEqual(
    threadSendFields({ id: 'm-2', text: 'x', threadId: 't-2', taskId: 'task-2' }),
    { replyTo: 'm-2', threadId: 't-2', taskId: 'task-2' },
  )
  assert.deepEqual(threadSendFields({ id: 'm-3', text: 'x' }), { replyTo: 'm-3' })
  assert.deepEqual(
    threadSendFields({ id: 'm-4', text: 'x', threadId: '', taskId: '' }),
    { replyTo: 'm-4' },
  )
})

// ── notices ────────────────────────────────────────────────────────────────

test('audit, drift and finish-gate notices are classified from the host wording', () => {
  assert.equal(noticeKindOf('建议复盘：这一轮工具失败集中在文件权限'), 'audit')
  assert.equal(noticeKindOf('目标可能偏移：正在做的事和房间目标不一致'), 'drift')
  assert.equal(noticeKindOf('完成未通过证据门：缺少可验证的交付物'), 'finish-gate')
  assert.equal(noticeKindOf('证据门连续 2 轮未通过，已暂停自动续跑'), 'finish-gate')
  assert.equal(noticeKindOf('evidence gate BYPASSED for this run'), 'finish-gate')
})

test('an ordinary notice keeps the plain divider treatment', () => {
  for (const text of ['已邀请 小赵 加入群聊', '目标已暂停。', '', '   ']) {
    assert.equal(noticeKindOf(text), 'notice', text)
  }
})

test('only typed notices carry a label', () => {
  assert.equal(noticeKindLabel('audit'), '审计')
  assert.equal(noticeKindLabel('drift'), '目标')
  assert.equal(noticeKindLabel('finish-gate'), '完成门')
  assert.equal(noticeKindLabel('notice'), undefined)
})

// ── context sections ───────────────────────────────────────────────────────

test('context sections sort by size and report their share of the prompt', () => {
  const rows = contextSectionRows({ role: 100, skills: 300, input: 600 })
  assert.deepEqual(rows.map(row => row.key), ['input', 'skills', 'role'])
  assert.deepEqual(rows.map(row => row.label), ['输入', '技能', '角色'])
  assert.deepEqual(rows.map(row => row.chars), [600, 300, 100])
  assert.deepEqual(rows.map(row => row.ratio), [0.6, 0.3, 0.1])
})

test('unknown sections keep their key as the label; ties sort by key', () => {
  const rows = contextSectionRows({ zebra: 10, alpha: 10, mystery: 20 })
  assert.deepEqual(rows.map(row => row.label), ['mystery', 'alpha', 'zebra'])
  assert.equal(CONTEXT_SECTION_LABELS.memory, '记忆')
})

test('missing, empty and unusable sections yield no rows', () => {
  assert.deepEqual(contextSectionRows(undefined), [])
  assert.deepEqual(contextSectionRows({}), [])
  assert.deepEqual(contextSectionRows({ role: Number.NaN }), [])
  assert.deepEqual(contextSectionRows({ role: 0 }), [{ key: 'role', label: '角色', chars: 0, ratio: 0 }])
})

test('empty prompt sections produce a zero total instead of NaN ratios', () => {
  const rows = contextSectionRows({ role: 0, skills: 0 })
  assert.equal(rows.length, 2)
  for (const row of rows) assert.equal(row.ratio, 0)
})
