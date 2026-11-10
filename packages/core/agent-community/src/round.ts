/**
 * round.ts — the explicit state machine behind ONE group-chat round (P2-1).
 *
 * WHY A STATE MACHINE. Today the "who is still working, and when may the leader speak again"
 * decision is implicit: `group-task.onMemberFinished` inspects a live `runningBotIds` Set and
 * integrates when it is empty, `afterRunSettled` re-enters the driver on every run, and
 * `index.ts` creates runs before any of that exists. Three components therefore each hold a
 * part of one fact, and the fact is not durable. Measured consequences upstream: the leader is
 * woken once per member instead of once per fan-out, a PASS produces an extra integration turn,
 * and a user message arriving mid-fan-out races the previous batch.
 *
 * This module makes that fact explicit and PURE: one immutable `RoundState` value describes a
 * batch (`batchId`) of participants, and every transition returns a new value plus what the
 * caller must do next. There is no IO, no Cordis service and no `Date.now()` — every timestamp
 * is an explicit `at`/`createdAt` argument. That is what lets the migration table in
 * the round transitions run without a host, and what lets `index.ts` persist the state verbatim
 * (`room.taskState`) and restore it after a restart (`parseRoundState`).
 *
 * THE CONTRACT THE HOST RELIES ON
 *   · one round settles ONCE (`settleParticipant`/`noteStarted`/`interruptRound` after close are
 *     no-ops that return the same value and `changed:false`);
 *   · a participant settles once (a duplicate settle is `already-settled`, never a second done);
 *   · parallel: every queued participant may start at the same time; ordered: exactly one
 *     runner and only the queue head may start (`nextOrdered`);
 *   · all terminal → the round settles automatically (`done`/`failed`/`pass` are all terminal,
 *     so a failed member never blocks the batch — failures are reported, not fatal);
 *   · `claimLeaderWake` is the single idempotent "wake the leader" gate: it fires exactly once
 *     for a settled round, never for an interrupted round, and never when every participant
 *     PASSed (PASS means "nothing to add", so waking the leader would produce a duplicate
 *     answer — `[PASS]` must be silent);
 *   · a user message that supersedes the round closes it (`interruptRound('superseded')`) and
 *     nothing from the old batch may start afterwards.
 *
 * @module
 */

/** How the participants of one round are scheduled. */
export type RoundMode = 'ordered' | 'parallel'

/**
 * One participant's life cycle: it waits (`queued`), is handed a run (`running`), and then
 * lands in exactly one terminal state. `pass` is a terminal reply, not a scheduling state: a
 * participant that answered `[PASS]` did its turn and has nothing to add to the leader's
 * integration.
 */
export type RoundParticipantStatus = 'queued' | 'running' | 'done' | 'failed' | 'pass'

/** The round's own life cycle. It is `open` until it settles or is interrupted, once. */
export type RoundStatus = 'open' | 'settled' | 'interrupted'

/** One participant of the round. `runId` is the run that carries its turn, when one exists. */
export interface RoundParticipant {
  readonly botId: string
  readonly status: RoundParticipantStatus
  readonly runId?: string | undefined
}

/**
 * ONE group-chat round, immutable.
 *
 * `batchId` is the group of work the user's instruction created (the runs enqueued for that
 * message share it); `id` is this round's own identity, so a room that is interrupted and
 * re-asked has two distinct rounds and the old batch's late settlements cannot bleed into the
 * new one.
 */
export interface RoundState {
  readonly id: string
  readonly roomId: string
  readonly batchId: string
  readonly instruction: string
  readonly mode: RoundMode
  readonly status: RoundStatus
  readonly participants: readonly RoundParticipant[]
  readonly createdAt: string
  readonly settledAt?: string | undefined
  readonly closeReason?: 'all-settled' | 'interrupted' | 'superseded' | undefined
  /** 统一唤醒 leader 的幂等标记：非空 = 已经唤醒过。 */
  readonly leaderWokenAt?: string | undefined
}

/** A name-grouped view of the participants, for the dock/status line. */
export interface RoundSummary {
  readonly running: readonly string[]
  readonly queued: readonly string[]
  readonly done: readonly string[]
  readonly failed: readonly string[]
  readonly pass: readonly string[]
  readonly total: number
  readonly settled: boolean
}

