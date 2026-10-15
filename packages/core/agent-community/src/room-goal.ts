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
 * the plugin instead: one more run while there is progress, stop when there is not.
 *
 * @module
 */
import type { BotId, RoomGoal } from './types.ts'

/** Longest goal text kept; the prompt block has a budget too. */
export const MAX_GOAL_CHARS = 300

/** How many consecutive goal-driven rounds without progress before the goal pauses itself. */
export const GOAL_STALL_LIMIT = 3

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
  const label = goal.status === 'active' ? '进行中' : goal.status === 'paused' ? '已暂停' : '已完成'
  const clipped = text.length <= MAX_GOAL_CHARS ? text : `${text.slice(0, MAX_GOAL_CHARS - 1)}…`
  return `[${label}] ${clipped}`
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

/** Whether a goal-driven follow-up run should be queued after a turn settles. */
export function shouldContinueGoal(input: {
  readonly goal: RoomGoal | undefined
  /** The run that just finished was started BY the goal (not by the user). */
  readonly goalDriven: boolean
  /** Did that run actually touch anything (tool calls: files, commands, edits)? */
  readonly hadToolActivity: boolean
  /** Runs already queued for this goal without a user message in between. */
  readonly continuations: number
  readonly maxContinuations?: number | undefined
}): boolean {
  const goal = input.goal
  if (goal === undefined || goal.status !== 'active') return false
  const max = input.maxContinuations ?? 3
  if (input.continuations >= max) return false
  // A round that produced nothing real is a stall, not progress: continuing would burn a
  // model call per round until the user notices. The goal pauses instead (see the service).
  return input.hadToolActivity
}
