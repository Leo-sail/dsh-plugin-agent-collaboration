/**
 * The selection arbitration behind "clicking another Bot does not switch the conversation".
 *
 * These assertions are the whole rule set: the hook only feeds `resolveSelection` the live
 * timestamps and room ids, so if these pass the poll can no longer write back a room the
 * user has already left, and an explicit reload can no longer win over a newer click.
 *
 * Run with: node --test tests/selection.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSelection } from '../packages/ui/ui-agent-community/src/client/community/selection.ts'
import type { SelectionInput } from '../packages/ui/ui-agent-community/src/client/community/selection.ts'

/** Two direct rooms as they would appear in the bots tab. */
const roomIds = ['bot-a', 'bot-b']

/** A fetch that started long before any user pick: the poll case. */
const base: SelectionInput = {
  prev: 'bot-a',
  preferId: undefined,
  requestStartedAt: 1_000,
  lastUserSelectAt: 0,
  roomIds,
}

test('no preferId keeps the current room, even when it is not the first row', () => {
  // The bug: the poll passed the selectedId it captured when its request STARTED, so an
  // answer that landed after a click re-selected the room the user had just left.
  assert.equal(resolveSelection({ ...base, prev: 'bot-b' }), 'bot-b')
})

test('no preferId and no selection picks the first room of the tab', () => {
  assert.equal(resolveSelection({ ...base, prev: undefined }), 'bot-a')
})

test('no preferId falls back to the first room when the current room is gone', () => {
  // A deleted bot/room must not stay selected: the list cannot highlight it and the panel
  // would draw a room that no longer exists.
  assert.equal(resolveSelection({ ...base, prev: 'bot-deleted' }), 'bot-a')
})

test('empty room list selects nothing', () => {
  assert.equal(resolveSelection({ ...base, prev: 'bot-a', roomIds: [] }), undefined)
  assert.equal(resolveSelection({ ...base, prev: undefined, roomIds: [] }), undefined)
})

test('a preferId from a fetch that started BEFORE the click does not override it', () => {
  // The old `onReload(roomId)` after a send/model/fork: the user switched away while the
  // request was in flight, and its answer dragged the selection back to the old room.
  assert.equal(resolveSelection({
    ...base,
    prev: 'bot-b',
    preferId: 'bot-a',
    requestStartedAt: 1_000,
    lastUserSelectAt: 2_000,
  }), 'bot-b')
})

test('a preferId started in the same millisecond as the click loses to the click', () => {
  // Ties go to the user: a request cannot prove it is newer than the pick it would undo.
  assert.equal(resolveSelection({
    ...base,
    prev: 'bot-b',
    preferId: 'bot-a',
    requestStartedAt: 2_000,
    lastUserSelectAt: 2_000,
  }), 'bot-b')
})

test('a preferId started AFTER the last pick is honoured', () => {
  assert.equal(resolveSelection({
    ...base,
    prev: 'bot-a',
    preferId: 'bot-b',
    requestStartedAt: 2_001,
    lastUserSelectAt: 2_000,
  }), 'bot-b')
})

test('a preferId outside the tab list falls back to the first room', () => {
  // Explicit navigations can name a room of the other tab (fork/created group). Selecting
  // an id the list cannot show would render the empty state with a dangling selection.
  assert.equal(resolveSelection({
    ...base,
    prev: 'bot-b',
    preferId: 'group-x',
    requestStartedAt: 2_001,
    lastUserSelectAt: 2_000,
  }), 'bot-a')
})

test('a stale preferId with a vanished current room still falls back to the first room', () => {
  assert.equal(resolveSelection({
    ...base,
    prev: 'bot-deleted',
    preferId: 'bot-a',
    requestStartedAt: 1_000,
    lastUserSelectAt: 2_000,
  }), 'bot-a')
})
