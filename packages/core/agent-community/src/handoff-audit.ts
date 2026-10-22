/**
 * Selective audit sampling (OP-16): ask a human to look at the runs that actually need it.
 *
 * WHY THIS MODULE EXISTS. Every run can technically be audited, but a room produces far more
 * runs than anyone will read: flagging all of them is the same as flagging none. The useful
 * signal is concentrated in failures whose cause is UNKNOWN or structural — an unattributed
 * failure, a completed turn that produced nothing, a tool-heavy turn where most calls failed.
 *
 * So this module ranks runs by "how much would a human learn from reading this" and samples a
 * few of them, de-duplicated per room and per failure type, and produces ONE short Chinese
 * notice. It is advisory: it never retries, never edits code, and it never copies prompt text
 * or model output into the notice — only ids, enums and counters.
 *
 * @module
 */
import type { RunEvidence, RunFaultSide, RunFinishPath } from './types.ts'

/**
 * The minimal run shape the auditor reads.
 *
 * Deliberately CLOSED: there is no `prompt`, no `reply` and no `reasoning` field, so a notice
 * can never leak transcript content even by accident.
 */
export interface AuditRunLike {
  readonly id: string
  readonly roomId: string
  readonly status: string
  readonly faultSide?: RunFaultSide | undefined
  readonly evidence?: Pick<RunEvidence, 'finishPath' | 'toolCalls' | 'toolFailures'> | undefined
  /** The user message this run answered, when known, so the notice can point at it. */
  readonly rootMessageId?: string | undefined
}

/** One selected sample: which run, where, why — never what was said. */
export interface AuditSample {
  readonly runId: string
  readonly roomId: string
  readonly reason: string
  /** Higher = more worth a human's time (0 means "do not audit"). */
  readonly priority: number
  /** The originating message id, when the run carries one. */
  readonly messageId?: string | undefined
}

/** Priority weights, exported so the ranking is explainable in tests and logs. */
export const AUDIT_WEIGHTS = {
  failed: 40,
  nonCompleted: 20,
  interrupted: 15,
  faultUnknown: 30,
  faultHarness: 20,
  faultMemory: 15,
  faultTool: 10,
  faultRoomGoal: 10,
  faultModel: 5,
  faultEvidenceMissing: 15,
  finishEmpty: 25,
  finishUnknown: 15,
  finishBudget: 15,
  finishFailed: 10,
  toolFailureEach: 5,
  toolFailureCap: 20,
} as const

/** How much a human would learn from reading this run; completed-normal runs score 0. */
export function auditPriority(run: AuditRunLike): number {
  let score = 0
  if (run.status === 'failed') score += AUDIT_WEIGHTS.failed
  else if (run.status === 'interrupted') score += AUDIT_WEIGHTS.interrupted
  else if (run.status !== 'completed') score += AUDIT_WEIGHTS.nonCompleted

  switch (run.faultSide) {
    case 'unknown': score += AUDIT_WEIGHTS.faultUnknown; break
    case 'harness': score += AUDIT_WEIGHTS.faultHarness; break
    case 'memory': score += AUDIT_WEIGHTS.faultMemory; break
    case 'tool': score += AUDIT_WEIGHTS.faultTool; break
    case 'room-goal': score += AUDIT_WEIGHTS.faultRoomGoal; break
    case 'model': score += AUDIT_WEIGHTS.faultModel; break
    default: break
  }

  const evidence = run.evidence
  if (evidence === undefined) {
    score += AUDIT_WEIGHTS.faultEvidenceMissing
  } else {
    const finishPath = evidence.finishPath
    if (finishPath === 'empty') score += AUDIT_WEIGHTS.finishEmpty
    else if (finishPath === 'unknown') score += AUDIT_WEIGHTS.finishUnknown
    else if (finishPath === 'timeout' || finishPath === 'no-progress') score += AUDIT_WEIGHTS.finishBudget
    else if (finishPath === 'failed') score += AUDIT_WEIGHTS.finishFailed
    const toolFailures = evidence.toolFailures ?? 0
    if (Number.isFinite(toolFailures) && toolFailures > 0) {
      score += Math.min(Math.round(toolFailures) * AUDIT_WEIGHTS.toolFailureEach, AUDIT_WEIGHTS.toolFailureCap)
    }
  }
  return score
}