/** `done`/`failed`/`pass` are all terminal: none of them is still on the board. */
export function isTerminalParticipantStatus(status: RoundParticipantStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'pass'
}

/**
 * True when the room's leader is itself a participant of this round.
 *
 * A parallel round triggered by `@all` includes the leader as one of the answering members.
 * The leader has already spoken in that round, so the once-only integration wake would only
 * produce a duplicate summary of the same replies (measured 2026-11-10: an @all greeting got
 * three replies, a re-dispatch and a final summary).
 */
export function leaderIsParticipant(round: RoundState, leaderId: string | undefined): boolean {
  if (leaderId === undefined) return false
  return round.participants.some(participant => participant.botId === leaderId)
}

/** A settled or interrupted round does not accept any further transition. */
export function isRoundClosed(round: RoundState): boolean {
  return round.status !== 'open'
}

/** The first terminal-state participant group is not enough: every participant is terminal. */
function allTerminal(round: RoundState): boolean {
  return round.participants.every(participant => isTerminalParticipantStatus(participant.status))
}

/** True when every participant replied `[PASS]` (an empty round counts as "nothing to say"). */
function allPassed(round: RoundState): boolean {
  return round.participants.every(participant => participant.status === 'pass')
}

/** Immutably replace one participant's record. The input round and its array are untouched. */
function replaceParticipant(round: RoundState, botId: string, next: RoundParticipant): RoundState {
  return {
    ...round,
    participants: round.participants.map(participant => (participant.botId === botId ? next : participant)),
  }
}

/**
 * Settle the round once the last participant lands.
 *
 * PURE and idempotent: a round that is already closed is returned as-is. This is the ONLY
 * place that writes `all-settled`, so the last settlement of a fan-out is the one that closes
 * it, exactly once — no caller has to check "was this the last one?" itself.
 */
function settleWhenComplete(round: RoundState, at: string): RoundState {
  if (round.status !== 'open' || !allTerminal(round)) return round
  return { ...round, status: 'settled', settledAt: at, closeReason: 'all-settled' }
}

/**
 * Start a round.
 *
 * Participants are de-duplicated while keeping the caller's order (a router that names the same
 * bot twice must not create two rows for it). An EMPTY participant list is already settled: there
 * is nothing to wait for, and the caller can go straight to `claimLeaderWake` (which stays silent
 * for it — an empty batch has nothing to integrate).
 */
export function createRound(input: {
  readonly id: string
  readonly roomId: string
  readonly instruction: string
  readonly mode: RoundMode
  readonly participants: readonly string[]
  readonly createdAt: string
  readonly batchId?: string | undefined
}): RoundState {
  const seen = new Set<string>()
  const participants: RoundParticipant[] = []
  for (const botId of input.participants) {
    if (seen.has(botId)) continue
    seen.add(botId)
    participants.push({ botId, status: 'queued' })
  }
  const batchId = input.batchId ?? input.id
  if (participants.length === 0) {
    return {
      id: input.id,
      roomId: input.roomId,
      batchId,
      instruction: input.instruction,
      mode: input.mode,
      status: 'settled',
      participants,
      createdAt: input.createdAt,
      settledAt: input.createdAt,
      closeReason: 'all-settled',
    }
  }
  return {
    id: input.id,
    roomId: input.roomId,
    batchId,
    instruction: input.instruction,
    mode: input.mode,
    status: 'open',
    participants,
    createdAt: input.createdAt,
  }
}

/** One participant's record, or undefined when the round does not contain that bot. */
export function participantOf(round: RoundState, botId: string): RoundParticipant | undefined {
  return round.participants.find(participant => participant.botId === botId)
}

/**
 * Is this reply a PASS — i.e. the member did its turn and has nothing to add?
 *
 * Accepted: `[PASS]` / `PASS`, after trimming and case-insensitively (`" pass "`, `"[Pass]"`).
 * A sentence that merely mentions PASS is NOT a pass: the marker is the whole reply, exactly as
 * the round prompt asks for it. Keeping this strict is what stops "PASS 上面那条" from being
 * swallowed silently.
 */
export function isPassReply(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return normalized === 'pass' || normalized === '[pass]'
}

