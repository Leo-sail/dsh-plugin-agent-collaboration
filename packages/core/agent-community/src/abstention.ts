/**
 * Structured interaction normalizers (OP-12 abstention + OP-14 message threading).
 *
 * WHY ONE MODULE. Both features take UNTRUSTED, model- or client-supplied fields and turn them
 * into bounded values the room can safely persist:
 *
 *   · an abstention (`reason` / `missing` / `suggestedOwner`) is authored by a bot and becomes a
 *     VISIBLE notice — an empty or 10 000-character "reason" would either say nothing or flood
 *     the transcript;
 *   · threading (`replyTo` / `threadId` / `taskId`) is authored by the client and becomes part of
 *     the persisted message — a `replyTo` naming another room's message, or an id long enough to
 *     bloat `state.json`, must be dropped instead of stored.
 *
 * Keeping both decisions pure here means the rules are testable without a host, and the service
 * and the tool layer share exactly one implementation.
 *
 * NOTHING HERE THROWS: invalid input is dropped or clamped, because these run on the hot path of
 * a chat turn and a validation bug must never take the turn down.
 *
 * @module
 */

import type { AbstainRequest, BotMessageId } from './types.ts'

// ── OP-12: structured abstention ─────────────────────────────────────────────

/**
 * The abstention contract lives in `types.ts` (it crosses the tool/RPC boundary); re-exported
 * here so the normalizer and its callers can take both from one module.
 */
export type { AbstainRequest }

/** The bounded form actually stored/rendered. */
export interface NormalizedAbstain {
  readonly reason: string
  readonly missing: readonly string[]
  readonly suggestedOwner?: string | undefined
}

/** A notice line is a transcript row, not an essay: these bounds keep it readable. */
export const ABSTAIN_MAX_REASON_LENGTH = 600
export const ABSTAIN_MAX_MISSING = 5
export const ABSTAIN_MAX_MISSING_LENGTH = 120
export const ABSTAIN_MAX_OWNER_LENGTH = 60

/** Trim, collapse whitespace and clamp one text field to `limit` characters. */
function clampText(raw: string, limit: number): string {
  const text = raw.replace(/\s+/gu, ' ').trim()
  if (text.length <= limit) return text
  // Keep the bound exactly (ellipsis included) so callers can assert `length <= limit`.
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Validate and bound a bot's abstention.
 *
 * Returns `undefined` when the reason is empty: the whole point of the feature is to say WHY, and
 * a notice that only says "I can't" is worse than no notice. Everything else is clamped rather
 * than rejected — a bot that over-shares is still giving useful information.
 */
export function normalizeAbstain(input: AbstainRequest): NormalizedAbstain | undefined {
  const reason = clampText(input.reason ?? '', ABSTAIN_MAX_REASON_LENGTH)
  if (reason === '') return undefined
  const missing: string[] = []
  for (const raw of input.missing ?? []) {
    const entry = clampText(raw ?? '', ABSTAIN_MAX_MISSING_LENGTH)
    if (entry === '' || missing.includes(entry)) continue
    missing.push(entry)
    if (missing.length >= ABSTAIN_MAX_MISSING) break
  }
  const owner = clampText(input.suggestedOwner ?? '', ABSTAIN_MAX_OWNER_LENGTH)
  return {
    reason,
    missing,
    ...(owner !== '' ? { suggestedOwner: owner } : {}),
  }
}

/**
 * The Chinese notice a room sees for an abstention.
 *
 * Visible by design: the user asked for a bot, this is that bot saying "I cannot, here is what I
 * need". It is a room NOTICE (a `dispatch` row), so it renders in the transcript for the user; by
 * the service's notice rule it stays out of the model prompt and off the unread count, which is
 * why the abstention cannot leak into later bot turns. The notice does NOT end the task and the
 * run keeps going (the tool deliberately does not conclude the turn).
 */
export function abstainNotice(input: NormalizedAbstain, botName: string): string {
  const parts = [`「${botName}」说明无法完成这一项：${input.reason}`]
  if (input.missing.length > 0) parts.push(`缺少：${input.missing.join('、')}`)
  if (input.suggestedOwner !== undefined) parts.push(`建议由「${input.suggestedOwner}」接手`)
  return parts.join('；')
}

// ── OP-14: message threading / task linkage ─────────────────────────────────

/**
 * Bounds for `threadId` / `taskId`.
 *
 * Eight dozen characters is generous for a client-chosen thread or task label and small enough
 * that a bad client cannot grow the persisted transcript with enormous ids. Over-long ids are
 * DROPPED, not truncated: a truncated id silently points at a DIFFERENT thread/task, which is
 * worse than having none.
 */
export const THREAD_FIELD_MAX_LENGTH = 80

/** What the client asked to attach to a message (all optional, all untrusted). */
export interface ThreadingInput {
  readonly replyTo?: string | undefined
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/** The bounded fields actually stored on the message / ledger row. */
export interface ThreadingFields {
  readonly replyTo?: BotMessageId | undefined
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/** Where `replyTo` has to resolve: a message in the SAME room as the new one. */
export interface ThreadingContext {
  /** Whether this message id exists in the room the new message is being posted to. */
  messageInRoom(id: string): boolean
}

function boundedThreadField(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value === '' || value.length > THREAD_FIELD_MAX_LENGTH) return undefined
  return value
}

/**
 * Validate the threading fields of an incoming user message.
 *
 * `replyTo` must name an existing message IN THE SAME ROOM — a reply pointer to another room's
 * message would be a cross-room link, exactly what the isolation rules forbid — so it is dropped
 * when it does not resolve. `threadId` / `taskId` are opaque labels: trimmed, and dropped when
 * empty or over the bound. Missing fields simply stay absent (the shape is unchanged for every
 * existing caller).
 */
export function normalizeThreading(input: ThreadingInput, context: ThreadingContext): ThreadingFields {
  const replyToRaw = input.replyTo?.trim() ?? ''
  const replyTo = replyToRaw !== '' && context.messageInRoom(replyToRaw)
    ? (replyToRaw as BotMessageId)
    : undefined
  const threadId = boundedThreadField(input.threadId)
  const taskId = boundedThreadField(input.taskId)
  return {
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  }
}
