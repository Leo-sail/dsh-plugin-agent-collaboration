/**
 * Memory lifecycle: where an entry came from, whether it may be injected, and when it must decay.
 *
 * WHY THIS MODULE EXISTS (OP-08). The plugin's room memory used to treat every written line as
 * equally true: a task line from a user-driven turn, a note the bot wrote about itself, and a
 * line produced by a routine/peer-woken turn all went into the same 12-slot partition and were
 * replayed into the next prompt with the same authority. Three failures follow:
 *
 *   · a bot's own report ("我已完成…") is not evidence that it did it;
 *   · work that a neighbour bot or a timer started was never confirmed by the user, yet it
 *     reads as established fact;
 *   · a wrong attempt the user explicitly corrected stays "learned" for ever, and the promotion
 *     scanner can even promote it (a correction is exactly the signal that the attempt failed).
 *
 * So every entry now carries metadata — `source`, `status`, `outcome`, `confidence` — and the
 * lifecycle is a small, pure state machine:
 *
 *   run (user-driven, completed)   → active     (injectable, promotable when positive)
 *   a2a / bot-message / routine    → probation  (visible to the bot, NOT injected into the main
 *                                                prompt; a neighbour's claim is not the user's word)
 *   note (bot's own remember)      → active     (injected, but never promoted: self-report is not
 *                                                run-backed evidence)
 *   corrected by the user later    → decayed    (outcome negative; stops influencing the prompt,
 *                                                never promoted)
 *
 * The file format is versioned by the same metadata (`memory-store.ts`), so a partition written
 * before OP-08 parses as "legacy": a run-backed task keeps promoting exactly as before (outcome
 * defaults to positive), while a legacy line without a run id is unknown/probation-free active.
 *
 * PURE on purpose: no I/O, no host, no model call. Every rule is asserted in
 * `tests/memory-lifecycle.test.ts`, and `memory-store`/`memory-promote`/`bot-memory` only ever
 * consume these predicates.
 *
 * @module
 */
import type { BotMemoryEntry, BotMessage } from './types.ts'

/** Where one memory entry came from. */
export type MemorySource = NonNullable<BotMemoryEntry['source']>

/** Lifecycle state. `active` is the only state injected into the main prompt. */
export type MemoryStatus = NonNullable<BotMemoryEntry['status']>

/** How the recorded attempt ended, from the user's point of view. */
export type MemoryOutcome = NonNullable<BotMemoryEntry['outcome']>

/** The metadata written for one entry. */
export interface EntryMeta {
  readonly source: MemorySource
  readonly status: MemoryStatus
  readonly confidence: number
  readonly outcome: MemoryOutcome
}

/** Confidence when an entry carries none (legacy lines, hand-edited files). */
export const DEFAULT_CONFIDENCE = 0.5

/** How many NEWEST task entries a correction may decay — bounds the scan, bounds the damage. */
export const DECAY_WINDOW_TASKS = 3

/** Task-family similarity for decay (same scale as the promotion scanner's threshold). */
export const DECAY_FAMILY_SIMILARITY = 0.6

/** Confidence gained when a similar task succeeds again (maintenance of an active entry). */
export const MAINTAIN_CONFIDENCE_STEP = 0.1
/** Ceiling for maintained confidence — never certainty. */
export const MAINTAIN_CONFIDENCE_CAP = 0.95

/**
 * Metadata for a task line recorded from a finished run, keyed by the run's origin.
 *
 * ONLY `user`-origin runs are the user's own request, so only they are `active`/`positive` and
 * eligible for promotion. A turn woken by a peer bot or by a reminder is real work but NOT a
 * user-instruction: it goes to `probation` (still readable through `recall`, never injected into
 * the main prompt, never promoted) until the user confirms the same task family later.
 */
export function entryMetaForRun(origin: string): EntryMeta {
  switch (origin) {
    case 'user':
      return { source: 'run', status: 'active', confidence: 0.7, outcome: 'positive' }
    case 'a2a':
    // A peer message and a member hand-off are the same provenance: another agent's request.
    case 'bot-message':
      return { source: 'a2a', status: 'probation', confidence: 0.35, outcome: 'unknown' }
    case 'routine':
      return { source: 'routine', status: 'probation', confidence: 0.3, outcome: 'unknown' }
    default:
      return { source: 'unknown', status: 'probation', confidence: 0.3, outcome: 'unknown' }
  }
}

