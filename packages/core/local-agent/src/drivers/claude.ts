/**
 * Native Claude Code driver — `claude -p --output-format stream-json`.
 *
 * One CLI process per turn (the -p mode is one-shot), with `--resume <session>` for
 * continuation. The team-tool bridge is the same loopback MCP server the other drivers use:
 * `--mcp-config` declares it, Claude calls an `mcp__dshbot__*` tool, the MCP handler parks and
 * pushes a tool-call event, and the next stream call resolves it with DSH's tool result.
 *
 * Permission mapping (A6b): the Bot's DSH permission is not yet wired to `--permission-mode`;
 * this driver launches with Claude's default permission mode plus `--allowedTools mcp__dshbot`
 * so team tools (which DSH itself gates) do not double-prompt. File/shell permission presets
 * remain on Claude's side until the mode bridge lands.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { cleanEnv } from '../discover.ts'
import { LoopbackMcp } from '../mcp.ts'
import type { AgentEvent, DriverModel, DriverMcpTool, DriverStreamInput, LocalAgentDriver } from './types.ts'

export interface ClaudeDriverOptions {
  readonly route: string
  readonly name: string
  readonly executable: string
  readonly args?: readonly string[]
}

interface ClaudeSessionState {
  readonly sessionId: string
  readonly queue: AgentEvent[]
  notify: (() => void) | undefined
  readonly mcp: LoopbackMcp
  resumeId: string | undefined
  child: ChildProcess | undefined
  emitText: boolean
  ended: boolean
}

const RESULT_TIMEOUT_MS = 10 * 60_000

export class ClaudeDriver implements LocalAgentDriver {
  readonly route: string
  private readonly name: string
  private readonly executable: string
  private readonly baseArgs: readonly string[]
  private readonly sessions = new Map<string, ClaudeSessionState>()
  private disposed = false

  constructor(options: ClaudeDriverOptions) {
    this.route = options.route
    this.name = options.name
    this.executable = options.executable
    this.baseArgs = options.args ?? []
  }

  async listModels(): Promise<readonly DriverModel[]> {
    return [{ id: 'default', name: 'agent default' }]
  }

  /** Forget this conversation's CLI process/`--resume` id. */
  resetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.mcp.close()
    try { session.child?.kill('SIGTERM') } catch { /* gone */ }
    this.sessions.delete(sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const session of this.sessions.values()) {
      session.mcp.close()
      try { session.child?.kill('SIGTERM') } catch { /* gone */ }
    }
    this.sessions.clear()
  }

  async *stream(input: DriverStreamInput): AsyncIterable<AgentEvent> {
    if (this.disposed) throw new Error('claude driver is disposed')
    const session = this.sessionFor(input.sessionId)
    if (input.mcp !== undefined) await this.configureBridge(session, input.mcp.tools)
    for (const result of input.toolResults ?? []) {
      session.mcp.resolve(result.callId, { text: result.text, isError: result.isError })
    }
    const continuing = (input.toolResults?.length ?? 0) > 0
    if (!continuing) this.startTurn(session, input)

    for (;;) {
      const event = await this.next(session)
      yield event
      if (event.type === 'tool-call' || event.type === 'done' || event.type === 'error') return
    }
  }

  private sessionFor(sessionId: string): ClaudeSessionState {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = {
        sessionId,
        queue: [],
        notify: undefined,
        mcp: new LoopbackMcp(),
        resumeId: undefined,
        child: undefined,
        emitText: false,
        ended: false,
      }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private async configureBridge(session: ClaudeSessionState, tools: readonly DriverMcpTool[]): Promise<void> {
    await session.mcp.listen()
    session.mcp.setTools(tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })))
    session.mcp.setCallHandler(call => {
      this.push(session, { type: 'tool-call', callId: call.callId, name: call.name, arguments: call.arguments })
    })
  }

  private startTurn(session: ClaudeSessionState, input: DriverStreamInput): void {
    session.emitText = false
    session.ended = false
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'mcp__dshbot',
      // A6b: map the Bot permission onto Claude's own permission mode. full-access uses the
      // dedicated flag because bypassPermissions is not accepted in -p mode on every build.
      ...(input.permission === 'workspace-write'
        ? ['--permission-mode', 'acceptEdits']
        : input.permission === 'full-access'
          ? ['--dangerously-skip-permissions']
          : input.permission === 'read-only' ? ['--permission-mode', 'plan'] : []),
      ...this.baseArgs,
      ...(input.resumeId === undefined ? [] : ['--resume', input.resumeId]),
      ...(input.model !== undefined && input.model !== 'default' ? ['--model', input.model] : []),
    ]
    const mcpConfig = this.mcpConfig(session)
    if (mcpConfig !== undefined) args.push('--mcp-config', mcpConfig)

    const child = spawn(this.executable, args, {
      cwd: input.cwd,
      // The CLI's own auth/config env is part of "the agent's own login": Anthropic relays and
      // cc-switch-style launchers configure Claude Code through ANTHROPIC_* variables, and
      // stripping them made a working setup look like 'Not logged in'. DSH_* stays dropped.
      env: { ...cleanEnv(), ...claudeAuthEnv() },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    session.child = child
    child.unref()
    process.once('exit', () => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    child.stdin?.write(input.prompt)
    child.stdin?.end()

    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => this.onLine(session, line))
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 2_000) })
    child.on('exit', code => {
      session.child = undefined
      if (!session.ended) {
        session.ended = true
        this.push(session, { type: 'error', error: new Error(stderr.trim() === '' ? `claude exited ${String(code)}` : stderr.trim()) })
      }
    })
    const timer = setTimeout(() => {
      if (session.ended) return
      session.ended = true
      try { child.kill('SIGTERM') } catch { /* gone */ }
      this.push(session, { type: 'error', error: new Error('claude turn timed out') })
    }, RESULT_TIMEOUT_MS)
    timer.unref?.()
    child.on('exit', () => { clearTimeout(timer) })
  }

  /** `--mcp-config` accepts an inline JSON string. */
  private mcpConfig(session: ClaudeSessionState): string | undefined {
    const url = session.mcp.url
    if (url === undefined) return undefined
    return JSON.stringify({
      mcpServers: {
        dshbot: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${session.mcp.token}` },
        },
      },
    })
  }

  private onLine(session: ClaudeSessionState, line: string): void {
    if (line.trim() === '') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(message['type'] ?? '')
    if (type === 'system' && message['subtype'] === 'init') {
      const sessionId = message['session_id']
      if (typeof sessionId === 'string') {
        session.resumeId = sessionId
        this.push(session, { type: 'thread', threadId: sessionId })
      }
      return
    }
    if (type === 'assistant') {
      const content = asRecord(message['message'])?.['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          const record = asRecord(block)
          if (record === undefined) continue
          if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text'] !== '') {
            session.emitText = true
            this.push(session, { type: 'text', text: record['text'] })
          } else if (record['type'] === 'tool_use') {
            const name = typeof record['name'] === 'string' ? record['name'] : 'tool'
            // MCP team tools reach us through the loopback MCP handler (and DSH executes them);
            // the assistant echo is only an activity line so the transcript stays readable.
            this.push(session, { type: 'activity', text: `调用工具 ${name}` })
          }
        }
      }
      return
    }
    if (type === 'result') {
      if (session.ended) return
      session.ended = true
      const usage = usageOf(message['usage'])
      if (usage !== undefined) this.push(session, { type: 'usage', usage })
      if (message['is_error'] === true) {
        const text = typeof message['result'] === 'string' && message['result'] !== '' ? message['result'] : 'claude reported an error'
        // Surface the CLI's own reason in the transcript before failing the turn. Without it a
        // not-logged-in run settles as an empty turn and the room only shows a generic
        // "模型输出为空" diagnosis (measured 2026-11-10); the actual cause is right here.
        this.push(session, { type: 'activity', text: `Claude Code: ${text}` })
        this.push(session, { type: 'error', error: new Error(text) })
        return
      }
      if (!session.emitText && typeof message['result'] === 'string' && message['result'] !== '') {
        this.push(session, { type: 'text', text: message['result'] })
      }
      this.push(session, { type: 'done' })
    }
  }

  private push(session: ClaudeSessionState, event: AgentEvent): void {
    session.queue.push(event)
    const notify = session.notify
    session.notify = undefined
    notify?.()
  }

  private next(session: ClaudeSessionState): Promise<AgentEvent> {
    const queued = session.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<AgentEvent>(resolve => {
      session.notify = () => {
        const event = session.queue.shift()
        if (event !== undefined) resolve(event)
      }
    })
  }
}

/** Pass through only Claude Code's own auth/config environment. */
function claudeAuthEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(?:ANTHROPIC_|CLAUDE_CODE_)/.test(key)) continue
    if (value !== undefined) env[key] = value
  }
  return env
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function usageOf(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (usage === undefined) return undefined
  const number = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : 0)
  return { inputTokens: number('input_tokens'), outputTokens: number('output_tokens') }
}
