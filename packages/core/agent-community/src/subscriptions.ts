/**
 * Thread subscriptions (S1-3) — a room message's durable owner.
 *
 * WHY THIS EXISTS. `routing.ts` decides who answers a message by looking at its TEXT. That is the
 * right rule for a new instruction and the wrong rule for a conversation already in progress: a
 * follow-up like "and the second one" carries no names, so it falls back to the leader or to a
 * role match and the running task is re-routed on every reply. The Super-agent article's answer is
 * the Thread/Subscription pair — one event stream, one or more subscribed workers, follow-ups
 * delivered directly, no re-decision.
 *
 * WHAT IS STORED. A subscription binds `(roomId, threadId | taskId)` to a small set of bots, with
 * a TTL and a room cap. It is created when a new instruction is routed (source `round`) or work is
 * dispatched into the thread (`dispatch`), and both are capped hard so an active room cannot grow
 * the state without bound.
 *
 * WHAT IT DOES NOT DO. It never overrides an explicit addressee: an `@mention`, a written name, a
 * management instruction or an `@all` still wins (routing asks the subscription only after those).
 * A subscription with neither threadId nor taskId is never stored — it would match every message in
 * the room, which is exactly the free-for-all the router exists to avoid.
 *
 * Everything here is pure; the service owns persistence and caps only through these functions.
 *
 * @module
 */
import type { BotId, ThreadSubscription, ThreadSubscriptionAuthority, ThreadSubscriptionSource } from './types.ts'

/** How long an idle subscription stays valid (refreshed whenever it resolves a message). */
export const THREAD_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1_000
/** Cap per room; oldest-updated entries are dropped first. */
export const MAX_SUBSCRIPTIONS_PER_ROOM = 50
/** Cap on bots one thread/task may route to (matches the router's subscription fan-out rule). */
export const MAX_BOTS_PER_THREAD = 5

