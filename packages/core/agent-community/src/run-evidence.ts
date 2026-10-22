/**
 * Run evidence and failure attribution (OP-04): what a run cost, how it ended, whose fault.
 *
 * WHY THIS MODULE EXISTS. Two runs can both "fail" and mean completely different things: the
 * provider rejected the request, the harness hit its own deadline, a tool was denied by the
 * sandbox, the context exploded, or the room's goal orchestration stalled. Without recording
 * that distinction, an evaluation can only count failures, and an operator re-reads free-text
 * error strings to guess where to look.
 *
 * So every settled run carries a small `RunEvidence` record — counters, token usage, a closed
 * `finishPath` vocabulary and a `faultSide` — and nothing else. PROSE IS NEVER STORED: no prompt
 * text, no reasoning, no tool output. That keeps the record small, persistable in `state.runs`
 * and safe to expose in the panel snapshot.
 *
 * All functions are pure and deterministic; the executor supplies the raw counts.
 *
 * @module
 */
import type { FailureKind } from './run-budget.ts'
import type { RunEvidence, RunFaultSide, RunFinishPath } from './types.ts'

/** The token shape the provider reports; only the three totals are kept. */
export interface RunEvidenceUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

/** Minimal tool-card shape, so counting stays a pure function. */
export interface ToolActivityLike {
  readonly name?: string | undefined
  readonly status?: string | undefined
}

export interface FaultSideInput {
  /** The classified failure kind (S8); wins over message text. */
  readonly failureKind?: FailureKind | undefined
  /** The raw error message, for runs whose kind is generic/absent. */
  readonly error?: string | undefined
  /** How the run ended, when known. */
  readonly finishPath?: RunFinishPath | undefined
}

/** Tool-card statuses that count as a failed tool call. */
const FAILED_TOOL_STATUSES = new Set(['failed', 'error', 'blocked', 'denied'])

/**
 * Which layer a failure belongs to.
 *
 * DETERMINISTIC AND ORDERED, because the same message can contain several signals:
 *
 *   1. an explicit user stop is `user` (nothing the harness can fix);
 *   2. a budget outcome — `timeout` / `no-progress` kind or finish path — is `harness`:
 *      the adaptive allowance is the runner's own policy, not a model fault;
 *      `lease-lost` (a dead process reclaimed by supervision) is `harness` too;
 *   3. an explicit kind is trusted next: `provider` → `model`, `tool` → `tool`;
 *   4. otherwise message text, most specific first: tool/sandbox/permission/approval → `tool`;
 *      memory/context/compaction → `memory`; room/goal/leader/stall → `room-goal`;
 *      transport/network/5xx/rate-limit/provider → `model`; a bare "timed out" → `harness`;
 *   5. anything unrecognised stays `unknown` rather than being blamed on the model.
 */
export function classifyFaultSide(input: FaultSideInput): RunFaultSide {
  if (input.finishPath === 'stopped' || input.failureKind === 'user-cancel') return 'user'
  if (input.failureKind === 'timeout' || input.failureKind === 'no-progress') return 'harness'
  if (input.failureKind === 'lease-lost') return 'harness'
  if (input.finishPath === 'timeout' || input.finishPath === 'no-progress') return 'harness'
  // An explicit kind is stronger evidence than free-text matching.
  if (input.failureKind === 'provider') return 'model'
  if (input.failureKind === 'tool') return 'tool'

  const message = (input.error ?? '').toLowerCase()
  if (message === '') return 'unknown'
  if (/tool|sandbox|permission|approval|eacces|eperm/u.test(message)) return 'tool'
  if (/memory|context|compact|token budget|记忆|上下文/u.test(message)) return 'memory'
  if (/room|goal|leader|stall|orchestrat|房间|目标/u.test(message)) return 'room-goal'
  // Transport tokens are checked BEFORE the bare "timed out": ETIMEDOUT is a network/connect
  // timeout (the provider side), while a plain "timed out" with no network signal is the
  // harness deadline. An explicit timeout failureKind already won above, so the budget
  // verdict is never re-attributed by message text.
  if (/transport|network|econn|etimedout|enotfound|5\d\d|rate[ _-]?limit|provider|model|stream|请求|模型/u.test(message)) {
    return 'model'
  }
  if (/timed? ?out|timeout/u.test(message)) return 'harness'
  return 'unknown'
}

export interface FinishPathInput {
  readonly status: string
  readonly replyText?: string | undefined
  /** The `finish_task` report, when the run called it. */
  readonly finishReport?: string | undefined
  readonly stopped?: boolean | undefined
  readonly failureKind?: FailureKind | undefined
}

/**
 * How the run ended, in the closed vocabulary.
 *
 * Precedence follows causality: an explicit stop or a budget verdict describes WHY the turn
 * ended even when it also produced text; then a failure; then a delivery (a finish report is a
 * stronger statement than the turn's prose); then a silent completed turn.
 */
