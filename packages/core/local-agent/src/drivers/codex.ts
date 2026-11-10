/**
 * Codex CLI driver over its app-server JSON-RPC (stdio).
 *
 * WHY APP-SERVER, NOT `codex exec`: we need two things exec cannot give us — (1) the team
 * tools bridged back into a live turn (exec refuses MCP tool calls under
 * `approval_policy = never`), and (2) an approval seam for A4. The app-server protocol
 * declares MCP servers per thread, so the bridge's loopback server needs no user config
 * changes and no global env var.
 *
 * One app-server process per route, one thread per DSH session (mirrors DS-Bot's proven
 * mapping). A turn suspends when the agent calls a bridged tool: the driver yields a
 * `tool-call` event and keeps the process/turn alive; the adapter re-enters `stream()` with
 * that call's result, which resolves the parked MCP request and the same turn continues.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { cleanEnv } from '../discover.ts'
import { LoopbackMcp } from '../mcp.ts'
import { JsonRpcPeer, wireChild } from './jsonrpc.ts'
import type {
  AgentEvent,
  DriverModel,
  DriverMcpTool,
  DriverStreamInput,
  LocalAgentDriver,
} from './types.ts'

const INIT_TIMEOUT_MS = 30_000
const THREAD_TIMEOUT_MS = 60_000

export interface CodexDriverOptions {
  readonly route: string
  readonly name: string
  /** Absolute path resolved by discovery (PATH, npm global, or the app bundle). */
  readonly executable: string
  /** Launch arguments, e.g. `['app-server', '--listen', 'stdio://']`. */
  readonly args?: readonly string[]
}

/** One DSH session's thread + parked-tool plumbing. */
interface SessionState {
  readonly sessionId: string
  threadId: string | undefined
  turnId: string | undefined
  readonly mcp: LoopbackMcp
  mcpUrl: string | undefined
  readonly queue: AgentEvent[]
  notify: (() => void) | undefined
  closed: boolean
}

export class CodexDriver implements LocalAgentDriver {
  readonly route: string
  private readonly name: string
  private readonly executable: string
  private readonly args: readonly string[]
  private child: ChildProcess | undefined
  private peer: JsonRpcPeer | undefined
  private starting: Promise<JsonRpcPeer> | undefined
  private stderr = ''
  private readonly sessions = new Map<string, SessionState>()
  private modelsCache: readonly DriverModel[] | undefined
  private disposed = false

  constructor(options: CodexDriverOptions) {
    this.route = options.route
    this.name = options.name
    this.executable = options.executable
    this.args = options.args ?? ['app-server', '--listen', 'stdio://']
  }

  async listModels(): Promise<readonly DriverModel[]> {
    if (this.modelsCache !== undefined) return this.modelsCache
    const peer = await this.ensure()
    try {
      const reply = await peer.request('model/list', {}, { timeoutMs: INIT_TIMEOUT_MS }) as { data?: unknown }
      const data = Array.isArray(reply?.data) ? reply.data : []
      const models = data
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map(entry => ({
          id: String(entry['id'] ?? entry['model'] ?? 'default'),
          name: String(entry['displayName'] ?? entry['name'] ?? entry['id'] ?? 'default'),
        }))
      this.modelsCache = models.length === 0 ? [{ id: 'default', name: 'CLI default' }] : models
    } catch {
      this.modelsCache = [{ id: 'default', name: 'CLI default' }]
    }
    return this.modelsCache
  }

