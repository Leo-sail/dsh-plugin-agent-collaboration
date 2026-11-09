/**
 * Subsystem health (S0-7) — the notification rule, not the logging.
 *
 * WHY THIS EXISTS. A room can be quietly broken while every individual failure looks handled:
 * routing throws and is caught, prompt assembly degrades, a schedule's delivery fails, memory
 * writes are logged and retried. Each site already logs once; nobody aggregates. The article's
 * Watchdog section makes the point that process liveness is not enough — a subsystem that fails
 * three times in a row is a real signal, and one that succeeded again is not.
 *
 * WHAT IT IS. A pure record/level/notify policy over `(subsystem, outcome)` pairs:
 *   · consecutive failures accumulate, any success resets them to zero;
 *   · `warning` at 1–2 failures, `error` from the threshold (default 3) up;
 *   · only an `error` produces a notice, at most once per cooldown window (default 10 min),
 *     so a broken subsystem explains itself once instead of flooding the room.
 *
 * WHAT IT IS NOT. It does not catch, retry or repair anything — callers keep their own failure
 * handling. It stores no message text beyond the first line of the error (which is already shown
 * in the room's diagnosis row) and never enters prompts.
 *
 * LIFETIME. The rolling record lives in the service's memory only: a plugin reload / host restart
 * clears the streak and the notice cooldown, so a subsystem that keeps failing starts counting
 * again. That is deliberate — this is a live-process health signal, not a durable audit log (the
 * room notices it already wrote are durable; see `BotRoom.notices`).
 *
 * @module
 */

export type HealthLevel = 'ok' | 'warning' | 'error'

/** One subsystem's rolling state. Timestamps are milliseconds; absent means "never". */
export interface HealthRecord {
  readonly subsystem: string
  readonly consecutiveFailures: number
  /** First line of the latest error, clipped — enough to recognise it, never a prompt. */
  readonly lastError?: string | undefined
  readonly lastFailureAt?: number | undefined
  readonly lastOkAt?: number | undefined
  /** When the last ERROR notice was written, for the cooldown. */
  readonly lastNotifiedAt?: number | undefined
}

export type HealthOutcome =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly at: number; readonly error: unknown }

/** Consecutive failures before a subsystem is `error` (and before the room hears about it). */
export const HEALTH_ERROR_THRESHOLD = 3
/** Minimum gap between two error notices for one subsystem. */
export const HEALTH_NOTICE_COOLDOWN_MS = 10 * 60_000
/** How much of an error message the record keeps. */
export const HEALTH_ERROR_CHARS = 240

/** A stable, model-free description of an unknown thrown value. */
export function normalizeHealthError(error: unknown): string {
  const text = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : (() => {
          try {
            return JSON.stringify(error)
          } catch {
            return String(error)
          }
        })()
  const firstLine = text.split('\n')[0] ?? text
  return [...firstLine.trim()].slice(0, HEALTH_ERROR_CHARS).join('')
}

/** Apply one outcome to a subsystem's record, returning the new record. */
export function recordHealth(
  previous: HealthRecord | undefined,
  subsystem: string,
  outcome: HealthOutcome,
): HealthRecord {
  if (outcome.ok) {
    return {
      subsystem,
      consecutiveFailures: 0,
      lastOkAt: outcome.at,
      ...(previous?.lastError !== undefined ? { lastError: previous.lastError } : {}),
      ...(previous?.lastFailureAt !== undefined ? { lastFailureAt: previous.lastFailureAt } : {}),
      ...(previous?.lastNotifiedAt !== undefined ? { lastNotifiedAt: previous.lastNotifiedAt } : {}),
    }
  }
  return {
    subsystem,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    lastError: normalizeHealthError(outcome.error),
    lastFailureAt: outcome.at,
    ...(previous?.lastOkAt !== undefined ? { lastOkAt: previous.lastOkAt } : {}),
    ...(previous?.lastNotifiedAt !== undefined ? { lastNotifiedAt: previous.lastNotifiedAt } : {}),
  }
}

/** The level implied by the streak. */
export function healthLevel(record: HealthRecord, threshold: number = HEALTH_ERROR_THRESHOLD): HealthLevel {
  if (record.consecutiveFailures <= 0) return 'ok'
  return record.consecutiveFailures >= Math.max(1, Math.floor(threshold)) ? 'error' : 'warning'
}

/**
 * Whether this record owes the room a notice.
 *
 * Only `error` notifies. A record already notified inside the cooldown stays silent; a recovery
 * clears the streak but keeps the notified stamp, so a flapping subsystem is quiet for one window
 * instead of writing a line on every down-up cycle.
 */
export function shouldNotifyHealth(
  record: HealthRecord,
  now: number,
  options: { readonly threshold?: number | undefined; readonly cooldownMs?: number | undefined } = {},
): boolean {
  const threshold = options.threshold ?? HEALTH_ERROR_THRESHOLD
  const cooldownMs = options.cooldownMs ?? HEALTH_NOTICE_COOLDOWN_MS
  if (healthLevel(record, threshold) !== 'error') return false
  if (record.lastNotifiedAt === undefined) return true
  return now - record.lastNotifiedAt >= Math.max(0, cooldownMs)
}

/** Stamp the notice time (the caller writes the notice). */
export function markHealthNotified(record: HealthRecord, now: number): HealthRecord {
  return { ...record, lastNotifiedAt: now }
}

/** The one grey line a broken subsystem writes. */
const SUBSYSTEM_LABELS: Readonly<Record<string, string>> = {
  routing: '消息路由',
  steer: '运行中补充',
  schedules: '定时任务',
  outbox: '后台重试',
  prompt: '提示词组装',
  context: '上下文',
  memory: '记忆',
}

export function healthNoticeText(record: HealthRecord): string {
  const error = record.lastError === undefined || record.lastError === '' ? '未知错误' : record.lastError
  const name = SUBSYSTEM_LABELS[record.subsystem] ?? record.subsystem
  return `「${name}」连续 ${record.consecutiveFailures} 次出现问题：${error}`
    + '（插件已尽量继续工作；如果持续出现，请把这条提示反馈给开发者）'
}

/** What `getHealth` returns: one plain snapshot per subsystem, worst first. */
export interface HealthSnapshot {
  readonly subsystem: string
  readonly level: HealthLevel
  readonly consecutiveFailures: number
  readonly lastError?: string | undefined
  readonly lastFailureAt?: string | undefined
  readonly lastOkAt?: string | undefined
}

const LEVEL_ORDER: Readonly<Record<HealthLevel, number>> = { error: 0, warning: 1, ok: 2 }

/** Snapshots sorted worst-first, then by name, so a diagnostic list leads with what matters. */
export function healthSnapshots(
  records: Iterable<HealthRecord>,
  threshold: number = HEALTH_ERROR_THRESHOLD,
): HealthSnapshot[] {
  return [...records]
    .map(record => ({
      subsystem: record.subsystem,
      level: healthLevel(record, threshold),
      consecutiveFailures: record.consecutiveFailures,
      ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
      ...(record.lastFailureAt !== undefined
        ? { lastFailureAt: new Date(record.lastFailureAt).toISOString() }
        : {}),
      ...(record.lastOkAt !== undefined ? { lastOkAt: new Date(record.lastOkAt).toISOString() } : {}),
    }))
    .sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || a.subsystem.localeCompare(b.subsystem))
}
