/**
 * run-state.ts — the durable checkpoint of ONE bot run (P3-1).
 *
 * WHY A CHECKPOINT. A run's progress lives only in memory today: the executor's step counter, the
 * approval bridge's pending map, the run budget. A DSH restart therefore loses three facts at
 * once — which approval was still waiting, how far the run got, and which side-effect writes were
 * already delivered but not yet acknowledged. The recovery attempt then either re-runs a finished
 * tool (duplicate side effects) or silently drops the pending approval. This module is the
 * LangGraph-style checkpoint that fixes that: one persisted value that says where the run is,
 * which writes it still owes to the outside world, and which approvals still need a human.
 *
 * THE CONTRACT THE DISK STORE RELIES ON
 *   · one revision is written once: `rev` strictly increases per real change and
 *     {@link isStaleSnapshot} lets the store reject an out-of-date writer;
 *   · a terminal snapshot (`settled`/`interrupted`) accepts no further transition;
 *   · a write is enqueued at most once per id and acknowledged idempotently; replay is
 *     at-least-once, so the consumer dedupes by {@link RunPendingWrite.id};
 *   · an approval resolves only while it is still pending: an expired, repeated or unknown
 *     decision is refused with an explicit reason and changes nothing;
 *   · recovery picks one of four decisions and never pretends to resume a run whose lease is
 *     still held by another process.
 *
 * Everything here is PURE: no IO, no Cordis service and no `Date.now()` — every clock is an
 * explicit `at`/`now` argument, so crash/replay/expiry scenarios are testable without a host.
 *
 * @module
 */

/**
 * Where one run is in its life cycle.
 *
 * `claimed` is before the first step advances; `running` is the normal working phase;
 * `awaiting-approval` means a tool call is blocked on a human decision; `settled`/`interrupted`
 * are terminal. `unknown` is a recovery artifact: a snapshot whose phase could not be trusted
 * (an old/foreign writer) is never resumed from a guessed step — it is marked failed instead.
 */
export type RunPhase = 'claimed' | 'running' | 'awaiting-approval' | 'settled' | 'interrupted' | 'unknown'

/** The final outcome of a run. `interrupted` settles into the `interrupted` phase (see below). */
export type RunTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled'

/** How hard a write must be on disk before the run may move on. */
export type RunDurability = 'sync' | 'async' | 'exit'

/**
 * One write the run still owes to the outside world (room message, ledger row, file card, …).
 *
 * It is part of the snapshot for exactly two reasons: a crash between "the side effect happened"
 * and "the transcript recorded it" must replay the write instead of re-running the tool, and the
 * `id` makes that replay idempotent — the consumer can skip an id it already applied.
 */
export interface RunPendingWrite {
  readonly id: string
  readonly kind: 'tool-result' | 'assistant-text' | 'ledger-row' | 'deliverable'
  readonly at: string
  /** Set by {@link acknowledgeWrite}: the caller replayed it, so recovery must not replay it again. */
  readonly replayed?: boolean
}

/**
 * One approval the run is blocked on.
 *
 * `expiresAt` is the approval window (ISO); once `now > expiresAt` the decision must be refused
 * as expired, because the user saw a prompt whose context may no longer be true.
 */
export interface RunPendingInterrupt {
  readonly id: string
  readonly kind: 'approval'
  readonly callId: string
  readonly toolName: string
  readonly raisedAt: string
  /** ISO deadline; absent means the approval does not expire on its own. */
  readonly expiresAt?: string | undefined
}

/**
 * One decided approval, kept as a bounded tombstone so a repeated decision is refused instead of
 * re-executing the tool. `expired` is recorded when a sweep retires a timed-out approval
 * (see {@link expireInterrupts}).
 */
export interface RunResolvedInterrupt {
  readonly id: string
  readonly outcome: 'allowed' | 'rejected' | 'expired'
  readonly at: string
}

/**
 * ONE run's durable checkpoint, immutable.
 *
 * `rev` is the persistence revision: it starts at 0 and every real change bumps it by exactly
 * one, so the store can reject a snapshot written by a slower/older writer. `step`/`turn` are
 * progress counters a resumed run continues from; `pendingWrites`/`pendingInterrupts` are the
 * work still owed; `resolvedInterrupts` is the bounded duplicate-decision memory; `settled` is
 * the terminal record (also present when the phase is `interrupted`).
 */
