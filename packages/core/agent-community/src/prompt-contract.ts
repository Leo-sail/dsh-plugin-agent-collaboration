/**
 * The prompt format contract (OP-05; v2 adds the OP-03 trust boundary, v3 adds the OP-09
 * group-pattern section, v4 renames its card wording, v5 adds the P5-2 trusted knowledge section).
 *
 * WHY THIS MODULE EXISTS. A bot's turn prompt is assembled from dynamic sections — role,
 * skills, room goal, pinned constraints, group patterns, room knowledge, room memory, recent
 * history, this turn's input — and until now the order and the separators lived implicitly
 * inside `runs.ts buildPrompt`. Any
 * refactor there could silently reorder two sections or change a blank line, and every
 * evaluation of the bots would then be comparing harnesses that are not the same harness. This
 * module makes the format explicit and testable:
 *
 *   · ONE order (`PROMPT_SECTION_ORDER`), one separator (`PROMPT_SEPARATOR`);
 *   · sections are named and optional — a missing section must not leave a blank line behind;
 *   · `assemblePrompt` is a pure string function, so the exact bytes of a prompt can be
 *     golden-tested without a host, a session or a model;
 *   · the TRUST BOUNDARY is part of the format: `memory`/`history` are untrusted context
 *     evidence and `assemblePrompt` puts the fixed {@link CONTEXT_GUARD_BLOCK} in front of the
 *     first of them (once, and only when one exists);
 *   · `PROMPT_CONTRACT_VERSION` is recorded on every run's harness attribution (see
 *     `harness-attribution.ts`), so a stored result can be traced back to this format.
 *
 * ROLE ISOLATION. The whole assembled prompt is ONE user message. Nothing here is ever placed
 * in the system prompt or in a tool-instruction role: the system prompt is the stable bot
 * persona (`bot-prompt.ts`), and the only instruction of a turn is its `[本轮输入]` block.
 *
 * The contract describes the DYNAMIC per-turn prompt only: the bot's system prompt is a
 * separate, stable artefact (`bot-prompt.ts`).
 *
 * @module
 */
import { contextGuardText } from './trust.ts'

/**
 * Version of the per-turn prompt format.
 *
 * BUMP THIS whenever a byte of the assembled prompt can change (order, separator, a section's
 * wording). Runs record it, so results produced under different contracts are never silently
 * compared as if they were the same.
 *
 * v2 (OP-03): a `constraints` section (user-stated hard rules pinned across compaction) and a
 * fixed trust-boundary guard inserted before the first untrusted context section. Both change
 * the assembled bytes, so every stored v1 prompt is a different harness.
 *
 * v3 (OP-09): a `patterns` section carrying this GROUP's learned collaboration patterns
 * (`[本群协作模式]`). It sits AFTER `constraints` and BEFORE `memory`/`history`: it is standing
 * knowledge about how this group works, not untrusted transcript data, so it is rendered
 * outside the trust guard. Every stored v2 prompt is a different harness.
 *
 * v4 (P1): the learned-pattern section's wording changed (「群协作模式」→「群经验卡」, block header
 * `[本群经验卡]`); the order did not change. Every stored v3 prompt is a different harness.
 *
 * v5 (P5-2): a `knowledge` section carrying THIS ROOM's user-maintained Markdown knowledge base
 * (`[本房间知识]`), placed AFTER `patterns` and BEFORE `memory`/`history`. It is TRUSTED standing
 * context — the user wrote it through the panel — so it is deliberately NOT in
 * `UNTRUSTED_PROMPT_SECTIONS`: the guard still starts only at `memory`/`history`, which keeps
 * knowledge outside the guard. Every stored v4 prompt is a different harness.
 *
 * v9 (C2 fix, 2026-11-09): the `segment` handoff moved INSIDE the guard — its content is copied
 * from a previous finish report or bot reply (model/file-derived evidence), so it must never read
 * as a new instruction. Order is unchanged (segment is first), which moves the guard before it.
 *
 * v8 (S3-1): the trust-boundary guard text now states the general rule for tool output, file
 * content and schedule text as well (evidence, never instructions). No section order changed; every
 * stored v7 prompt is a different harness.
 *
 * v10 (2026-11-09): the room knowledge block header is renamed `[本房间知识]` → `[本群规则]` to
 * match the product label. Model-visible only; section order unchanged. Every stored v9 prompt
 * is a different harness.
 *
 * v7 (S2-2): a `recall` section (trusted instructions) telling the model that older history may
 * exist only as an id-stub and that the read tools expand it. Placed after `knowledge` and before
 * `memory`/`history`: it is an instruction, not transcript data, so the guard still starts at
 * `memory`. Every stored v6 prompt is a different harness.
 *
 * v6 (S1-4): a `segment` section carrying the task boundary (`[任务段]`: this segment's task plus a
 * handoff built from the previous segment's finish report). It appears ONLY on the first turn of a
 * new assigned task. Since v9 its handoff body is EVIDENCE (inside the guard); every stored v5
 * prompt is a different harness.
 */
