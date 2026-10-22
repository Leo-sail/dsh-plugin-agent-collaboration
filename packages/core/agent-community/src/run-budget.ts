/**
 * Adaptive Task-time Allowance (ATA) — how long one bot run may take.
 *
 * THE USER'S RULE: runTimeout must be configured from what the task ACTUALLY takes, not from
 * one hardcoded number. The measured history of this deployment makes the point: 368 completed
 * runs span 51 s (p50) to 5,052 s (max), and the p95 ranges from 82 s for one bot to 1,931 s
 * for another. A fixed 600 s deadline would have killed 14 real, successful runs.
 *
 * So a deadline is derived, per run, from three sorted fallbacks:
 *
 *   1. the same (bot, origin, task-class) sample  → p95 × safety
 *   2. the same origin sample                     → p95 × safety
 *   3. every completed run in the deployment      → p95 × safety
 *   4. a configured bootstrap (cold start only)   → NEVER a literal in the runtime path
 *
 * …then clamped into `max(floorMs, 3×median) .. capMs` so a fast-but-noisy class and a
 * long-tail class both stay sane. While the run is live, real progress (stream frames, tool
 * starts/ends) can extend the deadline a bounded number of times; silence cannot — that is
 * "no-progress" and it ends the run.
 *
 * Everything here is pure and dependency-free so the policy can be tested without a host.
 *
 * @module
 */

/** What kind of work a run is doing, used to pick the duration sample. */
export type TaskClass =
  | 'user-task'
  | 'goal-continuation'
  | 'schedule'
  | 'member-report'
  | 'a2a'
  | 'task-board'
  | 'unknown'

/** Why a failed run failed — decides whether a retry is allowed. */
export type FailureKind =
  | 'provider'
  | 'tool'
  | 'timeout'
  | 'no-progress'
  | 'user-cancel'
  | 'lease-lost'
  | 'unknown'

/** Which sample set produced a budget, for the ledger/log line that explains the deadline. */
export type BudgetSource = 'key' | 'origin' | 'all' | 'bootstrap'

export interface RunTimeoutPolicy {
  /** Cold-start deadline when no sample reaches MIN_SAMPLE_SIZE. Config value, not a literal. */
  readonly bootstrapMs: number
  /** Lowest deadline any run gets. */
  readonly floorMs: number
  /** Highest deadline any run gets. */
  readonly capMs: number
  /** How many newest completed runs are used per sample set. */
  readonly sampleWindow: number
  /** p95 × safetyFactor = the starting budget. */
  readonly safetyFactor: number
  /** no-progress window = noProgressFactor × observed inter-progress gap. */
  readonly noProgressFactor: number
  readonly noProgressFloorMs: number
  readonly noProgressCapMs: number
  /** One extension adds baseBudget × extendFactor. */
  readonly extendFactor: number
  /** How many times a progressing run may be extended. */
  readonly maxExtensions: number
}

export interface RunRetryPolicy {
  /** Total attempts allowed (attempt starts at 0). */
  readonly maxAttempts: number
  /** Base backoff; attempt N waits backoffMs × 2^N. */
  readonly backoffMs: number
}

/**
 * Deployment defaults.
 *
 * These are the values a fresh install uses — BOTH are configurable through the plugin's
 * Config, and neither is a hidden runtime constant: `bootstrapMs` is only the cold-start
 * approximation before the deployment has its own history.
 */
export const DEFAULT_RUN_TIMEOUT_POLICY: RunTimeoutPolicy = {
  bootstrapMs: 900_000,        // 15 min cold start (the first runs have no history yet)
  floorMs: 180_000,            // never kill a run inside 3 min
  capMs: 7_200_000,            // 2 h hard ceiling, configurable
  sampleWindow: 50,
  safetyFactor: 1.5,
  noProgressFactor: 3,
  noProgressFloorMs: 120_000,  // silence inside 2 min is normal (thinking, a slow tool)
  noProgressCapMs: 1_800_000,  // 30 min of silence is a hang, whatever the history
  extendFactor: 0.5,
  maxExtensions: 2,
}

