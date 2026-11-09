/**
 * Guardrail enforcement (P3-3): turn the pure checks into ONE decision a run can execute.
 *
 * `guardrails.ts` answers "did any rule fail, and what is the strictest requested action". That is
 * not yet something a run can act on: a failure carries a stage, an action and a list of reasons,
 * but the executor needs to know whether to send the prompt at all, with what added line, or to
 * stop the turn and surface a Chinese error. This module is that translation — values in, a value
 * out, no host, no IO, no clock. It exists as its own layer so `runs.ts` can be wired and tested
 * without a session or a model, and so the wording of the block error lives in one place.
 *
 * THE STAGES ARE FIXED HERE, not passed in: `checkPreTurn` evaluates only `pre-turn` rules and
 * `checkPostTurn` only `post-turn` ones. A caller cannot accidentally run an output rule on the
 * input text (or the reverse) by getting an argument wrong.
 *
 * WHAT EACH DECISION MEANS:
 *
 *   · pre-turn `pass`   — send `text` unchanged;
 *   · pre-turn `repair` — append `promptSuffix` to the outgoing prompt; the model fixes only the
 *     listed problems in place. The suffix is exactly `guardrailRepairPrompt(outcome)`;
 *   · pre-turn `block`  — do not run the turn; `error` is the Chinese reason for `run.error`, the
 *     error row and the room notice;
 *   · post-turn `block`  — the answer must not be published; `error` is the same kind of reason;
 *   · post-turn `repair` — the output has ALREADY streamed, so an in-place retry cannot happen in
 *     this version. The turn is let through (`decision: 'pass'`) and `degradedRepair` explains
 *     that the repair is deferred, so the host can log/notice it instead of silently ignoring it.
 *
 * A block is decided by `evaluateGuardrails` (block wins over repair) and always surfaces ALL
 * failures, not just the blocking ones: one error line should tell the user everything that is
 * wrong with the turn, not one problem at a time.
 *
 * @module
 */
import { evaluateGuardrails, guardrailRepairPrompt } from './guardrails.ts'
import type { GuardrailContext, GuardrailOutcome, GuardrailRule } from './guardrails.ts'

/** Everything one pre-turn check may know. The stage is implied by the function called. */
export interface PreTurnGuardrailInput {
  readonly rules: readonly GuardrailRule[]
  /** The text about to go into the turn (the prompt/instruction the bot is handed). */
  readonly text: string
  /** One-based turn number inside the run, for diagnostics. */
  readonly turn: number
  readonly botId: string
  readonly roomId: string
}

/** A post-turn check additionally sees the tools the turn used. */
export interface PostTurnGuardrailInput extends PreTurnGuardrailInput {
  readonly toolNames?: readonly string[] | undefined
}

/**
 * What the executor should do with one turn after the guardrail checks ran.
 *
 * Deliberately a small closed union: `pass` carries nothing, `repair` carries the one line to
 * append, and `block` carries the reason to show. A caller that switches on `decision` cannot
 * forget to handle a stage — the distinction lives in which function produced the value.
 */
export type GuardrailTurnDecision =
  | { readonly decision: 'pass' }
  /** pre-turn repair: append `promptSuffix` to the outgoing prompt (只修命中项). */
  | { readonly decision: 'repair'; readonly promptSuffix: string; readonly reasons: readonly string[] }
  /** 中断本回合：`error` 是给 run.error / 房间展示的中文原因。 */
  | { readonly decision: 'block'; readonly error: string; readonly reasons: readonly string[] }

/**
 * How a post-turn repair degrades once the output already exists.
 *
 * The current executor has no "rewind the published answer" path, so the only honest options are
 * to block (too strict — the answer may be perfectly usable) or to let it through and say that the
 * fix is deferred. The reason list still carries every failure, so the host can log/notice it.
 */
const POST_TURN_REPAIR_DEGRADED =
  '本回合输出已产生，无法就地修复；请在下一回合重试，本轮按放行处理。'

/**
 * `[guardrails] 规则 rule-1：原因；rule-2：原因` — one line for a block error and for logs.
 *
 * The trailing `。` of each rule's reason is folded into the `；`/final `。` separators so the
 * line reads as one sentence instead of `。；`. A passing outcome (or an outcome with no
 * failures) returns the empty string: there is nothing to report, and callers may pass the
 * result straight into a log without inventing a branch.
 */
export function guardrailFailureLine(outcome: GuardrailOutcome): string {
  if (outcome.failures.length === 0) return ''
  const parts = outcome.failures.map(failure => `${failure.ruleId}：${failure.reason.replace(/。$/u, '')}`)
  return `[guardrails] 规则 ${parts.join('；')}。`
}

/** Every failure reason in rule order: what the model/host is told, independent of action. */
function reasonsOf(outcome: GuardrailOutcome): readonly string[] {
  return outcome.failures.map(failure => failure.reason)
}

/**
 * The pre-turn decision: send as-is, append the repair line, or stop before the model is called.
 *
 * Empty rules — the default configuration — evaluate to a passing outcome, so this is a no-op
 * until the user registers a check.
 */
export function checkPreTurn(input: PreTurnGuardrailInput): GuardrailTurnDecision {
  const context: GuardrailContext = {
    stage: 'pre-turn',
    text: input.text,
    turn: input.turn,
    botId: input.botId,
    roomId: input.roomId,
  }
  const outcome = evaluateGuardrails(input.rules, context)
  if (outcome.action === 'block') {
    return { decision: 'block', error: guardrailFailureLine(outcome), reasons: reasonsOf(outcome) }
  }
  if (outcome.action === 'repair') {
    // `evaluateGuardrails` only sets `repair` when at least one rule failed, and
    // `guardrailRepairPrompt` returns a prompt for every repairing outcome; the fallback keeps
    // the type honest without inventing behaviour.
    const promptSuffix = guardrailRepairPrompt(outcome) ?? guardrailFailureLine(outcome)
    return { decision: 'repair', promptSuffix, reasons: reasonsOf(outcome) }
  }
  return { decision: 'pass' }
}

/**
 * The post-turn decision: publish the answer, or stop it before it reaches the room.
 *
 * A `repair` outcome becomes `pass` + `degradedRepair` (see {@link POST_TURN_REPAIR_DEGRADED}):
 * the answer has already streamed, so this version cannot retry in place. A `block` outcome is
 * still enforced — its error line is the same one the pre-turn path uses.
 */
export function checkPostTurn(input: PostTurnGuardrailInput): {
  readonly decision: 'pass' | 'block'
  readonly error?: string | undefined
  readonly reasons: readonly string[]
  /** post-turn 的 repair 在当前版本不可执行（输出已流式产生）：给出说明供 host 记日志/notice，decision 仍为 pass。 */
  readonly degradedRepair?: string | undefined
} {
  const context: GuardrailContext = {
    stage: 'post-turn',
    text: input.text,
    turn: input.turn,
    botId: input.botId,
    roomId: input.roomId,
    ...(input.toolNames !== undefined ? { toolNames: input.toolNames } : {}),
  }
  const outcome = evaluateGuardrails(input.rules, context)
  if (outcome.action === 'block') {
    return { decision: 'block', error: guardrailFailureLine(outcome), reasons: reasonsOf(outcome) }
  }
  if (outcome.action === 'repair') {
    return { decision: 'pass', reasons: reasonsOf(outcome), degradedRepair: POST_TURN_REPAIR_DEGRADED }
  }
  return { decision: 'pass', reasons: [] }
}
