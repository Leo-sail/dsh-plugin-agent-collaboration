/**
 * In-session failure diagnosis: one plain GREY line, not a settings panel.
 *
 * The diagnosis must say the cause (model/harness/tool/memory/room-goal/unattributed), keep a
 * short flattened error detail, optionally name the largest prompt section, and NEVER contain
 * the words the UI colours as actionable system rows (建议复盘/审计/目标可能偏移/bypass).
 *
 * Run with: node --test tests/run-diagnosis.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  diagnoseRunFailure,
  DIAGNOSIS_DETAIL_LIMIT,
} from '../packages/core/agent-community/src/run-diagnosis.ts'

// ── which runs get a diagnosis ─────────────────────────────────────────────

test('benign terminal statuses never get a diagnosis', () => {
  for (const status of ['completed', 'interrupted', 'stopped', 'cancelled']) {
    assert.equal(diagnoseRunFailure({ status }), undefined, status)
    // Even a stray attribution does not diagnose a benign terminal status.
    assert.equal(diagnoseRunFailure({ status, faultSide: 'unknown', finishPath: 'reply' }), undefined, status)
  }
})

test('a failed run always gets one, even without attribution', () => {
  const diagnosis = diagnoseRunFailure({ status: 'failed' })
  assert.ok(diagnosis !== undefined)
  assert.equal(diagnosis.cause, '未归因失败')
  assert.match(diagnosis.text, /^诊断：/u)
})

test('a problematic finish path on an unfinished run gets one; clean unfinished runs do not', () => {
  assert.ok(diagnoseRunFailure({ status: 'running', finishPath: 'timeout' }) !== undefined)
  assert.ok(diagnoseRunFailure({ status: 'running', faultSide: 'tool' }) !== undefined)
  assert.equal(diagnoseRunFailure({ status: 'running', finishPath: 'reply' }), undefined)
  assert.equal(diagnoseRunFailure({ status: 'queued' }), undefined)
})

// ── cause mapping ──────────────────────────────────────────────────────────

test('each fault side maps to its Chinese cause', () => {
  const cases: Array<[Parameters<typeof diagnoseRunFailure>[0], string]> = [
    [{ status: 'failed', faultSide: 'model' }, '模型/Provider 调用失败'],
    [{ status: 'failed', faultSide: 'tool' }, '工具调用失败或被拒绝'],
    [{ status: 'failed', faultSide: 'memory' }, '记忆/上下文问题'],
    [{ status: 'failed', faultSide: 'room-goal' }, '房间/目标编排问题'],
    [{ status: 'failed', faultSide: 'unknown' }, '未归因失败'],
    [{ status: 'failed', faultSide: 'user' }, '用户中止'],
    [{ status: 'failed', faultSide: 'harness' }, '框架/运行预算问题'],
    [{ status: 'failed', faultSide: 'harness', finishPath: 'timeout' }, '运行超时（框架侧）'],
    [{ status: 'failed', faultSide: 'harness', finishPath: 'no-progress' }, '运行无进展（框架侧）'],
    [{ status: 'failed', faultSide: 'harness', failureKind: 'timeout' }, '运行超时（框架侧）'],
  ]
  for (const [input, cause] of cases) {
    assert.equal(diagnoseRunFailure(input)?.cause, cause, JSON.stringify(input))
  }
})

test('without fault side the budget fields still name the cause', () => {
  assert.equal(diagnoseRunFailure({ status: 'failed', failureKind: 'timeout' })?.cause, '运行超时（框架侧）')
  assert.equal(diagnoseRunFailure({ status: 'failed', failureKind: 'no-progress' })?.cause, '运行无进展（框架侧）')
  assert.equal(diagnoseRunFailure({ status: 'failed', finishPath: 'no-progress' })?.cause, '运行无进展（框架侧）')
})

// ── detail ─────────────────────────────────────────────────────────────────

test('the error detail is flattened and clipped, never a prompt', () => {
  const diagnosis = diagnoseRunFailure({
    status: 'failed',
    faultSide: 'tool',
    error: '  tool read_file failed:\n\n  EACCES\t /etc/hosts  ',
  })
  assert.equal(diagnosis?.detail, 'tool read_file failed: EACCES /etc/hosts')
  const long = diagnoseRunFailure({
    status: 'failed',
    faultSide: 'model',
    error: 'x'.repeat(500),
  })
  assert.ok([...long!.detail!].length <= DIAGNOSIS_DETAIL_LIMIT)
  assert.ok(long!.detail!.endsWith('…'))
})

test('a whitespace-only error produces no detail', () => {
  const diagnosis = diagnoseRunFailure({ status: 'failed', faultSide: 'model', error: ' \n\t ' })!
  assert.equal(diagnosis.detail, undefined)
  assert.equal(diagnosis.text.includes('—'), false)
})

// ── context cost hint ──────────────────────────────────────────────────────

test('the largest context section is named in Chinese with its share', () => {
  const diagnosis = diagnoseRunFailure({
    status: 'failed',
    faultSide: 'harness',
    finishPath: 'timeout',
    contextSections: { role: 100, memory: 900, history: 0, input: 200 },
  })!
  assert.equal(diagnosis.context, '上下文最大段：记忆 900 字（75%）')
  assert.match(diagnosis.text, /上下文最大段：记忆 900 字（75%）/u)
})

test('unknown section names pass through; ties resolve by name', () => {
  const diagnosis = diagnoseRunFailure({
    status: 'failed',
    faultSide: 'tool',
    contextSections: { zzCustom: 50, aaCustom: 50 },
  })!
  // Equal sizes → lexicographic name first (deterministic).
  assert.equal(diagnosis.context, '上下文最大段：aaCustom 50 字（50%）')
})

test('no usable context sections means no context line', () => {
  assert.equal(diagnoseRunFailure({ status: 'failed', faultSide: 'tool', contextSections: {} })?.context, undefined)
  assert.equal(diagnoseRunFailure({
    status: 'failed',
    faultSide: 'tool',
    contextSections: { memory: 0 },
  })?.context, undefined)
})

// ── grey notice constraints ────────────────────────────────────────────────

test('the fixed prefix is 诊断： and the line stays a plain grey notice', () => {
  const diagnosis = diagnoseRunFailure({
    status: 'failed',
    faultSide: 'tool',
    error: 'sandbox denied',
    contextSections: { memory: 100, input: 50 },
  })!
  assert.ok(diagnosis.text.startsWith('诊断：'))
  assert.match(diagnosis.text, /工具调用失败或被拒绝/u)
  assert.match(diagnosis.text, /sandbox denied/u)
  // Words the UI uses to colour/classify system rows must never appear.
  for (const forbidden of ['建议复盘', '审计', '目标可能偏移', 'bypass']) {
    assert.equal(diagnosis.text.includes(forbidden), false, forbidden)
  }
})

test('a completed run with empty output is diagnosed, unlike a normal completed reply', () => {
  const empty = diagnoseRunFailure({ status: 'completed', finishPath: 'empty' })!
  assert.match(empty.text, /没有产生任何回复/u)
  assert.equal(diagnoseRunFailure({ status: 'completed', finishPath: 'reply' }), undefined)
  assert.equal(diagnoseRunFailure({ status: 'completed', finishPath: 'finish_task' }), undefined)
})

test('colour-label words even inside the error text are stripped', () => {
  const diagnosis = diagnoseRunFailure({
    status: 'failed',
    faultSide: 'unknown',
    error: '建议复盘：审计失败，目标可能偏移，bypass 模式',
  })!
  for (const forbidden of ['建议复盘', '审计', '目标可能偏移', 'bypass']) {
    assert.equal(diagnosis.text.includes(forbidden), false, forbidden)
  }
})

test('a cause-only diagnosis still has valid text', () => {
  const diagnosis = diagnoseRunFailure({ status: 'failed', faultSide: 'room-goal' })!
  assert.equal(diagnosis.text, '诊断：房间/目标编排问题')
  assert.equal(diagnosis.detail, undefined)
  assert.equal(diagnosis.context, undefined)
})
