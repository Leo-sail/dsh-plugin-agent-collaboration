/**
 * Semantic admission assessor (S2-5) — the v1 SKELETON.
 *
 * WHY THIS EXISTS. S0-3 gave the router a deterministic program layer: explicit addressees always
 * run, everything inferred is either runs-as-before (legacy), recorded (observe) or run under the
 * rules (auto). Some judgement ("is this really work for the team, or chat?") is not expressible
 * as a table. The Article's answer is a semantic layer: a cheap model call with user-written
 * natural-language rules, whose verdict is explainable and whose failure falls back to observe.
 *
 * WHY THIS IS ONLY A SKELETON. The plan makes S2-5 conditional on ~a week of S0-3 `observe` data,
 * so wiring a live model call now would be an unmeasured spend with no baseline to judge it. This
 * module therefore implements the parts that are DETERMINISTIC and testable today:
 *   · the room setting (enabled + bounded rule text + change timestamp);
 *   · the per-room-per-minute HARD budget (the call would use it; the caller consumes it);
 *   · the assessor prompt (rules + candidates + bounded message text + a strict JSON answer spec);
 *   · tolerant parsing + validation of the answer (unknown target / malformed JSON = no verdict);
 *   · the fallback policy — timeout, error, malformed or out-of-room target all mean "ignore, and
 *     say why" (the same behaviour `observe` has), never "accept by accident".
 *
 * The service seam `assessAdmission()` exists and currently returns "assessor unavailable"; when
 * the observe data is in, only that seam needs a model call.
 *
 * @module
 */

import type { BotRoomAssessment } from './types.ts'

/** Hard caps: a rule text is guidance, not a document. */
export const MAX_ASSESSMENT_RULES_CHARS = 4_000
/** One assessor call per room per minute. */
export const ASSESSOR_WINDOW_MS = 60_000
export const ASSESSOR_CALLS_PER_WINDOW = 1
/** A candidate message is truncated for the prompt; the verdict only needs its intent. */
export const ASSESSOR_MESSAGE_CHARS = 2_000
/** How long a call may take before the caller falls back. */
export const ASSESSOR_TIMEOUT_MS = 3_000

/** The normalized setting stored on a room. */
export interface AssessmentSetting {
  readonly enabled: boolean
  readonly rules: string
  readonly updatedAt?: string | undefined
}

/** Normalize a stored/requested setting; `rules` is clipped, never rejected. */
export function normalizeAssessment(value: unknown, nowIso?: string): AssessmentSetting {
  if (value === null || typeof value !== 'object') return { enabled: false, rules: '' }
  const view = value as { enabled?: unknown; rules?: unknown; updatedAt?: unknown }
  const rules = typeof view.rules === 'string' ? [...view.rules.trim()].slice(0, MAX_ASSESSMENT_RULES_CHARS).join('') : ''
  return {
    enabled: view.enabled === true,
    rules,
    ...(typeof view.updatedAt === 'string' && view.updatedAt !== '' ? { updatedAt: view.updatedAt } : (nowIso !== undefined ? { updatedAt: nowIso } : {})),
  }
}

/** Apply an update while preserving the change timestamp semantics. */
export function mergeAssessment(previous: BotRoomAssessment | undefined, update: { readonly enabled?: boolean | undefined; readonly rules?: string | undefined }, nowIso: string): AssessmentSetting {
  const before = normalizeAssessment(previous)
  const enabled = update.enabled === undefined ? before.enabled : update.enabled === true
  const rules = update.rules === undefined
    ? before.rules
    : [...update.rules.trim()].slice(0, MAX_ASSESSMENT_RULES_CHARS).join('')
  const changed = enabled !== before.enabled || rules !== before.rules
  return { enabled, rules, updatedAt: changed ? nowIso : (before.updatedAt ?? nowIso) }
}

/** Per-room budget state: the window start and how many calls it already used. */
export interface AssessorBudgetState {
  readonly windowStartedAt: number
  readonly used: number
}

/** Remaining calls in the current minute window (1 when the window rolled over). */
export function assessorBudgetRemaining(state: Map<string, AssessorBudgetState>, roomId: string, now: number): number {
  const current = state.get(roomId)
  if (current === undefined || now - current.windowStartedAt >= ASSESSOR_WINDOW_MS) return ASSESSOR_CALLS_PER_WINDOW
  return Math.max(0, ASSESSOR_CALLS_PER_WINDOW - current.used)
}