/**
 * The next participant an ORDERED round may start, or undefined when nothing may start now.
 *
 * Undefined covers all three "not now" cases so a caller never has to re-derive them: the round
 * is closed, someone is still running (ordered is strictly one at a time), or no queued
 * participant is left. Parallel rounds delegate scheduling to the caller and never have a
 * "next" — every queued participant is startable immediately.
 */
export function nextOrdered(round: RoundState): string | undefined {
  if (round.mode !== 'ordered' || isRoundClosed(round)) return undefined
  if (round.participants.some(participant => participant.status === 'running')) return undefined
  const head = round.participants.find(participant => participant.status === 'queued')
  return head?.botId
}

/**
 * Mark one participant as running.
 *
 * Refusals are explicit so the host can record WHY nothing started:
 *   · `closed` — the round settled/interrupted; nothing from this batch may start;
 *   · `unknown-bot` — the bot is not a participant of this round;
 *   · `already-started` — a participant gets exactly one start (running or terminal are both
 *     "started"); settling a queued participant directly is allowed and never comes through here;
 *   · `not-next` — ordered mode and this bot is not the queue head (or someone is still running).
 *
 * A refused call returns the ORIGINAL round value (reference equality), so a caller that stores
 * whatever comes back cannot accidentally write an equal-but-new state.
 */
export function noteStarted(round: RoundState, botId: string, runId?: string | undefined): {
  readonly round: RoundState
  readonly changed: boolean
  readonly refused?: 'closed' | 'unknown-bot' | 'already-started' | 'not-next' | undefined
} {
  if (isRoundClosed(round)) return { round, changed: false, refused: 'closed' }
  const participant = participantOf(round, botId)
  if (participant === undefined) return { round, changed: false, refused: 'unknown-bot' }
  if (participant.status !== 'queued') return { round, changed: false, refused: 'already-started' }
  if (round.mode === 'ordered' && nextOrdered(round) !== botId) {
    return { round, changed: false, refused: 'not-next' }
  }
  const nextRunId = runId ?? participant.runId
  const running: RoundParticipant = {
    botId: participant.botId,
    status: 'running',
    ...(nextRunId !== undefined ? { runId: nextRunId } : {}),
  }
  return { round: replaceParticipant(round, botId, running), changed: true }
}

/**
 * Land one participant: `done`, `failed` or `pass` (a `[PASS]` reply is terminal immediately).
 *
 * `queued` is accepted as a start state too — a run that could not be enqueued, or a member
 * removed while queued, still has to be able to land; there is deliberately no `not-started`
 * refusal. `at` is the settlement clock and becomes the round's `settledAt` when this is the
 * last landing.
 *
 * Returns `next` for an ordered round that is still open after this landing: the queue head the
 * caller should start (the caller decides whether it actually starts it — the function is pure).
 * Parallel rounds never return `next`.
 */
export function settleParticipant(round: RoundState, botId: string, outcome: 'done' | 'failed' | 'pass', at: string, runId?: string | undefined): {
  readonly round: RoundState
  readonly changed: boolean
  readonly ignored?: 'closed' | 'unknown-bot' | 'already-settled' | undefined
  /** ordered 模式下，本结算后应启动的下一个 bot（调用方决定是否真的启动）。 */
  readonly next?: string | undefined
} {
  if (isRoundClosed(round)) return { round, changed: false, ignored: 'closed' }
  const participant = participantOf(round, botId)
  if (participant === undefined) return { round, changed: false, ignored: 'unknown-bot' }
  if (isTerminalParticipantStatus(participant.status)) {
    return { round, changed: false, ignored: 'already-settled' }
  }
  const nextRunId = runId ?? participant.runId
  const landed: RoundParticipant = {
    botId: participant.botId,
    status: outcome,
    ...(nextRunId !== undefined ? { runId: nextRunId } : {}),
  }
  const settled = settleWhenComplete(replaceParticipant(round, botId, landed), at)
  const next = settled.mode === 'ordered' && settled.status === 'open' ? nextOrdered(settled) : undefined
  return {
    round: settled,
    changed: true,
    ...(next !== undefined ? { next } : {}),
  }
}

