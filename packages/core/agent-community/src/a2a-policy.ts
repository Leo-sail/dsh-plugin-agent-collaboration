/**
 * A2A policy (S3-1) — who may message whom, decided in ONE place.
 *
 * WHY THIS EXISTS. `message_member` is the plugin's only bot-to-bot channel. Its safety rests on
 * two different questions that used to be answered implicitly: "is the target in this room?" and
 * "may a member of THIS room reach outside it?" The first is isolation; the second is authority.
 * Keeping them in a pure policy makes the default explicit and reviewable — same room allowed,
 * cross-room denied unless a room explicitly opted in (no such switch exists yet, by design).
 *
 * WHAT THIS IS NOT. It does not deliver the message, wake anyone or check the sender's role
 * beyond naming it in the reason; those are the service's job. It is the decision table only.
 *
 * @module
 */

/** One bot-to-bot request. */
export interface A2ARequest {
  /** True when the sender and the target are in the same room (the only supported channel). */
  readonly sameRoom: boolean
  /** True when the target name resolved to a member of the sender's room. */
  readonly targetIsMember: boolean
  /**
   * Room-level opt-in for crossing a room boundary. Absent/false = deny; the current product has
   * no such switch, so this is the documented default for future work.
   */
  readonly crossRoomAllowed?: boolean | undefined
  readonly senderIsLeader?: boolean | undefined
}

export interface A2ADecision {
  readonly allow: boolean
  readonly reason: string
}

/**
 * The allow matrix.
 *
 * · same room, target is a member → allow (leader and member alike; the message tool exists for
 *   exactly this);
 * · same room, target is not a member → deny (the room is an isolation domain);
 * · cross-room → deny unless the room explicitly enabled it AND the target is a member of the
 *   sender's room; cross-room targets resolve to nothing today, so the deny is also the safe
 *   failure for a stale name.
 */
export function decideA2A(input: A2ARequest): A2ADecision {
  if (!input.sameRoom) {
    return input.crossRoomAllowed === true && input.targetIsMember
      ? { allow: true, reason: '跨房间 A2A 已被房间显式授权' }
      : { allow: false, reason: '跨房间 A2A 默认禁止（需要房间显式授权）' }
  }
  if (!input.targetIsMember) {
    return { allow: false, reason: '目标不是本房间成员，房间是隔离域' }
  }
  return {
    allow: true,
    reason: input.senderIsLeader === true ? 'leader 在本房间内联系成员' : '成员在本房间内联系同伴',
  }
}

/** The tool-facing refusal, shared so every caller words it the same way. */
export function a2aDenialText(decision: A2ADecision): string {
  return `没有发送：${decision.reason}。只能用群里现有成员的名字。`
}
