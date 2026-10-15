/**
 * Unread badges — the one place that decides how many messages a room shows as unread.
 *
 * Pulled out of the service class because it is pure arithmetic over the room list, and because it
 * has already been wrong twice in ways that only a behavioural test would have caught: a per-append
 * counter that double-counted a sentence (room message + ledger row), and a read watermark that made
 * a cleared room report its entire history as unread.
 *
 * @module
 */
import type { BotMessage } from './types.ts'

/** Messages of one room in their stored order. */
type RoomMessages = readonly BotMessage[]

/**
 * One room's read water mark.
 *
 * `id` is the newest message the user had seen; `at` is when that message was written.
 * The timestamp is what makes the mark survive its own message: compaction and pruning
 * delete messages, and a mark that pointed at a deleted message used to be read as
 * "everything here is read" — which silently disabled the unread dot for that room for
 * ever (reported as 「群聊回复后我没有看到小圆点」; that room's mark had been left behind by
 * an earlier compaction).
 */
export interface ReadMark {
  readonly id: string
  /** ISO timestamp of the marked message. Absent on marks written by older builds. */
  readonly at?: string | undefined
}

/** A stored mark: the current object shape, or the bare id an older build wrote. */
export type StoredReadMark = string | ReadMark

/**
 * Turn a stored mark into a `ReadMark`, resolving an old bare-id mark's time.
 *
 * Marks written before the time was stored only carry an id. When that message still
 * exists its time is read from the message, so a later compaction cannot strip the mark
 * of the one fact that keeps the dot honest. A mark whose message is already gone has no
 * recoverable time — the caller decides what that means.
 *
 * @param mark - the stored mark, in either shape.
 * @param messages - every message the caller holds, for the id → time lookup.
 * @returns a resolved mark, or undefined when nothing can be resolved.
 */
export function resolveReadMark(
  mark: StoredReadMark | undefined,
  messages: RoomMessages,
): ReadMark | undefined {
  if (mark === undefined) return undefined
  if (typeof mark !== 'string') return mark
  const found = messages.find(m => m.id === mark)
  return found === undefined ? undefined : { id: found.id, at: found.createdAt }
}

/**
 * Unread count per room, derived from each room's read water mark.
 *
 * `readAt[roomId]` is the last message the user has seen. Everything after it that a bot
 * sent counts — with three deliberate exclusions:
 *
 *   · the user's own messages never count;
 *   · a placeholder with no visible text (reasoning / tool activity only) never counts;
 *   · one RUN counts once, however many message rows it produced, so the narration a model emits
 *     before a tool call cannot inflate the badge.
 *
 * ── A MARK WHOSE MESSAGE IS GONE ──────────────────────────────────────────────
 *
 * Two different situations used to collapse into one wrong answer:
 *
 *   · the marked message was CLEARED — the user emptied the room, so nothing in it is
 *     unread, and the watermark is meaningless;
 *   · the marked message was replaced by COMPACTION while newer messages stayed — the user
 *     read up to a point in time, and everything after that point is still unread.
 *
 * The old rule treated both as "read everything", which made the second case permanent:
 * no reply could ever light the dot again. Now the mark is compared by TIME when its
 * message is gone (the only fix that can tell the two apart), and only a mark whose time
 * is at the end of the list still reads as "nothing unread".
 */
