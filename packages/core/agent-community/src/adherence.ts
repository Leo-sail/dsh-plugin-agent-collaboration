/**
 * Collaboration adherence (P2): a small, honest scorecard for a group task board.
 *
 * WHY THIS EXISTS. The panel can say a group task "finished", but not whether the group
 * actually did what it promised: assignments may still be open, the finish may have been
 * bypassed by the evidence gate, or a report may claim completion with no evidence at all.
 * This module turns the persisted board into a handful of counts and a deliberately coarse
 * score. It is a DIAGNOSTIC, not a judge: no model call, no new state authority, and nothing
 * here changes a task.
 *
 * PURE on purpose — the finish/advance paths call it while saving a board, and the tests can
 * assert every formula without a host.
 *
 * @module
 */
import type { RoomTaskAssignment, RoomTaskState } from './types.ts'

/** Counts and a 0–100 score for one persisted board. */
export interface TaskAdherence {
  /** Assignments on the board (the denominator). */
  readonly assigned: number
  /** Assignments whose terminal status is done. */
  readonly done: number
  /** Assignments whose terminal status is failed/blocked. */
  readonly failed: number
  /** Assignments still open/assigned/working/reported. */
  readonly pending: number
  /** `done / assigned`, 0 when there is nothing to measure. */
  readonly coverage: number
  /** The task is closed and the finish gate passed. */
  readonly verifiedFinish: boolean
  /** The finish was let through after repeated gate failures. */
  readonly bypassed: boolean
  /** How many evidence items the finish carried. */
  readonly evidenceCount: number
  /**
   * Coarse score: 70% assignment coverage + 30% verified finish, minus 15 for a bypassed
   * finish. Bounded to 0–100; intended for a badge/trend, not for comparing across tasks.
   */
  readonly score: number
  /** Human-readable reasons the score is not 100, in stable order. */
  readonly issues: readonly string[]
}

/** The statuses that count as a finished assignment. */
const DONE_STATUSES = new Set(['done'])
/** The statuses that count as a failed/blocked assignment. */
const FAILED_STATUSES = new Set(['blocked', 'failed', 'cancelled'])

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Build the scorecard from the persisted board. Never throws; malformed rows are ignored. */
export function taskAdherence(
  state: Pick<RoomTaskState, 'assignments' | 'finished'> | undefined,
): TaskAdherence {
  const rows = state?.assignments ?? []
  let done = 0
  let failed = 0
  for (const row of rows) {
    const status = row.status ?? 'assigned'
    if (DONE_STATUSES.has(status)) done += 1
    else if (FAILED_STATUSES.has(status)) failed += 1
  }
  const assigned = rows.length
  const pending = Math.max(0, assigned - done - failed)
  const coverage = assigned === 0 ? 0 : clamp01(done / assigned)
  const finished = state?.finished
  const verifiedFinish = finished?.gate === 'passed'
  const bypassed = finished?.gate === 'bypassed'
  const evidenceCount = finished?.evidence?.length ?? 0
  const raw = coverage * 70 + (verifiedFinish ? 30 : 0) - (bypassed ? 15 : 0)
  const score = Math.round(Math.min(100, Math.max(0, raw)))
  const issues: string[] = []
  if (assigned > 0 && done < assigned) issues.push(`${assigned - done} 个任务未完成`)
  if (finished === undefined) issues.push('任务尚未收尾')
  else if (bypassed) issues.push('完成证据未通过，已 bypass')
  else if (!verifiedFinish) issues.push('完成未经证据门验证')
  if (finished !== undefined && evidenceCount === 0) issues.push('收尾没有附带证据')
  return {
    assigned,
    done,
    failed,
    pending,
    coverage,
    verifiedFinish,
    bypassed,
    evidenceCount,
    score,
    issues,
  }
}
