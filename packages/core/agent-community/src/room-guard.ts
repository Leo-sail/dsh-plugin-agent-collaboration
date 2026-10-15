/**
 * Who may create which kind of room.
 *
 * ONE REQUEST, ONE GROUP. Measured failure this exists for: in a direct chat the user wrote
 * 「你们两个拉个群打个招呼」, the panel's post-send analysis recorded a group proposal for it
 * (the user then confirmed → group A), and the direct-chat bot — still inside its own turn —
 * called `agent_community_create_room` and built group B. Two rooms, one sentence, and the other
 * bot answered in both.
 *
 * Two independent writers can always race, so the rule cannot be "ask nicely": a Bot actor may not
 * create a GROUP room at all. The sanctioned path is `propose_group` (a 1:1 only tool), which the
 * user confirms, and the host then creates the room itself. A 1:1 room is unaffected — that is
 * bookkeeping, not a team decision — and the panel's own create/repair calls carry no agent
 * session, so they are the user acting.
 *
 * Pure on purpose: the decision is testable without a Cordis runtime, and the wording below is the
 * only thing the model reads when it is refused, so it has to name the way forward.
 */

/** Who is asking. `user` covers the panel, the CLI and any non-plugin agent session. */
export type RoomCreationActor =
  | { readonly kind: 'user' }
  | {
    readonly kind: 'bot'
    /** The room the calling bot is working in — a 1:1 or a group. */
    readonly roomKind: 'direct' | 'group'
  }

export type RoomCreationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

/** What the caller is asking for, narrowed to the fields the decision needs. */
export interface RoomCreationRequest {
  readonly directBotId?: string | undefined
  readonly memberIds?: readonly string[] | undefined
}

/** A room with no `directBotId` and at least two members is a collaboration group. */
export function isGroupCreation(request: RoomCreationRequest): boolean {
  if (request.directBotId !== undefined) return false
  return (request.memberIds?.length ?? 0) >= 2
}

/**
 * Decide whether this room creation may proceed.
 *
 * @param request - the room being asked for.
 * @param actor - who is asking; see {@link RoomCreationActor}.
 * @returns `{ allow: true }`, or a refusal whose `reason` is written for the calling model.
 */
export function screenRoomCreation(
  request: RoomCreationRequest,
  actor: RoomCreationActor,
): RoomCreationDecision {
  if (actor.kind === 'user') return { allow: true }
  if (!isGroupCreation(request)) return { allow: true }
  return {
    allow: false,
    reason: actor.roomKind === 'direct'
      ? '建群不由 Bot 直接创建：请调用 propose_group 把你的建议交给用户，'
        + '用户确认后系统会创建群聊并把任务放进去。不要再用 create_room 建群。'
      : '群聊里不能再建群：需要新群时请让用户在 Bots团队 界面新建。'
        + '本群的协作请用 invite_bot / assign_task 完成。',
  }
}

/**
 * Why a Bot may not touch the room it named, or `undefined` when there is no objection.
 *
 * ONE RULE, TWO CALLERS: the tool layer (a `room_id` parameter the model filled in) and the host
 * (`postBotMessage`, where the session — not the model — says which room the bot is in). Both used
 * to accept the requested room on trust, which is how a task from group A could be posted into
 * group B. `own` is the room the calling SESSION belongs to; `undefined` means the caller is not a
 * plugin bot (the user, or the panel), and the user may address any room.
 */
export function crossRoomError(own: string | undefined, asked: string): string | undefined {
  if (own === undefined || own === asked) return undefined
  return `你只能在自己所在的房间操作（当前房间 ${own}），不能对其它房间读写；`
    + '跨房间的任务请由用户转发，或由用户在界面上把 Bot 拉进那个房间。'
}