/**
 * Metadata for a `note` the bot wrote through `agent_community_remember`.
 *
 * Active (the bot asked for it explicitly, and a user can always delete it) but NOT promotable:
 * a model's account of itself is not run-backed evidence (the same rule the promotion scanner
 * already applies to refusals).
 */
export function entryMetaForNote(): EntryMeta {
  return { source: 'note', status: 'active', confidence: 0.5, outcome: 'unknown' }
}

/** The status an entry effectively has. A missing status is `active` (pre-OP-08 data). */
export function statusOf(entry: Pick<BotMemoryEntry, 'status'>): MemoryStatus {
  return entry.status ?? 'active'
}

/** The source an entry effectively has: a run-backed legacy line is `run`, anything else unknown. */
export function sourceOf(entry: Pick<BotMemoryEntry, 'source' | 'runId'>): MemorySource {
  if (entry.source !== undefined) return entry.source
  return entry.runId !== undefined ? 'run' : 'unknown'
}

/**
 * The outcome an entry effectively has.
 *
 * LEGACY COMPATIBILITY, stated once: a task line that predates OP-08 carries a run id and no
 * outcome. Before this module existed every run-backed task line was a promotion candidate, so
 * reading those as `positive` keeps an existing installation's learning behaviour unchanged.
 * An entry WITHOUT a run id (a note, a legacy free line) is `unknown`.
 */
export function outcomeOf(entry: Pick<BotMemoryEntry, 'outcome' | 'runId'>): MemoryOutcome {
  if (entry.outcome !== undefined) return entry.outcome
  return entry.runId !== undefined ? 'positive' : 'unknown'
}

/** A 0..1 confidence. Missing/NaN defaults to {@link DEFAULT_CONFIDENCE}; values are clamped. */
export function confidenceOf(entry: Pick<BotMemoryEntry, 'confidence'>): number {
  const value = entry.confidence
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIDENCE
  return Math.min(1, Math.max(0, value))
}

/**
 * Whether an entry belongs in the MAIN prompt block.
 *
 * `probation` entries are deliberately not injected: another agent's unconfirmed claim must not
 * read like the user's instruction. They remain searchable through `recall`, labelled, and they
 * can still be promoted by the user's later confirmation of the same task family (a fresh
 * user-origin entry), never on their own.
 */
export function isInjectable(entry: Pick<BotMemoryEntry, 'status'>): boolean {
  return statusOf(entry) === 'active'
}

/**
 * Whether an entry may be promoted into the bot's global instruction file.
 *
 * ALL FOUR must hold: a task line, a real run id, `active`, and a `positive` outcome from a
 * `run` source. Notes, probation (a2a/routine), negative/decayed and unknown-outcome entries are
 * never promoted. Legacy run-backed tasks pass through {@link outcomeOf}/{@link sourceOf}
 * compatibility so pre-OP-08 data keeps its old behaviour.
 */
export function promotable(entry: BotMemoryEntry): boolean {
  if (entry.kind !== 'task') return false
  if (entry.runId === undefined) return false
  if (!isInjectable(entry)) return false
  if (outcomeOf(entry) !== 'positive') return false
  return sourceOf(entry) === 'run'
}

// ── decay (state transition driven by the user correcting the bot) ──────────────
//
// The correction words and the bigram similarity are DUPLICATED from `memory-promote.ts` on
// purpose: `memory-promote` imports {@link promotable} from this module, so importing back would
// be a cycle. They are small, pure and frozen here; keep the two lists in sync.

const CORRECTION_WORDS: readonly string[] = [
  '不对', '错了', '不是', '不行', '别', '不要', '改成', '重新', '再来', '我说过', '又错',
  'wrong', 'not what', 'redo', 'again', 'incorrect',
]

