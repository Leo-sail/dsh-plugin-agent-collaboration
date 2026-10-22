/**
 * Group flow: propose → confirm/decline → invite → dissolve → hand-off (§5.4–5.9).
 *
 * The service owns the DECISIONS; the host service (index.ts) owns the state and the
 * side effects. That split is what makes every rule here testable without a Cordis
 * runtime — and the rules are the part that has been wrong before: `proposeGroup`
 * used to invent a proposal by "counting the bots and taking the first two", which
 * is not a proposal at all.
 *
 * Three invariants this module exists to hold:
 *
 *  - A proposal's roster comes from the LIVE bot list. Constructing one from a
 *    stale id set is what let a deleted bot appear in the confirmation dialog; a
 *    second filter at confirm time covers a delete that lands mid-dialog.
 *  - Group membership grows only through `invite`, which is capped (4 per turn,
 *    20 per room). Nothing else appends to `memberIds`.
 *  - Every path that can empty a room or remove its leader runs the same two
 *    repairs — dissolve, and leadership hand-off in join order.
 */

import type {
  BotId, BotIdentity, BotMessage, BotMessageId, BotRoom, BotRoomId, BotRunId,
  ConfirmGroupRequest, CreateRoomRequest, DeclineGroupRequest, GroupProposal,
  PendingGroupProposal, ProposeGroupRequest, RoomTaskState,
} from './types.ts'
import type { LlmStream } from './skills-profile.ts'
import {
  applyTaskBoardOperation,
  TASK_BOARD_SCHEMA_VERSION,
  type TaskBoardContext,
  type TaskBoardOperation,
} from './task-board.ts'
import { resolveRoomLeader } from './room-leader.ts'
import {
  buildCapabilityCard,
  chooseValidLeader,
  defaultProposalLeader,
  fallbackSelection,
  sanitizeCollaborateSelection,
  shortlistFor,
  type CapabilityCard,
  type RankedCandidate,
} from './capability.ts'

/** §5.6: one turn may pull in at most four bots. */
export const MAX_INVITES_PER_ROUND = 4
/**
 * How many members one `remove_bot` call may take out.
 *
 * The same budget as an invite: enough for "kick the two that failed", small enough that
 * a confused leader cannot empty the room in a single call.
 */
export const MAX_REMOVALS_PER_CALL = 4
/** §5.6: a room may hold at most twenty members. */
export const MAX_GROUP_MEMBERS = 20
/** §5.7 default round budget; the leader is asked to finish before this. */
export const DEFAULT_MAX_ROUNDS = 20
/** How long the dialog has to answer before the proposal counts as declined (§5.4). */
export const DEFAULT_PROPOSAL_TIMEOUT_MS = 120_000
/**
 * Fallback width of "one turn" for the invite cap when no run boundary was
 * observed. A turn that never reports its start must still not hand out unlimited
 * invites, and a permanently-blocking counter would be worse than an approximate one.
 */
export const INVITE_ROUND_WINDOW_MS = 60_000
/** The model may propose a handful of members, never the whole roster. */
const MAX_PROPOSED_MEMBERS = 4

/**
 * The outcome of asking the direct-chat bot's model which bots should take part.
 *
 * `no-group` is a DECISION ("one bot is enough") and must not be overruled; `failed` is the
 * absence of one (no provider, transport error, unreadable answer) and may fall back to the
 * deterministic shortlist. Collapsing the two — the old `undefined` did — is what would let a
 * fallback drag bots into a group the model had explicitly judged unnecessary.
 */
type ConsultVerdict =
  | {
    readonly kind: 'decided'
    readonly members: string[]
    readonly leaderId?: string | undefined
    readonly name?: string | undefined
    readonly reason?: string | undefined
  }
  | { readonly kind: 'no-group' }
  | { readonly kind: 'failed' }

/** Everything the flow needs from the host service. */
export interface GroupFlowPort {
  getRoom(roomId: string): BotRoom | undefined
  /** Every room, so a proposal can be found by id without knowing its room first. */
  listRooms(): readonly BotRoom[]
  /** Persist a mutated room (state write; the guard for "room still exists" is here). */
  saveRoom(room: BotRoom): void
  listBots(): readonly BotIdentity[]
  getBot(id: string): BotIdentity | undefined
  getMessage(id: string): BotMessage | undefined
  createRoom(input: CreateRoomRequest): Promise<BotRoom>
  /** Append one visible message (history + ledger). */
  appendMessage(message: BotMessage): void
  /** A system row: invites, hand-offs, group creation. */
  note(roomId: string, text: string): void
  /** Queue exactly one run. */
  queueRun(input: { roomId: BotRoomId; botId: BotId; prompt: string; origin: 'user' }): void
  /** Delete a room and everything scoped to it (messages, sessions, ledger, disk). */
  deleteRoom(roomId: string): Promise<void>
  /** Wake the executor after queueing. */
  nudge(): void
  /**
   * Keep the direct-chat turn alive after a decline (§5.4). A live turn is nudged;
   * only when nothing is running is a follow-up queued, so a decline can never
   * double-run the task.
   */
  resumeSoloTurn(roomId: string, botId: BotId, prompt: string): void
  stream(): LlmStream | undefined
  nextId(): string
  now(): string
  logger?: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void } | undefined
}

export interface GroupFlowOptions {
  proposalTimeoutMs?: number
  now?(): number
}

export interface RemoveBotsInput {
  readonly roomId: string
  /** Bots to take out of the room; at most {@link MAX_REMOVALS_PER_CALL} per call. */
  readonly botIds: readonly string[]
  /** The bot asking, when a bot is asking. Absent = the user (full authority). */
  readonly actorId?: string | undefined
  readonly reason?: string | undefined
}

