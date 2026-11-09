/**
 * Outbox (S1-5) — durable retry for side effects that can fail.
 *
 * WHY THIS EXISTS. An in-memory queue is lost on a crash, and a side effect that failed once is
 * usually transient: a host call timed out, a service was being replaced, a file system was busy.
 * The Super-agent prototype's answer is a durable effect queue: store the intent FIRST, execute it
 * after commit, retry with backoff, keep the order of one kind, and report a kind that keeps
 * failing instead of dropping it silently.
 *
 * SCOPE IN THIS PLUGIN (important). Room messages and notices do NOT need an outbox here: they are
 * already durable in `state.json` + the ledger journal, and the ledger is the source of truth. The
 * genuinely fallible side effects are HOST calls — today that is settling a fired reminder's row in
 * DSH's schedule service (`delete`/`update`). That call used to be best-effort fire-and-forget: a
 * transient failure left the reminder visible as permanently active, and a crash before the call
 * lost it entirely. This module makes exactly that class of call durable and retryable.
 *
 * WHAT IS STORED. `{ id, kind, key, payload, attempts, dueAt, createdAt }`, deduplicated by
 * `kind+key`: re-enqueuing replaces the PAYLOAD and re-arms the effect immediately (latest intent
 * wins), but KEEPS the accumulated attempts/id/createdAt. Resetting the count on every re-enqueue
 * would make a subsystem that keeps failing across occurrences look healthy forever — each fresh
 * intent would restart the budget before `maxAttempts` could ever be reached (review F3). The cap
 * keeps a broken host from growing the file without bound.
 *
 * Everything here is pure: the service owns the timer, the file and the handler registry.
 *
 * @module
 */

/** One pending side effect. `payload` is handler-owned JSON; the queue never interprets it. */
export interface OutboxEffect {
  readonly id: string
  readonly kind: string
  /** Dedupe key within a kind (e.g. a schedule id). */
  readonly key: string
  readonly payload: unknown
  /** Failed attempts so far; 0 until the first failure. */
  readonly attempts: number
  /** C9 fix: bumped on every re-arm; a stale in-flight settle may only act on its own revision. */
  readonly revision: number
  readonly dueAt: number
  readonly createdAt: number
}

export interface OutboxConfig {
  /** Total attempts before an effect is dropped and reported. */
  readonly maxAttempts: number
  /** First retry delay; doubles per failure. */
  readonly baseBackoffMs: number
  /** Cap on a single retry delay. */
  readonly maxBackoffMs: number
  /** Cap on stored effects; the oldest are dropped first. */
  readonly maxEffects: number
}

export const DEFAULT_OUTBOX: OutboxConfig = {
  maxAttempts: 3,
  baseBackoffMs: 2_000,
  maxBackoffMs: 30_000,
  maxEffects: 200,
}