/** Fillers stripped before similarity so two phrasings of one request compare fairly. */
const FILLER = /[，,。.！!？?、；;：:\s"'“”‘’（）()【】\[\]「」]/gu

/** Whether a user message reads as correcting the previous attempt. */
export function isCorrectionText(text: string): boolean {
  const lower = text.toLowerCase()
  return CORRECTION_WORDS.some(word => lower.includes(word.toLowerCase()))
}

/** The task part of one memory line: `任务：X → 结果：Y` becomes `X`. */
export function taskSignature(text: string): string {
  return text
    .replace(/^任务[:：]/u, '')
    .split('→')[0]!
    .replace(FILLER, '')
    .toLowerCase()
}

/** Character-bigram Jaccard similarity (CJK-friendly; same scale as the promotion scanner). */
export function textSimilarity(a: string, b: string): number {
  a = a.replace(FILLER, '')
  b = b.replace(FILLER, '')
  if (a === '' || b === '') return 0
  if (a === b) return 1
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
    if (out.size === 0) out.add(s)
    return out
  }
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Decay the task entries the user has explicitly corrected since.
 *
 * RULES (all bounded so a single correction cannot rewrite unrelated history):
 *   · only the NEWEST {@link DECAY_WINDOW_TASKS} task entries are candidates;
 *   · only `active` entries change — probation/decayed entries are already not injected;
 *   · only the task entry that was the LAST task before a user correction is a target (the user
 *     is reacting to it, not to older work);
 *   · when a later task entry exists after the correction (the redo), it must be the SAME task
 *     family ({@link DECAY_FAMILY_SIMILARITY}) — otherwise the correction is about something
 *     else and nothing is decayed;
 *   · the transition is `status: decayed`, `outcome: negative`, `confidence −= 0.4` (floor 0.1),
 *     `updatedAt: now`. The id does NOT change (stable id = kind+at+text), so a delta boundary
 *     survives the transition.
 *
 * @returns a NEW entries array and how many entries changed; the caller must REWRITE the
 *          partition (not append) when `changed > 0`.
 */
export function decayForCorrections(
  entries: readonly BotMemoryEntry[],
  messages: ReadonlyArray<Pick<BotMessage, 'sender' | 'text' | 'createdAt'>>,
  now: string,
): { entries: BotMemoryEntry[]; changed: number } {
  const tasks = entries.filter(entry => entry.kind === 'task')
  if (tasks.length === 0) return { entries: [...entries], changed: 0 }
  const window = tasks.slice(-DECAY_WINDOW_TASKS)
  const windowIds = new Set(window.map(entry => entry.id))
  const corrections = messages
    .filter(message => message.sender.kind === 'user' && isCorrectionText(message.text))
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  if (corrections.length === 0) return { entries: [...entries], changed: 0 }

  const decayed = new Set<string>()
  for (const correction of corrections) {
    // The task the user is reacting to: the newest task entry at or before the correction.
    const before = tasks.filter(entry => entry.at <= correction.createdAt)
    const target = before[before.length - 1]
    if (target === undefined || !windowIds.has(target.id)) continue
    if (!isInjectable(target) || decayed.has(target.id)) continue
    // If a redo exists, it must be the same task family; otherwise the correction is unrelated.
    const after = tasks.find(entry => entry.at > correction.createdAt)
    if (after !== undefined) {
      const sameFamily = textSimilarity(taskSignature(target.text), taskSignature(after.text))
        >= DECAY_FAMILY_SIMILARITY
      if (!sameFamily) continue
    }
    decayed.add(target.id)
  }
  if (decayed.size === 0) return { entries: [...entries], changed: 0 }

  const next = entries.map((entry): BotMemoryEntry => {
    if (!decayed.has(entry.id)) return entry
    return {
      ...entry,
      status: 'decayed',
      outcome: 'negative',
      confidence: Math.max(0.1, confidenceOf(entry) - 0.4),
      updatedAt: now,
    }
  })
  return { entries: next, changed: decayed.size }
}

/**
 * MAINTAIN: a similar task succeeded again, so a still-active entry earns a little confidence.
 *
 * Deliberately small and capped: this is "the same request worked twice", not "the model says it
 * went well". The caller opts in (OP-08 does not wire it into the write path yet) so no entry is
 * ever bumped without an explicit successful re-run behind it.
 */
export function bumpMaintain(
  entries: readonly BotMemoryEntry[],
  taskText: string,
  now: string,
): { entries: BotMemoryEntry[]; changed: number } {
  const signature = taskSignature(taskText)
  if (signature === '') return { entries: [...entries], changed: 0 }
  let changed = 0
  const next = entries.map((entry): BotMemoryEntry => {
    if (entry.kind !== 'task' || !isInjectable(entry)) return entry
    if (textSimilarity(taskSignature(entry.text), signature) < DECAY_FAMILY_SIMILARITY) return entry
    changed += 1
    return {
      ...entry,
      confidence: Math.min(MAINTAIN_CONFIDENCE_CAP, confidenceOf(entry) + MAINTAIN_CONFIDENCE_STEP),
      updatedAt: now,
    }
  })
  return { entries: next, changed }
}