/**
 * The round's settlement view: who is still outstanding, how the landings split, and whether
 * the batch is over.
 *
 * `waiting` lists bot ids that are still queued or running. `failed` counts as settled
 * (failed members must not block the batch), and `allPassed` is the PASS-silence flag — an
 * empty round is vacuously all-passed, so nothing wakes the leader for a batch nobody received.
 * `state` prefers the persisted status (an interrupted round stays `interrupted` even if every
 * participant landed); an open round that nonetheless has every participant terminal is
 * reported `settled` — the view never claims work is outstanding that is not.
 */
export function roundSettlement(round: RoundState): {
  readonly state: 'waiting' | 'settled' | 'interrupted'
  readonly waiting: readonly string[]
  readonly done: number
  readonly failed: number
  readonly passed: number
  readonly allPassed: boolean
} {
  const waiting = round.participants
    .filter(participant => !isTerminalParticipantStatus(participant.status))
    .map(participant => participant.botId)
  const count = (status: RoundParticipantStatus): number =>
    round.participants.filter(participant => participant.status === status).length
  const state = round.status === 'interrupted'
    ? 'interrupted'
    : round.status === 'settled' || waiting.length === 0
      ? 'settled'
      : 'waiting'
  return {
    state,
    waiting,
    done: count('done'),
    failed: count('failed'),
    passed: count('pass'),
    allPassed: allPassed(round),
  }
}

/**
 * Close an open round because it can no longer be served: the user sent a new instruction
 * (`superseded`) or the turn was cancelled (`interrupted`).
 *
 * Idempotent by design: a settled round is not interrupted (it already closed once), and a
 * second interrupt changes nothing. Participants are left exactly as they were — a run that is
 * still executing is the settle path's business, not the close path's; closing only makes sure
 * its late settle is ignored.
 */
export function interruptRound(round: RoundState, reason: 'interrupted' | 'superseded', at: string): { readonly round: RoundState; readonly changed: boolean } {
  if (isRoundClosed(round)) return { round, changed: false }
  return {
    round: { ...round, status: 'interrupted', settledAt: at, closeReason: reason },
    changed: true,
  }
}

/**
 * The single, idempotent "may the leader be woken for this round?" gate.
 *
 * Exactly one caller may act on `wake:true`; the write of `leaderWokenAt` happens in the same
 * pure transition, so the second caller (a duplicate settle arriving late, a retried host
 * callback) receives `already-woken` and does nothing. PASS-only rounds never wake: every
 * member answered "nothing to add", so an integration turn would be a duplicate model call for
 * an empty report. Interrupted rounds never wake: they were closed because no integration is
 * wanted.
 */
export function claimLeaderWake(round: RoundState, at: string): { readonly round: RoundState; readonly wake: boolean; readonly reason: 'not-settled' | 'all-passed' | 'already-woken' | undefined } {
  if (round.status !== 'settled') return { round, wake: false, reason: 'not-settled' }
  if (allPassed(round)) return { round, wake: false, reason: 'all-passed' }
  if (round.leaderWokenAt !== undefined) return { round, wake: false, reason: 'already-woken' }
  return { round: { ...round, leaderWokenAt: at }, wake: true, reason: undefined }
}

/**
 * Name-grouped participant lists for the dock.
 *
 * Names come from `nameOf`, so this module owns no bot directory. `settled` means "this round
 * is closed" (settled OR interrupted): the dock must never render an interrupted batch as still
 * waiting for someone to land.
 */
export function roundSummary(round: RoundState, nameOf: (botId: string) => string): RoundSummary {
  const names = (status: RoundParticipantStatus): readonly string[] =>
    round.participants
      .filter(participant => participant.status === status)
      .map(participant => nameOf(participant.botId))
  return {
    running: names('running'),
    queued: names('queued'),
    done: names('done'),
    failed: names('failed'),
    pass: names('pass'),
    total: round.participants.length,
    settled: isRoundClosed(round),
  }
}

/**
 * One human line for the room header / task dock:
 * `本轮：A、B 进行中；C 已完成；D 已跳过`.
 *
 * Groups are rendered in life-cycle order (running, queued, done, failed, pass) and empty
 * groups are omitted, so the paragraph only says what actually happened. An empty round has
 * nothing to say and returns undefined (the dock keeps its previous line instead of printing
 * a bare `本轮：`).
 */
