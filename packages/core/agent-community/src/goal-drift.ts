/**
 * Goal drift watchdog (OP-13): notice when a room's work stops matching its stated goal.
 *
 * WHY THIS MODULE EXISTS. A room can have an active goal (an authorized objective that keeps
 * the conversation moving) and still slowly walk away from it — the user says "先不管那个，
 * 换个方向", or the bots spend several turns on an unrelated tangent. Today nothing notices:
 * the goal keeps spending authorized rounds on work it was not granted for.
 *
 * The watchdog is a WARNING, never an action: it returns a level + score, and the service may
 * write ONE visible notice per room per 10 minutes. It never pauses a goal, never cancels a run
 * and never spends tokens. The judgement is deterministic (keyword coverage + explicit
 * off-topic phrases), so it is testable and explainable — no model call.
 *
 * Deliberately conservative: a short reply is not drift, a goal without extractable keywords is
 * not drift, and any level below `watch` is silent.
 *
 * @module
 */

/** Replies shorter than this (in code points) are too short to judge. */
export const GOAL_DRIFT_MIN_REPLY_CHARS = 24

/** Score at which the watchdog starts saying something (`watch`). */
export const GOAL_DRIFT_WATCH_SCORE = 30

/** Score at which the reply is called `drift`. */
export const GOAL_DRIFT_DRIFT_SCORE = 60

/** Score ceiling (also used to describe severity consistently). */
const SCORE_CAP = 100

/** How much of the score a complete keyword miss costs. */
const COVERAGE_WEIGHT = 70

/** How much one explicit off-topic phrase adds (capped). */
const OFF_TOPIC_WEIGHT = 20
const OFF_TOPIC_CAP = 30

/**
 * Phrases that explicitly abandon/redirect the current work.
 *
 * These are language-level signals a bot or user writes directly, so matching them needs no
 * model: "先不管/换个/重新/另外/先做别的/算了". A phrase alone is `watch`; together with weak
 * goal coverage it becomes `drift`.
 */
const OFF_TOPIC_PHRASES: readonly string[] = [
  '换个', '换个话题', '先不管', '先放着', '重新', '另外', '先做别的', '先做别的', '算了', '不做这个',
]

/** Characters too common to carry meaning: bigrams containing them are dropped. */
const STOP_CHARS = new Set([...'的了和与及把被对将是在有要需请帮去做写个这那些先再然后如果因为所以但是也可以我你他它们一个并给就都还很更再才又并且着过吗呢吧啊哦吧'])

/** English stop words for latin tokens. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'on', 'in', 'is', 'are',
  'be', 'this', 'that', 'it', 'we', 'you', 'i', 'do', 'does', 'not', 'please', 'help',
  'as', 'at', 'by', 'from', 'into', 'then', 'so', 'if', 'but', 'can', 'will',
])

/**
 * Extract deterministic keywords from the goal.
 *
 * CJK runs become bigrams (2-character windows) with stop-character bigrams dropped; latin
 * words are lowercased and stop-word filtered. Bigrams are used instead of word segmentation
 * because there is no dictionary in this plugin — and a bigram overlap still measures "does the
 * reply talk about the same thing" well enough for a WARNING. Order is first-seen and the list
 * is capped, so the score is reproducible.
 */
export function goalKeywords(goalText: string): string[] {
  const tokens: string[] = []
  const push = (token: string): void => {
    if (token !== '' && !tokens.includes(token) && tokens.length < 24) tokens.push(token)
  }
  for (const match of goalText.toLowerCase().matchAll(/[\u4e00-\u9fff]+|[a-z][a-z0-9_-]+/gu)) {
    const run = match[0]
    if (!/[\u4e00-\u9fff]/u.test(run)) {
      if (run.length >= 2 && !STOP_WORDS.has(run)) push(run)
      continue
    }
    if (run.length === 2) {
      if (!STOP_CHARS.has(run[0]!) && !STOP_CHARS.has(run[1]!)) push(run)
      continue
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (STOP_CHARS.has(bigram[0]!) || STOP_CHARS.has(bigram[1]!)) continue
      push(bigram)
    }
  }
  return tokens
}

