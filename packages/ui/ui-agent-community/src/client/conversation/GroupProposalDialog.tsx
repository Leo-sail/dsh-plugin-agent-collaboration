/**
 * GroupProposalDialog — the §5.4 confirmation surface for "shall we do this as a
 * group?".
 *
 * Everything the dialog *decides* is a pure function exported from this module
 * (`buildProposalView`, `shouldPromptProposal`, `applyProposalDecision`,
 * `proposalNavigation`), and the React component below is a thin shell over them.
 * That split is deliberate: the acceptance harness has no DOM (this workspace ships
 * no DOM implementation and the task forbids new dependencies), so the decisions are
 * asserted directly while the render is asserted through SSR of the real component.
 *
 * The component owns no data: CommunityPage asks the host for a proposal after a DM
 * message and passes it in. See the wiring notes there.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from './NativeDialog.tsx'
import { css } from '../styles.ts'
import type { BotRoom, ConfirmGroupRequest, GroupProposal } from '@dsh-plugin/agent-community'
import {
  PROPOSAL_CONFIRM, PROPOSAL_CONFIRMING, PROPOSAL_DECLINE, PROPOSAL_LEADER,
  PROPOSAL_MEMBERS_LABEL, PROPOSAL_NAME_LABEL, PROPOSAL_NO_DESCRIPTION,
  PROPOSAL_NO_MEMBERS, PROPOSAL_REASON_LABEL, PROPOSAL_TITLE, proposalTimeoutHint,
} from './nativeStrings.ts'

/**
 * How long the dialog waits for an answer before it counts as a decline (§5.4
 * 超时降级). Two minutes is long enough that a user reading the reason is never
 * interrupted mid-decision, and short enough that a proposal cannot sit on screen
 * for the rest of the session.
 */
export const PROPOSAL_TIMEOUT_MS = 120_000

/** Live conversation-phase directory entry. `description` is the bot's role, per §5.4. */
export interface ProposalBot {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly avatarSeed?: string | undefined
}

export interface ProposalMember {
  readonly id: string
  readonly name: string
  /** Role description (`bot.description`); empty when the bot has none. */
  readonly description: string
  /** The bot that would lead the new group. */
  readonly isLeader: boolean
  readonly avatarSeed?: string | undefined
}

export interface ProposalView {
  readonly name: string
  readonly reason: string
  readonly members: readonly ProposalMember[]
  /** Member ids the confirm should send — i.e. the SURVIVING members, in host order. */
  readonly memberIds: readonly string[]
}

/**
 * Turn a host proposal into exactly what the dialog shows.
 *
 * The roster is rebuilt from the live directory rather than trusted from the
 * proposal (§5.4): a bot deleted between proposal and dialog must not be offered, and
 * must not be sent to `confirmGroup` either. Deduplicating at the same time keeps one
 * row per member even if the host ever repeats an id.
 */
export function buildProposalView(
  proposal: Pick<GroupProposal, 'suggestedName' | 'suggestedMemberIds' | 'suggestedLeaderId' | 'reason'>,
  bots: readonly ProposalBot[],
): ProposalView {
  const directory = new Map(bots.map(b => [b.id, b]))
  const seen = new Set<string>()
  const members: ProposalMember[] = []
  for (const id of proposal.suggestedMemberIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const bot = directory.get(id)
    if (bot === undefined) continue
    members.push({
      id: bot.id,
      name: bot.name,
      description: bot.description ?? '',
      isLeader: bot.id === proposal.suggestedLeaderId,
      ...(bot.avatarSeed !== undefined ? { avatarSeed: bot.avatarSeed } : {}),
    })
  }
  return {
    name: proposal.suggestedName,
    reason: proposal.reason,
    members,
    memberIds: members.map(m => m.id),
  }
}

export interface ProposalGateInput {
  readonly proposal: GroupProposal | undefined
  readonly roomId: string
  readonly messageId: string
  /** Rooms where the user already chose 我自己做 — no second modal this session. */
  readonly soloRooms: ReadonlySet<string>
  /** Proposals already answered, keyed by the message they came from. */
  readonly answeredMessages: ReadonlySet<string>
}

/**
 * Decide whether a host answer is worth interrupting the user for.
 *
 * The gate exists because the host may hand back a proposal for every candidate
 * message; without it the dialog would behave like a recurring nag. Declining once
 * is taken as "keep working the way we are" for that room, and the user can still
 * create a group by hand from the sidebar.
 */
