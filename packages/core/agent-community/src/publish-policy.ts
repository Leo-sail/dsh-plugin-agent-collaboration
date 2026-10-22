/**
 * Publish policy: which finished runs speak in the room, and what exactly they say.
 *
 * WHY THIS MODULE EXISTS
 * The room's transcript is built from the ledger, and every settled run used to write to
 * it — including turns the user never asked for. The user saw the result as "the bot
 * answered twice": the leader's dispatch turn plus its integrate turn, or a member's own
 * answer plus the reply it sent the leader. Two independent fixes are needed and this is
 * the shared decision both read:
 *
 *   · `shouldPublishRun` — may THIS run's turn be rendered at all? A run whose `publish`
 *     is `internal` exists to move work between bots (the leader's integrate turn, a
 *     report delivery); its rows are coordination, not conversation.
 *   · `chooseFinalDelivery` — of the text a run produced (`replyText`) and the report it
 *     handed to the user through `finish_task` (`finishReport`), what is the ONE message
 *     the room gets?
 *
 * THE USER'S DECISION THIS ENCODES (2026-10, decision 2)
 * A member's own output stays visible — the user wants to see who did what. What must not
 * be visible is the leader's integration turn restating it, and the same delivery written
 * twice (once by `finish_task`, once by the turn's own reply). So: visible runs publish
 * their reply; internal runs publish nothing unless they carry a finish report; and a
 * report is only used when the run itself produced no text to deliver.
 *
 * Deliberately dependency-free: the projection, the driver and `settleRun` all import it,
 * and a policy that needs the service to be testable would not be testable at all.
 *
 * @module
 */

/** Whether a run's turn may appear in the room. Absent means `visible` (historical behaviour). */
export type RunPublish = 'visible' | 'internal'

/** The default for a run that carries no explicit flag: a normal answer is visible. */
export const DEFAULT_RUN_PUBLISH: RunPublish = 'visible'

/** The only field this module reads from a run. */
export interface PublishableRun {
  readonly publish?: RunPublish | undefined
}

/** The text a settled run should deliver, and whether it should be delivered at all. */
export interface FinalDelivery {
  /** The one body the room gets. Empty when `publishFinal` is false. */
  readonly text: string
  /** True when this run owes the room a message. */
  readonly publishFinal: boolean
}

export interface FinalDeliveryInput {
  /** What the turn itself wrote. Empty/whitespace-only means "the turn produced no text". */
  readonly replyText?: string | undefined
  /** The `finish_task` report, when this run called it. */
  readonly finishReport?: string | undefined
  /** The run's publish flag; absent keeps the historical visible behaviour. */
  readonly publish?: RunPublish | undefined
}

/**
 * Whether this run may be rendered in the room at all.
 *
 * `internal` is the only thing that turns rendering off: a run with no flag is a normal
 * answer, and an unknown future flag value must never silently silence a bot — that
 * would be a worse failure than one extra row.
 */
export function shouldPublishRun(run: PublishableRun | undefined): boolean {
  return run?.publish !== 'internal'
}

/** The run's publish mode as a value, for the ledger projection's per-run gate. */
export function publishOf(run: PublishableRun | undefined): RunPublish {
  return shouldPublishRun(run) ? 'visible' : 'internal'
}

/** True when the string carries something a user could read. */
const hasText = (text: string | undefined): text is string =>
  text !== undefined && text.trim() !== ''

/**
 * Pick the ONE message a settled run delivers, or none.
 *
 * The two sources are mutually exclusive here — that is the whole point. Their precedence:
 *
 *   · internal run, finish report  → the report (a leader that finished a task owes the
 *     user the result even though its turn was coordination);
 *   · internal run, no report      → nothing (the integrate turn's prose is a restatement
 *     of what the members already said in the room);
 *   · visible run, reply text      → the reply;
 *   · visible run, no reply        → the finish report (a turn that only called
 *     `finish_task` would otherwise deliver nothing);
 *   · neither source               → nothing.
 *
 * When a visible run produced BOTH, the reply wins and the report is NOT delivered again:
 * they describe the same delivery, and publishing both is the exact duplicate this module
 * exists to prevent.
 */
export function chooseFinalDelivery(input: FinalDeliveryInput): FinalDelivery {
  const reply = input.replyText
  const report = input.finishReport
  // Same rule as `publishOf`, without building a throwaway object.
  const publishing: RunPublish = input.publish === 'internal' ? 'internal' : DEFAULT_RUN_PUBLISH

  if (publishing === 'internal') {
    return hasText(report)
      ? { text: report, publishFinal: true }
      : { text: '', publishFinal: false }
  }

  if (hasText(reply)) return { text: reply, publishFinal: true }
  if (hasText(report)) return { text: report, publishFinal: true }
  return { text: '', publishFinal: false }
}
