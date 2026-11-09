/**
 * Room admission (S0-3) — the one place that says whether an INFERRED routing decision may
 * wake anyone.
 *
 * WHY THIS EXISTS. `routing.ts` answers WHO would answer. On a group room, that answer is
 * sometimes an inference: a greeting wakes the room, a role match guesses a bot, a message that
 * addressed nobody falls back to the leader. The Super-agent article makes the distinction the
 * agent's FIRST decision (an explicit request vs an inferred candidate) and adds an `observe`
 * mode: record "would have acted" without acting, collect evidence, then enable. This module is
 * that decision for a room. It is deliberately pure, so the router and the service share exactly
 * one classification and it can be tested without a host.
 *
 * WHAT IT DOES NOT DO. It does not decide who answers (routing.ts owns that), it never downgrades
 * an EXPLICIT request, and a `legacy` room never calls it for a gate decision — the service only
 * consults it while the room's mode is `observe`/`auto`, so the default behaviour is byte-for-byte
 * the behaviour of 0.3.x.
 *
 * THE ONE HARD RULE. A message that names its recipient is explicit, even when the name was
 * typed without `@`: `routing.ts` records that choice as `matched: { botId: ['name:…'] }`, and
 * `wasCalledByName` reads exactly that marker. Greetings (`reason: 'all'` without the `@all`
 * token), role matches, subscription hits and the leader fallback are inferred.
 *
 * @module
 */
import type { RouteDecision } from './routing.ts'
import type { AdmissionMode, BotRoomAdmission } from './types.ts'

/** Explicit = somebody was addressed; inferred = the room guessed who owns the message. */
export type AdmissionClass = 'explicit' | 'inferred'

/**
 * The inputs one classification reads.
 *
 * Deliberately the same values the service already has after `routeMessage`: no extra parse, no
 * second source of truth. `matched` is passed whole so the written-name marker survives.
 */
export interface AdmissionInput {
  /** A 1:1 room answers its only bot; nothing about it is inferred. */
  readonly directBotId?: string | undefined
  /** The `@all` / `@所有人` TOKEN (not the plain words 大家/各位). */
  readonly allMentioned: boolean
  readonly reason: RouteDecision['reason']
  readonly matched: Readonly<Record<string, readonly string[]>>
}

/**
 * Whether the routing choice came from a WRITTEN-OUT MEMBER NAME.
 *
 * `routing.ts` sets `matched[botId] = ['name:<name>']` only for the written-name branch; a role
 * match puts the matched TERMS there instead. The prefix is therefore the one marker that tells
 * the two apart, and testing it here keeps the rule in a single place.
 */
export function wasCalledByName(matched: Readonly<Record<string, readonly string[]>>): boolean {
  return Object.values(matched).some(terms => terms.some(term => term.startsWith('name:')))
}

/**
 * Classify one routing decision as an explicit request or an inference.
 *
 * Order matters twice:
 *   · a direct room is explicit before any other rule is read;
 *   · `reason: 'all'` is explicit only when the user wrote the `@all` token — a greeting or
 *     「大家看一下」 is still an inference about who should answer, which is exactly the noise
 *     `observe` is meant to measure.
 */
export function classifyRequest(input: AdmissionInput): AdmissionClass {
  if (input.directBotId !== undefined) return 'explicit'
  switch (input.reason) {
    case 'direct':
    case 'mention':
    case 'coordinator':
      // A management instruction is a concrete directive even though it names the leader by
      // rule rather than by `@`; suppressing it would break kicking/inviting/renaming.
      return 'explicit'
    case 'subscription-thread':
      // S1-3: the thread/task already has owners. This is a continuation of work the room is
      // already doing, not a new inference; `observe` must not silence an in-progress conversation.
      return 'explicit'
    case 'all':
      return input.allMentioned ? 'explicit' : 'inferred'
    case 'matched':
      return wasCalledByName(input.matched) ? 'explicit' : 'inferred'
    case 'subscription':
    case 'leader':
      return 'inferred'
  }
}

/** The room's mode; absent is `legacy` (old state files need no migration). */
export function admissionModeOf(room: { readonly admission?: BotRoomAdmission | undefined }): AdmissionMode {
  return room.admission?.mode ?? 'legacy'
}

/** The ONLY gate: `observe` skips inferred decisions; every other combination runs. */
export function shouldObserveOnly(mode: AdmissionMode, clarity: AdmissionClass): boolean {
  return mode === 'observe' && clarity === 'inferred'
}

const ADMISSION_MODES: readonly AdmissionMode[] = ['legacy', 'observe', 'auto']

/**
 * Validate a mode coming from the panel/RPC before it is persisted.
 *
 * Room fields arrive as JSON and are not schema-checked at the RPC boundary, so an unknown mode
 * is rejected here rather than stored and silently treated as something else. Throws with the
 * accepted values, because the caller is the one that can fix it.
 */
export function normalizeAdmission(value: unknown): BotRoomAdmission {
  const mode = typeof value === 'object' && value !== null
    ? (value as { readonly mode?: unknown }).mode
    : undefined
  if (typeof mode !== 'string' || !(ADMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(`admission.mode 必须是 ${ADMISSION_MODES.join(' / ')} 之一`)
  }
  return { mode: mode as AdmissionMode }
}

/** A short Chinese explanation of a routing reason, for the observe notice. */
export function admissionReasonLabel(reason: RouteDecision['reason']): string {
  switch (reason) {
    case 'direct':
      return '私聊消息'
    case 'all':
      return '群里的集体称呼'
    case 'mention':
      return '@ 点名'
    case 'subscription':
      return '之前关注的话题'
    case 'subscription-thread':
      return '这个对话已有负责人'
    case 'matched':
      return '按 Bot 描述匹配'
    case 'coordinator':
      return '管理指令'
    case 'leader':
      return '没有点名，默认交给队长'
  }
}

export interface AdmissionNoticeInput {
  /** Display names of the bots that would have been woken, in routing order. */
  readonly targets: readonly string[]
  /** The routing reason, already human-readable (see {@link admissionReasonLabel}). */
  readonly reason: string
  /** How many inferred messages this notice covers; 1 when it is the first in the window. */
  readonly suppressed: number
  /** How long the window covers, e.g. `过去 60 秒`. */
  readonly window: string
}

/**
 * One grey line that says what `observe` held back.
 *
 * Bounded and countable on purpose: a busy room must not get one line per greeting, so the
 * service aggregates a window and this text names the sample plus how many messages it covers.
 */
export function admissionNoticeText(input: AdmissionNoticeInput): string {
  const who = input.targets.length === 0
    ? '（没有目标）'
    : input.targets.map(name => `「${name}」`).join('、')
  const scope = input.suppressed > 1
    ? `${input.window}共 ${input.suppressed} 条未点名消息本会唤醒${who}`
    : `未点名消息本会唤醒${who}`
  return `【未点名消息】${scope}（原因：${input.reason}）。当前设置为「只看不回复」，这条消息没有触发回复。`
}