export interface RunSnapshot {
  readonly runId: string
  readonly roomId: string
  readonly botId: string
  readonly rev: number
  readonly phase: RunPhase
  readonly step: number
  readonly turn: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly pendingWrites: readonly RunPendingWrite[]
  readonly pendingInterrupts: readonly RunPendingInterrupt[]
  /** Most recent decided interrupts, FIFO-capped at {@link MAX_RESOLVED_INTERRUPTS}. */
  readonly resolvedInterrupts: readonly RunResolvedInterrupt[]
  readonly settled?: { readonly status: RunTerminalStatus; readonly at: string; readonly error?: string | undefined } | undefined
}

/** How many decided approvals are remembered for duplicate-decision detection (FIFO). */
export const MAX_RESOLVED_INTERRUPTS = 32

/**
 * Start the checkpoint of a run that has not done anything yet.
 *
 * It is `claimed` with `step`/`turn` 0 and `rev` 0 (the first real change becomes rev 1). Ids are
 * trusted here — this is only ever called by the host with its own ids; persisted values go
 * through {@link parseRunSnapshot}.
 */
export function createRunSnapshot(input: {
  readonly runId: string
  readonly roomId: string
  readonly botId: string
  readonly at: string
}): RunSnapshot {
  return {
    runId: input.runId,
    roomId: input.roomId,
    botId: input.botId,
    rev: 0,
    phase: 'claimed',
    step: 0,
    turn: 0,
    createdAt: input.at,
    updatedAt: input.at,
    pendingWrites: [],
    pendingInterrupts: [],
    resolvedInterrupts: [],
  }
}

/**
 * How durable a write/interrupt must be (the P3-1 grading table).
 *
 *   · `sync` — must reach the disk BEFORE it is acted on: an approval (the user must not decide on
 *     a prompt a restart cannot restore; dispatch/pending interrupts share this rule);
 *   · `async` — batchable and replay-safe by id: tool results, deliverables and ledger rows may lag
 *     behind the run and are replayed from `pendingWrites` after a restart, then acknowledged;
 *   · `exit` — best effort until process exit: pure UI streaming text; losing it is acceptable
 *     because the settled message is what the transcript keeps.
 */
export function durabilityOf(kind: RunPendingWrite['kind'] | RunPendingInterrupt['kind']): RunDurability {
  switch (kind) {
    case 'approval': return 'sync'
    case 'tool-result': return 'async'
    case 'deliverable': return 'async'
    case 'ledger-row': return 'async'
    case 'assistant-text': return 'exit'
  }
}

/**
 * Advance the checkpoint to step `step` (rev + 1), turning `claimed` into `running`.
 *
 * Only forward movement is accepted: an equal or lower step is a replayed signal, not progress.
 * A run waiting for an approval is blocked mid-step, so it cannot advance until the interrupt is
 * resolved. Terminal and `unknown` snapshots never advance.
 */
export function markStep(snapshot: RunSnapshot, step: number, at: string): {
  readonly snapshot: RunSnapshot
  readonly changed: boolean
} {
  if (snapshot.phase !== 'claimed' && snapshot.phase !== 'running') return { snapshot, changed: false }
  if (isTerminalRunSnapshot(snapshot)) return { snapshot, changed: false }
  if (!isCount(step) || step <= snapshot.step) return { snapshot, changed: false }
  return {
    snapshot: {
      ...snapshot,
      phase: 'running',
      step,
      rev: snapshot.rev + 1,
      updatedAt: at,
    },
    changed: true,
  }
}

/**
 * Enqueue one write the run still owes.
 *
 * Idempotent by `id`: a duplicate enqueue (a retried host callback, a replay) returns the SAME
 * snapshot, so an already-delivered write cannot be queued twice. Writes may be enqueued while
 * the run waits for an approval (an assistant text emitted before the blocked tool call) but not
 * on a terminal or `unknown` snapshot.
 */
