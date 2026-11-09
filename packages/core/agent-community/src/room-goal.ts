/**
 * A room's goal — the one objective the bots in THAT room are working toward.
 *
 * WHY IT IS ON THE ROOM AND NOT ON THE BOT. The user's rule has four parts, and all four are
 * satisfied by one decision: the goal is keyed by `roomId` alone.
 *
 *   · a DM's goal must not affect a group's goal      → different roomId
 *   · a group's goal must not affect a DM's bot       → different roomId
 *   · one group's goal must not affect another group  → different roomId
 *   · one bot's DM goal must not affect another's DM  → different roomId
 *
 * Every reader takes the room it was given and nothing else, and no writer can name another
 * room (the tool layer derives the room from the caller's session; see `collaboration-tools`).
 * The goal is never copied into a cross-room carrier — not into the global memory file, not
 * into a bot-level field — so there is no path by which one room's objective could surface in
 * another even after rooms are added later.
 *
 * WHY NOT DSH'S `create_goal`. DSH's goal tools require a direct human request in a top-level
 * agent turn; a bot's turn is driven by the plugin, and the user's words arrive through a room,
 * so that precondition never holds. They also start autonomous continuation rounds that the
 * plugin's run lease, timeout and stop button know nothing about. A room goal is advanced by
 * the plugin instead — but ONLY inside a user-authorized round budget: a bot may propose a
 * goal, and only the user's grant (see `RoomGoalAuthorization`) lets it continue itself.
 *
 * @module
 */
import type { BotId, RoomGoal } from './types.ts'

/** Longest goal text kept; the prompt block has a budget too. */
export const MAX_GOAL_CHARS = 300

/** How many consecutive goal-driven rounds without progress before the goal pauses itself. */
export const GOAL_STALL_LIMIT = 3

/** Default automatic-round budget a user grant carries. */
export const DEFAULT_GOAL_MAX_ROUNDS = 3

/** Hard ceiling on a grant, so a typo in a round budget cannot create an unbounded loop. */
export const GOAL_MAX_ROUNDS_LIMIT = 20

/** Who is asking to change the goal. */
export type GoalActor =
  | { readonly kind: 'user' }
  | { readonly kind: 'bot'; readonly botId: string; readonly roomKind: 'direct' | 'group' }

/** Whether this actor may create, edit, pause or resume THIS room's goal. */
export function canEditGoal(actor: GoalActor, leaderId: string | undefined): boolean {
  // The user owns the room: they may always set or clear its goal.
  if (actor.kind === 'user') return true
  // A group is coordinated by its leader — a member editing the objective under the leader's
  // feet is how two bots end up working toward different things.
  return leaderId !== undefined && leaderId === actor.botId
}

/** Whether a bot may READ this room's goal. Every member may: it is the room's task. */
export function canReadGoal(actor: GoalActor, memberIds: readonly string[]): boolean {
  if (actor.kind === 'user') return true
  return memberIds.some(id => id === actor.botId)
}

/** One line for the prompt block: status + text, clipped. */
export function describeGoal(goal: RoomGoal | undefined): string | undefined {
  if (goal === undefined) return undefined
  const text = goal.text.replace(/\s+/gu, ' ').trim()
  if (text === '') return undefined
  const clipped = text.length <= MAX_GOAL_CHARS ? text : `${text.slice(0, MAX_GOAL_CHARS - 1)}…`
  return `[${goalStatusLabel(goal.status)}] ${clipped}`
}

/** The Chinese label every surface (prompt / notice / panel) uses for one goal status. */
export function goalStatusLabel(status: RoomGoal['status']): string {
  switch (status) {
    case 'active': return '进行中'
    case 'paused': return '已暂停'
    case 'proposed': return '待确认'
    case 'done': return '已完成'
  }
}

/**
 * The `[本房间目标]` block, or undefined when the room has no goal.
 *
 * `roomName` is included on purpose: it is the cheapest way for the model to notice that the
 * goal it is reading belongs to THIS room and not to whatever it did a moment ago elsewhere.
 */
export function goalPromptBlock(goal: RoomGoal | undefined, roomName: string): string | undefined {
  const line = describeGoal(goal)
  if (line === undefined) return undefined
  return [
    '[本房间目标]',
    `房间：${roomName}。以下目标只属于这个房间，与其他房间无关。`,
    line,
  ].join('\n')
}

// ── Automatic continuation: authority + budget ──────────────────────────────

/** Clamp a caller-supplied round budget into [1, GOAL_MAX_ROUNDS_LIMIT]. */
export function clampRoundBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GOAL_MAX_ROUNDS
  return Math.min(GOAL_MAX_ROUNDS_LIMIT, Math.max(1, Math.trunc(value)))
}

