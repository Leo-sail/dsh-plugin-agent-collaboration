/**
 * The DSH LLM adapter that serves local-agent model routes.
 *
 * A Bot whose model is a local-agent route answers through the CLI instead of a model API:
 * the run loop, Sessions, tools and approvals stay the ordinary ones. This adapter turns each
 * model request into a prompt for the driver and the driver's events back into DSH stream
 * chunks.
 *
 * TWO HARD RULES, both from the user's 2026-11-10 decisions:
 * 1. NO PERSONA / NO SYSTEM PROMPT. `system`, runtime-context and skill-catalog injections are
 *    dropped — the agent keeps its own rules. The counter `stats.systemDropped` makes that
 *    testable instead of a claim.
 * 2. NO API KEY. Credentials are the CLI's; the adapter only resolves which model to ask for.
 *
 * @module
 */
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmImageRequestPricing,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { DriverMcpTool, DriverToolResult, LocalAgentDriver } from './drivers/types.ts'
import type { LocalAgentEngineSpec, LocalAgentSessionRecord } from './types.ts'

/** Replay window when the CLI-side session is new or its id was lost. */
const REPLAY_MESSAGES = 12
const REPLAY_BYTES = 24 * 1024
const REPLAY_MESSAGE_CHARS = 2_000
const DEFAULT_CONTEXT_WINDOW = 200_000
const ACTIVITY_PREFIX = '▸ '
/**
 * DSH tools bridged to the agent over loopback MCP. Deliberately a whitelist: shell/file tools
 * stay the agent's own (its sandbox governs them), and nothing outside the collaboration
 * surface can be called through this bridge.
 */
const BRIDGED_TOOL_NAMES = new Set([
  'message_member', 'assign_task', 'finish_task', 'agent_community_deliver',
  'agent_community_dispatch', 'agent_community_remember', 'agent_community_recall',
  'agent_community_goal', 'agent_community_abstain', 'agent_community_list_bots',
  'agent_community_handoff_file', 'ask_user_question', 'propose_group', 'invite_bot', 'remove_bot',
  'approve_agent_action', 'agent_switch_model',
])

function isBridgedTool(name: string): boolean {
  return BRIDGED_TOOL_NAMES.has(name) || name.startsWith('agent_community_')
}

/** Everything the adapter needs from the host service. */
export interface LocalAgentAdapterDeps {
  readonly driverFor: (route: string) => LocalAgentDriver | undefined
  readonly specFor: (route: string) => LocalAgentEngineSpec | undefined
  readonly recordFor: (sessionId: string) => LocalAgentSessionRecord | undefined
  readonly saveRecord: (sessionId: string, record: LocalAgentSessionRecord) => void
  readonly cwdFor: (sessionId: string) => string
  /** Bot permission for this session, mapped by drivers onto their CLI's sandbox/permission mode. */
  readonly permissionFor: (sessionId: string) => 'read-only' | 'workspace-write' | 'full-access' | undefined
  /** Config switch: expose the collaboration tools to the agent over loopback MCP. */
  readonly toolsBridge: boolean
}

/** One promptable message after filtering out the injected, non-conversation kinds. */
interface PromptMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly id: string | undefined
}