/** The pair that identifies a subscription's target. Empty when the message has no thread/task. */
export interface ThreadingKey {
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/** Whether a message carries enough threading to be subscribed at all. */
export function hasThreading(threading: ThreadingKey): boolean {
  return (threading.threadId ?? '') !== '' || (threading.taskId ?? '') !== ''
}

/** Stable identity for a subscription: room + non-empty thread/task components. */
export function subscriptionKey(roomId: string, threading: ThreadingKey): string {
  return `${roomId}\u0000${threading.threadId ?? ''}\u0000${threading.taskId ?? ''}`
}

/** What one message says about the thread it belongs to; `replyTo` is accepted so replies count. */
export interface ReplyThreadingInput {
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
  readonly replyTo?: string | undefined
}

/**
 * The threading a SUBSCRIPTION should key on for one message.
 *
 * The panel's reply gesture sets only `replyTo`: it deliberately does not invent a thread id, so
 * a reply chain would never satisfy `hasThreading` and S1-3 could not bind from ordinary replies.
 * Walk the replied-to chain to its root (or to the first ancestor that carries an explicit
 * threadId/taskId) and use that as this message's thread. Explicit threadId/taskId always win;
 * without either and without a reply the result is empty and nothing is bound.
 *
 * Pure: the caller supplies the ancestor lookup, so the rule is testable without a host.
 */
export function subscriptionThreadingFor(
  input: ReplyThreadingInput,
  lookup: (messageId: string) => ReplyThreadingInput | undefined,
  maxHops = 16,
): ThreadingKey {
  if (hasThreading(input)) {
    return {
      ...(input.threadId !== undefined && input.threadId !== '' ? { threadId: input.threadId } : {}),
      ...(input.taskId !== undefined && input.taskId !== '' ? { taskId: input.taskId } : {}),
    }
  }
  let current = input.replyTo
  let fallback = current
  const seen = new Set<string>()
  while (current !== undefined && current !== '' && seen.size < maxHops) {
    if (seen.has(current)) break
    seen.add(current)
    fallback = current
    const ancestor = lookup(current)
    if (ancestor === undefined) break
    if (hasThreading(ancestor)) {
      return {
        ...(ancestor.threadId !== undefined && ancestor.threadId !== '' ? { threadId: ancestor.threadId } : {}),
        ...(ancestor.taskId !== undefined && ancestor.taskId !== '' ? { taskId: ancestor.taskId } : {}),
      }
    }
    current = ancestor.replyTo
  }
  return fallback !== undefined && fallback !== '' ? { threadId: fallback } : {}
}

/** Whether two threadings name the same thread or the same task (one non-empty match is enough). */
export function threadingMatches(a: ThreadingKey, b: ThreadingKey): boolean {
  const aThread = a.threadId ?? ''
  const bThread = b.threadId ?? ''
  if (aThread !== '' && aThread === bThread) return true
  const aTask = a.taskId ?? ''
  const bTask = b.taskId ?? ''
  return aTask !== '' && aTask === bTask
}

/** Whether the subscription is past its TTL. */
export function isSubscriptionExpired(subscription: ThreadSubscription, now: number): boolean {
  return now >= subscription.expiresAt
}

/** Remove expired entries (called on every read/write that touches the room). */
export function pruneSubscriptions(
  subscriptions: readonly ThreadSubscription[],
  now: number,
): ThreadSubscription[] {
  return subscriptions.filter(subscription => !isSubscriptionExpired(subscription, now))
}

/** A subscription matched to one message: the bots to route to, and which entry matched. */
export interface ResolvedSubscription {
  readonly subscriptionId: string
  readonly botIds: readonly BotId[]
}

/**
 * Resolve the bots that own this message's thread/task.
 *
 * Newest matching subscription wins (a task can be re-assigned; the newer ownership is the
 * current one). Bots that left the room are filtered out — a subscription never routes into a
 * room its own bot is no longer in — and an empty result means "fall back to normal routing".
 */
export function resolveThreadSubscription(input: {
  readonly subscriptions: readonly ThreadSubscription[]
  readonly threading: ThreadingKey
  readonly memberIds: readonly BotId[]
  readonly now: number
}): ResolvedSubscription | undefined {
  if (!hasThreading(input.threading)) return undefined
  const members = new Set(input.memberIds.map(id => String(id)))
  const live = pruneSubscriptions(input.subscriptions, input.now)
    .filter(subscription => threadingMatches(subscription, input.threading))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const subscription of live) {
    const botIds = subscription.botIds.filter(id => members.has(String(id))).slice(0, MAX_BOTS_PER_THREAD)
    if (botIds.length > 0) return { subscriptionId: subscription.id, botIds }
  }
  return undefined
}

/**
 * Precedence of the AUTHORIZING party (S3-1): a user instruction outranks a leader's dispatch,
 * which outranks the system. Kept separate from `SOURCE_RANK` below because "who created it" and
 * "who was allowed to" are different questions.
 */
const AUTHORITY_RANK: Readonly<Record<ThreadSubscriptionAuthority, number>> = {
  user: 3,
  leader: 2,
  system: 1,
}

/** Precedence label when two binds for one key disagree: manual > dispatch > round. */
const SOURCE_RANK: Readonly<Record<ThreadSubscriptionSource, number>> = {
  round: 1,
  dispatch: 2,
  manual: 3,
}

/**
 * Bind `botIds` to a room's thread/task, returning the new list.
 *
 * Rules: expired entries are pruned first; an existing key is merged (bots union, capped, newest
 * source label wins, TTL refreshed); a new entry is created with a caller-supplied id; the room cap
 * drops the least recently updated entry. At least one threading component must be non-empty — a
 * bind without one is a no-op (returns the pruned list unchanged).
 */
