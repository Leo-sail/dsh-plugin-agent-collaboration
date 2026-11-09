/**
 * Member presence — what a leader needs to know before it dispatches work.
 *
 * WHY THIS EXISTS. `assign_task` wakes a member whether or not that member is already busy, and
 * the leader had no way to see the difference: the roster in its prompt says who EXISTS, not who
 * is mid-turn, queued, blocked on a user approval or waiting for a peer. The result was visible
 * in real rooms — two tasks handed to the same busy member, a leader re-assigning work to the bot
 * it just woke. Presence is derived state (runs + approvals + assignments + mailbox), never a
 * stored flag, so it cannot drift from the runs the panel already shows.
 *
 * PURE: the service collects the raw facts and this module decides the ONE state a member is in,
 * so the ordering rule (working beats queued beats waiting beats idle) is testable without a host.
 *
 * @module
 */

/** The one state a room member is in, in decreasing order of "do not give it more work". */
export type MemberPresenceState =
  | 'working'
  | 'queued'
  | 'waiting-approval'
  | 'waiting-other'
  | 'idle'

/** Raw facts the service can observe for one member. */
export interface MemberPresenceInput {
  readonly botId: string
  readonly name: string
  /** A run of THIS bot in THIS room is running. */
  readonly running: boolean
  /** A run of THIS bot in THIS room is queued. */
  readonly queued: boolean
  /** Approval cards this bot is currently blocked on. */
  readonly pendingApprovals: number
  /**
   * Some OTHER member of the room is running. A member with nothing of its own in flight is
   * "waiting on others" — the state that explains why the room is quiet from its point of view.
   */
  readonly othersRunning: boolean
  /** The open board assignment for this bot, when it has one. */
  readonly assignment?: {
    readonly status: 'assigned' | 'working' | 'reported' | 'done' | 'blocked' | 'failed' | 'cancelled' | 'open'
    readonly task: string
  } | undefined
  /** Messages waiting in this bot's room inbox. */
  readonly mailboxPending: number
}

/** One member as the list_bots tool reports it. */
export interface MemberPresenceView {
  readonly botId: string
  readonly name: string
  readonly state: MemberPresenceState
  /** Chinese label for the transcript/tool rendering. */
  readonly label: string
  readonly pendingApprovals: number
  readonly mailboxPending: number
  readonly assignment?: {
    readonly status: string
    readonly task: string
  } | undefined
}

const LABELS: Readonly<Record<MemberPresenceState, string>> = {
  working: '工作中',
  queued: '排队中',
  'waiting-approval': '等审批',
  'waiting-other': '等别的 Bot',
  idle: '空闲',
}

/** Non-negative integer, for counts that come from loosely-typed host state. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Decide the ONE state for a member, and package the counts the leader needs.
 *
 * ORDER IS THE RULE: a running turn outranks everything (do not wake it again); a queued run is
 * next (it will start on its own); then a blocked approval (it cannot move without the user);
 * then "waiting on another member"; idle last. The ordering is deliberate — reporting "空闲" for
 * a bot that is actually blocked on an approval is the exact wrong information for a dispatcher.
 */
export function memberPresence(input: MemberPresenceInput): MemberPresenceView {
  const pendingApprovals = count(input.pendingApprovals)
  const mailboxPending = count(input.mailboxPending)
  const state: MemberPresenceState = input.running
    ? 'working'
    : input.queued
      ? 'queued'
      : pendingApprovals > 0
        ? 'waiting-approval'
        : input.othersRunning
          ? 'waiting-other'
          : 'idle'
  return {
    botId: input.botId,
    name: input.name,
    state,
    label: LABELS[state],
    pendingApprovals,
    mailboxPending,
    ...(input.assignment !== undefined
      ? { assignment: { status: input.assignment.status, task: input.assignment.task } }
      : {}),
  }
}

/** Whether a member can take new work right now (the leader's dispatch precondition). */
export function canTakeWork(view: MemberPresenceView): boolean {
  return view.state === 'idle'
}

/** One Chinese line per member, for the `list_bots` tool's text answer. */
export function describePresence(view: MemberPresenceView): string {
  const parts = [`· ${view.name}：${view.label}`]
  if (view.assignment !== undefined) {
    parts.push(`任务「${view.assignment.task}」（${view.assignment.status}）`)
  }
  if (view.pendingApprovals > 0) parts.push(`待审批 ${view.pendingApprovals}`)
  if (view.mailboxPending > 0) parts.push(`未读 ${view.mailboxPending}`)
  return parts.join('；')
}
