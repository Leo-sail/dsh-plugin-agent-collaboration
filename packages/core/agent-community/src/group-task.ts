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
 */
import type { BotId, BotRoomId, FinishEvidence } from './types.ts'
import { rankByGoal } from './goal-attention.ts'

/** One member assignment, tracked so the leader can be told what is outstanding. */
export interface Assignment {
  readonly botId: string
  readonly task: string
  readonly at: string
  status: 'running' | 'done' | 'failed'
  result?: string | undefined
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
  readonly pendingReports: Array<{ botId: string; text: string; ok: boolean }>
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
    options?: { readonly internal?: boolean | undefined },
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
    }
    state.pendingReports.push({ botId: input.botId, text: input.text, ok: input.ok })
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
      assignment.result ??= '成员已离开本群，任务未完成'
      changed = true
    }
    const keptReports = state.pendingReports.filter(report => report.botId !== botId)
    if (keptReports.length !== state.pendingReports.length) {
      changed = true
      state.pendingReports.length = 0
      state.pendingReports.push(...keptReports)
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
    return { stalled: state.stalledRounds >= STALL_LIMIT, stalledRounds: state.stalledRounds }
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
      if (epochChanged || roundReset) this.save(roomId, state)
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
      assignment.result ??= reason
    }
    state.runningBotIds.clear()
    state.pendingReports.length = 0
    state.stalledRounds = 0
    this.save(roomId, state)
  }

  /** Record work the leader assigned through the `assign_task` tool. */
  assign(input: { roomId: string; botIds: readonly string[]; task: string }): { assigned: string[]; refused: string[] } {
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
      if (!this.accessor.enqueueRun(input.roomId, botId, prompt, { internal: false })) { refused.push(botId); continue }
      state.runningBotIds.add(botId)
      state.assignments.push({ botId, task: input.task, at: new Date().toISOString(), status: 'running' })
      assigned.push(botId)
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
    const state: GroupTaskState = restored ?? {
      round: 0,
      stalledRounds: 0,
      assignments: [],
      runningBotIds: new Set<string>(),
      pendingReports: [],
    }
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
    readonly tasks: ReadonlyArray<{ readonly botId: string; readonly task: string }>
  }): { assigned: readonly string[]; refused: readonly string[] } {
    const state = this.ensure(input.roomId)
    const room = this.accessor.roomById(input.roomId)
    if (room === undefined) return { assigned: [], refused: input.tasks.map(t => t.botId) }
    const assigned: string[] = []
    const refused: string[] = []
    for (const item of input.tasks) {
      if (!room.memberIds.includes(item.botId) || item.botId === this.accessor.leaderOf(input.roomId)) {
        refused.push(item.botId)
        continue
      }
      const prompt = this.memberPrompt(item.task, 'leader 派工')
      // Same rule as `assign`: dispatched work is the member's own visible contribution.
      if (!this.accessor.enqueueRun(input.roomId, item.botId, prompt, { internal: false })) {
        refused.push(item.botId)
        continue
      }
      state.runningBotIds.add(item.botId)
      state.assignments.push({
        botId: item.botId, task: item.task, at: new Date().toISOString(), status: 'running',
      })
      assigned.push(item.botId)
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
   */
  private leaderPrompt(roomId: string, userText: string): string {
    const room = this.accessor.roomById(roomId)
    const members = (room?.memberIds ?? []).map((id) => this.accessor.botName(id)).join('、')
    return [
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
   * DELIBERATELY PURE: the caller clears `pendingReports` only after the integration run was
   * actually queued. Clearing here lost the reports whenever the enqueue was refused (a paused
   * room, an executor that could not start) — the leader never saw what its members delivered,
   * and the next idle turn looked like a stall because the reports were gone.
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
      .map((r) => `· ${this.accessor.botName(r.botId)}${r.ok ? '' : '（失败）'}：${r.text}`)
      .join('\n')
    const outstanding = state.assignments
      .filter((a) => a.status === 'running')
      .map((a) => `· ${this.accessor.botName(a.botId)}：${a.task}`)
      .join('\n')
    return [
      '[成员汇报]',
      reports !== '' ? reports : '（本轮没有新的汇报）',
      ...(outstanding !== '' ? ['', '[仍在进行]', outstanding] : []),
      '',
      '请判断任务是否已经完成。',
      // 统一的发布口径（DUP-18）：成员的产出是它自己的正文，已经在群里；这里只做一次汇总。
      '已完成 → 调用 finish_task 一次性汇总并收尾：report 写清「做了什么、产出了什么、还剩什么」，'
        + '不要重复成员已经发布的内容。',
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
      '如果这项工作要求的信息你没有，直接说明缺什么，不要臆测。',
    ].join('\n')
  }
}

/** Re-exported for the service layer's state typing. */
export type { BotId, BotRoomId }