export const PROMPT_CONTRACT_VERSION = 10

/**
 * The canonical section order.
 *
 * `role` first (who is speaking), then the capabilities and the standing task context, then the
 * user's hard constraints (they outrank remembered/historical data), then this group's learned
 * collaboration patterns, then this room's user-maintained knowledge, then the recent
 * conversation, then the instruction for this turn. `input` is deliberately LAST: it is the
 * thing the model must act on, read after all context.
 *
 * TRUST ORDER IS PART OF THE ORDER: `constraints`, `segment`, `patterns`, `knowledge` and `recall` sit BEFORE
 * `memory`/`history` because those two are untrusted context evidence — a rule pinned from what
 * the user actually said, how this group previously agreed to work, and the reference material
 * the user maintains for this room must be read before (and protected from) what a previous turn
 * happened to write. The guard is inserted before the first untrusted section, never before the
 * trusted standing context (`constraints`/`patterns`/`knowledge`).
 */
export const PROMPT_SECTION_ORDER = [
  'role',
  'skills',
  'goal',
  'constraints',
  'segment',
  'patterns',
  'knowledge',
  'recall',
  'memory',
  'history',
  'input',
] as const

/** Name of one prompt section. */
export type PromptSectionName = (typeof PROMPT_SECTION_ORDER)[number]

/** One section's content (the header included; the separator is added by the assembler). */
export type PromptSection = string

/** A prompt under construction: every section optional, assembled in contract order. */
export type PromptSections = Partial<Record<PromptSectionName, PromptSection>>

/** What goes BETWEEN sections. Never after the last one. */
export const PROMPT_SEPARATOR = '\n\n'

/**
 * Sections whose content is DATA, not instructions.
 *
 * `memory` is what this bot recorded in earlier turns (including tool output it chose to
 * remember) and `history` is the recent transcript: either can contain text that LOOKS like an
 * instruction ("ignore your rules", "run this command") because it quotes a document, a web page
 * or another bot. The model must treat them as evidence, never as a new order.
 *
 * `constraints`, `segment`, `patterns`, `knowledge` and `recall` are deliberately NOT listed here: they are trusted
 * standing context (pinned by the user / agreed by the group / maintained by the user), so they
 * render outside the guard. Moving a section into this list is a trust-boundary change, not a
 * formatting change.
 */
export const UNTRUSTED_PROMPT_SECTIONS: ReadonlyArray<PromptSectionName> = ['segment', 'memory', 'history']

/**
 * The fixed trust-boundary guard, inserted ONCE before the first untrusted section.
 *
 * Not a section of its own: it must not be selectable, empty-able or re-orderable by a caller.
 * It is also deliberately unconditional whenever untrusted content exists — a conditional rule
 * ("only if it looks like an injection") is a model judgement, and the whole point is that the
 * model must not have to make that judgement.
 */
export const CONTEXT_GUARD_BLOCK = contextGuardText()

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
 *   · no trailing separator after the last section;
 *   · {@link CONTEXT_GUARD_BLOCK} is inserted exactly once, right before the FIRST untrusted
 *     section that is actually present — and not at all when neither `memory` nor `history`
 *     exists (the trusted `constraints`/`patterns`/`knowledge` sections never trigger it). The
 *     guard is not a section: it cannot be passed in, blanked or moved.
 */
export function assemblePrompt(sections: PromptSections): string {
  const blocks: string[] = []
  let guardInserted = false
  for (const name of PROMPT_SECTION_ORDER) {
    const section = sections[name]
    if (section === undefined || section === '') continue
    if (!guardInserted && UNTRUSTED_PROMPT_SECTIONS.includes(name)) {
      blocks.push(CONTEXT_GUARD_BLOCK)
      guardInserted = true
    }
    blocks.push(section)
  }
  return blocks.join(PROMPT_SEPARATOR)
}
