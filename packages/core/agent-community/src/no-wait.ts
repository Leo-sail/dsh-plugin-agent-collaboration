/**
 * No-wait guard (S0-6) — refuse the three ways a Bot can block its own turn waiting.
 *
 * WHY THIS EXISTS. DSH gives every bot the native background-job tools (`tool-jobs`), so a long
 * command has a correct home: start it, keep working, let the completion arrive as a new event.
 * But the model's habits come from shorter sessions: `sleep 30` between polls, a foreground
 * `bash` with a five-minute timeout, or `job_output` with a long wait. Each one freezes the turn:
 * the room shows 处理中… while nothing new happens, and the user's next message queues behind it.
 * The Super-agent prototype refuses exactly these three, and the article's "full duplex" section
 * is the reason why: a turn must stay able to accept input instead of sleeping.
 *
 * WHAT IT IS. A PURE classifier over a tool name + arguments, plus a mode:
 *   · `observe` (DEFAULT) — only log what WOULD be refused; no behaviour change;
 *   · `enforce` — refuse the call and return a message telling the model what to do instead;
 *   · `off` — do nothing.
 * Evidence first: enforcement is a behaviour change, so it ships off-by-default and is enabled
 * after the observe log looks clean on a real room.
 *
 * WHAT IT IS NOT. It does not limit tool runtime in general (a legitimately long tool is the job
 * runner's business), does not inspect the user's own tools (the wiring scopes it to bot sessions),
 * and never refuses a call it cannot classify with confidence: an unknown argument shape is
 * allowed — a false refusal would break real work.
 *
 * @module
 */

/** How the guard behaves. `observe` is the shipped default. */
export type NoWaitMode = 'off' | 'observe' | 'enforce'

export interface NoWaitConfig {
  readonly mode: NoWaitMode
  /** A foreground shell call asking for more than this is a block candidate. */
  readonly maxForegroundMs: number
  /** A `job_output` wait asking for more than this is a block candidate. */
  readonly maxJobWaitMs: number
}

export const DEFAULT_NO_WAIT: NoWaitConfig = {
  mode: 'observe',
  maxForegroundMs: 30_000,
  maxJobWaitMs: 5_000,
}

/** Clamp a partial deployment config; unknown modes fall back to `observe`. */
export function normalizeNoWait(input: Partial<NoWaitConfig> | undefined): NoWaitConfig {
  const mode = input?.mode
  const maxForegroundMs = input?.maxForegroundMs
  const maxJobWaitMs = input?.maxJobWaitMs
  return {
    mode: mode === 'off' || mode === 'observe' || mode === 'enforce' ? mode : DEFAULT_NO_WAIT.mode,
    maxForegroundMs: Number.isFinite(maxForegroundMs) && (maxForegroundMs as number) > 0
      ? Math.floor(maxForegroundMs as number)
      : DEFAULT_NO_WAIT.maxForegroundMs,
    maxJobWaitMs: Number.isFinite(maxJobWaitMs) && (maxJobWaitMs as number) >= 0
      ? Math.floor(maxJobWaitMs as number)
      : DEFAULT_NO_WAIT.maxJobWaitMs,
  }
}

export type NoWaitReason = 'sleep' | 'foreground-timeout' | 'job-wait'

export type NoWaitVerdict =
  | { readonly level: 'none' }
  | {
      readonly level: 'block' | 'warn'
      readonly reason: NoWaitReason
      /** Why it looks like a wait; logs/observe only. */
      readonly detail: string
      /** Model-facing refusal: what to do instead. */
      readonly message: string
    }

/** The suggestion appended to every refusal — the whole point is to move work to the job tools. */
const INSTEAD = '把这条命令/子任务改为后台执行（bash 的标准后台参数或 job 工具启动），然后继续做别的或结束这一轮；'
  + '它完成后会作为新事件回来，不需要你在这一轮里等。'

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'shell'])
const JOB_TOOLS: ReadonlySet<string> = new Set(['job_output'])

/** First numeric value among the given argument keys, if any. */
function numericArg(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** Whether the command is literally a sleep at its start (the pattern that blocks a turn). */
function isSleepCommand(command: string): boolean {
  const trimmed = command.trimStart()
  return /^sleep(?:\s|$)/u.test(trimmed) || /^start-sleep\b/iu.test(trimmed)
}

/** The public classifier: tool name + arguments in, verdict out. */
export function inspectToolCall(input: {
  readonly tool: string | undefined
  readonly args: unknown
  readonly config: NoWaitConfig
}): NoWaitVerdict {
  const tool = (input.tool ?? '').trim()
  if (input.args === null || typeof input.args !== 'object') return { level: 'none' }
  const args = input.args as Record<string, unknown>

  if (SHELL_TOOLS.has(tool)) {
    const command = typeof args['command'] === 'string' ? args['command'] : undefined
    if (command !== undefined && isSleepCommand(command)) {
      return {
        level: 'block',
        reason: 'sleep',
        detail: `shell command starts with sleep: ${command.slice(0, 80)}`,
        message: `不要用 sleep 等待。${INSTEAD}`,
      }
    }
    const timeoutMs = numericArg(args, ['timeoutMs', 'timeout_ms', 'timeout'])
    if (timeoutMs !== undefined && timeoutMs > input.config.maxForegroundMs) {
      return {
        level: 'block',
        reason: 'foreground-timeout',
        detail: `foreground timeout ${Math.round(timeoutMs)}ms > ${input.config.maxForegroundMs}ms`,
        message: `不要用长前台命令等待（请求了 ${Math.round(timeoutMs / 1000)} 秒）。${INSTEAD}`,
      }
    }
    return { level: 'none' }
  }

  if (JOB_TOOLS.has(tool)) {
    const waitMs = numericArg(args, ['timeoutMs', 'timeout_ms', 'waitTimeoutMs', 'waitMs', 'wait_ms'])
    if (waitMs !== undefined && waitMs > input.config.maxJobWaitMs) {
      return {
        level: 'block',
        reason: 'job-wait',
        detail: `job wait ${Math.round(waitMs)}ms > ${input.config.maxJobWaitMs}ms`,
        message: `不要长时间等后台任务（请求了 ${Math.round(waitMs / 1000)} 秒）。`
          + '先结束这一轮，任务完成会自己作为新事件回来；需要时下一轮再查它的结果。',
      }
    }
    if (args['wait'] === true && waitMs === undefined) {
      return {
        level: 'warn',
        reason: 'job-wait',
        detail: 'job_output with wait:true and no explicit timeout',
        message: '不要用 wait 等后台任务完成；先结束这一轮，完成事件会自己回来。',
      }
    }
    return { level: 'none' }
  }

  return { level: 'none' }
}