export function shouldPromptProposal(input: ProposalGateInput): boolean {
  if (input.proposal === undefined) return false
  if (input.soloRooms.has(input.roomId)) return false
  if (input.answeredMessages.has(input.messageId)) return false
  // A one-member "group" is the DM the user is already looking at.
  return input.proposal.suggestedMemberIds.length >= 2
}

export type ProposalDecision =
  | { readonly kind: 'joined'; readonly room: BotRoom }
  | { readonly kind: 'stayed'; readonly reason: 'declined' | 'timeout' }

export interface ProposalNavigation {
  readonly tab: 'bots' | 'rooms'
  readonly selectedId: string
}

/**
 * Where the page lands after the user answered (§5.4): confirming opens the NEW
 * group room, declining (or timing out) leaves the reader in the DM they were in.
 */
export function proposalNavigation(decision: ProposalDecision, sourceRoomId: string): ProposalNavigation {
  return decision.kind === 'joined'
    ? { tab: 'rooms', selectedId: decision.room.id }
    : { tab: 'bots', selectedId: sourceRoomId }
}

export interface ProposalDecisionDeps {
  confirmGroup(input: ConfirmGroupRequest): Promise<BotRoom>
  declineGroup(input: { proposalId: string }): Promise<void>
}

export type ProposalChoice =
  | {
    readonly choice: 'collaborate'
    readonly proposalId: string
    /** The (possibly edited) group name. */
    readonly name: string
    readonly memberIds: readonly string[]
  }
  | { readonly choice: 'solo'; readonly proposalId: string; readonly cause: 'user' | 'timeout' }

/**
 * Perform the user's choice against the host, and report what happened.
 *
 * This is the single path from "user decided" to "RPC called", so both buttons and
 * the timeout go through it — there is no second code path that could forget to
 * acknowledge a decline.
 */
export async function applyProposalDecision(
  choice: ProposalChoice,
  deps: ProposalDecisionDeps,
): Promise<ProposalDecision> {
  if (choice.choice === 'collaborate') {
    const name = choice.name.trim()
    const room = await deps.confirmGroup({
      proposalId: choice.proposalId,
      memberIds: choice.memberIds,
      // An emptied name field must not create an unnamed room: the host's default
      // name is better than a blank one.
      ...(name !== '' ? { name } : {}),
    })
    return { kind: 'joined', room }
  }
  await deps.declineGroup({ proposalId: choice.proposalId })
  return { kind: 'stayed', reason: choice.cause === 'timeout' ? 'timeout' : 'declined' }
}

export interface GroupProposalDialogProps {
  proposal: GroupProposal
  /** Live directory; member rows and their role descriptions come from here. */
  bots: readonly ProposalBot[]
  /** Overridable for tests; defaults to {@link PROPOSAL_TIMEOUT_MS}. */
  timeoutMs?: number | undefined
  onConfirm(input: ConfirmGroupRequest): Promise<BotRoom>
  onDecline(proposalId: string): Promise<void>
  /** Fired after a successful confirm, with the room to navigate to. */
  onConfirmed(room: BotRoom): void
  /** Fired after a decline, whichever way it was triggered. */
  onDeclined(proposalId: string, cause: 'user' | 'timeout'): void
}