export type RemoveBotsResult =
  | {
    readonly ok: true
    readonly room: BotRoom
    readonly removed: readonly BotId[]
    readonly refused: ReadonlyArray<{ readonly botId: string; readonly reason: string }>
  }
  | {
    readonly ok: false
    readonly removed: readonly BotId[]
    readonly refused: ReadonlyArray<{ readonly botId: string; readonly reason: string }>
    readonly error: string
  }

export interface InviteBotInput {
  readonly roomId: string
  readonly botId: string
  readonly reason?: string | undefined
  /** Explicit turn boundary; see {@link GroupFlowService.beginRound}. */
  readonly roundToken?: string | undefined
  now?: number | undefined
}

export type InviteResult =
  | { readonly ok: true; readonly room: BotRoom; readonly alreadyMember: boolean }
  | { readonly ok: false; readonly error: string }

export interface TaskBoardActor {
  readonly roomId: string
  readonly actorBotId: string
}

export interface AssignRoomTaskInput extends TaskBoardActor {
  readonly botId: string
  readonly task: string
}

export interface ReportRoomTaskInput extends TaskBoardActor {
  readonly taskId: string
  readonly text: string
  readonly status?: 'working' | 'done' | 'blocked' | undefined
}

/** One proposal plus the room it was recorded on. */
interface LocatedProposal {
  readonly room: BotRoom
  readonly proposal: PendingGroupProposal
}

export class GroupFlowService {
  private readonly port: GroupFlowPort
  private readonly proposalTimeoutMs: number
  private readonly nowMs: () => number
  /** Turn boundaries per room, plus the invites counted inside each. */
  private readonly roundStart = new Map<string, number>()
  private readonly invites = new Map<string, number[]>()

  constructor(port: GroupFlowPort, options: GroupFlowOptions = {}) {
    this.port = port
    this.proposalTimeoutMs = options.proposalTimeoutMs ?? DEFAULT_PROPOSAL_TIMEOUT_MS
    this.nowMs = options.now ?? (() => Date.now())
  }

  // ── Proposals ───────────────────────────────────────────────────────────────

  /**
   * Record a group proposal for a direct-chat message.
   *
   * Two sources, one rule: the roster is never guessed. When the bot's
   * `propose_group` tool supplies members they are used verbatim; otherwise the
   * direct-chat bot's own model is asked (a direct `llm.stream` call, no session).
   * Neither path can name a bot that no longer exists — both are filtered against
   * the live roster before the record is written.
   */
  async propose(input: ProposeGroupRequest): Promise<GroupProposal | undefined> {
    const room = this.port.getRoom(input.roomId)
    if (room === undefined) throw new Error(`Room "${input.roomId}" not found`)
    // Only a direct chat can propose a group: a group that proposes another group
    // has no user surface to answer on.
    if (room.directBotId === undefined) return undefined
    const sourceBot = this.port.getBot(room.directBotId)
    const message = this.port.getMessage(input.messageId)
    if (message === undefined) return undefined

    // ── A PENDING PROPOSAL IS NEVER OVERWRITTEN ─────────────────────────────────
    //
    // Two writers can reach this method for the same room: the panel's post-send analysis and the
    // bot's own `propose_group` tool. Overwriting while the user is reading the dialog is not a
    // refresh — the dialog holds the OLD proposal id, and confirming it then failed with
    // "Group proposal … not found". An expired proposal is resolved first (that is the same
    // "refused" the user would get by ignoring it), then a fresh one may be recorded.
    // ── ONE MESSAGE PRODUCES AT MOST ONE GROUP ──────────────────────────────
    //
    // Measured: a single direct-chat message produced two groups with the same name, eighty
    // seconds apart, each running the whole flow (leader, member, replies). The room already
    // keeps the proposal whose confirmation created the group, including its sourceMessageId,
    // but nothing compared it with the message being proposed again — and two writers reach
    // this method: the panel's post-send analysis and the bot's own propose_group tool.
    if (room.pendingGroupProposal !== undefined
      && room.pendingGroupProposal.sourceMessageId === input.messageId
      && room.pendingGroupProposal.status !== 'pending') {
      return undefined
    }

    const existing = room.pendingGroupProposal
    if (existing !== undefined && existing.status === 'pending') {
      if (!this.expired(existing)) {
        // ── A DIFFERENT MESSAGE IS A DIFFERENT TASK ──────────────────────────────
        //
        // A pending proposal belongs to the message that produced it. Returning it for a
        // LATER message showed the user a dialog whose taskText was the previous request, and
        // confirming it started the group on stale words — the last thing a user who already
        // reported "the bots don't fit" needs. Only the SAME message may reuse it (the panel
        // and the bot's own tool can both ask); otherwise the new task gets no proposal until
        // the user answers the dialog that is already open.
        return existing.sourceMessageId === message.id ? this.toProposal(existing) : undefined
      }
      this.resolveExpired(room, existing)
    }

    const alive = this.port.listBots()
    // A group needs at least two participants; with one bot in the community there
    // is nothing to propose and no model call to pay for.
    if (alive.length < 2) return undefined

    // ── WHO COULD ACTUALLY DO THIS? (deterministic, before any model call) ─────
    //
    // The cards and the shortlist are built from the live bots and the task text. The model
    // then chooses INSIDE the shortlist; a model failure falls back to the shortlist too.
    // This is what stops "pull in whichever bots happen to exist": every candidate carries a
    // fit score and the hits that produced it, so the proposal can say why it named them.
    const cards = alive.map(bot => buildCapabilityCard({
      id: bot.id,
      name: bot.name,
      description: bot.description,
      ...(bot.systemPrompt !== undefined ? { systemPrompt: bot.systemPrompt } : {}),
      ...(bot.skillProfile !== undefined ? { skillProfile: { names: bot.skillProfile.names } } : {}),
    }))
    const shortlist = shortlistFor(message.text, cards, room.directBotId, MAX_PROPOSED_MEMBERS)
    // The source bot is always on the shortlist, so fewer than two means there is no second
    // bot to collaborate with.
    if (shortlist.length < 2) return undefined

    const explicit = (input.memberIds ?? []).filter(id => typeof id === 'string' && id !== '')
    const decided = explicit.length > 0
      ? {
        members: explicit,
        leaderId: input.leaderId,
        name: input.name,
        reason: input.reason,
      }
      : await this.decideMembers(room, sourceBot, message.text, shortlist, cards)
    if (decided === undefined) return undefined

    const members: BotId[] = []
    for (const rawId of [room.directBotId, ...decided.members]) {
      const id = alive.find(b => b.id === rawId)?.id ?? alive.find(b => b.name === rawId)?.id
      if (id === undefined || members.includes(id)) continue
      members.push(id)
    }
    if (members.length < 2) return undefined

    // The leader defaults to the source bot when it is a member — it is the bot that already
    // holds the task's context — unless an EXPLICIT caller (bot or user) named a valid member.
    // A model-driven suggestion does not get to replace that default: the user may not have
    // talked to the model's favourite bot at all. The dialog still lets the user change it.
    const leaderId = explicit.length > 0
      ? chooseValidLeader({
        members,
        ...(decided.leaderId !== undefined ? { leaderId: decided.leaderId } : {}),
        sourceBotId: room.directBotId,
      }) ?? members[0]!
      : defaultProposalLeader(members, room.directBotId) ?? members[0]!
    const proposal: PendingGroupProposal = {
      id: this.port.nextId(),
      roomId: room.id,
      ...(message.runId !== undefined ? { runId: message.runId as BotRunId } : {}),
      sourceMessageId: message.id,
      // The text is kept on the proposal, not just referenced: the group replays it
      // verbatim on confirm (§5.4), and the source message may be cleared by then.
      taskText: message.text,
      name: decided.name?.trim() !== undefined && decided.name?.trim() !== ''
        ? decided.name.trim()
        : `${room.name} + 协作`,
      memberIds: members,
      leaderId: leaderId as BotId,
      reason: decided.reason?.trim() !== undefined && decided.reason?.trim() !== ''
        ? decided.reason.trim()
        : '这个任务更适合由多个 Bot 协作完成',
      status: 'pending',
      createdAt: this.port.now(),
      expiresAt: new Date(this.nowMs() + this.proposalTimeoutMs).toISOString(),
    }
    this.port.saveRoom({ ...room, pendingGroupProposal: proposal, updatedAt: this.port.now() })
    return this.toProposal(proposal)
  }

