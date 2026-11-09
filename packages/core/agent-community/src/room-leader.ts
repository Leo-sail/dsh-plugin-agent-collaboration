/**
 * Room leadership, resolved in ONE place.
 *
 * WHY THIS MODULE EXISTS (DUP-12/13)
 * Two resolvers used to disagree:
 *   · the service's `leaderOfRoom` read `room.team.leader` and fell back to `memberIds[0]`;
 *   · `GroupFlowService.leaderIdOf` returned `room.team.leader.botId` ONLY, `undefined` when a
 *     group carried no team at all.
 *
 * A group can genuinely have no `team`: rooms are also created by hand from the panel, and older
 * persisted rooms predate the field. In such a room the service would wake `memberIds[0]` as the
 * coordinator while the task board refused every leader-only call ("this room has no leader") —
 * so the round budget never advanced and the leader could not close its own board. Same room,
 * two answers, both wrong in different ways.
 *
 * The rule here: the stored leader wins when it is a live bot that is still a member; otherwise
 * the first member in join order is the leader. A leader that was removed therefore hands the
 * role to the next member deterministically, without rewriting `team` as a side effect of a read
 * (the hand-off write happens in `handoffLeadership`, when membership actually changes).
 *
 * Pure and dependency-free: every caller — the service, the group flow, the driver — can share
 * exactly this decision, and it is testable without a host.
 *
 * @module
 */

import type { BotId } from './types.ts'

/**
 * The fields leadership resolution reads.
 *
 * Structurally compatible with `BotRoom`, so callers pass the room itself; a test can pass a
 * literal without building a whole room.
 */
export interface LeaderLookupRoom {
  readonly memberIds: readonly BotId[]
  readonly team?: {
    readonly leader?:
      | { readonly kind: 'bot'; readonly botId: BotId }
      | { readonly kind: 'session'; readonly sessionId: unknown }
      | undefined
    | undefined
  } | undefined
}

/**
 * The room's coordinator, or `undefined` when the room has no members.
 *
 * The stored leader is used only while it is valid (a bot, and still a member). Otherwise the
 * first member in join order takes over — the same member `handoffLeadership` would choose.
 */
export function resolveRoomLeader(room: LeaderLookupRoom | undefined): BotId | undefined {
  if (room === undefined) return undefined
  const stored = room.team?.leader
  if (stored !== undefined && stored.kind === 'bot' && room.memberIds.includes(stored.botId)) {
    return stored.botId
  }
  return room.memberIds[0]
}

/** Whether this bot is the room's coordinator under {@link resolveRoomLeader}. */
export function isRoomLeader(room: LeaderLookupRoom | undefined, botId: string | undefined): boolean {
  const leader = resolveRoomLeader(room)
  return leader !== undefined && botId !== undefined && leader === botId
}
