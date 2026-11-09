/**
 * Collaboration priors (OP-11): how hard does this task look, and who has actually delivered in
 * this community before?
 *
 * WHY. Two cost/quality defects in the proposal path:
 *
 *   1. ROSTER SIZE WAS FLAT. Every proposal considered four candidates and the deterministic
 *      fallback proposed up to three members, whether the task was "translate this sentence" or
 *      "research the field, write a report, design a deck". A difficulty estimate turns the
 *      roster budget into a function of the task: simple → 2, standard → 3, complex → 4.
 *   2. HISTORY WAS IGNORED. A bot that has finished three assignments and one that has failed
 *      twice rank identically on static capability text. Past assignments on the room boards are
 *      already persisted, so they can break a near-tie WITHOUT overriding capability: fit scores
 *      stay primary, history only reorders candidates whose scores are within one point.
 *
 * Everything here is deterministic and pure: no clocks, no I/O, no model. The call site decides
 * how much authority to give these numbers (budget clamped by `MAX_PROPOSED_MEMBERS`; priors only
 * as a tie-break), so this module can never turn a guess into a roster.
 *
 * @module
 */

import type { RankedCandidate } from './capability.ts'

/** How much coordination a task looks like it needs. */
export type TaskDifficulty = 'simple' | 'standard' | 'complex'

/** Members a proposal may consider per difficulty. The caller clamps to its own hard cap. */
const ROSTER_BUDGET: Readonly<Record<TaskDifficulty, number>> = {
  simple: 2,
  standard: 3,
  complex: 4,
}

/** Short tasks with no multi-step language are the only ones called "simple". */
const SIMPLE_MAX_LENGTH = 40
/** A single request this long is multi-artifact by construction, whatever its words. */
const COMPLEX_MIN_LENGTH = 120

/**
 * Words that reliably describe heavy work (research, multi-artifact delivery, refactors).
 *
 * ONE such word is not enough to call a task complex — "把这篇公众号拆解一下" is a single
 * specialist job — but two of them together, or one in a long request, are.
 */
const HEAVY_MARKERS: readonly string[] = [
  '研究', '调研', '综述', '论文', '架构', '重构', '迁移', '部署', '评估', '数据分析',
  '多文件', '多个文件', '跨领域', '端到端', '完整方案', '全套', '拆解', '方案设计',
]

/** Connectors that mean "several things to do"; they disqualify the "simple" label. */
const MULTI_STEP_MARKERS: readonly string[] = [
  '并且', '同时', '然后', '接着', '还要', '以及', '分别', '各自', '一起', '协作', '配合',
]

function countMarkers(text: string, markers: readonly string[]): number {
  let hits = 0
  for (const marker of markers) {
    if (text.includes(marker)) hits += 1
  }
  return hits
}

/**
 * Estimate the task's difficulty from its own words.
 *
 * Deliberately conservative: an empty or unknown text is `standard` (the historical behaviour),
 * a task must be SHORT and free of both heavy and multi-step language to count as `simple`, and
 * a task must be long or carry several heavy markers to count as `complex`. A wrong `simple`
 * would shrink a roster that needed more members, so the bar for `simple` is the strictest.
 */
export function classifyTaskDifficulty(text: string): TaskDifficulty {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return 'standard'
  const length = normalized.length
  const heavy = countMarkers(normalized, HEAVY_MARKERS)
  const multiStep = countMarkers(normalized, MULTI_STEP_MARKERS)
  if (length >= COMPLEX_MIN_LENGTH || heavy >= 2) return 'complex'
  if (length <= SIMPLE_MAX_LENGTH && heavy === 0 && multiStep === 0) return 'simple'
  return 'standard'
}

/** The proposal-width budget for one difficulty (callers clamp it to their hard cap). */
export function rosterBudget(difficulty: TaskDifficulty): number {
  return ROSTER_BUDGET[difficulty]
}

// ── historical member priors ────────────────────────────────────────────────

/** The part of a room board this module reads (structural, so `BotRoom[]` is assignable). */
export interface PriorRoomInput {
  readonly taskState?: {
    readonly assignments?: readonly {
      readonly botId: string
      readonly status?: string | undefined
    }[] | undefined
  } | undefined
}

/** One member's collaboration record across the whole community. */
export interface MemberPrior {
  readonly done: number
  readonly failed: number
  readonly samples: number
  /** done / samples, in [0, 1]. Only present when `samples >= MIN_PRIOR_SAMPLES`. */
  readonly rate: number
}

/** A single success or failure proves nothing: priors start at two decided assignments. */
export const MIN_PRIOR_SAMPLES = 2

