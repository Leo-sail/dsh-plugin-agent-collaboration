/**
 * useGroupProposal — the §5.4 "shall we do this as a group?" flow.
 *
 * Three jobs, all of them about the pending proposal for the room on screen:
 *
 *   · `detectProposal` asks the host after a DM send; the host owns the judgement and may
 *     legitimately answer "no proposal", so the UI never guesses from the text itself.
 *   · a watcher closes the hole `detectProposal` alone left open: a proposal a bot announced
 *     with `propose_group` — the normal path — arrives in the snapshot, not through the RPC.
 *   · the answer callbacks: confirm lands in the NEW group, decline (or timeout) leaves the
 *     reader in the DM and asks that room no more this session.
 *
 * `pendingNavigation` lives here because answering is the only thing that sets it: the room
 * list is tab-filtered, so the target room may not exist in the snapshot the answer came from.
 * Holding it until a snapshot actually carries the room avoids the tab/selection race
 * described at the effect below.
 *
 * The gate's two memory sets are refs, not state: they only ever inform a decision, so
 * re-rendering on them would be pointless work on every poll.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotCommunitySnapshot, BotRoom, ConfirmGroupRequest, GroupProposal } from '@dsh-plugin-agent-community/agent-community'
import { proposalNavigation, shouldPromptProposal } from '../conversation/GroupProposalDialog.tsx'
import { PROPOSAL_TIMED_OUT_NOTICE } from '../conversation/nativeStrings.ts'
import type { ActiveTab, CommunityRemote } from './types.ts'

export interface GroupProposalFlowInput {
  remote: CommunityRemote
  /** The polled snapshot: it carries a proposal the bot announced with `propose_group`. */
  snapshot: BotCommunitySnapshot | undefined
  /** The room on screen — the only room whose pending proposal is worth asking about. */
  selectedId: string | undefined
  /** Cheap identity of the room list; see `useCommunitySnapshot`. */
  roomIdsKey: string
  setTab: (tab: ActiveTab) => void
  setSelectedId: (roomId: string) => void
  setNotice: (text: string) => void
  /**
   * Fetch the snapshot now. No room argument on purpose: after an answer the selection is
   * applied first (directly, or through `pendingNavigation`), and the shell's arbitration
   * (`selection.ts`) must keep it rather than carrying the room this flow was issued from.
   */
  load: () => Promise<void>
}

/** Everything the shell needs to render and answer {@link GroupProposalDialog}. */
export interface GroupProposalFlow {
  /** The proposal the dialog should show, or `undefined` when there is nothing to ask. */
  proposal: GroupProposal | undefined
  /** §5.4: after a DM send, ask the host whether this task should become a group. */
  detectProposal: (roomId: string, messageId: string) => Promise<void>
  onConfirm: (input: ConfirmGroupRequest) => Promise<BotRoom>
  onDecline: (proposalId: string) => Promise<void>
  onConfirmed: (room: BotRoom) => void
  onDeclined: (proposalId: string, cause: 'user' | 'timeout') => void
}

