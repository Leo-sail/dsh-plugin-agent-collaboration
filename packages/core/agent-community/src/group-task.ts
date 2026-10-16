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
import type { BotId, BotRoomId } from './types.ts'

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
  finished?: { report: string; at: string } | undefined
}

/** What the driver needs from the community service. */
export interface GroupTaskAccessor {
  /** Enqueue a run for a bot in a room. Returns false when the bot cannot run. */
  enqueueRun(roomId: string, botId: string, prompt: string): boolean
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
  }): Promise<{ leaderRuns: boolean }> {
    const state = this.ensure(input.roomId)
    // ── NO HAND-OFF, NO INTEGRATION ─────────────────────────────────────────────
    //
    // Only a member that was GIVEN work needs the leader to pick the thread back up. A member
    // woken by `@mention` answers on its own, and the user's rule for that case is "the
    // mentioned bot replies" — waking the leader afterwards would add a model call per
    // mention and produce a second answer to the same message.
    const assignment = [...state.assignments].reverse().find((a) => a.botId === input.botId && a.status === 'running')
    if (assignment === undefined) return { leaderRuns: false }
    state.runningBotIds.delete(input.botId)
    assignment.status = input.ok ? 'done' : 'failed'
    assignment.result = input.text
    state.pendingReports.push({ botId: input.botId, text: input.text, ok: input.ok })
    state.stalledRounds = 0
    this.save(input.roomId, state)

    if (state.finished !== undefined) return { leaderRuns: false }

    // Only integrate once the whole fan-out has settled — otherwise the leader runs
    // once per member and re-plans against a half-finished picture.
    if (state.runningBotIds.size > 0) return { leaderRuns: false }

    const leader = this.accessor.leaderOf(input.roomId)
    if (leader === undefined) return { leaderRuns: false }
    // ── NO AUTOMATIC LEADER RUN ─────────────────────────────────────────────
    //
    // This used to enqueue an integrate run for the leader as soon as every assigned member
    // had settled. Measured on a one-line greeting that produced a whole extra leader turn —
    // a '搞定 ✅' bulletin with a table — which the user counted as a duplicate reply and,
    // correctly, said should never have run: the member's answer already was the result.
    //
    // The leader is woken by a member's own report (message_member) instead. That is the
    // hand-off the prompt asks members for, and it carries the leader's attention only when a
    // member actually has something to hand over.
    const ok = false
    if (ok) state.runningBotIds.add(leader)
    this.save(input.roomId, state)
    return { leaderRuns: ok }
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

    if (state.finished !== undefined) return { stalled: false, stalledRounds: 0 }

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
  async finish(input: { roomId: string; report: string }): Promise<void> {
    const state = this.ensure(input.roomId)
    state.finished = { report: input.report, at: new Date().toISOString() }
    state.runningBotIds.clear()
    this.save(input.roomId, state)

    const leader = this.accessor.leaderOf(input.roomId)
    if (leader !== undefined) this.accessor.postReport(input.roomId, leader, input.report)
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
      if (!this.accessor.enqueueRun(input.roomId, botId, prompt)) { refused.push(botId); continue }
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
      if (!this.accessor.enqueueRun(input.roomId, item.botId, prompt)) {
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

  /** The leader's integrate prompt, with what came back since it last ran. */
  private integratePrompt(roomId: string, state: GroupTaskState): string {
    const reports = state.pendingReports
      .map((r) => `· ${this.accessor.botName(r.botId)}${r.ok ? '' : '（失败）'}：${r.text}`)
      .join('\n')
    state.pendingReports.length = 0
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
      '已完成 → 调用 finish_task 给出最终汇报。',
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