  /** The room's pending proposal, expiring it first when its deadline has passed. */
  pending(roomId: string): PendingGroupProposal | undefined {
    const room = this.port.getRoom(roomId)
    const proposal = room?.pendingGroupProposal
    if (room === undefined || proposal === undefined) return undefined
    if (proposal.status !== 'pending') return undefined
    if (this.expired(proposal)) {
      this.resolveExpired(room, proposal)
      return undefined
    }
    return proposal
  }

  /** Look a proposal up by id across rooms (the dialog only knows the id). */
  find(proposalId: string): PendingGroupProposal | undefined {
    return this.locate(proposalId)?.proposal
  }

  /** Expire every overdue proposal; called on a timer so a closed dialog still resolves. */
  sweepExpired(): number {
    let expired = 0
    for (const room of this.roomsWithProposals()) {
      const proposal = room.pendingGroupProposal
      if (proposal === undefined || proposal.status !== 'pending' || !this.expired(proposal)) continue
      this.resolveExpired(room, proposal)
      expired++
    }
    return expired
  }

  /**
   * Confirm: create the group, replay the user's original task into it, and start
   * ONLY the leader (§5.4 "只给 leader 起一轮").
   */
  async confirm(input: ConfirmGroupRequest): Promise<BotRoom> {
    const found = this.locate(input.proposalId)
    if (found === undefined) throw new Error(`Group proposal "${input.proposalId}" not found`)
    const { room: sourceRoom, proposal } = found
    if (proposal.status !== 'pending') {
      throw new Error(`Group proposal "${proposal.id}" is already ${proposal.status}`)
    }
    if (this.expired(proposal)) {
      this.resolveExpired(sourceRoom, proposal)
      throw new Error(`Group proposal "${proposal.id}" timed out and was declined`)
    }

    // Concurrency backstop for §5.4: a bot deleted between the dialog opening and
    // the user clicking 确认 must not enter the room.
    const alive = new Map(this.port.listBots().map(b => [b.id, b]))
    const requested = input.memberIds.length > 0 ? input.memberIds : proposal.memberIds
    const members: BotId[] = []
    for (const raw of requested) {
      const bot = alive.get(raw as BotId)
      if (bot === undefined || members.includes(bot.id)) continue
      members.push(bot.id)
    }
    if (members.length < 2) {
      throw new Error('A collaboration group needs at least two bots that still exist')
    }
    // The user may pick the leader in the dialog (`input.leaderId`); otherwise the proposal's
    // leader, otherwise the first surviving member. Every candidate is re-checked against the
    // live member list — a bot removed while the dialog was open cannot lead.
    const leaderId = chooseValidLeader({
      members,
      ...(input.leaderId !== undefined ? { leaderId: input.leaderId } : {}),
      fallbackLeaderId: proposal.leaderId,
    }) ?? members[0]!
    const leaderName = alive.get(leaderId as BotId)?.name ?? leaderId
    const name = input.name !== undefined && input.name.trim() !== '' ? input.name.trim() : proposal.name

    const group = await this.port.createRoom({
      name,
      memberIds: members,
      // The leader is the group's coordinator; `team.leader` is where every
      // leader-only check (task assignment, hand-off) reads it from.
      team: { leaderBotId: leaderId, leaderName },
    })

    this.port.saveRoom({
      ...sourceRoom,
      pendingGroupProposal: { ...proposal, status: 'confirmed', createdRoomId: group.id },
      updatedAt: this.port.now(),
    })

    // The task itself moves into the group as the user's own words. A summary here
    // would be a different task: the leader must see what was actually asked.
    const source = proposal.sourceMessageId !== undefined
      ? this.port.getMessage(proposal.sourceMessageId)
      : undefined
    this.port.appendMessage({
      id: this.port.nextId() as BotMessageId,
      roomId: group.id,
      sender: { kind: 'user', name: source?.sender.name ?? 'user' },
      text: proposal.taskText,
      ...(source?.modelText !== undefined ? { modelText: source.modelText } : {}),
      mentions: [],
      createdAt: this.port.now(),
    })
    this.port.note(group.id, `已创建协作群聊，负责人：${leaderName}`)
    // Exactly one run: the leader decides who works, and pulls people in with
    // `invite_bot`. Starting every member here would be the "全体各跑一次" model
    // the leader-driven design replaced.
    this.port.queueRun({ roomId: group.id, botId: leaderId as BotId, prompt: proposal.taskText, origin: 'user' })
    this.port.nudge()
    return group
  }

