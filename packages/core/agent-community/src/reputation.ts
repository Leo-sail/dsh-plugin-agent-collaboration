/**
 * Reputation watch (OP-18) — a quiet, data-driven "this member has been failing" signal.
 *
 * WHY THIS EXISTS. A group leader keeps dispatching work, and a member that has failed its last
 * few assignments looks exactly like a member that is still working: the board only says "done"
 * or "not done yet". The user asked for a WATCHDOG, not for automatic replacement: when a bot's
 * recent completion rate is low, say so once in the room and let the reader decide (swap the
 * member, or add context to the assignment). Nothing here changes a task, a run or a message.
 *
 * The statistics come from the persisted task board (`room.taskState.assignments`), so the watch
 * is derived from facts the plugin already records — no new persistence, no model call.
 *
 * @module
 */

/** The assignment fields the statistics read. */
export interface AssignmentLike {
  readonly botId: string
  /** `BotTaskStatus` plus the `failed` write used by member removal; treated as data. */
  readonly status?: string | undefined
  readonly report?: { readonly text: string; readonly at: string } | undefined
}

/** The persisted board shape (`RoomTaskState.assignments`). */
export interface RoomTaskStateLike {
  readonly assignments?: readonly AssignmentLike[] | undefined
}

/** The minimum a room needs: its task board, when it has one. */
export interface RoomReputationSource {
  readonly taskState?: RoomTaskStateLike | undefined
}

/** What one bot's board history says. */
export interface BotReputation {
  readonly botId: string
  /** Assignments it finished. */
  readonly done: number
  /** Assignments that failed, blocked or were cancelled. */
  readonly failed: number
  /** Assignments carrying a report (a member spoke about the work). */
  readonly reported: number
  /** Denominator of the completion rate: `done + failed`. */
  readonly samples: number
  /** `done / samples`; absent with fewer than {@link MIN_REPUTATION_SAMPLES} settled rows. */
  readonly successRate?: number | undefined
}

/** Below this many settled assignments a rate would be noise, so none is reported. */
export const MIN_REPUTATION_SAMPLES = 2

/** Default sample floor before the watchdog speaks (a 2-row sample is too thin to act on). */
export const REPUTATION_WATCH_MIN_SAMPLES = 4

/** Default completion rate below which the watchdog speaks. */
export const REPUTATION_WATCH_LOW_RATE = 0.4

/** One reminder per room per this interval — a watchdog that nags is just noise. */
export const REPUTATION_NOTICE_COOLDOWN_MS = 10 * 60_000

/** Assignment statuses that count as a completed piece of work. */
const DONE_STATUSES = new Set(['done'])
/** Assignment statuses that count as an unsuccessful piece of work. */
const FAILED_STATUSES = new Set(['failed', 'blocked', 'cancelled'])

/**
 * Completion statistics per bot, across the rooms given.
 *
 * Only the caller's rooms are read (the service passes one room or the whole board); a bot id
 * that appears in two rooms is aggregated, because the question the watchdog asks is about the
 * BOT, not about one board. Ordering is by bot id so the result is stable between polls.
 *
 * A rate needs {@link MIN_REPUTATION_SAMPLES} settled rows. `reported` is counted independently:
 * a reported assignment may still be `working`, and a report is evidence the member engaged even
 * before the leader marks it done.
 */
export function botReputations(rooms: readonly RoomReputationSource[]): BotReputation[] {
  const tallies = new Map<string, { done: number; failed: number; reported: number }>()
  for (const room of rooms) {
    const assignments = room.taskState?.assignments
    if (assignments === undefined) continue
    for (const assignment of assignments) {
      const botId = assignment.botId
      if (botId === undefined || botId === '') continue
      let tally = tallies.get(botId)
      if (tally === undefined) {
        tally = { done: 0, failed: 0, reported: 0 }
        tallies.set(botId, tally)
      }
      const status = assignment.status ?? ''
      if (DONE_STATUSES.has(status)) tally.done += 1
      else if (FAILED_STATUSES.has(status)) tally.failed += 1
      if (status === 'reported' || assignment.report !== undefined) tally.reported += 1
    }
  }
  return [...tallies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([botId, tally]) => {
      const samples = tally.done + tally.failed
      return {
        botId,
        done: tally.done,
        failed: tally.failed,
        reported: tally.reported,
        samples,
        ...(samples >= MIN_REPUTATION_SAMPLES ? { successRate: tally.done / samples } : {}),
      }
    })
}

