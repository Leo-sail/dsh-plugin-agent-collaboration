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
