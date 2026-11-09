/**
 * Mid-run input delivery (S1-2) — fold a user's follow-up into the turn that is ALREADY running.
 *
 * WHY THIS EXISTS. The article's opening example is a person changing their mind mid-task: plan A
 * in chat, then "actually use B" in a review comment, and the same work adapts. Today the plugin
 * queues the second message as a NEW run behind the pair's mutex, so the bot finishes the old
 * instruction, answers it, and only then starts the new one — the user sees an answer to a question
 * they already replaced, and pays twice.
 *
 * WHAT DELIVERY MEANS. The follow-up is injected into the live session as model-facing context
 * (the same no-wake `agent.inject` path the roster delta and the status question use), so the
 * RUNNING turn sees it at its next step and can adapt. It creates no run, no task, no round, and it
 * costs no slot. That is deliberately the weaker of the two mechanisms: `agent.followup` would
 * queue a next-turn prompt, which cannot fire while this turn is still running and would be left
 * behind after the plugin settles the run.
 *
 * WHEN IT APPLIES (all must hold):
 *   · the feature is enabled;
 *   · every target of the message is RUNNING with a live agent (all-or-nothing: steering one bot
 *     and opening a new round for another would supersede the round the steered bot belongs to);
 *   · the message belongs to the same thread/task as the running run — a different thread is a
 *     different instruction, not a correction.
 *
 * If any of those fail, the caller takes today's path: a normal new run. A delivery is best-effort
 * by nature (the turn may end between the check and the inject), so the caller reports what really
 * happened instead of assuming it.
 *
 * @module
 */

/** What to do with one target of an incoming user message. */
export type InputDeliveryDecision = 'steer' | 'new-run'

export interface DecideInputDelivery {
  readonly enabled: boolean
  /** The newest live run for the pair: `running` is the only steerable state. */
  readonly runStatus: 'running' | 'queued' | 'idle'
  /** Whether `SessionRunner` currently holds a live agent for the pair. */
  readonly liveAgent: boolean
  /** Thread/task key of the run that is executing (see `threadKeyOf`). */
  readonly runThreadKey: string
  /** Thread/task key of the incoming message. */
  readonly messageThreadKey: string
}

/** The rule, in one pure function so the service has no second copy of it. */
export function decideInputDelivery(input: DecideInputDelivery): InputDeliveryDecision {
  if (!input.enabled) return 'new-run'
  if (input.runStatus !== 'running') return 'new-run'
  if (!input.liveAgent) return 'new-run'
  if (input.runThreadKey !== input.messageThreadKey) return 'new-run'
  return 'steer'
}


/**
 * Bound on the steer bookkeeping (`runId -> thread key`), checked before every insert batch.
 *
 * Entries are only meaningful while their run can still be steered; past this many entries the
 * service prunes the ones whose run has settled. Without the bound the map would grow with every
 * message for the life of the process — the leak this constant and {@link pruneRunThreadKeys}
 * close (review F2).
 */
export const RUN_THREAD_KEY_LIMIT = 512

/**
 * Drop bookkeeping for runs that can no longer be steered. Mutates in place and returns whether
 * anything was removed, so the caller can log/measure the prune without rebuilding the map.
 */
export function pruneRunThreadKeys(
  keys: Map<string, string>,
  liveRunIds: ReadonlySet<string>,
): boolean {
  let removed = false
  for (const runId of [...keys.keys()]) {
    if (liveRunIds.has(runId)) continue
    keys.delete(runId)
    removed = true
  }
  return removed
}

/** Longest follow-up the injector carries; longer text is clipped, never dropped silently. */
export const MAX_STEER_CHARS = 4_000

/**
 * The text actually injected into the live turn.
 *
 * Framed as a mid-turn correction, not as a new request: the model must continue the CURRENT work
 * and adapt it, not answer the follow-up as a separate question. The truncation marker tells the
 * model the text is partial instead of letting it assume it saw everything.
 */
export function steerInputText(text: string): string {
  const trimmed = text.trim()
  const clipped = [...trimmed].slice(0, MAX_STEER_CHARS).join('')
  const partial = clipped.length < [...trimmed].length ? '（内容过长，已截断）' : ''
  return `【用户在你这一轮执行中途补充/修正】${clipped}${partial}`
    + '\n请继续当前任务，并按这条补充调整做法；如果它与原指令冲突，以这条为准。不要把它当成一条新的独立请求。'
}
