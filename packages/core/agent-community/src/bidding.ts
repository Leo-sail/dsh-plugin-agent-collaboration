/**
 * Parallel bidding — a PURE, OPT-IN policy for "run two candidate answers and keep the better one".
 *
 * WHY THIS IS A POLICY MODULE AND NOT A FEATURE. Running the same task twice in parallel doubles
 * token spend and can double the visible output; it is only worth it when the task is genuinely
 * hard/ambiguous AND the room has another member to bid AND the budget is explicitly there.
 * Nothing in the plugin calls these functions by default: `runs`/`group-task` keep their current
 * single-answer behaviour until a caller (a future opt-in setting) asks this module what to do.
 * Keeping the decision here means the rule is testable without a host, a model or a run.
 *
 * THREE SMALL RULES:
 *   1. {@link shouldRunParallelBids} — gate: complex + ambiguous + ≥2 members + explicit budget.
 *   2. {@link scoreBid} / {@link selectWinningBid} — deterministic winner: evidence first, a
 *      reported finish path second, tool failures subtract. Near-ties (<5) keep the FIRST bid in
 *      input order instead of flipping a coin, so two identical observations never disagree.
 *   3. {@link bidBudget} — at most two candidates, each with a hard token cap.
 *
 * Pure on purpose: no timers, no randomness, no I/O. This module imports nothing.
 *
 * @module
 */

/** How hard the task looked to the router/leader. Only `complex` may bid. */
export type BidDifficulty = 'simple' | 'standard' | 'complex'

/** Minimum caller-estimated ambiguity (0..1) before bidding is even considered. */
export const PARALLEL_BID_MIN_AMBIGUITY = 0.6

/** Bidding needs at least two members: one candidate each. */
export const PARALLEL_BID_MIN_MEMBERS = 2

/** Never fan out wider than two candidates — the whole point is a cheap second opinion. */
export const PARALLEL_BID_MAX_BIDS = 2

/**
 * Smallest total budget that can pay for two candidates plus the judge comparison.
 *
 * Below this the "cheap second opinion" is a false economy: two truncated answers are worse than
 * one complete one, so the policy refuses rather than truncating both.
 */
export const PARALLEL_BID_MIN_BUDGET_TOKENS = 20_000

/** Budget used by {@link bidBudget} when the caller states none. */
export const PARALLEL_BID_DEFAULT_BUDGET_TOKENS = 120_000

/** How a candidate's turn ended, as the caller observed it. */
export type BidFinishPath = 'finish_task' | 'natural' | 'none' | 'failed'

/** One candidate answer under consideration. */
export interface BidCandidate {
  /** Unique within the bid round (for ordering); optional because the array order carries it. */
  readonly id?: string | undefined
  /** The answer text (verbatim). Only its length contributes to the score. */
  readonly text: string
  /** How many verifiable pieces of evidence the answer declared/accepted (0+). */
  readonly evidenceCount: number
  /** Which terminal path the candidate reached. */
  readonly finishPath: BidFinishPath
  /** Tool calls that errored during the candidate's turn (0+). */
  readonly toolFailures: number
}

/** Input for the parallel-bid gate. */
export interface ParallelBidInput {
  readonly difficulty: BidDifficulty
  /** 0..1; the caller's estimate (e.g. from routing confidence). NaN/out-of-range = unusable. */
  readonly ambiguity: number
  /** How many members the room could bid with. */
  readonly memberCount: number
  /**
   * The token budget the caller is willing to spend on this round. OMITTED means "not stated":
   * the policy cannot prove the budget is enough, so it refuses (conservative, and it keeps the
   * default path off without anyone having to remember a flag).
   */
  readonly budgetTokens?: number | undefined
}

/** The gate's answer. `reason` is a stable machine-ish string, safe to log. */
export interface ParallelBidDecision {
  readonly run: boolean
  readonly reason: string
}

