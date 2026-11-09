/**
 * Intake (S1-1) — one normalized event envelope in front of every way a room is driven.
 *
 * WHY THIS EXISTS. A room is driven today by four unrelated paths: a user message (inline in
 * `sendMessage`), an A2A/bot message, a fired reminder (`bot-schedules`) and a goal continuation
 * (`room-goal`). Each one knows a different amount about why it is running, and none of them leaves
 * a trace a human can query: when a bot answers something surprising, the answer is "one of these
 * four started it" with the reason buried in a log line.
 *
 * The Super-agent article's event-driven section starts with the same observation: the input is no
 * longer a prompt a person typed, it is a semi-structured EVENT from the environment. This module
 * is the shared envelope and the program-level (Fast Path) filter for those existing sources.
 *
 * V1 IS OBSERVATION-ONLY (deliberate). It builds the envelope, applies the deterministic filter,
 * stamps the event id onto the runs it created and keeps a bounded in-memory ring that
 * `listRecentEvents` exposes. It does NOT gate behaviour: the four paths still do exactly what they
 * did before, and with `intakeEnabled` off nothing at all changes. Rewriting the delivery pipeline
 * around the envelope is the second half of the plan, and doing it in the same commit as the
 * envelope would trade eleven commits of stabilised behaviour for unverified refactoring.
 *
 * @module
 */

/** Where an event came from. The set is closed on purpose: a new source is a product decision. */
export type RoomEventKind =
  | 'user-message'
  | 'a2a-message'
  | 'schedule-due'
  | 'goal-continuation'
  | 'system'

/** Who/what produced the event. `id` is a bot id for `bot`, otherwise opaque. */
export interface RoomEventActor {
  readonly kind: 'user' | 'bot' | 'schedule' | 'system'
  readonly id?: string | undefined
  readonly name?: string | undefined
}

/** What the event carries. Text is stored clipped (a trace, not a second transcript). */
export interface RoomEventPayload {
  readonly text?: string | undefined
  readonly botId?: string | undefined
  readonly scheduleId?: string | undefined
  readonly goalId?: string | undefined
}

/** The program-level filter's verdict, kept on the event so the trace explains itself. */
export interface RoomEventDecision {
  readonly accept: boolean
  readonly reason: string
}

export interface RoomEvent {
  /** C12: the run this event produced (filled by the service view; absent while still routing). */
  readonly runId?: string | undefined
  readonly id: string
  readonly kind: RoomEventKind
  readonly roomId: string
  /** Epoch millis. */
  readonly at: number
  readonly actor: RoomEventActor
  readonly payload: RoomEventPayload
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
  readonly decision: RoomEventDecision
}

/** The room facts the Fast Path reads. Deliberately tiny — no host, no message list. */
export interface IntakeRoomView {
  readonly paused?: boolean | undefined
  readonly memberIds: readonly string[]
}

/** How much event text the trace keeps. */
export const MAX_EVENT_TEXT_CHARS = 240
/** Ring capacity exposed by `listRecentEvents`. */
export const MAX_RECENT_EVENTS = 200

/**
 * The deterministic admission check (the article's Fast Path).
 *
 * It answers "would this event be allowed to drive the room at all", BEFORE any model/routing:
 *   · a paused room accepts nothing (every path already refuses it, so the trace says the same);
 *   · an A2A/bot event from a bot that is not a room member is ignored (the isolation rule);
 *   · every other source is accepted here — whether a user message deserves a RUN is S0-3
 *     admission's decision, made later against the routing result.
 *
 * The filter never grants authority: an accepted event still has to satisfy the path's own checks.
 */
export function filterRoomEvent(input: {
  readonly event: { readonly kind: RoomEventKind; readonly actor: RoomEventActor; readonly payload: RoomEventPayload }
  readonly room: IntakeRoomView
}): RoomEventDecision {
  if (input.room.paused === true) return { accept: false, reason: '房间已暂停' }
  if (input.event.kind === 'a2a-message') {
    const sender = input.event.payload.botId ?? input.event.actor.id
    if (sender !== undefined && !input.room.memberIds.includes(sender)) {
      return { accept: false, reason: '发送方不是本房间成员' }
    }
    return { accept: true, reason: '成员之间的消息' }
  }
  if (input.event.kind === 'schedule-due') return { accept: true, reason: '定时任务到期' }
  if (input.event.kind === 'goal-continuation') return { accept: true, reason: '目标授权续跑' }
  if (input.event.kind === 'user-message') return { accept: true, reason: '用户消息' }
  return { accept: true, reason: '系统事件' }
}