  /**
   * Decline: mark the proposal declined and keep the direct-chat turn alive.
   *
   * Idempotent — the dialog's timeout and the user's click can both land, and the
   * second one must be harmless.
   */
  async decline(input: DeclineGroupRequest): Promise<void> {
    const found = this.locate(input.proposalId)
    if (found === undefined) return
    const { room, proposal } = found
    if (proposal.status !== 'pending') return
    if (this.expired(proposal)) {
      this.resolveExpired(room, proposal)
      return
    }
    this.port.saveRoom({
      ...room,
      pendingGroupProposal: { ...proposal, status: 'declined' },
      updatedAt: this.port.now(),
    })
    this.resumeSolo(room, proposal)
  }

  // ── Membership ──────────────────────────────────────────────────────────────

  /**
   * Mark the start of one turn, so the invite cap counts per turn rather than per
   * room lifetime. Called whenever a run is queued into a group.
   */
  beginRound(roomId: string, now?: number): void {
    this.roundStart.set(roomId, now ?? this.nowMs())
  }

  /**
   * Add one bot to a group (§5.6).
   *
   * Returns a failure instead of throwing: the caller is the model's `invite_bot`
   * tool, and the model has to be told WHY it cannot have this bot, in its own turn.
   */
  async invite(input: InviteBotInput): Promise<InviteResult> {
    const room = this.port.getRoom(input.roomId)
    if (room === undefined) return { ok: false, error: `Room "${input.roomId}" not found` }
    if (room.directBotId !== undefined) {
      return { ok: false, error: 'invite_bot is only available in a group chat' }
    }
    const bot = this.port.getBot(input.botId)
    if (bot === undefined) return { ok: false, error: `Bot "${input.botId}" not found` }
    // Already inside: success, and no invite is consumed — re-inviting a member is
    // not an action, so it must not burn the turn's budget.
    if (room.memberIds.includes(bot.id)) return { ok: true, room, alreadyMember: true }
    if (room.memberIds.length >= MAX_GROUP_MEMBERS) {
      return { ok: false, error: `This room already has ${MAX_GROUP_MEMBERS} members; that is the maximum` }
    }
    const now = input.now ?? this.nowMs()
    const used = this.invitesInRound(room.id, input.roundToken, now)
    if (used >= MAX_INVITES_PER_ROUND) {
      return {
        ok: false,
        error: `invite_bot may add at most ${MAX_INVITES_PER_ROUND} bots per turn; `
          + `this turn already added ${used}. Ask again in your next turn.`,
      }
    }

    const updated: BotRoom = {
      ...room,
      // Appended, never reordered: memberIds order IS join order, and leadership
      // hand-off is defined as "the next member in join order".
      memberIds: [...room.memberIds, bot.id],
      updatedAt: this.port.now(),
    }
    this.port.saveRoom(updated)
    this.noteInvite(room.id, input.roundToken, now)
    this.port.note(room.id, `已邀请 ${bot.name} 加入群聊${input.reason !== undefined && input.reason !== '' ? `（${input.reason}）` : ''}`)
    // The new member is addressable from the NEXT turn on; this turn's prompt has
    // already been built from the old roster.
    return { ok: true, room: updated, alreadyMember: false }
  }