export function roundStatusLine(round: RoundState, nameOf: (botId: string) => string): string | undefined {
  if (round.participants.length === 0) return undefined
  const segments: string[] = []
  const append = (status: RoundParticipantStatus, label: string): void => {
    const ids = round.participants
      .filter(participant => participant.status === status)
      .map(participant => nameOf(participant.botId))
    if (ids.length === 0) return
    segments.push(`${ids.join('、')} ${label}`)
  }
  append('running', '进行中')
  append('queued', '排队中')
  append('done', '已完成')
  append('failed', '已失败')
  append('pass', '已跳过')
  return segments.length === 0 ? undefined : `本轮：${segments.join('；')}`
}

/** A plain object (not null, not an array): the only shape persisted JSON may be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string id — `''` is a corrupt id, not an id. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isRoundMode(value: unknown): value is RoundMode {
  return value === 'ordered' || value === 'parallel'
}

function isRoundStatus(value: unknown): value is RoundStatus {
  return value === 'open' || value === 'settled' || value === 'interrupted'
}

function isParticipantStatus(value: unknown): value is RoundParticipantStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed' || value === 'pass'
}

function isCloseReason(value: unknown): value is 'all-settled' | 'interrupted' | 'superseded' {
  return value === 'all-settled' || value === 'interrupted' || value === 'superseded'
}

/**
 * Restore a persisted round, tolerantly (migration path).
 *
 * The rules are deliberately asymmetric, matching what a persisted file can contain after a
 * crash or a hand edit:
 *   · the round's identity fields (`id`, `roomId`, `mode`, `createdAt`) and its `participants`
 *     ARRAY must exist and type-check, otherwise the value is not a round → undefined;
 *   · `instruction` must be a string (it may be empty — a user may send an empty message);
 *   · a missing `status` is an old file: the round is treated as `open`; an UNKNOWN status is
 *     corruption and rejects the value (inventing `open` here could resurrect a closed round
 *     and wake the leader for work that already finished);
 *   · `batchId` falls back to `id` when absent/invalid, exactly like `createRound` — a round
 *     written before batch ids existed still routes to the right integration;
 *   · `participants` items are dropped individually when malformed or carrying an unknown
 *     status; duplicate bot ids keep the FIRST occurrence (createRound dedupes the same way,
 *     so a re-parse cannot reorder a batch); a bad `runId` is dropped but the participant stays;
 *   · `settledAt`/`closeReason`/`leaderWokenAt` are kept when they type-check and dropped
 *     otherwise (they are diagnostics/markers, never scheduling inputs);
 *   · unknown extra fields are ignored, so a future writer can add fields without breaking
 *     this reader. No data is ever "guessed": anything that cannot be trusted is left out.
 *
 * The function never mutates `raw`.
 */
export function parseRoundState(raw: unknown): RoundState | undefined {
  if (!isRecord(raw)) return undefined
  const id = raw['id']
  const roomId = raw['roomId']
  const instruction = raw['instruction']
  const createdAt = raw['createdAt']
  const mode = raw['mode']
  if (!isNonEmptyString(id)) return undefined
  if (!isNonEmptyString(roomId)) return undefined
  if (typeof instruction !== 'string') return undefined
  if (!isNonEmptyString(createdAt)) return undefined
  if (!isRoundMode(mode)) return undefined

  const rawStatus = raw['status']
  let status: RoundStatus
  if (rawStatus === undefined) status = 'open'
  else if (isRoundStatus(rawStatus)) status = rawStatus
  else return undefined

  const rawParticipants = raw['participants']
  if (!Array.isArray(rawParticipants)) return undefined
  const seen = new Set<string>()
  const participants: RoundParticipant[] = []
  for (const item of rawParticipants) {
    if (!isRecord(item)) continue
    const botId = item['botId']
    if (!isNonEmptyString(botId) || seen.has(botId)) continue
    const participantStatus = item['status']
    if (!isParticipantStatus(participantStatus)) continue
    seen.add(botId)
    const runId = item['runId']
    participants.push({
      botId,
      status: participantStatus,
      ...(typeof runId === 'string' ? { runId } : {}),
    })
  }

  const rawBatchId = raw['batchId']
  const rawSettledAt = raw['settledAt']
  const rawCloseReason = raw['closeReason']
  const rawLeaderWokenAt = raw['leaderWokenAt']
  return {
    id,
    roomId,
    batchId: isNonEmptyString(rawBatchId) ? rawBatchId : id,
    instruction,
    mode,
    status,
    participants,
    createdAt,
    ...(typeof rawSettledAt === 'string' ? { settledAt: rawSettledAt } : {}),
    ...(isCloseReason(rawCloseReason) ? { closeReason: rawCloseReason } : {}),
    ...(typeof rawLeaderWokenAt === 'string' ? { leaderWokenAt: rawLeaderWokenAt } : {}),
  }
}

