/**
 * Group pattern cards (OP-09): remember HOW this group worked, not just what it said.
 *
 * WHY THIS MODULE EXISTS. A group that finishes a task keeps nothing about the process: the
 * next task in the same room starts from zero and repeats the same detours. But asking a model
 * to summarise every finish would cost a turn and make the record non-deterministic. So the
 * card is built DETERMINISTICALLY from the finish report the leader already wrote:
 *
 *   · the opening sentences become `approach` ("how we did it");
 *   · lines that name a pitfall/risk/attention point become `pitfalls`;
 *   · the finish gate's evidence becomes a short reference list.
 *
 * Cards live on the room (`BotRoom.patternCards`), are de-duplicated by the normalized task,
 * newest first and capped. `renderGroupPatternsBlock` turns the newest few into the
 * `[本群经验卡]` prompt section — scoped to one room, so a pattern learned in one group can
 * never leak into another.
 *
 * Everything here is pure and bounded; no model call, no storage, no clock beyond `now`.
 *
 * @module
 */
import type { GroupPatternCard } from './types.ts'

/** How many cards one room keeps. Older patterns age out. */
export const GROUP_PATTERNS_MAX = 20

/** How many cards the prompt block renders at most. */
export const GROUP_PATTERNS_RENDER_LIMIT = 3

/** The task text stored on a card. */
const TASK_LIMIT = 160

/** The approach (first sentences) length budget. */
const APPROACH_LIMIT = 240

/** One pitfall line. */
const PITFALL_LIMIT = 120

/** At most this many pitfalls per card. */
const PITFALL_MAX = 3

/** One evidence reference. */
const EVIDENCE_LIMIT = 120

/** At most this many evidence references per card. */
const EVIDENCE_MAX = 5

/** Sentence ends used to split the report into units. */
const SENTENCE_SPLIT = /[。！？!?；;\n]+/u

/** Lines/sentences worth keeping as pitfalls. */
const PITFALL_MARKERS = /坑|风险|注意|失败|限制|问题|难点|教训/u

