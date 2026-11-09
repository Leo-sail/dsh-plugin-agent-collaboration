/**
 * GroupTaskDriver — the leader-driven loop that runs a group task to completion.
 *
 * HOW IT WORKS
 * A group's work is coordinated by its leader, not by a separate dispatcher agent.
 * One pass of the loop is:
 *
 *   user speaks in the group
 *     → leader runs a DISPATCH turn: it reads the request and decides who works,
 *       calling `assign_task` (enqueue each member) / `invite_bot` (recruit) /
 *       `finish_task` (report and stop)
 *     → assigned members run, in parallel
 *     → leader runs an INTEGRATE turn once they settle
 *     → repeat until `finish_task`, or until the no-progress guard fires
 *
 * The leader decides HOW MANY bots answer (R10): it names one, several or all, and
 * nothing here second-guesses that. Fanning out to every member on every message
 * would produce N duplicate replies, which is exactly what the old "nobody was
 * mentioned, so answer normally" rule caused.
 *
 * NO ROUND LIMIT (user decision). A task runs as long as it keeps making progress.
 * The only stop conditions are completion and the no-progress guard below — the
 * guard is deliberately NOT a counter of rounds, because a long legitimate task
 * looks identical to a stall if you only count rounds.
 *
 * The guard treats all of these as PROGRESS:
 *   · the leader assigned work
 *   · the leader produced new text
 *   · a member is still running
 *   · a member reported back since the last round
 *   · a compaction is in flight
 * Only when none holds for several consecutive rounds is the task considered stuck.
 *
 * P3-2: the leader keeps a long-lived ACCOUNT of the task (`state.ledger`: confirmed facts, the
 * current plan, a progress log) and both prompts render it before their own content, so a long
 * task's leader no longer re-derives what it already established. The stall decision itself is a
 * `termination.ts` rule (`stallLimit`), not an inlined counter comparison — the threshold and the
 * reason wording live in that module.
 */
import type { BotId, BotRoomId, FinishEvidence } from './types.ts'
import { rankByGoal } from './goal-attention.ts'
import {
  emptyLeaderLedger,
  mergeMemberReports,
  parseLeaderLedger,
  renderLeaderLedger,
  setPlan,
} from './leader-ledger.ts'
import type { LeaderLedger } from './leader-ledger.ts'
import { evaluateTermination, stallLimit } from './termination.ts'

/** One member assignment, tracked so the leader can be told what is outstanding. */
export interface Assignment {
  readonly botId: string
  readonly task: string
  readonly at: string
  status: 'running' | 'done' | 'failed'
  result?: string | undefined
  /**
   * P2-2: the leader declared this task needs FILE output.
   *
   * A requirement FLAG, never a gate: it lets the integrate turn and the adherence scorecard
   * tell "did not need a file" apart from "needed one and delivered none". `finish` still closes
   * the task when the file is missing — the user's explicit decision.
   */
  requiresDeliverables?: boolean | undefined
  /** Files the member declared with `agent_community_deliver` when it settled. */
  deliverables?: readonly string[] | undefined
  /**
   * The member's own outcome for this assignment: working while it runs, then done/failed.
   *
   * Persisted next to the board status because the board vocabulary has no "failed" — a stopped
   * or crashed member has to stay distinguishable from one that is still working.
   */
  reportedStatus?: 'working' | 'done' | 'failed' | undefined
}

/** Per-room coordination state. Backend only — there is deliberately no board UI. */
export interface GroupTaskState {
  round: number
  /** Consecutive rounds in which nothing moved. Reset by any progress signal. */
  stalledRounds: number
  readonly assignments: Assignment[]
  /** Members believed to be mid-run right now. */
  readonly runningBotIds: Set<string>
  /** Reports received since the leader last ran. */
  readonly pendingReports: Array<{
    botId: string
    text: string
    ok: boolean
    /**
     * Names of the files this member declared with `agent_community_deliver`.
     *
     * Absent/empty means the run produced NO deliverable — the leader must be able to see
     * that difference; before this field every report was prose and a member that only
     * described where a file "would be" looked identical to one that actually delivered.
     */
    deliverables?: readonly string[] | undefined
  }>
  /**
   * P3-2: the leader's long-lived task account (facts / plan / progress).
   *
   * Persisted with the board (`RoomTaskState.leaderLedger`) so a restart keeps it, and rendered
   * into the dispatch/integrate prompts so the leader reads what it already knows before deciding
   * what to do next. Reset by `beginTask` — a new user instruction starts a new account.
   */
  ledger: LeaderLedger
  /** The user instruction this task belongs to, so a finish cannot outlive its task. */
  instructionAt?: string | undefined
  /**
   * A closed task. `evidence`/`gate` come from the finish gate (OP-02): a task finished with
   * `bypassed` was let through after repeated rejections and is explicitly NOT verified.
   */
  finished?: {
    report: string
    at: string
    epoch?: string | undefined
    evidence?: readonly FinishEvidence[] | undefined
    gate?: 'passed' | 'bypassed' | undefined
  } | undefined
}

