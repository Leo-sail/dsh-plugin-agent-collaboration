/**
 * roundDock — presentation rules for the round status dock (P2-1).
 *
 * WHAT THIS IS FOR
 * The host records a group ROUND (see core `round.ts`) while a multi-bot instruction is in
 * flight and after it settles. This module turns that record into the three things the composer
 * dock needs — whether to show, a one-line summary for the header, and one row per participant —
 * as pure functions, so the dock's rendering rules can be tested without React.
 *
 * STRUCTURAL TYPES ON PURPOSE
 * The client never imports the host's round module (that is server code); the dock only reads the
 * fields it paints, so it declares the subset here. A full `RoundState` from the snapshot is
 * assignable to {@link RoundDockState} without a cast.
 *
 * WHAT THE USER SHOULD SEE
 *   · while the batch runs: who is working, who is queued, who already answered or skipped;
 *   · after it settles: the same list as the receipt for this instruction (until the next
 *     instruction opens a new round);
 *   · never for an interrupted/superseded round: it describes work that no longer belongs to the
 *     conversation, and the transcript already has its grey "本轮被打断" row.
 */

/** One participant, as the dock paints it (names come from the caller's bot directory). */
export type RoundDockParticipantStatus = 'queued' | 'running' | 'done' | 'failed' | 'pass'

export interface RoundDockParticipant {
  readonly botId: string
  readonly status: RoundDockParticipantStatus
}

/** The subset of the host's RoundState the dock renders. */
export interface RoundDockState {
  readonly status: 'open' | 'settled' | 'interrupted'
  readonly mode: 'ordered' | 'parallel'
  readonly participants: readonly RoundDockParticipant[]
}

/** One rendered participant row: stable key, display name, raw status and its Chinese label. */
export interface RoundDockRow {
  readonly key: string
  readonly name: string
  readonly status: RoundDockParticipantStatus
  readonly label: string
}

const STATUS_LABEL: Readonly<Record<RoundDockParticipantStatus, string>> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '未完成',
  pass: '已跳过',
}

/** The label for one participant status (`进行中` etc.). */
export function roundParticipantLabel(status: RoundDockParticipantStatus): string {
  return STATUS_LABEL[status] ?? status
}

/**
 * Whether the dock should paint a round section at all.
 *
 * An interrupted/superseded round is hidden; a round with no participants is meaningless; a
 * settled round stays visible as the receipt of the instruction that just finished.
 */
export function shouldShowRoundDock(round: RoundDockState | undefined): boolean {
  if (round === undefined) return false
  if (round.status === 'interrupted') return false
  return round.participants.length > 0
}

/**
 * The header summary: how many are still working / done / skipped, in one short line.
 *
 * Running and queued are counted as "in flight" because to the user they are the same promise
 * ("someone is still on it"). The line always starts with 本轮 so it cannot be confused with the
 * task board's counts in the same dock.
 */
export function summarizeRound(round: RoundDockState): string {
  const total = round.participants.length
  if (total === 0) return ''
  let running = 0
  let done = 0
  let failed = 0
  let pass = 0
  for (const participant of round.participants) {
    if (participant.status === 'running' || participant.status === 'queued') running += 1
    else if (participant.status === 'done') done += 1
    else if (participant.status === 'pass') pass += 1
    else failed += 1
  }
  const parts = [`本轮 ${done}/${total} 完成`]
  if (running > 0) parts.push(`${running} 进行中`)
  if (pass > 0) parts.push(`${pass} 跳过`)
  if (failed > 0) parts.push(`${failed} 未完成`)
  if (round.status === 'settled') parts.push('已收口')
  return parts.join(' · ')
}

/**
 * One row per participant, in participant order.
 *
 * `nameOf` is the caller's bot-directory lookup; an unknown id renders as the raw id, because a
 * participant whose bot was deleted must still be visible (and explained) rather than silently
 * dropped from the round.
 */
export function roundDockRows(
  round: RoundDockState,
  nameOf: (botId: string) => string,
): RoundDockRow[] {
  return round.participants.map(participant => ({
    key: participant.botId,
    name: nameOf(participant.botId),
    status: participant.status,
    label: roundParticipantLabel(participant.status),
  }))
}