export function enqueueWrite(snapshot: RunSnapshot, write: {
  readonly id: string
  readonly kind: RunPendingWrite['kind']
  readonly at: string
}, at: string): {
  readonly snapshot: RunSnapshot
  readonly changed: boolean
} {
  if (isTerminalRunSnapshot(snapshot) || snapshot.phase === 'unknown') return { snapshot, changed: false }
  if (snapshot.pendingWrites.some(pending => pending.id === write.id)) return { snapshot, changed: false }
  return {
    snapshot: {
      ...snapshot,
      pendingWrites: [...snapshot.pendingWrites, { id: write.id, kind: write.kind, at: write.at }],
      rev: snapshot.rev + 1,
      updatedAt: at,
    },
    changed: true,
  }
}

/**
 * Acknowledge a write the caller replayed successfully (rev + 1).
 *
 * The entry is MARKED `replayed` rather than deleted, deliberately: the tombstone keeps a retried
 * `enqueueWrite` for the same id a no-op, so a crash between deliver and persist cannot deliver
 * the same write twice. A second ack is a no-op (`changed:false`, same value); an unknown id is
 * ignored. Acknowledging on a terminal snapshot is refused — the run is over.
 */
export function acknowledgeWrite(snapshot: RunSnapshot, writeId: string, at: string): {
  readonly snapshot: RunSnapshot
  readonly changed: boolean
} {
  if (isTerminalRunSnapshot(snapshot) || snapshot.phase === 'unknown') return { snapshot, changed: false }
  const index = snapshot.pendingWrites.findIndex(pending => pending.id === writeId)
  const target = index < 0 ? undefined : snapshot.pendingWrites[index]
  if (target === undefined || target.replayed === true) return { snapshot, changed: false }
  return {
    snapshot: {
      ...snapshot,
      pendingWrites: snapshot.pendingWrites.map((pending, position) =>
        position === index ? { ...pending, replayed: true } : pending),
      rev: snapshot.rev + 1,
      updatedAt: at,
    },
    changed: true,
  }
}

/**
 * Raise an approval interrupt: the phase becomes `awaiting-approval` and the interrupt is added to
 * `pendingInterrupts` (rev + 1). Returns the SAME snapshot when nothing changed — compare by
 * reference.
 *
 * Idempotent per id. An ALREADY DECIDED id is refused too: re-opening it would let a late/duplicate
 * user decision re-execute a tool call the first decision already resolved. A genuinely new
 * approval needs a new id.
 *
 * Two pending approvals can coexist (parallel tool calls): the run stays `awaiting-approval` until
 * the last one is decided.
 */
export function openInterrupt(snapshot: RunSnapshot, interrupt: {
  readonly id: string
  readonly callId: string
  readonly toolName: string
  readonly raisedAt: string
  readonly expiresAt?: string
}, at: string): RunSnapshot {
  if (isTerminalRunSnapshot(snapshot) || snapshot.phase === 'unknown') return snapshot
  if (snapshot.pendingInterrupts.some(pending => pending.id === interrupt.id)) return snapshot
  if (snapshot.resolvedInterrupts.some(resolved => resolved.id === interrupt.id)) return snapshot
  const next: RunPendingInterrupt = {
    id: interrupt.id,
    kind: 'approval',
    callId: interrupt.callId,
    toolName: interrupt.toolName,
    raisedAt: interrupt.raisedAt,
    ...(interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : {}),
  }
  return {
    ...snapshot,
    phase: 'awaiting-approval',
    pendingInterrupts: [...snapshot.pendingInterrupts, next],
    rev: snapshot.rev + 1,
    updatedAt: at,
  }
}

/**
 * Decide one pending approval.
 *
 * The id must still be pending. Refusals change NOTHING (same value back) and say why:
 *   · `expired` — `at` is past the interrupt's `expiresAt` (a late click must not execute the
 *     tool: the user approved a prompt whose context may be stale);
 *   · `already-resolved` — the id is in `resolvedInterrupts` (a repeated click/duplicated bridge
 *     callback must not execute twice);
 *   · `unknown` — the id is nowhere (a decision for another run/room, or a closed snapshot: a
 *     terminal run has no actionable approvals).
 *
 * Success removes the interrupt, appends a tombstone to `resolvedInterrupts` (FIFO-capped at
 * {@link MAX_RESOLVED_INTERRUPTS}) and returns the phase to `running` once no approval is left.
 */
