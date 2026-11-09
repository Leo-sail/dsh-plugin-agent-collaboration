/**
 * context-steward.ts — the conservative context steward (P5-1).
 *
 * WHY THIS LAYER EXISTS. `context-pressure.ts` turns one meter reading into a decision
 * (ok / soft / hard / overflow), but nothing acts on it: a long session drifts to the window edge
 * and the user only learns about it when the provider rejects a request. The host can already
 * sample (`tokenMeter.contextPressure(session)`) and compact (`compaction.compactIfNeeded`), yet
 * wiring the two directly into the service would put thresholds, notice wording, notification
 * de-duplication and a behavioural switch into one untestable place.
 *
 * This steward is the missing DECISION-AND-ACTION layer, and every host capability arrives through
 * {@link ContextStewardDeps}: sample, compact, notify, log, clock. That makes the whole behaviour a
 * pure value machine testable with fakes — no Cordis service, no real clock, no IO of its own.
 *
 * THE CONSERVATIVE CONTRACT (the default changes nothing)
 *   · no usable reading → `unavailable` (no notice, no compaction, no warning spam);
 *   · ok / soft → `ok` — soft is observed only, the room is never told;
 *   · hard / overflow → ONE grey notice per (session, level) per cooldown window (15 min default).
 *     A repeat inside the window answers `ok` (not `notified`: otherwise a caller that logs results
 *     would report a notice the user never received). A hard → overflow escalation is a DIFFERENT
 *     level and therefore notifies immediately;
 *   · automatic compaction is OFF by default and, when switched on, runs AFTER the notice: overflow
 *     asks for the `context-overflow` trigger, hard for `pressure`. Its failure is reported as
 *     `compaction-failed` with a warning — the run is never thrown off by the steward;
 *   · every injected failure is contained: a throwing sampler/notifier/warn is warned about and the
 *     method still answers (it never rejects).
 *
 * The only default that reads a clock is `deps.now` falling back to `Date.now`; tests inject the
 * clock, and nothing else here touches time. No input value is mutated.
 *
 * @module
 */
import { contextPressureNotice, decideContextPressure } from './context-pressure.ts'
import type {
  ContextPressureDecision,
  ContextPressureSample,
  ContextPressureThresholds,
} from './context-pressure.ts'

/** How long one (session, level) notice is suppressed by default: fifteen minutes. */
const DEFAULT_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000

/** The reason reported when the host cannot produce a reading at all. */
const UNAVAILABLE_REASON = '没有可用的上下文压力读数'

/** What the steward needs from the host. All of it is injected so the logic stays testable. */
export interface ContextStewardDeps {
  /** 采样；服务缺席/会话不存在/读数不可信时返回 undefined。 */
  readonly pressureFor: (sessionId: string) => ContextPressureSample | undefined
  /** 请求 Host 压缩；true=确实压缩了，false=不需要/没压缩。 */
  readonly compact: (input: {
    readonly sessionId: string
    readonly trigger: 'pressure' | 'context-overflow'
  }) => Promise<boolean>
  /** 给房间的 durable 提示（grey notice）。 */
  readonly notify: (input: { readonly roomId: string; readonly text: string }) => void
  /** 诊断日志。 */
  readonly warn: (message: string) => void
  readonly thresholds?: ContextPressureThresholds | undefined
  /** 自动压缩开关；默认 false（只观测+通知）。 */
  readonly autoCompact?: boolean | undefined
  /** 同一 session 同 level 的通知冷却毫秒；默认 15 分钟。 */
  readonly notifyCooldownMs?: number | undefined
  /** 时钟（毫秒）；默认 Date.now，便于测试。 */
  readonly now?: (() => number) | undefined
}

/** What one inspection did, as a value the caller can log/act on. */
export type ContextStewardResult =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ok'; readonly decision: ContextPressureDecision }
  | { readonly kind: 'notified'; readonly decision: ContextPressureDecision; readonly level: 'hard' | 'overflow' }
  | { readonly kind: 'compacted'; readonly decision: ContextPressureDecision; readonly trigger: 'pressure' | 'context-overflow'; readonly compacted: boolean }
  | { readonly kind: 'compaction-failed'; readonly decision: ContextPressureDecision; readonly error: string }

/**
 * The conservative steward: sample → judge → notify (cooled down) → optionally compact.
 *
 * One instance per plugin: the cooldown memory is per (session, level) and deliberately PER
 * instance, so a restart may emit one extra notice rather than silently swallow the first one.
 * `inspect` is the only public operation and it never rejects.
 */
export class ContextSteward {
  private readonly deps: ContextStewardDeps
  private readonly now: () => number
  private readonly notifyCooldownMs: number
  private readonly autoCompact: boolean
  /** `${sessionId}\u0000${level}` → epoch-ms of the last notice that actually reached the room. */
  private readonly notifiedAt = new Map<string, number>()

