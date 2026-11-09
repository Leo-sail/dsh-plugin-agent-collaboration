/**
 * Restart recovery planning — what to do with the runs the last process left behind.
 *
 * WHY THIS IS PURE. The dangerous part of recovery is not the file IO, it is the DECISION: a run
 * that was mid-turn when the host stopped cannot be resumed deterministically (its model call is
 * gone), a snapshot that says "settled" may be ahead of the persisted board or behind it, and an
 * orphan snapshot must never resurrect a run. Those decisions are made here, from two plain
 * inputs — the snapshots on disk and the run rows in state — so tests can cover every combination
 * without a host.
 *
 * THE RULE THE USER ASKED FOR: never pretend success. A run whose state cannot be determined is
 * settled as FAILED with a reason the room can show, not silently completed and not left running.
 *
 * @module
 */
import type { RunSnapshot, RunTerminalStatus } from './run-state.ts'
import { isTerminalRunSnapshot } from './run-state.ts'

/** How long a settled snapshot is kept for audit before the startup sweep deletes it. */
export const RECOVERY_RETAIN_SETTLED_MS = 72 * 60 * 60 * 1000

/** Run states as the service's persisted run rows spell them. */
export type RecoveryRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

/** One persisted run row the plan may act on. */
export interface RecoveryRunRow {
  readonly runId: string
  readonly roomId: string
  readonly botId: string
  readonly status: RecoveryRunStatus
}

/** One thing the service must do during startup recovery. */
export type RecoveryAction =
  /**
   * The snapshot knows the run already ended (the process died between the settle write and the
   * board write, or vice versa): complete that settle from the snapshot rather than re-running.
   */
  | {
    readonly kind: 'settle-run'
    readonly runId: string
    readonly roomId: string
    readonly botId: string
    readonly status: RunTerminalStatus
    readonly reason: string
  }
  /**
   * The run was mid-turn and cannot be resumed deterministically: fail it with an explanation
   * instead of guessing. This is the "never pretend success" case.
   */
  | {
    readonly kind: 'fail-uncertain'
    readonly runId: string
    readonly roomId: string
    readonly botId: string
    readonly error: string
    readonly reason: string
  }
  /** The snapshot no longer describes anything actionable: delete the file. */
  | { readonly kind: 'prune-snapshot'; readonly runId: string; readonly reason: string }
  /** Nothing to do for this snapshot. */
  | { readonly kind: 'keep'; readonly runId: string; readonly reason: string }

/** One user-visible recovery notice (a grey transcript row), per affected room. */
export interface RecoveryNotice {
  readonly roomId: string
  readonly botId: string
  readonly text: string
}

export interface RecoveryPlan {
  readonly actions: readonly RecoveryAction[]
  readonly notices: readonly RecoveryNotice[]
}

const TERMINAL_STATUSES: ReadonlySet<RecoveryRunStatus> = new Set([
  'completed', 'failed', 'interrupted', 'cancelled',
])

/** Whether a persisted run row is already in a terminal state. */
export function isTerminalRunRow(status: RecoveryRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Short Chinese description of which pending things a crashed snapshot carried. */
function carriedWork(snapshot: RunSnapshot): string {
  const writes = snapshot.pendingWrites.filter(write => write.replayed !== true).length
  const approvals = snapshot.pendingInterrupts.length
  const parts: string[] = []
  if (approvals > 0) parts.push(`${approvals} 个未决审批`)
  if (writes > 0) parts.push(`${writes} 条未落账写入`)
  return parts.length === 0 ? '' : `（遗留 ${parts.join('、')}，均已失效）`
}

/**
 * Plan the startup recovery actions for every snapshot the last process left behind.
 *
 * `now` is passed in (no clock here) and decides only the retention sweep.
 */
export function planRunRecovery(input: {
  readonly snapshots: readonly RunSnapshot[]
  readonly runs: readonly RecoveryRunRow[]
  readonly now: string
  readonly retainSettledMs?: number | undefined
}): RecoveryPlan {
  const byId = new Map(input.runs.map(run => [run.runId, run]))
  const nowMs = Date.parse(input.now)
  const retain = input.retainSettledMs ?? RECOVERY_RETAIN_SETTLED_MS
  const actions: RecoveryAction[] = []
  const notices: RecoveryNotice[] = []

  for (const snapshot of input.snapshots) {
    const run = byId.get(snapshot.runId)
    const where = { runId: snapshot.runId, roomId: snapshot.roomId, botId: snapshot.botId }
    if (run === undefined) {
      // Orphan snapshot: the run row is gone (room/bot deleted, board cleared, or an older build
      // pruned runs). Nothing can be resumed and nothing should be shown.
      actions.push({ kind: 'prune-snapshot', runId: snapshot.runId, reason: 'run row no longer exists' })
      continue
    }
    if (isTerminalRunSnapshot(snapshot)) {
      if (!isTerminalRunRow(run.status)) {
        // The snapshot settled but the board did not: finish the settle from the snapshot. This
        // is the one case where trusting the snapshot beats trusting the board — the run really
        // did reach an outcome, and re-running it would duplicate its side effects.
        const status = snapshot.settled?.status ?? 'failed'
        actions.push({
          kind: 'settle-run',
          ...where,
          status,
          reason: 'snapshot is terminal while the run row is not',
        })
        notices.push({
          roomId: snapshot.roomId,
          botId: snapshot.botId,
          text: `恢复：上次的回合已在宿主中断前结束（状态 ${status}），已按快照补记结果。`,
        })
        continue
      }
      // Both terminal: keep the snapshot as an audit record for a bounded time, then delete.
      const settledAt = snapshot.settled?.at ?? snapshot.updatedAt
      const settledMs = Date.parse(settledAt)
      if (Number.isFinite(settledMs) && Number.isFinite(nowMs) && nowMs - settledMs > retain) {
        actions.push({ kind: 'prune-snapshot', runId: snapshot.runId, reason: 'settled snapshot past retention' })
      } else {
        actions.push({ kind: 'keep', runId: snapshot.runId, reason: 'settled snapshot within retention' })
      }
      continue
    }
    if (isTerminalRunRow(run.status)) {
      // The board says the run ended but the snapshot stayed open — a stale checkpoint from a
      // process that died between the two writes. The board is the user-facing truth; drop it.
      actions.push({
        kind: 'prune-snapshot',
        runId: snapshot.runId,
        reason: 'run row is already terminal; snapshot is stale',
      })
      continue
    }
    // Open snapshot + open run row = the process died mid-turn. There is no deterministic resume
    // for a model call that no longer exists, so the run is failed with an explanation rather
    // than silently completed or left running for ever.
    const carried = carriedWork(snapshot)
    const error = `宿主重启后无法确定该回合状态（step ${snapshot.step}）${carried}；请重发消息重试。`
    actions.push({
      kind: 'fail-uncertain',
      ...where,
      error,
      reason: 'process stopped mid-turn; deterministic resume is impossible',
    })
    notices.push({
      roomId: snapshot.roomId,
      botId: snapshot.botId,
      text: `恢复：上次未完成的回合已在宿主重启后停止${carried}，请重发消息重试。`,
    })
  }
  return { actions, notices }
}
