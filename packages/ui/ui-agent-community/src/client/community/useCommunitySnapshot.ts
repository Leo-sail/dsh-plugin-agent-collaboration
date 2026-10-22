/**
 * useCommunitySnapshot — the page's data loop, in one place.
 *
 * Three jobs, all of them about `remote.snapshot()`:
 *
 *   · `load()` fetches once, stores the result, and repairs the selection if the selected
 *     room no longer exists in the current tab's list. It does NOT decide the selection by
 *     itself: `selection.ts` arbitrates between "what the user last picked" and "what an
 *     explicit reload asked for", using the timestamps below.
 *   · a poll re-runs `load()`: 400ms while any run is live, 1500ms when everything is idle.
 *   · a repair pass gives a bot that has no direct room one, so a bot can never be listed
 *     without a conversation to open.
 *
 * The two `…Key` strings exist so the effects that only care about "did the pairing change?"
 * do not re-run on every poll: the snapshot is a fresh object each tick, so keying them on it
 * would rebuild work 0.7–2.5× a second. `roomIdsKey` is returned because the shell's
 * pending-navigation effect needs the same cheap identity.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { BotCommunitySnapshot } from '@dsh-plugin-agent-community/agent-community'
import type { ActiveTab, CommunityRemote } from './types.ts'
import { describe } from './types.ts'
import { resolveSelection } from './selection.ts'

export interface CommunitySnapshotLoop {
  snapshot: BotCommunitySnapshot | undefined
  /**
   * Local update of the last snapshot.
   *
   * Needed because the host's answer to a write (marking a room read) only reaches this panel
   * on the NEXT poll: without this, the room the user is sitting in keeps showing the unread
   * dot it was opened to clear until that poll lands.
   */
  setSnapshot: Dispatch<SetStateAction<BotCommunitySnapshot | undefined>>
  /** Last `load()` failure. The shell paints it over the conversation area. */
  error: string | undefined
  setError: Dispatch<SetStateAction<string | undefined>>
  /**
   * Fetch the snapshot now; `preferId` asks to keep that room selected while it still exists.
   *
   * Honoured only when the fetch STARTED after the user's last pick (see `selection.ts`):
   * a reload issued before a click must not undo it when it lands. Callers that just want
   * fresh data — the poll, a send, a fork — pass nothing and keep whatever is selected.
   */
  load: (preferId?: string) => Promise<void>
  /**
   * Record that the USER just picked a room or tab.
   *
   * Must be called immediately before the `setSelectedId` that applies the pick: an
   * explicit reload already in flight has to lose to this click, and the timestamp is what
   * `resolveSelection` compares the request's start time against.
   */
  noteUserSelection: () => void
  /** Room ids, comma-joined — a cheap identity for "the room list changed". */
  roomIdsKey: string
}

export function useCommunitySnapshot({ remote, tab, setSelectedId }: {
  remote: CommunityRemote
  tab: ActiveTab
  /** The shell owns the selection; the hook only repairs it after a fetch. Stable setter. */
  setSelectedId: Dispatch<SetStateAction<string | undefined>>
}): CommunitySnapshotLoop {
  const [snapshot, setSnapshot] = useState<BotCommunitySnapshot>()
  const [error, setError] = useState<string>()

  const backfilling = useRef(false)

  /**
   * Monotonic id of the newest `load()`.
   *
   * The poll can have several requests in flight at once (400ms ticks against a slow host),
   * and a tab switch creates a new `load` while the old one still runs. Without this, an
   * older answer could land last and both paint stale data AND re-point the selection — the
   * "clicked another Bot, had to click several times" symptom. Only the newest request may
   * commit anything.
   */
  const seqRef = useRef(0)
  /**
   * `Date.now()` of the user's last explicit pick, 0 before the first one.
   *
   * A REF, not state: only `resolveSelection` reads it, and it has to be read at the moment
   * an answer lands — re-rendering on a click is already handled by `selectedId`.
   */
  const lastUserSelectAtRef = useRef(0)

  const noteUserSelection = useCallback(() => {
    lastUserSelectAtRef.current = Date.now()
  }, [])

  const load = useCallback(async (preferId?: string) => {
    const reqSeq = ++seqRef.current
    const startedAt = Date.now()
    try {
      const snap = await remote.snapshot()
      // A newer request already started: its answer supersedes this one, so committing this
      // stale snapshot would only overwrite fresher data and could undo the user's click.
      if (reqSeq !== seqRef.current) return
      setSnapshot(snap)
      const rooms = tab === 'bots'
        ? snap.rooms.filter(r => r.directBotId !== undefined)
        : snap.rooms.filter(r => r.directBotId === undefined)
      const roomIds = rooms.map(r => r.id)
      setSelectedId(prev => resolveSelection({
        prev,
        preferId,
        requestStartedAt: startedAt,
        lastUserSelectAt: lastUserSelectAtRef.current,
        roomIds,
      }))
      setError(undefined)
    } catch (e) {
      // Same generation rule for failures: a superseded request must not paint its error
      // over the answer (or the cleared error) of the request that replaced it.
      if (reqSeq !== seqRef.current) return
      setError(describe(e))
    }
    // `setSelectedId` is a stable state setter, so the callback's identity still only follows
    // `remote` and `tab` — which is what the poll and the callers rely on.
  }, [remote, tab])

  const roomIdsKey = (snapshot?.rooms ?? []).map(r => r.id).join(',')
  /** Cheap identity of the bot↔room pairing, so the repair effect is not poll-driven. */
  const botsRoomsKey = [
    ...(snapshot?.bots ?? []).map(b => b.id),
    ...(snapshot?.rooms ?? []).map(r => `${r.id}:${r.directBotId ?? ''}`),
  ].join('|')

  // Poll the snapshot faster while any run is live.
  //
  // 1500ms was slow enough that a short run could start AND finish between two
  // samples, so the panel never observed it as `running`: no whale, no force-open
  // work section, and no duration. 400ms while live keeps the running state visible
  // without hammering the host once everything is idle.
  //
  // The tick passes NO room id on purpose: it used to capture `selectedId` from this
  // effect's closure and pass it as `preferId`, which made every in-flight poll write back
  // the room the user had already left. The poll's job is data only — the selection stays
  // whatever the user picked, and `resolveSelection` only repairs a room that disappeared.
  const anyRunLive = (snapshot?.runs ?? []).some(
    (r: { status?: string }) => r.status === 'running' || r.status === 'queued',
  )
  useEffect(() => {
    const every = anyRunLive ? 400 : 1500
    const t = window.setInterval(() => { void load() }, every)
    return () => clearInterval(t)
  }, [load, anyRunLive])

  // Repair bots that have no direct room (e.g. created by tool before the pairing existed)
  useEffect(() => {
    if (snapshot === undefined || backfilling.current) return
    const missing = snapshot.bots.filter(b => !snapshot.rooms.some(r => r.directBotId === b.id))
    if (missing.length === 0) return
    backfilling.current = true
    void (async () => {
      for (const bot of missing) {
        try {
          await remote.createRoom({ name: bot.name, directBotId: bot.id, memberIds: [bot.id] })
        } catch {
          // Keep repairing others; next load() will surface errors.
        }
      }
      backfilling.current = false
      void load()
    })()
    // Same reasoning as above: only the bot/room pairing matters here, not the object identity.
  }, [botsRoomsKey, remote, load])

  return { setSnapshot, snapshot, error, setError, load, noteUserSelection, roomIdsKey }
}
