/**
 * Host wiring for the no-wait guard (S0-6): a `tools.guard()` that refuses blocking waits in a
 * BOT session only.
 *
 * WHY A GUARD AND NOT A PROMPT RULE. The prompt already tells a bot to use background jobs (the
 * `bots:async` section), but prompts are advisory: a model that types `sleep 30` still freezes the
 * turn. `tools.guard()` is the one plugin-level hook that runs after pre-execute/approval and
 * before the tool body, so it can stop the call with a model-readable reason. The classifier in
 * `no-wait.ts` decides WHAT counts; this file decides WHO it applies to and what the host sees.
 *
 * SCOPE. Only sessions this plugin owns (`ac:<roomId>:<botId>`, parsed by `SessionRunner`) are
 * checked. The user's own DSH tools are never affected — a human is allowed to run a long
 * command in their own session.
 *
 * DEGRADATION. Every step is optional: a host without `tools.guard()` simply logs that the guard
 * is unavailable; a thrown guard never breaks the tool pipeline (fail-open is the safe direction
 * for an advisory check, and the prompt rule still applies).
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { optionalService, SessionRunner } from './session-runner.ts'
import { inspectToolCall, normalizeNoWait, type NoWaitConfig } from './no-wait.ts'

interface ToolGuardHost {
  guard?(check: (exec: unknown) => string | undefined): unknown
}

/** The bot-session id on a guard/pre-execute execution, across host shapes. */
function sessionIdOf(exec: unknown): string | undefined {
  if (exec === null || typeof exec !== 'object') return undefined
  const view = exec as {
    sessionId?: unknown
    session?: { id?: unknown }
    agent?: { session?: { id?: unknown } }
    execution?: { sessionId?: unknown }
  }
  const candidates = [
    view.agent?.session?.id,
    view.session?.id,
    view.sessionId,
    view.execution?.sessionId,
  ]
  return candidates.find((value): value is string => typeof value === 'string' && value !== '')
}

export class NoWaitGuard {
  private readonly config: NoWaitConfig

  constructor(
    private readonly ctx: Context,
    config: unknown,
    private readonly note: (message: string) => void = () => undefined,
  ) {
    // `config` is the raw plugin-config value: its mode is a plain string at the schema
    // boundary, so normalization (and the fallback to `observe`) lives in `no-wait.ts`.
    this.config = normalizeNoWait(config as Partial<NoWaitConfig> | undefined)
  }

  /** Register the guard. Returns a disposer (best-effort). */
  install(): () => void {
    if (this.config.mode === 'off') {
      this.note('no-wait guard disabled by config')
      return () => undefined
    }
    const tools = optionalService<ToolGuardHost>(this.ctx, 'tools')
    if (tools?.guard === undefined) {
      this.note('no-wait guard unavailable (no ctx.tools.guard on this runtime)')
      return () => undefined
    }
    try {
      const dispose = tools.guard(exec => this.check(exec))
      this.note(`no-wait guard installed (${this.config.mode})`)
      return typeof dispose === 'function' ? dispose as () => void : () => undefined
    } catch (error: unknown) {
      this.note(`no-wait guard failed to register: ${String(error)}`)
      return () => undefined
    }
  }

  /** The synchronous check the host runs. Return a string to refuse, undefined to allow. */
  private check(exec: unknown): string | undefined {
    try {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) return undefined
      // BOT SESSIONS ONLY: the user's own session must never be throttled by this plugin.
      if (SessionRunner.parseSessionId(sessionId) === undefined) return undefined
      const view = exec as { name?: unknown; arguments?: unknown }
      const tool = typeof view.name === 'string' ? view.name : undefined
      const verdict = inspectToolCall({ tool, args: view.arguments, config: this.config })
      if (verdict.level === 'none') return undefined
      if (this.config.mode === 'observe' || verdict.level === 'warn') {
        this.note(`no-wait ${this.config.mode}: ${tool ?? '?'} ${verdict.detail}`)
        return undefined
      }
      this.note(`no-wait refused: ${tool ?? '?'} ${verdict.detail}`)
      return verdict.message
    } catch (error: unknown) {
      // A guard must never break the pipeline; fail open and leave a line for diagnosis.
      this.note(`no-wait guard check failed: ${String(error)}`)
      return undefined
    }
  }
}
