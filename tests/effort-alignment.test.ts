/**
 * Rationale for the values the Bot settings form puts in its effort dropdown.
 *
 * The form has two call sites for this rule: switching provider/model, and validating a Bot's
 * STORED level against the catalog once it loads. Both were hand-copied logic before; these
 * cases pin the rule (including the provider-default case, which is the one that made a saved
 * `max` impossible to notice and impossible to keep on a route that publishes nothing).
 *
 * Run with: node --test tests/effort-alignment.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alignEffortId } from '../packages/ui/ui-agent-community/src/client/community/effort-alignment.ts'

const levels = [{ id: 'low' }, { id: 'high' }]

test('the provider default is valid everywhere and is never replaced', () => {
  assert.equal(alignEffortId([], '', ''), '')
  assert.equal(alignEffortId(levels, 'high', ''), '')
  assert.equal(alignEffortId(levels, '', ''), '')
})

test('a level the model publishes is kept', () => {
  assert.equal(alignEffortId(levels, 'high', 'low'), 'low')
  assert.equal(alignEffortId(levels, '', 'high'), 'high')
})

test('an unpublished level falls back to the model default, then to its first level', () => {
  assert.equal(alignEffortId(levels, 'high', 'max'), 'high')
  assert.equal(alignEffortId(levels, '', 'max'), 'low')
  assert.equal(alignEffortId(levels, 'max', 'max'), 'low', 'defaultEffort must be published too')
})

test('a model that publishes nothing resolves to the provider default', () => {
  assert.equal(alignEffortId([], 'high', 'max'), '')
  assert.equal(alignEffortId([], '', 'max'), '')
  assert.equal(alignEffortId([], '', 'low'), '')
})
