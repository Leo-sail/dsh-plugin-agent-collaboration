/**
 * The prompt format contract (OP-05).
 *
 * WHY THIS MODULE EXISTS. A bot's turn prompt is assembled from dynamic sections — role,
 * skills, room goal, room memory, recent history, this turn's input — and until now the order
 * and the separators lived implicitly inside `runs.ts buildPrompt`. Any refactor there could
 * silently reorder two sections or change a blank line, and every evaluation of the bots would
 * then be comparing harnesses that are not the same harness. This module makes the format
 * explicit and testable:
 *
 *   · ONE order (`PROMPT_SECTION_ORDER`), one separator (`PROMPT_SEPARATOR`);
 *   · sections are named and optional — a missing section must not leave a blank line behind;
 *   · `assemblePrompt` is a pure string function, so the exact bytes of a prompt can be
 *     golden-tested without a host, a session or a model;
 *   · `PROMPT_CONTRACT_VERSION` is recorded on every run's harness attribution (see
 *     `harness-attribution.ts`), so a stored result can be traced back to this format.
 *
 * The contract describes the DYNAMIC per-turn prompt only: the bot's system prompt is a
 * separate, stable artefact (`bot-prompt.ts`).
 *
 * @module
 */

/**
 * Version of the per-turn prompt format.
 *
 * BUMP THIS whenever a byte of the assembled prompt can change (order, separator, a section's
 * wording). Runs record it, so results produced under different contracts are never silently
 * compared as if they were the same.
 */
export const PROMPT_CONTRACT_VERSION = 1

/**
 * The canonical section order.
 *
 * `role` first (who is speaking), then the capabilities and the standing task context, then
 * the recent conversation, then the instruction for this turn. `input` is deliberately LAST:
 * it is the thing the model must act on, read after all context.
 */
export const PROMPT_SECTION_ORDER = ['role', 'skills', 'goal', 'memory', 'history', 'input'] as const

/** Name of one prompt section. */
export type PromptSectionName = (typeof PROMPT_SECTION_ORDER)[number]

/** One section's content (the header included; the separator is added by the assembler). */
export type PromptSection = string

/** A prompt under construction: every section optional, assembled in contract order. */
export type PromptSections = Partial<Record<PromptSectionName, PromptSection>>

/** What goes BETWEEN sections. Never after the last one. */
export const PROMPT_SEPARATOR = '\n\n'

/**
 * Header for the recent-history block.
 *
 * The truncation marker is not decoration: a model told its window is partial asks for the
 * file/command instead of assuming the transcript simply ends there.
 */
export function historyHeader(count: number, truncated: boolean): string {
  return truncated
    ? `[最近 ${count} 条消息（已按长度截断）]`
    : `[最近 ${count} 条消息]`
}

/** The final block: this turn's instruction, header + verbatim text. */
export function inputBlock(text: string): string {
  return `[本轮输入]\n${text}`
}

/**
 * Assemble the sections into the final prompt.
 *
 * RULES, all of them asserted by tests:
 *   · the order is `PROMPT_SECTION_ORDER`, never the object's key order;
 *   · `undefined` and `''` sections are skipped — no empty line, no stray separator;
 *   · sections are joined by exactly `PROMPT_SEPARATOR`;
 *   · no trailing separator after the last section.
 */
export function assemblePrompt(sections: PromptSections): string {
  const blocks: string[] = []
  for (const name of PROMPT_SECTION_ORDER) {
    const section = sections[name]
    if (section === undefined || section === '') continue
    blocks.push(section)
  }
  return blocks.join(PROMPT_SEPARATOR)
}