export function unreadByRoom(
  messages: RoomMessages,
  readAt: Readonly<Record<string, StoredReadMark>>,
): Record<string, number> {
  const rooms = new Map<string, BotMessage[]>()
  for (const message of messages) {
    const list = rooms.get(message.roomId)
    if (list === undefined) rooms.set(message.roomId, [message])
    else list.push(message)
  }
  const unread: Record<string, number> = {}
  for (const [roomId, list] of rooms) {
    const from = startIndex(list, readAt[roomId], messages)
    /**
     * One entry per SPEAKER PER TURN.
     *
     * A "turn" is everything since the user's own last message: answering one prompt is ONE
     * notification from a bot, however many rows it produced. That makes the badge agree with
     * what the user counts on screen, and it covers both ways a single reply became two rows:
     *
     *   · the run's own answer (which carries a `runId`) PLUS a message the bot posted itself
     *     through `agent_community_post_message`, which has no run id at all. Measured on a
     *     real board: three bots answered one 「你好」 and the group showed 4 unread, because
     *     one of them had done exactly that;
     *   · a bot that runs twice for one prompt, which a run-only key counted twice.
     *
     * Rows from the same speaker in the same turn collapse; every bot that answered adds one.
     */
    const seen = new Set<string>()
    let turn = -1
    let count = 0
    for (let i = 0; i < list.length; i += 1) {
      const message = list[i]!
      if (message.sender.kind === 'user') {
        // The user's own message opens a new turn. It never counts itself, but it is what
        // makes the next bot message a different notification from the previous one.
        turn += 1
        continue
      }
      if (i < from) continue
      if (message.text.trim() === '') continue
      const speaker = message.sender.botId !== undefined
        ? `id:${message.sender.botId}`
        // Two different bots sharing one turn is only reachable for a bot with no id at
        // all; the name is the best remaining identity, and collapsing those would
        // undercount a group the same way a run-only key did.
        : `name:${message.sender.name}`
      const key = `${speaker}\u0000${turn}`
      if (seen.has(key)) continue
      seen.add(key)
      count += 1
    }
    if (count > 0) unread[roomId] = count
  }
  return unread
}

/**
 * First message index that is still unread for one room's mark.
 *
 * @param list - the room's messages, in stored order.
 * @param mark - the stored mark, in either shape, or undefined when the room was never read.
 * @returns the index to start counting from.
 */
function startIndex(list: RoomMessages, mark: StoredReadMark | undefined, all: RoomMessages): number {
  if (mark === undefined) return 0
  const resolved = resolveReadMark(mark, all)
  const id = typeof mark === 'string' ? mark : mark.id
  const marked = list.findIndex(m => m.id === id)
  if (marked >= 0) return marked + 1
  // The marked message is gone. A mark that carries no time cannot say what the user had
  // seen — that is a mark written before the time existed AND whose message was already
  // deleted, which is unrecoverable; it reads as "nothing unread here" (the pre-fix
  // behaviour) rather than inventing a count.
  const at = resolved?.at
  if (at === undefined) return list.length
  let lastRead = -1
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]!.createdAt <= at) lastRead = i
  }
  return lastRead + 1
}

/** Sum of every room's unread count — what the plugin's sidebar entry shows. */
export function totalUnread(unread: Readonly<Record<string, number>>): number {
  let total = 0
  for (const n of Object.values(unread)) total += n
  return total
}

/**
 * The water mark a "mark as read" call should store for a room.
 *
 * Carries the newest message's TIME as well as its id: the id alone dies with the message,
 * and compaction is exactly the operation that replaces the marked message while newer ones
 * remain (see `unreadByRoom`).
 *
 * `undefined` when the room has no messages, in which case the caller changes nothing (there is
 * nothing to read, and writing a watermark for an empty room would only confuse the next clear).
 */
export function readWaterMarkFor(messages: RoomMessages, roomId: string): ReadMark | undefined {
  let newest: BotMessage | undefined
  for (const message of messages) if (message.roomId === roomId) newest = message
  if (newest === undefined) return undefined
  return { id: newest.id, at: newest.createdAt }
}

/** What one "mark this room read" call should do. */
export type ReadMarkDecision =
  | { readonly write: false; readonly reason: 'empty' | 'same' | 'backwards' }
  | { readonly write: true; readonly mark: ReadMark }

