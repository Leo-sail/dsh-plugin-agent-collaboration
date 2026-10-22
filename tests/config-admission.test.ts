/**
 * Tests for config / prompt-change admission (OP-21).
 *
 * The contract is narrow: admit known settings only when they are the right type and inside the
 * documented product bounds, report every issue at once, ignore (but warn about) unknown keys,
 * and never silently apply an invalid value. Construction is deliberately not wired to this —
 * `admitConfigOrThrow` is the opt-in entry point for a future write path.
 *
 * Run with: node --test tests/config-admission.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONFIG_ADMISSION_RULES,
  admitConfig,
  admitConfigOrThrow,
} from '../packages/core/agent-community/src/config-admission.ts'

const VALID = {
  maxBots: 8,
  maxRooms: 8,
  maxMessages: 500,
  maxConcurrentRuns: 4,
  runLeaseMs: 60_000,
  historyMessagesInPrompt: 10,
  memoryEntriesPerRoom: 12,
  memoryPromptEntries: 8,
  botAgentPreset: 'bot',
} as const

test('a fully valid config is admitted unchanged', () => {
  const result = admitConfig({ ...VALID })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.config, { ...VALID })
  assert.deepEqual(result.warnings, [])
})

test('every rule has a unique key and a stated intent', () => {
  const keys = CONFIG_ADMISSION_RULES.map(rule => rule.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const rule of CONFIG_ADMISSION_RULES) assert.notEqual(rule.intent.trim(), '')
})

test('the boundary values are admitted', () => {
  for (const rule of CONFIG_ADMISSION_RULES) {
    if (rule.kind === 'string') continue
    assert.ok(rule.min !== undefined && rule.max !== undefined)
    for (const value of [rule.min, rule.max]) {
      const result = admitConfig({ [rule.key]: value })
      assert.equal(result.ok, true, `${rule.key}=${String(value)} should be admitted`)
    }
  }
})

test('out-of-range integers are rejected with the field named', () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['maxBots', 0],
    ['maxBots', 65],
    ['maxRooms', 0],
    ['maxRooms', 129],
    ['maxMessages', 99],
    ['maxMessages', 200_001],
    ['maxConcurrentRuns', 0],
    ['maxConcurrentRuns', 17],
    ['runLeaseMs', 9_999],
    ['runLeaseMs', 300_001],
    ['historyMessagesInPrompt', -1],
    ['historyMessagesInPrompt', 51],
    ['memoryEntriesPerRoom', -1],
    ['memoryEntriesPerRoom', 51],
    ['memoryPromptEntries', -1],
    ['memoryPromptEntries', 21],
  ]
  for (const [key, value] of cases) {
    const result = admitConfig({ [key]: value })
    assert.equal(result.ok, false, `${key}=${value} should be rejected`)
    if (result.ok) continue
    assert.equal(result.issues[0]?.key, key)
  }
})

test('type errors are rejected, including non-integer numbers and empty presets', () => {
  for (const [key, value] of [
    ['maxBots', '8'],
    ['maxRooms', 8.5],
    ['maxMessages', null],
    ['botAgentPreset', ''],
    ['botAgentPreset', '   '],
    ['botAgentPreset', 42],
  ] as const) {
    const result = admitConfig({ [key]: value as never })
    assert.equal(result.ok, false, `${key}=${String(value)} should be rejected`)
    if (result.ok) continue
    assert.equal(result.issues[0]?.key, key)
  }
})

test('unknown keys are warned about but do not reject the config', () => {
  const result = admitConfig({ ...VALID, unknownSetting: true, another: 'x' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.config, { ...VALID }, 'unknown keys must not be admitted')
  assert.equal(result.warnings.length, 2)
  assert.ok(result.warnings.some(line => line.includes('unknownSetting')))
})

test('undefined values count as "not provided", not as type errors', () => {
  const result = admitConfig({ ...VALID, maxBots: undefined })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(Object.prototype.hasOwnProperty.call(result.config, 'maxBots'), false)
})

test('all issues are collected in one admission', () => {
  const result = admitConfig({ maxBots: 0, maxRooms: 'many', runLeaseMs: 1, botAgentPreset: '' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.issues.map(issue => issue.key), [
    'maxBots', 'maxRooms', 'runLeaseMs', 'botAgentPreset',
  ])
})

test('an empty config is admissible', () => {
  const result = admitConfig({})
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.config, {})
})

test('admitConfigOrThrow returns the admitted config and throws on the first invalid batch', () => {
  assert.deepEqual(admitConfigOrThrow({ ...VALID }), { ...VALID })
  assert.throws(
    () => admitConfigOrThrow({ maxBots: 0, maxConcurrentRuns: 99 }),
    (error: unknown) => error instanceof Error
      && error.message.includes('maxBots')
      && error.message.includes('maxConcurrentRuns'),
  )
})

test('a non-object input is rejected rather than crashing', () => {
  const result = admitConfig(null as never)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.issues[0]?.key, '(config)')
})
