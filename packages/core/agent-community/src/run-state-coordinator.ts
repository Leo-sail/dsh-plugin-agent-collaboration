/**
 * RunStateCoordinator — the bridge between the pure run state machine and its disk store.
 *
 * WHY A COORDINATOR. `run-state.ts` decides transitions, `run-state-store.ts` owns the files, and
 * the host services (approval bridge, run executor, service) must not each re-derive "which run is
 * this, what is its revision, did the write land". This class is that one adapter: it owns the
 * in-memory mirror lifetime, turns transitions into persisted writes, records approval interrupts,
 * refuses stale/duplicate decisions, and plans restart recovery.
 *
 * FAILURE POLICY. Durability matters only where the plan says so: approval opens/decisions and
 * run settles are awaited (sync), pending async writes are fire-and-forget with a warning. A
 * failed snapshot write must NEVER fail the run/turn that triggered it — the ledger remains the
 * user-visible source of truth; the snapshot is the crash-recovery aid.
 *
 * @module
 */
import type { RunSnapshot, RunTerminalStatus, RunPendingWrite } from './run-state.ts'
import {
  acknowledgeWrite,
  createRunSnapshot,
  enqueueWrite as enqueuePendingWrite,
  isTerminalRunSnapshot,
  markStep,
  openInterrupt,
  resolveInterrupt,
  settleRunSnapshot,
} from './run-state.ts'
import type { RunStateStore } from './run-state-store.ts'
import { planRunRecovery, type RecoveryPlan, type RecoveryRunRow } from './run-recovery-plan.ts'

export interface RunStateCoordinatorOptions {
  readonly store: RunStateStore
  /** Clock, injected so tests/callers stay deterministic. */
  readonly now: () => string
  readonly warn?: ((message: string) => void) | undefined
}

/** What the coordinator needs to know about a run before it can checkpoint it. */
export interface RunStateClaim {
  readonly runId: string
  readonly roomId: string
  readonly botId: string
}

export class RunStateCoordinator {
  private readonly store: RunStateStore
  private readonly now: () => string
  private readonly warn: (message: string) => void
  private readonly mirrors = new Map<string, RunSnapshot>()
  private loaded = false

  constructor(options: RunStateCoordinatorOptions) {
    this.store = options.store
    this.now = options.now
    this.warn = options.warn ?? (() => undefined)
  }

  /** Read the persisted snapshots into the mirror (idempotent). */
  async load(): Promise<void> {
    if (this.loaded) return
    await this.store.load()
    for (const snapshot of this.store.snapshots()) this.mirrors.set(snapshot.runId, snapshot)
    this.loaded = true
  }

  /** Current mirror, for diagnostics/tests. */
  snapshots(): readonly RunSnapshot[] {
    return [...this.mirrors.values()]
  }

  get(runId: string): RunSnapshot | undefined {
    return this.mirrors.get(runId)
  }

  /**
   * A run was claimed: create (or restart) its checkpoint.
   *
   * A retried run re-uses its id; its old snapshot may be terminal or carry an old revision, so a
   * restart keeps the revision monotonic (the store refuses going backwards) and resets the
   * progress fields. The previous attempt's pending writes are dropped: they belonged to a turn
   * that already settled.
   */
  async claim(input: RunStateClaim): Promise<void> {
    const previous = this.mirrors.get(input.runId)
    const fresh = createRunSnapshot({
      runId: input.runId,
      roomId: input.roomId,
      botId: input.botId,
      at: this.now(),
    })
    const next: RunSnapshot = previous === undefined
      ? fresh
      : {
          ...fresh,
          rev: previous.rev + 1,
          createdAt: previous.createdAt,
        }
    await this.write(next, 'claim')
  }

  /** Record that the run advanced to `step` (monotonic; no-op when unchanged). */
  async noteStep(runId: string, step: number): Promise<void> {
    const current = this.mirrors.get(runId)
    if (current === undefined) return
    const result = markStep(current, step, this.now())
    if (!result.changed) return
    await this.write(result.snapshot, 'step')
  }

  /** Queue one asynchronous write (tool result / deliverable) for idempotent replay. */
  enqueueWrite(runId: string, write: Omit<RunPendingWrite, 'replayed'>): void {
    const current = this.mirrors.get(runId)
    if (current === undefined) return
    // Aliased import: the method name is the same word, and an unqualified call inside the
    // class body would resolve to the method instead of the pure transition.
    const result = enqueuePendingWrite(current, write, this.now())
    if (!result.changed) return
    // Async durability: the caller must not wait for the disk; a failed write is logged.
    void this.write(result.snapshot, 'enqueue-write')
  }