export function useGroupProposal({
  remote, snapshot, selectedId, roomIdsKey, setTab, setSelectedId, setNotice, load,
}: GroupProposalFlowInput): GroupProposalFlow {
  const [proposal, setProposal] = useState<GroupProposal | undefined>()
  /** Rooms where the user chose 我自己做; asked once, not on every later message. */
  const soloRooms = useRef(new Set<string>())
  /** Proposals already answered, keyed by the message that produced them. */
  const answeredMessages = useRef(new Set<string>())
  /**
   * Where to land once a freshly created room shows up in a snapshot.
   *
   * The room list is filtered by tab, and `load()` uses the tab from the closure it
   * was created with, so switching tab and selecting the new room in the same commit
   * got undone by the next reload ("select the first room of the DM list"). Holding
   * the target until the snapshot actually contains it avoids that race entirely.
   */
  const pendingNavigation = useRef<{ tab: ActiveTab; selectedId: string } | undefined>(undefined)

  // ── A BOT'S OWN PROPOSAL ALSO HAS TO REACH THE USER ──────────────────────────
  //
  // `detectProposal` only runs right after the user sends in a DM, so a proposal a bot
  // announced with `propose_group` — the normal path — never raised the dialog: the room
  // carried a pending proposal nobody was asked about. The snapshot already contains it, so
  // watching the selected room closes that hole without any new RPC.
  useEffect(() => {
    const room = snapshot?.rooms.find(r => r.id === selectedId)
    const pending = room?.pendingGroupProposal
    if (pending === undefined || pending.status !== 'pending') return
    if (pending.sourceMessageId === undefined) return
    // The stored proposal and the RPC's answer are two shapes: the state keeps `roomId`/
    // `memberIds`, the dialog wants `sourceRoomId`/`suggestedMemberIds`. Mapping here keeps
    // one dialog for both paths instead of a second renderer.
    const view: GroupProposal = {
      id: pending.id,
      sourceRoomId: pending.roomId,
      sourceMessageId: pending.sourceMessageId,
      suggestedName: pending.name,
      suggestedMemberIds: pending.memberIds,
      ...(pending.leaderId !== undefined ? { suggestedLeaderId: pending.leaderId } : {}),
      reason: pending.reason,
      createdAt: pending.createdAt,
    }
    if (!shouldPromptProposal({
      proposal: view,
      roomId: pending.roomId,
      messageId: pending.sourceMessageId,
      soloRooms: soloRooms.current,
      answeredMessages: answeredMessages.current,
    })) return
    // Never replace a proposal the user is already reading.
    setProposal(prev => prev ?? view)
  }, [snapshot, selectedId])

  // §5.4: after the user sends in a DM, ask the host whether this task should become
  // a group. The host owns the judgement (it may legitimately answer "no proposal"),
  // so the UI never guesses from the text itself.
  //
  // Detached on purpose: the message is already sent, and a failed analysis must not
  // turn into a send error the user cannot explain.
  const detectProposal = useCallback(async (roomId: string, messageId: string): Promise<void> => {
    let candidate: GroupProposal | undefined
    try {
      candidate = await remote.proposeGroup({ roomId, messageId })
    } catch {
      return
    }
    if (!shouldPromptProposal({
      proposal: candidate,
      roomId,
      messageId,
      soloRooms: soloRooms.current,
      answeredMessages: answeredMessages.current,
    })) return
    // Never replace a proposal the user is already reading: the poll can deliver a
    // second answer for a later message while the first dialog is still open.
    setProposal(prev => prev ?? candidate)
  }, [remote])

  // Apply a pending navigation as soon as its room exists in a snapshot.
  useEffect(() => {
    const want = pendingNavigation.current
    if (want === undefined) return
    if (snapshot === undefined || !snapshot.rooms.some(r => r.id === want.selectedId)) return
    pendingNavigation.current = undefined
    setTab(want.tab)
    setSelectedId(want.selectedId)
    // Keyed on the room IDS, not the snapshot object: the snapshot is a new object on every poll, so
    // this effect used to run 0.7–2.5×/s and rebuild its `view` object each time.
  }, [roomIdsKey])

  const onConfirm = useCallback(
    (input: ConfirmGroupRequest) => remote.confirmGroup(input),
    [remote],
  )
  const onDecline = useCallback(
    (proposalId: string) => remote.declineGroup({ proposalId }),
    [remote],
  )

  const onConfirmed = (room: BotRoom): void => {
    if (proposal === undefined) return
    answeredMessages.current.add(proposal.sourceMessageId)
    setProposal(undefined)
    // Land in the NEW group. Held until the next snapshot carries it, because
    // this snapshot predates the room and the list is tab-filtered.
    pendingNavigation.current = proposalNavigation({ kind: 'joined', room }, proposal.sourceRoomId)
    void load()
  }

  const onDeclined = (_proposalId: string, cause: 'user' | 'timeout'): void => {
    if (proposal === undefined) return
    const source = proposal.sourceRoomId
    answeredMessages.current.add(proposal.sourceMessageId)
    // §5.4 timeout counts as a decline — and either way the user has said
    // "I'll do it myself", so this room is not asked again this session. The
    // sidebar's 新建群聊 remains available for a deliberate group.
    soloRooms.current.add(source)
    setProposal(undefined)
    const nav = proposalNavigation(
      { kind: 'stayed', reason: cause === 'timeout' ? 'timeout' : 'declined' },
      source,
    )
    setTab(nav.tab)
    setSelectedId(nav.selectedId)
    if (cause === 'timeout') setNotice(PROPOSAL_TIMED_OUT_NOTICE)
    // Selection first, then the reload: `load()` no longer takes a room (the shell keeps
    // whatever was selected when the answer lands), so passing the old source room here as
    // a preference is neither possible nor wanted.
    void load()
  }

  return { proposal, detectProposal, onConfirm, onDecline, onConfirmed, onDeclined }
}