/** What the driver needs from the community service. */
export interface GroupTaskAccessor {
  /**
   * Enqueue a run for a bot in a room. Returns false when the bot cannot run.
   *
   * `internal` marks a turn that exists to move work between bots rather than to speak
   * to the user (the leader's integrate turn). Such a run is allowed to run and to call
   * `finish_task`, but its own prose must not be published as an answer — the user's
   * decision is that members stay visible and the integration restatement does not.
   * Omitted keeps the normal visible behaviour.
   */
  enqueueRun(
    roomId: string,
    botId: string,
    prompt: string,
    options?: {
      readonly internal?: boolean | undefined
      /**
       * S1-4: the assignment this run carries, so the run (and later the settle) can stamp a task
       * segment. Set for dispatched/assigned member work; the leader's integrate turn carries none.
       */
      readonly assignment?: { readonly subject: string; readonly fromName: string } | undefined
    },
  ): boolean
  /** Room membership, or undefined when the room is gone. */
  roomById(roomId: string): { readonly memberIds: readonly string[]; readonly directBotId?: string | undefined } | undefined
  /** The room's leader, falling back to the first member. */
  leaderOf(roomId: string): string | undefined
  /** Bot display name. */
  botName(botId: string): string
  /** True while a member of this room has a run in flight. */
  hasLiveRun(roomId: string): boolean
  /** True while any member's session is compacting — counts as busy, not stuck. */
  isCompacting(roomId: string): boolean
  /** Publish the leader's final report as an ordinary group message. */
  postReport(roomId: string, leaderId: string, report: string): void
  /** Persist coordination state. */
  saveTaskState(roomId: string, state: GroupTaskState): void
  /** Read persisted coordination state. */
  /** When the room's newest user instruction arrived. */
  lastUserMessageAt(roomId: string): string | undefined
  /**
   * OP-19: the room's current goal text, when it has one.
   *
   * Optional on the interface so a test/older accessor without goals still constructs; the
   * driver then keeps the pre-goal report order. The service returns `room.goal?.text`.
   */
  roomGoalText?(roomId: string): string | undefined
  loadTaskState(roomId: string): GroupTaskState | undefined
}

/**
 * Drop one member's lines from the task account.
 *
 * `forgetMember` forgets a removed member's pending report because it can no longer be
 * integrated; the account has to mirror that removal or the next prompt would still carry the
 * departed member's "confirmed fact" and plan line. Returns the SAME ledger when the member has
 * no lines, so the caller can skip a write cheaply.
 */
function withoutMemberLines(ledger: LeaderLedger, name: string, at: string): LeaderLedger {
  const progressPrefix = `[${name}] `
  const planPrefix = `${name}：`
  const facts = ledger.facts.filter(line => !line.startsWith(progressPrefix))
  const progress = ledger.progress.filter(line => !line.startsWith(progressPrefix))
  const plan = ledger.plan.filter(line => !line.startsWith(planPrefix))
  if (facts.length === ledger.facts.length && progress.length === ledger.progress.length && plan.length === ledger.plan.length) {
    return ledger
  }
  return { facts, progress, plan, updatedAt: at }
}

/**
 * Consecutive stalled rounds before the driver stops and reports.
 *
 * Mirrors the native goal driver's `blockedAfterConsecutiveRounds = 3`, which the
 * user asked to adopt: nothing may be declared blocked before round 3. Three is also
 * enough that a single slow round is never mistaken for a stall.
 */
const STALL_LIMIT = 3

export class GroupTaskDriver {
  private readonly accessor: GroupTaskAccessor
  private readonly states = new Map<string, GroupTaskState>()

  constructor(accessor: GroupTaskAccessor) {
    this.accessor = accessor
  }

  // NOTE: `onUserMessage` used to live here. It enqueued runs for a user message — the
  // same thing `routeMessage` does — and NOTHING ever called it (measured: zero call sites
  // outside this file). Two wake-up paths for one message is exactly how a room ends up
  // answering twice, so the dead one is gone rather than left as a trap; `routing.ts` is
  // the single decision point for who runs. `onMemberFinished`/`onLeaderIdle` below stay:
  // they are the "members are done → the leader continues" half, which the async dispatch
  // flow needs.