/** Clamp a partial config; zero/negative attempts are clamped to 1. */
export function normalizeOutboxConfig(input: Partial<OutboxConfig> | undefined): OutboxConfig {
  // A non-negative value is clamped up to the minimum; a negative/non-finite one falls back to the
  // default (it is a mistake, not a preference).
  const number = (value: number | undefined, fallback: number, min: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.max(min, Math.floor(value))
      : fallback
  return {
    maxAttempts: number(input?.maxAttempts, DEFAULT_OUTBOX.maxAttempts, 1),
    baseBackoffMs: number(input?.baseBackoffMs, DEFAULT_OUTBOX.baseBackoffMs, 0),
    maxBackoffMs: number(input?.maxBackoffMs, DEFAULT_OUTBOX.maxBackoffMs, 0),
    maxEffects: number(input?.maxEffects, DEFAULT_OUTBOX.maxEffects, 1),
  }
}

/** Delay before the next attempt after `failures` consecutive failures (1-based). */
export function backoffFor(failures: number, config: OutboxConfig): number {
  const n = Math.max(1, Math.floor(failures))
  const raw = config.baseBackoffMs * 2 ** (n - 1)
  return Math.min(config.maxBackoffMs, Math.max(0, raw))
}

/**
 * Add or replace an effect.
 *
 * The same `kind+key` is never stored twice: a newer intent replaces the old payload and is
 * re-armed immediately (`dueAt = now`), because retrying a stale payload after a fresh one arrived
 * would undo the new intent. The accumulated `attempts` (and the id/createdAt) are PRESERVED: a
 * host side effect that fails across several occurrences must still exhaust its budget and reach
 * `healthFailure` instead of resetting to zero on every re-enqueue. The cap drops the oldest
 * `createdAt` entries first.
 */
export function enqueueEffect(
  effects: readonly OutboxEffect[],
  input: {
    readonly id: string
    readonly kind: string
    readonly key: string
    readonly payload: unknown
    readonly now: number
    readonly config: OutboxConfig
  },
): OutboxEffect[] {
  const existing = effects.find(candidate => candidate.kind === input.kind && candidate.key === input.key)
  const effect: OutboxEffect = {
    id: existing?.id ?? input.id,
    kind: input.kind,
    key: input.key,
    payload: input.payload,
    attempts: existing?.attempts ?? 0,
    revision: (existing?.revision ?? 0) + 1,
    dueAt: input.now,
    createdAt: existing?.createdAt ?? input.now,
  }
  const withoutSameKey = effects.filter(candidate => !(candidate.kind === effect.kind && candidate.key === effect.key))
  const next = [...withoutSameKey, effect]
  if (next.length <= input.config.maxEffects) return next
  return next
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(next.length - input.config.maxEffects)
}

/** Effects ready to run, oldest first, capped per drain. */
export function dueEffects(
  effects: readonly OutboxEffect[],
  now: number,
  limit: number,
): OutboxEffect[] {
  return [...effects]
    .filter(effect => effect.dueAt <= now)
    .sort((a, b) => (a.dueAt - b.dueAt) || (a.createdAt - b.createdAt))
    .slice(0, Math.max(0, Math.floor(limit)))
}

/**
 * Remove a successfully run effect.
 *
 * C9: when `revision` is given, only the effect version the caller actually ran is removed. If a
 * recurring schedule re-armed the same kind+key while the handler was awaiting, the newer intent
 * stays queued instead of being silently deleted by the older success.
 */
export function settleEffectSuccess(effects: readonly OutboxEffect[], id: string, revision?: number): OutboxEffect[] {
  return effects.filter(effect => effect.id !== id
    || (revision !== undefined && effect.revision !== revision))
}

/**
 * Record a failed attempt.
 *
 * Under the cap the effect is rescheduled with exponential backoff; at the cap it is REMOVED and
 * returned as `exhausted`, so the caller can report the subsystem once instead of retrying forever.
 */
export function settleEffectFailure(
  effects: readonly OutboxEffect[],
  id: string,
  now: number,
  config: OutboxConfig,
  revision?: number,
): { readonly effects: OutboxEffect[]; readonly exhausted: boolean; readonly effect?: OutboxEffect } {
  const target = effects.find(effect => effect.id === id && (revision === undefined || effect.revision === revision))
  if (target === undefined) return { effects: [...effects], exhausted: false }
  const attempts = target.attempts + 1
  if (attempts >= config.maxAttempts) {
    return {
      effects: effects.filter(effect => effect.id !== id),
      exhausted: true,
      effect: target,
    }
  }
  return {
    effects: effects.map(effect =>
      effect.id === id ? { ...effect, attempts, dueAt: now + backoffFor(attempts, config) } : effect),
    exhausted: false,
  }
}

/** Stable serialization for the on-disk file (sorted so two equal queues write equal bytes). */
export function serializeEffects(effects: readonly OutboxEffect[]): string {
  return JSON.stringify([...effects].sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id)), null, 2)
}

/** Whether one parsed value is a usable effect. */
function isEffect(value: unknown): value is OutboxEffect {
  if (value === null || typeof value !== 'object') return false
  const view = value as Record<string, unknown>
  return typeof view['id'] === 'string' && view['id'] !== ''
    && typeof view['kind'] === 'string' && view['kind'] !== ''
    && typeof view['key'] === 'string'
    && Number.isFinite(view['attempts']) && (view['attempts'] as number) >= 0
    && Number.isFinite(view['dueAt'])
    && Number.isFinite(view['createdAt'])
    && 'payload' in view
}

/**
 * Parse the outbox file, tolerating damage.
 *
 * A missing/empty file is an empty queue; a bad entry is dropped (and counted) while the good ones
 * survive; a file that is not an array yields an empty queue. The caller logs when dropped > 0 —
 * never throwing here keeps a corrupt file from blocking startup.
 */
export function parseEffects(text: string, config: OutboxConfig): { effects: OutboxEffect[]; dropped: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { effects: [], dropped: 1 }
  }
  if (!Array.isArray(parsed)) return { effects: [], dropped: 1 }
  const effects: OutboxEffect[] = []
  let dropped = 0
  for (const value of parsed) {
    if (!isEffect(value)) {
      dropped += 1
      continue
    }
    effects.push({
      id: value.id,
      kind: value.kind,
      key: value.key,
      payload: value.payload,
      attempts: Math.floor(value.attempts),
      revision: Number.isFinite(value.revision) && (value.revision as number) >= 1
        ? Math.floor(value.revision as number)
        : 1,
      dueAt: value.dueAt,
      createdAt: value.createdAt,
    })
  }
  return {
    effects: effects.length <= config.maxEffects
      ? effects
      : effects.sort((a, b) => a.createdAt - b.createdAt).slice(effects.length - config.maxEffects),
    dropped,
  }
}