/** Count the explicit off-topic phrases present in the text (unique phrases, first-seen order). */
export function offTopicPhrases(text: string): string[] {
  const found: string[] = []
  for (const phrase of OFF_TOPIC_PHRASES) {
    if (text.includes(phrase) && !found.includes(phrase)) found.push(phrase)
  }
  // "换个话题" already says "换个": keep the longer, more precise phrase only, so the notice
  // does not list the same signal twice.
  return found.filter(phrase => !found.some(other => other !== phrase && other.includes(phrase)))
}

export interface GoalDriftInput {
  /** The room's active goal text; absent/blank means "nothing to watch". */
  readonly goalText?: string | undefined
  /** Recent user messages (oldest → newest), for context around a redirect. */
  readonly userTexts?: readonly string[] | undefined
  /** The bot answer that just settled. */
  readonly replyText?: string | undefined
}

export interface GoalDriftAssessment {
  readonly level: 'none' | 'watch' | 'drift'
  /** 0–100, higher = further from the goal; stable for the same input. */
  readonly score: number
  /** Human-readable justification (used verbatim in the notice). */
  readonly reason: string
}

/** Count code points, so a CJK reply is measured in characters the user sees. */
function codePointLength(text: string): number {
  return [...text].length
}

/**
 * Assess whether a settled reply has drifted from the active goal.
 *
 * ORDER (all deterministic):
 *   1. no active goal → `none`;
 *   2. reply too short → `none` (short answers are not evidence of drift);
 *   3. keyword coverage of the goal in the reply + explicit off-topic phrases → score;
 *   4. level thresholds: >= 60 `drift`, >= 30 `watch`, else `none`; any explicit off-topic
 *      phrase is at least `watch`.
 *
 * `userTexts` are accepted for the service's context but never counted as drift by themselves:
 * the reply is the thing that was actually published.
 */
export function assessGoalDrift(input: GoalDriftInput): GoalDriftAssessment {
  const goalText = (input.goalText ?? '').trim()
  if (goalText === '') return { level: 'none', score: 0, reason: '没有活跃目标' }
  const replyText = (input.replyText ?? '').trim()
  const replyLength = codePointLength(replyText)
  if (replyLength < GOAL_DRIFT_MIN_REPLY_CHARS) {
    return {
      level: 'none',
      score: 0,
      reason: `回复过短（${replyLength} 字），不足以判断是否偏移`,
    }
  }

  const keywords = goalKeywords(goalText)
  if (keywords.length === 0) {
    // No usable keywords means no measurable coverage; warning on redirect phrases alone would
    // be guessing. Stay silent rather than cry drift on a goal we cannot judge.
    return { level: 'none', score: 0, reason: '目标无法提取关键词，跳过判断' }
  }
  const matched = keywords.filter(keyword => replyText.toLowerCase().includes(keyword))
  const coverage = keywords.length === 0 ? 1 : matched.length / keywords.length
  const phrases = offTopicPhrases(replyText)
  const score = Math.min(
    SCORE_CAP,
    Math.round((1 - coverage) * COVERAGE_WEIGHT + Math.min(phrases.length * OFF_TOPIC_WEIGHT, OFF_TOPIC_CAP)),
  )
  const coverageText = `目标关键词覆盖 ${matched.length}/${keywords.length}（${Math.round(coverage * 100)}%）`
  const phraseText = phrases.length > 0
    ? `出现偏题表述：${phrases.join('、')}`
    : '未发现偏题表述'
  const reasonBase = `${coverageText}，${phraseText}`

  const drift = score >= GOAL_DRIFT_DRIFT_SCORE || (phrases.length > 0 && coverage < 0.4)
  if (drift) {
    return { level: 'drift', score, reason: `${reasonBase}（分数 ${score}）` }
  }
  if (score >= GOAL_DRIFT_WATCH_SCORE || phrases.length > 0) {
    return { level: 'watch', score, reason: `${reasonBase}（分数 ${score}）` }
  }
  return { level: 'none', score, reason: `${reasonBase}（分数 ${score}）` }
}
