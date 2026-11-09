/**
 * Run priority (S0-4) — which runs may use the human-reserved slot, and how many live agents a
 * run class may keep.
 *
 * WHY THIS EXISTS. The player's own message must never queue behind the bots it woke up: the
 * article's prototype reserves one extra worker slot for a person's message (and for a status
 * request), so automation can fill every normal slot and the user still gets an answer. This
 * module is the deterministic half: which run origins count as human, and what live-agent ceiling
 * each priority gets. The service and `SessionRunner` share it, so the rule has one home.
 *
 * WHAT IT IS NOT. It does not choose the run's model, budget or tools — only the slot ceiling.
 * An origin this module does not recognise is automation: a new automatic origin must not silently
 * gain the reserved slot.
 *
 * @module
 */

/** Human = a person is waiting on this run; auto = everything the system started by itself. */
export type RunPriority = 'human' | 'auto'

/**
 * Origins that mean a person is waiting.
 *
 * `user` is a message the user sent; `team-user` is the team flow's user-initiated run. Every
 * other origin (`routine`, `a2a`, `bot-message`, `team-assign`, `team-message`, `team-report`,
 * undefined) is automation and must wait behind the normal ceiling.
 */
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['user', 'team-user'])

/** Classify one run origin. Unknown/absent origins are automation, never the reserved slot. */
export function priorityOfOrigin(origin: string | undefined): RunPriority {
  return origin !== undefined && HUMAN_ORIGINS.has(origin) ? 'human' : 'auto'
}

/**
 * The live-agent ceiling for one run.
 *
 * `hardLimit` is the automation ceiling. When the reservation is enabled, `human` runs may keep
 * ONE more live agent than that — the prototyped "extra slot for a person's message" — so the
 * human run can start even while automation holds every normal slot. `hardLimit` below 1 is
 * clamped so a bad config can never produce a zero-slot ceiling.
 */
export function slotLimitFor(hardLimit: number, priority: RunPriority, humanPriority: boolean): number {
  const base = Number.isFinite(hardLimit) && hardLimit >= 1 ? Math.floor(hardLimit) : 1
  return humanPriority && priority === 'human' ? base + 1 : base
}