  /** Forget this conversation's thread (the app-server keeps the old thread; we stop using it). */
  resetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.mcp.close()
    this.sessions.delete(sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const session of this.sessions.values()) session.mcp.close()
    this.sessions.clear()
    const child = this.child
    this.child = undefined
    this.peer = undefined
    if (child !== undefined) {
      try { child.kill('SIGTERM') } catch { /* gone */ }
      const kill = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 3_000)
      kill.unref?.()
    }
  }

  async *stream(input: DriverStreamInput): AsyncIterable<AgentEvent> {
    if (this.disposed) throw new Error('codex driver is disposed')
    const peer = await this.ensure()
    const session = this.sessionFor(input.sessionId)

    if (input.mcp !== undefined) await this.configureBridge(session, input.mcp.tools)
    for (const result of input.toolResults ?? []) {
      session.mcp.resolve(result.callId, { text: result.text, isError: result.isError })
      const resolve = this.delegatedCalls.get(result.callId)
      if (resolve !== undefined) {
        this.delegatedCalls.delete(result.callId)
        resolve({ text: result.text, isError: result.isError })
      }
      const approval = this.pendingApprovals.get(result.callId)
      if (approval !== undefined) {
        this.pendingApprovals.delete(result.callId)
        approval(approvalDecisionOf(result))
      }
    }
    const continuing = (input.toolResults?.length ?? 0) > 0

    // A restarted app-server has no live thread even though the DSH session remembers one.
    if (session.threadId !== undefined && this.threadPeer.get(session.sessionId) !== peer) {
      await this.openThread(peer, session, input, true)
    } else if (session.threadId === undefined) {
      await this.openThread(peer, session, input, false)
    }

    if (!continuing) {
      const started = peer.request('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: input.prompt }],
        ...(input.model !== undefined && input.model !== 'default' ? { model: input.model } : {}),
      }, { timeoutMs: 0, signal: input.signal })
      started.then(
        reply => {
          const turn = (reply as { turn?: { id?: string } } | undefined)?.turn
          session.turnId = turn?.id
        },
        (error: unknown) => this.push(session, { type: 'error', error: asError(error) }),
      )
    }

    for (;;) {
      const event = await this.next(session)
      yield event
      if (event.type === 'tool-call' || event.type === 'done' || event.type === 'error') return
    }
  }

  /** Which peer each session's thread was created on (a restart invalidates it). */
  private readonly threadPeer = new Map<string, JsonRpcPeer>()
  /** Delegated dynamic tool calls (`item/tool/call`) parked until the host answers. */
  private readonly delegatedCalls = new Map<string, (result: { text: string; isError: boolean }) => void>()
  /** Parked CLI permission prompts, keyed by the synthetic DSH tool-call id. */
  private readonly pendingApprovals = new Map<string, (decision: { allow: boolean }) => void>()

  private sessionFor(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = {
        sessionId,
        threadId: undefined,
        turnId: undefined,
        mcp: new LoopbackMcp(),
        mcpUrl: undefined,
        queue: [],
        notify: undefined,
        closed: false,
      }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private async configureBridge(session: SessionState, tools: readonly DriverMcpTool[]): Promise<void> {
    session.mcpUrl = await session.mcp.listen()
    session.mcp.setTools(tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })))
    session.mcp.setCallHandler(call => {
      this.push(session, {
        type: 'tool-call',
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      })
    })
  }

  private async openThread(peer: JsonRpcPeer, session: SessionState, input: DriverStreamInput, resumeOnly: boolean): Promise<void> {
    const resumeId = session.threadId ?? input.resumeId
    if (resumeId !== undefined) {
      try {
        await peer.request('thread/resume', {
          threadId: resumeId,
          ...this.threadParams(input, session),
        }, { timeoutMs: THREAD_TIMEOUT_MS })
        session.threadId = resumeId
        this.threadPeer.set(session.sessionId, peer)
        this.push(session, { type: 'thread', threadId: resumeId })
        return
      } catch { /* thread is gone; fall through to a new one */ }
    }
    if (resumeOnly) session.threadId = undefined

    // Two config shapes are in the wild: app-server accepts `config.mcp_servers` overrides,
    // while older builds flattened `mcp_servers` onto thread params. Try the documented one
    // and fall back before giving up.
    const params = this.threadParams(input, session)
    let started: unknown
    try {
      started = await peer.request('thread/start', params, { timeoutMs: THREAD_TIMEOUT_MS })
    } catch (first) {
      const flattened = { ...params, ...(params.config ?? {}) }
      delete (flattened as { config?: unknown }).config
      try {
        started = await peer.request('thread/start', flattened, { timeoutMs: THREAD_TIMEOUT_MS })
      } catch {
        throw first
      }
    }
    const thread = (started as { thread?: { id?: unknown }; threadId?: unknown } | undefined)
    const threadId = typeof thread?.thread?.id === 'string' ? thread.thread.id
      : typeof thread?.threadId === 'string' ? thread.threadId
        : undefined
    if (threadId === undefined) throw new Error('codex app-server returned no thread id')
    session.threadId = threadId
    this.threadPeer.set(session.sessionId, peer)
    this.push(session, { type: 'thread', threadId })
  }

  private threadParams(input: DriverStreamInput, session: SessionState): Record<string, unknown> {
    // A6b: the Bot's DSH permission decides the CLI sandbox. Full access is the only mode
    // where Codex needs no approval round-trips (the DSH preset already grants everything).
    const sandbox = input.permission === 'workspace-write'
      ? 'workspace-write'
      : input.permission === 'full-access' ? 'danger-full-access' : 'read-only'
    return {
      cwd: input.cwd,
      sandbox,
      approvalPolicy: input.permission === 'full-access' ? 'never' : 'on-request',
      ...(input.model !== undefined && input.model !== 'default' ? { model: input.model } : {}),
      ...(session.mcpUrl === undefined ? {} : {
        config: {
          mcp_servers: {
            dshbot: {
              url: session.mcpUrl,
              http_headers: { Authorization: `Bearer ${session.mcp.token}` },
            },
          },
        },
      }),
    }
  }

  private async ensure(): Promise<JsonRpcPeer> {
    if (this.peer !== undefined) return this.peer
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(): Promise<JsonRpcPeer> {
    const child = spawn(this.executable, [...this.args], {
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.stderr = ''
    // A dangling app-server must never keep the host process alive after its turn finished.
    child.unref()
    process.once('exit', () => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000) })
    const peer = new JsonRpcPeer(message => {
      try { child.stdin?.write(`${JSON.stringify(message)}\n`) } catch { /* child gone */ }
    })
    wireChild(child, peer)
    peer.notificationHandler = (method, params) => this.onNotification(method, params)
    peer.requestHandler = (method, params) => this.onServerRequest(method, params)
    child.on('exit', code => {
      const reason = new Error(`codex app-server exited ${String(code)}${this.stderr === '' ? '' : `: ${this.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`}`)
      peer.close(reason)
      if (this.peer === peer) { this.peer = undefined; this.child = undefined }
      for (const session of this.sessions.values()) {
        this.push(session, { type: 'error', error: reason })
        session.threadId = undefined
        this.threadPeer.delete(session.sessionId)
      }
    })
    try {
      await peer.request('initialize', {
        clientInfo: { name: 'dsh-local-agent', title: 'DSH Local Agent', version: '1' },
      }, { timeoutMs: INIT_TIMEOUT_MS })
      peer.notify('initialized', {})
    } catch (error) {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      throw error
    }
    this.peer = peer
    return peer
  }


  private onNotification(method: string, params: unknown): void {
    const record = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {}
    const threadId = typeof record['threadId'] === 'string' ? record['threadId'] : undefined
    const session = threadId === undefined ? undefined : this.byThread(threadId)
    switch (method) {
      case 'item/started': {
        const item = asRecord(record['item'])
        if (item === undefined) break
        const type = String(item['type'] ?? '')
        if (type === 'commandExecution') {
          this.push(session, { type: 'activity', text: `Run ${truncate(String(item['command'] ?? 'a command'), 160)}` })
        } else if (type === 'fileChange') {
          this.push(session, { type: 'activity', text: 'Edit files' })
        } else if (type === 'mcpToolCall' && item['server'] !== 'dshbot') {
          this.push(session, { type: 'activity', text: `Tool ${String(item['tool'] ?? 'call')}` })
        }
        break
      }
      case 'item/completed': {
        const item = asRecord(record['item'])
        if (item === undefined) break
        const type = String(item['type'] ?? '')
        if (type === 'agentMessage') {
          const text = typeof item['text'] === 'string' ? item['text'] : ''
          if (text !== '') this.push(session, { type: 'text', text })
        } else if (type === 'reasoning') {
          const text = reasoningText(item)
          if (text !== '') this.push(session, { type: 'thought', text })
        } else if (type === 'commandExecution') {
          const status = String(item['status'] ?? '')
          if (status === 'failed') this.push(session, { type: 'activity', text: 'Run failed' })
        } else if (type === 'mcpToolCall' && item['server'] !== 'dshbot') {
          this.push(session, { type: 'activity', text: `Tool ${String(item['tool'] ?? 'call')} done` })
        }
        break
      }
      case 'turn/completed': {
        const turn = asRecord(record['turn'])
        const status = String(turn?.['status'] ?? 'completed')
        if (status === 'failed') {
          const error = asRecord(turn?.['error'])
          this.push(session, { type: 'error', error: new Error(String(error?.['message'] ?? 'the turn failed')) })
        } else if (status === 'interrupted') {
          this.push(session, { type: 'done', reason: 'interrupted' })
        } else {
          this.push(session, { type: 'done' })
        }
        break
      }
      case 'thread/tokenUsage/updated': {
        const usage = asRecord(record['tokenUsage'])
        const last = asRecord(usage?.['last'])
        if (last !== undefined) this.push(session, { type: 'usage', usage: usageOf(last) })
        break
      }
      case 'error': {
        // Transient reconnect notices carry willRetry; a real failure also ends the turn.
        if (record['willRetry'] === true) break
        const error = asRecord(record['error'])
        this.push(session, { type: 'error', error: new Error(String(error?.['message'] ?? 'codex reported an error')) })
        break
      }
      default: break
    }
  }

  /**
   * Server-initiated requests. A3 declines everything deterministically so a turn can never
   * hang on a dialog nobody can see; A4 replaces the command/file-changes branch with the
   * DSH approval bridge.
   */
  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    const record = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {}
    const threadId = typeof record['threadId'] === 'string' ? record['threadId'] : undefined
    const session = threadId === undefined ? undefined : this.byThread(threadId)

    if (method === 'item/tool/call') {
      // Codex delegates a client-declared tool's execution back to us. Park the JSON-RPC
      // response, hand the call to DSH as an ordinary tool call, and answer with the result
      // the host supplies on the next stream.
      const callId = String(record['callId'] ?? '')
      const tool = normalizeToolName(String(record['tool'] ?? ''))
      const args = record['arguments'] !== null && typeof record['arguments'] === 'object'
        ? record['arguments'] as Record<string, unknown>
        : {}
      if (callId === '' || tool === '') return { contentItems: [{ type: 'inputText', text: 'invalid delegated tool call' }], success: false }
      const result = await new Promise<{ text: string; isError: boolean }>(resolve => {
        this.delegatedCalls.set(callId, resolve)
        this.push(session, { type: 'tool-call', callId, name: tool, arguments: args })
      })
      return { contentItems: [{ type: 'inputText', text: result.text }], success: !result.isError }
    }

    // CLI permission prompts. Each becomes one DSH `approve_agent_action` call: the user
    // decides through the ordinary approval service, and only an explicit allow proceeds.
    const approvalAction = (): { action: string; detail: string } | undefined => {
      switch (method) {
        case 'mcpServer/elicitation/request': {
          const meta = record['_meta'] !== null && typeof record['_meta'] === 'object' ? record['_meta'] as Record<string, unknown> : {}
          if (meta['codex_approval_kind'] !== 'mcp_tool_call') return undefined
          const message = typeof record['message'] === 'string' ? record['message'] : 'The agent asks to call an MCP tool'
          const tool = typeof meta['tool_description'] === 'string' ? meta['tool_description'] : ''
          const params = meta['tool_params'] !== null && typeof meta['tool_params'] === 'object' ? JSON.stringify(meta['tool_params']) : ''
          return { action: message, detail: [tool, params].filter(Boolean).join('\n').slice(0, 4_000) }
        }
        case 'item/commandExecution/requestApproval':
          return {
            action: 'The agent asks to run a command',
            detail: [record['command'], record['reason']].filter(part => typeof part === 'string').join('\n').slice(0, 4_000),
          }
        case 'item/fileChange/requestApproval':
          return {
            action: 'The agent asks to change files',
            detail: [record['reason'], record['grantRoot']].filter(part => typeof part === 'string').join('\n').slice(0, 4_000),
          }
        case 'execCommandApproval':
        case 'applyPatchApproval':
          return {
            action: method === 'execCommandApproval' ? 'The agent asks to run a command' : 'The agent asks to apply a patch',
            detail: [record['command'], record['reason']].filter(part => typeof part === 'string').join('\n').slice(0, 4_000),
          }
        default:
          return undefined
      }
    }
    const approval = approvalAction()
    if (approval !== undefined) {
      const callId = `approval-${randomUUID()}`
      const decision = await new Promise<{ allow: boolean }>(resolve => {
        this.pendingApprovals.set(callId, resolve)
        this.push(session, {
          type: 'tool-call',
          callId,
          name: 'approve_agent_action',
          arguments: { action: approval.action, ...(approval.detail === '' ? {} : { detail: approval.detail }) },
        })
      })
      switch (method) {
        case 'mcpServer/elicitation/request':
          return decision.allow ? { action: 'accept', content: {} } : { action: 'decline' }
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          return { decision: decision.allow ? 'accept' : 'decline' }
        default:
          return { decision: decision.allow ? 'approved' : 'denied' }
      }
    }
    if (method === 'item/permissions/requestApproval') {
      // Additional sandbox permissions are never granted through this bridge (fail closed).
      this.push(session, { type: 'activity', text: 'The agent asked for extra sandbox permissions — denied (not bridged in v1)' })
      return { permissions: null }
    }
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' }
    throw new Error(`unsupported app-server request: ${method}`)
  }

  private byThread(threadId: string): SessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) return session
    }
    return undefined
  }

  private push(session: SessionState | undefined, event: AgentEvent): void {
    if (session === undefined || session.closed) return
    session.queue.push(event)
    const notify = session.notify
    session.notify = undefined
    notify?.()
  }

  private next(session: SessionState): Promise<AgentEvent> {
    const queued = session.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (session.closed) return Promise.reject(new Error('codex session closed'))
    return new Promise<AgentEvent>(resolve => {
      session.notify = () => {
        const event = session.queue.shift()
        if (event !== undefined) resolve(event)
      }
    })
  }
}