export const DEFAULT_RUN_RETRY_POLICY: RunRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 5_000,
}

/** A sample set needs this many runs before its p95 is trusted. */
export const MIN_SAMPLE_SIZE = 5

/** Merge a partial config over the deployment defaults, clamping the numbers that can hurt. */
export function resolveTimeoutPolicy(partial: Partial<RunTimeoutPolicy> | undefined): RunTimeoutPolicy {
  const merged = { ...DEFAULT_RUN_TIMEOUT_POLICY, ...(partial ?? {}) }
  const positive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
  const capMs = positive(merged.capMs, DEFAULT_RUN_TIMEOUT_POLICY.capMs)
  const floorMs = Math.min(positive(merged.floorMs, DEFAULT_RUN_TIMEOUT_POLICY.floorMs), capMs)
  const factor = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? value : fallback
  return {
    bootstrapMs: Math.min(positive(merged.bootstrapMs, DEFAULT_RUN_TIMEOUT_POLICY.bootstrapMs), capMs),
    floorMs,
    capMs,
    sampleWindow: Math.max(MIN_SAMPLE_SIZE, Math.round(positive(merged.sampleWindow, DEFAULT_RUN_TIMEOUT_POLICY.sampleWindow))),
    // Factors stay fractional (1.5, 0.5): rounding them to integers silently changed the
    // policy (1.5 → 2, 0.5 → 1), which is why they are validated, not truncated.
    safetyFactor: factor(merged.safetyFactor, DEFAULT_RUN_TIMEOUT_POLICY.safetyFactor),
    noProgressFactor: factor(merged.noProgressFactor, DEFAULT_RUN_TIMEOUT_POLICY.noProgressFactor),
    noProgressFloorMs: positive(merged.noProgressFloorMs, DEFAULT_RUN_TIMEOUT_POLICY.noProgressFloorMs),
    noProgressCapMs: positive(merged.noProgressCapMs, DEFAULT_RUN_TIMEOUT_POLICY.noProgressCapMs),
    extendFactor: factor(merged.extendFactor, DEFAULT_RUN_TIMEOUT_POLICY.extendFactor),
    maxExtensions: Math.max(0, Math.round(Number.isFinite(merged.maxExtensions) ? merged.maxExtensions : DEFAULT_RUN_TIMEOUT_POLICY.maxExtensions)),
  }
}

/** Merge a partial config over the deployment retry defaults. */
export function resolveRetryPolicy(partial: Partial<RunRetryPolicy> | undefined): RunRetryPolicy {
  const merged = { ...DEFAULT_RUN_RETRY_POLICY, ...(partial ?? {}) }
  const attempts = Number.isFinite(merged.maxAttempts) ? Math.round(merged.maxAttempts) : DEFAULT_RUN_RETRY_POLICY.maxAttempts
  const backoff = Number.isFinite(merged.backoffMs) ? Math.round(merged.backoffMs) : DEFAULT_RUN_RETRY_POLICY.backoffMs
  return {
    maxAttempts: Math.max(1, attempts),
    backoffMs: Math.max(0, backoff),
  }
}

/** Which task class a run belongs to, from its prompt prefix and origin. */
export function taskClassOf(prompt: string | undefined, origin: string | undefined): TaskClass {
  const text = prompt ?? ''
  // Prefixes are the most specific signal: the caller wrote them when the run was queued.
  if (text.startsWith('[继续目标]')) return 'goal-continuation'
  if (text.startsWith('[成员汇报]')) return 'member-report'
  if (text.startsWith('[任务]')) return 'task-board'
  if (text.startsWith('[来自 ')) return 'a2a'
  if (text.includes('定时任务') || text.startsWith('[定时')) return 'schedule'
  switch (origin) {
    case 'routine': return 'schedule'
    case 'bot-message': return 'member-report'
    case 'a2a': return 'a2a'
    case 'user': return 'user-task'
    default: return 'unknown'
  }
}