/** Clip the trace text; never split a surrogate pair. */
export function clipEventText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const chars = [...text.trim()]
  if (chars.length === 0) return undefined
  return chars.length <= MAX_EVENT_TEXT_CHARS ? chars.join('') : `${chars.slice(0, MAX_EVENT_TEXT_CHARS).join('')}…`
}

/** Build one normalized event (the caller supplies the id and clock; this module stays pure). */
export function buildRoomEvent(input: {
  readonly id: string
  readonly kind: RoomEventKind
  readonly roomId: string
  readonly at: number
  readonly actor: RoomEventActor
  readonly payload?: RoomEventPayload | undefined
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
  readonly room: IntakeRoomView
}): RoomEvent {
  const actor: RoomEventActor = {
    kind: input.actor.kind,
    ...(input.actor.id !== undefined ? { id: input.actor.id } : {}),
    ...(input.actor.name !== undefined ? { name: input.actor.name } : {}),
  }
  const payload: RoomEventPayload = {
    ...(clipEventText(input.payload?.text) !== undefined ? { text: clipEventText(input.payload?.text) } : {}),
    ...(input.payload?.botId !== undefined ? { botId: input.payload.botId } : {}),
    ...(input.payload?.scheduleId !== undefined ? { scheduleId: input.payload.scheduleId } : {}),
    ...(input.payload?.goalId !== undefined ? { goalId: input.payload.goalId } : {}),
  }
  const event = { kind: input.kind, actor, payload }
  return {
    id: input.id,
    kind: input.kind,
    roomId: input.roomId,
    at: input.at,
    actor,
    payload,
    ...(input.threadId !== undefined && input.threadId !== '' ? { threadId: input.threadId } : {}),
    ...(input.taskId !== undefined && input.taskId !== '' ? { taskId: input.taskId } : {}),
    decision: filterRoomEvent({ event, room: input.room }),
  }
}

/** Map a legacy run origin to the event kind it stands for (used by the central run queue). */
export function intakeKindForOrigin(origin: string | undefined): RoomEventKind {
  if (origin === 'user' || origin === 'team-user') return 'user-message'
  if (origin === 'a2a' || origin === 'bot-message') return 'a2a-message'
  if (origin === 'routine') return 'system'
  return 'system'
}

/** One-line trace for the log and the panel (no prompt text beyond the clipped payload). */
export function eventSummary(event: RoomEvent): string {
  const who = event.actor.name ?? event.actor.id ?? event.actor.kind
  const decision = event.decision.accept ? '接受' : `忽略（${event.decision.reason}）`
  return `[事件] ${event.kind} · ${who} · ${decision} · id=${event.id.slice(0, 8)}`
}

/** Append to the bounded ring, dropping the oldest event. */
export function pushRecentEvent(
  events: readonly RoomEvent[],
  event: RoomEvent,
  limit: number = MAX_RECENT_EVENTS,
): RoomEvent[] {
  const cap = Math.max(1, Math.floor(limit))
  const next = [...events, event]
  return next.length <= cap ? next : next.slice(next.length - cap)
}

/** Newest-first, with the optional kind filter `listRecentEvents` exposes. */
export function recentEventsFor(
  events: readonly RoomEvent[],
  filter: { readonly kind?: RoomEventKind | undefined; readonly roomId?: string | undefined; readonly limit?: number | undefined } = {},
): RoomEvent[] {
  const limit = filter.limit === undefined ? 50 : Math.max(1, Math.min(MAX_RECENT_EVENTS, Math.floor(filter.limit)))
  return [...events]
    .reverse()
    .filter(event => (filter.kind === undefined || event.kind === filter.kind))
    .filter(event => (filter.roomId === undefined || event.roomId === filter.roomId))
    .slice(0, limit)
}
