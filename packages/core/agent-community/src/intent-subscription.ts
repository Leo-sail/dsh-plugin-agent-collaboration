/**
 * Intent subscriptions (OP-18) — a bot saying, in advance, which words it wants to be woken for.
 *
 * WHY THIS EXISTS. Group routing is lexical and content-driven (see `routing.ts`): the router
 * looks at the message text, the bot's role text and the names, and infers who the message is
 * for. That inference is deliberately cheap (it runs on every message, so it may not call a
 * model), and it misses the one signal a user can give for free: "this bot handles 数据/图表,
 * wake it when the message talks about them". A subscription is that signal — an explicit,
 * per-bot keyword list that the router consults BEFORE its lexical guesswork. It makes the
 * common case predictable without making the router expensive.
 *
 * KEPT PURE AND SEPARATE from routing so the limits (how many subscriptions, how many hits, how
 * many bots) are decided in one testable place. The router only ever asks: "which members does
 * this text subscribe to, in room order?"
 *
 * @module
 */

/** Most subscriptions one bot may declare. Bounded so a bot cannot become a keyword dump. */
export const MAX_SUBSCRIPTIONS = 20

/** Longest single subscription, in characters. Longer input is clipped, never dropped. */
export const MAX_SUBSCRIPTION_CHARS = 40

/** Distinct terms one bot may report for a single message (the matched list stays readable). */
export const MAX_TERMS_PER_BOT = 3

/** Bots `matchSubscriptions` returns at most. The router narrows further (see routing.ts). */
export const MAX_MATCHED_BOTS = 3

/** The minimum shape: an id and whatever subscriptions the caller has for it. */
export interface SubscribableBot {
  readonly id: string
  /** Raw keyword/intent labels; normalized here, so callers may pass user input as-is. */
  readonly subscriptions?: readonly string[] | undefined
}

/** One bot's subscription hits for a message. */
export interface SubscriptionMatch {
  readonly botId: string
  /** The subscribed terms that appeared in the message, original casing, at most 3. */
  readonly terms: readonly string[]
}

/**
 * Clean a user-supplied subscription list.
 *
 * Rules, all of them about bounding persisted data rather than judging the words:
 *   · trim each entry, drop the empty ones;
 *   · clip each entry to {@link MAX_SUBSCRIPTION_CHARS} characters (a pasted paragraph is a
 *     mistake, but its leading words are still a usable intent);
 *   · deduplicate case-insensitively, keeping the FIRST spelling (the user's own casing);
 *   · keep at most {@link MAX_SUBSCRIPTIONS}, in input order.
 *
 * Order is preserved so the bot's own list stays stable across saves; it is not a priority
 * order — matching is "contains", not "first match wins".
 */
export function normalizeSubscriptions(input: readonly string[] | undefined): string[] {
  if (input === undefined) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const clipped = [...trimmed].slice(0, MAX_SUBSCRIPTION_CHARS).join('')
    if (clipped === '') continue
    const key = clipped.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clipped)
    if (out.length >= MAX_SUBSCRIPTIONS) break
  }
  return out
}

/**
 * The subscribed terms of ONE bot that appear in the message.
 *
 * Matching is case-insensitive substring containment: Chinese has no word boundaries and a
 * subscription is a human-chosen label, so "数据" must hit "帮我分析一下数据" without a
 * tokenizer. Each term is reported once, clipped to {@link MAX_TERMS_PER_BOT}.
 */
export function matchSubscriptionTerms(
  subscriptions: readonly string[] | undefined,
  messageText: string,
): string[] {
  if (subscriptions === undefined || subscriptions.length === 0) return []
  const hay = messageText.toLowerCase()
  if (hay.trim() === '') return []
  const hits: string[] = []
  const seen = new Set<string>()
  for (const raw of subscriptions) {
    if (typeof raw !== 'string') continue
    const term = raw.trim()
    if (term === '') continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    if (!hay.includes(key)) continue
    seen.add(key)
    hits.push(term)
    if (hits.length >= MAX_TERMS_PER_BOT) break
  }
  return hits
}

/**
 * Every bot whose subscriptions the message touches, best matches first.
 *
 * Ranking is by NUMBER of matched terms (more specific subscriptions outrank a single common
 * word); ties keep the caller's bot order, so the result is deterministic and a room's member
 * order is what breaks a tie. At most {@link MAX_MATCHED_BOTS} bots are returned.
 */
export function matchSubscriptions(
  bots: readonly SubscribableBot[],
  messageText: string,
): SubscriptionMatch[] {
  const matches: Array<{ botId: string; terms: string[]; order: number }> = []
  for (const [order, bot] of bots.entries()) {
    const terms = matchSubscriptionTerms(bot.subscriptions, messageText)
    if (terms.length > 0) matches.push({ botId: bot.id, terms, order })
  }
  matches.sort((a, b) => (b.terms.length - a.terms.length) || (a.order - b.order))
  return matches
    .slice(0, MAX_MATCHED_BOTS)
    .map(match => ({ botId: match.botId, terms: match.terms }))
}
