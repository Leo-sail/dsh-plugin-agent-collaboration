/**
 * OP-13: goal drift watchdog — deterministic, advisory-only.
 *
 * The watchdog answers ONE question: does a settled reply still look like it is about the
 * room's active goal? It uses goal-keyword coverage plus explicit redirect phrases, never a
 * model, and it never acts (no pause, no cancel) — the service turns a level into at most one
 * visible notice per room per ten minutes.
 *
 * Run with: node --test tests/goal-drift.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assessGoalDrift,
  GOAL_DRIFT_DRIFT_SCORE,
  GOAL_DRIFT_MIN_REPLY_CHARS,
  GOAL_DRIFT_WATCH_SCORE,
  goalKeywords,
  offTopicPhrases,
} from '../packages/core/agent-community/src/goal-drift.ts'

const GOAL = '把 Bots 插件稳定性方案写完并输出文档'

/** A long, on-goal answer (covers most keywords). */
const ON_GOAL = '这份 Bots 插件稳定性方案我已经写完，文档输出在 out/stability.md，包含三类问题的修复与验证结果，稍后可以 review。'
/** A long answer that abandons the goal explicitly. */
const OFF_TOPIC = '今天天气不错，我们先不管那个方案了，换个方向，重新做一个美食账号内容规划，另外再看一下别的事情。'
/** Long, about a different subject, no explicit redirect words. */
const TANGENT = '我查了一些资料，发现这个话题很有意思，可以从历史背景讲起，再介绍几个代表人物和观点，最后给出一些启发。'
/** Long enough, half-related: only a few goal keywords appear. */
const PARTIAL = '今天先看了 Bots 和插件相关的资料，方案和文档的部分还没有动，其他内容等有空再说。'

// ── inputs that must never be called drift ─────────────────────────────────

test('no active goal is never drift', () => {
  assert.deepEqual(assessGoalDrift({ goalText: '', replyText: OFF_TOPIC }), {
    level: 'none',
    score: 0,
    reason: '没有活跃目标',
  })
  assert.equal(assessGoalDrift({ replyText: OFF_TOPIC }).level, 'none')
})

test('a short reply is not judged at all', () => {
  const short = '好的'
  assert.ok([...short].length < GOAL_DRIFT_MIN_REPLY_CHARS)
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: short })
  assert.equal(assessment.level, 'none')
  assert.equal(assessment.score, 0)
  assert.match(assessment.reason, /回复过短/u)
})

test('a goal without extractable keywords cannot be called drift', () => {
  const assessment = assessGoalDrift({ goalText: '好的', replyText: OFF_TOPIC })
  assert.equal(assessment.level, 'none')
  assert.match(assessment.reason, /无法提取关键词/u)
})

// ── the three levels ───────────────────────────────────────────────────────

test('an on-goal answer is none', () => {
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: ON_GOAL })
  assert.equal(assessment.level, 'none')
  assert.ok(assessment.score < GOAL_DRIFT_WATCH_SCORE)
  assert.match(assessment.reason, /目标关键词覆盖/u)
})

test('a partly-related answer lands in watch', () => {
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: PARTIAL })
  assert.equal(assessment.level, 'watch')
  assert.ok(assessment.score >= GOAL_DRIFT_WATCH_SCORE)
  assert.ok(assessment.score < GOAL_DRIFT_DRIFT_SCORE)
})

test('an unrelated answer with redirect phrases is drift', () => {
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: OFF_TOPIC })
  assert.equal(assessment.level, 'drift')
  assert.ok(assessment.score >= GOAL_DRIFT_DRIFT_SCORE)
  assert.match(assessment.reason, /偏题表述/u)
})

test('a long tangent with zero keyword coverage is drift even without redirect words', () => {
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: TANGENT })
  assert.equal(assessment.level, 'drift')
  assert.equal(assessment.score, 70) // (1 - 0) * 70
})

test('a redirect phrase alone is at least watch, even when coverage is high', () => {
  // Coverage is good, but "另外" explicitly opens a different subject: warn, don't cry drift.
  const reply = `${ON_GOAL}另外再说一下别的事情，明天再补。`
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: reply })
  assert.equal(assessment.level, 'watch')
  assert.match(assessment.reason, /另外/u)
})

// ── determinism / explainability ───────────────────────────────────────────

test('the same input yields the same assessment', () => {
  const input = { goalText: GOAL, replyText: PARTIAL, userTexts: ['继续', '再加点内容'] }
  assert.deepEqual(assessGoalDrift(input), assessGoalDrift(input))
})

test('userTexts are accepted for context but never override the reply judgement', () => {
  const without = assessGoalDrift({ goalText: GOAL, replyText: ON_GOAL })
  const withTexts = assessGoalDrift({ goalText: GOAL, replyText: ON_GOAL, userTexts: [OFF_TOPIC, OFF_TOPIC] })
  assert.deepEqual(withTexts, without)
})

test('the reason names the coverage and the score', () => {
  const assessment = assessGoalDrift({ goalText: GOAL, replyText: TANGENT })
  assert.match(assessment.reason, /目标关键词覆盖 0\/\d+/u)
  assert.match(assessment.reason, new RegExp(`分数 ${assessment.score}`, 'u'))
})

// ── keyword extraction / phrase detection ──────────────────────────────────

test('goalKeywords extracts latin words and CJK bigrams, skipping filler', () => {
  const keywords = goalKeywords(GOAL)
  assert.ok(keywords.includes('bots'))
  assert.ok(keywords.includes('插件'))
  assert.ok(keywords.includes('方案'))
  // Filler-only bigrams are dropped ("的" etc. are stop characters).
  assert.equal(keywords.some(keyword => /的/u.test(keyword) && keyword.length === 2), false)
  // First-seen order + bounded list.
  assert.deepEqual(keywords, [...new Set(keywords)])
  assert.ok(keywords.length <= 24)
})

test('goalKeywords is empty for a filler-only goal', () => {
  assert.deepEqual(goalKeywords('好的，就这样'), [])
})

test('offTopicPhrases reports unique explicit redirects', () => {
  // The longer phrase wins: "换个话题" is reported, not also its parent "换个".
  assert.deepEqual(offTopicPhrases('先不管这个，换个话题，另外再说'), ['换个话题', '先不管', '另外'])
  assert.deepEqual(offTopicPhrases('一切正常，继续推进'), [])
})
