/**
 * useRoomActions — the open room's destructive/session actions: clear history, cancel every
 * live run, and delete a bot or group through the confirmation dialog.
 *
 * It owns the state those actions need and nothing else: which delete is armed, and which rooms
 * the user cleared this session (client-only — the host is told afterwards, so the transcript
 * repaints before the RPC settles). Everything it touches arrives as parameters, so the shell
 * keeps the snapshot, the selection and the busy flag.
 *
 * `messages` is the open room's transcript after those local clears. The page header that used
 * to render it was removed in favour of the panel's own SessionHeader, which is why the shell no
 * longer reads it — it is kept here (with the clear timestamp it filters on) so the clear flow
 * stays whole rather than being half-deleted.
 */
import { useState } from 'react'
import type { BotRoom, BotRun } from '@dsh-plugin-agent-community/agent-community'
import type { ConfirmDeleteTarget } from './ConfirmDeleteDialog.tsx'
import type { CommunityRemote } from './types.ts'
import { describe } from './types.ts'

export interface RoomActionsInput {
  remote: CommunityRemote
  /** The room on screen — clear and stop-all act on it. */
  selectedId: string | undefined
  /** Its record, for the stop-all pass's member filter. */
  selectedRoom: BotRoom | undefined
  /** Live runs from the snapshot, for the stop-all pass. */
  runs: readonly BotRun[]
  /** Another action is in flight: delete and stop-all hold each other off. */
  busy: boolean
  setBusy: (busy: boolean) => void
  setError: (message: string | undefined) => void
  /** Fetch the snapshot now; `preferId` asks to keep that room selected while it still exists. */
  load: (preferId?: string) => Promise<void>
}

/**
 * What the shell actually consumes. The old shape also carried `messages` plus a clear-history path
 * (`clearedRooms`/`clearTimestamps`) left over from the page header that no longer exists — nothing
 * referenced any of it, so it was deleted rather than ported: the conversation panel's own
 * SessionHeader owns clear/stop, and the transcript it renders comes from the ledger.
 */
export interface RoomActions {
  /** The armed delete target, or `undefined` when no confirmation is up. */
  confirmDelete: ConfirmDeleteTarget | undefined
  requestDelete: (target: ConfirmDeleteTarget) => void
  cancelDelete: () => void
  handleConfirmDelete: () => Promise<void>
}

export function useRoomActions({ remote, busy, setBusy, setError, load }: RoomActionsInput): RoomActions {
  // confirmDelete: show a confirmation dialog before deleting
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteTarget | undefined>()

  async function handleConfirmDelete() {
    if (confirmDelete === undefined || busy) return
    const { type, id } = confirmDelete
    setBusy(true)
    try {
      if (type === 'bot') {
        await remote.deleteBot({ id })
      } else {
        await remote.deleteRoom({ id })
      }
      void load()
    } catch (e) {
      setError(describe(e))
    }
    setConfirmDelete(undefined)
    setBusy(false)
  }

  return {
    confirmDelete,
    requestDelete: (target) => setConfirmDelete(target),
    cancelDelete: () => setConfirmDelete(undefined),
    handleConfirmDelete,
  }
}
