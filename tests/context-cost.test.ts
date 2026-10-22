/**
 * OP-15: per-section context cost (measured characters) + a clearly-labelled rough estimate.
 *
 * The module exists to answer "WHERE is this prompt big?" — memory/history usually dominate,
 * constraints/patterns are optional, role/input are cheap. These tests pin: contract-aligned
 * section names, code-point counting (CJK), share math, deterministic ordering, the token
 * estimate's boundaries, and that the persisted evidence only carries numbers (no prompt text).
 *
 * Run with: node --test tests/context-cost.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_SECTION_NAMES,
  estimateTokens,
  sectionStats,
  topCostSections,
} from '../packages/core/agent-community/src/context-cost.ts'
import { PROMPT_SECTION_ORDER } from '../packages/core/agent-community/src/prompt-contract.ts'
import { buildRunEvidence } from '../packages/core/agent-community/src/run-evidence.ts'
import { summarizeSnapshotRun } from '../packages/core/agent-community/src/snapshot-lite.ts'
import type { BotRun, RunEvidence } from '../packages/core/agent-community/src/types.ts'

// ── section names stay aligned with the prompt contract ────────────────────

test('measured section names are exactly the prompt contract order', () => {
  assert.deepEqual([...CONTEXT_SECTION_NAMES], [...PROMPT_SECTION_ORDER])
  for (const name of ['role', 'skills', 'goal', 'constraints', 'patterns', 'memory', 'history', 'input']) {
    assert.ok(CONTEXT_SECTION_NAMES.includes(name as never), name)
  }
})

// ── measurement ────────────────────────────────────────────────────────────

test('an empty prompt measures as empty', () => {
  assert.deepEqual(sectionStats({}), { chars: {}, totalChars: 0, shares: {} })
  assert.deepEqual(sectionStats({ role: '', memory: '' }).chars, {})
})

test('a single section is the whole prompt', () => {
  const stats = sectionStats({ input: '[本轮输入]\n你好' })
  assert.equal(stats.totalChars, [...'[本轮输入]\n你好'].length)
  assert.deepEqual(stats.chars, { input: [...'[本轮输入]\n你好'].length })
  assert.deepEqual(stats.shares, { input: 1 })
})

test('shares are per-section fractions that add up to one', () => {
  const stats = sectionStats({ role: 'R'.repeat(10), memory: 'M'.repeat(30), history: 'H'.repeat(60) })
  assert.equal(stats.totalChars, 100)
  assert.equal(stats.chars.role, 10)
  assert.equal(stats.shares.role, 0.1)
  assert.equal(stats.shares.memory, 0.3)
  assert.equal(stats.shares.history, 0.6)
  const sum = Object.values(stats.shares).reduce((total, share) => total + share, 0)
  assert.ok(Math.abs(sum - 1) < 0.001)
})

test('known sections keep contract order; unknown extras are appended alphabetically', () => {
  const stats = sectionStats({
    input: 'i',
    bExtra: 'bb',
    role: 'rr',
    aExtra: 'aa',
  })
  assert.deepEqual(Object.keys(stats.chars), ['role', 'input', 'aExtra', 'bExtra'])
})

test('CJK and emoji are counted by code point, not UTF-16 unit', () => {
  // "😀" is one code point but two UTF-16 units: a naive .length would overstate the cost.
  assert.equal(sectionStats({ input: '😀' }).totalChars, 1)
  assert.equal(sectionStats({ input: '你好世界' }).totalChars, 4)
})

// ── token estimate (heuristic, not precision) ─────────────────────────────

test('estimateTokens is bounded and monotonic, never negative', () => {
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(-10), 0)
  assert.equal(estimateTokens(Number.NaN), 0)
  assert.equal(estimateTokens(Number.POSITIVE_INFINITY), 0)
  assert.equal(estimateTokens(1), 1)
  assert.equal(estimateTokens(15), 10)
  assert.equal(estimateTokens(16), 11) // rounded up: the estimate is an upper-ish label
  let previous = 0
  for (const chars of [0, 1, 3, 10, 100, 1_000, 10_000]) {
    const tokens = estimateTokens(chars)
    assert.ok(tokens >= previous)
    previous = tokens
  }
})

// ── ranking ────────────────────────────────────────────────────────────────

test('topCostSections ranks the biggest sections first', () => {
  const stats = sectionStats({ role: 'r'.repeat(5), memory: 'm'.repeat(50), history: 'h'.repeat(20), input: 'i' })
  assert.deepEqual(topCostSections(stats).map(row => row.section), ['memory', 'history', 'role'])
  assert.equal(topCostSections(stats)[0]!.chars, 50)
  assert.equal(topCostSections(stats, 1).length, 1)
  assert.deepEqual(topCostSections(stats, 0), [])
  assert.deepEqual(topCostSections(stats, Number.NaN), [])
})

// ── persisted evidence: numbers only, never text ──────────────────────────

test('buildRunEvidence merges + normalizes contextSections', () => {
  const evidence = buildRunEvidence({
    promptChars: 120,
    contextSections: {
      memory: 80,
      role: 10,
      history: 30,
      empty: 0,
      broken: -5,
      nan: Number.NaN,
    },
    promptTokensEstimate: 80,
  })
  assert.deepEqual(evidence.contextSections, { history: 30, memory: 80, role: 10 })
  assert.equal(evidence.promptTokensEstimate, 80)
})

test('buildRunEvidence drops an empty/unusable contextSections record', () => {
  const evidence = buildRunEvidence({ contextSections: { memory: 0 } })
  assert.equal(evidence.contextSections, undefined)
})

test('the snapshot keeps the per-section numbers and cannot carry prompt text', () => {
  const TEST_EVIDENCE: RunEvidence = {
    promptChars: 200,
    contextSections: { memory: 120, history: 60, input: 20 },
    promptTokensEstimate: 134,
  }
  const run = {
    id: 'run-1', botId: 'bot-1', roomId: 'room-1', sessionId: 'sess-1', origin: 'user',
    prompt: '任务书'.repeat(1_000), status: 'completed', controlRevision: 1, attempt: 0, maxAttempts: 3,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:02.000Z',
    evidence: TEST_EVIDENCE,
  } as unknown as BotRun
  const lite = summarizeSnapshotRun(run)
  assert.deepEqual(lite.evidence?.contextSections, { memory: 120, history: 60, input: 20 })
  assert.equal(lite.evidence?.promptTokensEstimate, 134)
  const json = JSON.stringify(lite)
  assert.equal(json.includes('任务书'), false)
  assert.ok(json.length < 1_000)
})