export function bindThreadSubscription(input: {
  readonly subscriptions: readonly ThreadSubscription[]
  readonly roomId: string
  readonly threading: ThreadingKey
  readonly botIds: readonly BotId[]
  readonly source: ThreadSubscriptionSource
  /** S3-1: who authorized the bind; `user` when a user instruction created it. */
  readonly authorizedBy?: ThreadSubscriptionAuthority | undefined
  readonly now: number
  readonly ttlMs: number
  readonly id: string
}): ThreadSubscription[] {
  const pruned = pruneSubscriptions(input.subscriptions, input.now)
  if (!hasThreading(input.threading)) return pruned
  const key = subscriptionKey(input.roomId, input.threading)
  const expiresAt = input.now + Math.max(0, input.ttlMs)
  const existing = pruned.find(subscription => subscriptionKey(subscription.roomId, subscription) === key)
  const incoming = input.botIds.slice(0, MAX_BOTS_PER_THREAD)
  if (existing === undefined) {
    if (incoming.length === 0) return pruned
    const created: ThreadSubscription = {
      id: input.id,
      roomId: input.roomId,
      ...(input.threading.threadId !== undefined && input.threading.threadId !== ''
        ? { threadId: input.threading.threadId }
        : {}),
      ...(input.threading.taskId !== undefined && input.threading.taskId !== ''
        ? { taskId: input.threading.taskId }
        : {}),
      botIds: incoming,
      source: input.source,
      authorizedBy: input.authorizedBy ?? (input.source === 'manual' ? 'user' : 'leader'),
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt,
    }
    const next = [...pruned, created]
    return next.length <= MAX_SUBSCRIPTIONS_PER_ROOM
      ? next
      : next
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(next.length - MAX_SUBSCRIPTIONS_PER_ROOM)
  }
  const mergedBots = [...new Set([...existing.botIds, ...incoming])].slice(0, MAX_BOTS_PER_THREAD)
  const source = SOURCE_RANK[input.source] >= SOURCE_RANK[existing.source] ? input.source : existing.source
  const incomingAuth = input.authorizedBy ?? (input.source === 'manual' ? 'user' : 'leader')
  const existingAuth = existing.authorizedBy
    ?? (existing.source === 'manual' ? 'user' : 'leader')
  const authorizedBy = AUTHORITY_RANK[incomingAuth] >= AUTHORITY_RANK[existingAuth]
    ? incomingAuth
    : existingAuth
  const updated: ThreadSubscription = {
    ...existing,
    botIds: mergedBots,
    source,
    authorizedBy,
    updatedAt: input.now,
    expiresAt,
  }
  return pruned.map(subscription => (subscription.id === existing.id ? updated : subscription))
}

/**
 * Refresh a subscription that just resolved a message, so an active thread does not expire
 * mid-conversation. Unknown ids are ignored.
 */
export function touchSubscription(input: {
  readonly subscriptions: readonly ThreadSubscription[]
  readonly id: string
  readonly now: number
  readonly ttlMs: number
}): ThreadSubscription[] {
  const next = pruneSubscriptions(input.subscriptions, input.now).map(subscription =>
    subscription.id === input.id
      ? { ...subscription, updatedAt: input.now, expiresAt: input.now + Math.max(0, input.ttlMs) }
      : subscription)
  return next
}

/**
 * Take one bot out of the subscription that owns this thread/task ("hand it back").
 *
 * The entry remains for the other bots; removing the last bot drops the entry, which returns the
 * thread to normal routing. Returns what happened so the caller can tell the model the truth.
 */
export function unbindBotFromThread(input: {
  readonly subscriptions: readonly ThreadSubscription[]
  readonly roomId: string
  readonly threading: ThreadingKey
  readonly botId: BotId
  readonly now: number
}): { readonly subscriptions: ThreadSubscription[]; readonly removed: boolean; readonly dropped: boolean } {
  const pruned = pruneSubscriptions(input.subscriptions, input.now)
  if (!hasThreading(input.threading)) return { subscriptions: pruned, removed: false, dropped: false }
  const match = pruned.find(subscription =>
    subscription.roomId === input.roomId && threadingMatches(subscription, input.threading))
  if (match === undefined) return { subscriptions: pruned, removed: false, dropped: false }
  const remaining = match.botIds.filter(id => String(id) !== String(input.botId))
  if (remaining.length === match.botIds.length) return { subscriptions: pruned, removed: false, dropped: false }
  const subscriptions = remaining.length === 0
    ? pruned.filter(subscription => subscription.id !== match.id)
    : pruned.map(subscription =>
        subscription.id === match.id
          ? { ...subscription, botIds: remaining, updatedAt: input.now }
          : subscription)
  return { subscriptions, removed: true, dropped: remaining.length === 0 }
}
