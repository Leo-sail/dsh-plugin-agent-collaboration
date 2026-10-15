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
    const existing = room.pendingGroupProposal
    if (existing !== undefined && existing.status === 'pending') {
      if (!this.expired(existing)) return this.toProposal(existing)
      this.resolveExpired(room, existing)
    }

    const alive = this.port.listBots()
    // A group needs at least two participants; with one bot in the community there
    // is nothing to propose and no model call to pay for.
    if (alive.length < 2) return undefined

    const explicit = (input.memberIds ?? []).filter(id => typeof id === 'string' && id !== '')
    const decided = explicit.length > 0
      ? {
        members: explicit,
        leaderId: input.leaderId,
        name: input.name,
        reason: input.reason,
      }
      : await this.consultModel(room, sourceBot, message.text, alive)
    if (decided === undefined) return undefined

    const members: BotId[] = []
    for (const rawId of [room.directBotId, ...decided.members]) {
      const id = alive.find(b => b.id === rawId)?.id ?? alive.find(b => b.name === rawId)?.id
      if (id === undefined || members.includes(id)) continue
      members.push(id)
    }
    if (members.length < 2) return undefined

    const leaderId = members.find(id => id === decided.leaderId)
      ?? members.find(id => id === room.directBotId)
      ?? members[0]!
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
      leaderId,
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
    const leaderId = members.includes(proposal.leaderId) ? proposal.leaderId : members[0]!
    const leaderName = alive.get(leaderId)?.name ?? leaderId
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
    this.port.queueRun({ roomId: group.id, botId: leaderId, prompt: proposal.taskText, origin: 'user' })
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
        // Measured on a live group: the user asked to remove the coordinator, the request was
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
   */
  handoffLeadership(roomId: string, removedBotId: string): BotId | undefined {
    const room = this.port.getRoom(roomId)
    if (room === undefined || room.directBotId !== undefined) return undefined
    if (this.leaderIdOf(room) !== removedBotId) return undefined
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

  /** The room's leader bot id, when the room is a leader-driven group. */
  leaderIdOf(room: BotRoom): BotId | undefined {
    const leader = room.team?.leader
    return leader !== undefined && leader.kind === 'bot' ? leader.botId : undefined
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
    }
    this.port.saveRoom({ ...room, taskState: state, updatedAt: this.port.now() })
    return state
  }

  /** Leader-only: put one member on the board. */
  assignTask(input: AssignRoomTaskInput): RoomTaskState {
    const { room, state } = this.leaderBoard(input.roomId, input.actorBotId)
    const bot = this.port.getBot(input.botId)
    if (bot === undefined) throw new Error(`Bot "${input.botId}" not found`)
    const next: RoomTaskState = {
      ...state,
      assignments: [...state.assignments, {
        id: this.port.nextId(),
        botId: bot.id,
        task: input.task,
        at: this.port.now(),
        status: 'assigned',
      }],
    }
    this.port.saveRoom({ ...room, taskState: next, updatedAt: this.port.now() })
    return next
  }

  /**
   * Report progress on one row.
   *
   * A member may only write its OWN row; the leader may write any row. Anyone else
   * is refused — the board is the shared record of who promised what, and letting a
   * member edit another's row makes it worthless as evidence.
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
    const assignments = [...state.assignments]
    assignments[index] = {
      ...entry,
      status: input.status ?? 'working',
      report: { text: input.text, at: this.port.now() },
    }
    const next: RoomTaskState = { ...state, assignments }
    this.port.saveRoom({ ...room, taskState: next, updatedAt: this.port.now() })
    return next
  }

  /** Leader-only: close the round. Exhausting `maxRounds` finalises the board (§5.5). */
  advanceRound(input: TaskBoardActor): RoomTaskState {
    const { room, state } = this.leaderBoard(input.roomId, input.actorBotId)
    const round = state.round + 1
    const next: RoomTaskState = round > state.maxRounds
      ? { ...state, round, finished: { report: `已达轮次上限 ${state.maxRounds}，收尾`, at: this.port.now() } }
      : { ...state, round }
    this.port.saveRoom({ ...room, taskState: next, updatedAt: this.port.now() })
    return next
  }

  /** Leader-only: the board's final report (§24.8 — this is what the user reads). */
  finishTask(input: TaskBoardActor & { report: string }): RoomTaskState {
    const { room, state } = this.leaderBoard(input.roomId, input.actorBotId)
    const next: RoomTaskState = { ...state, finished: { report: input.report, at: this.port.now() } }
    this.port.saveRoom({ ...room, taskState: next, updatedAt: this.port.now() })
    return next
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

  /** The direct-chat bot's own judgement, via a session-less model call. */
  private async consultModel(
    room: BotRoom,
    sourceBot: BotIdentity | undefined,
    text: string,
    alive: readonly BotIdentity[],
  ): Promise<{ members: string[]; leaderId?: string | undefined; name?: string | undefined; reason?: string | undefined } | undefined> {
    const stream = this.port.stream()
    if (stream === undefined || sourceBot?.provider === undefined || sourceBot.model === undefined) return undefined
    if (text.trim() === '') return undefined
    const roster = alive.slice(0, 40).map(b => {
      const description = (b.description ?? '').replace(/\s+/gu, ' ').slice(0, 120)
      return `- id=${b.id} 名称=${b.name}${description === '' ? '' : ` 角色=${description}`}`
    }).join('\n')
    const system = [
      '你是一个协作调度助手。判断用户这条消息是否需要多个 Bot 协作完成。',
      '只输出一个 JSON 对象，不要输出解释或 Markdown 代码块。',
      '需要协作时：{"collaborate":true,"name":"群名","members":["bot id",...],"leader":"bot id","reason":"一句话理由"}',
      `members 至少 2 个、最多 ${MAX_PROPOSED_MEMBERS} 个，且必须来自给出的名单（用 id 字段）。`,
      '一个 Bot 就能完成时：{"collaborate":false}',
    ].join('\n')
    const user = [
      '[用户消息]',
      text.slice(0, 4_000),
      '',
      '[可选的 Bot 名单]',
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
      const parsed = parseProposalAnswer(answer)
      if (parsed === undefined) return undefined
      return parsed
    } catch (error: unknown) {
      // No proposal is always an acceptable answer: the direct chat keeps working.
      this.port.logger?.warn?.(`agent-community: group proposal analysis failed: ${String(error)}`)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Read the model's proposal decision.
 *
 * Anything that is not `collaborate: true` — including malformed JSON — means "no
 * group": the failure mode of a bogus roster must be a missing dialog, never a
 * dialog naming bots the user cannot see.
 */
export function parseProposalAnswer(text: string): { members: string[]; leaderId?: string | undefined; name?: string | undefined; reason?: string | undefined } | undefined {
  const match = /\{[\s\S]*\}/u.exec(text)
  if (match === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (record['collaborate'] !== true) return undefined
  const members = Array.isArray(record['members'])
    ? record['members'].filter((m): m is string => typeof m === 'string' && m !== '').slice(0, MAX_PROPOSED_MEMBERS)
    : []
  if (members.length === 0) return undefined
  return {
    members,
    ...(typeof record['leader'] === 'string' && record['leader'] !== '' ? { leaderId: record['leader'] } : {}),
    ...(typeof record['name'] === 'string' && record['name'] !== '' ? { name: record['name'] } : {}),
    ...(typeof record['reason'] === 'string' && record['reason'] !== '' ? { reason: record['reason'] } : {}),
  }
}
