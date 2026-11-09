/**
 * context-pressure.ts — the pure judgement layer for long-context pressure (P5-1).
 *
 * WHY A SEPARATE THRESHOLD MODULE. The host exposes today's context usage as a sample
 * (`tokenMeter.contextPressure(session)` → pressure tokens + context window) and compaction as an
 * action (`compaction.compactIfNeeded`/`compactNow`). What is missing is the DECISION in between:
 * "is this just normal use, is it time to compact, or is compaction no longer enough and the run
 * should cut over to a new session segment with a handoff note?" — plus the one grey room notice
 * that tells the user something happened. Scattering those thresholds and strings through the
 * service would make the behaviour untestable and easy to drift, so this module owns the judgement
 * ONLY: no IO, no clock, no host types — one sample in, one decision out.
 *
 * THE CONTRACT THE HOST RELIES ON
 *   · an unusable sample (non-finite tokens/window, window <= 0, negative tokens) is ALWAYS `ok`
 *     with ratio 0: a host that cannot read the meter must not start compacting (zero behaviour
 *     change by default);
 *   · the ratio is `pressureTokens / contextWindow`, never wrapped: usage above the window yields
 *     a ratio above 1 and therefore `overflow` (compaction cannot fix that situation);
 *   · thresholds are the canonical `overflow >= hard >= soft`; an invalid item (non-finite, <= 0,
 *     > 1) falls back to its default, and an out-of-order item falls back to defaults too, so a
 *     typo can never make the levels contradict each other;
 *   · `shouldCompact` is "anything above ok"; `shouldSwitchSegment` is "overflow only" — the
 *     caller does not re-derive either;
 *   · the reason always contains the current percentage AND all three thresholds, in the same
 *     resolved form the levels were computed from;
 *   · the room notice is only emitted for hard/overflow: soft is handled quietly by compaction,
 *     and an `ok` room must never be told its context is full.
 *
 * @module
 */

/** One context-usage reading: what the host meter reports for the session. */
export interface ContextPressureSample {
  /** Used context tokens (`tokenMeter`'s pressureTokens). */
  readonly pressureTokens: number
  /** The model's context window in tokens. */
  readonly contextWindow: number
}

/** How bad the current context usage is, from "business as usual" to "past the window". */
export type ContextPressureLevel = 'ok' | 'soft' | 'hard' | 'overflow'

/** Level thresholds as fractions of the context window; every field is optional. */
export interface ContextPressureThresholds {
  /** Where `soft` begins (compaction advisable). Defaults to 0.60. */
  readonly softRatio?: number | undefined
  /** Where `hard` begins (compaction urgent). Defaults to 0.80. */
  readonly hardRatio?: number | undefined
  /** Where `overflow` begins (compaction can no longer help). Defaults to 0.95. */
  readonly overflowRatio?: number | undefined
}

/** Everything the host needs after one sample: the level, the flags, the log line. */
export interface ContextPressureDecision {
  readonly level: ContextPressureLevel
  /** `pressureTokens / contextWindow`; 0 when the window/usage is unknown or invalid. */
  readonly ratio: number
  /** True when `level` is not `ok` — the host should trigger its compaction path. */
  readonly shouldCompact: boolean
  /** True only for `overflow` — switch to a fresh session segment and keep a handoff note. */
  readonly shouldSwitchSegment: boolean
  /** One Chinese line with the current percentage and every threshold; log/notice ready. */
  readonly reason: string
}

/** Concrete defaults, number-typed for the resolver (`Required<…>` keeps `| undefined`). */
const DEFAULT_SOFT_RATIO = 0.60
const DEFAULT_HARD_RATIO = 0.80
const DEFAULT_OVERFLOW_RATIO = 0.95

/**
 * Deployment thresholds. Deliberately conservative: compact softly at 60%, urgently at 80%, and
 * switch the session segment at 95% (before the provider starts rejecting the request).
 */
export const DEFAULT_CONTEXT_THRESHOLDS: Required<ContextPressureThresholds> = Object.freeze({
  softRatio: DEFAULT_SOFT_RATIO,
  hardRatio: DEFAULT_HARD_RATIO,
  overflowRatio: DEFAULT_OVERFLOW_RATIO,
})

/**
 * `pressureTokens / contextWindow`, or 0 when the sample cannot be used.
 *
 * The ratio is not clamped at 1: a session above its window must read as `> 1` (overflow), not
 * wrap around to a small number. A negative usage is treated as "unknown", not as free space.
 */
export function contextPressureRatio(sample: ContextPressureSample): number {
  if (!isUsableSample(sample)) return 0
  return sample.pressureTokens / sample.contextWindow
}

/**
 * Classify a ratio against the (normalized) thresholds.
 *
 * Boundaries are inclusive (`>=`): exactly 60% is already `soft`, exactly 80% already `hard`,
 * exactly 95% already `overflow`. A non-finite/negative ratio is `ok` — the meter said something
 * it cannot mean, so the safe default is "do not intervene".
 */
export function contextPressureLevel(ratio: number, thresholds?: ContextPressureThresholds): ContextPressureLevel {
  const resolved = resolveThresholds(thresholds)
  if (!(ratio >= resolved.softRatio)) return 'ok'
  if (ratio >= resolved.overflowRatio) return 'overflow'
  if (ratio >= resolved.hardRatio) return 'hard'
  return 'soft'
}

