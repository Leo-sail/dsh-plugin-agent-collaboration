/**
 * `approve_agent_action` — the DSH approval seam for a local agent's own permission prompts.
 *
 * The CLI asks "may I run this command / call this MCP tool / change this file?". The driver
 * parks that request and hands DSH an ordinary tool call; this definition turns it into
 * `ctx.approval.request(...)`, so the user's decision arrives through the same service and
 * audit trail as every other DSH approval.
 *
 * FAIL CLOSED: only an explicit `allowed-once` becomes `allow`. Timeout, rejection,
 * cancellation, an unavailable approval service, or an unparsable answer all mean `deny`.
 *
 * @module
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** The slice of the host's approval service this tool uses. */
export interface ApprovalPort {
  request(request: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: unknown
    readonly reason?: string
    readonly displayReason?: unknown
    readonly signal?: AbortSignal | undefined
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface ApproveActionArgs {
  readonly action: string
  readonly detail?: string
}

/** Canonical tool result; rendered as JSON text so the driver can parse it fail-closed. */
export interface ApproveActionResult {
  readonly decision: 'allow' | 'deny'
}

/**
 * Build the tool definition.
 *
 * @param approval - called at execution time; undefined on a host without the service means
 *   every request is denied (the turn fails visibly rather than silently proceeding).
 */
export function approveAgentActionTool(approval: () => ApprovalPort | undefined): ToolDefinition {
  return {
    name: 'approve_agent_action',
    description: 'Ask the user to approve an action you want to take: running a command, changing files, or calling a tool. The agent runtime asks this on your behalf when its own permission system wants a decision.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What the action does, in one line' },
        detail: { type: 'string', description: 'The exact command, paths, or arguments, when it helps the decision' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { decision: { type: 'string' } },
        required: ['decision'],
      },
      render: (_args: unknown, value: unknown) => {
        const decision = (value !== null && typeof value === 'object' ? (value as { decision?: unknown }).decision : undefined) === 'allow' ? 'allow' : 'deny'
        return [{ type: 'text', text: JSON.stringify({ decision }) }]
      },
    },
    async execute(args: unknown, exec: { agent?: unknown; callId?: unknown; signal?: AbortSignal | undefined }): Promise<unknown> {
      const approvalService = approval()
      if (approvalService === undefined || exec.agent === undefined) return { decision: 'deny' }
      const input = args !== null && typeof args === 'object' ? args as Record<string, unknown> : {}
      const action = String(input['action'] ?? 'The agent asks to run an action').slice(0, 500)
      const detail = typeof input['detail'] === 'string' ? input['detail'].slice(0, 4_000) : undefined
      const text = detail === undefined || detail === '' ? action : `${action}\n${detail}`
      try {
        const outcome = await approvalService.request({
          agent: exec.agent,
          toolName: 'approve_agent_action',
          ...(exec.callId === undefined ? {} : { callId: exec.callId }),
          reason: text,
          displayReason: { en: text },
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        return { decision: outcome === 'allowed-once' ? 'allow' : 'deny' }
      } catch {
        return { decision: 'deny' }
      }
    },
  }
}

/** What the natural-language switch asks the host to do. */
export interface SwitchModelPort {
  switchModel(sessionId: string, model: string): Promise<{ readonly ok: boolean; readonly model?: string; readonly available?: readonly string[]; readonly error?: string }>
  availableModels(sessionId: string): Promise<readonly string[]>
}

/**
 * `agent_switch_model` — change THIS conversation's model when the user asks in natural
 * language. Session-scoped by design (the Bot's configured model is unchanged; switching
 * there is a settings action).
 *
 * Unknown ids are rejected with the available list, so the agent can tell the user what it
 * can switch to instead of silently sending a bad model to the CLI.
 */
export function switchModelTool(port: () => SwitchModelPort | undefined): ToolDefinition {
  return {
    name: 'agent_switch_model',
    description: 'Switch the model used for THIS conversation when the user asks for it (for example "use opus" or "换成 sonnet"). Only the current conversation is affected; the Bot default model is changed in settings. Returns the applied model, or the list of available models when the request is unavailable.',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The model id or name to switch to' },
      },
      required: ['model'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          available: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value ?? { ok: false }) }],
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<unknown> {
      const switchPort = port()
      const sessionId = exec.agent !== null && typeof exec.agent === 'object' && typeof (exec.agent as { id?: unknown }).id === 'string'
        ? (exec.agent as { id: string }).id
        : undefined
      if (switchPort === undefined || sessionId === undefined) return { ok: false, error: 'model switching is unavailable in this host' }
      const input = args !== null && typeof args === 'object' ? args as Record<string, unknown> : {}
      const wanted = String(input['model'] ?? '').trim()
      if (wanted === '') return { ok: false, error: 'a model is required' }
      try {
        return await switchPort.switchModel(sessionId, wanted)
      } catch (error) {
        const available = await switchPort.availableModels(sessionId).catch(() => [])
        return { ok: false, error: error instanceof Error ? error.message : String(error), ...(available.length === 0 ? {} : { available }) }
      }
    },
  }
}