/**
 * One run settle, as the host sees it.
 *
 * `status` is the run's terminal status in the host's vocabulary (not a participant status);
 * `replyText` is the model's final text and the ONLY source of the PASS marker; `at` is the
 * settlement clock. `runId` is attached to the participant when the start did not already note it.
 */
export interface RoundSettleInput {
  readonly round: RoundState
  readonly botId: string
  readonly status: 'completed' | 'failed' | 'interrupted' | 'cancelled'
  readonly replyText: string
  readonly at: string
  readonly runId?: string | undefined
}

/**
 * Everything the host must do after ONE settle, decided from one round value.
 *
 * The post-settle questions — did the participant land, was the reply a PASS (suppress the room
 * post/memory/wake), is the round closed now, may the leader be woken — are answered together
 * here, so no caller can answer them inconsistently. `round` is the value to persist: the landed
 * participant, plus `leaderWokenAt` when this settle was the round's one allowed wake.
 */
export interface RoundSettleDecision {
  /** The value to persist; the input reference when nothing changed. */
  readonly round: RoundState
  readonly changed: boolean
  /** The participant's terminal state; undefined when this settle was a no-op. */
  readonly outcome: 'done' | 'failed' | 'pass' | undefined
  /** This settle counted as PASS — the caller must suppress room delivery, memory and wake. */
  readonly pass: boolean
  /** The leader must be woken now for the round's single integration turn. */
  readonly wakeLeader: boolean
  /** Every participant of the resulting round replied PASS — the wake gate stays silent. */
  readonly allPassed: boolean
  /** This call is the one that closed the round (`open` → `settled`). */
  readonly settledNow: boolean
}

/**
 * Decide the round transition for ONE run settle.
 *
 * A no-op covers the three "nothing to do" cases the host cannot distinguish on its own: the
 * round is closed, the bot is not a participant, or this participant already settled (a duplicate
 * or late report). It returns the INPUT round by reference with `outcome: undefined` and
 * `pass: false`, so a caller that stores the result blindly cannot invent a landing or a PASS.
 *
 * The PASS marker only counts for a live participant of an open round: a `[PASS]` reply for a bot
 * outside this round is an ordinary ignored settle, never a silent success.
 *
 * The leader wake happens in the SAME call that closes the round, through `claimLeaderWake`, so it
 * is at most once per round and never for an all-PASS or interrupted round. The claim and the
 * settlement share the settle clock `at`: closing and waking are one decision, not two.
 */
export function decideRoundSettle(input: RoundSettleInput): RoundSettleDecision {
  const { round, botId, status, replyText, at, runId } = input
  const participant = isRoundClosed(round) ? undefined : participantOf(round, botId)
  if (participant === undefined || isTerminalParticipantStatus(participant.status)) {
    return {
      round,
      changed: false,
      outcome: undefined,
      pass: false,
      wakeLeader: false,
      allPassed: roundSettlement(round).allPassed,
      settledNow: false,
    }
  }
  const pass = isPassReply(replyText)
  const outcome: 'done' | 'failed' | 'pass' = pass ? 'pass' : status === 'completed' ? 'done' : 'failed'
  // The guard above rules out every refusal settleParticipant has (closed round, unknown bot,
  // already-settled participant), so this landing is guaranteed to change the round.
  const landed = settleParticipant(round, botId, outcome, at, runId).round
  if (landed.status !== 'settled') {
    return {
      round: landed,
      changed: true,
      outcome,
      pass,
      wakeLeader: false,
      allPassed: roundSettlement(landed).allPassed,
      settledNow: false,
    }
  }
  const woken = claimLeaderWake(landed, at)
  return {
    round: woken.round,
    changed: true,
    outcome,
    pass,
    wakeLeader: woken.wake,
    allPassed: roundSettlement(woken.round).allPassed,
    settledNow: true,
  }
}