/**
 * The full decision for one sample: level, ratio, the two action flags and the reason line.
 *
 * An unusable sample returns the same nothing-to-do decision every time (`ok`, ratio 0, no flags),
 * with a reason that says the window is unknown — this is the default zero-behaviour path the
 * host relies on before it has a usable meter.
 */
export function decideContextPressure(sample: ContextPressureSample, thresholds?: ContextPressureThresholds): ContextPressureDecision {
  const resolved = resolveThresholds(thresholds)
  if (!isUsableSample(sample)) {
    return {
      level: 'ok',
      ratio: 0,
      shouldCompact: false,
      shouldSwitchSegment: false,
      reason: '上下文窗口未知，不干预',
    }
  }
  const ratio = sample.pressureTokens / sample.contextWindow
  const level = levelOfRatio(ratio, resolved)
  return {
    level,
    ratio,
    shouldCompact: level !== 'ok',
    shouldSwitchSegment: level === 'overflow',
    reason: reasonOf(level, ratio, resolved),
  }
}

/**
 * The grey-room notice for a decision, or undefined when there is nothing to tell the user.
 *
 * Only `hard` (compaction is actively running) and `overflow` (the next turn will move to a new
 * session segment) are worth a line. `soft` is handled silently and `ok` is normal operation —
 * emitting a notice there would just be noise.
 */
export function contextPressureNotice(decision: ContextPressureDecision): string | undefined {
  switch (decision.level) {
    case 'ok':
    case 'soft':
      return undefined
    case 'hard':
      return `上下文接近窗口上限（已用 ${percentOf(decision.ratio)}），正在自动压缩较早的历史。`
    case 'overflow':
      return `上下文即将超出窗口（已用 ${percentOf(decision.ratio)}），下一轮将切换到新会话段并保留交接说明。`
  }
}

/** Thresholds with defaults and the canonical ordering already applied. */
interface ResolvedThresholds {
  readonly softRatio: number
  readonly hardRatio: number
  readonly overflowRatio: number
}

/** A usable reading: finite numbers, a positive window and a non-negative usage. */
function isUsableSample(sample: ContextPressureSample): boolean {
  return Number.isFinite(sample.pressureTokens)
    && Number.isFinite(sample.contextWindow)
    && sample.contextWindow > 0
    && sample.pressureTokens >= 0
}

/** A threshold candidate: a finite fraction inside (0, 1]. */
function isUsableRatio(ratio: number | undefined): ratio is number {
  return ratio !== undefined && Number.isFinite(ratio) && ratio > 0 && ratio <= 1
}

/**
 * Normalize thresholds to the canonical `overflow >= hard >= soft`.
 *
 *   · an absent or invalid item (non-finite, <= 0, > 1) uses its default;
 *   · if the resolved triple is out of order, the inverted PAIR falls back to its defaults
 *     (`soft > hard` resets soft+hard; `hard > overflow` resets hard+overflow), so one typo does
 *     not silently reinterpret the levels;
 *   · if a custom value and a default still conflict after that, the whole set falls back to
 *     {@link DEFAULT_CONTEXT_THRESHOLDS} — the defaults are always self-consistent.
 *
 * Equal thresholds are allowed (`soft == hard` simply makes the intermediate level unreachable);
 * the invariant is `overflow >= hard >= soft`, not strict inequality.
 */
function resolveThresholds(thresholds?: ContextPressureThresholds): ResolvedThresholds {
  const soft = thresholds?.softRatio
  const hard = thresholds?.hardRatio
  const overflow = thresholds?.overflowRatio
  let softRatio = isUsableRatio(soft) ? soft : DEFAULT_SOFT_RATIO
  let hardRatio = isUsableRatio(hard) ? hard : DEFAULT_HARD_RATIO
  let overflowRatio = isUsableRatio(overflow) ? overflow : DEFAULT_OVERFLOW_RATIO
  if (hardRatio < softRatio) {
    softRatio = DEFAULT_SOFT_RATIO
    hardRatio = DEFAULT_HARD_RATIO
  }
  if (overflowRatio < hardRatio) {
    hardRatio = DEFAULT_HARD_RATIO
    overflowRatio = DEFAULT_OVERFLOW_RATIO
  }
  if (hardRatio < softRatio || overflowRatio < hardRatio) {
    softRatio = DEFAULT_SOFT_RATIO
    hardRatio = DEFAULT_HARD_RATIO
    overflowRatio = DEFAULT_OVERFLOW_RATIO
  }
  return { softRatio, hardRatio, overflowRatio }
}

/** Level classification over already-resolved thresholds (shared by decide and level). */
function levelOfRatio(ratio: number, thresholds: ResolvedThresholds): ContextPressureLevel {
  if (!(ratio >= thresholds.softRatio)) return 'ok'
  if (ratio >= thresholds.overflowRatio) return 'overflow'
  if (ratio >= thresholds.hardRatio) return 'hard'
  return 'soft'
}

/** One log line: current percentage and all thresholds, plus the action the level implies. */
function reasonOf(level: ContextPressureLevel, ratio: number, thresholds: ResolvedThresholds): string {
  const action = level === 'overflow'
    ? '建议切换到新会话段'
    : level === 'ok' ? '正常' : '建议压缩'
  return `上下文已用 ${percentOf(ratio)}（soft ${percentOf(thresholds.softRatio)} / hard ${percentOf(thresholds.hardRatio)} / overflow ${percentOf(thresholds.overflowRatio)}），${action}`
}

/** A ratio as a whole percentage, rounded (0.6 → "60%", 1.25 → "125%"). */
function percentOf(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}