  /**
   * A member's run settled.
   *
   * A report is progress: the native driver's stall detector would otherwise treat
   * "member finished and said something" as an idle round, and stop a task that is
   * actually advancing.
   */
  async onMemberFinished(input: {
    roomId: string
    botId: string
    text: string
    ok: boolean
    /**
     * Files the member declared as deliverables for this run (from the ledger's
     * `deliverable` row). Empty means it finished without producing one.
     */
    deliverables?: readonly string[] | undefined
    /**
     * True when this member's turn was started by the leader — whatever tool carried it.
     *
     * Measured: the leader handed work over with `message_member` instead of `assign_task`, so no
     * assignment record existed and this driver refused to integrate — the member delivered 814
     * words and the leader was never woken to report them.
     */
    fromLeader?: boolean
  }): Promise<{ leaderRuns: boolean }> {
    const state = this.ensure(input.roomId)
    // ── NO HAND-OFF, NO INTEGRATION ─────────────────────────────────────────────
    //
    // Only a member that was GIVEN work needs the leader to pick the thread back up. A member
    // woken by `@mention` answers on its own, and the user's rule for that case is "the
    // mentioned bot replies" — waking the leader afterwards would add a model call per
    // mention and produce a second answer to the same message.
    const assignment = [...state.assignments].reverse().find((a) => a.botId === input.botId && a.status === 'running')
    if (assignment === undefined && input.fromLeader !== true) return { leaderRuns: false }
    state.runningBotIds.delete(input.botId)
    if (assignment !== undefined) {
      assignment.status = input.ok ? 'done' : 'failed'
      assignment.result = input.text
      assignment.reportedStatus = input.ok ? 'done' : 'failed'
      // These files are the SETTLE-TIME truth (the run's ledger rows), and they stay on the
      // assignment so a later integrate turn — after the report was drained — can still check
      // the delivery. Empty/absent both mean "the run declared no file".
      if (input.deliverables !== undefined) assignment.deliverables = [...input.deliverables]
    }
    state.pendingReports.push({
      botId: input.botId,
      text: input.text,
      ok: input.ok,
      ...(input.deliverables !== undefined ? { deliverables: [...input.deliverables] } : {}),
    })
    // ── P3-2: THE REPORT ALSO LANDS IN THE LONG-LIVED ACCOUNT ─────────────────
    //
    // `pendingReports` is drained after ONE integrate turn; the ledger is what survives it. The
    // fact (what came back) and the progress line (完成/失败) are written in the same step, so a
    // later integrate turn — or a restart — still sees the confirmed facts and how far the fan-out
    // got, instead of re-deriving them from the board.
    state.ledger = mergeMemberReports(state.ledger, [{
      name: this.accessor.botName(input.botId),
      text: input.text,
      ok: input.ok,
    }], new Date().toISOString()).ledger
    state.stalledRounds = 0
    this.save(input.roomId, state)

    if (state.finished !== undefined && !this.finishedIsStale(input.roomId, state)) return { leaderRuns: false }

    // Only integrate once the whole fan-out has settled — otherwise the leader runs
    // once per member and re-plans against a half-finished picture.
    if (state.runningBotIds.size > 0) return { leaderRuns: false }
    

    const leader = this.accessor.leaderOf(input.roomId)
    if (leader === undefined) return { leaderRuns: false }
    // ── THE INTEGRATION TURN IS COORDINATION, NOT AN ANSWER ─────────────────────
    //
    // The members' own replies are already in the room (that is the user's decision:
    // their output stays visible). This turn reads those replies and decides whether the
    // task is done; if it has something to deliver, that is `finish_task`'s report, which
    // the settle path publishes once. Rendering the turn's prose as well is what the user
    // saw as "the bot answered twice" — so it runs internal.
    const prompt = this.integratePrompt(input.roomId, state)
    const ok = this.accessor.enqueueRun(
      input.roomId,
      leader,
      prompt,
      { internal: true },
    )
    if (ok) {
      // Drained only once the turn is really queued: a refused enqueue keeps the reports for
      // the next attempt, and they count as progress for the stall guard meanwhile.
      state.pendingReports.length = 0
      state.runningBotIds.add(leader)
    }
    this.save(input.roomId, state)
    return { leaderRuns: ok }
  }

