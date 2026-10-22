/**
 * Tests for the message threading / task linkage normalizer (OP-14).
 *
 * The client may attach `replyTo`, `threadId` and `taskId` to a user message. Two of these are
 * isolation-sensitive (`replyTo` must resolve to a message in the SAME room — a cross-room pointer
 * would link two isolated conversations) and all three are untrusted strings that end up in
 * `state.json`, so they are validated/bounded before being copied onto the message and its ledger
 * row. `normalizeThreading` is the single implementation of those rules.
 *
 * Run with: node --test tests/message-threading.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  THREAD_FIELD_MAX_LENGTH,
  normalizeThreading,
} from '../packages/core/agent-community/src/abstention.ts'
import type { ThreadingContext } from '../packages/core/agent-community/src/abstention.ts'

/** Contexts: `replyTo` resolves only to ids in this set (i.e. in the target room). */
function contextWith(...ids: readonly string[]): ThreadingContext {
  const inRoom = new Set(ids)
  return { messageInRoom: id => inRoom.has(id) }
}

const empty = contextWith()

test('a replyTo that resolves in the same room is kept', () => {
  const fields = normalizeThreading({ replyTo: 'msg-1' }, contextWith('msg-1'))
  assert.deepEqual(fields, { replyTo: 'msg-1' })
})

test('a replyTo that does not resolve is dropped, never stored', () => {
  // The message was deleted, never existed, or belongs to ANOTHER room: all are simply dropped.
  assert.deepEqual(normalizeThreading({ replyTo: 'missing' }, empty), {})
  assert.deepEqual(normalizeThreading({ replyTo: '   ' }, empty), {})
})

test('threadId and taskId are trimmed', () => {
  assert.deepEqual(
    normalizeThreading({ threadId: '  t-1  ', taskId: '\ttask-9\n' }, empty),
    { threadId: 't-1', taskId: 'task-9' },
  )
})

test('empty labels disappear instead of becoming empty strings', () => {
  assert.deepEqual(normalizeThreading({ threadId: '', taskId: '   ' }, empty), {})
})

test('over-long labels are dropped, not truncated (a cut id names a different thread)', () => {
  const long = 'x'.repeat(THREAD_FIELD_MAX_LENGTH + 1)
  assert.deepEqual(normalizeThreading({ threadId: long, taskId: long }, empty), {})
  // Exactly at the bound is valid.
  const atLimit = 'y'.repeat(THREAD_FIELD_MAX_LENGTH)
  assert.deepEqual(
    normalizeThreading({ threadId: atLimit, taskId: atLimit }, empty),
    { threadId: atLimit, taskId: atLimit },
  )
})

test('no threading input yields an empty shape (existing callers are unchanged)', () => {
  assert.deepEqual(normalizeThreading({}, empty), {})
})

test('fields travel together and independently', () => {
  const fields = normalizeThreading(
    { replyTo: 'm-1', threadId: 'thread-a', taskId: 'task-b' },
    contextWith('m-1'),
  )
  assert.deepEqual(fields, { replyTo: 'm-1', threadId: 'thread-a', taskId: 'task-b' })
  // A bad replyTo does not take the labels down with it.
  assert.deepEqual(
    normalizeThreading({ replyTo: 'gone', threadId: 'thread-a' }, empty),
    { threadId: 'thread-a' },
  )
})
