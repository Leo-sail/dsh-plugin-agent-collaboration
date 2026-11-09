/**
 * proposalGate — should a DM message even be considered for a group?
 *
 * WHAT THIS SAVES. `detectProposal` asks the host to have the direct-chat bot judge the
 * message, which is ONE extra model call per message. Most DM messages are greetings, quick
 * questions or single-deliverable asks ("你好", "帮我查下天气", "把这句话润色一下") — asking a
 * model whether those "should become a group" is a call whose answer is always no. The gate
 * skips the obviously-single-turn message and lets every collaborative-looking one through.
 *
 * WHAT IT IS NOT. This is a heuristic that only decides whether to ask the model — it does
 * NOT decide that a group is needed, and it is NOT the user's explicit group-creation path:
 *
 *   · a bot that announced a group with `propose_group` still reaches the user through the
 *     snapshot's pending proposal, whatever this gate says about the text;
 *   · a user who wants a group can always create one from the sidebar, and a user who
 *     declined a proposal is not asked again for that room this session.
 *
 * So a false negative costs a missed auto-suggestion (the explicit paths still work), and a
 * false positive costs one model call — which is why the thresholds below are permissive.
 *
 * @module
 */

/**
 * Words that mean "this message involves more than one step or more than one worker".
 *
 * A single hit is enough: "分别写…" / "同时整理…" / "分工…" only make sense when the work is
 * being split, and "一起/协作/汇总/建群/多个" name collaboration explicitly.
 */
const COLLABORATION_WORDS = [
  '一起', '协作', '分工', '分别', '同时', '汇总', '建群', '多个',
] as const

/**
 * Deliverable nouns. TWO distinct ones mean the task probably wants parallel work
 * (a report plus a deck, code plus tests, an image plus copy) — one noun alone is still a
 * normal single-bot request.
 */
const DELIVERABLE_WORDS = [
  '报告', '方案', '图', '表', '文案', '代码', '论文', '案例', '数据',
] as const

/** At or beyond this length the message is a task description, not a greeting. */
export const GROUP_GATE_MIN_CHARS = 60

/**
 * Whether the panel should ask the host to consider a group for this message.
 *
 * Order matters only for readability: every true rule returns true, and the fall-through is
 * false (do not spend the call). A blank or whitespace-only message never qualifies.
 */
export function shouldConsiderGroup(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return false
  if (COLLABORATION_WORDS.some(word => normalized.includes(word))) return true
  let deliverableHits = 0
  for (const word of DELIVERABLE_WORDS) {
    if (normalized.includes(word)) deliverableHits++
    if (deliverableHits >= 2) return true
  }
  // Long messages are task briefs far more often than chat: a 60+ character DM with no
  // keyword still deserves the host's judgement.
  if ([...normalized].length >= GROUP_GATE_MIN_CHARS) return true
  return false
}