  /**
   * A member left the room (removed by the leader, kicked by the user, or its run was
   * cancelled as part of that removal).
   *
   * `maintenance.cleanupRemovedMembers` cancels the member's runs by writing state directly,
   * so `settleRun`/`afterRunSettled` never run for them — this driver would keep the member
   * in `runningBotIds` for ever, and `onMemberFinished`'s "integrate only once the whole
   * fan-out has settled" check (`runningBotIds.size > 0`) would never pass again. The room
   * then stalls silently: members answered, nobody integrates, no report.
   *
   * This is the missing half of a removal. It drops the member from the board, forgets its
   * report (it can no longer be integrated), and — when nothing else is outstanding — lets
   * the leader continue exactly as `onMemberFinished` would.
   */
  forgetMember(roomId: string, botId: string): void {
    const state = this.ensure(roomId)
    let changed = false
    if (state.runningBotIds.delete(botId)) changed = true
    for (const assignment of state.assignments) {
      if (assignment.botId !== botId || assignment.status !== 'running') continue
      assignment.status = 'failed'
      assignment.reportedStatus = 'failed'
      assignment.result ??= '成员已离开本群，任务未完成'
      changed = true
    }
    const keptReports = state.pendingReports.filter(report => report.botId !== botId)
    if (keptReports.length !== state.pendingReports.length) {
      changed = true
      state.pendingReports.length = 0
      state.pendingReports.push(...keptReports)
    }
    // The account's lines for this member describe work that is no longer part of the round.
    if (changed) {
      state.ledger = withoutMemberLines(state.ledger, this.accessor.botName(botId), new Date().toISOString())
    }
    this.save(roomId, state)

    // Nothing of this member was outstanding. Removing an idle member must not wake the
    // leader — that would be an integration turn for a message nobody sent.
    if (!changed) return
    if (state.finished !== undefined && !this.finishedIsStale(roomId, state)) return
    // Somebody else is still working: their own settle will integrate once the fan-out is done.
    if (state.runningBotIds.size > 0) return
    const leader = this.accessor.leaderOf(roomId)
    if (leader === undefined) return
    state.stalledRounds = 0
    const prompt = this.integratePrompt(roomId, state)
    const ok = this.accessor.enqueueRun(roomId, leader, prompt, { internal: true })
    if (ok) {
      state.pendingReports.length = 0
      state.runningBotIds.add(leader)
    }
    this.save(roomId, state)
  }

  /**
   * The leader's dispatch turn ended without assigning anything.
   *
   * This is the only place the stall counter moves, and it refuses to move while any
   * member is still running or a compaction is in flight: those ARE progress, and
   * counting them would stop long tasks.
   */
  async onLeaderIdle(input: { roomId: string; producedText: boolean }): Promise<{ stalled: boolean; stalledRounds: number }> {
    const state = this.ensure(input.roomId)
    state.runningBotIds.delete(this.accessor.leaderOf(input.roomId) ?? '')

    if (state.finished !== undefined && !this.finishedIsStale(input.roomId, state)) return { stalled: false, stalledRounds: 0 }

    const moved =
      input.producedText ||
      state.runningBotIds.size > 0 ||
      state.pendingReports.length > 0 ||
      this.accessor.hasLiveRun(input.roomId) ||
      this.accessor.isCompacting(input.roomId)

    if (moved) {
      state.stalledRounds = 0
      this.save(input.roomId, state)
      return { stalled: false, stalledRounds: 0 }
    }

    state.stalledRounds += 1
    this.save(input.roomId, state)
    // P3-2: the decision is the composable termination rule, not an inlined `>=`. Only the stall
    // condition is configured here (the other clocks live in runs.ts); the default threshold and
    // the returned shape are unchanged.
    const termination = evaluateTermination(stallLimit(STALL_LIMIT), {
      turns: 0,
      totalTokens: 0,
      lastText: '',
      elapsedMs: 0,
      stalledRounds: state.stalledRounds,
    })
    return { stalled: termination.stop, stalledRounds: state.stalledRounds }
  }