/** Assignment statuses that count as a delivered job vs a failed one. */
const DONE_STATUSES = new Set(['done'])
const FAILED_STATUSES = new Set(['blocked', 'cancelled'])

/**
 * Count each member's finished/failed assignments across every room's task board.
 *
 * Only DECIDED outcomes count: `done` is a success, `blocked`/`cancelled` a failure. An
 * assignment still `open`/`assigned`/`working`/`reported` is not evidence yet (counting a
 * reported-but-unverified job as a win is how a board with no finishes would look like a good
 * record). Members below {@link MIN_PRIOR_SAMPLES} decided outcomes are simply absent.
 */
export function historicalMemberPriors(rooms: readonly PriorRoomInput[]): Map<string, MemberPrior> {
  const done = new Map<string, number>()
  const failed = new Map<string, number>()
  for (const room of rooms) {
    for (const assignment of room.taskState?.assignments ?? []) {
      const botId = assignment.botId
      if (typeof botId !== 'string' || botId === '') continue
      const status = assignment.status ?? ''
      if (DONE_STATUSES.has(status)) done.set(botId, (done.get(botId) ?? 0) + 1)
      else if (FAILED_STATUSES.has(status)) failed.set(botId, (failed.get(botId) ?? 0) + 1)
    }
  }
  const priors = new Map<string, MemberPrior>()
  for (const botId of new Set([...done.keys(), ...failed.keys()])) {
    const wins = done.get(botId) ?? 0
    const losses = failed.get(botId) ?? 0
    const samples = wins + losses
    if (samples < MIN_PRIOR_SAMPLES) continue
    priors.set(botId, { done: wins, failed: losses, samples, rate: wins / samples })
  }
  return priors
}

// ── ranking with priors ─────────────────────────────────────────────────────

/** Two scores closer than this are a statistical tie: capability text alone cannot separate them. */
export const PRIOR_TIE_WINDOW = 1

interface IndexedCandidate {
  readonly candidate: RankedCandidate
  readonly index: number
}

/**
 * Neutral rate for a member with no decided assignments.
 *
 * Neutrality is the gentle reading: a proven winner (rate 1) still wins the tie-break, a proven
 * failure (rate 0) still loses it, and the untested member sits between them instead of being
 * pushed to the bottom — no history is not bad history.
 */
const NO_HISTORY_RATE = 0.5

function priorKey(candidate: RankedCandidate, priors: ReadonlyMap<string, MemberPrior>, index: number): {
  rate: number
  samples: number
  index: number
} {
  const prior = priors.get(candidate.botId)
  return {
    rate: prior?.rate ?? NO_HISTORY_RATE,
    samples: prior?.samples ?? 0,
    index,
  }
}

/**
 * Reorder candidates: capability first, history only inside near-ties.
 *
 * `score` remains the primary key. Within a window whose top score is less than
 * {@link PRIOR_TIE_WINDOW} above a candidate's score, a better success rate wins, then more
 * samples, then the input order. A member with no decided assignments counts as neutral (0.5),
 * so history neither invents a winner nor punishes a newcomer. With no priors at all the output
 * order equals the input order, which is what keeps the old behaviour for a community with no
 * history.
 */
export function rankWithPriors(
  candidates: readonly RankedCandidate[],
  priors: ReadonlyMap<string, MemberPrior>,
): RankedCandidate[] {
  const sorted: IndexedCandidate[] = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      if (right.candidate.score !== left.candidate.score) return right.candidate.score - left.candidate.score
      // Stable: equal scores keep the caller's order (capability.ts already made it meaningful).
      return left.index - right.index
    })
  const output: RankedCandidate[] = []
  let windowStart = 0
  while (windowStart < sorted.length) {
    let windowEnd = windowStart + 1
    const windowTop = sorted[windowStart]!.candidate.score
    while (windowEnd < sorted.length && windowTop - sorted[windowEnd]!.candidate.score < PRIOR_TIE_WINDOW) {
      windowEnd += 1
    }
    const window = sorted.slice(windowStart, windowEnd)
    if (window.length > 1 && priors.size > 0) {
      window.sort((left, right) => {
        const a = priorKey(left.candidate, priors, left.index)
        const b = priorKey(right.candidate, priors, right.index)
        if (a.rate !== b.rate) return b.rate - a.rate
        if (a.samples !== b.samples) return b.samples - a.samples
        return a.index - b.index
      })
    }
    for (const entry of window) output.push(entry.candidate)
    windowStart = windowEnd
  }
  return output
}
