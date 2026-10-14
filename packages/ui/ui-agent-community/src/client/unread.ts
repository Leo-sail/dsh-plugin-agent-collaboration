/**
 * Unread badges — the arithmetic behind every dot the plugin draws.
 *
 * One map (`snapshot.unread`) feeds three surfaces: the badge beside a room's avatar, the small
 * dot on the Bots / 群聊 tabs, and the total on the plugin's own sidebar entry. Deriving all three
 * from the same numbers with pure functions is what keeps them from disagreeing — a room badge can
 * never say 3 while the entry says 0.
 */

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
