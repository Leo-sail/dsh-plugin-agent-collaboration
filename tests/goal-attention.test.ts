/**
 * Unit tests for OP-19 goal-aware attention ordering.
 *
 * Covered: empty input, no goal / unusable goal / no overlap (all keep the original order),
 * keyword and bigram coverage ranking, the recency tie-break, the limit, and input immutability.
 *
 * Run with: node --test tests/goal-attention.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalTerms, rankByGoal } from '../packages/core/agent-community/src/goal-attention.ts'

const indexes = (ranked: ReadonlyArray<{ index: number }>): number[] => ranked.map(item => item.index)

test('no texts means no ranking', () => {
  assert.deepEqual(rankByGoal([], '做一份报告'), [])
})

test('without a goal the original order is kept with zero scores', () => {
  const texts = ['第一条', '第二条', '第三条']
  const ranked = rankByGoal(texts, undefined)
  assert.deepEqual(indexes(ranked), [0, 1, 2])
  for (const item of ranked) assert.equal(item.score, 0)
  // A blank goal is the same as none.
  assert.deepEqual(indexes(rankByGoal(texts, '   ')), [0, 1, 2])
})

test('a goal with no usable terms (or no overlap) does not reorder', () => {
  const texts = ['甲', '乙', '丙']
  assert.deepEqual(goalTerms('好的'), [])
  assert.deepEqual(indexes(rankByGoal(texts, '好的')), [0, 1, 2])
  assert.deepEqual(indexes(rankByGoal(texts, '数据可视化报告')), [0, 1, 2], 'nothing matches')
})

test('reports covering more of the goal rank first', () => {
  const texts = [
    '顺便聊一下天气',
    '数据报告已经写完',
    '数据可视化部分还需要图表',
  ]
  const ranked = rankByGoal(texts, '完成数据可视化报告')
  assert.deepEqual(indexes(ranked), [2, 1, 0])
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0))
})

test('CJK bigrams let a reordered wording match', () => {
  const texts = ['优化一下首页的排版', '给按钮换个颜色']
  const ranked = rankByGoal(texts, '首页优化')
  assert.deepEqual(indexes(ranked), [0, 1])
  const terms = goalTerms('首页优化')
  assert.ok(terms.includes('首页'))
  assert.ok(terms.includes('优化'))
})

test('equal coverage is broken by recency: the later report comes first', () => {
  const texts = ['数据报告 A', '数据报告 B', '无关的话']
  const ranked = rankByGoal(texts, '数据报告')
  assert.deepEqual(indexes(ranked), [1, 0, 2])
})

test('the limit caps the returned list, never the input', () => {
  const texts = ['数据', '报告', '其他']
  assert.deepEqual(indexes(rankByGoal(texts, '数据报告', 2)), [1, 0])
  assert.deepEqual(rankByGoal(texts, '数据报告', 0), [])
  assert.equal(rankByGoal(texts, '数据报告', 99).length, texts.length)
})

test('the input array is not mutated', () => {
  const texts = ['乙', '甲']
  const copy = [...texts]
  rankByGoal(texts, '甲')
  assert.deepEqual(texts, copy)
})