export function resolveInterrupt(snapshot: RunSnapshot, interruptId: string, outcome: 'allowed' | 'rejected', at: string): {
  readonly snapshot: RunSnapshot
  readonly ok: boolean
  readonly reason?: 'expired' | 'unknown' | 'already-resolved' | undefined
} {
  const refuse = (reason: 'expired' | 'unknown' | 'already-resolved'): {
    readonly snapshot: RunSnapshot
    readonly ok: false
    readonly reason: 'expired' | 'unknown' | 'already-resolved'
  } => ({ snapshot, ok: false, reason })
  if (snapshot.resolvedInterrupts.some(entry => entry.id === interruptId)) return refuse('already-resolved')
  if (isTerminalRunSnapshot(snapshot) || snapshot.phase === 'unknown') return refuse('unknown')
  const index = snapshot.pendingInterrupts.findIndex(pending => pending.id === interruptId)
  const pending = index < 0 ? undefined : snapshot.pendingInterrupts[index]
  if (pending === undefined) return refuse('unknown')
  if (isExpiredAt(pending.expiresAt, at)) return { snapshot, ok: false, reason: 'expired' }
  const remaining = snapshot.pendingInterrupts.filter((_entry, position) => position !== index)
  return {
    snapshot: {
      ...snapshot,
      phase: snapshot.phase === 'awaiting-approval' && remaining.length === 0 ? 'running' : snapshot.phase,
      pendingInterrupts: remaining,
      resolvedInterrupts: appendResolved(snapshot.resolvedInterrupts, { id: interruptId, outcome, at }),
      rev: snapshot.rev + 1,
      updatedAt: at,
    },
    ok: true,
  }
}

/**
 * Sweep approvals whose `expiresAt` has passed: retire them into `resolvedInterrupts` with outcome
 * `expired` (rev + 1) and unblock the phase once none is left.
 *
 * {@link resolveInterrupt} deliberately refuses an expired decision without touching the value (a
 * late click must not execute anything); this explicit sweep is how a host that has given up on an
 * approval moves the checkpoint on. Returns the retired interrupts so the caller can settle/fail
 * the run they belonged to.
 */
export function expireInterrupts(snapshot: RunSnapshot, at: string): {
  readonly snapshot: RunSnapshot
  readonly changed: boolean
  readonly expired: readonly RunPendingInterrupt[]
} {
  if (isTerminalRunSnapshot(snapshot) || snapshot.phase === 'unknown') {
    return { snapshot, changed: false, expired: [] }
  }
  const expired: RunPendingInterrupt[] = []
  const remaining: RunPendingInterrupt[] = []
  for (const pending of snapshot.pendingInterrupts) {
    if (isExpiredAt(pending.expiresAt, at)) expired.push(pending)
    else remaining.push(pending)
  }
  if (expired.length === 0) return { snapshot, changed: false, expired: [] }
  let resolvedInterrupts = snapshot.resolvedInterrupts
  for (const pending of expired) {
    resolvedInterrupts = appendResolved(resolvedInterrupts, { id: pending.id, outcome: 'expired', at })
  }
  return {
    snapshot: {
      ...snapshot,
      phase: snapshot.phase === 'awaiting-approval' && remaining.length === 0 ? 'running' : snapshot.phase,
      pendingInterrupts: remaining,
      resolvedInterrupts,
      rev: snapshot.rev + 1,
      updatedAt: at,
    },
    changed: true,
    expired,
  }
}

/**
 * Close the run exactly once: the phase becomes `settled` (for completed/failed/cancelled) or
 * `interrupted` (for the interrupted status), and `settled` records status/at/error (rev + 1).
 *
 * Repeated settles are no-ops that return the SAME value, so the first outcome wins and a late
 * stop/timeout cannot rewrite a completed run. Pending writes and interrupts are left in place:
 * they are the recovery evidence, not runnable work (a terminal run is never resumed).
 */
export function settleRunSnapshot(snapshot: RunSnapshot, status: RunTerminalStatus, at: string, error?: string): {
  readonly snapshot: RunSnapshot
  readonly changed: boolean
} {
  if (isTerminalRunSnapshot(snapshot)) return { snapshot, changed: false }
  return {
    snapshot: {
      ...snapshot,
      phase: status === 'interrupted' ? 'interrupted' : 'settled',
      settled: {
        status,
        at,
        ...(error !== undefined ? { error } : {}),
      },
      rev: snapshot.rev + 1,
      updatedAt: at,
    },
    changed: true,
  }
}