export interface ReputationWatchOptions {
  /** Sample floor; defaults to {@link REPUTATION_WATCH_MIN_SAMPLES}. */
  readonly minSamples?: number | undefined
  /** Low-rate threshold; defaults to {@link REPUTATION_WATCH_LOW_RATE}. */
  readonly lowRate?: number | undefined
}

/**
 * The reputations worth one reminder, worst first.
 *
 * A bot qualifies when it has enough settled rows AND its completion rate is strictly below the
 * threshold. Ordering is by rate (worst first), then bot id, so the notice names the same bot
 * deterministically when several qualify.
 */
export function reputationWatch(
  reputations: readonly BotReputation[],
  options: ReputationWatchOptions = {},
): BotReputation[] {
  const minSamples = options.minSamples ?? REPUTATION_WATCH_MIN_SAMPLES
  const lowRate = options.lowRate ?? REPUTATION_WATCH_LOW_RATE
  return reputations
    .filter(rep => rep.successRate !== undefined
      && rep.samples >= minSamples
      && rep.successRate < lowRate)
    .sort((a, b) => ((a.successRate ?? 0) - (b.successRate ?? 0)) || a.botId.localeCompare(b.botId))
}

/**
 * The one line the room's transcript gets.
 *
 * Wording is fixed so the panel's notice typing (`建议换人或补上下文` is the actionable half) and
 * tests agree; it never claims a cause, because the board does not record one.
 */
export function reputationNoticeText(botName: string, reputation: BotReputation): string {
  return `声誉观察：${botName} 最近完成率偏低（${reputation.done}/${reputation.samples}），建议换人或补上下文。`
}

export interface ReputationWatchdogInput {
  readonly roomId: string
  /** The board(s) to derive statistics from — the service passes this room's board. */
  readonly rooms: readonly RoomReputationSource[]
  /** Display name for a bot id (the notice names a human, not an id). */
  readonly botName: (botId: string) => string
  /** Injectable clock, for tests. Defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
  /** Per-call overrides, forwarded to {@link reputationWatch}. */
  readonly options?: ReputationWatchOptions | undefined
}

/**
 * The throttle around {@link reputationWatch}: at most one reminder per room per cooldown.
 *
 * The service calls {@link check} after a group task closes (finish accepted or bypassed) and
 * writes the returned line as a room notice. State is in memory on purpose: a reminder that
 * survives a restart and arrives again after it would be the nag the cooldown exists to stop.
 */
export class ReputationWatchdog {
  private readonly cooldownMs: number
  private readonly lastNotifiedAt = new Map<string, number>()

  constructor(cooldownMs: number = REPUTATION_NOTICE_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs
  }

  /**
   * The notice to write for this room now, or undefined when there is nothing to say yet.
   *
   * Marks the room's cooldown only when it actually returns a line, so a quiet board does not
   * consume the window and a real signal right after it is still spoken.
   */
  check(input: ReputationWatchdogInput): string | undefined {
    const nowMs = input.nowMs ?? Date.now()
    const last = this.lastNotifiedAt.get(input.roomId)
    if (last !== undefined && nowMs - last < this.cooldownMs) return undefined
    const low = reputationWatch(botReputations(input.rooms), input.options)
    const worst = low[0]
    if (worst === undefined) return undefined
    this.lastNotifiedAt.set(input.roomId, nowMs)
    return reputationNoticeText(input.botName(worst.botId), worst)
  }
}
