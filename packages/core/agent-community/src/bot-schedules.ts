/**
 * BotSchedules — reminders a bot creates, executed by THIS plugin.
 *
 * WHY THE HOST'S SCHEDULE TOOL CANNOT DELIVER THEM
 * A reminder made through `schedule_create` is bound to the Session that created it, and the
 * host delivers it by calling `ctx.sessionController.resolveAgent(sessionId)`. That resolver
 * refuses any session whose header says `origin: "subagent"`:
 *
 *     if (session.header.origin === "subagent") return true   // hasApiSessionSubagentOwner
 *     … return { error: apiSessionSubagentOwnershipError(sessionId) }
 *
 * Bot sessions are exactly that — the plugin creates them as subagent sessions so they stay out
 * of the user's sidebar. Observed on the host: a reminder created at 04:31:44 (due
 * 04:33:44) stayed `status: "active"`, `lastDelivery: null`, and not one event reached the
 * session; the host only wrote an unpersisted `logger.warn`.
 *
 * SO THE PLUGIN TAKES THEM OVER — WITHOUT TAKING THEM OFF THE USER'S SCREEN: it imports each
 * host reminder bound to one of its own sessions and fires it through its own run pipeline (which
 * restores the session, runs the turn and posts the result in the ROOM). The host ROW STAYS while
 * the reminder is pending, because 自动化任务 reads exactly that row: deleting it at import time
 * made a working reminder invisible there, which the user reported straight away.
 *
 * The row is only settled once the plugin has actually delivered:
 *   · one-shot  → the row is deleted (the host has no way to record a delivery it did not make,
 *                 and leaving it would show a permanently "active" reminder that never fires again)
 *   · recurring → the row is re-timed to the next occurrence, so it stays visible with a correct
 *                 upcoming time on every cycle
 *
 * Recurrence: one-shot reminders (`after` / `at`) and fixed intervals (`every`) are supported.
 * Calendar rules (`daily` / `weekly` / `cron`) are imported as a single next occurrence and
 * reported, because re-deriving them would mean reimplementing time-zone arithmetic the host
 * already owns.
 */
import type { BotId, BotRoomId } from './types.ts'

/** One reminder owned by the plugin. */
export interface BotSchedule {
  readonly id: string
  readonly roomId: BotRoomId
  readonly botId: BotId
  readonly title: string
  readonly prompt: string
  /** Next fire time, ISO. */
  readonly dueAt: string
  /** Fixed interval for a repeating reminder; undefined for a one-shot. */
  readonly everySeconds?: number | undefined
  /** Host reminder this was imported from, for the audit trail and for settling it. */
  readonly hostId?: string | undefined
  /**
   * The session id the HOST row is bound to, verbatim.
   *
   * It is not recomputable: the binding carries the generation the reminder was created in
   * (`ac:<room>:<bot>:gN`), while `sessionIdFor` returns the room's CURRENT generation. Settling
   * the row with the wrong id would silently fail its lookup, so the exact string is kept.
   */
  readonly hostSessionId?: string | undefined
  readonly importedAt: string
  readonly lastFiredAt?: string | undefined
}

/**
 * One row of the host's `schedule.catalog()`.
 *
 * THE RECORD IS FLAT. Captured from the live host:
 *
 *   {"id":"schedule-8cb49253-…","kind":"after","title":"2分钟后发送「你好」",
 *    "prompt":"现在发送消息：你好…","afterSeconds":120,
 *    "scheduledAt":"","sessionId":"ac:…:g14","status":"active"}
 *
 * `ScheduleCatalogEntry` is `ScheduleRecord & { sessionId, status, lastDelivery? }`, so every
 * record field sits at the TOP level. The first version of this file read `row.record.scheduledAt`
 * (the shape `schedule.json` stores internally) and therefore found no due time at all: nothing
 * was imported, and two reminders sat undelivered while the user reported "it never runs".
 * `record` stays supported for the storage shape and for older callers.
 */