/** True when the snapshot accepts no further transition (settled OR interrupted, record or phase). */
export function isTerminalRunSnapshot(snapshot: RunSnapshot): boolean {
  return snapshot.settled !== undefined || snapshot.phase === 'settled' || snapshot.phase === 'interrupted'
}

/**
 * What to do with a snapshot found on disk after a restart.
 *
 * Order of the checks matters:
 *   1. terminal → `terminal`: never resume; `replays` still lists un-acknowledged writes so none
 *      are lost before the snapshot is archived, and no approval is re-raised;
 *   2. `unknown` phase → `mark-failed`: a phase that cannot be trusted must not resume from a
 *      guessed step;
 *   3. `leaseAlive` → `mark-failed` with a "still owned" reason: another process holds the run,
 *      so this snapshot must not be resumed or rewritten (it is NOT evidence that the run failed —
 *      check the reason before acting);
 *   4. live pending approvals → `resume-approvals` (re-raise exactly those; already-expired ones
 *      are listed separately in `expiredInterrupts`, never mixed into `interrupts`);
 *   5. no live approval left → `resume` from `step`; `expiredInterrupts` (when any) tells the
 *      caller to record those timed-out approvals as rejected — an expired card never blocks the
 *      run forever, it just cannot be granted.
 *
 * `replays` is the same for every decision: every write not marked `replayed`, in enqueue order.
 */
export function recoverDecision(snapshot: RunSnapshot, input: {
  readonly now: string
  readonly leaseAlive?: boolean | undefined
}): {
  readonly kind: 'terminal' | 'resume' | 'resume-approvals' | 'mark-failed'
  readonly step: number
  readonly replays: readonly RunPendingWrite[]
  readonly interrupts: readonly RunPendingInterrupt[]
  readonly expiredInterrupts: readonly RunPendingInterrupt[]
  readonly reason: string
} {
  const replays = snapshot.pendingWrites.filter(write => write.replayed !== true)
  const step = snapshot.step
  if (isTerminalRunSnapshot(snapshot)) {
    return {
      kind: 'terminal',
      step,
      replays,
      interrupts: [],
      expiredInterrupts: [],
      reason: `run already ${snapshot.settled?.status ?? snapshot.phase}; flush ${replays.length} pending write(s) and archive`,
    }
  }
  if (snapshot.phase === 'unknown') {
    return {
      kind: 'mark-failed',
      step,
      replays,
      interrupts: [],
      expiredInterrupts: [],
      reason: 'run phase is unknown after a restart; settle as failed instead of resuming from a guessed step',
    }
  }
  if (input.leaseAlive === true) {
    return {
      kind: 'mark-failed',
      step,
      replays,
      interrupts: [],
      expiredInterrupts: [],
      reason: 'run lease is still held by another process; do not resume or rewrite this snapshot',
    }
  }
  const interrupts: RunPendingInterrupt[] = []
  const expiredInterrupts: RunPendingInterrupt[] = []
  for (const pending of snapshot.pendingInterrupts) {
    if (isExpiredAt(pending.expiresAt, input.now)) expiredInterrupts.push(pending)
    else interrupts.push(pending)
  }
  if (interrupts.length > 0) {
    return {
      kind: 'resume-approvals',
      step,
      replays,
      interrupts,
      expiredInterrupts,
      reason: `${interrupts.length} approval(s) still pending after restart; re-raise them before resuming`,
    }
  }
  return {
    kind: 'resume',
    step,
    replays,
    interrupts: [],
    expiredInterrupts,
    reason: expiredInterrupts.length > 0
      ? `resume from step ${step}; ${expiredInterrupts.length} approval(s) expired while down and are reported as rejected`
      : `resume from step ${step} (${snapshot.phase})`,
  }
}

/**
 * Should the disk store reject `incomingRev` because `currentRev` is at least as new?
 *
 * Revisions must strictly increase: accepting an equal revision would let a duplicated write
 * resurrect stale pending writes, and accepting a lower one would roll a run backwards. Anything
 * that is not a finite integer revision is rejected as stale rather than compared (NaN comparisons
 * are all false, so a corrupt value could otherwise always win).
 */
