/**
 * selection.ts — who the room list should point at after a snapshot answer lands.
 *
 * The bug this closes: `load()` used to write back the selection it had captured when it
 * STARTED. The 400–1500ms poll therefore undid a click that happened while its request was
 * in flight, and a reload issued by a send / model change / fork dragged the user back to
 * the room it was opened from. Two separate facts decide the selection now:
 *
 *   · a request may only apply its answer if no newer request started — that is the
 *     generation counter in `useCommunitySnapshot`, it is about DATA, not selection;
 *   · an explicit `preferId` may only win if the request STARTED after the user's last
 *     explicit pick — a fetch that predates the click must not re-point the selection.
 *
 * Kept pure and DOM-free so the rules are testable without a host or a React tree (this
 * workspace ships neither for tests); the hook imports it rather than repeating the
 * comparisons inline.
 */

/** The facts a snapshot answer has to be judged against. */
export interface SelectionInput {
  /** The selection before this answer; `undefined` only before the first pick. */
  prev: string | undefined
  /** Room the caller explicitly asked to keep, if any. */
  preferId: string | undefined
  /** `Date.now()` when the request that produced this answer was STARTED. */
  requestStartedAt: number
  /** `Date.now()` of the user's last explicit room/tab pick; 0 before the first one. */
  lastUserSelectAt: number
  /** The ids of the rooms this answer would show in the current tab. */
  roomIds: readonly string[]
}

/**
 * Pick the room to select after a snapshot answer.
 *
 * Without a `preferId` the answer NEVER re-points the selection: it only repairs it when
 * the selected room is gone from the list (deleted, or a room of the other tab). With a
 * `preferId` the request has to have started AFTER the user's last pick, otherwise it
 * keeps `prev` — that ordering is what stops a fork/reload that was already in flight
 * from pulling the user back after they have moved on.
 *
 * The result is always either a room present in `roomIds` or `undefined` when the list is
 * empty: the page renders an empty state for `undefined`, never a dangling id.
 */
export function resolveSelection({
  prev, preferId, requestStartedAt, lastUserSelectAt, roomIds,
}: SelectionInput): string | undefined {
  // Ties go to the user: `>` rather than `>=`, so a request started in the same
  // millisecond as the pick is treated as predating it.
  const preferred = preferId !== undefined && requestStartedAt > lastUserSelectAt ? preferId : undefined
  const want = preferred ?? prev
  if (want !== undefined && roomIds.includes(want)) return want
  // The wanted room is not in this tab's list: fall back to its first row rather than
  // leaving a selection the list cannot highlight.
  return roomIds[0]
}