export interface HostScheduleRow {
  readonly id?: string
  readonly kind?: string
  readonly title?: string
  readonly prompt?: string
  readonly status?: string
  readonly sessionId?: string
  readonly scheduledAt?: string
  readonly everySeconds?: number
  readonly lastDelivery?: unknown
  readonly record?: {
    readonly id?: string
    readonly kind?: string
    readonly title?: string
    readonly prompt?: string
    readonly scheduledAt?: string
    readonly everySeconds?: number
  } | undefined
}

/** One imported reminder, plus whether a host row was consumed. */
export interface ImportResult {
  readonly imported: BotSchedule[]
  readonly skipped: number
}

/**
 * Turn host reminders bound to this plugin's sessions into plugin-owned reminders.
 *
 * Pure: it decides what to import and what to delete, and the caller does both.
 */
export function planImport(rows: readonly HostScheduleRow[], now = new Date()): {
  readonly schedules: BotSchedule[]
  readonly skipped: number
  readonly calendarOnly: readonly string[]
} {
  const schedules: BotSchedule[] = []
  const calendarOnly: string[] = []
  let skipped = 0
  for (const row of rows) {
    const sessionId = row.sessionId ?? ''
    const hostId = row.record?.id ?? row.id ?? ''
    if (!sessionId.startsWith('ac:') || hostId === '') { skipped += 1; continue }
    const pair = parsePair(sessionId)
    if (pair === undefined) { skipped += 1; continue }
    // Already delivered rows are the host's business, not ours.
    if (row.status !== undefined && row.status !== 'active') { skipped += 1; continue }
    // Flat first (catalog), nested second (storage) — see HostScheduleRow.
    const record = row.record ?? {}
    const kind = row.kind ?? record.kind ?? 'after'
    const dueAt = row.scheduledAt ?? record.scheduledAt ?? ''
    const everySeconds = row.everySeconds ?? record.everySeconds
    if (dueAt === '' || Number.isNaN(Date.parse(dueAt))) { skipped += 1; continue }
    const isEvery = kind === 'every'
    if (kind === 'daily' || kind === 'weekly' || kind === 'cron') calendarOnly.push(row.title ?? record.title ?? hostId)
    schedules.push({
      id: `bs-${hostId}`,
      roomId: pair.roomId,
      botId: pair.botId,
      title: row.title ?? record.title ?? ((row.prompt ?? record.prompt ?? '').slice(0, 40) || '定时提醒'),
      prompt: row.prompt ?? record.prompt ?? '',
      dueAt,
      ...(isEvery && typeof everySeconds === 'number' ? { everySeconds } : {}),
      hostId,
      hostSessionId: sessionId,
      importedAt: now.toISOString(),
    })
  }
  return { schedules, skipped, calendarOnly }
}

/** `ac:<roomId>:<botId>[:gN]` → its pair, or undefined when the id is not ours. */
function parsePair(sessionId: string): { roomId: BotRoomId; botId: BotId } | undefined {
  const parts = sessionId.split(':')
  if (parts.length < 3 || parts[0] !== 'ac') return undefined
  const roomId = parts[1]
  const botId = parts[2]
  if (roomId === undefined || roomId === '' || botId === undefined || botId === '') return undefined
  return { roomId: roomId as BotRoomId, botId: botId as BotId }
}

/** Reminders whose time has come, oldest first. */
export function dueSchedules(schedules: readonly BotSchedule[], now = new Date()): BotSchedule[] {
  const t = now.getTime()
  return schedules
    .filter(s => Date.parse(s.dueAt) <= t)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
}

/**
 * The schedule's next state after it fired.
 *
 * A one-shot returns undefined (it is removed); an interval advances from its PREVIOUS due time
 * so a reminder that fired late does not drift, and skips past any occurrences missed while the
 * app was closed instead of firing a burst of them.
 */
export function advanceSchedule(schedule: BotSchedule, now = new Date()): BotSchedule | undefined {
  if (schedule.everySeconds === undefined || schedule.everySeconds <= 0) return undefined
  const step = schedule.everySeconds * 1000
  let next = Date.parse(schedule.dueAt) + step
  while (next <= now.getTime()) next += step
  return {
    ...schedule,
    dueAt: new Date(next).toISOString(),
    lastFiredAt: now.toISOString(),
  }
}
