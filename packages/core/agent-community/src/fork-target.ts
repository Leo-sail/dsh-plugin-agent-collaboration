/**
 * Fork target resolution — which message a "在新对话中分支" cut is taken at.
 *
 * WHY THIS IS NOT A ONE-LINE LOOKUP. The panel's branch affordance is rendered from a
 * LEDGER row, but `copyBot` copies from `state.messages`: the two stores use DIFFERENT
 * ids. A user row seeded at startup carries the message id, but a user row pushed live
 * gets a random ledger id, and a bot reply row is derived from its run id. Passing the
 * ledger id straight into a message lookup therefore threw `Message "…" not found` and
 * the button appeared to do nothing.
 *
 * The resolution below accepts either id and degrades instead of throwing:
 *
 *   1. an actual message id → that message;
 *   2. a USER ledger row → its `messageId` (when the host stamped one);
 *   3. a reply/other row → the newest user row at or before it, then its message id
 *      (branching from a reply means "branch from the turn that prompted it");
 *   4. anything else → the newest user message in the room.
 *
 * The fork is created FROM the resolved message, so the copy keeps that turn and the
 * ones before it — exactly the semantics `copyBot` already documented.
 */
import type { LedgerEntry } from './ledger.ts'

/** The part of a message this resolver needs (structural, so tests need no full message). */
export interface ForkMessageLike {
  readonly id: string
  readonly sender: { readonly kind: string }
}

/** The part of a ledger entry this resolver needs. */
export interface ForkLedgerLike {
  readonly id: string
  readonly type?: string | undefined
  readonly messageId?: string | undefined
}

/** The id of the newest user message, or undefined when the room has none. */
export function lastUserMessageId(messages: readonly ForkMessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.sender.kind === 'user') return messages[i]!.id
  }
  return undefined
}

/**
 * Resolve the message id a fork should be cut at, from either a message id or a ledger id.
 *
 * Returns undefined only when the room has no user message at all; callers must then carry
 * the whole transcript rather than refuse the fork.
 */
export function resolveForkCutId(input: {
  /** What the panel sent: a ledger row id, a message id, or '' for "no cut". */
  readonly requestedId: string
  readonly messages: readonly ForkMessageLike[]
  readonly ledger?: readonly ForkLedgerLike[] | undefined
}): string | undefined {
  const { requestedId, messages } = input
  const ledger = input.ledger ?? []
  const byMessage = messages.find(message => message.id === requestedId)
  if (byMessage !== undefined) return byMessage.id
  if (requestedId !== '') {
    const index = ledger.findIndex(entry => entry.id === requestedId)
    if (index >= 0) {
      // Walk backwards from this row: the branch point is this row when it is a user
      // message, otherwise the user turn that prompted it.
      for (let i = index; i >= 0; i -= 1) {
        const entry = ledger[i]!
        if (entry.type !== 'user' || entry.messageId === undefined || entry.messageId === '') continue
        if (messages.some(message => message.id === entry.messageId)) return entry.messageId
      }
    }
  }
  // No usable id (live row without a stamped messageId, a stale id from a reload, or the
  // caller asked for no cut): branch from the room's newest user message. A fork that
  // carries a little more history is recoverable; a fork that throws is not.
  return lastUserMessageId(messages)
}
