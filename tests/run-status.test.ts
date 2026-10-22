/**
 * Unit tests for the run status strip rules (pure, no DOM / no host).
 *
 * Covered:
 *   · which run is "the current one" for a room (recency, not array order);
 *   · the running line: elapsed time, deadline, missing deadline, overdue deadline;
 *   · every terminal reason the S8 timeout work distinguishes (timeout / no-progress /
 *     user-cancel / other failure / stop);
 *   · completed runs hide the strip entirely;
 *   · the duration and clock formatters.
 *
 * Run with: node --test tests/run-status.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatClock,
  formatDuration,
  formatRunStatus,
  latestRunFor,
  parseTimeMs,
} from '../packages/ui/ui-agent-community/src/client/conversation/runStatusView.ts'
import type { RunView } from '../packages/ui/ui-agent-community/src/client/conversation/runStatusView.ts'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')

/** A run with only the fields a case cares about. */
function run(overrides: Partial<RunView> & Pick<RunView, 'id' | 'roomId' | 'status'>): RunView {
  return overrides
}

// ── which run is current ────────────────────────────────────────────────────

test('the current run is the room’s most recently updated one, not the last array item', () => {
  const runs: RunView[] = [
    run({ id: 'a', roomId: 'r1', status: 'completed', createdAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:05:00.000Z' }),
    run({ id: 'b', roomId: 'r1', status: 'running', createdAt: '2026-10-22T11:00:00.000Z', updatedAt: '2026-10-22T11:59:00.000Z' }),
    run({ id: 'c', roomId: 'r1', status: 'failed', createdAt: '2026-10-22T11:30:00.000Z', updatedAt: '2026-10-22T11:31:00.000Z' }),
    run({ id: 'other', roomId: 'r2', status: 'running', createdAt: '2026-10-22T11:59:30.000Z', updatedAt: '2026-10-22T11:59:40.000Z' }),
  ]
  assert.equal(latestRunFor('r1', runs)?.id, 'b')
  assert.equal(latestRunFor('r2', runs)?.id, 'other')
})

test('a room without runs, or with runs of another room only, has no current run', () => {
  const runs: RunView[] = [
    run({ id: 'a', roomId: 'r1', status: 'running', createdAt: '2026-10-22T11:00:00.000Z', updatedAt: '2026-10-22T11:01:00.000Z' }),
  ]
  assert.equal(latestRunFor('r2', runs), undefined)
  assert.equal(latestRunFor('r1', []), undefined)
})

test('createdAt is the fallback when a run has no updatedAt yet', () => {
  const runs: RunView[] = [
    run({ id: 'old', roomId: 'r1', status: 'completed', createdAt: '2026-10-22T09:00:00.000Z' }),
    run({ id: 'new', roomId: 'r1', status: 'queued', createdAt: '2026-10-22T11:00:00.000Z' }),
  ]
  assert.equal(latestRunFor('r1', runs)?.id, 'new')
})

// ── running ────────────────────────────────────────────────────────────────

test('a running run shows elapsed time and its deadline', () => {
  const view = formatRunStatus(run({
    id: 'run-1',
    roomId: 'r1',
    status: 'running',
    startedAt: '2026-10-22T11:55:00.000Z',
    deadlineAt: '2026-10-22T12:10:00.000Z',
  }), NOW)
  assert.equal(view.tone, 'running')
  assert.match(view.label, /^运行中 · 已用 5m · 预计截止 \d{2}:\d{2}$/)
  assert.equal(view.detail, '剩余 10m')
})

test('a running run without a deadline says so by omitting the deadline', () => {
  const view = formatRunStatus(run({
    id: 'run-2',
    roomId: 'r1',
    status: 'running',
    startedAt: '2026-10-22T11:30:00.000Z',
  }), NOW)
  assert.equal(view.tone, 'running')
  assert.match(view.label, /^运行中 · 已用 30m$/)
  assert.equal(view.label.includes('预计截止'), false)
  assert.equal(view.detail, undefined)
})

test('an overdue deadline is reported as overdue while the run continues', () => {
  const view = formatRunStatus(run({
    id: 'run-3',
    roomId: 'r1',
    status: 'running',
    startedAt: '2026-10-22T11:00:00.000Z',
    deadlineAt: '2026-10-22T11:50:00.000Z',
  }), NOW)
  assert.equal(view.tone, 'running')
  assert.equal(view.detail, '已到预计截止，仍在运行')
})

test('a running run missing startedAt falls back to createdAt for elapsed time', () => {
  const view = formatRunStatus(run({
    id: 'run-4',
    roomId: 'r1',
    status: 'running',
    createdAt: '2026-10-22T11:45:00.000Z',
  }), NOW)
  assert.match(view.label, /已用 15m/)
})

// ── terminal reasons ───────────────────────────────────────────────────────

test('a timed-out run says so and carries the host’s error', () => {
  const view = formatRunStatus(run({
    id: 'run-5',
    roomId: 'r1',
    status: 'failed',
    failureKind: 'timeout',
    error: '超过预算 12 分钟',
  }), NOW)
  assert.equal(view.tone, 'error')
  assert.equal(view.label, '运行超时已停止')
  assert.equal(view.detail, '超过预算 12 分钟')
})

test('a stalled run is worded differently from a timeout', () => {
  const view = formatRunStatus(run({
    id: 'run-6',
    roomId: 'r1',
    status: 'failed',
    failureKind: 'no-progress',
    lastError: '连续 5 分钟没有进展',
  }), NOW)
  assert.equal(view.tone, 'error')
  assert.equal(view.label, '无进展已停止')
  assert.equal(view.detail, '连续 5 分钟没有进展')
})

test('a user-cancelled failure reads as stopped, not as an error', () => {
  const view = formatRunStatus(run({
    id: 'run-7',
    roomId: 'r1',
    status: 'failed',
    failureKind: 'user-cancel',
  }), NOW)
  assert.equal(view.tone, 'muted')
  assert.equal(view.label, '已停止')
})

test('an unexplained failure still says it failed', () => {
  const view = formatRunStatus(run({
    id: 'run-8',
    roomId: 'r1',
    status: 'failed',
    failureKind: 'provider',
    error: 'provider 503',
  }), NOW)
  assert.equal(view.tone, 'error')
  assert.equal(view.label, '运行失败')
  assert.equal(view.detail, 'provider 503')
})

test('interrupted and cancelled runs are stops; completed runs hide the strip', () => {
  for (const status of ['interrupted', 'cancelled']) {
    const view = formatRunStatus(run({ id: `run-${status}`, roomId: 'r1', status }), NOW)
    assert.equal(view.tone, 'muted', status)
    assert.equal(view.label, '已停止', status)
  }
  const completed = formatRunStatus(run({ id: 'run-done', roomId: 'r1', status: 'completed' }), NOW)
  assert.equal(completed.tone, 'hidden')
  assert.equal(formatRunStatus(run({ id: 'run-unknown', roomId: 'r1', status: 'weird' }), NOW).tone, 'hidden')
})

test('a queued run shows how long it has been waiting', () => {
  const view = formatRunStatus(run({
    id: 'run-9',
    roomId: 'r1',
    status: 'queued',
    createdAt: '2026-10-22T11:58:30.000Z',
  }), NOW)
  assert.equal(view.tone, 'muted')
  assert.equal(view.label, '排队中 · 已等待 1m 30s')
})

// ── formatters ─────────────────────────────────────────────────────────────

test('durations render in the compact transcript notation', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(60_000), '1m')
  assert.equal(formatDuration(90_000), '1m 30s')
  assert.equal(formatDuration(3_600_000), '1h')
  assert.equal(formatDuration(3_900_000), '1h 5m')
  assert.equal(formatDuration(-5_000), '0s')
  assert.equal(formatDuration(Number.NaN), '0s')
})

test('clocks render as local HH:mm and unparseable values stay undefined', () => {
  assert.match(formatClock('2026-10-22T12:05:00.000Z') ?? '', /^\d{2}:\d{2}$/)
  assert.equal(formatClock(undefined), undefined)
  assert.equal(formatClock('not-a-date'), undefined)
  assert.equal(parseTimeMs(''), undefined)
  assert.equal(parseTimeMs('2026-10-22T12:05:00.000Z'), Date.parse('2026-10-22T12:05:00.000Z'))
})
