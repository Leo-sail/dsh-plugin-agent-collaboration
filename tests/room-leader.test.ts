/**
 * Unit tests for the shared room-leader rule (room-leader.ts).
 *
 * The bug this guards: the service resolved a group's leader as `team.leader ?? memberIds[0]`,
 * while the group flow resolved it as `team.leader` ONLY — so a hand-made or legacy group (no
 * `team` at all) had a coordinator in one place and no coordinator in the other. Its board then
 * refused every leader-only call (`advanceRound`, `finishTask`, `remove_bot`) while the service
 * still woke `memberIds[0]` as the leader. One rule, one answer.
 *
 * Run with: node --test tests/room-leader.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRoomLeader, resolveRoomLeader } from '../packages/core/agent-community/src/room-leader.ts'
import type { LeaderLookupRoom } from '../packages/core/agent-community/src/room-leader.ts'

type LeaderSpec =
  | { readonly kind: 'bot'; readonly botId: string }
  | { readonly kind: 'session'; readonly sessionId: string }

function room(memberIds: readonly string[], leader?: LeaderSpec): LeaderLookupRoom {
  return {
    memberIds: [...memberIds] as never,
    ...(leader === undefined ? {} : { team: { leader: leader as never } }),
  }
}

test('a stored leader that is a live member wins', () => {
  assert.equal(resolveRoomLeader(room(['a', 'b', 'c'], { kind: 'bot', botId: 'b' })), 'b')
})

test('a stored leader that was removed falls back to the first member in join order', () => {
  // `handoffLeadership` has not rewritten `team` yet (or the room predates the field).
  assert.equal(resolveRoomLeader(room(['a', 'b'], { kind: 'bot', botId: 'gone' })), 'a')
})

test('a group with no team at all still has a coordinator', () => {
  assert.equal(resolveRoomLeader(room(['a', 'b'])), 'a')
})

test('a session-kind leader is not a bot leader: the first member coordinates', () => {
  assert.equal(resolveRoomLeader(room(['a', 'b'], { kind: 'session', sessionId: 's-1' })), 'a')
})

test('an empty room has no leader, stored or not', () => {
  assert.equal(resolveRoomLeader(room([])), undefined)
  assert.equal(resolveRoomLeader(room([], { kind: 'bot', botId: 'b' })), undefined)
  assert.equal(resolveRoomLeader(undefined), undefined)
})

test('isRoomLeader answers for the stored leader and the fallback alike', () => {
  const withTeam = room(['a', 'b'], { kind: 'bot', botId: 'b' })
  assert.equal(isRoomLeader(withTeam, 'b'), true)
  assert.equal(isRoomLeader(withTeam, 'a'), false)
  const noTeam = room(['a', 'b'])
  assert.equal(isRoomLeader(noTeam, 'a'), true)
  assert.equal(isRoomLeader(noTeam, 'b'), false)
  assert.equal(isRoomLeader(undefined, 'a'), false)
  assert.equal(isRoomLeader(noTeam, undefined), false)
})