  /**
   * Take one or more bots out of a group.
   *
   * AUTHORITY: membership is coordination, exactly like `assign_task`, so only the
   * leader may do it — unless the caller is the user (no `actorId`), which is how the
   * hand-edit path stays open. A leader may not remove itself: leaving is not kicking,
   * and a silent self-removal would hand leadership to whoever happens to be next in
   * join order.
   *
   * The membership write happens once for the whole batch, then leadership is handed
   * off for any removed leader and the room is told what happened. Everything bound to
   * the removed members — their runs, their sessions, their share of the board — is
   * cleaned up by the service layer, which owns those resources.
   */
  remove(input: RemoveBotsInput): RemoveBotsResult {
    const room = this.port.getRoom(input.roomId)
    if (room === undefined) return { ok: false, removed: [], refused: [], error: `Room "${input.roomId}" not found` }
    if (room.directBotId !== undefined) {
      return { ok: false, removed: [], refused: [], error: 'remove_bot is only available in a group chat' }
    }
    const wanted = [...new Set(input.botIds.filter(id => typeof id === 'string' && id !== ''))]
    if (wanted.length === 0) return { ok: false, removed: [], refused: [], error: 'botIds is required' }
    if (wanted.length > MAX_REMOVALS_PER_CALL) {
      return {
        ok: false, removed: [], refused: [],
        error: `remove_bot may take out at most ${MAX_REMOVALS_PER_CALL} bots per call`,
      }
    }

    const leaderId = this.leaderIdOf(room)
    const actorId = input.actorId
    if (actorId !== undefined) {
      if (!room.memberIds.includes(actorId as BotId)) {
        return { ok: false, removed: [], refused: [], error: 'you are not a member of this group' }
      }
      if (leaderId !== undefined && leaderId !== actorId) {
        return { ok: false, removed: [], refused: [], error: 'only the group leader may remove members' }
      }
    }

    const refused: Array<{ botId: string; reason: string }> = []
    const removed: BotId[] = []
    for (const id of wanted) {
      const botId = id as BotId
      if (actorId !== undefined && botId === actorId) {
        // ── THE COORDINATOR MAY REMOVE ITSELF ────────────────────────────────────
        //
        // This used to refuse self-removal, on the theory that "leaving is a different action".
        // Observed in a group: the user asked to remove the coordinator, the request was
        // routed to the coordinator (correct — it is the only bot that may remove anybody), and
        // the room then had NO path to carry it out. The user asked for it explicitly, so it is
        // not an accident; leadership passes to the first remaining member.
        //
        // A non-leader never reaches this branch: the authority check above refuses it first.
        if (leaderId !== undefined && leaderId !== actorId) {
          refused.push({ botId: id, reason: 'only the group leader may remove members' })
        } else {
          removed.push(botId)
        }
      } else if (!room.memberIds.includes(botId)) {
        refused.push({ botId: id, reason: 'not a member of this group' })
      } else {
        removed.push(botId)
      }
    }
    if (removed.length === 0) {
      return { ok: false, removed: [], refused, error: refused[0]?.reason ?? 'nothing to remove' }
    }

    const gone = new Set<string>(removed)
    const updated: BotRoom = {
      ...room,
      memberIds: room.memberIds.filter(id => !gone.has(id)),
      updatedAt: this.port.now(),
    }
    this.port.saveRoom(updated)
    // Leadership first (it reads the roster), then the note: one hand-off per removed
    // leader, and the room's message reflects the final state.
    for (const botId of removed) this.handoffLeadership(room.id, botId)
    const names = removed.map(id => this.port.getBot(id)?.name ?? id)
    const reason = input.reason !== undefined && input.reason !== '' ? `（${input.reason}）` : ''
    this.port.note(room.id, `已将 ${names.join('、')} 移出群聊${reason}`)
    return { ok: true, room: this.port.getRoom(room.id) ?? updated, removed, refused }
  }

  /** §5.7: a room with no members left cannot be addressed, so it is dissolved. */
  async dissolveIfEmpty(roomId: string): Promise<boolean> {
    const room = this.port.getRoom(roomId)
    if (room === undefined || room.directBotId !== undefined) return false
    if (room.memberIds.length > 0) return false
    await this.port.deleteRoom(roomId)
    this.roundStart.delete(roomId)
    this.invites.delete(roomId)
    return true
  }

  /**
   * The leader was removed: hand the role to the next member in join order (§5.4).
   *
   * `removedBotId` is tolerated either way — present in `memberIds` (the caller has
   * not stripped it yet) or already gone — because both orders occur in practice:
   * a delete strips first, an `updateRoom` may not.
   *
   * WHAT THIS READS, AND WHY NOT `leaderIdOf`. This method REPAIRS the stored record, so it
   * compares against the stored leader, not the resolved one. `leaderIdOf` now falls back to
   * `memberIds[0]`; after the caller has already stripped the removed bot, the fallback would
   * point at its successor and the comparison would miss — leaving `team.leader` pointing at a
   * bot that is gone (functionally covered by the fallback, but the record and the "负责人已
   * 变更" note would both be stale). A group with no stored leader has no record to repair:
   * its leadership already resolves by join order (see `room-leader.ts`).
   */
  handoffLeadership(roomId: string, removedBotId: string): BotId | undefined {
    const room = this.port.getRoom(roomId)
    if (room === undefined || room.directBotId !== undefined) return undefined
    const stored = room.team?.leader
    const storedLeaderId = stored !== undefined && stored.kind === 'bot' ? stored.botId : undefined
    if (storedLeaderId !== removedBotId) return undefined
    const alive = new Map(this.port.listBots().map(b => [b.id, b]))
    const next = room.memberIds.find(id => id !== removedBotId && alive.has(id))
    if (next === undefined) return undefined
    const nextBot = alive.get(next)!
    this.port.saveRoom({
      ...room,
      team: {
        leader: { kind: 'bot', botId: nextBot.id },
        leaderName: nextBot.name,
        status: 'active',
      },
      updatedAt: this.port.now(),
    })
    this.port.note(room.id, `负责人已变更为 ${nextBot.name}`)
    return nextBot.id
  }

  /**
   * The room's leader bot id — the SAME rule the service and the task board use.
   *
   * A hand-made or legacy group may carry no `team` at all; the fallback to the first member in
   * join order is what lets its leader-only board calls work instead of refusing every one of
   * them with "this room has no leader" (see `room-leader.ts`).
   */
  leaderIdOf(room: BotRoom): BotId | undefined {
    return resolveRoomLeader(room)
  }

  // ── Background task board (§5.4 / §6) ───────────────────────────────────────

  /** Return the room's board, creating it on first use. */
  ensureTaskState(roomId: string, objective?: string): RoomTaskState {
    const room = this.port.getRoom(roomId)
    if (room === undefined) throw new Error(`Room "${roomId}" not found`)
    if (room.taskState !== undefined) return room.taskState
    const state: RoomTaskState = {
      round: 0,
      maxRounds: DEFAULT_MAX_ROUNDS,
      assignments: [],
      ...(objective !== undefined ? { objective } : {}),
      // OP-07: every board is versioned from birth; group-flow (the writer below) bumps it.
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      version: 0,
      updatedAt: this.port.now(),
    }
    this.port.saveRoom({ ...room, taskState: state, updatedAt: this.port.now() })
    return state
  }

