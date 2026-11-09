/**
 * Proposal editing rules — the pure half of the S7 group dialog.
 *
 * The host proposes a group (name / reason / suggested members / suggested leader), but the
 * suggestion is only a STARTING POINT: the user may add any bot from the live directory,
 * drop suggested ones, and pick any selected member as the leader. The dialog keeps that
 * edit buffer as plain state; the rules about what an edit does and when the result is
 * confirmable live here, so they can be tested without a DOM or a host.
 *
 * Two invariants the dialog relies on:
 *   · the leader is always a SELECTED member (removing the leader re-points it at the first
 *     remaining member, or at nothing when the selection becomes empty);
 *   · a confirmation needs at least two members and a valid leader — the host repeats this
 *     check, but a disabled confirm button is the only thing that keeps an invalid request
 *     from being *sent* in the first place.
 *
 * @module
 */

/** The edit buffer behind the dialog: selected members plus the leader among them. */
export interface ProposalSelection {
  readonly memberIds: readonly string[]
  readonly leaderId?: string | undefined
}

/** What {@link initialProposalSelection} reads from the host proposal. */
export interface ProposalSelectionView {
  /** Suggested member ids, already filtered to bots that still exist (host order). */
  readonly memberIds: readonly string[]
  readonly suggestedLeaderId?: string | undefined
}

/** The minimum a directory entry needs to be listed and sorted. */
export interface ProposalBotLike {
  readonly id: string
  readonly name: string
}

/** The verdict on a selection: confirmable, or why not. */
export interface ProposalValidation {
  readonly ok: boolean
  readonly reason?: string | undefined
}

/** Members a group needs before it is a collaboration rather than the DM itself. */
export const MIN_PROPOSAL_MEMBERS = 2

/**
 * The directory in display order.
 *
 * Sorted by name so the add/remove list is stable across renders and matches what a reader
 * expects (the host's ordering is creation order). A copy is returned; the input is never
 * mutated. `zh-Hans-CN` keeps mixed Chinese/Latin bot names in one natural order.
 */
export function sortProposalBots<T extends ProposalBotLike>(bots: readonly T[]): T[] {
  return [...bots].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * The selection a dialog opens with: every suggested member selected, the suggested leader
 * when it is one of them, otherwise the first selected member.
 *
 * Duplicates and empty ids are dropped — the host's suggestion is data, and two rows for one
 * bot would end in a duplicated id being sent to `confirmGroup`.
 */
export function initialProposalSelection(view: ProposalSelectionView): ProposalSelection {
  const memberIds: string[] = []
  for (const id of view.memberIds) {
    if (id === '' || memberIds.includes(id)) continue
    memberIds.push(id)
  }
  const suggested = view.suggestedLeaderId
  const leaderId = suggested !== undefined && memberIds.includes(suggested)
    ? suggested
    : memberIds[0]
  return { memberIds, leaderId }
}

/**
 * Tick or untick one bot.
 *
 * Removing the leader immediately re-points the leader at the first remaining member, so the
 * selection can never hold a leader who is not a member — the dialog never has to repair it
 * later. Removing the last member leaves `leaderId` undefined and the confirm button disabled
 * (`validateProposalSelection` says why).
 */
export function toggleProposalMember(state: ProposalSelection, botId: string): ProposalSelection {
  if (!state.memberIds.includes(botId)) {
    return { memberIds: [...state.memberIds, botId], leaderId: state.leaderId }
  }
  const memberIds = state.memberIds.filter(id => id !== botId)
  const leaderId = state.leaderId !== undefined && state.leaderId !== botId
    ? state.leaderId
    : memberIds[0]
  return { memberIds, leaderId }
}

/**
 * Point the leader at one bot.
 *
 * Only a bot that is currently selected may lead: the extra `memberIds` is the caller's view
 * of the selection (the dialog passes its state's list), kept as a parameter so a caller can
 * validate against the roster it just rendered instead of a possibly stale state object. A
 * refused or no-op change returns the SAME state reference, so a radio click on the current
 * leader does not re-render the dialog.
 */
export function setProposalLeader(
  state: ProposalSelection,
  botId: string,
  memberIds: readonly string[],
): ProposalSelection {
  if (!memberIds.includes(botId)) return state
  if (!state.memberIds.includes(botId)) return state
  if (state.leaderId === botId) return state
  return { memberIds: state.memberIds, leaderId: botId }
}

/**
 * Whether the current selection can be confirmed.
 *
 * `ok:false` always carries a reason the dialog paints under the member list and uses as the
 * confirm button's title — a disabled button with no explanation is the same dead end the
 * host's own refusal used to be.
 */
export function validateProposalSelection(state: ProposalSelection): ProposalValidation {
  const selected = new Set(state.memberIds)
  if (selected.size < MIN_PROPOSAL_MEMBERS) {
    return { ok: false, reason: `至少选择 ${MIN_PROPOSAL_MEMBERS} 个成员才能建群。` }
  }
  if (state.leaderId === undefined || !selected.has(state.leaderId)) {
    return { ok: false, reason: '请选择一位负责人，且负责人必须是已选成员。' }
  }
  return { ok: true }
}
