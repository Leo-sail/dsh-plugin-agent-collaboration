/**
 * Persisted community state: its shape, its version hops, and reading it back safely.
 *
 * Extracted from the service class, which had reached ~3,900 lines owning persistence, migrations,
 * bot/room CRUD, messaging, run control, session bookkeeping, eight filesystem sweeps, unread,
 * schedules and the RPC surface at once. Nothing here needs a `Context`, so it is the one part that
 * lifts out cleanly — which matters most for the migrations, the highest-risk code in the package.
 *
 * @module
 */
import type { BotId, BotIdentity, BotMailboxItem, BotMessage, BotRoom, BotRoomId, BotRun } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface RoomAgentSession {
  readonly roomId: BotRoomId
  readonly botId: BotId
  readonly sessionId: SessionId
}

export interface PersistedState {
  readonly version: 2 | 3 | 4 | 5 | 6
  readonly bots: BotIdentity[]
  readonly rooms: BotRoom[]
  readonly messages: BotMessage[]
  readonly runs: BotRun[]
  readonly mailbox: BotMailboxItem[]
  readonly roomAgentSessions: RoomAgentSession[]
  /**
   * Reminders bots created, owned and fired by this plugin (see bot-schedules.ts).
   *
   * Additive: a state file written before this field simply lacks it, and an empty list is the
   * right default for a community that has not scheduled anything yet.
   */
  readonly botSchedules?: import('./bot-schedules.ts').BotSchedule[]
  /**
   * Host reminder ids this plugin has ALREADY delivered.
   *
   * Without it the loop re-imports a delivered reminder: the entry leaves `botSchedules` the
   * moment it fires, while the host row is only settled a moment later (an async delete), so the
   * next 5-second scan sees a due row it has never seen before and delivers it AGAIN. Observed on
   * the real host: one reminder produced two runs 5 seconds apart, and the bot itself reported
   * "这条是重复投递的提醒". Bounded to the most recent ids.
   */
  readonly firedHostIds?: string[]
  /**
   * Id of the last message the user has READ in a room — the room's read water mark.
   *
   * Unread is DERIVED from this plus the room's message list (`snapshot().unread`), never counted up
   * incrementally. The first version kept counters and bumped them from two places (room messages and
   * ledger rows), so one sentence could be counted twice — the badge showed a larger number than the
   * room actually held. An id water mark has a single source of truth and cannot drift; it also
   * survives messages arriving out of order, because membership is decided by position in the room's
   * own ordered list.
   */
  /**
   * Read water marks, per room.
   *
   * `string` is what builds before the time survived; `ReadMark` carries the marked
   * message's time so the mark outlives the message (compaction). Both are accepted.
   */
  readonly roomReadAt?: Record<string, string | import('./unread.ts').ReadMark>
  /**
   * What each Bot remembers about each room it worked in — see `bot-memory.ts`.
   *
   * Top-level and keyed by (roomId, botId) on purpose: memory attached to the room record would be
   * shipped to the browser by `snapshot()` and `listRooms()` on every poll, and attaching it to the
   * bot instead would put two rooms' memories in one place — exactly the mixing the feature forbids.
   *
   * Additive: a board written before this field simply lacks it (`?? []` at every reader), which is
   * why `CURRENT_VERSION` does NOT move. Bumping it would make every older build refuse the whole
   * board — the version check rejects anything above the version it knows.
   */
  readonly botMemories?: import('./types.ts').BotMemoryRecord[]
}

export const CURRENT_VERSION = 6

export function parsePersistedState(raw: string, log: { warn(msg: string): void }): { state: PersistedState; migrated: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error: unknown) {
    throw new Error(`state file is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('state file is not a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  const version = obj['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 2 || version > CURRENT_VERSION) {
    throw new Error(`state file has an unsupported version: ${String(version)}`)
  }
  // Every version carries these arrays; a missing one is damage, not an empty community.
  for (const key of ['bots', 'rooms', 'messages', 'runs', 'mailbox', 'roomAgentSessions'] as const) {
    const value = obj[key]
    if (value === undefined && (key === 'mailbox' || key === 'roomAgentSessions')) continue
    if (!Array.isArray(value)) throw new Error(`state file field "${key}" is missing or not an array`)
  }
  const state = obj as unknown as PersistedState
  if (version === CURRENT_VERSION) return { state, migrated: false }

  let next: PersistedState = state
  if (version <= 2) {
    next = {
      ...next,
      bots: next.bots.map(b => (b.permission !== undefined ? b : { ...b, permission: 'full-access' as const })),
      runs: next.runs.map(r => (r.status === 'queued' ? { ...r, status: 'cancelled' as const, error: 'superseded by executor upgrade' } : r)),
    }
  }
  if (version <= 3) {
    next = {
      ...next,
      runs: next.runs.map(r => (r.status === 'queued' ? { ...r, status: 'cancelled' as const, error: 'superseded by v4 executor' } : r)),
    }
  }
  // v4 → v5 used to add a persisted `sessionVisibility` array that was always written as []; the
  // live records live in VisibilityController, so the hop is a documented no-op.
  if (version <= 5) {
    next = {
      ...next,
      bots: next.bots.map(b => (b.permission === undefined || b.permission === 'workspace-write'
        ? { ...b, permission: 'full-access' as const }
        : b)),
    }
  }
  log.warn(`agent-community: migrated state from v${version} to v${CURRENT_VERSION}`)
  return { state: { ...next, version: CURRENT_VERSION }, migrated: true }
}

export function emptyState(): PersistedState {
  return {
    version: CURRENT_VERSION,
    bots: [],
    rooms: [],
    messages: [],
    runs: [],
    mailbox: [],
    roomAgentSessions: [],
    botSchedules: [],
    firedHostIds: [],
    roomReadAt: {},
    botMemories: [],
  }
}
