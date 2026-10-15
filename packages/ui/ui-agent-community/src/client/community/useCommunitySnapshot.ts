/**
 * useCommunitySnapshot — the page's data loop, in one place.
 *
 * Three jobs, all of them about `remote.snapshot()`:
 *
 *   · `load()` fetches once, stores the result, and re-points the selection at a room that still
 *     exists in the current tab's list.
 *   · a poll re-runs `load()`: 400ms while any run is live, 1500ms when everything is idle.
 *   · a repair pass gives a bot that has no direct room one, so a bot can never be listed without
 *     a conversation to open.
 *
 * The two `…Key` strings exist so the effects that only care about "did the pairing change?" do
 * not re-run on every poll: the snapshot is a fresh object each tick, so keying them on it would
 * rebuild work 0.7–2.5× a second. `roomIdsKey` is returned because the shell's pending-navigation
 * effect needs the same cheap identity.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { BotCommunitySnapshot } from '@dsh-plugin-agent-community/agent-community'
import type { ActiveTab, CommunityRemote } from './types.ts'
import { describe } from './types.ts'

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
  /** Fetch the snapshot now; `preferId` asks to keep that room selected while it still exists. */
  load: (preferId?: string) => Promise<void>
  /** Room ids, comma-joined — a cheap identity for "the room list changed". */
  roomIdsKey: string
}

export function useCommunitySnapshot({ remote, tab, selectedId, setSelectedId }: {
  remote: CommunityRemote
  tab: ActiveTab
  selectedId: string | undefined
  /** The shell owns the selection; the hook only re-points it after a fetch. Stable setter. */
  setSelectedId: Dispatch<SetStateAction<string | undefined>>
}): CommunitySnapshotLoop {
  const [snapshot, setSnapshot] = useState<BotCommunitySnapshot>()
  const [error, setError] = useState<string>()

  const backfilling = useRef(false)

  const load = useCallback(async (preferId?: string) => {
    try {
      const snap = await remote.snapshot()
      setSnapshot(snap)
      const rooms = tab === 'bots'
        ? snap.rooms.filter(r => r.directBotId !== undefined)
        : snap.rooms.filter(r => r.directBotId === undefined)
      setSelectedId(prev => {
        const want = preferId ?? prev
        return want !== undefined && rooms.some(r => r.id === want) ? want : rooms[0]?.id
      })
      setError(undefined)
    } catch (e) {
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
  const anyRunLive = (snapshot?.runs ?? []).some(
    (r: { status?: string }) => r.status === 'running' || r.status === 'queued',
  )
  useEffect(() => {
    const every = anyRunLive ? 400 : 1500
    const t = window.setInterval(() => { void load(selectedId) }, every)
    return () => clearInterval(t)
  }, [load, selectedId, anyRunLive])

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

  return { setSnapshot, snapshot, error, setError, load, roomIdsKey }
}