/**
 * Decide what a `markRoomRead` call does to one room's water mark.
 *
 * WHY `same` IS COMPARED BY VALUE: the guard used to be `stored === mark`, a REFERENCE comparison
 * against a mark `readWaterMarkFor` had just built — it could never be true, so every call wrote
 * the whole board. The panel then issued that call once per poll for a room whose unread replies
 * arrived after it was opened (a mark the host correctly refuses as `backwards`), which is how a
 * badge ends up flickering: full-state write per cycle, plus a local clear the panel painted as
 * success. Both reasons now return `write: false`, and the caller is expected to treat that as
 * "nothing changed" rather than as "cleared".
 *
 * @param input.messages - every message the host holds.
 * @param input.roomId - the room being marked.
 * @param input.upToId - the message the caller considered seen; absent means "the newest one now".
 * @param input.stored - the room's current mark, in either shape.
 * @returns `{ write: true, mark }`, or a refusal naming why (`empty` / `same` / `backwards`).
 */
export function decideReadMark(input: {
  readonly messages: RoomMessages
  readonly roomId: string
  readonly upToId?: string | undefined
  readonly stored: StoredReadMark | undefined
}): ReadMarkDecision {
  const newest = readWaterMarkFor(input.messages, input.roomId)
  // An `upToId` that no longer exists (compaction replaced it) falls back to the newest message
  // rather than writing a mark that points at nothing.
  const upTo = input.upToId === undefined
    ? undefined
    : readWaterMarkFor(input.messages.filter(m => m.id === input.upToId), input.roomId)
  const mark = upTo ?? newest
  if (mark === undefined) return { write: false, reason: 'empty' }
  const previous = resolveReadMark(input.stored, input.messages)
  if (previous !== undefined && previous.id === mark.id && previous.at === mark.at) {
    return { write: false, reason: 'same' }
  }
  // Never move the mark BACKWARDS: a slower `upTo` call must not make already-read messages
  // unread again.
  if (previous?.at !== undefined && mark.at !== undefined && mark.at < previous.at) {
    return { write: false, reason: 'backwards' }
  }
  return { write: true, mark }
}

/**
 * Repair water marks that can no longer be interpreted, in place.
 *
 * THE ONE UNRECOVERABLE SHAPE: a mark written before marks carried a time, whose message was
 * then deleted (compaction, pruning). There is no timestamp to compare against, and reading
 * it as "read everything" disables that room's unread dot FOR EVER — measured on the user's
 * board: a group whose mark pointed at a compacted-away message reported zero unread while
 * three bots answered in it. New marks carry their time and cannot end up here; this exists
 * so boards written by older builds heal instead of staying broken.
 *
 * Conservative by construction: a mark whose message still exists is left alone, and a
 * timeless mark is only rewritten using the room's own oldest surviving message (everything
 * in the room post-dates a mark whose message is gone, so counting it as unread is the
 * honest reading). A mark for a room with no messages is dropped — that is the cleared room.
 *
 * @param messages - every message the caller holds.
 * @param readAt - the stored marks, mutated in place.
 * @returns how many marks were rewritten or removed.
 */
export function repairReadMarks(
  messages: RoomMessages,
  readAt: Record<string, StoredReadMark>,
): number {
  // Keys are plain strings: marks hold ids as text, and the branded id type compares
  // with them only one way round.
  const ids = new Set<string>(messages.map(m => String(m.id)))
  let repaired = 0
  for (const [roomId, mark] of Object.entries(readAt)) {
    const id = typeof mark === 'string' ? mark : mark.id
    if (ids.has(id)) continue
    const mine = messages.filter(m => m.roomId === roomId)
    if (mine.length === 0) {
      delete readAt[roomId]
      repaired += 1
      continue
    }
    // An object mark already carries its `at` and stays accurate through later deletions;
    // only the timeless shape is ambiguous, and only that one is rewritten.
    if (typeof mark !== 'string') continue
    let oldest = mine[0]!
    for (const m of mine) if (m.createdAt < oldest.createdAt) oldest = m
    // The id is synthetic on purpose: it names no message, and `unreadByRoom` only uses it
    // to find the mark's place, falling back to `at` when — as here — it matches nothing.
    readAt[roomId] = {
      id: String(oldest.id),
      at: new Date(Date.parse(oldest.createdAt) - 1).toISOString(),
    }
    repaired += 1
  }
  return repaired
}