  /** A pending write was replayed: acknowledge it so it is never replayed twice. */
  async acknowledge(runId: string, writeId: string): Promise<void> {
    const current = this.mirrors.get(runId)
    if (current === undefined) return
    const result = acknowledgeWrite(current, writeId, this.now())
    if (!result.changed) return
    await this.write(result.snapshot, 'acknowledge')
  }

  /**
   * An approval dialog opened for a run: record the interrupt BEFORE the ledger row is pushed, so
   * a crash between the two can never leave a visible card with no record of what it blocked.
   */
  async openApproval(input: {
    readonly runId: string
    readonly callId: string
    readonly toolName: string
    readonly expiresAt?: string | undefined
  }): Promise<void> {
    const current = this.mirrors.get(input.runId)
    if (current === undefined) return
    const at = this.now()
    const next = openInterrupt(current, {
      id: input.callId,
      callId: input.callId,
      toolName: input.toolName,
      raisedAt: at,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }, at)
    await this.write(next, 'open-approval')
  }

  /**
   * The user decided an approval: record the resolution, refusing stale decisions.
   *
   * A duplicate click and a decision after the interrupt expired are both refused with a reason
   * (and the snapshot is NOT changed by the refusal), which is what makes them harmless.
   */
  async decideApprovalByCallId(
    callId: string,
    outcome: 'allowed' | 'rejected',
  ): Promise<{ readonly ok: boolean; readonly reason?: string | undefined }> {
    const at = this.now()
    for (const current of this.mirrors.values()) {
      const pending = current.pendingInterrupts.find(interrupt => interrupt.callId === callId)
      if (pending === undefined) continue
      const result = resolveInterrupt(current, pending.id, outcome, at)
      if (!result.ok) return { ok: false, reason: result.reason }
      await this.write(result.snapshot, 'decide-approval')
      return { ok: true }
    }
    return { ok: false, reason: 'unknown' }
  }

  /** The run settled: persist the terminal snapshot (awaited — this is the sync-durability case). */
  async settle(runId: string, status: RunTerminalStatus, error?: string): Promise<void> {
    const current = this.mirrors.get(runId)
    if (current === undefined) return
    const result = settleRunSnapshot(current, status, this.now(), error)
    if (!result.changed) return
    await this.write(result.snapshot, 'settle')
  }

  /**
   * Startup recovery: plan from the persisted snapshots + the board's run rows, apply the
   * snapshot-side actions, and hand the plan back so the service can fix the run rows and record
   * the user-visible notices.
   */
  async recover(input: { readonly runs: readonly RecoveryRunRow[]; readonly now?: string | undefined }): Promise<RecoveryPlan> {
    await this.load()
    const plan = planRunRecovery({
      snapshots: [...this.mirrors.values()],
      runs: input.runs,
      now: input.now ?? this.now(),
    })
    for (const action of plan.actions) {
      if (action.kind === 'prune-snapshot') {
        const removed = await this.store.remove(action.runId)
        if (removed.ok) this.mirrors.delete(action.runId)
        continue
      }
      if (action.kind === 'fail-uncertain') {
        const current = this.mirrors.get(action.runId)
        if (current !== undefined && !isTerminalRunSnapshot(current)) {
          const settled = settleRunSnapshot(current, 'failed', this.now(), action.error)
          if (settled.changed) await this.write(settled.snapshot, 'recover-fail')
        }
      }
      // `settle-run` and `keep` need no snapshot write: the snapshot already holds the outcome.
    }
    return plan
  }

  /** Persist one snapshot through the store, mirroring only after the file accepted it. */
  private async write(snapshot: RunSnapshot, what: string): Promise<void> {
    try {
      const result = await this.store.write(snapshot)
      if (result.ok) {
        this.mirrors.set(result.snapshot.runId, result.snapshot)
        return
      }
      if (result.stale !== true) {
        this.warn(`agent-community: run-state ${what} for ${snapshot.runId} not persisted: ${result.error}`)
      }
    } catch (error: unknown) {
      this.warn(`agent-community: run-state ${what} for ${snapshot.runId} failed: ${String(error)}`)
    }
  }
}
