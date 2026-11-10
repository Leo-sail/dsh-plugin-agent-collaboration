/**
 * Agent Client Protocol (ACP v1) driver — one child process per route, one ACP session per
 * DSH session.
 *
 * ACP is JSON-RPC over newline-delimited stdio, which is exactly what `JsonRpcPeer` already
 * speaks, so this file is the protocol mapping only: initialize → session/new (or
 * session/load) → session/prompt, plus the agent → client permission request and the
 * session/update notifications. MCP servers are declared in `session/new`, which is how the
 * same loopback team-tool bridge Codex uses reaches ACP agents.
 *
 * The long tail of local agents (Gemini CLI, Grok Build, OpenCode, Cline, Cursor, Goose, Qwen
 * Code, custom `acp-<id>` agents) all ride this one driver. Data-driven engines live in
 * `engines.ts`; no per-agent code here.
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
const SESSION_TIMEOUT_MS = 60_000

export interface AcpDriverOptions {
  readonly route: string
  readonly name: string
  readonly executable: string
  /** Launch args, e.g. `['--acp']` or `['agent', 'stdio']`. */
  readonly args?: readonly string[]
  /** Extra environment for this engine (e.g. CLINE_SESSION_BACKEND_MODE). */
  readonly env?: Readonly<Record<string, string>>
}

interface AcpSessionReply {
  readonly sessionId?: unknown
  readonly configOptions?: unknown
}

interface AcpCapabilities {
  readonly loadSession: boolean
  readonly mcpHttp: boolean
}

interface AcpSessionState {
  readonly sessionId: string
  acpSessionId: string | undefined
  readonly queue: AgentEvent[]
  notify: (() => void) | undefined
  readonly mcp: LoopbackMcp
  /** Set once we know the agent cannot accept HTTP MCP servers (degradation). */
  mcpSuppressed?: boolean
  /** Model options the agent advertised in this session (`configOptions`). */
  modelOptions?: readonly DriverModel[]
  /** Model currently selected on the agent side. */
  currentModel?: string
}

export class AcpDriver implements LocalAgentDriver {
  readonly route: string
  private readonly name: string
  private readonly executable: string
  private readonly args: readonly string[]
  private readonly extraEnv: Readonly<Record<string, string>>
  private child: ChildProcess | undefined
  private peer: JsonRpcPeer | undefined
  private starting: Promise<JsonRpcPeer> | undefined
  private capabilities: AcpCapabilities = { loadSession: false, mcpHttp: false }
  private readonly sessions = new Map<string, AcpSessionState>()
  /** Parked permission prompts keyed by the synthetic DSH tool-call id. */
  private readonly pendingApprovals = new Map<string, (decision: { allow: boolean }) => void>()
  private modelsCache: readonly DriverModel[] = [{ id: 'default', name: 'agent default' }]
  private disposed = false

  constructor(options: AcpDriverOptions) {
    this.route = options.route
    this.name = options.name
    this.executable = options.executable
    this.args = options.args ?? []
    this.extraEnv = options.env ?? {}
  }

  async listModels(): Promise<readonly DriverModel[]> {
    // ACP model options are advertised per session (`configOptions`); after the first
    // session they are the real catalog. Before that the agent default is the honest answer.
    return this.modelsCache
  }