  /** Leader-only: put one member on the board (one atomic, version-checked assignment). */
  assignTask(input: AssignRoomTaskInput): RoomTaskState {
    const { room, state } = this.leaderBoard(input.roomId, input.actorBotId)
    const bot = this.port.getBot(input.botId)
    if (bot === undefined) throw new Error(`Bot "${input.botId}" not found`)
    return this.applyBoard(room, state, { kind: 'assign', botId: bot.id, task: input.task }, 'leader', input.actorBotId)
  }

  /**
   * Report progress on one row.
   *
   * A member may only write its OWN row; the leader may write any row. The authority rule is
   * enforced again inside `task-board.ts` (the single write contract); the checks here keep the
   * historical error texts and the "not found" semantics unchanged.
   */
  reportTask(input: ReportRoomTaskInput): RoomTaskState {
    const room = this.port.getRoom(input.roomId)
    if (room === undefined) throw new Error(`Room "${input.roomId}" not found`)
    const state = room.taskState
    if (state === undefined) throw new Error(`Room "${input.roomId}" has no task board`)
    const index = state.assignments.findIndex(a => a.id === input.taskId)
    if (index < 0) throw new Error(`Task "${input.taskId}" not found`)
    const entry = state.assignments[index]!
    const isLeader = this.leaderIdOf(room) === input.actorBotId
    if (!isLeader && entry.botId !== input.actorBotId) {
      throw new Error(
        `Bot "${input.actorBotId}" may not edit the entry assigned to "${entry.botId}"`,
      )
    }
    // `blocked` (the legacy input status) maps onto the same persisted vocabulary.
    const status = input.status === undefined
      ? 'working'
      : input.status === 'blocked' ? 'failed' : input.status
    return this.applyBoard(
      room,
      state,
      { kind: 'report', taskId: input.taskId, botId: entry.botId, text: input.text, status },
      isLeader ? 'leader' : 'member',
      input.actorBotId,
    )
  }

  /** Leader-only: close the round. Exhausting `maxRounds` finalises the board (§5.5). */
  advanceRound(input: TaskBoardActor): RoomTaskState {
    const { room, state } = this.leaderBoard(input.roomId, input.actorBotId)
    return this.applyBoard(room, state, { kind: 'advance' }, 'leader', input.actorBotId)
  }

  /** Leader-only: the board's final report (§24.8 — this is what the user reads). */
  finishTask(input: TaskBoardActor & { report: string }): RoomTaskState {
    const { room, state } = this.leaderBoard(input.roomId, input.actorBotId)
    return this.applyBoard(room, state, { kind: 'finish', report: input.report }, 'leader', input.actorBotId)
  }

  /**
   * Run ONE board operation through the transaction machinery and save the resulting board once.
   *
   * The saved room carries the final `taskState` (with the bumped `version`/`updatedAt`) in a
   * single replacement, so a concurrent reader never observes a half-applied transition. A
   * refusal becomes the same kind of `Error` the old inline writers threw.
   */
  private applyBoard(
    room: BotRoom,
    state: RoomTaskState,
    operation: TaskBoardOperation,
    actor: 'leader' | 'member' | 'system',
    actorBotId: string,
  ): RoomTaskState {
    const context: TaskBoardContext = {
      actor,
      actorBotId,
      memberIds: room.memberIds,
      // Optimistic concurrency: the board was read above; a write from a newer version wins the
      // race and this one is refused instead of clobbering it.
      expectedVersion: state.version ?? 0,
      now: this.port.now(),
    }
    const result = applyTaskBoardOperation(state, operation, context)
    if (!result.ok) throw new Error(result.reason)
    this.port.saveRoom({ ...room, taskState: result.state, updatedAt: this.port.now() })
    return result.state
  }