/** Consume one call from the room's minute budget; returns false when the window is exhausted. */
export function consumeAssessorBudget(state: Map<string, AssessorBudgetState>, roomId: string, now: number): boolean {
  const current = state.get(roomId)
  if (current === undefined || now - current.windowStartedAt >= ASSESSOR_WINDOW_MS) {
    state.set(roomId, { windowStartedAt: now, used: 1 })
    return true
  }
  if (current.used >= ASSESSOR_CALLS_PER_WINDOW) return false
  state.set(roomId, { windowStartedAt: current.windowStartedAt, used: current.used + 1 })
  return true
}

/** The prompt: rules, the room's candidate bots, and one bounded user message. */
export function buildAssessorPrompt(input: {
  readonly rules: string
  readonly messageText: string
  readonly candidates: ReadonlyArray<{ readonly name: string; readonly description?: string | undefined }>
  readonly requesters?: readonly string[] | undefined
}): string {
  const rules = [...input.rules.trim()].slice(0, MAX_ASSESSMENT_RULES_CHARS).join('')
  const message = [...input.messageText.trim()].slice(0, ASSESSOR_MESSAGE_CHARS).join('')
  const roster = input.candidates
    .map(candidate => `- ${candidate.name}${candidate.description !== undefined && candidate.description !== '' ? `：${candidate.description}` : ''}`)
    .join('\n')
  return [
    '你是房间的准入评估器：判断一条未点名的消息是否值得让某个成员开始工作。',
    rules !== '' ? `房间规则（用户写的自然语言，优先遵守）：\n${rules}` : '房间规则：（没有额外规则）',
    `可选择的成员：\n${roster}`,
    `用户消息：\n${message}`,
    '只输出一个 JSON 对象，不要 markdown、不要解释：',
    '{"accept": true|false, "target": "成员名（accept=true 时必填，必须是上面列出的名字之一）", "reason": "一句话理由（≤80 字）"}',
    '规则要求「不接」或消息只是闲聊时 accept=false。不确定时 accept=false（回退观察，不要猜）。',
  ].join('\n\n')
}

/** A validated assessor verdict. */
export interface AssessorVerdict {
  readonly accept: boolean
  readonly target?: string | undefined
  readonly reason: string
}

/**
 * Parse a model answer into a verdict, tolerantly.
 *
 * Models wrap JSON in fences or prose; the FIRST balanced `{...}` is extracted. Anything that does
 * not validate (missing accept, non-boolean accept, accept without a member target, reason not a
 * string) yields `undefined` — the caller treats that as "no verdict" and falls back.
 */
export function parseAssessorAnswer(
  answer: string,
  input: { readonly memberNames: readonly string[] },
): AssessorVerdict | undefined {
  const text = answer.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const view = parsed as { accept?: unknown; target?: unknown; reason?: unknown }
  if (typeof view.accept !== 'boolean') return undefined
  const reason = typeof view.reason === 'string' && view.reason.trim() !== ''
    ? [...view.reason.trim()].slice(0, 200).join('')
    : undefined
  if (view.accept === false) {
    return { accept: false, ...(reason !== undefined ? { reason } : { reason: '评估器判定不该行动' }) }
  }
  const target = typeof view.target === 'string' ? view.target.trim() : ''
  if (target === '' || !input.memberNames.includes(target)) return undefined
  return {
    accept: true,
    target,
    ...(reason !== undefined ? { reason } : { reason: '评估器判定该成员应行动' }),
  }
}

/** The fallback decision when there is no usable verdict. NEVER accepts. */
export function fallbackObservation(reason: string): { readonly action: 'ignore'; readonly accepted: false; readonly reason: string } {
  return { action: 'ignore', accepted: false, reason }
}

/**
 * Resolve one assessor attempt into an admission decision.
 *
 * No verdict (timeout / error / unavailable / malformed) falls back to `ignore` with the reason —
 * i.e. the room behaves like S0-3 `observe`, which is the safe direction: an unavailable assessor
 * must never wake a bot.
 */
export function resolveAssessorOutcome(input: {
  readonly verdict?: AssessorVerdict | undefined
  readonly timedOut?: boolean | undefined
  readonly error?: unknown
  readonly unavailable?: boolean | undefined
}): { readonly action: 'accept' | 'ignore'; readonly accepted: boolean; readonly target?: string | undefined; readonly reason: string } {
  if (input.unavailable === true) return fallbackObservation('语义评估尚未接入，回退 observe')
  if (input.timedOut === true) return fallbackObservation('评估超时，回退 observe')
  if (input.error !== undefined) return fallbackObservation('评估失败，回退 observe')
  if (input.verdict === undefined) return fallbackObservation('评估结果无法解析，回退 observe')
  return {
    action: input.verdict.accept ? 'accept' : 'ignore',
    accepted: input.verdict.accept,
    ...(input.verdict.target !== undefined ? { target: input.verdict.target } : {}),
    reason: input.verdict.reason,
  }
}