export function GroupProposalDialog({
  proposal, bots, timeoutMs = PROPOSAL_TIMEOUT_MS, onConfirm, onDecline, onConfirmed, onDeclined,
}: GroupProposalDialogProps) {
  const view = buildProposalView(proposal, bots)
  const [name, setName] = useState(view.name)
  const [pending, setPending] = useState<'collaborate' | 'solo' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [remainingMs, setRemainingMs] = useState(timeoutMs)

  // Latest props/state behind a ref. CommunityPage re-renders on every snapshot poll
  // (400ms while a run is live), and a timer effect that depended on those values
  // would be re-armed on each render — pushing the deadline out forever.
  const latest = useRef({ view, name, timeoutMs, onConfirm, onDecline, onConfirmed, onDeclined })
  useEffect(() => {
    latest.current = { view, name, timeoutMs, onConfirm, onDecline, onConfirmed, onDeclined }
  })

  // One settle per dialog instance: a click that races the timeout must not run both
  // paths (which would decline a proposal that was just confirmed).
  const settled = useRef(false)
  const settle = useCallback(async (choice: 'collaborate' | 'solo', cause: 'user' | 'timeout'): Promise<void> => {
    if (settled.current) return
    settled.current = true
    const l = latest.current
    setPending(choice)
    setError(undefined)
    try {
      const decision = await applyProposalDecision(
        choice === 'collaborate'
          ? { choice: 'collaborate', proposalId: proposal.id, name: l.name, memberIds: l.view.memberIds }
          : { choice: 'solo', proposalId: proposal.id, cause },
        { confirmGroup: l.onConfirm, declineGroup: input => l.onDecline(input.proposalId) },
      )
      if (decision.kind === 'joined') l.onConfirmed(decision.room)
      else l.onDeclined(proposal.id, decision.reason === 'timeout' ? 'timeout' : 'user')
    } catch (e) {
      // A failed RPC must not trap the user in a modal they cannot close: reopen the
      // decision, show why, and let them try again or pick 我自己做.
      settled.current = false
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(undefined)
    }
  }, [proposal.id])

  // §5.4 timeout degradation. The dialog's own deadline only stops it from asking;
  // it never blocks the bot, which is already working on the message that produced
  // the proposal — "未响应将自行完成" is literally what happens.
  useEffect(() => {
    if (timeoutMs <= 0) { void settle('solo', 'timeout'); return }
    const startedAt = Date.now()
    setRemainingMs(timeoutMs)
    const tick = window.setInterval(() => {
      const left = timeoutMs - (Date.now() - startedAt)
      setRemainingMs(Math.max(0, left))
      if (left <= 0) {
        window.clearInterval(tick)
        void settle('solo', 'timeout')
      }
    }, 500)
    return () => window.clearInterval(tick)
  }, [proposal.id, timeoutMs, settle])

  // Escape is the keyboard form of 我自己做, matching how the native approval panel
  // treats Escape (dismiss = the non-committal answer, never the destructive one).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void settle('solo', 'user') }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settle])

  const busy = pending !== undefined
  const seconds = Math.ceil(remainingMs / 1000)

  return (
    // Native chrome: the primitive Modal owns the mask, Escape, focus and elevation, so this
    // dialog no longer draws its own overlay (it used to, and looked nothing like DSH beside
    // the other dialogs).
    <NativeDialog
      open
      onClose={() => { void settle('solo', 'user') }}
      title={PROPOSAL_TITLE}
      closeLabel={PROPOSAL_DECLINE}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" disabled={busy} onClick={() => { void settle('solo', 'user') }}>
            {PROPOSAL_DECLINE}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => { void settle('collaborate', 'user') }}>
            {pending === 'collaborate' ? PROPOSAL_CONFIRMING : PROPOSAL_CONFIRM}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div className="ac-proposal-block">
          <span className="ac-proposal-field-label">{PROPOSAL_REASON_LABEL}</span>
          <p className="ac-proposal-reason">{view.reason}</p>
        </div>

        <div className={css.field}>
          <span className={css.fieldLabel}>{PROPOSAL_NAME_LABEL}</span>
          <Input className={css.textInput} type="text" value={name} disabled={busy} onChange={e => setName(e.target.value)} />
        </div>

        <div className="ac-proposal-block">
          <span className="ac-proposal-field-label">{PROPOSAL_MEMBERS_LABEL}（{view.members.length}）</span>
          {view.members.length === 0
            ? <p className="ac-proposal-empty">{PROPOSAL_NO_MEMBERS}</p>
            : (
              <ul className="ac-proposal-members">
                {view.members.map(m => (
                  <li key={m.id} className="ac-proposal-member" data-role={m.isLeader ? 'leader' : 'member'}>
                    <span className="ac-proposal-member-avatar" aria-hidden="true">{m.avatarSeed ?? '🤖'}</span>
                    <span className="ac-proposal-member-text">
                      <span className="ac-proposal-member-name">
                        {m.name}
                        {m.isLeader && <span className="ac-proposal-leader">{PROPOSAL_LEADER}</span>}
                      </span>
                      <span className="ac-proposal-member-desc">
                        {m.description !== '' ? m.description : PROPOSAL_NO_DESCRIPTION}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </div>

        {error !== undefined && <p className="ac-proposal-error">{error}</p>}

        <p className="ac-proposal-timeout">{proposalTimeoutHint(seconds)}</p>
      </div>
    </NativeDialog>
  )
}