  private leaderBoard(roomId: string, actorBotId: string): { room: BotRoom; state: RoomTaskState } {
    const room = this.port.getRoom(roomId)
    if (room === undefined) throw new Error(`Room "${roomId}" not found`)
    const leader = this.leaderIdOf(room)
    if (leader === undefined) throw new Error(`Room "${roomId}" has no leader`)
    if (leader !== actorBotId) throw new Error(`Bot "${actorBotId}" is not the leader of room "${roomId}"`)
    const state = room.taskState ?? this.ensureTaskState(roomId)
    return { room: this.port.getRoom(roomId)!, state }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private toProposal(proposal: PendingGroupProposal): GroupProposal {
    return {
      id: proposal.id,
      sourceRoomId: proposal.roomId,
      sourceMessageId: proposal.sourceMessageId ?? ('' as BotMessageId),
      suggestedName: proposal.name,
      suggestedMemberIds: proposal.memberIds,
      suggestedLeaderId: proposal.leaderId,
      reason: proposal.reason,
      createdAt: proposal.createdAt,
    }
  }

  private locate(proposalId: string): LocatedProposal | undefined {
    for (const room of this.roomsWithProposals()) {
      const proposal = room.pendingGroupProposal
      if (proposal !== undefined && proposal.id === proposalId) return { room, proposal }
    }
    return undefined
  }

  private roomsWithProposals(): readonly BotRoom[] {
    const out: BotRoom[] = []
    for (const room of this.iterRooms()) {
      if (room.pendingGroupProposal !== undefined) out.push(room)
    }
    return out
  }

  /**
   * Every room the port can see. The port has no `listRooms` because looking a
   * proposal up by id must not depend on the caller knowing the room.
   */
  private iterRooms(): readonly BotRoom[] {
    return this.port.listRooms()
  }

  private expired(proposal: PendingGroupProposal): boolean {
    if (proposal.expiresAt === undefined) return false
    return Date.parse(proposal.expiresAt) <= this.nowMs()
  }

  /** §5.4: an unanswered proposal is a refusal, and the bot finishes on its own. */
  private resolveExpired(room: BotRoom, proposal: PendingGroupProposal): void {
    this.port.saveRoom({
      ...room,
      pendingGroupProposal: { ...proposal, status: 'expired' },
      updatedAt: this.port.now(),
    })
    this.resumeSolo(room, proposal)
  }

  private resumeSolo(room: BotRoom, proposal: PendingGroupProposal): void {
    const botId = room.directBotId
    if (botId === undefined) return
    this.port.resumeSoloTurn(room.id, botId, proposal.taskText)
  }

  /** Invites counted inside the current turn (see {@link beginRound}). */
  private invitesInRound(roomId: string, roundToken: string | undefined, now: number): number {
    if (roundToken !== undefined) {
      // An explicit token is counted directly. Comparing timestamps here looked
      // equivalent and was not: back-to-back invites land in the same millisecond, so
      // a new token's `now` floor did not exclude the previous turn's invites and the
      // fifth invite of the NEXT turn was rejected.
      return this.roundInviteCounts.get(`${roomId}\u0000${roundToken}`) ?? 0
    }
    const floor = Math.max(this.roundStart.get(roomId) ?? 0, now - INVITE_ROUND_WINDOW_MS)
    return (this.invites.get(roomId) ?? []).filter(at => at >= floor).length
  }

  /** Record one accepted invite against whichever budget is in force. */
  private noteInvite(roomId: string, roundToken: string | undefined, now: number): void {
    if (roundToken !== undefined) {
      // A turn token is short-lived by construction, but a long session could mint
      // many of them; the whole map is dropped rather than grown without bound.
      if (this.roundInviteCounts.size > 1_000) this.roundInviteCounts.clear()
      const key = `${roomId}\u0000${roundToken}`
      this.roundInviteCounts.set(key, (this.roundInviteCounts.get(key) ?? 0) + 1)
      return
    }
    const stamps = this.invites.get(roomId) ?? []
    stamps.push(now)
    this.invites.set(roomId, stamps)
  }

  private readonly roundInviteCounts = new Map<string, number>()

  /**
   * Who takes part, decided by the model INSIDE the shortlist, with a deterministic fallback.
   *
   * Three outcomes matter differently:
   *   · "one bot is enough" — a DECISION: no group is proposed (the model judged the task);
   *   · a selection — accepted only if it stays inside the shortlist;
   *   · no usable answer — fall back to the ranked shortlist, which is still a defensible
   *     proposal (fit-ranked, and the user confirms before anything runs).
   */
  private async decideMembers(
    room: BotRoom,
    sourceBot: BotIdentity | undefined,
    text: string,
    shortlist: readonly RankedCandidate[],
    cards: readonly CapabilityCard[],
  ): Promise<{ members: string[]; leaderId?: string | undefined; name?: string | undefined; reason?: string | undefined } | undefined> {
    if (text.trim() === '') return undefined
    const verdict = await this.consultModel(sourceBot, text, shortlist, cards)
    if (verdict.kind === 'no-group') return undefined
    if (verdict.kind === 'decided') {
      // The prompt asks for ids, but a model naming a bot by its display name is still
      // unambiguous: resolve a name to the shortlist's id before validating. Anything that
      // is NEITHER is rejected below — it was never offered.
      const shortlistIds = shortlist.map(candidate => candidate.botId)
      const byName = new Map(
        cards
          .filter(card => shortlistIds.includes(card.botId))
          .map(card => [card.name, card.botId] as const),
      )
      const resolve = (reference: string): string => byName.get(reference) ?? reference
      const selection = sanitizeCollaborateSelection(
        {
          members: verdict.members.map(resolve),
          ...(verdict.leaderId !== undefined ? { leaderId: resolve(verdict.leaderId) } : {}),
        },
        shortlistIds,
        room.directBotId,
        MAX_PROPOSED_MEMBERS,
      )
      if (selection !== undefined) {
        return {
          members: [...selection.members],
          leaderId: selection.leaderId,
          ...(verdict.name !== undefined ? { name: verdict.name } : {}),
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        }
      }
      // The model named bots that were never offered (or too few of them). Falling through
      // to the deterministic list is the only safe answer: proposing an unvetted roster is
      // exactly the "it picked bots that do not fit" failure this path exists to remove.
    }
    const fallback = fallbackSelection(shortlist, room.directBotId)
    if (fallback === undefined) return undefined
    return {
      members: [...fallback.members],
      leaderId: fallback.leaderId,
      reason: '模型未能给出可用的选人结果，已按能力匹配的确定性候选建群（仍由你确认）',
    }
  }

  /**
   * The direct-chat bot's own judgement, via a session-less model call.
   *
   * The model only ever sees the SHORTLIST (fit-ranked, with each candidate's score and the
   * task terms it matched) and its answer is validated against that list afterwards. It also
   * gets to answer "one bot is enough", which is respected: that is a decision, not a failure.
   */
  private async consultModel(
    sourceBot: BotIdentity | undefined,
    text: string,
    shortlist: readonly RankedCandidate[],
    cards: readonly CapabilityCard[],
  ): Promise<ConsultVerdict> {
    const stream = this.port.stream()
    if (stream === undefined || sourceBot?.provider === undefined || sourceBot.model === undefined) {
      return { kind: 'failed' }
    }
    const cardById = new Map(cards.map(card => [card.botId, card]))
    // Best fit first: the source bot is on the shortlist for the fallback's sake, but a
    // stale array order must not look like a preference to the model.
    const ordered = [...shortlist].sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const leftName = cardById.get(left.botId)?.name ?? left.botId
      const rightName = cardById.get(right.botId)?.name ?? right.botId
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
    })
    const roster = ordered.map(candidate => {
      const card = cardById.get(candidate.botId)
      if (card === undefined) return `- id=${candidate.botId} 适配分=${candidate.score}`
      return [
        `- id=${card.botId}`,
        `名称=${card.name}`,
        `适配分=${candidate.score}`,
        `命中=${candidate.matched.slice(0, 6).join('、') || '（无）'}`,
        ...(card.domains.length > 0 ? [`领域=${card.domains.slice(0, 3).join('、')}`] : []),
        ...(card.skills.length > 0 ? [`技能=${card.skills.slice(0, 3).join('、')}`] : []),
        ...(card.deliverables.length > 0 ? [`产出=${card.deliverables.slice(0, 2).join('、')}`] : []),
        ...(card.boundaries.length > 0 ? [`边界=${card.boundaries.slice(0, 1).join('、')}`] : []),
      ].join(' ')
    }).join('\n')
    const system = [
      '你是一个协作调度助手。下面给出候选 Bot（已按与这条任务的相关度排序，含适配分与命中词）。',
      '判断用户这条消息是否需要多个 Bot 协作完成：',
      '- 一个 Bot 就能完成 → 只输出 {"collaborate":false}。',
      `- 需要协作 → 只输出 {"collaborate":true,"name":"群名","members":["候选 id",...],"leader":"成员 id","reason":"一句话理由"}。`,
      `规则：members 只能从候选名单里选，至少 2 个、最多 ${MAX_PROPOSED_MEMBERS} 个；`,
      'leader 必须是 members 之一：默认选发起本次单聊的 Bot（它就是刚接到这条任务的 Bot，掌握第一手上下文）；',
      '除非某个成员的适配分明显更高、且更适合统筹，才选那个成员。',
      '只输出一个 JSON 对象，不要输出解释或 Markdown 代码块。',
    ].join('\n')
    const user = [
      '[用户消息]',
      text.slice(0, 4_000),
      '',
      '[候选 Bot（按与本任务的相关度排序）]',
      roster,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      let answer = ''
      for await (const chunk of stream({
        provider: sourceBot.provider,
        model: sourceBot.model,
        system,
        // Blocks, not a string — the host's envelope requires ContentBlock[]; a string
        // made the adapter die as a bare TRANSPORT failure, so group proposals never
        // actually consulted the model.
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        purpose: 'group-proposal',
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') answer += chunk.text ?? ''
        if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error') {
            throw new Error(`provider rejected the proposal request: ${chunk.reason.failure?.message ?? 'unknown failure'}`)
          }
          if (chunk.reason?.kind === 'aborted') throw new Error('proposal request aborted')
        }
      }
      const decision = parseProposalDecision(answer)
      if (decision.kind === 'no-group') return { kind: 'no-group' }
      if (decision.kind === 'unreadable') return { kind: 'failed' }
      return {
        kind: 'decided',
        members: decision.members,
        ...(decision.leaderId !== undefined ? { leaderId: decision.leaderId } : {}),
        ...(decision.name !== undefined ? { name: decision.name } : {}),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      }
    } catch (error: unknown) {
      // A failed analysis is not "no group": the caller falls back to the ranked shortlist.
      this.port.logger?.warn?.(`agent-community: group proposal analysis failed: ${String(error)}`)
      return { kind: 'failed' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** What a model's proposal answer means — keeping "one bot is enough" apart from "unreadable". */
export type ProposalDecision =
  | { readonly kind: 'no-group' }
  | { readonly kind: 'unreadable' }
  | {
    readonly kind: 'collaborate'
    readonly members: string[]
    readonly leaderId?: string | undefined
    readonly name?: string | undefined
    readonly reason?: string | undefined
  }

/**
 * Read the model's proposal answer.
 *
 * The distinction matters to the caller: `no-group` is a DECISION ("one bot is enough") and
 * must not be overruled by a deterministic fallback, while `unreadable` is the absence of an
 * answer and may be. Malformed JSON never produces a dialog that names unvetted bots.
 */
export function parseProposalDecision(text: string): ProposalDecision {
  const match = /\{[\s\S]*\}/u.exec(text)
  if (match === null) return { kind: 'unreadable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return { kind: 'unreadable' }
  }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'unreadable' }
  const record = parsed as Record<string, unknown>
  // Anything but an explicit `true` is "no group": a truthy-looking answer from a confused
  // model must never be read as permission to build a roster.
  if (record['collaborate'] !== true) return { kind: 'no-group' }
  const members = Array.isArray(record['members'])
    ? record['members'].filter((m): m is string => typeof m === 'string' && m !== '').slice(0, MAX_PROPOSED_MEMBERS)
    : []
  if (members.length === 0) return { kind: 'unreadable' }
  return {
    kind: 'collaborate',
    members,
    ...(typeof record['leader'] === 'string' && record['leader'] !== '' ? { leaderId: record['leader'] } : {}),
    ...(typeof record['name'] === 'string' && record['name'] !== '' ? { name: record['name'] } : {}),
    ...(typeof record['reason'] === 'string' && record['reason'] !== '' ? { reason: record['reason'] } : {}),
  }
}

/**
 * Read the model's proposal decision, keeping the historical shape.
 *
 * Anything that is not `collaborate: true` — including malformed JSON — means "no group":
 * the failure mode of a bogus roster must be a missing dialog, never a dialog naming bots
 * the user cannot see.
 */
export function parseProposalAnswer(text: string): { members: string[]; leaderId?: string | undefined; name?: string | undefined; reason?: string | undefined } | undefined {
  const decision = parseProposalDecision(text)
  if (decision.kind !== 'collaborate') return undefined
  return {
    members: decision.members,
    ...(decision.leaderId !== undefined ? { leaderId: decision.leaderId } : {}),
    ...(decision.name !== undefined ? { name: decision.name } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
  }
}