  /** The leader declared the task complete. */
  /**
   * A new instruction starts a new task.
   *
   * `finished` records that THIS task was delivered — it is not a property of the room. Left set,
   * it outlives its task and every later instruction in that room is never integrated: measured on
   * two consecutive writing tasks whose deliverables sat in the group with no report, because the
   * guard `state.finished !== undefined` kept returning early.
   */
  beginTask(roomId: string): void {
    const state = this.ensure(roomId)
    const at = this.accessor.lastUserMessageAt(roomId)
    // ── P3-2: A NEW INSTRUCTION GETS A FRESH TASK ACCOUNT ──────────────────────
    //
    // The previous task's facts/plan/progress describe work that is already closed (and stays
    // archived on that task's persisted board). Carrying them into the next instruction's prompts
    // would make the leader act on stale constraints, so the account starts empty here.
    const previousLedger = state.ledger
    state.ledger = emptyLeaderLedger(at ?? new Date().toISOString())
    const ledgerChanged = previousLedger.facts.length > 0
      || previousLedger.plan.length > 0
      || previousLedger.progress.length > 0
    // The epoch must be PERSISTED even when there is nothing else to reset: this early return
    // used to skip the save, so `instructionAt` stayed undefined while a stale `finished` (whose
    // epoch is also undefined) compared equal to it and kept blocking every later task.
    const epochChanged = at !== undefined && at !== state.instructionAt
    if (epochChanged) state.instructionAt = at
    // ── A NEW INSTRUCTION GETS A FRESH ROUND BUDGET ────────────────────────────
    //
    // The persisted board counts leader turns (`group-flow.advanceRound`) and stops the task
    // at `maxRounds`. That budget belongs to ONE instruction: without this reset a room that
    // had used up its rounds would finalise every later task on its first leader turn.
    const roundReset = state.round !== 0
    if (roundReset) state.round = 0
    if (state.finished === undefined) {
      if (epochChanged || roundReset || ledgerChanged) this.save(roomId, state)
      return
    }
    state.finished = undefined
    state.pendingReports.length = 0
    state.stalledRounds = 0
    this.save(roomId, state)
  }

  /**
   * Mirror the persisted board's round into the driver.
   *
   * The board is the authority for the round budget: `group-flow.advanceRound` increments it
   * and finalises it at `maxRounds`. Every `saveTaskState` writes THIS state's `round` back to
   * the board, so without the mirror the next save (a member finishing, a report arriving)
   * would roll the board back to the driver's stale value and the budget could never be spent.
   */
  adoptRound(roomId: string, round: number): void {
    const state = this.ensure(roomId)
    if (state.round === round) return
    state.round = round
    this.save(roomId, state)
  }

  /**
   * Whether the room's CURRENT task is already closed.
   *
   * `finished` is a property of a task, not of the room (see `finishedIsStale`): a record
   * written for an earlier instruction must not report the current one as done. The service
   * asks this before spending a round or moving the stall clock, so the leader turn that
   * called `finish_task` (and any turn after `stop`) is not counted against the next task.
   */
  isFinished(roomId: string): boolean {
    const state = this.ensure(roomId)
    return state.finished !== undefined && !this.finishedIsStale(roomId, state)
  }

  async finish(input: {
    roomId: string
    report: string
    /**
     * Evidence the service's finish gate accepted (OP-02). Stored on the finished record so a
     * delivered task can always be audited; absent only for callers that predate the gate.
     */
    evidence?: readonly FinishEvidence[] | undefined
    /** `bypassed` records that the gate was overridden after repeated rejections. */
    gate?: 'passed' | 'bypassed' | undefined
  }): Promise<void> {
    const state = this.ensure(input.roomId)
    state.finished = {
      report: input.report,
      at: new Date().toISOString(),
      epoch: state.instructionAt,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.gate !== undefined ? { gate: input.gate } : {}),
    }
    state.runningBotIds.clear()
    this.save(input.roomId, state)

