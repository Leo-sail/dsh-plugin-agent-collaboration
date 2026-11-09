/**
 * Proposal policy (OP-10): when can the deterministic roster skip the extra model call, and how
 * is a model's answer validated?
 *
 * WHY. Every direct-chat group proposal paid for a second model call (`consultModel`) just to
 * pick members from a shortlist the capability ranking had already ordered. For the common case —
 * a short, simple task where the shortlist is exactly the source bot plus one clear fit — the
 * model can only echo the ranking, so the call is pure cost.
 *
 * The shortcut is deliberately CONSERVATIVE (SKIP only when every condition holds):
 *
 *   · the shortlist has exactly two candidates (source bot + one other);
 *   · the task classifies as `simple` (see `collaboration-priors.ts`);
 *   · the other candidate has a real, non-marginal fit score — not a 0.5 boundary accident;
 *   · the source bot is on the shortlist and is the selected leader.
 *
 * Anything else (ambiguous task, low score, larger shortlist, missing source) falls through to
 * the existing model consult, and a skipped selection is still validated by
 * {@link validateConsultDecision} before it becomes a proposal — a skipped model must never be a
 * skipped check.
 *
 * @module
 */

import {
  MIN_PROPOSED_MEMBERS,
  fallbackSelection,
  sanitizeCollaborateSelection,
  type CollaborateSelection,
  type RankedCandidate,
} from './capability.ts'
import { classifyTaskDifficulty } from './collaboration-priors.ts'

/**
 * Fit score a non-source candidate needs before the model is considered redundant.
 *
 * `rankCandidates` adds 3 for a skill-name hit, 2 for description/domain prose, 0.5 for a
 * boundary mention. Two points means "the bot's own description/domains talk about this task" —
 * a single boundary word does not, and such a marginal candidate is exactly the case where the
 * model's judgement is still worth paying for.
 */
export const SKIP_CONSULT_FIT_FLOOR = 2

/** The user-facing reason attached to a deterministically selected roster. */
export const DETERMINISTIC_SELECTION_REASON = '按能力匹配确定性选人，省去一次模型判断'

/** The inputs the policy reads: a shortlist entry needs only identity + fit score. */
export interface SkipModelConsultInput {
  readonly shortlist: readonly { readonly botId: string; readonly score: number }[]
  /** The bot the user is already talking to — the shortlist's anchor and the default leader. */
  readonly directBotId?: string | undefined
  readonly taskText: string
  /** The caller's hard cap (group-flow passes its `MAX_PROPOSED_MEMBERS`). */
  readonly maxMembers: number
}

export interface DeterministicRoster {
  readonly members: readonly string[]
  readonly leaderId: string
}

/**
 * `false` = ask the model (the historical path). An object = skip it with this roster.
 *
 * The `selection` is intentionally optional in the type even though every SKIP produced here
 * carries one: the call site must handle "skip without a usable roster" by falling back to the
 * model rather than by proposing nothing.
 */
export type SkipModelConsult =
  | { readonly skip: true; readonly reason: string; readonly selection?: DeterministicRoster | undefined }
  | false

/**
 * Should this proposal skip the model consult and use the ranked shortlist verbatim?
 *
 * Conservative by construction: every input is a guard, and a skipped selection is still
 * validated by the caller (`validateConsultDecision`). See the module header for the rules.
 */
export function shouldSkipModelConsult(input: SkipModelConsultInput): SkipModelConsult {
  const text = input.taskText.trim()
  if (text === '') return false
  const sourceBotId = input.directBotId
  if (sourceBotId === undefined || sourceBotId === '') return false
  if (input.maxMembers < MIN_PROPOSED_MEMBERS) return false
  // Only the exact "source + one clear fit" shape is unambiguous enough to skip.
  if (input.shortlist.length !== 2) return false
  const source = input.shortlist.find(candidate => candidate.botId === sourceBotId)
  const other = input.shortlist.find(candidate => candidate.botId !== sourceBotId)
  if (source === undefined || other === undefined) return false
  // A marginal candidate (a boundary-word-only 0.5 hit) is not a clear match.
  if (other.score < SKIP_CONSULT_FIT_FLOOR) return false
  // A task the classifier is not confident about keeps the model call: shrinking the roster of a
  // complex task by skipping its consult is the one failure this shortcut must never cause.
  if (classifyTaskDifficulty(text) !== 'simple') return false

  const ranked: RankedCandidate[] = input.shortlist.map(candidate => ({
    botId: candidate.botId,
    score: candidate.score,
    matched: [],
  }))
  // Reuse the deterministic roster rule and the source-bot leader rule; do not invent a second
  // selection implementation.
  const selection = fallbackSelection(ranked, sourceBotId)
  if (selection === undefined || selection.members.length < MIN_PROPOSED_MEMBERS) return false
  return {
    skip: true,
    reason: DETERMINISTIC_SELECTION_REASON,
    selection: { members: selection.members, leaderId: selection.leaderId },
  }
}

/** A model's member/leader answer, before validation. */
export interface ConsultDecision {
  readonly members: readonly string[]
  readonly leaderId?: string | undefined
}

export type ConsultDecisionCheck =
  | { readonly ok: true; readonly selection: CollaborateSelection }
  | { readonly ok: false; readonly reason: string; readonly dropped: readonly string[] }

/**
 * Validate a model's selection against the shortlist it was given.
 *
 * This is the inline logic `decideMembers` used to own, extracted so the shortcut, the model path
 * and the tests share one rule: members outside `allowedIds` were never offered and are dropped;
 * the result must still have at least {@link MIN_PROPOSED_MEMBERS} members; the leader is forced
 * to a member (the source bot when valid — `sanitizeCollaborateSelection` owns that choice).
 *
 * A failure returns the reason (and the unoffered names) for logging/tests; the caller's fallback
 * to the deterministic roster is unchanged.
 */
export function validateConsultDecision(
  decision: ConsultDecision,
  allowedIds: readonly string[],
  sourceBotId: string | undefined,
  maxMembers: number,
): ConsultDecisionCheck {
  const allowed = new Set(allowedIds)
  const dropped = decision.members.filter(member => !allowed.has(member))
  const selection = sanitizeCollaborateSelection(
    { members: decision.members, ...(decision.leaderId !== undefined ? { leaderId: decision.leaderId } : {}) },
    allowedIds,
    sourceBotId,
    maxMembers,
  )
  if (selection !== undefined) return { ok: true, selection }
  const reason = dropped.length > 0
    ? `模型选择了不在候选名单内的成员：${dropped.join('、')}；有效成员不足 ${MIN_PROPOSED_MEMBERS} 个`
    : `模型给出的成员不足 ${MIN_PROPOSED_MEMBERS} 个，无法建群`
  return { ok: false, reason, dropped }
}