/** Clip a string by code points (never split a surrogate pair) and mark the cut. */
function clipText(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const points = [...trimmed]
  if (points.length <= limit) return trimmed
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/**
 * Normalize a task for de-duplication: trim, collapse whitespace, lowercase.
 *
 * Two finishes of "把方案写完" and " 把方案写完 " are the SAME pattern (the latest wins);
 * otherwise a busy room would accumulate one card per retry of one task.
 */
export function normalizePatternTask(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** Split the report into sentence-ish units, dropping empties. */
function sentenceUnits(report: string): string[] {
  return report
    .split(SENTENCE_SPLIT)
    .map(unit => unit.replace(/\s+/gu, ' ').trim())
    .filter(unit => unit !== '')
}

export interface GroupPatternCardInput {
  /** The task the group delivered (room objective or the user's own words). */
  readonly task: string
  /** The leader's finish report. */
  readonly report: string
  /** Short evidence references (paths, message ids, task ids). */
  readonly evidence?: readonly string[] | undefined
  readonly now: string
  /** `pending` = learned from a bypassed finish; confirm in settings before it enters prompts. */
  readonly status?: 'active' | 'pending' | undefined
}

/**
 * Build one deterministic card from a finish.
 *
 * Same input → same card (including the id), so the record is reproducible and testable. All
 * fields are length-bounded; an empty report still yields a card with an explicit fallback
 * approach rather than an unusable empty row.
 */
export function buildGroupPatternCard(input: GroupPatternCardInput): GroupPatternCard {
  const task = clipText(normalizePatternTask(input.task), TASK_LIMIT)
  const units = sentenceUnits(input.report)
  // The approach is "what we did"; pitfall lines are kept separate so the rendered block does
  // not say the same sentence twice. If the report is ONLY pitfalls, the approach falls back to
  // the same sentences (a card with no approach would be unusable).
  const pitfallUnits = units.filter(unit => PITFALL_MARKERS.test(unit))
  const approachUnits = units.filter(unit => !PITFALL_MARKERS.test(unit))
  const approachSource = approachUnits.length > 0 ? approachUnits : units
  const approach = approachSource.length === 0
    ? '（无文字做法摘要）'
    : clipText(approachSource.slice(0, 2).join('；'), APPROACH_LIMIT)
  const pitfalls = pitfallUnits
    .slice(0, PITFALL_MAX)
    .map(unit => clipText(unit, PITFALL_LIMIT))
  const evidence = (input.evidence ?? [])
    .map(item => clipText(item, EVIDENCE_LIMIT))
    .filter(item => item !== '')
    .slice(0, EVIDENCE_MAX)
  const idBase = normalizePatternTask(task).replace(/\s+/gu, '-').slice(0, 24)
  return {
    id: `pattern:${input.now}:${idBase}`,
    task,
    approach,
    ...(pitfalls.length > 0 ? { pitfalls } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    createdAt: input.now,
    source: 'finish',
    ...(input.status !== undefined ? { status: input.status } : {}),
  }
}

/**
 * Merge a new card into the room's list.
 *
 * Newest first; a card for the SAME normalized task replaces the old one (the latest finish is
 * the truth); the list is capped at `max`.
 */
export function mergeGroupPatterns(
  existing: readonly GroupPatternCard[] | undefined,
  card: GroupPatternCard,
  max: number = GROUP_PATTERNS_MAX,
): readonly GroupPatternCard[] {
  const key = normalizePatternTask(card.task)
  const kept = (existing ?? []).filter(candidate => normalizePatternTask(candidate.task) !== key)
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : GROUP_PATTERNS_MAX
  return [card, ...kept].slice(0, limit)
}

/** Hard cap for the single editable experience text (kept small: it is injected every turn). */
export const EXPERIENCE_TEXT_LIMIT = 3_000

/**
 * Compose the single experience text from ACTIVE cards (newest first).
 *
 * This is only the AUTO seed: once the user edits the card, the service stops calling this.
 * Pending cards (bypassed finishes) are deliberately absent — an unverified pattern must not
 * become standing group memory without the user's word.
 */
export function composeExperienceText(
  cards: readonly GroupPatternCard[] | undefined,
  limit: number = EXPERIENCE_TEXT_LIMIT,
): string | undefined {
  const active = (cards ?? [])
    .filter(card => (card.status ?? 'active') === 'active')
    .filter(card => card.task.trim() !== '' && card.approach.trim() !== '')
  if (active.length === 0) return undefined
  const lines = active.map((card) => {
    const pitfalls = (card.pitfalls ?? []).filter(item => item.trim() !== '')
    return `· ${card.task}：${card.approach}${pitfalls.length > 0 ? `（注意：${pitfalls.join('；')}）` : ''}`
  })
  const text = lines.join('\n')
  const points = [...text]
  return points.length <= limit ? text : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/** Render the single experience card as the `[本群经验卡]` prompt section. */
export function renderExperienceBlock(text: string | undefined): string | undefined {
  const flat = (text ?? '').trim()
  if (flat === '') return undefined
  return `[本群经验卡]\n${flat}`
}

/**
 * Render the newest cards as the `[本群经验卡]` prompt section.
 *
 * Returns `undefined` when there is nothing to say — the caller then omits the section, so an
 * empty group pays no prompt cost. Only task/approach/pitfalls are rendered: evidence stays on
 * the card for auditing, not in the turn prompt.
 */
export function renderGroupPatternsBlock(
  cards: readonly GroupPatternCard[] | undefined,
  limit: number = GROUP_PATTERNS_RENDER_LIMIT,
): string | undefined {
  const usable = (cards ?? [])
    // Only ACTIVE cards enter the prompt; pending cards wait for the user's confirmation.
    .filter(card => (card.status ?? 'active') === 'active')
    .filter(card => card.task.trim() !== '' && card.approach.trim() !== '')
    .slice(0, Math.max(0, Math.floor(limit)))
  if (usable.length === 0) return undefined
  const lines = usable.map((card) => {
    const pitfalls = (card.pitfalls ?? []).filter(item => item.trim() !== '')
    const suffix = pitfalls.length > 0 ? `（坑：${pitfalls.join('；')}）` : ''
    return `· ${card.task}：${card.approach}${suffix}`
  })
  return ['[本群经验卡]', ...lines].join('\n')
}

// ── Incremental experience card + auto-refine ────────────────────────────────
//
// The card is INCREMENTAL: every finish appends (or replaces) its own line, so user-edited and
// previously refined text survives. When the text reaches 80% of the limit, one hidden leader
// turn condenses it; that is the only model call in this path and it is opt-in at the room level.

/** Trigger a condense pass at this fraction of the hard cap. */
export const EXPERIENCE_REFINE_RATIO = 0.8
/** The condensed card is asked to fit this fraction of the cap. */
export const EXPERIENCE_REFINE_TARGET_RATIO = 0.55
/** The condensed card must keep at least this fraction; below it the answer is rejected. */
export const EXPERIENCE_REFINE_MIN_RATIO = 0.2
/** The prompt asks for at least this fraction of the cap (do not collapse to one line). */
export const EXPERIENCE_REFINE_TARGET_MIN_RATIO = 0.3

/** One rendered card line: `· task：approach（注意：pitfall；pitfall）`. */
export function experienceLineFor(card: GroupPatternCard): string {
  const pitfalls = (card.pitfalls ?? []).filter(item => item.trim() !== '')
  return `· ${card.task}：${card.approach}${pitfalls.length > 0 ? `（注意：${pitfalls.join('；')}）` : ''}`
}

/**
 * Merge one new pattern into an existing experience text INCREMENTALLY.
 *
 * Same normalized task replaces its old line; a new task is appended at the end. The caller owns
 * the cap (and the refine trigger); this function never drops unrelated lines.
 */
export function mergeExperienceText(
  existing: string | undefined,
  card: GroupPatternCard,
  limit: number = EXPERIENCE_TEXT_LIMIT,
): string | undefined {
  const line = experienceLineFor(card)
  const old = (existing ?? '').trim()
  const key = normalizePatternTask(card.task)
  const lines = old === '' ? [] : old.split('\n').filter(item => item.trim() !== '')
  const at = lines.findIndex(item => {
    const body = item.startsWith('· ') ? item.slice(2) : item
    const task = body.split('：')[0] ?? ''
    return normalizePatternTask(task) === key
  })
  if (at >= 0) lines[at] = line
  else lines.push(line)
  const text = lines.join('\n')
  const points = [...text]
  return points.length <= limit ? text : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/** Whether the card should be condensed (80% of the hard cap by default). */
export function experienceNeedsRefine(
  text: string | undefined,
  limit: number = EXPERIENCE_TEXT_LIMIT,
  ratio: number = EXPERIENCE_REFINE_RATIO,
): boolean {
  const length = [...(text ?? '').trim()].length
  if (length === 0) return false
  const safeRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : EXPERIENCE_REFINE_RATIO
  return length >= Math.ceil(limit * safeRatio)
}

/** The prompt for the hidden condense turn. Model-facing, not user-facing. */
export function buildExperienceRefinePrompt(text: string, limit: number = EXPERIENCE_TEXT_LIMIT): string {
  const targetMax = Math.max(200, Math.floor(limit * EXPERIENCE_REFINE_TARGET_RATIO))
  const targetMin = Math.max(120, Math.floor(limit * EXPERIENCE_REFINE_TARGET_MIN_RATIO))
  return [
    '[整理本群经验]',
    '下面是本群积累的工作经验，已经接近字数上限。请把它整理成更短、更通用的经验清单：',
    '· 合并重复或相近的条目，删掉一次性的细节和客套话；',
    '· 保留「什么任务、通常怎么做、要注意什么」，不要把所有任务合并成一句话；',
    '· 只输出整理后的经验文本，每行一条，格式：· 任务：做法（注意：风险）；',
    `· ${targetMin}–${targetMax} 字，不要少于 ${targetMin} 字；不要解释，不要标题，不要代码块。`,
    '原文：',
    text.trim(),
  ].join('\n')
}

/**
 * Parse the condense answer.
 *
 * Tolerates a fenced block or a leading label, rejects empty/oversize output so a bad turn can
 * never overwrite a good experience card.
 */
export function parseRefinedExperience(
  answer: string,
  limit: number = EXPERIENCE_TEXT_LIMIT,
  minChars: number = Math.max(120, Math.floor(limit * EXPERIENCE_REFINE_MIN_RATIO)),
): string | undefined {
  let text = (answer ?? '').trim()
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/u.exec(text)
  if (fence !== null) text = fence[1]!.trim()
  text = text.replace(/^(整理后的?经验[:：]\s*)/u, '').trim()
  if (text === '') return undefined
  const points = [...text]
  if (points.length > limit) return undefined
  if (points.length < Math.max(0, Math.floor(minChars))) return undefined
  return text
}