    const leader = this.accessor.leaderOf(input.roomId)
    if (leader !== undefined) this.accessor.postReport(input.roomId, leader, input.report)
  }

  /**
   * Stop coordinating this room's task, from the driver's side.
   *
   * Budget exhaustion and the no-progress guard both end automation WITHOUT a `finish_task`:
   * the board is closed (so a late member settle cannot start another integration turn),
   * outstanding assignments are marked failed so the board does not keep claiming work that
   * nobody is doing, and queued reports are dropped (there is no turn left to read them).
   * The service records the user-facing notice: this class owns no transcript.
   *
   * `finished` (not a separate flag) is what suppresses later integration — exactly the same
   * record `finish_task` writes, so `onMemberFinished`/`forgetMember` need no new condition.
   */
  stop(roomId: string, reason: string): void {
    const state = this.ensure(roomId)
    state.finished = { report: reason, at: new Date().toISOString(), epoch: state.instructionAt }
    for (const assignment of state.assignments) {
      if (assignment.status !== 'running') continue
      assignment.status = 'failed'
      assignment.reportedStatus = 'failed'
      assignment.result ??= reason
    }
    state.runningBotIds.clear()
    state.pendingReports.length = 0
    state.stalledRounds = 0
    this.save(roomId, state)
  }

  /**
   * Record work the leader assigned through the `assign_task` tool.
   *
   * `requiresDeliverables` is copied onto every assignment it creates: the prompt and the
   * adherence scorecard need to know, per task, whether a file was REQUIRED, not just whether
   * one happened to be declared (P2-2).
   */
  assign(input: {
    roomId: string
    botIds: readonly string[]
    task: string
    requiresDeliverables?: boolean
  }): { assigned: string[]; refused: string[] } {
    const state = this.ensure(input.roomId)
    const room = this.accessor.roomById(input.roomId)
    const members = new Set(room?.memberIds ?? [])
    const assigned: string[] = []
    const refused: string[] = []

    for (const botId of input.botIds) {
      // Only members can be assigned. A non-member must be recruited first, which is
      // what keeps a group sealed: the leader cannot hand work to a bot it is not
      // allowed to perceive.
      if (!members.has(botId)) { refused.push(botId); continue }
      const prompt = this.memberPrompt(input.task, 'leader 分派')
      // A member's answer is visible on purpose (user decision 2): the user wants to see
      // who did what, so an assigned turn publishes like any other answer.
      if (!this.accessor.enqueueRun(input.roomId, botId, prompt, {
        internal: false,
        assignment: { subject: input.task, fromName: 'leader' },
      })) { refused.push(botId); continue }
      state.runningBotIds.add(botId)
      state.assignments.push({
        botId,
        task: input.task,
        at: new Date().toISOString(),
        status: 'running',
        reportedStatus: 'working',
        ...(input.requiresDeliverables === true ? { requiresDeliverables: true } : {}),
      })
      assigned.push(botId)
    }
    // ── P3-2: THE DISPATCH IS THE PLAN ────────────────────────────────────────
    //
    // "who was given what" is exactly the plan the leader needs on its next turn; a later
    // `assign` REPLACES it (setPlan is a batch replacement), because re-planning is a decision,
    // not an append. An all-refused call is not a dispatch and leaves the previous plan alone.
    if (assigned.length > 0) {
      state.ledger = setPlan(
        state.ledger,
        assigned.map(botId => `${this.accessor.botName(botId)}：${input.task}`),
        new Date().toISOString(),
      ).ledger
    }
    state.stalledRounds = 0
    this.save(input.roomId, state)
    return { assigned, refused }
  }

  /** Drop all coordination state for a room (dissolved, or messages cleared). */
  forget(roomId: string): void {
    this.states.delete(roomId)
  }

  private ensure(roomId: string): GroupTaskState {
    const live = this.states.get(roomId)
    if (live !== undefined) return live
    const restored = this.accessor.loadTaskState(roomId)
    const now = new Date().toISOString()
    // P3-2: the restored state normally carries a ledger (the host's board conversion parses
    // `RoomTaskState.leaderLedger`). Re-normalising it here keeps a board persisted by an OLDER
    // build — no `leaderLedger` field at all — working: the driver starts with an empty account
    // instead of throwing on its first prompt.
    const state: GroupTaskState = restored === undefined
      ? {
          round: 0,
          stalledRounds: 0,
          assignments: [],
          runningBotIds: new Set<string>(),
          pendingReports: [],
          ledger: emptyLeaderLedger(now),
        }
      : { ...restored, ledger: parseLeaderLedger(restored.ledger) ?? emptyLeaderLedger(now) }
    this.states.set(roomId, state)
    return state
  }

  private save(roomId: string, state: GroupTaskState): void {
    this.states.set(roomId, state)
    this.accessor.saveTaskState(roomId, state)
  }

  /**
   * Hand one specific task to each of several members — `dispatch`'s worker.
   *
   * Unlike `assign` (one task, many members), each member gets its own brief. Both end up in
   * the same bookkeeping, so one completion path (`onMemberFinished`) integrates either way.
   *
   * @param input.tasks - member id plus the brief for that member; already validated.
   * @returns which members were queued and which could not be.
   */
  assignEach(input: {
    readonly roomId: string
    readonly tasks: ReadonlyArray<{
      readonly botId: string
      readonly task: string
      /** P2-2: this member's brief must produce a file (same meaning as `assign`). */
      readonly requiresDeliverables?: boolean | undefined
    }>
  }): { assigned: readonly string[]; refused: readonly string[] } {
    const state = this.ensure(input.roomId)
    const room = this.accessor.roomById(input.roomId)
    if (room === undefined) return { assigned: [], refused: input.tasks.map(t => t.botId) }
    const assigned: string[] = []
    const refused: string[] = []
    const planLines: string[] = []
    for (const item of input.tasks) {
      if (!room.memberIds.includes(item.botId) || item.botId === this.accessor.leaderOf(input.roomId)) {
        refused.push(item.botId)
        continue
      }
      const prompt = this.memberPrompt(item.task, 'leader 派工')
      // Same rule as `assign`: dispatched work is the member's own visible contribution.
      if (!this.accessor.enqueueRun(input.roomId, item.botId, prompt, {
        internal: false,
        assignment: { subject: item.task, fromName: 'leader' },
      })) {
        refused.push(item.botId)
        continue
      }
      state.runningBotIds.add(item.botId)
      state.assignments.push({
        botId: item.botId,
        task: item.task,
        at: new Date().toISOString(),
        status: 'running',
        reportedStatus: 'working',
        ...(item.requiresDeliverables === true ? { requiresDeliverables: true } : {}),
      })
      assigned.push(item.botId)
      planLines.push(`${this.accessor.botName(item.botId)}：${item.task}`)
    }
    // P3-2: same rule as `assign` — the latest dispatch batch IS the current plan.
    if (planLines.length > 0) {
      state.ledger = setPlan(state.ledger, planLines, new Date().toISOString()).ledger
    }
    this.save(input.roomId, state)
    return { assigned, refused }
  }

  /**
   * The leader's dispatch prompt.
   *
   * It is told the roster it may use and that it decides how many run. `assign_task`
   * is described as the way to fan out so the leader does not try to do everything
   * itself, and `finish_task` as the only way to end.
   *
   * P3-2: when the task account has anything to say (a plan from the last dispatch, confirmed
   * facts, a stall hint) its block is rendered BEFORE the instruction, followed by a blank line.
   * The leader reads its own account first, then the request it is being asked to plan. Public so
   * the host (and the tests) can render the dispatch prompt for a room without guessing its text.
   */
  leaderPrompt(roomId: string, userText: string): string {
    const state = this.ensure(roomId)
    const ledger = renderLeaderLedger(state.ledger, { stalledRounds: state.stalledRounds })
    const room = this.accessor.roomById(roomId)
    const members = (room?.memberIds ?? []).map((id) => this.accessor.botName(id)).join('、')
    return [
      ...(ledger !== undefined ? [ledger, ''] : []),
      '[群任务调度]',
      `本群成员：${members}。`,
      '你是本群的协调者。请先判断用户这条消息需要几个 bot 来处理 —— 可能是一个、几个，或全部，由你决定。',
      '需要他人参与时，调用 assign_task 把工作分派出去（可以一次分派给多个）。',
      '发现某项工作更适合不在本群的 bot 时，调用 invite_bot 把他拉进来再分派。',
      '所有工作完成后，调用 finish_task 给出最终汇报。',
      '不要自己包办全部工作；也不要为了继续而继续。',
      '',
      '[用户消息]',
      userText,
    ].join('\n')
  }

  /**
   * True when the finish belongs to an EARLIER instruction.
   *
   * `finished` marks the task as delivered, but a room can be finishing one task while the user
   * has already started the next — measured: the leader completed the previous article's
   * verification AFTER the new instruction arrived, set `finished` again, and every later
   * integration in that room was blocked. Comparing epochs is exact; comparing times is not,
   * because that write happens after the new instruction.
   */
    private finishedIsStale(roomId: string, state: GroupTaskState): boolean {
      const done = state.finished
      if (done === undefined) return false
      // Epoch mismatch: the finish belongs to a different instruction.
      if (done.epoch !== state.instructionAt) return true
      // Or it is simply older than the instruction now being served. This second test is what
      // makes the check work even when no epoch was recorded: measured on a room whose finish
      // was written at 13:58 while the next instruction arrived at 14:45 — forty-seven minutes
      // earlier, yet it still blocked every integration because both epochs were undefined.
      const latest = this.accessor.lastUserMessageAt(roomId)
      return latest !== undefined && done.at < latest
    }

  /**
   * The leader's integrate prompt, with what came back since it last ran.
   *
   * Two delivery views, on purpose: `[成员汇报]` carries each NEW report (drained after one
   * turn), while `[交付核对]` is the persistent checklist generated from the board's settled
   * assignments, so what was actually handed over does not vanish with the inbox.
   *
   * DELIBERATELY PURE: the caller clears `pendingReports` only after the integration run was
   * actually queued. Clearing here lost the reports whenever the enqueue was refused (a paused
   * room, an executor that could not start) — the leader never saw what its members delivered,
   * and the next idle turn looked like a stall because the reports were gone.
   *
   * P3-2: the task account (facts / plan / progress / stall hint) is rendered BEFORE `[成员汇报]`,
   * followed by a blank line. The per-turn inbox stays exactly where it was; the account is the
   * part that survives the turn.
   */
  private integratePrompt(roomId: string, state: GroupTaskState): string {
    // ── OP-19: THE GOAL DECIDES WHICH REPORTS THE LEADER READS FIRST ─────────────
    //
    // No report is dropped and the failure/success split is kept: the ranking only decides the
    // order INSIDE each half. With no goal — or a goal none of the reports mention — `rankByGoal`
    // returns the arrival order untouched, so a goal-less room's prompt is byte-identical to the
    // pre-goal version.
    const ranked = rankByGoal(state.pendingReports.map(report => report.text), this.accessor.roomGoalText?.(roomId))
    const orderedReports = ranked
      .map(entry => state.pendingReports[entry.index])
      .filter((report): report is NonNullable<typeof report> => report !== undefined)
    const reportsForPrompt = [
      ...orderedReports.filter(report => !report.ok),
      ...orderedReports.filter(report => report.ok),
    ]
    const reports = reportsForPrompt
      .map((r) => {
        const head = `· ${this.accessor.botName(r.botId)}${r.ok ? '' : '（失败）'}：${r.text}`
        // Files vs no files is the line the leader acts on: a report that only describes
        // where a file "is" must not read like a delivery. Keep it one line per member.
        const files = r.deliverables ?? []
        const handedOver = files.length > 0
          ? `交付文件：${files.join('、')}`
          : '未交付文件（若这项任务要求文件产出，应要求补交或说明原因）'
        return `${head}\n  交付：${handedOver}`
      })
      .join('\n')
    const outstanding = state.assignments
      .filter((a) => a.status === 'running')
      .map((a) => `· ${this.accessor.botName(a.botId)}：${a.task}`)
      .join('\n')
    // ── P2-2: THE DELIVERY CHECKLIST COMES FROM THE BOARD, NOT THE INBOX ────────
    //
    // The per-report 交付 line above reads `pendingReports`, which the caller drains after ONE
    // integrate turn. This checklist is built from `state.assignments`, so what a member actually
    // handed over stays visible across turns (and after a restart): that is what lets the leader
    // notice a task that REQUIRED a file and still produced none. Running assignments are not
    // repeated here — their task text is already in [仍在进行] above.
    const deliveryCheck = state.assignments
      .filter((a) => a.status === 'done' || a.status === 'failed')
      .map((a) => {
        const name = this.accessor.botName(a.botId)
        if (a.status === 'failed') return `· ${name}：未完成`
        const files = a.deliverables ?? []
        if (files.length > 0) return `· ${name}：已完成；交付文件：${files.join('、')}`
        if (a.requiresDeliverables === true) {
          return `· ${name}：已完成；未交付文件（任务要求文件产出，应先要求补交或说明原因）`
        }
        return `· ${name}：已完成；未声明文件`
      })
      .join('\n')
    const ledger = renderLeaderLedger(state.ledger, { stalledRounds: state.stalledRounds })
    return [
      ...(ledger !== undefined ? [ledger, ''] : []),
      '[成员汇报]',
      reports !== '' ? reports : '（本轮没有新的汇报）',
      ...(deliveryCheck !== '' ? ['', '[交付核对]', deliveryCheck] : []),
      ...(outstanding !== '' ? ['', '[仍在进行]', outstanding] : []),
      '',
      '请判断任务是否已经完成。',
      // 统一的发布口径（DUP-18）：成员的产出是它自己的正文，已经在群里；这里只做一次汇总。
      '已完成 → 调用 finish_task 一次性汇总并收尾：report 写清「做了什么、产出了什么、还剩什么」，'
        + '不要重复成员已经发布的内容。',
      '如果任务要求文件产出，但某位成员的汇报显示「未交付文件」：先不要 finish，'
        + '用 assign_task 要求它补交（明确「必须调用 agent_community_deliver；只在正文写路径不算交付」）；'
        + '确实交不出时，在 finish_task 的 report 里如实写明是谁、缺什么。',
      '（如果成员的结果已经在群里、这一轮你没有新的内容要对用户说，就直接结束本轮，不要重复播报。）',
      '还需要工作 → 调用 assign_task 继续分派；不要再重复分派同一件事。',
    ].join('\n')
  }

  /**
   * A member's task prompt.
   *
   * Self-contained on purpose: members cannot see the leader's private chat and
   * cannot see its reasoning, so everything needed to act has to travel with the
   * assignment. Without this a member receives "do your part" and nothing else.
   */
  private memberPrompt(task: string, from: string): string {
    return [
      `[来自 ${from} 的任务]`,
      task,
      '',
      '完成后请简要汇报：你做了什么、产出在哪里、是否有未解决的问题。',
      '如果这项任务需要文件产出：结束前必须调用 agent_community_deliver 交付文件；'
        + '只在正文里写路径、不调用交付工具，对用户和队长来说不算交付。',
      '如果这项工作要求的信息你没有，直接说明缺什么，不要臆测。',
    ].join('\n')
  }
}

/** Re-exported for the service layer's state typing. */
export type { BotId, BotRoomId }