/** Why this run is worth a look, in one short line (ids/enums/counters only). */
function reasonOf(run: AuditRunLike): string {
  const reasons: string[] = []
  if (run.status === 'failed') reasons.push('运行失败')
  else if (run.status === 'interrupted') reasons.push('回合被中断')
  else if (run.status !== 'completed') reasons.push(`运行未完成（${run.status}）`)
  if (run.faultSide === 'unknown') reasons.push('失败归因未知')
  else if (run.faultSide !== undefined && run.faultSide !== 'user') reasons.push(`归因 faultSide=${run.faultSide}`)
  const finishPath: RunFinishPath | undefined = run.evidence?.finishPath
  if (finishPath === 'empty') reasons.push('完成但没有任何输出')
  else if (finishPath === 'unknown') reasons.push('结束路径未知')
  else if (finishPath === 'timeout') reasons.push('超时结束')
  else if (finishPath === 'no-progress') reasons.push('无进展结束')
  const toolFailures = run.evidence?.toolFailures ?? 0
  if (toolFailures > 0) {
    const toolCalls = run.evidence?.toolCalls ?? 0
    reasons.push(`工具失败 ${toolFailures}/${toolCalls} 次`)
  }
  if (run.evidence === undefined) reasons.push('缺少运行证据')
  return reasons.length > 0 ? reasons.join('；') : '需要人工抽样确认'
}

export interface SelectAuditSamplesInput {
  readonly runs: readonly AuditRunLike[]
  readonly limit?: number | undefined
}

/**
 * Pick at most `limit` runs to audit, de-duplicated per room AND per failure type.
 *
 * Ranking is highest priority first (ties keep input order). De-duplication is what keeps the
 * notice readable: two failures from the same room usually share a cause, and five `unknown`
 * failures across rooms are one lesson, not five. Completed-normal runs (priority 0) never
 * appear — that is the "selective" half of selective audit.
 */
export function selectAuditSamples(input: SelectAuditSamplesInput): AuditSample[] {
  const limit = input.limit === undefined ? 5 : Math.max(0, Math.floor(input.limit))
  const ranked = input.runs
    .map((run, index) => ({ run, index, priority: auditPriority(run) }))
    .filter(entry => entry.priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
  const seenRooms = new Set<string>()
  const seenTypes = new Set<string>()
  const samples: AuditSample[] = []
  for (const entry of ranked) {
    if (samples.length >= limit) break
    const type = entry.run.faultSide !== undefined && entry.run.faultSide !== 'user'
      ? `side:${entry.run.faultSide}`
      : entry.run.evidence?.finishPath !== undefined
        ? `finish:${entry.run.evidence.finishPath}`
        : 'missing-evidence'
    if (seenRooms.has(entry.run.roomId)) continue
    if (seenTypes.has(type)) continue
    seenRooms.add(entry.run.roomId)
    seenTypes.add(type)
    samples.push({
      runId: entry.run.id,
      roomId: entry.run.roomId,
      reason: reasonOf(entry.run),
      priority: entry.priority,
      ...(entry.run.rootMessageId !== undefined ? { messageId: entry.run.rootMessageId } : {}),
    })
  }
  return samples
}

/**
 * The visible, human-facing line for one sample.
 *
 * Says what to look at and — just as important — what will NOT happen automatically. No prompt
 * or model output is ever included: the notice only names ids, the reason and the message.
 */
export function auditNotice(sample: AuditSample): string {
  const message = sample.messageId !== undefined ? `；相关消息 ${sample.messageId}` : ''
  return `建议复盘：run ${sample.runId}（房间 ${sample.roomId}）——${sample.reason}${message}。`
    + '仅提醒：不会自动重试，也不会自动修改代码；可在面板查看该 run 的证据。'
}