  constructor(deps: ContextStewardDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.notifyCooldownMs = normaliseCooldown(deps.notifyCooldownMs)
    this.autoCompact = deps.autoCompact === true
  }

  /**
   * Check one bot turn's session. Never throws: every injected failure is reported, not propagated.
   *
   * The result says what HAPPENED (`notified` only when a notice really reached the room,
   * `compacted` only when the host was asked and answered), so the caller can record a ledger line
   * or a diagnostic without re-deriving anything.
   */
  async inspect(input: { readonly roomId: string; readonly botId: string; readonly sessionId: string }): Promise<ContextStewardResult> {
    try {
      return await this.inspectOnce(input)
    } catch (error: unknown) {
      // Last-resort containment: a pathological dependency (a throwing clock, for example) must
      // still not fail the turn that called us.
      this.warnSafely(`上下文管家检查失败：${errorText(error)}`)
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON }
    }
  }

  /** The real body; `inspect` only wraps it so no code path can escape as a rejection. */
  private async inspectOnce(input: {
    readonly roomId: string
    readonly botId: string
    readonly sessionId: string
  }): Promise<ContextStewardResult> {
    let sample: ContextPressureSample | undefined
    try {
      sample = this.deps.pressureFor(input.sessionId)
    } catch (error: unknown) {
      // An unreadable meter is "no reading", not a failure of the turn; warn once per call so the
      // cause stays visible without turning every turn into a notice.
      this.warnSafely(`读取上下文压力失败：${errorText(error)}`)
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON }
    }

    // A host without a usable reading must not start compacting: untouched behaviour is the default.
    if (sample === undefined) return { kind: 'unavailable', reason: UNAVAILABLE_REASON }

    const decision = decideContextPressure(sample, this.deps.thresholds)
    // ok is normal operation; soft is handled silently by the host's own compaction — neither is
    // worth interrupting the room with.
    if (decision.level !== 'hard' && decision.level !== 'overflow') return { kind: 'ok', decision }
    const level: 'hard' | 'overflow' = decision.level

    const now = this.readNow()
    if (this.isCooling(input.sessionId, level, now)) {
      // Inside the window the user already has this notice. Answer `ok`, not `notified`: the
      // caller must not record a second notice that was never sent.
      return { kind: 'ok', decision }
    }

    const text = contextPressureNotice(decision)
    if (text === undefined) return { kind: 'ok', decision } // unreachable for hard/overflow
    try {
      this.deps.notify({ roomId: input.roomId, text })
      // Only a notice that reached the room starts the cooldown: if notify threw, the user never
      // saw it, so the next inspection should retry instead of staying silent for fifteen minutes.
      this.notifiedAt.set(notificationKey(input.sessionId, level), now)
    } catch (error: unknown) {
      this.warnSafely(`发送上下文压力通知失败：${errorText(error)}`)
    }

    if (!this.autoCompact) return { kind: 'notified', decision, level }
    const trigger: 'pressure' | 'context-overflow' = level === 'overflow' ? 'context-overflow' : 'pressure'
    try {
      const compacted = await this.deps.compact({ sessionId: input.sessionId, trigger })
      return { kind: 'compacted', decision, trigger, compacted }
    } catch (error: unknown) {
      this.warnSafely(`自动压缩上下文失败：${errorText(error)}`)
      return { kind: 'compaction-failed', decision, error: errorText(error) }
    }
  }

  /** The injected clock, contained: a throwing clock is "now = 0" rather than a rejected inspect. */
  private readNow(): number {
    try {
      return this.now()
    } catch (error: unknown) {
      this.warnSafely(`读取上下文管家时钟失败：${errorText(error)}`)
      return 0
    }
  }

  /** True when `(session, level)` was notified less than one cooldown ago. */
  private isCooling(sessionId: string, level: 'hard' | 'overflow', now: number): boolean {
    const last = this.notifiedAt.get(notificationKey(sessionId, level))
    if (last === undefined) return false
    const elapsed = now - last
    // A clock that moved backwards must not silence the notice for ever: `elapsed < 0` is treated
    // as "not cooling" (the notice is re-sent and the timestamp moves with the new clock).
    return elapsed >= 0 && elapsed < this.notifyCooldownMs
  }

  /** Diagnostics only; a throwing logger must never break the steward. */
  private warnSafely(message: string): void {
    try {
      this.deps.warn(message)
    } catch {
      // Ignore: warnings are best-effort.
    }
  }
}

/** `(session, level)` is the cooldown key: levels cool down independently (upgrade = new level). */
function notificationKey(sessionId: string, level: 'hard' | 'overflow'): string {
  return `${sessionId}\u0000${level}`
}

/** A usable cooldown: finite and non-negative. Anything else uses the documented 15-minute default. */
function normaliseCooldown(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_NOTIFY_COOLDOWN_MS
  return value
}

/** Plain text for a caught error, for a warning line. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