function finiteValues(values: readonly number[] | undefined): number[] {
  return (values ?? []).filter(v => Number.isFinite(v) && v >= 0)
}

/** Nearest-rank percentile: q in (0, 1]; returns undefined for an empty sample. */
export function percentile(values: readonly number[], q: number): number | undefined {
  const sorted = finiteValues(values).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const clampedQ = Math.min(1, Math.max(Number.EPSILON, q))
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(clampedQ * sorted.length)))
  return sorted[rank - 1]
}

/** Median of a sample (undefined for an empty sample). */
export function median(values: readonly number[]): number | undefined {
  const sorted = finiteValues(values).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  const left = sorted[mid - 1] ?? 0
  const right = sorted[mid] ?? left
  return (left + right) / 2
}

export interface DeadlineBudgetInput {
  /** Durations of completed runs for this exact key, newest first or any order. */
  readonly durationsMs: readonly number[]
  /** Durations for the same origin (all task classes). */
  readonly originDurationsMs: readonly number[]
  /** Durations for every completed run in the deployment. */
  readonly allDurationsMs: readonly number[]
  readonly policy: RunTimeoutPolicy
}

export interface DeadlineBudget {
  readonly budgetMs: number
  readonly source: BudgetSource
  readonly samples: number
}

/**
 * The derived deadline budget for one run.
 *
 * THE VALUE IS NEVER A CONSTANT: it is a p95 of real durations whenever there is enough
 * history, and the configured bootstrap only for the cold start. The clamp keeps a run with
 * an unusually fast sample from being killed early (floor + 3×median) and a pathological
 * long-tail from running forever (cap).
 */
export function deriveDeadlineBudget(input: DeadlineBudgetInput): DeadlineBudget {
  const policy = input.policy
  const batches: ReadonlyArray<{ readonly values: readonly number[]; readonly source: BudgetSource }> = [
    { values: input.durationsMs, source: 'key' },
    { values: input.originDurationsMs, source: 'origin' },
    { values: input.allDurationsMs, source: 'all' },
  ]
  for (const batch of batches) {
    const sample = finiteValues(batch.values)
    if (sample.length < MIN_SAMPLE_SIZE) continue
    const p95 = percentile(sample, 0.95) ?? 0
    const med = median(sample) ?? 0
    const rawBase = p95 * policy.safetyFactor
    const floorForThisSample = Math.max(policy.floorMs, med * 3)
    return {
      budgetMs: Math.round(clamp(rawBase, Math.min(floorForThisSample, policy.capMs), policy.capMs)),
      source: batch.source,
      samples: sample.length,
    }
  }
  return {
    budgetMs: Math.round(clamp(policy.bootstrapMs, policy.floorMs, policy.capMs)),
    source: 'bootstrap',
    samples: 0,
  }
}

/**
 * How long the run may go WITHOUT progress before it is treated as hung.
 *
 * Progress is a stream frame / tool start / tool end — not a heartbeat. A turn that is
 * thinking or running a slow tool is silent for a while, so the window is at least
 * `noProgressFloorMs`; a deployment with measured inter-progress gaps gets factor × p95.
 */
export function noProgressLimitMs(policy: RunTimeoutPolicy, observedGapP95Ms?: number | undefined): number {
  const observed = observedGapP95Ms !== undefined && Number.isFinite(observedGapP95Ms) && observedGapP95Ms > 0
    ? observedGapP95Ms * policy.noProgressFactor
    : policy.noProgressFloorMs
  const floor = Math.min(policy.noProgressFloorMs, policy.noProgressCapMs)
  return Math.round(clamp(observed, floor, Math.max(floor, policy.noProgressCapMs)))
}

/** Whether the run produced any progress inside the no-progress window. */
export function progressIsRecent(nowMs: number, lastProgressAtMs: number | undefined, policy: RunTimeoutPolicy): boolean {
  if (lastProgressAtMs === undefined || !Number.isFinite(lastProgressAtMs)) return false
  const age = nowMs - lastProgressAtMs
  return age >= 0 && age <= noProgressLimitMs(policy)
}

