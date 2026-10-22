/**
 * Unit tests for the budgeted `[最近 N 条消息]` window (core/context-window.ts).
 *
 * Three behaviours are asserted, because three separate costs came from the old
 * "last N messages, verbatim" slice:
 *
 *  1. the turn's own input row must NOT be in the window (it is delivered again as
 *     `[本轮输入]`, so the model paid for the same sentence twice);
 *  2. the window has a byte budget and a per-row cap (one 10 KB reply must not take
 *     the whole block), and the caller is told it was truncated;
 *  3. when there is no input row to drop, the window is still the newest rows in
 *     order, up to `maxMessages`.
 *
 * Run with: node --test tests/context-window.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HISTORY_MESSAGES,
  buildHistoryWindow,
  utf8ByteLength,
  type HistoryWindowMessage,
} from '../packages/core/agent-community/src/context-window.ts'

const ISO = (n: number): string => new Date(Date.parse('2026-10-22T00:00:00.000Z') + n).toISOString()

function userMessage(id: string, text: string, n = 0): HistoryWindowMessage {
  return { id, text, senderKind: 'user', senderName: '老板', sequence: n }
}

function botMessage(id: string, text: string, n = 0): HistoryWindowMessage {
  return { id, text, senderKind: 'bot', senderName: '小董', sequence: n }
}

test('the turn input is excluded from the window, everything else is kept', () => {
  const messages: HistoryWindowMessage[] = [
    userMessage('m1', '帮我写一个方案', 1),
    botMessage('m2', '好的，先确认目标。', 2),
    userMessage('m3', '就按上次那个来', 3),
  ]
  const window = buildHistoryWindow(messages, { runPrompt: '就按上次那个来', maxMessages: 10 })
  assert.equal(window.text.includes('就按上次那个来'), false, 'input row must be dropped from the window')
  assert.equal(window.text.includes('帮我写一个方案'), true, 'older rows stay')
  assert.equal(window.text.includes('好的，先确认目标。'), true)
  assert.equal(window.included, 2)
  assert.equal(window.omitted, 0)
  assert.equal(window.truncated, false, 'dropping the duplicate input is not truncation')
})

test('the same rules exclude the input by id, even when its text was rewritten', () => {
  const messages: HistoryWindowMessage[] = [
    userMessage('m1', 'a', 1),
    userMessage('m2', 'model-facing copy that differs from the draft', 2),
  ]
  ;(messages[1] as { displayText?: string }).displayText = 'draft'
  const byId = buildHistoryWindow(messages, { runMessageId: 'm2' })
  assert.equal(byId.text.includes('model-facing copy'), false)
  assert.equal(byId.included, 1)
  // Without the id, a prompt match on the DISPLAY text still finds the row.
  const byPrompt = buildHistoryWindow(messages, { runPrompt: 'draft' })
  assert.equal(byPrompt.text.includes('model-facing copy'), false)
  assert.equal(byPrompt.included, 1)
})

test('the byte budget keeps the newest rows and reports the omission', () => {
  const big = 'x'.repeat(1_000)
  const messages: HistoryWindowMessage[] = Array.from({ length: 10 }, (_, i) =>
    botMessage(`m${i}`, `${i}-${big}`, i + 1))
  const window = buildHistoryWindow(messages, {
    maxMessages: 10,
    maxBytes: 2_500,
    perMessageChars: 1_500,
  })
  assert.equal(window.truncated, true)
  assert.ok(window.omitted > 0, 'older rows were dropped')
  assert.ok(window.included >= 2, 'at least the newest rows made it')
  assert.ok(utf8ByteLength(window.text) <= 2_500, `budget respected (got ${utf8ByteLength(window.text)})`)
  const lines = window.text.split('\n')
  assert.ok(lines[lines.length - 1]!.includes('9-'), 'the newest row is last')
  assert.ok(lines[0]!.includes('8-'), 'older rows come before it')
})

test('the per-message cap clips a single huge row instead of spending the budget on it', () => {
  const messages: HistoryWindowMessage[] = [
    botMessage('m1', 'short earlier', 1),
    botMessage('m2', 'y'.repeat(50_000), 2),
  ]
  const window = buildHistoryWindow(messages, { maxMessages: 10, perMessageChars: 500, maxBytes: 10_000 })
  assert.equal(window.truncated, true)
  assert.equal(window.included, 2)
  assert.ok(window.text.includes('已截断'), 'the clipped row is marked')
  assert.ok(utf8ByteLength(window.text) < 1_200, 'the huge row no longer dominates the block')
})

test('without an input row the newest maxMessages rows are kept, oldest first', () => {
  const messages: HistoryWindowMessage[] = Array.from({ length: 30 }, (_, i) =>
    userMessage(`m${i}`, `row ${i}`, i + 1)).map((m, i) => ({ ...m, senderKind: i % 2 === 0 ? 'user' : 'bot' }))
  const window = buildHistoryWindow(messages, { runPrompt: 'not present in the transcript' })
  const lines = window.text.split('\n')
  assert.equal(lines.length, DEFAULT_HISTORY_MESSAGES)
  assert.equal(window.included, DEFAULT_HISTORY_MESSAGES)
  assert.equal(window.omitted, 20)
  assert.equal(lines[0]!.includes('row 20'), true, 'oldest kept row first')
  assert.equal(lines[lines.length - 1]!.includes('row 29'), true, 'newest kept row last')
})

test('maxMessages 0 disables the block; empty input is empty', () => {
  const messages = [botMessage('m1', 'a', 1)]
  const disabled = buildHistoryWindow(messages, { maxMessages: 0 })
  assert.equal(disabled.text, '')
  assert.equal(disabled.included, 0)
  assert.equal(disabled.truncated, true)
  const empty = buildHistoryWindow([], { maxMessages: 10 })
  assert.equal(empty.text, '')
  assert.equal(empty.truncated, false)
})

test('utf8ByteLength counts CJK as 3 bytes and astral characters as 4', () => {
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中文'), 6)
  assert.equal(utf8ByteLength('😀'), 4)
})