/** `mcp__server__tool`, `server.tool` and bare names all reach DSH as the bare tool name. */
function normalizeToolName(tool: string): string {
  const trimmed = tool.trim()
  if (trimmed === '') return ''
  const parts = trimmed.split(/__|\./)
  return parts[parts.length - 1] ?? trimmed
}

/** Fail-closed: only a well-formed {"decision":"allow"} from the DSH tool counts. */
function approvalDecisionOf(result: { text: string; isError: boolean }): { allow: boolean } {
  if (result.isError) return { allow: false }
  try {
    const parsed = JSON.parse(result.text) as { decision?: unknown }
    return { allow: parsed !== null && typeof parsed === 'object' && parsed.decision === 'allow' }
  } catch {
    return { allow: false }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function reasoningText(item: Record<string, unknown>): string {
  const content = item['content']
  if (Array.isArray(content)) {
    const text = content
      .map(part => (part !== null && typeof part === 'object' ? (part as Record<string, unknown>)['text'] : undefined))
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
    if (text !== '') return text
  }
  const summary = item['summary']
  if (typeof summary === 'string') return summary
  return ''
}

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

function usageOf(last: Record<string, unknown>): TokenUsage {
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    inputTokens: number(last['inputTokens']),
    outputTokens: number(last['outputTokens']),
    ...(number(last['cachedInputTokens']) === 0 ? {} : { cacheReadTokens: number(last['cachedInputTokens']) }),
    ...(number(last['reasoningOutputTokens']) === 0 ? {} : { reasoningTokens: number(last['reasoningOutputTokens']) }),
  }
}
