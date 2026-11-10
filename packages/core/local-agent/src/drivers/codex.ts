/**
 * Codex CLI driver: `codex exec --json` for a new thread, `codex exec resume <id> --json` for
 * the next one.
 *
 * WHY NOT THE APP-SERVER PROTOCOL YET. `exec --json` already carries everything A2 needs
 * (thread id, agent text, usage, failure) with no long-lived process to babysit; the
 * app-server driver buys approvals/streaming and lands with A4/A6 when there is a UI to use
 * them. The CLI found here may be the one bundled inside ChatGPT.app — discovery reports its
 * absolute path, so this driver never assumes PATH.
 *
 * @module
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { cleanEnv } from '../discover.ts'
import type { AgentEvent, DriverModel, DriverStreamInput, LocalAgentDriver } from './types.ts'

const RESUME_TIMEOUT_MS = 10 * 60_000

export interface CodexDriverOptions {
  readonly route: string
  readonly name: string
  /** Absolute path resolved by discovery (PATH, npm global, or the app bundle). */
  readonly executable: string
}

interface Queued {
  readonly events: AgentEvent[]
  notify: (() => void) | undefined
  closed: boolean
}

export class CodexDriver implements LocalAgentDriver {
  readonly route: string
  private readonly name: string
  private readonly executable: string
  private readonly children = new Set<ChildProcess>()
  private disposed = false

  constructor(options: CodexDriverOptions) {
    this.route = options.route
    this.name = options.name
    this.executable = options.executable
  }

  async listModels(): Promise<readonly DriverModel[]> {
    // The CLI reports no machine-readable model list on `exec`; the config's default is the
    // honest answer for A2. A5 reads the configured catalog (`model_catalog_json`).
    return [{ id: 'default', name: 'CLI default' }]
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const child of this.children) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    this.children.clear()
  }

  async *stream(input: DriverStreamInput): AsyncIterable<AgentEvent> {
    if (this.disposed) throw new Error('codex driver is disposed')
    const args = this.argsFor(input)
    const child = spawn(this.executable, args, {
      cwd: input.cwd,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.children.add(child)

    const queued: Queued = { events: [], notify: undefined, closed: false }
    const push = (event: AgentEvent): void => {
      if (queued.closed) return
      queued.events.push(event)
      const notify = queued.notify
      queued.notify = undefined
      notify?.()
    }
    const close = (event?: AgentEvent): void => {
      if (queued.closed) return
      if (event !== undefined) queued.events.push(event)
      queued.closed = true
      const notify = queued.notify
      queued.notify = undefined
      notify?.()
    }

    let stderr = ''
    let turnCompleted = false
    let turnFailed = false
    let sawAgentText = false
    let buffer = ''
    const onLine = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed === '') return
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { return }
      if (parsed === null || typeof parsed !== 'object') return
      const event = parsed as Record<string, unknown>
      const type = event['type']
      if (type === 'thread.started') {
        const threadId = event['thread_id']
        if (typeof threadId === 'string' && threadId !== '') push({ type: 'thread', threadId })
        return
      }
      if (type === 'item.completed') {
        const item = event['item']
        if (item === null || typeof item !== 'object') return
        const record = item as Record<string, unknown>
        const itemType = record['type']
        const text = typeof record['text'] === 'string' ? record['text'] : ''
        if (itemType === 'agent_message') {
          if (text !== '') { sawAgentText = true; push({ type: 'text', text }) }
          return
        }
        if (itemType === 'reasoning') {
          if (text !== '') push({ type: 'thought', text })
          return
        }
        if (itemType === 'error') return // config warnings / transient notices
        // Tool-ish items become one activity line each, the same way DS-Bot renders CLI work.
        if (itemType === 'command_execution') {
          const command = typeof record['command'] === 'string' ? record['command'] : ''
          push({ type: 'activity', text: `Run ${command === '' ? 'a command' : `\`${truncate(command, 160)}\``}` })
          return
        }
        if (itemType === 'file_change') {
          const changes = Array.isArray(record['changes']) ? record['changes'] : []
          const paths = changes
            .map(change => (change !== null && typeof change === 'object' ? (change as Record<string, unknown>)['path'] : undefined))
            .filter((path): path is string => typeof path === 'string')
          push({ type: 'activity', text: `Edit ${paths.length === 0 ? 'files' : paths.map(path => `\`${truncate(path, 80)}\``).join(', ')}` })
          return
        }
        push({ type: 'activity', text: String(itemType) })
        return
      }
      if (type === 'turn.completed') {
        turnCompleted = true
        const usage = event['usage']
        if (usage !== null && typeof usage === 'object') {
          const record = usage as Record<string, unknown>
          push({ type: 'usage', usage: tokenUsageOf(record) })
        }
        return
      }
      if (type === 'turn.failed') {
        turnFailed = true
        const error = event['error']
        const message = error !== null && typeof error === 'object'
          ? String((error as Record<string, unknown>)['message'] ?? 'codex turn failed')
          : 'codex turn failed'
        push({ type: 'error', error: new Error(message) })
        return
      }
      // Top-level `error` events are Codex's transient notices ("Reconnecting..."). They are
      // not turn failure: a real failure arrives as `turn.failed`.
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })

    const onAbort = (): void => {
      try { child.kill('SIGTERM') } catch { /* race with exit */ }
      const kill = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 3_000)
      kill.unref?.()
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }, RESUME_TIMEOUT_MS)
    timer.unref?.()

    child.on('error', error => { close({ type: 'error', error }) })
    child.on('close', code => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      this.children.delete(child)
      if (buffer !== '') { onLine(buffer); buffer = '' }
      if (turnFailed) { close(); return }
      if (input.signal?.aborted) { close({ type: 'done', reason: 'aborted' }); return }
      if (turnCompleted) { close({ type: 'done' }); return }
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
      close({ type: 'error', error: new Error(`codex exited ${String(code)}${detail === '' ? '' : `: ${detail}`}${sawAgentText ? '' : ' (no agent message)'}`) })
    })

    try {
      while (!queued.closed || queued.events.length > 0) {
        const next = queued.events.shift()
        if (next !== undefined) { yield next; continue }
        await new Promise<void>(resolve => { queued.notify = resolve })
      }
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (!queued.closed) {
        try { child.kill('SIGKILL') } catch { /* gone */ }
        this.children.delete(child)
      }
    }
  }

  private argsFor(input: DriverStreamInput): string[] {
    const resumed = input.resumeId !== undefined && input.resumeId !== ''
    const args = resumed
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', input.resumeId as string]
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', input.cwd]
    // The model flag is a NEW-thread choice; a resumed thread keeps its own model (A5 adds
    // runtime switching through the config option surface, not by re-flagging a resume).
    if (!resumed && input.model !== undefined && input.model !== 'default') args.push('--model', input.model)
    // Replay is bounded (12 messages / 24 KB) and a delta is normally small, so the prompt
    // fits argv comfortably; stdin is not used because `exec resume` does not read it reliably.
    args.push(input.prompt)
    return args
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function tokenUsageOf(record: Record<string, unknown>): TokenUsage {
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    inputTokens: number(record['input_tokens']),
    outputTokens: number(record['output_tokens']),
    ...(number(record['cached_input_tokens']) === 0 ? {} : { cacheReadTokens: number(record['cached_input_tokens']) }),
    ...(number(record['reasoning_output_tokens']) === 0 ? {} : { reasoningTokens: number(record['reasoning_output_tokens']) }),
  }
}