export function finishPathOf(input: FinishPathInput): RunFinishPath {
  if (input.stopped === true) return 'stopped'
  if (input.failureKind === 'timeout') return 'timeout'
  if (input.failureKind === 'no-progress') return 'no-progress'
  const status = input.status
  if (status === 'interrupted' || status === 'cancelled') return 'stopped'
  if (status === 'failed') return 'failed'
  if ((input.finishReport ?? '').trim() !== '') return 'finish_task'
  if ((input.replyText ?? '').trim() !== '') return 'reply'
  if (status === 'completed') return 'empty'
  return 'unknown'
}

/** Count tool cards and how many of them failed (pure; no tool OUTPUT is read). */
export function countToolActivity(toolActivity: readonly ToolActivityLike[] | undefined): {
  readonly toolCalls: number
  readonly toolFailures: number
} {
  const cards = toolActivity ?? []
  let failures = 0
  for (const card of cards) {
    if (FAILED_TOOL_STATUSES.has((card.status ?? '').toLowerCase())) failures += 1
  }
  return { toolCalls: cards.length, toolFailures: failures }
}

export interface RunEvidenceInput {
  readonly durationMs?: number | undefined
  readonly promptChars?: number | undefined
  readonly toolCalls?: number | undefined
  readonly toolFailures?: number | undefined
  /** Optional raw tool cards: counts are derived when explicit counts are absent. */
  readonly toolActivity?: readonly ToolActivityLike[] | undefined
  readonly deliverableCount?: number | undefined
  readonly contextWindowMessages?: number | undefined
  readonly approvalRequests?: number | undefined
  readonly usage?: RunEvidenceUsage | undefined
  readonly finishPath?: RunFinishPath | undefined
  readonly faultSide?: RunFaultSide | undefined
  /** OP-15: measured characters per prompt section (no text). */
  readonly contextSections?: Readonly<Record<string, number>> | undefined
  /** OP-15: rough token estimate for the whole prompt. */
  readonly promptTokensEstimate?: number | undefined
}

/** A finite, non-negative integer, or undefined (never NaN/Infinity/negative in persisted state). */
function counter(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value)
}

/**
 * Normalize a per-section character record: non-negative integers only, empty/zero sections
 * dropped, keys bounded and sorted (deterministic persisted state, no smuggled free text).
 */
function contextSectionsOf(
  value: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined
  const entries: Array<[string, number]> = []
  for (const [key, chars] of Object.entries(value)) {
    const name = key.trim()
    if (name === '' || name.length > 40) continue
    const count = counter(chars)
    if (count === undefined || count === 0) continue
    entries.push([name, count])
    if (entries.length >= 32) break
  }
  if (entries.length === 0) return undefined
  entries.sort((left, right) => left[0].localeCompare(right[0]))
  return Object.fromEntries(entries)
}

function usageOf(value: RunEvidenceUsage | undefined): RunEvidence['usage'] {
  if (value === undefined) return undefined
  const uncachedInputTokens = counter(value.uncachedInputTokens)
  const outputTokens = counter(value.outputTokens)
  const totalTokens = counter(value.totalTokens)
  if (uncachedInputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined
  }
  return { uncachedInputTokens, outputTokens, totalTokens }
}

/**
 * Merge raw counters into the ONE evidence record persisted on the run.
 *
 * Fixed keys only (so nothing can be smuggled in), numbers normalised (so a NaN or a negative
 * never reaches state.json), undefined fields omitted (exactOptionalPropertyTypes-friendly),
 * and — by construction — no free text field exists at all.
 */
export function buildRunEvidence(input: RunEvidenceInput): RunEvidence {
  const toolCounts = countToolActivity(input.toolActivity)
  const toolCalls = counter(input.toolCalls) ?? toolCounts.toolCalls
  const toolFailures = counter(input.toolFailures) ?? toolCounts.toolFailures
  return {
    ...(counter(input.durationMs) !== undefined ? { durationMs: counter(input.durationMs)! } : {}),
    ...(counter(input.promptChars) !== undefined ? { promptChars: counter(input.promptChars)! } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolFailures !== undefined ? { toolFailures } : {}),
    ...(counter(input.deliverableCount) !== undefined ? { deliverableCount: counter(input.deliverableCount)! } : {}),
    ...(counter(input.contextWindowMessages) !== undefined
      ? { contextWindowMessages: counter(input.contextWindowMessages)! }
      : {}),
    ...(counter(input.approvalRequests) !== undefined
      ? { approvalRequests: counter(input.approvalRequests)! }
      : {}),
    ...(usageOf(input.usage) !== undefined ? { usage: usageOf(input.usage)! } : {}),
    ...(input.finishPath !== undefined ? { finishPath: input.finishPath } : {}),
    ...(input.faultSide !== undefined ? { faultSide: input.faultSide } : {}),
    ...(contextSectionsOf(input.contextSections) !== undefined
      ? { contextSections: contextSectionsOf(input.contextSections)! }
      : {}),
    ...(counter(input.promptTokensEstimate) !== undefined
      ? { promptTokensEstimate: counter(input.promptTokensEstimate)! }
      : {}),
  }
}