export interface GoalRoundBudget {
  readonly maxRounds: number
  readonly roundsUsed: number
  readonly remaining: number
}

/** The user-authorized round budget of a goal, or undefined when there is no grant. */
export function authorizedRoundBudget(goal: RoomGoal | undefined): GoalRoundBudget | undefined {
  const authorization = goal?.authorization
  if (authorization === undefined || authorization.grantedBy !== 'user') return undefined
  const maxRounds = clampRoundBudget(authorization.maxRounds)
  const roundsUsed = Math.max(0, Math.trunc(authorization.roundsUsed))
  return { maxRounds, roundsUsed, remaining: Math.max(0, maxRounds - roundsUsed) }
}

/** Whether the goal carries a user grant that has not expired. */
export function goalAuthorizationUsable(goal: RoomGoal | undefined, nowMs?: number): boolean {
  const authorization = goal?.authorization
  if (authorization === undefined || authorization.grantedBy !== 'user') return false
  if (authorization.expiresAt === undefined || nowMs === undefined) return true
  const expiresAt = Date.parse(authorization.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > nowMs
}

export interface GoalContinuationInput {
  readonly goal: RoomGoal | undefined
  /** Did that run actually touch anything (tool calls: files, commands, edits)? */
  readonly hadToolActivity: boolean
  /** Counter override; defaults to the grant's own `roundsUsed`. */
  readonly roundsUsed?: number | undefined
  /** Current epoch ms; when given, an expired grant can never continue. */
  readonly nowMs?: number | undefined
}

/**
 * Whether a goal-driven follow-up run may be queued after a turn settles.
 *
 * EVERY condition is required, and the authority condition is the point of this function:
 *
 *   · the goal is ACTIVE (a 'proposed' goal is a suggestion awaiting the user, not work);
 *   · the run produced real tool activity (a round that changed nothing is a stall);
 *   · a USER grant exists, is not expired, and still has rounds (a bot cannot grant it);
 *   · the round counter has not reached the grant's `maxRounds`.
 *
 * Without the grant this returns false — that is the "user must decide" rule, enforced in one
 * pure place instead of trusting every caller to remember it.
 */
export function goalContinuationDecision(input: GoalContinuationInput): boolean {
  const goal = input.goal
  if (goal === undefined || goal.status !== 'active') return false
  if (!input.hadToolActivity) return false
  if (!goalAuthorizationUsable(goal, input.nowMs)) return false
  const budget = authorizedRoundBudget(goal)
  if (budget === undefined) return false
  const roundsUsed = input.roundsUsed === undefined
    ? budget.roundsUsed
    : Math.max(0, Math.trunc(input.roundsUsed))
  return roundsUsed < budget.maxRounds
}

/**
 * LEGACY-COMPATIBLE WRAPPER.
 *
 * Older callers (and older persisted goals) counted rounds in `goal.continuations`; this maps
 * that counter onto the same authorization decision, so no path can continue a goal without a
 * grant even if it still speaks the old vocabulary. `goalDriven` is accepted but no longer
 * changes the answer — the grant is the only authority.
 */
export function shouldContinueGoal(input: {
  readonly goal: RoomGoal | undefined
  /** Kept for signature compatibility; the authorization grant decides, not this flag. */
  readonly goalDriven: boolean
  readonly hadToolActivity: boolean
  readonly continuations: number
  readonly maxContinuations?: number | undefined
}): boolean {
  if (!goalContinuationDecision({
    goal: input.goal,
    hadToolActivity: input.hadToolActivity,
    roundsUsed: input.continuations,
  })) return false
  // A caller-provided ceiling may only TIGHTEN the grant, never widen it.
  return input.maxContinuations === undefined || input.continuations < input.maxContinuations
}

// ── Goal mutations (pure, so the authority rules are testable) ──────────────

/** What a Bot's `agent_community_goal` call asks for. */
export type BotGoalAction = 'set' | 'resume' | 'pause' | 'done'

/** What the call actually became: a proposal still needs the user. */
export type BotGoalOutcome = 'proposed' | 'active' | 'paused' | 'done'

export interface BotGoalChange {
  readonly goal: RoomGoal
  readonly outcome: BotGoalOutcome
}

/** A goal a Bot suggested: never active, never carries a grant. */
function proposedGoal(
  previous: RoomGoal | undefined,
  text: string,
  now: string,
  botId: BotId | undefined,
): RoomGoal {
  return {
    text,
    status: 'proposed',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(botId !== undefined ? { ownerBotId: botId } : {}),
    continuations: 0,
    stalledRounds: 0,
  }
}

/**
 * What a BOT's goal call becomes.
 *
 * A bot may propose, and may pause/finish an existing goal, but it can NEVER grant itself
 * automatic continuation: `set`/`resume` land as 'proposed' — with ONE narrow exception. A
 * `set` (progress refresh) of a goal that is already ACTIVE under a live user grant only
 * updates the text: the grant and its spent rounds are preserved, so a per-round progress
 * update cannot reset the budget (which is exactly the loop this rule closes). `resume` never
 * takes that exception, because re-arming is the user's decision, not the bot's.
 *
 * Returns undefined when there is no goal to act on.
 */
export function applyBotGoalChange(previous: RoomGoal | undefined, input: {
  readonly action: BotGoalAction
  readonly text?: string | undefined
  readonly now: string
  readonly botId?: BotId | undefined
}): BotGoalChange | undefined {
  const now = input.now
  const text = (input.text ?? previous?.text ?? '').replace(/\s+/gu, ' ').trim()
  if (input.action === 'pause' || input.action === 'done') {
    if (previous === undefined) return undefined
    const outcome = input.action === 'pause' ? 'paused' as const : 'done' as const
    return { goal: { ...previous, status: outcome, updatedAt: now }, outcome }
  }
  // set / resume
  if (input.action === 'set' && previous !== undefined && previous.status === 'active'
    && goalAuthorizationUsable(previous, Date.parse(now))) {
    if (text === '') return undefined
    return { goal: { ...previous, text, updatedAt: now }, outcome: 'active' }
  }
  if (text === '') return undefined
  return { goal: proposedGoal(previous, text, now, input.botId), outcome: 'proposed' }
}

export interface UserGoalChange {
  readonly goal: RoomGoal
  readonly outcome: 'active' | 'paused' | 'done'
}

/**
 * What the USER's own act becomes.
 *
 * Activating a goal writes a FRESH grant (the user is the authorizer). Pausing/finishing keeps
 * the previous grant untouched, so a later resume cannot silently top the budget up.
 */
export function applyUserGoalChange(previous: RoomGoal | undefined, input: {
  readonly status: 'active' | 'paused' | 'done'
  readonly text?: string | undefined
  readonly now: string
  readonly maxRounds?: number | undefined
}): UserGoalChange | undefined {
  const text = (input.text ?? previous?.text ?? '').replace(/\s+/gu, ' ').trim()
  if (text === '') return undefined
  const now = input.now
  if (input.status === 'active') {
    const goal: RoomGoal = {
      text,
      status: 'active',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(previous?.ownerBotId !== undefined ? { ownerBotId: previous.ownerBotId } : {}),
      authorization: {
        grantedBy: 'user',
        maxRounds: clampRoundBudget(input.maxRounds),
        roundsUsed: 0,
        grantedAt: now,
      },
      continuations: 0,
      stalledRounds: 0,
    }
    return { goal, outcome: 'active' }
  }
  if (previous === undefined) return undefined
  return {
    goal: { ...previous, text, status: input.status, updatedAt: now },
    outcome: input.status,
  }
}

/** Grant (or re-grant) automatic continuation for an existing goal. */
export function authorizeGoal(goal: RoomGoal, input: {
  readonly now: string
  readonly maxRounds?: number | undefined
}): RoomGoal {
  return {
    ...goal,
    status: 'active',
    updatedAt: input.now,
    authorization: {
      grantedBy: 'user',
      maxRounds: clampRoundBudget(input.maxRounds),
      roundsUsed: 0,
      grantedAt: input.now,
    },
    continuations: 0,
    stalledRounds: 0,
  }
}

/** Pause a goal; its grant (and spent rounds) survives so resume cannot refresh it. */
export function pauseGoal(goal: RoomGoal, now: string): RoomGoal {
  return { ...goal, status: 'paused', updatedAt: now }
}

/**
 * Resume a paused goal under the user's own act.
 *
 * A usable grant with rounds left is kept as-is (resume is not a top-up). A goal with no
 * usable grant — never authorized, expired, or budget spent — gets a FRESH grant here,
 * because resuming is itself an explicit user act.
 */
export function resumeGoal(goal: RoomGoal, input: {
  readonly now: string
  readonly maxRounds?: number | undefined
}): RoomGoal {
  const budget = authorizedRoundBudget(goal)
  if (budget !== undefined && budget.remaining > 0 && goalAuthorizationUsable(goal, Date.parse(input.now))) {
    return { ...goal, status: 'active', updatedAt: input.now }
  }
  return authorizeGoal(goal, input)
}