export function isStaleSnapshot(incomingRev: number, currentRev: number): boolean {
  if (!Number.isInteger(incomingRev) || !Number.isInteger(currentRev)) return true
  return incomingRev <= currentRev
}

/**
 * Canonical JSON for the disk store.
 *
 * Only schema fields are written (unknown extras are dropped), in a fixed order, with optional
 * fields omitted when absent — so two values that are `deepEqual` serialize to the same bytes and
 * a parse/serialize round-trip is exactly stable.
 */
export function serializeRunSnapshot(snapshot: RunSnapshot): string {
  return JSON.stringify({
    runId: snapshot.runId,
    roomId: snapshot.roomId,
    botId: snapshot.botId,
    rev: snapshot.rev,
    phase: snapshot.phase,
    step: snapshot.step,
    turn: snapshot.turn,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    pendingWrites: snapshot.pendingWrites.map(write => ({
      id: write.id,
      kind: write.kind,
      at: write.at,
      ...(write.replayed === true ? { replayed: true } : {}),
    })),
    pendingInterrupts: snapshot.pendingInterrupts.map(interrupt => ({
      id: interrupt.id,
      kind: interrupt.kind,
      callId: interrupt.callId,
      toolName: interrupt.toolName,
      raisedAt: interrupt.raisedAt,
      ...(interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : {}),
    })),
    resolvedInterrupts: snapshot.resolvedInterrupts.map(interrupt => ({
      id: interrupt.id,
      outcome: interrupt.outcome,
      at: interrupt.at,
    })),
    ...(snapshot.settled !== undefined
      ? { settled: { status: snapshot.settled.status, at: snapshot.settled.at, ...(snapshot.settled.error !== undefined ? { error: snapshot.settled.error } : {}) } }
      : {}),
  })
}

/**
 * Restore a persisted checkpoint, tolerantly.
 *
 * `raw` may be the JSON string the store wrote or an already-parsed value (a migration path).
 * Rejection vs. repair follows one rule: never guess progress.
 *   · a torn/unparseable JSON string, a non-object, or a bad CORE field (ids, `rev`, `phase`,
 *     `step`, `turn`, `createdAt`, `updatedAt`) → `undefined`, because resuming from a guessed
 *     step/timestamp can duplicate side effects;
 *   · anything LIST-LIKE is repaired: bad pending items are dropped individually, duplicate ids
 *     keep their first occurrence, a pending interrupt whose id is already decided is dropped (a
 *     decided approval is never resurrected), and `resolvedInterrupts` is capped to the newest
 *     {@link MAX_RESOLVED_INTERRUPTS};
 *   · a malformed `settled` record is dropped (the phase still marks the run terminal); unknown
 *     extra fields from a future writer are ignored. The input value is never mutated.
 */
export function parseRunSnapshot(raw: unknown): RunSnapshot | undefined {
  const value = decodeSnapshotJson(raw)
  if (value === undefined) return undefined
  const runId = value['runId']
  const roomId = value['roomId']
  const botId = value['botId']
  const rev = value['rev']
  const phase = value['phase']
  const step = value['step']
  const turn = value['turn']
  const createdAt = value['createdAt']
  const updatedAt = value['updatedAt']
  if (!isNonEmptyString(runId)) return undefined
  if (!isNonEmptyString(roomId)) return undefined
  if (!isNonEmptyString(botId)) return undefined
  if (!isCount(rev)) return undefined
  if (!isRunPhase(phase)) return undefined
  if (!isCount(step)) return undefined
  if (!isCount(turn)) return undefined
  if (!isNonEmptyString(createdAt)) return undefined
  if (!isNonEmptyString(updatedAt)) return undefined
  const resolvedInterrupts = parseResolvedInterrupts(value['resolvedInterrupts'])
  const decided = new Set(resolvedInterrupts.map(interrupt => interrupt.id))
  const settled = parseSettled(value['settled'])
  return {
    runId,
    roomId,
    botId,
    rev,
    phase,
    step,
    turn,
    createdAt,
    updatedAt,
    pendingWrites: parsePendingWrites(value['pendingWrites']),
    pendingInterrupts: parsePendingInterrupts(value['pendingInterrupts'], decided),
    resolvedInterrupts,
    ...(settled !== undefined ? { settled } : {}),
  }
}

