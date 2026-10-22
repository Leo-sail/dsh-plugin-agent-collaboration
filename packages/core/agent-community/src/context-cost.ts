/**
 * Per-section context cost (OP-15): WHERE a prompt's bytes come from.
 *
 * WHY THIS MODULE EXISTS. "The prompt is 18 KB" is not actionable. The sections have very
 * different costs and very different values: memory/history grow with use and are usually the
 * bulk, role/input are cheap and essential, patterns are learned and therefore optional. Without
 * a per-section breakdown, a context-budget fix has no target — the only lever visible was
 * "compact more".
 *
 * This module measures CHARACTERS per section (a fact) and offers one deliberately rough token
 * estimate (a heuristic, clearly labelled). The measured value is `sectionStats`; the estimate
 * exists only so logs/notices can say "roughly N tokens" instead of pretending to know exactly.
 *
 * Section names come from `prompt-contract.ts`, so the measurement can never drift from the
 * format it measures.
 *
 * @module
 */
import { PROMPT_SECTION_ORDER, type PromptSectionName } from './prompt-contract.ts'

/** The measured sections, in contract order. */
export const CONTEXT_SECTION_NAMES: readonly PromptSectionName[] = PROMPT_SECTION_ORDER

/** Characters per section, plus the total and each section's share of it. */
export interface ContextSectionStats {
  /** Unicode code-point count per section (empty sections are omitted). */
  readonly chars: Readonly<Record<string, number>>
  readonly totalChars: number
  /** `chars[section] / totalChars`, rounded to 4 decimals (0 when there is no content). */
  readonly shares: Readonly<Record<string, number>>
}

/** One row of a "costliest sections" ranking. */
export interface ContextSectionCost {
  readonly section: string
  readonly chars: number
  readonly share: number
}

/** Count Unicode code points, so a CJK section is measured in characters, not UTF-16 units. */
function codePoints(text: string): number {
  return [...text].length
}

/**
 * Measure each section's character cost.
 *
 * Known sections are emitted in CONTRACT ORDER first, then any extra keys alphabetically, so
 * the output is deterministic for the same input. Empty/undefined sections are omitted: a
 * section that carries no bytes should not appear to cost anything.
 */
export function sectionStats(sections: Readonly<Record<string, string>>): ContextSectionStats {
  const chars: Record<string, number> = {}
  const ordered: string[] = [...CONTEXT_SECTION_NAMES]
  for (const key of Object.keys(sections)) {
    if (!ordered.includes(key)) ordered.push(key)
  }
  // Extra keys after the contract order, alphabetically, for a stable record.
  const extras = ordered
    .slice(CONTEXT_SECTION_NAMES.length)
    .sort((left, right) => left.localeCompare(right))
  let totalChars = 0
  for (const name of [...CONTEXT_SECTION_NAMES, ...extras]) {
    const value = sections[name]
    if (value === undefined || value === '') continue
    const count = codePoints(value)
    if (count <= 0) continue
    chars[name] = count
    totalChars += count
  }
  const shares: Record<string, number> = {}
  for (const [name, count] of Object.entries(chars)) {
    shares[name] = totalChars === 0 ? 0 : Math.round((count / totalChars) * 10_000) / 10_000
  }
  return { chars, totalChars, shares }
}

/**
 * ROUGH token estimate — a label, not a measurement.
 *
 * Heuristic: ~1.5 characters per token for mixed Chinese/English prompt text (CJK runs cost
 * more tokens per character than Latin prose, code and JSON cost fewer). Real tokenisation is
 * model-specific and unavailable here, so this is rounded UP and never presented as exact.
 */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 1.5)
}

/**
 * Rank the costliest sections (largest first; ties keep contract order via the input record).
 *
 * Used by logs and the panel-facing evidence line ("memory is 61 % of this prompt"), never to
 * make a budget decision by itself.
 */
export function topCostSections(stats: ContextSectionStats, limit = 3): ContextSectionCost[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  if (cap === 0) return []
  return Object.entries(stats.chars)
    .map(([section, chars]) => ({ section, chars, share: stats.shares[section] ?? 0 }))
    .sort((left, right) => right.chars - left.chars)
    .slice(0, cap)
}