  /** Apply a session-scoped model switch immediately on the live ACP session. */
  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    const peer = this.peer
    if (session === undefined || session.acpSessionId === undefined || peer === undefined) return
    await peer.request('session/set_config_option', {
      sessionId: session.acpSessionId,
      configId: 'model',
      value: model,
    }, { timeoutMs: 15_000 })
    session.currentModel = model
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const session of this.sessions.values()) {
      session.mcp.close()
      this.peer?.notify('session/cancel', { sessionId: session.acpSessionId })
    }
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
    if (this.disposed) throw new Error('acp driver is disposed')
    const peer = await this.ensure()
    const session = this.sessionFor(input.sessionId)

    if (input.mcp !== undefined) await this.configureBridge(session, input.mcp.tools)
    for (const result of input.toolResults ?? []) {
      session.mcp.resolve(result.callId, { text: result.text, isError: result.isError })
      const approval = this.pendingApprovals.get(result.callId)
      if (approval !== undefined) {
        this.pendingApprovals.delete(result.callId)
        approval(approvalDecisionOf(result))
      }
    }
    const continuing = (input.toolResults?.length ?? 0) > 0

    if (session.acpSessionId === undefined) await this.openSession(peer, session, input)
    if (!continuing) this.startPrompt(peer, session, input)

    for (;;) {
      const event = await this.next(session)
      yield event
      if (event.type === 'tool-call' || event.type === 'done' || event.type === 'error') return
    }
  }

  /** Read `configOptions` (model selector) out of a session/new|load reply. */
  private adoptSessionOptions(session: AcpSessionState, reply: AcpSessionReply | undefined): void {
    const options = Array.isArray(reply?.configOptions) ? reply.configOptions : []
    for (const option of options) {
      if (option === null || typeof option !== 'object') continue
      const record = option as Record<string, unknown>
      const id = String(record['id'] ?? record['category'] ?? '')
      if (id !== 'model') continue
      const entries = Array.isArray(record['options']) ? record['options'] : []
      const models: DriverModel[] = []
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        const value = (entry as Record<string, unknown>)['value'] ?? (entry as Record<string, unknown>)['id']
        if (typeof value !== 'string') continue
        const name = (entry as Record<string, unknown>)['name']
        models.push({ id: value, name: typeof name === 'string' ? name : value })
      }
      if (models.length > 0) {
        session.modelOptions = models
        this.modelsCache = models
      }
      const current = record['currentValue'] ?? record['currentValueId']
      if (typeof current === 'string') session.currentModel = current
    }
  }

  /** Apply the request's model selection to a freshly created/resumed session. */
  private async applyRequestedModel(peer: JsonRpcPeer, session: AcpSessionState, model: string | undefined): Promise<void> {
    if (model === undefined || model === 'default' || session.acpSessionId === undefined) return
    try {
      await peer.request('session/set_config_option', {
        sessionId: session.acpSessionId,
        configId: 'model',
        value: model,
      }, { timeoutMs: 15_000 })
      session.currentModel = model
    } catch {
      // The agent may not accept runtime model selection; the turn proceeds on its default.
    }
  }

  private sessionFor(sessionId: string): AcpSessionState {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = { sessionId, acpSessionId: undefined, queue: [], notify: undefined, mcp: new LoopbackMcp() }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private async configureBridge(session: AcpSessionState, tools: readonly DriverMcpTool[]): Promise<void> {
    await session.mcp.listen()
    session.mcp.setTools(tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })))
    session.mcp.setCallHandler(call => {
      this.push(session, { type: 'tool-call', callId: call.callId, name: call.name, arguments: call.arguments })
    })
  }

  private mcpServers(session: AcpSessionState): unknown[] {
    if (session.mcpSuppressed === true) return []
    const url = session.mcp.url
    if (url === undefined) return []
    return [{
      type: 'http',
      name: 'dshbot',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${session.mcp.token}` }],
    }]
  }

  private async openSession(peer: JsonRpcPeer, session: AcpSessionState, input: DriverStreamInput): Promise<void> {
    let mcpServers = this.mcpServers(session)
    if (mcpServers.length > 0 && this.capabilities.mcpHttp === false) {
      // Honest degradation: no tools for this agent, text/permissions/sessions still work.
      session.mcpSuppressed = true
      mcpServers = []
      this.push(session, { type: 'activity', text: 'This agent does not accept HTTP MCP servers; team tools unavailable for this session' })
    }
    const resumeId = session.acpSessionId ?? input.resumeId
    if (resumeId !== undefined) {
      try {
        const loaded = await peer.request('session/load', { sessionId: resumeId, cwd: input.cwd, mcpServers }, { timeoutMs: SESSION_TIMEOUT_MS }) as AcpSessionReply
        session.acpSessionId = typeof loaded?.sessionId === 'string' ? loaded.sessionId : resumeId
        this.adoptSessionOptions(session, loaded)
        await this.applyRequestedModel(peer, session, input.model)
        this.push(session, { type: 'thread', threadId: session.acpSessionId })
        return
      } catch {
        // loadSession is not mandatory in ACP; fall through to a fresh session (adapter replays).
        session.acpSessionId = undefined
      }
    }
    const created = await peer.request('session/new', { cwd: input.cwd, mcpServers }, { timeoutMs: SESSION_TIMEOUT_MS }) as AcpSessionReply
    if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
      throw new Error('acp agent returned no session id')
    }
    session.acpSessionId = created.sessionId
    this.adoptSessionOptions(session, created)
    await this.applyRequestedModel(peer, session, input.model)
    this.push(session, { type: 'thread', threadId: created.sessionId })
  }

  private startPrompt(peer: JsonRpcPeer, session: AcpSessionState, input: DriverStreamInput): void {
    peer.request('session/prompt', {
      sessionId: session.acpSessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    }, { timeoutMs: 0, signal: input.signal }).then(
      reply => {
        const usage = usageOf(reply)
        if (usage !== undefined) this.push(session, { type: 'usage', usage })
        this.push(session, { type: 'done' })
      },
      (error: unknown) => this.push(session, { type: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
    )
  }

  private async ensure(): Promise<JsonRpcPeer> {
    if (this.peer !== undefined) return this.peer
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(): Promise<JsonRpcPeer> {
    const child = spawn(this.executable, [...this.args], {
      env: cleanEnv(this.extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.unref()
    process.once('exit', () => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    const peer = new JsonRpcPeer(message => {
      try { child.stdin?.write(`${JSON.stringify(message)}\n`) } catch { /* gone */ }
    })
    wireChild(child, peer)
    peer.notificationHandler = (method, params) => this.onNotification(method, params)
    peer.requestHandler = (method, params) => this.onServerRequest(method, params)
    child.on('exit', code => {
      const reason = new Error(`acp agent exited ${String(code)}`)
      peer.close(reason)
      if (this.peer === peer) { this.peer = undefined; this.child = undefined }
      for (const session of this.sessions.values()) {
        this.push(session, { type: 'error', error: reason })
        session.acpSessionId = undefined
      }
    })
    const initialized = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-local-agent', version: '1' },
    }, { timeoutMs: INIT_TIMEOUT_MS }) as {
      agentCapabilities?: {
        loadSession?: unknown
        mcpCapabilities?: { http?: unknown }
      }
    }
    this.capabilities = {
      loadSession: initialized?.agentCapabilities?.loadSession === true,
      mcpHttp: initialized?.agentCapabilities?.mcpCapabilities?.http === true,
    }
    this.peer = peer
    return peer
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const record = asRecord(params)
    const session = this.byAcpSession(record?.['sessionId'])
    if (session === undefined) return
    const update = asRecord(record?.['update'])
    if (update === undefined) return
    switch (String(update['sessionUpdate'] ?? '')) {
      case 'agent_message_chunk': {
        const text = contentText(update['content'])
        if (text !== '') this.push(session, { type: 'text', text })
        break
      }
      case 'agent_thought_chunk': {
        const text = contentText(update['content'])
        if (text !== '') this.push(session, { type: 'thought', text })
        break
      }
      case 'plan': {
        const entries = Array.isArray(update['entries']) ? update['entries'] : []
        const text = entries
          .map(entry => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['content'] : undefined))
          .filter((part): part is string => typeof part === 'string')
          .join('\n')
        if (text !== '') this.push(session, { type: 'thought', text })
        break
      }
      case 'tool_call':
      case 'tool_call_update': {
        const title = typeof update['title'] === 'string' ? update['title'] : ''
        if (title !== '') this.push(session, { type: 'activity', text: title })
        break
      }
      default:
        break
    }
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    const record = asRecord(params)
    const session = this.byAcpSession(record?.['sessionId'])
    if (method === 'session/request_permission') {
      const toolCall = asRecord(record?.['toolCall'])
      const title = typeof toolCall?.['title'] === 'string' ? toolCall.title : 'The agent asks to run an action'
      const rawInput = toolCall?.['rawInput'] !== null && typeof toolCall?.['rawInput'] === 'object' ? JSON.stringify(toolCall?.rawInput) : ''
      const options = Array.isArray(record?.['options']) ? record['options'] as unknown[] : []
      const callId = `approval-${randomUUID()}`
      const decision = await new Promise<{ allow: boolean }>(resolve => {
        this.pendingApprovals.set(callId, resolve)
        this.push(session, {
          type: 'tool-call',
          callId,
          name: 'approve_agent_action',
          arguments: { action: title, ...(rawInput === '' ? {} : { detail: rawInput.slice(0, 4_000) }) },
        })
      })
      if (!decision.allow) return { outcome: { outcome: 'cancelled' } }
      const allowOption = options
        .map(option => asRecord(option))
        .find(option => typeof option?.['kind'] === 'string' && String(option['kind']).startsWith('allow'))
      const optionId = allowOption === undefined ? undefined : allowOption['optionId']
      if (typeof optionId !== 'string') return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId } }
    }
    if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
    // We advertise no fs/terminal capabilities; anything else is unsupported.
    throw new Error(`unsupported acp client request: ${method}`)
  }

  private byAcpSession(acpSessionId: unknown): AcpSessionState | undefined {
    if (typeof acpSessionId !== 'string') return undefined
    for (const session of this.sessions.values()) {
      if (session.acpSessionId === acpSessionId) return session
    }
    return undefined
  }

  private push(session: AcpSessionState | undefined, event: AgentEvent): void {
    if (session === undefined) return
    session.queue.push(event)
    const notify = session.notify
    session.notify = undefined
    notify?.()
  }

  private next(session: AcpSessionState): Promise<AgentEvent> {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function contentText(content: unknown): string {
  if (content === null || typeof content !== 'object') return ''
  const block = content as Record<string, unknown>
  return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''
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

function usageOf(reply: unknown): TokenUsage | undefined {
  const record = asRecord(reply)
  if (record === undefined) return undefined
  const usage = asRecord(record['usage'])
  if (usage === undefined) return undefined
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return { inputTokens: number(usage['inputTokens']), outputTokens: number(usage['outputTokens']) }
}
