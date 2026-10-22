/**
 * Goal-aware attention (OP-19) — when the leader reads many member reports, put the ones that
 * concern the room's goal first.
 *
 * WHY THIS EXISTS. `integratePrompt` joins every pending member report into the leader's turn
 * in arrival order. A long-running task produces reports about different sub-problems, and the
 * room's GOAL is the stable statement of what actually matters — the user's objective does not
 * change between rounds, while the reports pile up. Ordering the reports by how much they cover
 * the goal is a free way to spend the leader's attention where the user asked for it.
 *
 * WHAT IT IS NOT. No model call, no summarising, no dropping: this module only ORDERS indexes.
 * The caller keeps every report (failed reports first, by its own rule), and with no goal or no
 * lexical overlap the input order is returned untouched.
 *
 * @module
 */

/** A ranked position in the input array. `score` is only meaningful relative to its siblings. */
export interface RankedText {
  /** Index in the input `texts` array. */
  readonly index: number
  /** Coverage (0..1) of the goal's terms plus a small recency bonus. */
  readonly score: number
}

/** Weight of "this report is newer" relative to full goal coverage. */
const RECENCY_WEIGHT = 0.05

/** Goal terms kept for matching; bounded so a pasted objective cannot slow a prompt build. */
const MAX_GOAL_TERMS = 40

/**
 * Words that appear in almost every objective and therefore carry no attention signal — the
 * same reasoning as the router's stop terms, scoped to task descriptions.
 */
const GOAL_STOP_TERMS = new Set([
  '这个', '那个', '一个', '一下', '帮我', '请你', '需要', '以及', '并且', '然后', '可以',
  '我们', '你们', '他们', '进行', '完成', '任务', '目标', '工作', '内容', '相关',
  '好的', '好吧', '谢谢', '收到', '嗯嗯', '可以',
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'do', 'does', 'this', 'that', 'it', 'we', 'you', 'they', 'task', 'goal', 'work',
])

/**
 * The matching terms of a goal.
 *
 * CJK has no spaces, so a run of Han characters is split logically: the whole run (when long
 * enough) plus even-position bigrams, which is what catches "首页优化" in a report that says
 * "优化一下首页". Non-Han words are split on punctuation/whitespace and lower-cased. Terms shorter
 * than two characters are dropped — they match almost any sentence.
 */
export function goalTerms(goalText: string | undefined): string[] {
  if (goalText === undefined) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (term: string): void => {
    const lower = term.toLowerCase()
    if (lower.length < 2) return
    if (GOAL_STOP_TERMS.has(lower)) return
    if (seen.has(lower)) return
    seen.add(lower)
    out.push(lower)
  }
  for (const raw of goalText.split(/[^\p{L}\p{N}]+/u)) {
    const term = raw.trim()
    if (term.length < 2) continue
    push(term)
    if (term.length >= 4 && /^[\p{Script=Han}]+$/u.test(term)) {
      for (let i = 0; i + 2 <= term.length; i += 2) push(term.slice(i, i + 2))
    }
    if (out.length >= MAX_GOAL_TERMS) break
  }
  return out.slice(0, MAX_GOAL_TERMS)
}

/** How many of the goal's terms a report text contains. */
function coverageHits(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const hay = text.toLowerCase()
  if (hay === '') return 0
  let hits = 0
  for (const term of terms) if (hay.includes(term)) hits += 1
  return hits
}

/**
 * Order report texts by how much they cover the room's goal, newest first on ties.
 *
 *   · no texts → empty;
 *   · no goal, or a goal with no usable terms → the original order, score 0 for everyone;
 *   · a goal that no text mentions → the original order (a lexically unrelated batch is not
 *     evidence of relevance, so doing nothing is the honest answer);
 *   · otherwise coverage ranks first, and among EQUAL coverage the LATER index (newer report)
 *     wins by a small margin, so "最近优先" cannot outrank actual goal relevance.
 *
 * `limit` caps the returned list (the caller may ask for "the top N"), never the input.
 */
export function rankByGoal(
  texts: readonly string[],
  goalText: string | undefined,
  limit?: number | undefined,
): RankedText[] {
  const total = texts.length
  if (total === 0) return []
  const cap = limit === undefined ? total : Math.max(0, Math.min(total, Math.trunc(limit)))
  if (cap === 0) return []
  const untouched = (): RankedText[] => texts.slice(0, cap).map((_, index) => ({ index, score: 0 }))
  const terms = goalTerms(goalText)
  if (terms.length === 0) return untouched()
  const hits = texts.map(text => coverageHits(text, terms))
  if (!hits.some(hit => hit > 0)) return untouched()
  const ranked = texts.map((_, index) => {
    const coverage = (hits[index] ?? 0) / terms.length
    const recency = total > 1 ? index / (total - 1) : 1
    return { index, score: coverage + recency * RECENCY_WEIGHT }
  })
  ranked.sort((a, b) => (b.score - a.score) || (b.index - a.index))
  return ranked.slice(0, cap)
}
