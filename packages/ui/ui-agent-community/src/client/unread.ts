/**
 * Unread badges — the arithmetic behind every dot the plugin draws.
 *
 * One map (`snapshot.unread`) feeds three surfaces: the badge beside a room's avatar, the small
 * dot on the Bots / 群聊 tabs, and the total on the plugin's own sidebar entry. Deriving all three
 * from the same numbers with pure functions is what keeps them from disagreeing — a room badge can
 * never say 3 while the entry says 0.
 */

/**
 * Advance a room's read water mark — the one decision behind the panel's mark-read effect.
 *
 * WHY THIS IS A PURE FUNCTION, AND WHY IT IS NOT "MARK THE ROOM READ"
 *
 * The panel used to call `markRoomRead` on every poll tick for as long as the open room showed a
 * count, and every answer dropped the room's unread entry locally for one frame. A mark that
 * cannot cover what is on screen (the replies arrived AFTER the room was opened — deliberately
 * still unread, see README §17) is refused host-side, so the entry came back on the next poll and
 * the badge flipped for ever: reported as 「bots团队入口处的未读消息和侧栏的群聊都会一直闪烁」.
 * Observed on the real modules: ten poll cycles produced nineteen flips and ten local deletes,
 * where the fixed version produces none.
 *
 * 0.3.2 KEEPS THE SAME ARITHMETIC AND CHANGES WHAT THE PANEL CONSIDERS SEEN. The room on screen
 * is read as soon as it is displayed (auto-selected or clicked), and a reply that lands while its
 * room is visible is passed in as an explicit target immediately. Only messages that arrive while
 * the panel is hidden stay unread — they are the ones whose count has to be right when the user
 * comes back. See `CommunityPage.tsx`'s two effects and `README` §17.
 *
 * Three rules kill the flicker, and all three live here so they can be tested without a DOM:
 *   · the water mark is issued at most once per (room, target time) — a target that is not newer
 *     than the last one issued for that room is `undefined`, not a plan;
 *   · the caller may drop the room's unread entry locally ONLY when the target is at/after every
 *     message the panel knows (`clearsRoom`) — otherwise the host is being asked to mark less
 *     than the room holds, and painting that as success is exactly the flicker;
 *   · the comparison is by TIME, never by array index. The send path's target is the message the
 *     RPC just returned, which the panel's snapshot may not contain yet; `findIndex` would answer
 *     -1 there and a "newer" mark would be discarded as "older".
 */

/** One message, as the planner needs it. */
export interface MarkReadMessage {
  readonly id: string
  readonly roomId: string
  readonly createdAt: string
}

/** A mark-read the panel should issue, and what it may do locally when the host confirms it. */
export interface MarkReadPlan {
  /** Message the water mark should land on. */
  readonly upToId: string
  /** When that message was written — the panel's bookkeeping key for this room. */
  readonly at: string
  /**
   * True when `upToId` is at/after every message the panel knows about.
   *
   * Only then does the host's write clear the room, so only then may the panel delete the room's
   * unread entry locally for same-frame feedback.
   */
  readonly clearsRoom: boolean
}

/**
 * Decide whether to advance a room's water mark, and how far.
 *
 * @param input.messages - every message the panel holds, in stored order.
 * @param input.roomId - the room on screen.
 * @param input.openedAt - when that room most recently became the visible one (`undefined` =
 *   the panel never displayed it while in front).
 * @param input.upTo - the message the user demonstrably saw, passed as the object the RPC returned
 *   (NOT looked up in the snapshot, which may not contain it yet); `null` means "everything up to
 *   the moment the room became visible". The arrival effect passes the new message explicitly.
 * @param input.lastMarkedAt - when this panel last asked the host to mark this room.
 * @returns the mark to issue, or `undefined` when there is nothing new to ask for.
 */
export function planMarkRead(input: {
  readonly messages: ReadonlyArray<MarkReadMessage>
  readonly roomId: string
  readonly openedAt: string | undefined
  readonly upTo: { readonly id: string; readonly createdAt: string } | null
  readonly lastMarkedAt: string | undefined
}): MarkReadPlan | undefined {
  const mine = input.messages.filter(m => m.roomId === input.roomId)
  if (mine.length === 0 && input.upTo === null) return undefined
  const newest = mine[mine.length - 1]

  let target: { readonly id: string; readonly createdAt: string } | undefined
  if (input.upTo !== null) {
    target = input.upTo
  } else if (input.openedAt !== undefined) {
    // The newest message that existed when the room became visible: what the user has had on
    // screen. Messages that arrive afterwards are passed in explicitly by the panel while the
    // room stays visible; a hidden window leaves them unread on purpose, so the count is right
    // when the user looks again.
    for (const m of mine) if (m.createdAt <= input.openedAt) target = m
  }
  // NO ANCHOR, NO CALL. An empty room (or one opened before its first message) has nothing the
  // user can be said to have seen, and the host reads a missing target as "mark the newest" —
  // which would mark a reply the user never got to see as read.
  if (target === undefined) return undefined

  // Not newer than the last mark issued for this room: asking again is what made the badge blink,
  // and a backwards mark can never clear anything anyway.
  if (input.lastMarkedAt !== undefined && target.createdAt <= input.lastMarkedAt) return undefined

  return {
    upToId: target.id,
    at: target.createdAt,
    clearsRoom: newest === undefined || target.createdAt >= newest.createdAt,
  }
}

/** Unread count for one room; 0 when the room has nothing unread (absent keys mean 0). */
export function unreadFor(unread: Readonly<Record<string, number>> | undefined, roomId: string | undefined): number {
  if (unread === undefined || roomId === undefined) return 0
  const n = unread[roomId] ?? 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Every room's count added up — what the plugin entry badge shows. */
export function totalUnread(unread: Readonly<Record<string, number>> | undefined): number {
  if (unread === undefined) return 0
  let sum = 0
  for (const n of Object.values(unread)) if (Number.isFinite(n) && n > 0) sum += Math.floor(n)
  return sum
}

/** Rooms with something unread, optionally narrowed to direct chats or group chats. */
export function unreadRoomIds(
  unread: Readonly<Record<string, number>> | undefined,
  rooms: ReadonlyArray<{ readonly id: string; readonly directBotId?: string | undefined }>,
  kind?: 'direct' | 'group',
): string[] {
  if (unread === undefined) return []
  return rooms
    .filter(room => (kind === undefined
      ? true
      : kind === 'direct' ? room.directBotId !== undefined : room.directBotId === undefined))
    .filter(room => unreadFor(unread, room.id) > 0)
    .map(room => room.id)
}

/** Does this section need a dot on its tab? */
export function sectionHasUnread(
  unread: Readonly<Record<string, number>> | undefined,
  rooms: ReadonlyArray<{ readonly id: string; readonly directBotId?: string | undefined }>,
  kind: 'direct' | 'group',
): boolean {
  return unreadRoomIds(unread, rooms, kind).length > 0
}

/**
 * Badge text. Empty for zero, capped at 99+ because the dot is a fixed-size circle and three
 * digits would either overflow it or force every badge to be wider than the avatar it follows.
 */
export function formatUnread(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return n > 99 ? '99+' : String(Math.floor(n))
}
