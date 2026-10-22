/**
 * In-session failure diagnosis (OP follow-up): a small GREY line in the transcript, not a
 * settings-page panel.
 *
 * WHY THIS MODULE EXISTS. When a bot turn fails, the user sees the failure but not the reason,
 * and the reason used to live in a separate "run diagnostics" settings panel that people did
 * not open. The useful move is to say it WHERE the failure happened: one plain notice in the
 * room, in the same quiet style as other system rows.
 *
 * The notice is deliberately NOT an audit prompt or a goal-drift warning: it must not contain
 * the words the UI uses to colour system rows as actionable (建议复盘 / 审计 / 目标可能偏移 /
 * bypass). It is a neutral, one-line explanation: CAUSE + optional error detail + optional
 * context-cost hint ("largest section: memory 911 chars (10%)").
 *
 * Pure and deterministic: ids/enums/numbers in, one string out; no prompt text is ever read.
 *
 * @module
 */
import type { FailureKind } from './run-budget.ts'
import type { RunFaultSide, RunFinishPath } from './types.ts'

export interface RunDiagnosisInput {
  readonly status: string
  readonly faultSide?: RunFaultSide | undefined
  readonly finishPath?: RunFinishPath | undefined
  readonly failureKind?: FailureKind | undefined
  /** The failure message the turn already recorded (never a prompt). */
  readonly error?: string | undefined
  /** OP-15 per-section character counts, when the run recorded them. */
  readonly contextSections?: Readonly<Record<string, number>> | undefined
}

export interface RunDiagnosis {
  /** Chinese cause, e.g. "运行超时（框架侧）". */
  readonly cause: string
  /** Flattened, clipped error text (absent when there is none). */
  readonly detail?: string | undefined
  /** Where the prompt budget went, when measurable. */
  readonly context?: string | undefined
  /** The exact line to record as a room notice. */
  readonly text: string
}

/** How much of the error text the notice keeps. */
export const DIAGNOSIS_DETAIL_LIMIT = 160

/** Human names for the prompt-contract sections; unknown names pass through unchanged. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  role: '角色',
  skills: '技能',
  goal: '目标',
  constraints: '约束',
  patterns: '协作模式',
  memory: '记忆',
  history: '历史',
  input: '输入',
}

/**
 * Words the UI classifies as its coloured, actionable system rows. A diagnosis must stay a
 * plain grey notice, so they are stripped from any free text we echo.
 */
const COLOUR_LABEL_WORDS = /建议复盘|审计|目标可能偏移|bypass/gu

/** Terminal statuses that are NOT failures: no diagnosis line. */
const BENIGN_STATUSES = new Set(['completed', 'interrupted', 'stopped', 'cancelled'])

/** Clip by code point, marking the cut. */
function clip(text: string, limit: number): string {
  const points = [...text]
  if (points.length <= limit) return text
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/** Flatten whitespace and drop UI colour-label words; undefined when nothing useful remains. */
function cleanDetail(error: string | undefined): string | undefined {
  if (error === undefined) return undefined
  const flattened = error.replace(COLOUR_LABEL_WORDS, ' ').replace(/\s+/gu, ' ').trim()
  if (flattened === '') return undefined
  return clip(flattened, DIAGNOSIS_DETAIL_LIMIT)
}

/** The cause for one (faultSide, finishPath, failureKind) combination. */
function causeOf(input: RunDiagnosisInput): string {
  const side = input.faultSide
  const finishPath = input.finishPath
  const failureKind = input.failureKind
  const budgetTimeout = finishPath === 'timeout' || failureKind === 'timeout'
  const budgetNoProgress = finishPath === 'no-progress' || failureKind === 'no-progress'
  switch (side) {
    case 'model': return '模型/Provider 调用失败'
    case 'harness': return budgetTimeout
      ? '运行超时（框架侧）'
      : budgetNoProgress ? '运行无进展（框架侧）' : '框架/运行预算问题'
    case 'tool': return '工具调用失败或被拒绝'
    case 'memory': return '记忆/上下文问题'
    case 'room-goal': return '房间/目标编排问题'
    case 'user': return '用户中止'
    case 'unknown': return '未归因失败'
    default:
      // No attribution recorded: fall back to what the budget fields say.
      if (budgetTimeout) return '运行超时（框架侧）'
      if (budgetNoProgress) return '运行无进展（框架侧）'
      if (finishPath === 'empty') return '本轮没有产生任何回复（模型输出为空）'
      return input.status === 'failed' ? '未归因失败' : '框架/运行预算问题'
  }
}

/** "上下文最大段：记忆 911 字（10%）" from the OP-15 per-section measurement. */
function contextOf(
  sections: Readonly<Record<string, number>> | undefined,
): string | undefined {
  if (sections === undefined) return undefined
  const rows: Array<{ name: string; chars: number }> = []
  let total = 0
  for (const [name, chars] of Object.entries(sections)) {
    if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) continue
    rows.push({ name, chars: Math.round(chars) })
    total += chars
  }
  if (rows.length === 0 || total <= 0) return undefined
  // Largest first; ties by name so the same measurement always names the same section.
  rows.sort((left, right) => right.chars - left.chars || left.name.localeCompare(right.name))
  const largest = rows[0]!
  const label = SECTION_LABELS[largest.name] ?? largest.name
  const percent = Math.round((largest.chars / total) * 100)
  return `上下文最大段：${label} ${largest.chars} 字（${percent}%）`
}

/**
 * Produce a diagnosis for a problematic run, or `undefined` when there is nothing to explain.
 *
 * Benign terminal statuses (completed/interrupted/stopped/cancelled) never get a line, even if
 * a stray fault field is set: a turn the user stopped is not a failure to diagnose.
 */
export function diagnoseRunFailure(input: RunDiagnosisInput): RunDiagnosis | undefined {
  // A completed run with NO output is still a user-visible problem: the turn "succeeded"
  // technically but the user received nothing. Diagnose it; a normal completed reply does not.
  const emptyCompletion = input.status === 'completed' && input.finishPath === 'empty'
  if (BENIGN_STATUSES.has(input.status) && !emptyCompletion) return undefined
  const problematicPath = input.finishPath === 'failed'
    || input.finishPath === 'timeout'
    || input.finishPath === 'no-progress'
    || input.finishPath === 'empty'
  const problematicSide = input.faultSide !== undefined && input.faultSide !== 'user'
  if (input.status !== 'failed' && !problematicSide && !problematicPath) return undefined

  const cause = causeOf(input)
  const detail = cleanDetail(input.error)
  const context = contextOf(input.contextSections)
  const text = `诊断：${cause}`
    + (detail !== undefined ? ` — ${detail}` : '')
    + (context !== undefined ? `。${context}` : '')
  return {
    cause,
    ...(detail !== undefined ? { detail } : {}),
    ...(context !== undefined ? { context } : {}),
    text,
  }
}