/**
 * Decide whether this round MAY run two parallel candidates.
 *
 * Every condition must hold; the reason names the FIRST one that failed, in a fixed order, so a
 * log line explains the decision without reading this file.
 */
export function shouldRunParallelBids(input: ParallelBidInput): ParallelBidDecision {
  if (input.difficulty !== 'complex') {
    return { run: false, reason: `difficulty-not-complex(${String(input.difficulty)})` }
  }
  const ambiguity = input.ambiguity
  if (typeof ambiguity !== 'number' || !Number.isFinite(ambiguity) || ambiguity < PARALLEL_BID_MIN_AMBIGUITY) {
    return {
      run: false,
      reason: `ambiguity-below-threshold(${String(ambiguity)} < ${PARALLEL_BID_MIN_AMBIGUITY})`,
    }
  }
  const memberCount = input.memberCount
  if (typeof memberCount !== 'number' || !Number.isFinite(memberCount) || memberCount < PARALLEL_BID_MIN_MEMBERS) {
    return {
      run: false,
      reason: `not-enough-members(${String(memberCount)} < ${PARALLEL_BID_MIN_MEMBERS})`,
    }
  }
  if (input.budgetTokens === undefined) {
    return { run: false, reason: 'budget-not-stated' }
  }
  if (!Number.isFinite(input.budgetTokens) || input.budgetTokens < PARALLEL_BID_MIN_BUDGET_TOKENS) {
    return {
      run: false,
      reason: `budget-insufficient(${String(input.budgetTokens)} < ${PARALLEL_BID_MIN_BUDGET_TOKENS})`,
    }
  }
  return { run: true, reason: 'eligible' }
}

/** Component weights of {@link scoreBid}, exposed so tests and logs can explain a score. */
export interface BidScoreParts {
  /** Base for being a real candidate at all. */
  readonly base: number
  readonly evidence: number
  readonly finish: number
  readonly text: number
  readonly failures: number
}

/** A scored candidate. */
export interface ScoredBid {
  readonly bid: BidCandidate
  /** 0..100 integer. */
  readonly score: number
  readonly parts: BidScoreParts
}

/** Weight table (all deterministic; total maximum is 100). */
const BID_BASE = 40
const BID_PER_EVIDENCE = 8
const BID_MAX_EVIDENCE = 5
const BID_FINISH: Readonly<Record<BidFinishPath, number>> = {
  finish_task: 10,
  natural: 4,
  none: 0,
  failed: -20,
}
const BID_TEXT_MAX = 10
const BID_TEXT_CHARS_PER_STEP = 80
const BID_TEXT_STEP = 5
const BID_FAILURE_PENALTY = 5
const BID_MAX_FAILURE_PENALTY = 20
const BID_EMPTY_ANSWER_PENALTY = 15

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Collapse whitespace so an answer's "size" is its content, not its formatting. */
function answerLength(text: string): number {
  return text.replace(/\s+/gu, '').length
}

/**
 * Score one candidate deterministically, 0..100.
 *
 * The ordering follows the same evidence rule the plugin already uses elsewhere: a concrete
 * finish path and real evidence outrank prose; tool failures are a real cost. No model is
 * involved, so the same four numbers always produce the same score.
 */
export function scoreBid(bid: BidCandidate): number {
  return scoreBidDetailed(bid).score
}

/** {@link scoreBid} with the component breakdown, for tests/logs. */
export function scoreBidDetailed(bid: BidCandidate): ScoredBid {
  const evidenceCount = Number.isFinite(bid.evidenceCount) ? Math.max(0, Math.floor(bid.evidenceCount)) : 0
  const evidence = Math.min(BID_MAX_EVIDENCE, evidenceCount) * BID_PER_EVIDENCE
  const finish = BID_FINISH[bid.finishPath] ?? BID_FINISH.none
  const length = Number.isFinite(bid.text.length) ? answerLength(bid.text) : 0
  const text = length === 0
    ? -BID_EMPTY_ANSWER_PENALTY
    : Math.min(BID_TEXT_MAX, Math.floor(length / BID_TEXT_CHARS_PER_STEP) * BID_TEXT_STEP)
  const failures = Number.isFinite(bid.toolFailures) ? Math.max(0, Math.floor(bid.toolFailures)) : 0
  const failurePenalty = -Math.min(BID_MAX_FAILURE_PENALTY, failures * BID_FAILURE_PENALTY)
  const parts: BidScoreParts = { base: BID_BASE, evidence, finish, text, failures: failurePenalty }
  const total = BID_BASE + evidence + finish + text + failurePenalty
  return { bid, score: Math.round(clamp(total, 0, 100)), parts }
}

