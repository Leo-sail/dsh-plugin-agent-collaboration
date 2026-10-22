/**
 * Harness attribution (OP-01): WHICH harness produced a run's results.
 *
 * WHY THIS MODULE EXISTS. Evaluation results are only comparable when the harness that
 * produced them is recorded: a prompt-format change, a different agent preset, or another
 * history/memory window all move the numbers, and without attribution a stored result cannot
 * tell "the bot got better" from "the context got bigger". Every run therefore records one
 * attribution object at claim time (the moment it actually starts running):
 *
 *   { pluginVersion, harnessRevision, promptContract, preset, historyMessages, memoryPromptEntries }
 *
 * `harnessRevision` is a HAND-MAINTAINED batch marker — the git revision changes for reasons
 * that do not affect the harness (docs, UI), so it cannot be the attribution key by itself.
 * The plugin version is READ from the package at runtime (never written as a literal here), so
 * a release cannot silently keep attributing runs to an old version.
 *
 * @module
 */
import { createRequire } from 'node:module'
import { PROMPT_CONTRACT_VERSION } from './prompt-contract.ts'
import type { HarnessAttribution } from './types.ts'

/**
 * The harness batch marker recorded on every run.
 *
 * BUMP THIS by hand together with `PROMPT_CONTRACT_VERSION` whenever a change can alter
 * model-visible behaviour or resource budgets; the string names the batch, not the commit.
 */
export const HARNESS_REVISION = 'paper-batch2-2026-10-22'

/** What the attribution says when the package metadata cannot be read. */
export const UNKNOWN_PLUGIN_VERSION = 'unknown'

/** Loader shape a test can inject instead of reading the real package.json. */
export type PluginJsonLoader = () => unknown

/**
 * The plugin's own `version` from its package.json.
 *
 * Path note: this module sits in `src/` (or `lib/` when built) and the package root is its
 * parent, so `../package.json` is the same file in both layouts. Any failure — missing file,
 * malformed JSON, missing/empty version — degrades to 'unknown' rather than guessing: an
 * attribution that lies is worse than one that admits it does not know.
 *
 * @param load - test seam; defaults to reading `../package.json`.
 */
export function readPluginVersion(load?: PluginJsonLoader): string {
  try {
    const parsed = (load ?? defaultPluginJsonLoader)()
    if (parsed === null || typeof parsed !== 'object') return UNKNOWN_PLUGIN_VERSION
    const version = (parsed as { version?: unknown }).version
    if (typeof version !== 'string' || version.trim() === '') return UNKNOWN_PLUGIN_VERSION
    return version.trim()
  } catch {
    return UNKNOWN_PLUGIN_VERSION
  }
}

/** Read the real package.json next to this module. Kept separate so `readPluginVersion` stays pure-ish. */
function defaultPluginJsonLoader(): unknown {
  const require = createRequire(import.meta.url)
  return require('../package.json') as unknown
}

/** Fields a caller may supply; anything omitted falls back to the harness defaults. */
export interface HarnessAttributionInput {
  readonly pluginVersion?: string | undefined
  readonly harnessRevision?: string | undefined
  readonly promptContract?: number | undefined
  readonly preset?: string | undefined
  readonly historyMessages?: number | undefined
  readonly memoryPromptEntries?: number | undefined
}

/**
 * Build one frozen attribution record.
 *
 * Pure apart from the version lookup, and the version itself is injectable — that seam is what
 * lets a test assert "missing metadata → unknown" without breaking the real package.json.
 */
export function buildHarnessAttribution(input: HarnessAttributionInput = {}): HarnessAttribution {
  const attribution: HarnessAttribution = {
    pluginVersion: input.pluginVersion ?? readPluginVersion(),
    harnessRevision: input.harnessRevision ?? HARNESS_REVISION,
    promptContract: input.promptContract ?? PROMPT_CONTRACT_VERSION,
    preset: input.preset ?? 'bot',
    historyMessages: input.historyMessages ?? 10,
    memoryPromptEntries: input.memoryPromptEntries ?? 8,
  }
  return Object.freeze(attribution)
}
