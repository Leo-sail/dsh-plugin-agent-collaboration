/**
 * Cross-room open work (S2-3) — the read-only attention index.
 *
 * WHY THIS EXISTS. A room is an isolation domain, and every piece of state about "what is
 * happening" lives inside one. With more than a few rooms the user can no longer tell where a
 * bot is running, where something waits for approval, or where a task finished without proper
 * evidence — they have to open each room and look. The Article's point is that the global order
 * point can be a cheap INDEX without becoming a second source of truth.
 *
 * WHAT IT IS. A pure projection from the state the plugin already writes (runs, room flags, goal
 * stall counters, the task board's finish gate) into one metadata item per (room, kind). It
 * writes nothing, persists nothing and carries NO message text, prompt text or model output —
 * only ids, counts and timestamps. The panel renders it as a dot/count; bots never see it, so the
 * room-isolation rule is untouched.
 *
 * WHAT IS NOT DERIVED (v1): "blocked" is the room's paused flag (the user must resume it);
 * "needs-review" is a finished task whose evidence gate was BYPASSED (unverified). Failed runs are
 * visible in their own room's transcript and are not promoted here.
 *
 * @module
 */

import type { BotId, BotRoomId, OpenWorkItem, OpenWorkKind, OpenWorkRoom, OpenWorkView } from './types.ts'

/** Priority for ordering: the kinds that need a HUMAN first, then activity. */
const KIND_PRIORITY: Readonly<Record<OpenWorkKind, number>> = {
  'awaiting-approval': 0,
  'needs-review': 1,
  stalled: 2,
  blocked: 3,
  running: 4,
  queued: 5,
}

/** Kinds that mean "a person should look at this room". */
const ATTENTION_KINDS: ReadonlySet<OpenWorkKind> = new Set([
  'awaiting-approval',
  'needs-review',
  'stalled',
  'blocked',
])

export interface OpenWorkRunInput {
  readonly roomId: string
  readonly botId: string
  readonly status: string
  readonly awaitingApproval?: boolean | undefined
  readonly createdAt?: string | undefined
  readonly startedAt?: string | undefined
}

export interface OpenWorkRoomInput {
  readonly id: string
  readonly name: string
  readonly directBotId?: string | undefined
  readonly paused?: boolean | undefined
  readonly updatedAt?: string | undefined
  readonly goal?:
    | {
        readonly stalledRounds?: number | undefined
        readonly updatedAt?: string | undefined
      }
    | undefined
  readonly taskState?:
    | {
        readonly finished?:
          | {
              readonly gate?: 'passed' | 'bypassed' | undefined
              readonly at?: string | undefined
            }
          | undefined
      }
    | undefined
}

/** Epoch millis from an ISO timestamp; a malformed/absent value falls back to `fallback`. */
function atMs(iso: string | undefined, fallback: number): number {
  if (iso === undefined || iso === '') return fallback
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Derive one room's aggregated items from its state. Pure and deterministic. */
export function deriveRoomOpenWork(room: OpenWorkRoomInput, runs: readonly OpenWorkRunInput[], now: number): OpenWorkItem[] {
  const roomRuns = runs.filter(run => run.roomId === room.id)
  const items: OpenWorkItem[] = []

  const running = roomRuns.filter(run => run.status === 'running')
  if (running.length > 0) {
    items.push({
      kind: 'running',
      since: Math.min(...running.map(run => atMs(run.startedAt ?? run.createdAt, now))),
      count: running.length,
      botIds: [...new Set(running.map(run => run.botId))] as BotId[],
    })
  }
  const queued = roomRuns.filter(run => run.status === 'queued')
  if (queued.length > 0) {
    items.push({
      kind: 'queued',
      since: Math.min(...queued.map(run => atMs(run.createdAt, now))),
      count: queued.length,
      botIds: [...new Set(queued.map(run => run.botId))] as BotId[],
    })
  }
  const awaiting = roomRuns.filter(run => run.awaitingApproval === true)
  if (awaiting.length > 0) {
    items.push({
      kind: 'awaiting-approval',
      since: Math.min(...awaiting.map(run => atMs(run.startedAt ?? run.createdAt, now))),
      count: awaiting.length,
      botIds: [...new Set(awaiting.map(run => run.botId))] as BotId[],
    })
  }
  if (room.paused === true) {
    items.push({ kind: 'blocked', since: atMs(room.updatedAt, now) })
  }
  if ((room.goal?.stalledRounds ?? 0) > 0) {
    items.push({ kind: 'stalled', since: atMs(room.goal?.updatedAt ?? room.updatedAt, now) })
  }
  if (room.taskState?.finished?.gate === 'bypassed') {
    items.push({ kind: 'needs-review', since: atMs(room.taskState.finished.at ?? room.updatedAt, now) })
  }
  return items
}

/** Derive the whole view: rooms with work only, sorted by attention priority then age. */
export function deriveOpenWork(input: {
  readonly rooms: readonly OpenWorkRoomInput[]
  readonly runs: readonly OpenWorkRunInput[]
  readonly now: number
}): OpenWorkView {
  const rooms: OpenWorkRoom[] = []
  let attentionCount = 0
  let runningCount = 0
  let queuedCount = 0
  for (const room of input.rooms) {
    const items = deriveRoomOpenWork(room, input.runs, input.now)
      .sort((a, b) => (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]) || (a.since - b.since))
    if (items.length === 0) continue
    attentionCount += items.filter(item => ATTENTION_KINDS.has(item.kind)).reduce((sum, item) => sum + (item.count ?? 1), 0)
    runningCount += items.find(item => item.kind === 'running')?.count ?? 0
    queuedCount += items.find(item => item.kind === 'queued')?.count ?? 0
    const roomAttention = items
      .filter(item => ATTENTION_KINDS.has(item.kind))
      .reduce((sum, item) => sum + (item.count ?? 1), 0)
    rooms.push({
      roomId: room.id as BotRoomId,
      roomName: room.name,
      ...(room.directBotId !== undefined ? { directBotId: room.directBotId as BotId } : {}),
      items,
      attentionCount: roomAttention,
    })
  }
  rooms.sort((a, b) => {
    const pa = KIND_PRIORITY[a.items[0]!.kind]
    const pb = KIND_PRIORITY[b.items[0]!.kind]
    return pa !== pb ? pa - pb : a.items[0]!.since - b.items[0]!.since
  })
  return { rooms, attentionCount, runningCount, queuedCount }
}

/** Whether one room needs a human (used by the row badge / tab dot). */
export function roomNeedsAttention(room: OpenWorkRoom): boolean {
  return room.items.some(item => ATTENTION_KINDS.has(item.kind))
}

/** How many items a room reports for its badge (attention kinds only). */
export function roomAttentionCount(room: OpenWorkRoom): number {
  return room.items
    .filter(item => ATTENTION_KINDS.has(item.kind))
    .reduce((sum, item) => sum + (item.count ?? 1), 0)
}