/** What one request contributes as prompt text. */
interface BuiltPrompt {
  readonly prompt: string
  readonly lastMessageId: string | undefined
  readonly systemDropped: boolean
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => block !== null && typeof block === 'object')
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** A deterministic title (never reaches the CLI). */
function titleChunks(text: string): StreamChunk[] {
  const line = text.split('\n').find(part => part.trim() !== '')?.trim() ?? 'Chat'
  const title = truncate(line, 60) || 'Chat'
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: title },
    { type: 'block-end', index: 0, block: { type: 'text', text: title } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A deterministic digest (never reaches the CLI). */
function digestChunks(messages: readonly { role: string; text: string }[]): StreamChunk[] {
  const lines: string[] = []
  let used = 0
  for (const message of messages) {
    const text = message.text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${truncate(text, 300)}`
    if (used + line.length > 8 * 1024) break
    lines.push(line)
    used += line.length
  }
  const text = `[Earlier conversation, condensed]\n${lines.join('\n')}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function failureChunks(code: string, message: string, signal?: AbortSignal): StreamChunk[] {
  return signal?.aborted === true
    ? [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }]
    : [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }]
}

function bridgedToolsOf(tools: GenerateOptions['tools']): DriverMcpTool[] {
  return (tools ?? [])
    .filter(tool => isBridgedTool(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
}

function lastMessageIdOf(messages: GenerateOptions['messages']): string | undefined {
  for (let at = (messages ?? []).length - 1; at >= 0; at -= 1) {
    const message = messages[at]
    if (message !== undefined && 'id' in message && typeof message.id === 'string') return message.id
  }
  return undefined
}

/** Render the replay window for a fresh CLI session: conversation content only. */
function renderReplay(messages: readonly PromptMessage[]): string {
  if (messages.length === 0) return ''
  if (messages.length === 1 && messages[0]?.role === 'user') return messages[0].text
  const kept: string[] = []
  let bytes = 0
  for (let at = messages.length - 1; at >= 0 && kept.length < REPLAY_MESSAGES; at -= 1) {
    const message = messages[at]
    if (message === undefined) continue
    const line = `${message.role}: ${truncate(message.text, REPLAY_MESSAGE_CHARS)}`
    if (bytes + line.length > REPLAY_BYTES) break
    kept.unshift(line)
    bytes += line.length
  }
  return kept.length === 0 ? '' : `Conversation so far:\n\n${kept.join('\n\n')}`
}

/** The adapter. One instance serves every registered route. */
export class LocalAgentAdapter extends LlmAdapter {
  private readonly deps: LocalAgentAdapterDeps
  /** Test-visible counters: assertions about "no persona" read this instead of trusting prose. */
  readonly stats = { systemDropped: 0, turns: 0 }
  private disposed = false
  /** Bridged calls parked by a previous stream, awaiting their DSH tool results. */
  private readonly pendingCalls = new Set<string>()

  constructor(deps: LocalAgentAdapterDeps) {
    super()
    this.deps = deps
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.deps.specFor(provider)?.name ?? provider }
  }

  providerRetryPolicy(): undefined {
    // The CLI owns its retries (Codex shows Reconnecting itself); retrying a whole turn here
    // would double-bill the user's session.
    return undefined
  }

  imageRequestPricing(): LlmImageRequestPricing | undefined {
    // v1: text only. Do not declare image support the driver does not implement.
    return undefined
  }

  // Structural: dsh-llm's generated declaration names an interface it does not re-export.
  imageRequestTarget(_provider: string, _model: string, image: { width: number; height: number; bytes: number }): { width: number; height: number; maxBytes: number } {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const driver = this.deps.driverFor(provider)
    if (driver === undefined) return []
    const models = await driver.listModels()
    return models.map(model => ({ provider, id: model.id, name: model.name }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = this.deps.specFor(provider)
    return {
      provider,
      id: model,
      name: model === 'default' ? 'CLI default' : model,
      inputModalities: ['text'],
      context: { contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    }
  }

  async prepareCall(provider: string, model: string): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    const resolved = await this.resolveModel(provider, model)
    return { model: resolved, stream: options => this.streamFor(provider, options) }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamFor(options.provider, options)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  /** Results for bridged calls parked by a previous stream (consumed once). */
  private takeToolResults(messages: GenerateOptions['messages']): DriverToolResult[] {
    const results: DriverToolResult[] = []
    for (const message of messages ?? []) {
      if (message.role !== 'tool') continue
      const callId = 'toolCallId' in message && typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      if (callId === undefined || !this.pendingCalls.has(callId)) continue
      this.pendingCalls.delete(callId)
      results.push({
        callId,
        text: textOf(message.content) || ('isError' in message && message.isError === true ? 'the call failed' : ''),
        isError: 'isError' in message && message.isError === true,
      })
    }
    return results
  }

  /** Build prompt text from the request, dropping every injected, non-conversation kind. */
  buildPrompt(options: GenerateOptions, record: LocalAgentSessionRecord | undefined): BuiltPrompt {
    let systemDropped = false
    const promptable: PromptMessage[] = []

    if (typeof options.system === 'string' && options.system.trim() !== '') systemDropped = true
    for (const message of options.messages ?? []) {
      const role = message.role
      const id = 'id' in message && typeof message.id === 'string' ? message.id : undefined
      if (role === 'system') {
        if (textOf(message.content) !== '') systemDropped = true
        continue
      }
      if (role === 'user') {
        const source = 'source' in message ? message.source : undefined
        const kind = source !== undefined && typeof source === 'object' && 'kind' in source ? String(source.kind) : undefined
        // runtime-context and skill-catalog are DSH injections (measured M0); they are not the
        // user's words and must never become the agent's task.
        if (kind !== undefined && kind !== 'user') continue
        const text = textOf(message.content)
        if (text !== '') promptable.push({ role: 'user', text, id })
        continue
      }
      if (role === 'assistant') {
        const text = textOf(message.content)
        if (text !== '') promptable.push({ role: 'assistant', text, id })
        continue
      }
      // tool messages: CLI-internal history; the CLI keeps its own.
    }

    const lastMessageId = promptable.at(-1)?.id
    const handedAt = record?.handedId === undefined
      ? -1
      : promptable.findIndex(message => message.id === record.handedId)
    const fresh = record?.handedId === undefined || handedAt === -1
    if (fresh) return { prompt: renderReplay(promptable), lastMessageId, systemDropped }

    // A resumed CLI conversation already holds its own assistant replies; only the NEW user
    // words are input. Sending the assistant text back would duplicate the reply.
    const delta = promptable
      .slice(handedAt + 1)
      .filter(message => message.role === 'user')
      .map(message => message.text)
      .filter(text => text !== '')
    if (delta.length > 0) return { prompt: delta.join('\n\n'), lastMessageId, systemDropped }
    // Nothing new (a retry of the same request): repeat the newest user text rather than
    // sending an empty prompt the CLI cannot accept.
    const lastUser = [...promptable].reverse().find(message => message.role === 'user')
    return { prompt: lastUser?.text ?? '', lastMessageId, systemDropped }
  }

  private async *streamFor(route: string, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.disposed) { yield* failureChunks('LOCAL_AGENT_DISPOSED', 'the local agent adapter is disposed'); return }

    // Auxiliary requests never reach the CLI: a session title and a compaction summary are
    // deterministic and must not spend the user's agent quota.
    if (options.purpose === 'session-title') {
      const first = (options.messages ?? []).find(message => message.role === 'user')
      yield* titleChunks(textOf(first?.content))
      return
    }
    if (options.purpose === 'compaction') {
      yield* digestChunks((options.messages ?? []).map(message => ({ role: message.role, text: textOf(message.content) })))
      return
    }

    const driver = this.deps.driverFor(route)
    if (driver === undefined) { yield* failureChunks('NO_ADAPTER', `no local agent driver for ${route}`); return }
    if (options.sessionId === undefined) {
      yield* failureChunks('INVALID_REQUEST', 'a local agent request needs a session')
      return
    }

    const sessionId = String(options.sessionId)
    const record = this.deps.recordFor(sessionId)
    // ── A MODEL CHANGE MUST START A NEW CLI CONVERSATION ─────────────────────────
    //
    // The CLI thread/session was created under the OLD model. Switching the Bot's model in
    // Settings and reusing that thread made Codex accept the turn and then never produce an
    // item (measured 2026-11-10: gpt switched to gpt-6-astra, every following turn ended
    // "no progress after 120s" or an empty reply). Retiring the mapping makes the driver start
    // a fresh thread with the new model, and the replay below re-seeds it with the visible
    // conversation, so nothing the user said is lost.
    const requestedModel = record?.modelOverride ?? options.model
    const explicitModel = (value: unknown): value is string => typeof value === 'string' && value !== '' && value !== 'default'
    // A provider switch changes the route too; that conversation also cannot be resumed.
    const modelChanged = record !== undefined
      && (record.route !== route || (explicitModel(requestedModel) && record.model !== requestedModel))
    let effectiveRecord = record
    if (modelChanged) {
      effectiveRecord = { ...record, resumeId: undefined, handedId: undefined }
      try {
        await driver.resetSession?.(sessionId)
      } catch { /* the next turn still starts a fresh mapping when possible */ }
    }
    const built = this.buildPrompt(options, effectiveRecord)
    if (built.systemDropped) this.stats.systemDropped += 1
    this.stats.turns += 1

    const toolResults = this.takeToolResults(options.messages)
    const bridgedTools = this.deps.toolsBridge ? bridgedToolsOf(options.tools) : []
    // The handed marker must be an id from the SAME filtered list `buildPrompt` compared
    // against. Using the raw message list here recorded the id of a dropped runtime-context
    // injection, so the marker never matched on resume and every turn replayed history
    // (measured with the fake ACP agent on 2026-11-10).
    const lastMessageId = built.lastMessageId

    let nextIndex = 0
    let textIndex = -1
    let textBuf = ''
    let thinkIndex = -1
    let thinkBuf = ''
    let usage: TokenUsage | undefined
    let threadId = record?.resumeId
    let sawDone = false

    const closeText = function* (): Generator<StreamChunk> {
      if (textIndex < 0) return
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }
      textIndex = -1
      textBuf = ''
    }
    const closeThinking = function* (): Generator<StreamChunk> {
      if (thinkIndex < 0) return
      yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }
      thinkIndex = -1
      thinkBuf = ''
    }

    try {
      for await (const event of driver.stream({
        sessionId,
        prompt: built.prompt,
        cwd: this.deps.cwdFor(sessionId),
        model: effectiveRecord?.modelOverride ?? options.model,
        permission: this.deps.permissionFor(sessionId),
        resumeId: modelChanged ? undefined : effectiveRecord?.resumeId,
        ...(bridgedTools.length === 0 ? {} : { mcp: { tools: bridgedTools } }),
        ...(toolResults.length === 0 ? {} : { toolResults }),
        signal: options.signal,
      })) {
        switch (event.type) {
          case 'thread': threadId = event.threadId; break
          case 'usage': usage = event.usage; break
          case 'done': sawDone = true; break
          case 'tool-call': {
            // The agent called a bridged team tool. Stop this LLM stream with `tool-calls`;
            // DSH executes the tool (approvals included) and re-enters with the result.
            yield* closeText()
            yield* closeThinking()
            const index = nextIndex++
            this.pendingCalls.add(event.callId)
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id: event.callId as never, name: event.name, argumentsDelta: JSON.stringify(event.arguments) }
            yield {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id: event.callId as never, name: event.name, arguments: JSON.stringify(event.arguments) },
            }
            if (threadId !== undefined || lastMessageId !== undefined) {
              this.deps.saveRecord(sessionId, {
                route,
                ...(threadId === undefined ? {} : { resumeId: threadId }),
                cwd: this.deps.cwdFor(sessionId),
                ...(lastMessageId === undefined ? {} : { handedId: lastMessageId }),
                model: options.model,
                updatedAt: new Date().toISOString(),
              })
            }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          case 'error':
            // Yield a proper failure finish instead of throwing mid-stream: a throw can be seen
            // as an empty completion (the room then shows "模型输出为空" and loses the CLI's
            // reason). LOCAL_AGENT_FAILED keeps the cause visible in the turn error.
            yield* failureChunks('LOCAL_AGENT_FAILED', event.error.message)
            return
          case 'permission': {
            yield* closeText()
            if (thinkIndex < 0) { thinkIndex = nextIndex++; yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' } }
            const line = `${ACTIVITY_PREFIX}${event.action}${event.detail === undefined ? '' : ` — ${truncate(event.detail, 240)}`}\n`
            thinkBuf += line
            yield { type: 'reasoning-delta', index: thinkIndex, text: line }
            break
          }
          case 'activity': {
            yield* closeText()
            if (thinkIndex < 0) { thinkIndex = nextIndex++; yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' } }
            const line = `${ACTIVITY_PREFIX}${event.text}\n`
            thinkBuf += line
            yield { type: 'reasoning-delta', index: thinkIndex, text: line }
            break
          }
          case 'text': {
            yield* closeThinking()
            if (textIndex < 0) { textIndex = nextIndex++; yield { type: 'block-start', index: textIndex, blockType: 'text' } }
            textBuf += event.text
            yield { type: 'text-delta', index: textIndex, text: event.text }
            break
          }
          case 'thought': {
            yield* closeText()
            if (thinkIndex < 0) { thinkIndex = nextIndex++; yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' } }
            thinkBuf += event.text
            yield { type: 'reasoning-delta', index: thinkIndex, text: event.text }
            break
          }
        }
      }
    } catch (error) {
      yield* closeText()
      yield* closeThinking()
      yield* failureChunks('LOCAL_AGENT_FAILED', error instanceof Error ? error.message : String(error), options.signal)
      return
    }

    if (options.signal?.aborted === true) {
      yield* closeText()
      yield* closeThinking()
      yield* failureChunks('ABORTED', 'the turn was stopped', options.signal)
      return
    }

    yield* closeText()
    yield* closeThinking()
    if (usage !== undefined) yield { type: 'usage', usage }

    if (sawDone || threadId !== undefined) {
      const next: LocalAgentSessionRecord = {
        route,
        ...(threadId === undefined ? {} : { resumeId: threadId }),
        cwd: this.deps.cwdFor(sessionId),
        ...(lastMessageId === undefined ? {} : { handedId: lastMessageId }),
        model: options.model,
        updatedAt: new Date().toISOString(),
      }
      this.deps.saveRecord(sessionId, next)
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