/** The result of picking a winner. */
export interface BidSelection {
  /** The winning candidate, or undefined for an empty round. */
  readonly winner: BidCandidate | undefined
  /** True when the top two were within the tie window; the FIRST input candidate then wins. */
  readonly tie: boolean
  /** Every candidate with its score, in input order. */
  readonly scored: readonly ScoredBid[]
}

/** Two candidates closer than this are a tie: keep the first rather than re-rolling. */
export const BID_TIE_WINDOW = 5

/**
 * Pick the winning candidate deterministically.
 *
 * Highest score wins. If the best two are within {@link BID_TIE_WINDOW} points, the FIRST input
 * candidate among the near-ties wins and `tie` is reported: no randomness, no dependence on the
 * numbers' decimal noise, and a stable transcript for a given input.
 */
export function selectWinningBid(bids: readonly BidCandidate[]): BidSelection {
  if (bids.length === 0) return { winner: undefined, tie: false, scored: [] }
  const scored = bids.map(bid => scoreBidDetailed(bid))
  let best = scored[0]!.score
  for (const entry of scored) if (entry.score > best) best = entry.score
  const nearTies = scored.filter(entry => entry.score > best - BID_TIE_WINDOW)
  if (nearTies.length > 1) {
    // "Keep the first" means the first in INPUT order that is actually close to the best.
    const firstNearTie = scored.find(entry => entry.score > best - BID_TIE_WINDOW)!
    return { winner: firstNearTie.bid, tie: true, scored }
  }
  return { winner: nearTies[0]!.bid, tie: false, scored }
}

/** Input for {@link bidBudget}. */
export interface BidBudgetInput {
  /** Requested candidates; clamped to 1..{@link PARALLEL_BID_MAX_BIDS}. Default 2. */
  readonly maxBids?: number | undefined
  /** Total tokens the caller can spend; default {@link PARALLEL_BID_DEFAULT_BUDGET_TOKENS}. */
  readonly totalTokens?: number | undefined
}

/** The token split for one bid round. Does NOT run anything. */
export interface BidBudget {
  readonly maxBids: number
  readonly totalTokens: number
  /** Hard cap for each candidate. */
  readonly perBidTokens: number
  /** One entry per candidate, so a caller cannot silently spend more than the cap. */
  readonly candidates: ReadonlyArray<{ readonly index: number; readonly tokenCap: number }>
}

/** Split a budget across at most two candidates. Pure arithmetic; nothing is executed. */
export function bidBudget(input: BidBudgetInput = {}): BidBudget {
  const requested = input.maxBids === undefined || !Number.isFinite(input.maxBids)
    ? PARALLEL_BID_MAX_BIDS
    : Math.floor(input.maxBids)
  const maxBids = clamp(requested, 1, PARALLEL_BID_MAX_BIDS)
  const totalTokens = input.totalTokens === undefined || !Number.isFinite(input.totalTokens) || input.totalTokens <= 0
    ? PARALLEL_BID_DEFAULT_BUDGET_TOKENS
    : Math.floor(input.totalTokens)
  const perBidTokens = Math.max(1, Math.floor(totalTokens / maxBids))
  const candidates = Array.from({ length: maxBids }, (_, index) => ({ index, tokenCap: perBidTokens }))
  return { maxBids, totalTokens, perBidTokens, candidates }
}