export interface ShouldExtendInput {
  readonly nowMs: number
  readonly deadlineAtMs: number
  readonly lastProgressAtMs: number | undefined
  readonly policy: RunTimeoutPolicy
  /** Extensions already granted. */
  readonly extensions: number
  /** When the run started; bounds the extension chain by policy.capMs from start. */
  readonly startedAtMs?: number | undefined
  /** The base budget a single extension is a fraction of. */
  readonly baseBudgetMs?: number | undefined
}

export type DeadlineVerdict = 'ok' | 'extend' | 'timed-out'

/**
 * The one decision at the deadline: keep going (still progressing), or stop the run.
 *
 * A deadline that arrives while the turn is clearly STILL PROGRESSING is extended a bounded
 * number of times — long tasks are not bugs. A deadline that arrives with no recent progress
 * is a hang, and it is not retried.
 */
export function shouldExtend(input: ShouldExtendInput): DeadlineVerdict {
  if (input.nowMs < input.deadlineAtMs) return 'ok'
  if (!progressIsRecent(input.nowMs, input.lastProgressAtMs, input.policy)) return 'timed-out'
  if (input.extensions >= input.policy.maxExtensions) return 'timed-out'
  return nextExtensionDeadline(input) === undefined ? 'timed-out' : 'extend'
}

/**
 * The deadline after one extension, or undefined when the cap leaves no room.
 *
 * An extension is `baseBudget × extendFactor`. The chain cannot pass `startedAt + capMs`;
 * when the cap is closer than one full step the remaining sliver is granted (so a run at the
 * cap is not extended into an infinite tail of tiny steps — the next call then returns
 * undefined because nothing moved).
 */
export function nextExtensionDeadline(input: ShouldExtendInput): number | undefined {
  const policy = input.policy
  const base = input.baseBudgetMs !== undefined && Number.isFinite(input.baseBudgetMs)
    ? input.baseBudgetMs
    : input.startedAtMs !== undefined && input.deadlineAtMs > input.startedAtMs
      ? input.deadlineAtMs - input.startedAtMs
      : policy.bootstrapMs
  const step = Math.max(1, Math.round(base * policy.extendFactor))
  const proposed = input.deadlineAtMs + step
  if (input.startedAtMs === undefined) return proposed
  const capAt = input.startedAtMs + policy.capMs
  if (proposed <= capAt) return proposed
  return capAt > input.deadlineAtMs ? capAt : undefined
}

/** Backoff for one retry attempt: backoffMs × 2^attempt (attempt is 0-based). */
export function retryBackoffMs(policy: RunRetryPolicy, attempt: number): number {
  const exponent = Math.max(0, Math.min(10, Math.trunc(attempt)))
  return policy.backoffMs * 2 ** exponent
}

/** Only transient/model-side failures are worth another attempt. */
export function isRetryableFailureKind(kind: FailureKind): boolean {
  return kind === 'provider' || kind === 'tool' || kind === 'lease-lost'
}

/**
 * Best-effort classification of a failed run.
 *
 * `timeout` / `no-progress` are decided by the budget code and passed explicitly; this covers
 * the generic error path so a provider failure may be retried while a user stop never is.
 */
export function classifyFailure(status: string | undefined, error: string | undefined): FailureKind {
  if (status === 'interrupted' || status === 'cancelled') return 'user-cancel'
  const msg = (error ?? '').toLowerCase()
  if (msg.includes('lease')) return 'lease-lost'
  if (msg.includes('no-progress') || msg.includes('no progress')) return 'no-progress'
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline')) return 'timeout'
  if (msg.includes('tool')) return 'tool'
  if (/provider|model|stream|api|http|empty_response|abort|模型|请求/.test(msg)) return 'provider'
  return 'unknown'
}

/** Clamp a value between two bounds. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
