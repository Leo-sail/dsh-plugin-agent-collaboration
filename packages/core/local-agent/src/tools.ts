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