/** Append a decided interrupt, dropping the oldest entries beyond {@link MAX_RESOLVED_INTERRUPTS}. */
function appendResolved(
  existing: readonly RunResolvedInterrupt[],
  entry: RunResolvedInterrupt,
): readonly RunResolvedInterrupt[] {
  const next = [...existing, entry]
  return next.length <= MAX_RESOLVED_INTERRUPTS ? next : next.slice(next.length - MAX_RESOLVED_INTERRUPTS)
}

/** One interrupt's deadline check: `now > expiresAt`. Unparseable clocks never claim expiry. */
function isExpiredAt(expiresAt: string | undefined, now: string): boolean {
  if (expiresAt === undefined) return false
  const expires = Date.parse(expiresAt)
  const at = Date.parse(now)
  if (Number.isNaN(expires) || Number.isNaN(at)) return false
  return at > expires
}

/** A raw value that may be the persisted JSON string or an already-parsed JSON value. */
function decodeSnapshotJson(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    return isRecord(parsed) ? parsed : undefined
  }
  return isRecord(raw) ? raw : undefined
}

/** Tolerant list restore: bad items dropped, duplicate ids keep their first occurrence. */
function parsePendingWrites(raw: unknown): readonly RunPendingWrite[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const writes: RunPendingWrite[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = item['id']
    const kind = item['kind']
    const at = item['at']
    if (!isNonEmptyString(id) || seen.has(id) || !isWriteKind(kind) || !isNonEmptyString(at)) continue
    seen.add(id)
    writes.push({
      id,
      kind,
      at,
      ...(item['replayed'] === true ? { replayed: true } : {}),
    })
  }
  return writes
}

/** Tolerant interrupt restore; an id already in `decided` is a decided approval, never revived. */
function parsePendingInterrupts(raw: unknown, decided: ReadonlySet<string>): readonly RunPendingInterrupt[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const interrupts: RunPendingInterrupt[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = item['id']
    const kind = item['kind']
    const callId = item['callId']
    const toolName = item['toolName']
    const raisedAt = item['raisedAt']
    const expiresAt = item['expiresAt']
    if (kind !== 'approval') continue
    if (!isNonEmptyString(id) || seen.has(id) || decided.has(id)) continue
    if (!isNonEmptyString(callId) || !isNonEmptyString(toolName) || !isNonEmptyString(raisedAt)) continue
    seen.add(id)
    interrupts.push({
      id,
      kind: 'approval',
      callId,
      toolName,
      raisedAt,
      ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
    })
  }
  return interrupts
}

/** Newest `MAX_RESOLVED_INTERRUPTS` tombstones, first occurrence per id winning. */
function parseResolvedInterrupts(raw: unknown): readonly RunResolvedInterrupt[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const resolved: RunResolvedInterrupt[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = item['id']
    const outcome = item['outcome']
    const at = item['at']
    if (!isNonEmptyString(id) || seen.has(id) || !isResolvedOutcome(outcome) || !isNonEmptyString(at)) continue
    seen.add(id)
    resolved.push({ id, outcome, at })
  }
  return resolved.length <= MAX_RESOLVED_INTERRUPTS ? resolved : resolved.slice(resolved.length - MAX_RESOLVED_INTERRUPTS)
}

function parseSettled(raw: unknown): RunSnapshot['settled'] {
  if (!isRecord(raw)) return undefined
  const status = raw['status']
  const at = raw['at']
  const error = raw['error']
  if (!isTerminalStatus(status) || !isNonEmptyString(at)) return undefined
  return {
    status,
    at,
    ...(typeof error === 'string' ? { error } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** `rev`/`step`/`turn`: a non-negative integer, never a float or a negative. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRunPhase(value: unknown): value is RunPhase {
  return value === 'claimed'
    || value === 'running'
    || value === 'awaiting-approval'
    || value === 'settled'
    || value === 'interrupted'
    || value === 'unknown'
}

function isTerminalStatus(value: unknown): value is RunTerminalStatus {
  return value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'cancelled'
}

function isWriteKind(value: unknown): value is RunPendingWrite['kind'] {
  return value === 'tool-result' || value === 'assistant-text' || value === 'ledger-row' || value === 'deliverable'
}

function isResolvedOutcome(value: unknown): value is RunResolvedInterrupt['outcome'] {
  return value === 'allowed' || value === 'rejected' || value === 'expired'
}
