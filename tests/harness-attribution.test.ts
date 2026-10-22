/**
 * OP-01: every run records WHICH harness produced its results.
 *
 * Evaluation results are only comparable if the harness is attributed: a prompt-contract bump,
 * a preset change or a different history/memory window moves the numbers. These assertions
 * cover the attribution record itself (fields, defaults, freezing), the runtime version read
 * (real package.json, injected loaders and the 'unknown' fallback) and the snapshot carrying
 * the attribution without carrying heavy run fields.
 *
 * Run with: node --test tests/harness-attribution.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  buildHarnessAttribution,
  readPluginVersion,
  HARNESS_REVISION,
  UNKNOWN_PLUGIN_VERSION,
} from '../packages/core/agent-community/src/harness-attribution.ts'
import { PROMPT_CONTRACT_VERSION } from '../packages/core/agent-community/src/prompt-contract.ts'
import { summarizeSnapshotRun } from '../packages/core/agent-community/src/snapshot-lite.ts'
import type { BotRun, HarnessAttribution } from '../packages/core/agent-community/src/types.ts'

const PACKAGE_JSON = new URL('../packages/core/agent-community/package.json', import.meta.url)

/** A full injected attribution, so the pure builder is asserted without touching package.json. */
const injected: HarnessAttribution = {
  pluginVersion: '9.9.9-test',
  harnessRevision: HARNESS_REVISION,
  promptContract: PROMPT_CONTRACT_VERSION,
  preset: 'bot',
  historyMessages: 10,
  memoryPromptEntries: 8,
}

test('the harness revision is a fixed batch marker, not a git sha', () => {
  assert.equal(HARNESS_REVISION, 'paper-batch3-2026-10-22')
  assert.equal(typeof HARNESS_REVISION, 'string')
  assert.ok(HARNESS_REVISION.length > 0)
})

test('buildHarnessAttribution fills every field and freezes the result', () => {
  const attribution = buildHarnessAttribution(injected)
  assert.deepEqual({ ...attribution }, injected)
  assert.deepEqual(Object.keys(attribution).sort(), [
    'harnessRevision', 'historyMessages', 'memoryPromptEntries', 'pluginVersion', 'preset', 'promptContract',
  ])
  assert.equal(Object.isFrozen(attribution), true)
  assert.throws(() => { (attribution as { pluginVersion: string }).pluginVersion = 'mutated' }, TypeError)
})

test('buildHarnessAttribution defaults: harness revision, prompt contract, preset and windows', () => {
  const attribution = buildHarnessAttribution({ pluginVersion: '1.2.3' })
  assert.equal(attribution.pluginVersion, '1.2.3')
  assert.equal(attribution.harnessRevision, HARNESS_REVISION)
  assert.equal(attribution.promptContract, PROMPT_CONTRACT_VERSION)
  assert.equal(attribution.preset, 'bot')
  assert.equal(attribution.historyMessages, 10)
  assert.equal(attribution.memoryPromptEntries, 8)
})

test('the prompt contract on an attribution is the contract module version', () => {
  assert.equal(buildHarnessAttribution({}).promptContract, PROMPT_CONTRACT_VERSION)
  assert.equal(buildHarnessAttribution({ promptContract: 7 }).promptContract, 7)
})

test('readPluginVersion reads the real package.json at runtime (no version literal in source)', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string }
  assert.equal(typeof pkg.version, 'string')
  assert.equal(readPluginVersion(), pkg.version)
  // Bellwether against re-introducing '0.3.2' as a source literal: the value must equal the
  // package.json at RUNTIME (if the package version changes, this test follows automatically).
  assert.match(readPluginVersion(), /^\d+\.\d+\.\d+/u)
})

test('readPluginVersion accepts an injected loader (test seam) and reads .version', () => {
  assert.equal(readPluginVersion(() => ({ version: '4.5.6' })), '4.5.6')
  assert.equal(readPluginVersion(() => ({ version: '  7.8.9  ' })), '7.8.9')
})

test('readPluginVersion degrades to unknown instead of guessing', () => {
  assert.equal(readPluginVersion(() => ({})), UNKNOWN_PLUGIN_VERSION)
  assert.equal(readPluginVersion(() => ({ version: '' })), UNKNOWN_PLUGIN_VERSION)
  assert.equal(readPluginVersion(() => ({ version: 42 })), UNKNOWN_PLUGIN_VERSION)
  assert.equal(readPluginVersion(() => null), UNKNOWN_PLUGIN_VERSION)
  assert.equal(readPluginVersion(() => { throw new Error('ENOENT') }), UNKNOWN_PLUGIN_VERSION)
  assert.equal(UNKNOWN_PLUGIN_VERSION, 'unknown')
})

test('buildHarnessAttribution reports unknown when package metadata is unavailable', () => {
  // The pure builder takes pluginVersion from the caller; when that caller already degraded
  // (readPluginVersion → 'unknown'), the record says so rather than inventing a version.
  assert.equal(buildHarnessAttribution({ pluginVersion: UNKNOWN_PLUGIN_VERSION }).pluginVersion, 'unknown')
})

test('the snapshot keeps the attribution and still drops the heavy run fields', () => {
  const run = {
    id: 'run-1',
    botId: 'bot-1',
    roomId: 'room-1',
    sessionId: 'sess-1',
    origin: 'user',
    prompt: '任务书'.repeat(5_000),
    status: 'completed',
    controlRevision: 3,
    attempt: 0,
    maxAttempts: 3,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:01.000Z',
    startedAt: '2026-10-22T00:00:00.000Z',
    finishedAt: '2026-10-22T00:00:01.000Z',
    harness: injected,
  } as unknown as BotRun
  const lite = summarizeSnapshotRun(run)
  assert.deepEqual(lite.harness, injected)
  const serialized = JSON.stringify(lite)
  assert.equal(serialized.includes('任务书'), false)
  // `promptContract` is part of the attribution; the run's own `prompt` field must be absent.
  assert.equal(Object.keys(lite).includes('prompt'), false)
  assert.equal(serialized.includes('sess-1'), false)
  assert.ok(serialized.length < 1_000, `snapshot run row=${serialized.length}`)
})

test('a run without attribution stays attribution-free in the snapshot', () => {
  const run = {
    id: 'run-2', botId: 'bot-1', roomId: 'room-1', sessionId: 'sess-1', origin: 'user',
    prompt: 'hi', status: 'queued', controlRevision: 0, attempt: 0, maxAttempts: 3,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
  } as unknown as BotRun
  const lite = summarizeSnapshotRun(run)
  assert.equal(lite.harness, undefined)
  assert.equal(JSON.stringify(lite).includes('harness'), false)
})
